# Quickstart: Reconciliação, Health Checks e Métricas

**Feature**: `003-reconciliation-health-metrics` | Guia de validação ponta a ponta. Os contratos estão em
[contracts/](contracts/) e as leituras em [data-model.md](data-model.md); aqui ficam só os passos e o resultado esperado.

## 1. Pré-requisitos

- O ambiente da 001 e da 002 funcionando (Bun 1.4.4, Docker com Compose, MiniStack, `.env` a partir do `.env.example`).
- Nenhuma variável nova: o prazo das checagens de ready (2 s) é fixo (I-75).

## 2. Subir o cluster

```bash
docker compose --profile cluster up -d --build
docker compose ps        # migrate e queue-init com saída 0; app1 (3001), app2 (3002), app3 (3003) no ar
```

## 3. Cenários

### 3.1 Health

```bash
curl -i http://localhost:3001/health/live     # 200 {"status":"ok"}
curl -i http://localhost:3001/health/ready    # 200 {"status":"ok","checks":{"postgres":"up","sqs":"up"}}
```

### 3.2 Reconciliação consistente

```bash
W=$(curl -s -X POST localhost:3001/wallets -H 'Content-Type: application/json' \
  -d '{"playerId":"p-quickstart","initialBalance":{"amount":"100.00","currency":"BRL"}}' | jq -r .id)
curl -s -X POST localhost:3001/wagering/transactions -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:qs-bet-1' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"qs-bet-1\",\"playerId\":\"p-quickstart\",\"walletId\":\"$W\",\"roundId\":\"r1\",\"gameId\":\"g1\",\"kind\":\"BET\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"
curl -s -X POST localhost:3002/wallets/$W/reconciliation | jq
```

Esperado: `storedBalance` e `calculatedBalance` 75.00, `difference` 0.00, `consistent` true, `chainConsistent` true,
`checkedEntries` 2 (abertura e BET), sem `firstBrokenSeq`. Repetir em outra instância dá o mesmo resultado.

### 3.3 Erros

```bash
curl -i -X POST localhost:3001/wallets/not-a-uuid/reconciliation                              # 400 VALIDATION_ERROR
curl -i -X POST localhost:3001/wallets/0192f291-27dd-7d3f-8071-000000000001/reconciliation    # 404 WALLET_NOT_FOUND
```

### 3.4 Métricas

```bash
curl -s localhost:3001/metrics | grep -E '^(transactions_total|duplicates_total|outbox_pending_events|reconciliation_divergences_total)'
```

Esperado: `transactions_total{status="PROCESSED"}` ≥ 1 na instância que atendeu a BET; `outbox_pending_events` e
`outbox_oldest_pending_age_seconds` presentes (0 quando o publicador já publicou tudo);
`reconciliation_divergences_total 0`. Nenhum rótulo com `walletId` ou valor monetário.

### 3.5 Dependência fora

```bash
docker compose stop sqs
curl -i localhost:3001/health/ready     # 503 {"status":"unavailable","checks":{"postgres":"up","sqs":"down"}} em até ~2 s
curl -i localhost:3001/health/live      # 200
# uma nova BET por HTTP continua respondendo 201 (I-34)
docker compose start sqs                # ready volta a 200 sem reiniciar a app

docker compose stop postgres
curl -i localhost:3001/health/ready     # 503 com "postgres":"down"; live continua 200
docker compose start postgres
```

### 3.6 Encerramento

```bash
docker compose stop app2 &              # SIGTERM; durante a drenagem:
curl -i localhost:3002/health/ready     # 503 enquanto a instância drena (pode já ter saído se não havia trabalho)
wait; docker compose ps app2            # saída 0
```

### 3.7 Divergência

Não é reproduzível no cluster: as guardas do banco impedem alterar saldo ou ledger por fora (001). O caminho de
divergência é provado pela suíte, num banco de teste criado sem as guardas (research R-38):

```bash
bun test --preload ./test/support/db-setup.preload.ts test/integration/reconciliation-divergence.test.ts
```

## 4. Suíte

```bash
docker compose up -d postgres sqs
bun run typecheck && bun run test
```
