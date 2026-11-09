# Data Model: Mensageria Confiável

**Feature**: `002-messaging-reliability` | **Date**: 2026-11-08 | **Plan**: [plan.md](plan.md)

Complementa a data-model da 001 (`specs/001-wagering-transaction-core/data-model.md`), que continua valendo. Aqui só o
que é novo ou muda: domínio, schema (duas migrations) e os fluxos de escrita dos três trabalhadores. Nenhuma coluna nova
nas tabelas da 001; nenhuma guarda da 001 é afrouxada (constitution V).

## 1. Modelo de domínio

Mesmas regras da 001: construtor `private`, factories estáticas, `rehydrate` sem revalidar transições, nada de
`@nestjs`, `@mikro-orm` ou `@aws-sdk` no domínio (constitution VI).

### InboxMessage (`inbox/domain/inbox-message.ts`)

Esqueleto do enunciado §6.5.

| Campo | Tipo | Regra |
|-------|------|-------|
| `messageId` | string | 1 a 128 caracteres em `[A-Za-z0-9._:-]` (I-69) |
| `consumerName` | string | 1 a 64 caracteres; o padrão é `wager-transactions-consumer` (R-27) |
| `payloadHash` | string | SHA-256 hex do JSON canônico de `data` (o mesmo `payloadHash` do I-25) |
| `transactionId` | UUID | transação resultante: a criada pela mensagem ou a existente, em replay |
| `receivedAt` | Date | via `Clock` |
| `processedAt?` | Date | via `Clock` |

- `InboxMessage.receive({ messageId, consumerName, payloadHash, transactionId, receivedAt })`: valida formato.
- `markProcessed(at)`: uma vez só; segunda chamada lança `InvalidTransactionStateError`.
- `isProcessed()`, `matchesPayload(hash)`, `rehydrate(state)`.
- Na persistência a linha é sempre gravada já processada (`receive(...)` + `markProcessed(now)` na mesma transação do
  efeito ou do replay), então `processed_at` é `NOT NULL` no schema (§2.1).

### WagerTransaction (mudanças)

- **`scheduleNextReferenceAttempt(nextAttemptAt, at)`**: só a partir de PENDING_REFERENCE; incrementa
  `referenceAttempts`, define `nextReferenceAttemptAt`, atualiza `updatedAt`, mantém o status (I-11). Em qualquer outro
  status lança `InvalidTransactionStateError`.
- `markProcessed(referenceTransactionId, observedBalance, at)` a partir de PENDING_REFERENCE já existe; na resolução ela
  reescreve `observedBalance` e `referenceTransactionId` (I-67).
- `reject(code, observedBalance, at)` e `fail(code, at)` a partir de PENDING_REFERENCE já existem. Na resolução por
  esgotamento o código é `REFERENCE_NOT_FOUND` (I-21); `fail` usa `INTERNAL_ERROR` (I-22, I-61).
- Ao sair de PENDING_REFERENCE, `nextReferenceAttemptAt` fica nulo; `referenceAttempts` é preservado (auditoria).
- `correlationId` nunca muda (I-53, I-67, I-69).

Transições, com as novas tentativas explícitas (I-11):

```text
PENDING ──► PROCESSED | REJECTED | FAILED
   │
   └──► PENDING_REFERENCE ──► PROCESSED            (referência aplicada; ledger e eventos)
            │   ▲         ├──► REJECTED             (REFERENCE_REJECTED, mismatch, kind, amount,
            │   │         │                          ALREADY_REVERSED, saldo ou REFERENCE_NOT_FOUND)
            └───┘         └──► FAILED               (erro permanente inesperado, só pelo worker, I-61)
   scheduleNextReferenceAttempt: attempts + 1 e próxima hora; status igual
```

### PendingReferencePolicy (`wagering/domain/pending-reference-policy.ts`)

Serviço de domínio puro (R-25), configurado com `maxAttempts` (10), `ttlMs` (600000), `baseMs` (5000), `maxMs`
(60000) e `jitterRatio` (0,2):

- `delayBefore(attemptNumber, random)`: `min(base × 2^(attemptNumber − 1), max)` × `(1 − r + 2r × random)`;
  `attemptNumber` ≥ 2 (a 1ª tentativa foi agendada pela 001 em `created_at` + 5 s, sem jitter).
- `isExhausted(attemptsAfterThis, createdAt, now)`: `attemptsAfterThis ≥ maxAttempts` ou `now − createdAt ≥ ttlMs`
  (I-64).
- Sem jitter, a sequência de esperas é 5, 10, 20, 40, 60, 60, 60, 60, 60, 60 s: a 10ª tentativa acontece 435 s depois da
  criação, e é ela que, ainda sem referência, rejeita com `REFERENCE_NOT_FOUND` (I-64).
- Só conta como tentativa a avaliação concluída com a referência ausente ou pendente; falha de infraestrutura não conta
  (Assumptions da spec). O esgotamento só é consultado depois de a referência ser relida e avaliada: aplicada ou
  rejeitada, a pendente resolve normalmente; `REFERENCE_NOT_FOUND` só se ela continuar ausente ou pendente (I-72).

### RandomSource (`platform/random/random-source.port.ts`)

Porta `RANDOM_SOURCE` com `next(): number` em `[0, 1)`; adapter com `crypto.getRandomValues`; double determinístico nos
testes (como `FixedClock` e `SequentialIdGenerator` da 001).

### OutboxMessage (uso)

Sem mudança de código de domínio: `markPublished(at)` e `scheduleRetry(now)` (backoff de 1 a 60 s) já existem e
passam a ser usados pelo publicador (I-31, I-65).

### Códigos de DLQ

Atributos `errorCode` e `errorClass` de toda mensagem enviada pela aplicação à DLQ (FR-040, I-68, I-70, I-71). Lista
completa em [contracts/queues.md](contracts/queues.md):

- `errorClass` `permanent`: `MALFORMED_MESSAGE`, `UNSUPPORTED_MESSAGE_TYPE`, `VALIDATION_ERROR`, `OPENING_NOT_ALLOWED`,
  `WALLET_NOT_FOUND`, `INBOX_PAYLOAD_MISMATCH`, `IDEMPOTENCY_CONFLICT`;
- `errorClass` `unexpected`: `INTERNAL_ERROR`, enviado no 5º recebimento de um erro inesperado (I-71).

`MALFORMED_MESSAGE`, `UNSUPPORTED_MESSAGE_TYPE` e `INBOX_PAYLOAD_MISMATCH` são códigos exclusivos de DLQ, na tabela
própria da §7 (I-70). Nenhum desses valores vai para `failure_code` nem para `error.code` HTTP.

## 2. Schema PostgreSQL

Mesmas convenções da 001: guardas com `RAISE EXCEPTION ... USING ERRCODE = 'P0001'`, nomes de constraint estáveis
(a aplicação identifica violações por eles), nenhum `DEFAULT now()` em coluna de domínio.

### 2.1 `inbox_messages` (Migration20261108000100)

```sql
CREATE TABLE inbox_messages (
  consumer_name   varchar(64)  NOT NULL,
  message_id      varchar(128) NOT NULL,
  payload_hash    char(64)     NOT NULL,
  transaction_id  uuid         NOT NULL REFERENCES wager_transactions (id),
  received_at     timestamptz  NOT NULL,
  processed_at    timestamptz  NOT NULL,
  CONSTRAINT inbox_messages_pk           PRIMARY KEY (consumer_name, message_id),             -- I-28
  CONSTRAINT inbox_consumer_name_ck      CHECK (length(consumer_name) BETWEEN 1 AND 64),
  CONSTRAINT inbox_message_id_ck         CHECK (message_id ~ '^[A-Za-z0-9._:-]{1,128}$'),       -- I-69
  CONSTRAINT inbox_payload_hash_ck       CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT inbox_processed_after_ck    CHECK (processed_at >= received_at)
);

CREATE INDEX inbox_transaction_idx ON inbox_messages (transaction_id);                        -- auditoria

-- Inbox imutável: a linha é a prova de que a mensagem foi tratada; corrigir é mandar outra mensagem.
CREATE TRIGGER inbox_no_update_delete_trg BEFORE UPDATE OR DELETE ON inbox_messages
  FOR EACH ROW EXECUTE FUNCTION jg_forbid_mutation();
CREATE TRIGGER inbox_no_truncate_trg BEFORE TRUNCATE ON inbox_messages
  FOR EACH STATEMENT EXECUTE FUNCTION jg_forbid_mutation();
```

- `down`: `DROP TRIGGER inbox_no_truncate_trg`, `DROP TRIGGER inbox_no_update_delete_trg`, `DROP TABLE
  inbox_messages`. A função `jg_forbid_mutation` é da migration `000400` da 001 e não é tocada.
- A violação `23505` em `inbox_messages_pk` é classificada como `inbox-race` (R-22): relê a inbox; mesmo hash =
  duplicata, hash diferente = `INBOX_PAYLOAD_MISMATCH`.
- `transaction_id NOT NULL`: só existe linha de inbox quando há transação (efeito ou replay). Conflito de idempotência
  e erros permanentes não gravam inbox (I-68).

### 2.2 Índices do worker de PENDING_REFERENCE (Migration20261108000200)

```sql
-- Claim do worker: pendentes vencidas, em ordem de vencimento e criação (FR-023, I-63).
CREATE INDEX wager_tx_pending_due_idx
  ON wager_transactions (next_reference_attempt_at, created_at)
  WHERE status = 'PENDING_REFERENCE';

-- Antecipação e irmãs mais antigas: pendentes que referenciam (provider, id externo) (FR-026, I-63).
CREATE INDEX wager_tx_pending_by_reference_idx
  ON wager_transactions (provider_id, reference_external_transaction_id, created_at)
  WHERE status = 'PENDING_REFERENCE';
```

- `down`: `DROP INDEX wager_tx_pending_by_reference_idx` e `DROP INDEX wager_tx_pending_due_idx`.
- Nenhuma coluna nova: `reference_attempts` e `next_reference_attempt_at` já existem (001, §2.2). As atualizações do
  worker passam pelo trigger `jg_wager_tx_guard` da 001, que já permite PENDING_REFERENCE → PENDING_REFERENCE (só
  tentativas e próxima hora), → PROCESSED, → REJECTED e → FAILED, e recusa mudanças nas colunas de identidade
  (inclusive `correlation_id`).
- `outbox_messages` não muda: `outbox_pending_idx` (001) atende o claim do publicador.

### 2.3 Migrations registradas

| Migration | `up` | `down` |
|-----------|------|--------|
| `Migration20261108000100` | `inbox_messages`, índice e triggers de imutabilidade | triggers e tabela, na ordem inversa |
| `Migration20261108000200` | `wager_tx_pending_due_idx`, `wager_tx_pending_by_reference_idx` | os dois índices |

Registradas em `MIGRATIONS` (`mikro-orm.config.ts`) depois das quatro da 001; `up → down → up` coberto pelo teste de
migrations (constitution V).

## 3. Fluxos de escrita

Toda query dentro de transação usa o EntityManager da transação (001, R-19); SQL com `?`. Ordem única de lock: wallet
antes de linhas de transação (R-26).

### 3.1 Consumidor: efeito novo (FR-003)

1. `SET LOCAL lock_timeout`
2. `SELECT ... FROM wallets WHERE id = ? FOR UPDATE`
3. `SELECT ... FROM inbox_messages WHERE consumer_name = ? AND message_id = ?` → duplicata confirmada antes: replay,
   sem escrever nada
4. Releitura da idempotência (consulta única da 001) → replay: `INSERT INTO inbox_messages` apontando a existente;
   conflito: erro (sem inbox, I-68)
5. Referência, reversão existente e `WagerRulesService.decide` (001)
6. `INSERT INTO wager_transactions`; se o saldo muda, `UPDATE wallets ... WHERE version = ?` e `INSERT INTO
   wallet_ledger_entries`
7. Se a transação ficou PROCESSED ou REJECTED: antecipação (§3.4)
8. `INSERT INTO inbox_messages` (`transaction_id` da nova, `received_at` e `processed_at`)
9. `INSERT INTO outbox_messages` (eventos com `correlationId` = `causationId` = `messageId`, I-69)
10. `COMMIT`; depois, failpoint `after_commit_before_ack` e `DeleteMessage`

Replay pelo caminho rápido (fora do lock): transação mínima só com o `INSERT INTO inbox_messages`; `23505` em
`inbox_messages_pk` → releitura.

### 3.2 Publicador (FR-016 a FR-019)

1. Transação curta: `SELECT id FROM outbox_messages WHERE published_at IS NULL AND next_attempt_at <= ? ORDER BY
   next_attempt_at LIMIT ? FOR UPDATE SKIP LOCKED`; `UPDATE outbox_messages SET next_attempt_at = ? WHERE id IN (...)`
   (agora + 30 s); `COMMIT`
2. Fora de transação, para cada evento: `SendMessage` (corpo = `payload`, grupo = `aggregate_id`, deduplicação = `id`)
3. Failpoint `before_publish_mark`
4. `UPDATE outbox_messages SET published_at = ? WHERE id = ? AND published_at IS NULL`
5. Falha no passo 2: `UPDATE outbox_messages SET attempts = ?, next_attempt_at = ? WHERE id = ? AND published_at IS
   NULL` (valores de `OutboxMessage.scheduleRetry`)

### 3.3 Worker de PENDING_REFERENCE (FR-023 a FR-031)

1. Claim, transação mínima: `SELECT id, wallet_id, provider_id, reference_external_transaction_id, created_at FROM
   wager_transactions WHERE status = 'PENDING_REFERENCE' AND next_reference_attempt_at <= ? ORDER BY
   next_reference_attempt_at, created_at LIMIT ? FOR UPDATE SKIP LOCKED`; `UPDATE wager_transactions SET
   next_reference_attempt_at = ?, updated_at = ? WHERE id IN (...)` (agora + lease); `COMMIT`
2. Para cada reservada R, irmãs mais antigas primeiro (I-63), cada uma numa transação:
   1. `SET LOCAL lock_timeout`; `SELECT ... FROM wallets WHERE id = ? FOR UPDATE`
   2. `SELECT ... FROM wager_transactions WHERE id = ?` → status ≠ PENDING_REFERENCE: nada a fazer
   3. referência por `(provider_id, reference_external_transaction_id)`; reversão existente; `decide`
   4. conforme a decisão: `UPDATE wager_transactions SET status, failure_code, observed_balance,
      observed_balance_currency, reference_transaction_id, processed_at, next_reference_attempt_at = NULL, updated_at
      WHERE id = ? AND status = 'PENDING_REFERENCE'` (1 linha; 0 → quebra de invariante) e, se o saldo muda,
      `UPDATE wallets` + `INSERT INTO wallet_ledger_entries`; ou, se continua pendente e não esgotou, `UPDATE ... SET
      reference_attempts = ?, next_reference_attempt_at = ?, updated_at = ? WHERE id = ? AND status =
      'PENDING_REFERENCE'`
   5. se ficou PROCESSED ou REJECTED: antecipação (§3.4)
   6. `INSERT INTO outbox_messages` (eventos com o `correlation_id` da pendente, sem `causationId`, I-69)
   7. failpoint `after_pending_resolution_before_commit`; `COMMIT`
3. Erro permanente inesperado: rollback; nova transação: lock da wallet, `UPDATE ... SET status = 'FAILED',
   failure_code = 'INTERNAL_ERROR', next_reference_attempt_at = NULL, updated_at = ? WHERE id = ? AND status =
   'PENDING_REFERENCE'`; `COMMIT` (I-22, I-61). Sem evento.

### 3.4 Antecipação (FR-026, I-21, I-63, I-73)

Na mesma transação que deixa X PROCESSED ou REJECTED (submit, consumidor ou worker), depois do lock da wallet de X. Só
puxa a próxima tentativa das dependentes; quem as processa é a próxima varredura do worker (§3.3), na ordem de lock
wallet primeiro (I-73):

```sql
UPDATE wager_transactions
   SET next_reference_attempt_at = ?, updated_at = ?        -- agora
 WHERE status = 'PENDING_REFERENCE'
   AND provider_id = ?                                      -- X.provider_id
   AND reference_external_transaction_id = ?                -- X.external_transaction_id
   AND next_reference_attempt_at > ?                        -- só as que ainda não estão vencidas
```

Usa `wager_tx_pending_by_reference_idx`. Não muda `reference_attempts` nem o status (I-11).
