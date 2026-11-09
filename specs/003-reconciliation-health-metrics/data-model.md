# Data Model: Reconciliação, Health Checks e Métricas

**Feature**: `003-reconciliation-health-metrics` | **Plan**: [plan.md](plan.md) | **Research**: [research.md](research.md)

Esta feature **não muda o schema**: nenhuma tabela, coluna, índice, trigger ou migration nova. Ela só lê
`wallets`, `wallet_ledger_entries` e `outbox_messages` (001) e expõe estado em memória (002). O schema da 001 e da 002
continua normativo (`specs/001-wagering-transaction-core/data-model.md`, `specs/002-messaging-reliability/data-model.md`).

## 1. Modelo de domínio

### ReconciliationResult (`reconciliation/domain/reconciliation.ts`)

Valor calculado, nunca persistido, produzido pela função pura `reconcile(input)` (R-37).

| Campo | Tipo | Regra |
|-------|------|-------|
| `walletId` | uuid | A wallet reconciliada. |
| `storedBalance` | `Money` | `wallets.balance` lido no snapshot. |
| `calculatedBalance` | `Money` | Σ CREDIT − Σ DEBIT do ledger da wallet; `0.00` sem lançamentos (FR-004). |
| `difference` | `Money` | `storedBalance − calculatedBalance`, com sinal (FR-005). |
| `checkedEntries` | inteiro ≥ 0 | Lançamentos lidos (FR-004). |
| `chainConsistent` | boolean | Cadeia íntegra (FR-006). |
| `firstBrokenSeq` | inteiro, opcional | Presente só com `chainConsistent` false: o menor `seq` com elo quebrado; sem elo quebrado e com a cauda divergente, o `seq` do último lançamento. |
| `consistent` | boolean | `difference` zero **e** `chainConsistent` (FR-007). |

Entrada de `reconcile`: `walletId`, `storedBalance`, `calculatedBalance`, `checkedEntries`, `firstBrokenLinkSeq?`,
`lastSeq?`, `lastBalanceAfter?`. Todos os valores monetários na moeda da wallet; moedas diferentes entre os campos são
erro de programação (`Money` já recusa a operação, 001).

Regras da cadeia (I-37, I-74), em ordem de `seq` dentro da wallet:

```text
elo quebrado em n  ⇔  (n é o primeiro e before[n] ≠ 0.00)  ou  (n não é o primeiro e before[n] ≠ after[n−1])
cauda quebrada     ⇔  existe lançamento  e  after[último] ≠ storedBalance
chainConsistent    ⇔  nenhum elo quebrado  e  cauda íntegra
```

### Readiness (`health/application/readiness.ts`)

| Campo | Valores | Regra |
|-------|---------|-------|
| `checks.postgres` | `up` \| `down` | `SELECT 1` respondeu em até 2 s. |
| `checks.sqs` | `up` \| `down` | `GetQueueAttributes` das três filas respondeu em até 2 s. |
| `draining` | boolean | `WorkerRegistry.isDraining()` (R-40). |
| `status` | `ok` \| `unavailable` | `ok` ⇔ todas as checagens `up` e não `draining`. HTTP 200 / 503. |

Função pura `readinessOf(checks, draining)`; as checagens são portas com prazo.

### Séries de métrica (`platform/metrics`, R-42, R-43)

| Nome | Tipo | Rótulos | Origem |
|------|------|---------|--------|
| `transactions_total` | counter | `status` | submit e worker, depois do commit (002, N-45) |
| `duplicates_total` | counter | `source` | submit e consumidor (002) |
| `retries_total` | counter | `worker` | consumidor, publicador, worker (002) |
| `dlq_total` | counter | `errorCode`, `errorClass` | consumidor (002) |
| `lock_conflicts_total` | counter | — | unit of work (002) |
| `reconciliation_divergences_total` | counter | — | reconciliação (esta feature, FR-008) |
| `processing_latency_ms` | histogram | `worker` | consumidor e worker (002) |
| `outbox_lag_ms` | histogram | — | publicador, na marca (002) |
| `outbox_pending_events` | gauge | — | lido do banco na coleta (R-44) |
| `outbox_oldest_pending_age_seconds` | gauge | — | lido do banco na coleta (R-44) |

Rótulos permitidos (lista fechada, imposta pela porta): `status`, `source`, `worker`, `errorCode`, `errorClass`,
`outcome`, `kind`. Buckets dos histogramas (ms): 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000,
`+Inf`. Por série: contagem, soma, contagem por bucket e uma janela das últimas 1 000 observações (só para os testes).

## 2. Leituras no banco

### 2.1 Reconciliação (R-36)

Numa transação `REPEATABLE READ`, `READ ONLY`, as duas consultas no mesmo snapshot, com `?`:

```sql
SELECT balance::text AS balance, currency FROM wallets WHERE id = ?;          -- sem FOR UPDATE

WITH chain AS (
  SELECT seq, direction, amount, balance_before, balance_after,
         lag(balance_after) OVER (ORDER BY seq) AS previous_after,
         row_number()       OVER (ORDER BY seq DESC) AS from_end
    FROM wallet_ledger_entries
   WHERE wallet_id = ?
)
SELECT count(*)                                                             AS checked_entries,
       coalesce(sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::text AS calculated,
       min(seq) FILTER (WHERE (previous_after IS NULL AND balance_before <> 0)
                           OR (previous_after IS NOT NULL AND balance_before <> previous_after)) AS first_broken_link_seq,
       max(seq)                                                             AS last_seq,
       max(balance_after::text) FILTER (WHERE from_end = 1)                 AS last_balance_after
  FROM chain;
```

- Usa `ledger_wallet_seq_idx (wallet_id, seq)` (001); memória constante na aplicação (FR-009).
- `numeric` sempre como texto; `seq` (bigint) chega como string e só vira inteiro depois de conferido como seguro.
- Wallet ausente na primeira consulta → `WalletNotFoundError` (404), sem rodar a segunda.

### 2.2 Readiness

```sql
SELECT 1;
```

### 2.3 Atraso da outbox (R-44)

```sql
SELECT count(*) AS pending, min(occurred_at) AS oldest
  FROM outbox_messages
 WHERE published_at IS NULL;
```

Coberta pelo índice parcial `outbox_pending_idx` (001), que só contém linhas pendentes.

## 3. Escritas

Nenhuma. A reconciliação é somente leitura (imposto pelo `READ ONLY`); health e métricas não gravam nada. A única
mudança de estado é em memória: o contador `reconciliation_divergences_total`.

## 4. Banco de teste sem as guardas (R-38)

Só para os testes de divergência: um banco vazio com as migrations `Migration20261107000100` a
`Migration20261107000300` (wallets, wager_transactions, wallet_ledger_entries, outbox_messages e seus índices e
constraints), **sem** `Migration20261107000400` (funções e triggers de guarda) e sem as migrations da 002. Os CHECKs e
as unicidades das tabelas continuam ativos; só os triggers não existem. Nenhum banco migrado por completo tem triggers
desligados.
