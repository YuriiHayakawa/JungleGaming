# Contrato: GET /metrics

**Feature**: `003-reconciliation-health-metrics` | Normativo junto com a spec (FR-019 a FR-024) e o I-76.

- Sem autenticação. `200`, `Content-Type: text/plain; version=0.0.4; charset=utf-8` (formato de texto de exposição
  do Prometheus), escrito à mão, sem dependência nova.
- Métricas por instância, acumuladas desde o início do processo (exceto os gauges da outbox, lidos do banco a cada
  coleta).
- Requisições a `/metrics` são logadas em nível `debug`.

## Famílias

| Família | Tipo | Rótulos |
|---------|------|---------|
| `transactions_total` | counter | `status` (PROCESSED, REJECTED, PENDING_REFERENCE, FAILED) |
| `duplicates_total` | counter | `source` (idempotency, inbox) |
| `retries_total` | counter | `worker` (consumer, publisher, pending_worker) |
| `dlq_total` | counter | `errorCode`, `errorClass` |
| `lock_conflicts_total` | counter | — |
| `reconciliation_divergences_total` | counter | — |
| `processing_latency_ms` | histogram | `worker` (consumer, pending_worker) |
| `outbox_lag_ms` | histogram | — |
| `outbox_pending_events` | gauge | — |
| `outbox_oldest_pending_age_seconds` | gauge | — |

Rótulos permitidos (lista fechada): `status`, `source`, `worker`, `errorCode`, `errorClass`, `outcome`, `kind`. Nunca
`walletId`, `providerId`, ids de transação, mensagem ou evento, nem valores monetários.

Buckets dos histogramas (ms): 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, `+Inf`.

## Exemplo (trecho)

```text
# HELP transactions_total Wager transactions recorded, counted after commit.
# TYPE transactions_total counter
transactions_total{status="PROCESSED"} 42
transactions_total{status="REJECTED"} 3
# HELP reconciliation_divergences_total Reconciliations that found a divergence.
# TYPE reconciliation_divergences_total counter
reconciliation_divergences_total 0
# HELP processing_latency_ms Processing latency per message or pending re-evaluation, in milliseconds.
# TYPE processing_latency_ms histogram
processing_latency_ms_bucket{worker="consumer",le="5"} 3
processing_latency_ms_bucket{worker="consumer",le="10"} 9
processing_latency_ms_bucket{worker="consumer",le="+Inf"} 12
processing_latency_ms_sum{worker="consumer"} 118
processing_latency_ms_count{worker="consumer"} 12
# HELP outbox_pending_events Outbox events not yet published, read at scrape time.
# TYPE outbox_pending_events gauge
outbox_pending_events 2
# HELP outbox_oldest_pending_age_seconds Age of the oldest unpublished outbox event, read at scrape time.
# TYPE outbox_oldest_pending_age_seconds gauge
outbox_oldest_pending_age_seconds 1.274
```

- Família sem nenhuma observação ainda: `# HELP` e `# TYPE` presentes; contadores sem rótulo aparecem com 0.
- Banco indisponível na coleta: os dois gauges da outbox são omitidos; o restante é respondido normalmente (200).
- Valores de rótulo escapados (`\\`, `\"`, `\n`); séries em ordem estável (nome, depois rótulos).
