# Implementation notes: Mensageria Confiável (002)

Decisões tomadas durante o `/speckit-implement` para ambiguidades que **não** envolvem regra financeira (dinheiro, saldo,
ledger, idempotência ou outbox). Leitura mais conservadora em cada caso. Formato: decisão, motivo, task.

## Fundação

| # | Decisão | Motivo | Task |
|---|---------|--------|------|
| N-01 | A URL de cada fila é resolvida pelo nome no **primeiro uso** e guardada (não no boot); falha na resolução não é guardada e é repetida na chamada seguinte. | Resolver no boot faria uma instância só HTTP (papéis desligados) depender do SQS para subir, contra o FR-033 (HTTP continua com a fila fora), e quebraria as suítes da 001 sem SQS. O efeito pedido pelo R-21 (resolver uma vez por nome) se mantém. | T027 |
| N-02 | O cliente SQS usa `maxAttempts` 2, `connectionTimeout` 3 s e `requestTimeout` 30 s (maior que o long polling máximo de 20 s). | Sem prazo, um envio pendurado prenderia o publicador; com prazo menor que 20 s, um long polling válido seria cortado. | T027 |
| N-03 | Os serviços `app-test` e `app-test-init` do profile `test` não têm `depends_on`; o harness sobe com `docker compose run -d --no-deps` e passa `DATABASE_URL` e as filas do arquivo por `-e`. | Com dependências, o `run` subiria `migrate` e `queue-init` contra o banco e as filas padrão a cada teste. | T003, T034 |
| N-04 | O `PollingLoop` aplica o backoff (1 a 30 s, dobrando) a **qualquer** erro da iteração, não só à indisponibilidade, e volta ao intervalo no primeiro sucesso. | Mais conservador: nenhuma exceção escapa do laço e um erro inesperado não vira laço quente. A classificação fina por iteração continua sendo do trabalhador (consumidor, publicador, worker). | T011, T031 |
| N-05 | O `OrmLifecycle` registra `shutdown.workers_drained` e `shutdown.orm_closed`, e o handler de sinal registra `shutdown.started`, `shutdown.signal_ignored`, `shutdown.completed`, `shutdown.timeout` e `shutdown.failed`. | O T035 exige que o log mostre o drain do `WorkerRegistry` e o fechamento do ORM. | T032, T035 |
| N-06 | O handler de sinal é instalado só quando `src/main.ts` roda como processo (`import.meta.main`); o `bootstrap()` usado pelos testes em processo não instala nada. | Os testes em processo chamam `app.close()` diretamente (os mesmos hooks) e não podem registrar `process.on('SIGTERM')` no processo do `bun test`. | T032 |
| N-07 | O `MessagingModule` foi criado já na Fundação, só com a porta `SQS_PORT` → `AwsSqsAdapter`; o consumidor entra nele na US1. | O T033 expõe o `SqsPort` no `RunningApp`, o que exige o provider registrado. | T033, T046 |
| N-08 | Envelope: o `messageId` acompanha o erro só quando é válido; com `messageId` inválido ou ausente o erro de DLQ não tem `messageId`. | O envio à DLQ usa o `messageId` como `MessageDeduplicationId`; um id inválido não pode ser usado (a deduplicação cai no id do SQS, definido no consumidor). | T036 |
