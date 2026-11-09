# Contrato HTTP: reconciliação e health checks

**Feature**: `003-reconciliation-health-metrics` | Normativo junto com a spec (FR-001 a FR-018) e as interpretações
I-37, I-38, I-53, I-74 e I-75. Nenhum destes endpoints exige autenticação. Todos devolvem o header `X-Correlation-Id`
(001/FR-060).

## POST /wallets/:walletId/reconciliation

- Sem corpo; um corpo enviado é ignorado. Somente leitura (snapshot `REPEATABLE READ`, `READ ONLY`).
- `walletId`: UUID (o mesmo esquema de `GET /wallets/:walletId` da 001).

### 200: wallet consistente

```json
{
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "storedBalance":     { "amount": "975.00", "currency": "BRL" },
  "calculatedBalance": { "amount": "975.00", "currency": "BRL" },
  "difference":        { "amount": "0.00",   "currency": "BRL" },
  "consistent": true,
  "chainConsistent": true,
  "checkedEntries": 42
}
```

### 200: divergência (nada é corrigido)

```json
{
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "storedBalance":     { "amount": "960.00", "currency": "BRL" },
  "calculatedBalance": { "amount": "975.00", "currency": "BRL" },
  "difference":        { "amount": "-15.00", "currency": "BRL" },
  "consistent": false,
  "chainConsistent": false,
  "firstBrokenSeq": 1871,
  "checkedEntries": 42
}
```

- `difference` = stored − calculated, com sinal; strings com 2 casas (001/FR-003).
- `firstBrokenSeq` (inteiro) só aparece com `chainConsistent` false.
- `consistent` = `difference` zero e `chainConsistent` true.
- Efeitos da divergência: uma linha de log `reconciliation.divergence` em nível `error`, com `walletId`,
  `correlationId`, `checkedEntries`, `firstBrokenSeq` e `consistent: false`, **sem** valores monetários; +1 em
  `reconciliation_divergences_total`.

### Erros (envelope único do I-38)

| Situação | Status | `error.code` | `retryable` |
|----------|--------|--------------|-------------|
| `walletId` malformado | 400 | `VALIDATION_ERROR` | false |
| Wallet inexistente | 404 | `WALLET_NOT_FOUND` | false |
| Banco indisponível | 503 (+ `Retry-After`) | `SERVICE_UNAVAILABLE` | true |
| Erro inesperado | 500 | `INTERNAL_ERROR` | true |

## GET /health/live

- Sempre `200 {"status":"ok"}` enquanto o processo responde; não consulta dependências.

## GET /health/ready

- Checa, em paralelo e com prazo de 2 s cada: `postgres` (`SELECT 1`) e `sqs` (`GetQueueAttributes` das filas de
  transações, DLQ e eventos configuradas).
- Corpo próprio, fora do envelope do I-38; `Content-Type: application/json`.

| Situação | Status | Corpo |
|----------|--------|-------|
| Tudo disponível, sem encerramento | 200 | `{"status":"ok","checks":{"postgres":"up","sqs":"up"}}` |
| Banco fora | 503 | `{"status":"unavailable","checks":{"postgres":"down","sqs":"up"}}` |
| Fila fora (ou filas inexistentes) | 503 | `{"status":"unavailable","checks":{"postgres":"up","sqs":"down"}}` |
| Encerrando (WorkerRegistry drenando) | 503 | `{"status":"unavailable","checks":{"postgres":"up","sqs":"up"}}` (estado real de cada dependência) |

- As requisições a `/health/*` são logadas em nível `debug`.
