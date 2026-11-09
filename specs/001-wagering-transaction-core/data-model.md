# Data Model: Núcleo Transacional de Apostas

**Feature**: `001-wagering-transaction-core` | **Date**: 2026-11-07 | **Plan**: [plan.md](plan.md)

Duas partes: o modelo de domínio (classes sem ORM nem Nest) e o schema PostgreSQL que impõe as invariantes no banco
(constitution V). Os nomes de constraint são estáveis: a aplicação identifica violações por eles (research R-08,
R-12).

## 1. Modelo de domínio

Todas as classes têm construtor `private` e factories estáticas; `rehydrate` reconstrói estado persistido sem
revalidar transições (enunciado §6.0; constitution VI).

### Money (`shared-kernel/domain/money.ts`)

| Campo | Tipo | Regra |
|-------|------|-------|
| `value` | `Decimal` (privado) | instância isolada de decimal.js (research R-03) |
| `currency` | `string` | `^[A-Z]{3}$` (I-05) |

- `Money.from({ amount, currency })`: aceita só `^(0|[1-9]\d*)(\.\d{1,2})?$` e normaliza para 2 casas (I-01).
  Limite 9999999999999999.99 (I-03).
- `Money.zero(currency)`, `add`, `subtract`, `negate`, `isZero`, `isPositive`, `isNegative`, `isLessThan`,
  `equals`, `toJSON(): MoneyProps`, `toString()`.
- Operações entre moedas diferentes lançam `CurrencyMismatchError` (FR-004). Resultados internos podem ser
  negativos (ex.: `subtract` para testar saldo), mas nunca são persistidos como saldo.

### Wallet (`wallets/domain/wallet.ts`), aggregate root

| Campo | Tipo | Regra |
|-------|------|-------|
| `id` | UUIDv7 | gerado por `IdGenerator` (I-35) |
| `playerId` | string 1–255 | I-50 |
| `currency` | string | igual a `balance.currency` |
| `balance` | Money | nunca negativo |
| `version` | inteiro ≥ 1 | 1 na criação; +1 por alteração de saldo, e só nela (FR-009) |
| `createdAt`, `updatedAt` | Date | via `Clock` |

- `Wallet.open({ id, playerId, initialBalance, at })`: `version` 1. O saldo inicial já é o saldo da wallet; o
  lançamento de abertura é criado pelo use case com `balanceBefore` 0.00 e não incrementa a `version` (I-06).
- `debit(money, entryId, transactionId, at)` e `credit(...)`: validam a moeda, calculam o novo saldo, recusam
  saldo negativo com `InsufficientBalanceError`, incrementam `version` e devolvem o `WalletLedgerEntry`
  correspondente. Saldo e lançamento nascem juntos (enunciado §6.2). `credit` recusa saldo resultante acima de
  9999999999999999.99 com `BalanceLimitExceededError` (I-54).
- `Wallet.rehydrate(state)`.

### WagerTransaction (`wagering/domain/wager-transaction.ts`)

Campos do enunciado §6.3, mais:

| Campo extra | Motivo |
|-------------|--------|
| `observedBalance?: Money` | saldo observado no resultado, devolvido no replay (I-26, FR-036) |
| `correlationId: string` | correlationId com que foi processada (I-53, FR-060) |
| `referenceAttempts: number`, `nextReferenceAttemptAt?: Date` | tentativas de PENDING_REFERENCE (I-11, I-21); nesta feature só são inicializados |

Transições (FR-028, I-11); qualquer chamada em estado terminal lança `InvalidTransactionStateError`:

```text
                 ┌────────────► PROCESSED   (terminal)
                 │
PENDING ─────────┼────────────► REJECTED    (terminal)
   │             │
   │             └────────────► FAILED      (terminal)
   │
   └──► PENDING_REFERENCE ──┬─► PROCESSED
            ▲   │           ├─► REJECTED
            └───┘           └─► FAILED
     (nova tentativa: só attempts e nextAttemptAt)
```

- `create(props)`: nasce PENDING; valida a exigência de referência por kind (I-13); recusa OPENING vindo de
  provedor (o use case de abertura usa uma factory interna `createOpening`).
- `referenceTransactionId` (coluna `reference_transaction_id`) só é gravado quando a transação fica PROCESSED, pela
  `markProcessed`. REJECTED (inclusive com referência existente e inconsistente) e PENDING_REFERENCE (inclusive com
  referência existente porém pendente) ficam com o campo nulo: `reject` e `markPendingReference` não recebem
  referência (enunciado §6.3). A referência externa (`reference_external_transaction_id`) é sempre gravada.
- `markProcessed(referenceTransactionId, observedBalance, at)`, `markPendingReference(observedBalance,
  nextAttemptAt)`, `reject(code, observedBalance)`, `fail(code)`.
- Consultas: `isTerminal`, `affectsBalance` (false para LOSS), `requiresReference` (REFUND, ROLLBACK),
  `matchesPayload(hash)`, `ledgerDirectionFor(reference?)`: BET → DEBIT; WIN, REFUND, OPENING → CREDIT;
  ROLLBACK → inverso da referência (I-12).

### WalletLedgerEntry (`wallets/domain/wallet-ledger-entry.ts`)

Campos do enunciado §6.4, todos `readonly`; `create` valida `balanceBefore ± money = balanceAfter`,
`money > 0`, `balanceAfter ≥ 0` e moeda única. `seq` não é do domínio: é atribuído pelo banco e só aparece no
read model do ledger (cursor, I-36).

### FailureCode (`wagering/domain/failure-code.ts`)

Taxonomia do `docs/interpretacoes.md` §7, com `retryable` e ação por código. Códigos de transação persistíveis:
`INSUFFICIENT_FUNDS`, `REVERSAL_WOULD_OVERDRAW`, `BALANCE_LIMIT_EXCEEDED`, `REFERENCE_NOT_FOUND`,
`REFERENCE_REJECTED`, `REFERENCE_MISMATCH`, `INVALID_REFERENCE_KIND`, `ALREADY_REVERSED`, `AMOUNT_MISMATCH`,
`CURRENCY_MISMATCH`, `WALLET_PLAYER_MISMATCH` (mais `INTERNAL_ERROR` para FAILED, usado pela feature de
mensageria). Códigos só de resposta HTTP: `VALIDATION_ERROR`, `OPENING_NOT_ALLOWED`, `IDEMPOTENCY_KEY_REQUIRED`,
`IDEMPOTENCY_CONFLICT`, `WALLET_NOT_FOUND`, `WALLET_ALREADY_EXISTS`, `TRANSACTION_NOT_FOUND`,
`ROUTE_NOT_FOUND` (I-59), `SERVICE_UNAVAILABLE`, `INTERNAL_ERROR`.

Mapeamento para status HTTP (I-39, I-45, I-54, I-55, I-59):

| Código | Status | Corpo | `retryable` |
|--------|--------|-------|-------------|
| Todos os códigos persistíveis (transação REJECTED), inclusive `BALANCE_LIMIT_EXCEEDED` | 422 | `TransactionResult` | false |
| `VALIDATION_ERROR` (inclusive JSON malformado, `Content-Type` não suportado e corpo acima do limite, I-59), `OPENING_NOT_ALLOWED`, `IDEMPOTENCY_KEY_REQUIRED` | 400 | `{ error }` | false |
| `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND`, `ROUTE_NOT_FOUND` (rota ou método inexistente, I-59) | 404 | `{ error }` | false |
| `IDEMPOTENCY_CONFLICT`, `WALLET_ALREADY_EXISTS` | 409 | `{ error }` | false |
| `SERVICE_UNAVAILABLE` | 503 + Retry-After | `{ error }` | true |
| `INTERNAL_ERROR` | 500 | `{ error }` | true |

### WagerRulesService (`wagering/domain/wager-rules.service.ts`)

Função pura `decide({ wallet, transaction, reference, referenceAlreadyReversed })` →
`Apply { direction } | Reject { code } | PendingReference`, avaliando o passo 5 do I-44 nesta ordem:

1. `WALLET_PLAYER_MISMATCH` (playerId ≠ dono da wallet)
2. `CURRENCY_MISMATCH` (moeda ≠ moeda da wallet)
3. Se há referência e ela existe, em qualquer estado:
   1. `REFERENCE_MISMATCH` (player, wallet, moeda ou rodada diferentes; o provider já é igual por construção)
   2. `INVALID_REFERENCE_KIND` (REFUND de não-BET; ROLLBACK de LOSS, ROLLBACK ou OPENING; WIN/LOSS de não-BET;
      I-14, I-46)
   3. `AMOUNT_MISMATCH` (só REFUND/ROLLBACK; I-17)
4. Estado da referência: ausente, PENDING ou PENDING_REFERENCE → `PendingReference`; REJECTED ou FAILED →
   `REFERENCE_REJECTED` (I-15)
5. `ALREADY_REVERSED` (só REFUND/ROLLBACK com referência PROCESSED; I-16)
6. Saldo: débito que deixaria saldo < 0 → `INSUFFICIENT_FUNDS` (BET) ou `REVERSAL_WOULD_OVERDRAW` (ROLLBACK de WIN
   ou REFUND) (I-18); crédito (WIN, REFUND, ROLLBACK de BET) que deixaria saldo > 9999999999999999.99 →
   `BALANCE_LIMIT_EXCEEDED` (I-54)
7. LOSS → `Apply` sem direção (sem lançamento)

### Eventos de integração (`wagering/domain/events/`, `wallets/domain/events/`)

Envelope `IntegrationEvent<T>` do enunciado §11 (`eventId`, `aggregateId` = walletId, `correlationId`,
`causationId?`, `occurredAt`, `eventType` e `version` no tipo, `data`). Nas requisições HTTP, `causationId` fica
ausente.

| Evento (v1) | Quando (FR-045, FR-046, I-33) | `data` |
|-------------|-------------------------------|--------|
| `WagerTransactionProcessed` | transação PROCESSED, inclusive LOSS; não na abertura (I-09) | `transactionId`, `providerId`, `externalTransactionId`, `walletId`, `playerId`, `roundId`, `gameId`, `kind`, `money`, `referenceTransactionId?`, `balance` (observado), `walletVersion` |
| `WagerTransactionRejected` | transação REJECTED | os mesmos identificadores, `kind`, `money`, `failureCode`, `retryable`, `balance` (observado) |
| `WalletBalanceChanged` | saldo mudou, inclusive na abertura | `walletId`, `transactionId`, `direction`, `money`, `balanceBefore`, `balanceAfter`, `walletVersion` (enunciado §11) |
| `WagerTransactionPendingReference` | entrou em PENDING_REFERENCE | identificadores, `kind`, `money`, `referenceExternalTransactionId`, `nextAttemptAt` |

Todos os valores monetários vão como `MoneyProps` (string). Ordem de gravação na transação:
`WalletBalanceChanged` (se houver) e depois o evento de status.

### OutboxMessage (`outbox/domain/outbox-message.ts`)

Campos do enunciado §6.5. `enqueue(event)`: `id` = `eventId`, `payload` = `event.toJSON()`, `attempts` 0,
`nextAttemptAt` = `occurredAt`, `publishedAt` ausente. `markPublished` e `scheduleRetry` existem e têm teste
unitário, mas só são usados pela feature de publicação.

## 2. Schema PostgreSQL

Convenções: `uuid` gerado pela aplicação; dinheiro em `numeric(18,2)` com a moeda ao lado; `timestamptz` vindo
do `Clock`; nenhum `DEFAULT now()` nas colunas de domínio. Todos os triggers de guarda usam
`RAISE EXCEPTION ... USING ERRCODE = 'P0001'`, com mensagem prefixada pelo nome da regra; a aplicação trata
esses erros como quebra de invariante (500, research R-12).

Mapeamento no ORM (research R-04, spike S-05): **toda coluna de dinheiro** é declarada no `EntitySchema` com
`type: new DecimalType('string')`, `precision: 18` e `scale: 2`, nunca `type: 'decimal'` sem modo. O modo padrão
do `DecimalType` segue o `runtimeType` da propriedade e pode virar `number`. As colunas são:

| Tabela | Colunas de dinheiro |
|--------|---------------------|
| `wallets` | `balance` |
| `wager_transactions` | `amount`, `observed_balance` (nullable) |
| `wallet_ledger_entries` | `amount`, `balance_before`, `balance_after` |

O `seq` do ledger é lido como string (`BigIntType('string')` ou SQL cru, que já devolve string) e nunca vira
`number`. O mapper converte esses valores com `Money.from`, junto da coluna de moeda (I-04). O teste de
integração `money-columns` prova o mapeamento nas seis colunas.

### 2.1 `wallets`

```sql
CREATE TABLE wallets (
  id          uuid          PRIMARY KEY,
  player_id   varchar(255)  NOT NULL,
  currency    char(3)       NOT NULL,
  balance     numeric(18,2) NOT NULL,
  version     integer       NOT NULL,
  created_at  timestamptz   NOT NULL,
  updated_at  timestamptz   NOT NULL,
  CONSTRAINT wallets_player_id_len_ck     CHECK (length(player_id) BETWEEN 1 AND 255),
  CONSTRAINT wallets_currency_ck          CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT wallets_balance_non_neg_ck   CHECK (balance >= 0),
  CONSTRAINT wallets_version_ck           CHECK (version >= 1),
  CONSTRAINT wallets_player_currency_uq   UNIQUE (player_id, currency),   -- FR-008, I-10
  CONSTRAINT wallets_id_currency_uq       UNIQUE (id, currency)           -- alvo de FK composta do ledger
);
```

### 2.2 `wager_transactions`

```sql
CREATE TABLE wager_transactions (
  id                                 uuid          PRIMARY KEY,
  provider_id                        varchar(255)  NOT NULL,
  external_transaction_id            varchar(255)  NOT NULL,
  idempotency_key                    varchar(255)  NOT NULL,
  payload_hash                       char(64)      NOT NULL,
  wallet_id                          uuid          NOT NULL REFERENCES wallets (id),
  player_id                          varchar(255)  NOT NULL,
  round_id                           varchar(255)  NOT NULL,
  game_id                            varchar(255)  NOT NULL,
  kind                               varchar(16)   NOT NULL,
  amount                             numeric(18,2) NOT NULL,
  currency                           char(3)       NOT NULL,
  reference_external_transaction_id  varchar(255),
  reference_transaction_id           uuid          REFERENCES wager_transactions (id),
  status                             varchar(24)   NOT NULL,
  failure_code                       varchar(48),
  observed_balance                   numeric(18,2),
  observed_balance_currency          char(3),
  correlation_id                     varchar(128)  NOT NULL,
  reference_attempts                 integer       NOT NULL DEFAULT 0,
  next_reference_attempt_at          timestamptz,
  created_at                         timestamptz   NOT NULL,
  processed_at                       timestamptz,
  updated_at                         timestamptz   NOT NULL,

  CONSTRAINT wager_tx_provider_idempotency_uq UNIQUE (provider_id, idempotency_key),          -- I-24, I-56
  CONSTRAINT wager_tx_provider_external_uq UNIQUE (provider_id, external_transaction_id),     -- I-24
  CONSTRAINT wager_tx_ledger_key_uq        UNIQUE (id, wallet_id, currency, amount),          -- alvo de FK do ledger

  CONSTRAINT wager_tx_kind_ck     CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
  CONSTRAINT wager_tx_status_ck   CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
  CONSTRAINT wager_tx_currency_ck CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT wager_tx_hash_ck     CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT wager_tx_amount_ck   CHECK (amount > 0 OR (kind = 'LOSS' AND amount = 0)),        -- I-02
  CONSTRAINT wager_tx_opening_identity_ck CHECK ((kind = 'OPENING') = (provider_id = 'system')),  -- I-07
  CONSTRAINT wager_tx_reference_by_kind_ck CHECK (                                            -- I-13
       (kind IN ('REFUND','ROLLBACK') AND reference_external_transaction_id IS NOT NULL)
    OR (kind IN ('BET','OPENING')     AND reference_external_transaction_id IS NULL)
    OR  kind IN ('WIN','LOSS')),
  CONSTRAINT wager_tx_resolved_reference_ck CHECK (
    reference_transaction_id IS NULL OR reference_external_transaction_id IS NOT NULL),
  CONSTRAINT wager_tx_processed_reversal_ck CHECK (                                           -- sustenta o I-16
    NOT (kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED') OR reference_transaction_id IS NOT NULL),
  CONSTRAINT wager_tx_failure_code_ck CHECK (
       (status IN ('REJECTED','FAILED') AND failure_code IS NOT NULL)
    OR (status IN ('PENDING','PENDING_REFERENCE','PROCESSED') AND failure_code IS NULL)),
  CONSTRAINT wager_tx_failure_code_value_ck CHECK (failure_code IS NULL OR failure_code IN (
    'INSUFFICIENT_FUNDS','REVERSAL_WOULD_OVERDRAW','BALANCE_LIMIT_EXCEEDED','REFERENCE_NOT_FOUND','REFERENCE_REJECTED',
    'REFERENCE_MISMATCH','INVALID_REFERENCE_KIND','ALREADY_REVERSED','AMOUNT_MISMATCH',
    'CURRENCY_MISMATCH','WALLET_PLAYER_MISMATCH','INTERNAL_ERROR')),
  CONSTRAINT wager_tx_processed_at_ck CHECK (status <> 'PROCESSED' OR processed_at IS NOT NULL),
  CONSTRAINT wager_tx_observed_balance_ck CHECK (
       status IN ('PENDING','FAILED')
    OR (observed_balance IS NOT NULL AND observed_balance >= 0 AND observed_balance_currency IS NOT NULL)),
  CONSTRAINT wager_tx_attempts_ck CHECK (reference_attempts >= 0)
);

-- I-16 / FR-025: uma única reversão PROCESSED por transação referenciada, REFUND e ROLLBACK juntos.
CREATE UNIQUE INDEX wager_tx_single_reversal_uq
  ON wager_transactions (reference_transaction_id)
  WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED';
```

Observações:

- `observed_balance_currency` existe porque, numa rejeição `CURRENCY_MISMATCH`, a moeda da transação difere da
  moeda do saldo observado (a da wallet).
- O lookup da referência usa `wager_tx_provider_external_uq`; a checagem `ALREADY_REVERSED` usa o índice parcial.
- A idempotência é escopada por provedor (I-56): `wager_tx_provider_idempotency_uq` atende o caminho rápido e a
  releitura sob lock, que buscam por `(provider_id, idempotency_key)`.
- Índices para o worker de PENDING_REFERENCE (I-21) ficam para a feature dele.

### 2.3 `wallet_ledger_entries`

```sql
CREATE TABLE wallet_ledger_entries (
  seq             bigint        GENERATED ALWAYS AS IDENTITY,
  id              uuid          PRIMARY KEY,
  wallet_id       uuid          NOT NULL,
  transaction_id  uuid          NOT NULL,
  direction       varchar(6)    NOT NULL,
  amount          numeric(18,2) NOT NULL,
  currency        char(3)       NOT NULL,
  balance_before  numeric(18,2) NOT NULL,
  balance_after   numeric(18,2) NOT NULL,
  created_at      timestamptz   NOT NULL,

  CONSTRAINT ledger_seq_uq            UNIQUE (seq),
  CONSTRAINT ledger_wallet_tx_uq      UNIQUE (wallet_id, transaction_id),                   -- I-36
  CONSTRAINT ledger_direction_ck      CHECK (direction IN ('DEBIT','CREDIT')),
  CONSTRAINT ledger_amount_ck         CHECK (amount > 0),
  CONSTRAINT ledger_balance_after_ck  CHECK (balance_after >= 0),
  CONSTRAINT ledger_balance_before_ck CHECK (balance_before >= 0),
  CONSTRAINT ledger_arithmetic_ck     CHECK (
       (direction = 'CREDIT' AND balance_after = balance_before + amount)
    OR (direction = 'DEBIT'  AND balance_after = balance_before - amount)),
  -- moeda do lançamento = moeda da wallet
  CONSTRAINT ledger_wallet_fk FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency),
  -- lançamento pertence a uma transação da mesma wallet, com mesmo valor e moeda
  CONSTRAINT ledger_transaction_fk FOREIGN KEY (transaction_id, wallet_id, currency, amount)
    REFERENCES wager_transactions (id, wallet_id, currency, amount)
);

CREATE INDEX ledger_wallet_seq_idx ON wallet_ledger_entries (wallet_id, seq);           -- paginação (I-36)
```

### 2.4 `outbox_messages`

```sql
CREATE TABLE outbox_messages (
  id               uuid          PRIMARY KEY,        -- = eventId
  aggregate_id     uuid          NOT NULL,           -- walletId (I-33)
  event_type       varchar(64)   NOT NULL,
  event_version    integer       NOT NULL,
  payload          jsonb         NOT NULL,           -- envelope toJSON(); dinheiro como string
  correlation_id   varchar(128)  NOT NULL,
  occurred_at      timestamptz   NOT NULL,
  attempts         integer       NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz   NOT NULL,
  published_at     timestamptz,
  CONSTRAINT outbox_event_type_ck CHECK (event_type IN (
    'WagerTransactionProcessed','WagerTransactionRejected','WalletBalanceChanged',
    'WagerTransactionPendingReference')),
  CONSTRAINT outbox_event_version_ck CHECK (event_version >= 1),
  CONSTRAINT outbox_attempts_ck      CHECK (attempts >= 0)
);

CREATE INDEX outbox_pending_idx ON outbox_messages (next_attempt_at) WHERE published_at IS NULL;
```

### 2.5 Funções e triggers de guarda

```sql
-- Bloqueio genérico (ledger: UPDATE, DELETE, TRUNCATE; transações: DELETE, TRUNCATE).
CREATE FUNCTION jg_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%_immutable: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'P0001';
END $$;

-- Ledger imutável (FR-041, I-36, SC-008).
CREATE TRIGGER ledger_no_update_delete_trg BEFORE UPDATE OR DELETE ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION jg_forbid_mutation();
CREATE TRIGGER ledger_no_truncate_trg BEFORE TRUNCATE ON wallet_ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION jg_forbid_mutation();

-- Lançamento só para transação PROCESSED que move saldo, com direção coerente com o kind, e encadeado
-- ao lançamento anterior e ao saldo atual da wallet (FR-029, FR-042).
CREATE FUNCTION jg_ledger_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  tx             record;
  ref_direction  varchar(6);
  last_after     numeric(18,2);
  wallet_balance numeric(18,2);
BEGIN
  SELECT status, kind, reference_transaction_id INTO tx
    FROM wager_transactions WHERE id = NEW.transaction_id;
  IF tx.status <> 'PROCESSED' OR tx.kind = 'LOSS' THEN
    RAISE EXCEPTION 'ledger_requires_processed_movement' USING ERRCODE = 'P0001';
  END IF;
  IF (tx.kind = 'BET' AND NEW.direction <> 'DEBIT')
     OR (tx.kind IN ('WIN','REFUND','OPENING') AND NEW.direction <> 'CREDIT') THEN
    RAISE EXCEPTION 'ledger_direction_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF tx.kind = 'ROLLBACK' THEN
    -- wallet_id + transaction_id usa o índice de ledger_wallet_tx_uq; uma reversão válida é sempre da mesma
    -- wallet (REFERENCE_MISMATCH barra o resto), então a direção da referência está nessa wallet.
    SELECT direction INTO ref_direction
      FROM wallet_ledger_entries
     WHERE wallet_id = NEW.wallet_id AND transaction_id = tx.reference_transaction_id;
    IF ref_direction IS NULL OR NEW.direction = ref_direction THEN
      RAISE EXCEPTION 'ledger_rollback_direction_mismatch' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  SELECT balance_after INTO last_after
    FROM wallet_ledger_entries WHERE wallet_id = NEW.wallet_id ORDER BY seq DESC LIMIT 1;
  IF NEW.balance_before <> COALESCE(last_after, 0) THEN
    RAISE EXCEPTION 'ledger_chain_broken' USING ERRCODE = 'P0001';
  END IF;
  SELECT balance INTO wallet_balance FROM wallets WHERE id = NEW.wallet_id;
  IF NEW.balance_after <> wallet_balance THEN
    RAISE EXCEPTION 'ledger_wallet_balance_mismatch' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ledger_before_insert_trg BEFORE INSERT ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION jg_ledger_before_insert();

-- No commit, o saldo da wallet é igual ao balance_after do último lançamento (ou 0.00 sem lançamentos).
-- Junto com o encadeamento acima, garante wallet.balance == saldo reconstruído pelo ledger (FR-042).
CREATE FUNCTION jg_wallet_matches_ledger_tail() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_balance numeric(18,2);
  last_after      numeric(18,2);
BEGIN
  SELECT balance INTO current_balance FROM wallets WHERE id = NEW.id;
  SELECT balance_after INTO last_after
    FROM wallet_ledger_entries WHERE wallet_id = NEW.id ORDER BY seq DESC LIMIT 1;
  IF current_balance <> COALESCE(last_after, 0) THEN
    RAISE EXCEPTION 'wallet_ledger_tail_mismatch' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER wallets_match_ledger_tail_trg
  AFTER INSERT OR UPDATE OF balance ON wallets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION jg_wallet_matches_ledger_tail();

-- Wallet: colunas de identidade imutáveis, version +1 exatamente quando o saldo muda (FR-009), sem DELETE.
CREATE FUNCTION jg_wallets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'wallets_immutable: DELETE is not allowed' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.id, NEW.player_id, NEW.currency, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.player_id, OLD.currency, OLD.created_at) THEN
    RAISE EXCEPTION 'wallets_identity_changed' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.balance <> OLD.balance AND NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'wallets_version_must_increment' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.balance = OLD.balance AND NEW.version <> OLD.version THEN
    RAISE EXCEPTION 'wallets_version_without_balance_change' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER wallets_guard_trg BEFORE UPDATE OR DELETE ON wallets
  FOR EACH ROW EXECUTE FUNCTION jg_wallets_guard();

-- Transações: estados terminais imutáveis, colunas de identidade imutáveis, só transições do I-11, sem DELETE.
CREATE FUNCTION jg_wager_tx_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'wager_transactions_immutable: DELETE is not allowed' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
    RAISE EXCEPTION 'wager_tx_terminal_state' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
      NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
      NEW.reference_external_transaction_id, NEW.correlation_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash,
      OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency,
      OLD.reference_external_transaction_id, OLD.correlation_id, OLD.created_at) THEN
    RAISE EXCEPTION 'wager_tx_identity_changed' USING ERRCODE = 'P0001';
  END IF;
  IF NOT (
       (OLD.status = 'PENDING' AND NEW.status IN ('PROCESSED','REJECTED','PENDING_REFERENCE','FAILED'))
    OR (OLD.status = 'PENDING_REFERENCE'
        AND NEW.status IN ('PENDING_REFERENCE','PROCESSED','REJECTED','FAILED'))) THEN
    RAISE EXCEPTION 'wager_tx_invalid_transition' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER wager_tx_guard_trg BEFORE UPDATE OR DELETE ON wager_transactions
  FOR EACH ROW EXECUTE FUNCTION jg_wager_tx_guard();
CREATE TRIGGER wager_tx_no_truncate_trg BEFORE TRUNCATE ON wager_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION jg_forbid_mutation();
```

### 2.6 Migrations (MikroORM Migrations, SQL cru, `up` e `down`)

| Migration | `up` | `down` |
|-----------|------|--------|
| `Migration20261107000100` | `wallets`, `wager_transactions` com constraints e o índice parcial | `DROP TABLE wager_transactions, wallets` |
| `Migration20261107000200` | `wallet_ledger_entries` e índice | `DROP TABLE wallet_ledger_entries` |
| `Migration20261107000300` | `outbox_messages` e índice | `DROP TABLE outbox_messages` |
| `Migration20261107000400` | funções e triggers da seção 2.5 | `DROP TRIGGER ...` e `DROP FUNCTION ...` na ordem inversa |

Os testes de integração executam `up → down → up` e conferem que o catálogo (`pg_tables`, `pg_trigger`,
`pg_indexes`) volta ao estado esperado (constitution V).

Configuração do migrator (spike S-08):

- As migrations são registradas por `migrationsList`, sem descoberta por arquivo.
- `snapshot: false` e `snapshotOnMigrate: false`: o MikroORM 7 não grava arquivos de snapshot no repositório.
  O schema vem só das migrations escritas à mão, nunca de diff gerado.
- `migrate:up` aplica todas as pendentes (`migrator.up()`), e `migrate:down` desfaz todas
  (`migrator.down({ to: 0 })`).

## 3. Fluxo de escrita da submissão (referência para a implementação)

Dentro de `em.transactional()`, em `READ COMMITTED` (research R-07, R-08). Toda query desta lista usa o
EntityManager da transação, recebido no callback, nunca outra conexão do pool (research R-19). SQL escrito à mão
usa placeholders `?` com parâmetros (`em.execute(sql, params)`), nunca `$1` e nunca valores concatenados (spike
S-05). Única exceção: o `SET LOCAL`, que não aceita parâmetro; ele recebe o inteiro de
`WALLET_LOCK_TIMEOUT_MS`, já validado como inteiro positivo no boot.

1. `SET LOCAL lock_timeout = '<WALLET_LOCK_TIMEOUT_MS>ms'` (I-51)
2. `SELECT ... FROM wallets WHERE id = ? FOR UPDATE`
3. Releitura da idempotência numa **consulta única**, num só snapshot:
   `WHERE provider_id = ? AND (idempotency_key = ? OR external_transaction_id = ?)` → replay ou 409 (I-56). A linha
   da mesma chave tem precedência. Duas consultas separadas podiam ver estados diferentes e devolver 409 a uma
   requisição idêntica (research R-08). A mesma consulta é usada no caminho rápido e na releitura depois do `23505`
4. Carregar a referência por `(provider_id, reference_external_transaction_id)`; se for PROCESSED e o kind for
   REFUND/ROLLBACK, checar se já existe reversão PROCESSED
5. `WagerRulesService.decide(...)` (ordem do I-44)
6. `INSERT INTO wager_transactions` já no status final (PROCESSED, REJECTED ou PENDING_REFERENCE)
7. Se o saldo muda: `UPDATE wallets SET balance, version, updated_at WHERE id = ? AND version = ?` (1 linha) e
   `INSERT INTO wallet_ledger_entries` (o `seq` é alocado aqui, depois do lock: a ordem de `seq` por wallet é a
   ordem de commit, e o cursor nunca pula lançamentos, SC-010)
8. `INSERT INTO outbox_messages` dos eventos
9. `COMMIT` (os triggers diferidos rodam aqui)

A wallet é a única linha travada explicitamente, e cada transação trava no máximo uma wallet. A ordem de
inserção nos índices únicos é a mesma em todas as transações, de modo que não há ciclo de espera por construção.
`40P01` é tratado mesmo assim (research R-12).
