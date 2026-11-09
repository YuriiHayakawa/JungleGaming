# Quickstart: validar o Núcleo Transacional de Apostas

**Feature**: `001-wagering-transaction-core` | **Plan**: [plan.md](plan.md) | **Contrato**:
[contracts/openapi.yaml](contracts/openapi.yaml) | **Schema**: [data-model.md](data-model.md) | **Decisões**:
[ARCHITECTURE.md](../../ARCHITECTURE.md) (na raiz do repositório)

Guia de execução e validação de ponta a ponta. Não contém implementação.

## 1. Pré-requisitos

- Bun 1.4.4 (`bun --version`)
- Docker com Compose v2, com o daemon ativo (`docker info`)
- Portas livres: 5432 (PostgreSQL, configurável por `POSTGRES_PORT`), 4566 (MiniStack, desde a feature 002) e 3001 a
  3003 (instâncias da app)

## 2. Subir o ambiente

```bash
bun install --frozen-lockfile
docker compose up -d --build                     # postgres + migrate, sqs + queue-init (one-shot) + app1
docker compose --profile cluster up -d --build   # acrescenta app2 e app3
```

O serviço `migrate` roda `migrate:up` e o `queue-init` cria as filas antes das instâncias (desde a feature 002). Para
rodar localmente, fora do Compose, com `postgres` e `sqs` no ar e numa porta que a `app1` não usa:

```bash
bun run migrate:up
bun run queue:init
PORT=3000 bun run dev
```

> Validado de ponta a ponta em 2026-11-09 (T123), com o cluster das três features. Correções feitas no texto nessa
> validação: a porta 4566 e o `sqs`/`queue-init` (entraram com a 002), `--build` e `PORT=3000` no modo local (a 3001
> é da `app1`), e os requisitos dos testes na tabela abaixo.

Variáveis principais (padrões em `.env.example`): `DATABASE_URL`, `PORT`, `WALLET_LOCK_TIMEOUT_MS=5000`,
`DB_POOL_MAX=25`, `DB_POOL_ACQUIRE_TIMEOUT_MS=8000`, `HTTP_SERVER_TIMEOUT_MS=20000`, `RETRY_AFTER_SECONDS=1`,
`FAILPOINT` (vazio; ignorado quando `NODE_ENV=production`). A app recusa subir se
`DB_POOL_ACQUIRE_TIMEOUT_MS <= WALLET_LOCK_TIMEOUT_MS` ou se
`HTTP_SERVER_TIMEOUT_MS <= DB_POOL_ACQUIRE_TIMEOUT_MS + WALLET_LOCK_TIMEOUT_MS + 2000` (I-51).

## 3. Rodar os testes

| Comando | O que roda | Requer |
|---------|------------|--------|
| `bun run typecheck` | `tsc --noEmit` estrito | — |
| `bun run test:unit` | domínio (`test/unit`) | — |
| `bun run test:integration` | `test/integration`, cada arquivo num banco próprio clonado do template `jg_test_template` | `postgres` e `sqs` do Compose |
| `bun run test:concurrency` | `test/concurrency` com 3 processos da app via `Bun.spawn` e SIGTERM em container | `postgres` e `sqs` do Compose e Docker |
| `bun run test` | os três acima, em sequência | idem |
| `bun run test:chaos` | conjunto focado de testes de falha (subconjunto de `test:concurrency`) | idem |
| `bun run migrate:down` | desfaz todas as migrations | — |

Resultado esperado: todos verdes, e todo teste que toca wallet termina com `assertWalletMatchesLedger`
(saldo = Σ créditos − Σ débitos, cadeia encadeada, saldo ≥ 0).

## 4. Validação manual dos fluxos principais

Exemplos com `app1`. Os ids gerados variam; use os retornados.

### 4.1 Abrir wallet (US1)

```bash
curl -s -X POST localhost:3001/wallets -H 'content-type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"100.00","currency":"BRL"}}'
```

Esperado: `201` com `version` 1 e `balance` "100.00". Repetir o comando dá `409 WALLET_ALREADY_EXISTS` com
`error.details.walletId` igual ao id criado (I-52). `GET /wallets/{id}/ledger` mostra um lançamento CREDIT
"100.00" (antes "0.00", depois "100.00").

### 4.2 Apostar e reenviar (US2, US3)

```bash
curl -s -X POST localhost:3001/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:bet-1' \
  -d '{"providerId":"provider-a","externalTransactionId":"bet-1","playerId":"player-1","walletId":"<id>",
       "roundId":"r1","gameId":"g1","kind":"BET","money":{"amount":"80.00","currency":"BRL"}}'
```

Esperado: `201`, `PROCESSED`, saldo "20.00", `idempotentReplay` false. O mesmo comando na `app2` dá `200` com o
mesmo `transactionId`, saldo "20.00" e `idempotentReplay` true. Mudar `amount` mantendo a chave dá
`409 IDEMPOTENCY_CONFLICT`.

### 4.3 Rejeição, reversão e pendência (US2, US5, US6)

- BET de "80.00" com outra chave → `422`, `REJECTED`, `INSUFFICIENT_FUNDS`, `retryable` false, saldo "20.00".
- REFUND de "80.00" referenciando `bet-1` → `201`, saldo "100.00"; um ROLLBACK de `bet-1` depois → `422
  ALREADY_REVERSED`.
- ROLLBACK referenciando um id externo inexistente → `202`, `PENDING_REFERENCE`, saldo inalterado.
- LOSS de "0.00" → `201`, `PROCESSED`, sem lançamento e sem mudança de `version`.

### 4.4 Contrato de erros (US7, US9)

- Sem `Idempotency-Key` → `400 IDEMPOTENCY_KEY_REQUIRED`.
- `amount` como número JSON → `400 VALIDATION_ERROR`.
- `X-Correlation-Id: abc-123` → o mesmo valor volta no header da resposta; um valor inválido (ex.: 200
  caracteres) não causa 400, e a resposta traz um UUIDv7 gerado.
- `docker compose stop postgres` e uma submissão → `503 SERVICE_UNAVAILABLE` com `Retry-After`;
  `docker compose start postgres` e o reenvio → processado uma única vez.

## 5. Mapa de validação dos critérios de sucesso

| Critério | Onde é provado |
|----------|----------------|
| SC-001 100/80/80 (≥ 20 repetições) | `test/concurrency/hot-wallet-race.test.ts` |
| SC-002 mesma BET 50× em paralelo | `test/concurrency/idempotent-burst.test.ts` |
| SC-003 REFUND × ROLLBACK simultâneos | `test/concurrency/reversal-race.test.ts` |
| SC-004 wallets distintas sem interferência; lock segurado numa wallet não atrasa outra | `test/concurrency/wallet-isolation.test.ts` |
| SC-005 tudo acima com 3 instâncias | harness de `test/concurrency` (todos os testes usam 3 processos) |
| SC-006 saldo = ledger em toda wallet | `assertWalletMatchesLedger` ao fim de cada teste |
| SC-007 sem efeito parcial; reenvio após queda | `test/integration/atomicity.test.ts` (failpoint) e `test/concurrency/crash-recovery.test.ts` |
| SC-008 ledger imutável | `test/integration/schema-guards.test.ts` |
| SC-009 cinco situações distinguíveis | `test/integration/http-contract.test.ts` |
| SC-010 paginação estável sob escrita | `test/integration/ledger-pagination.test.ts` |
| SC-011 < 1 s sem disputa | asserção de duração em `test/integration/http-contract.test.ts` |
| FR-059 lock timeout → 503 sem efeito | `test/concurrency/lock-timeout.test.ts` (`WALLET_LOCK_TIMEOUT_MS` reduzido; lock segurado por conexão externa) |
