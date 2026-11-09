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

## US1

| # | Decisão | Motivo | Task |
|---|---------|--------|------|
| N-09 | Na US1, qualquer erro no processamento de uma mensagem vira `retry` (sem delete, `ChangeMessageVisibility` com `min(base × 2^(n−1), teto)`); a classificação em transitório, permanente e inesperado entra na US2. | O T045 manda não apagar a mensagem com erro ainda sem classificação; devolver a visibilidade com o backoff é o comportamento transitório do I-30 e é o que o T041 espera (`CONSUMER_RETRY_BASE_SECONDS=1`). | T045 |
| N-10 | O failpoint `after_commit_before_ack` dispara em todo ack de uma entrega que gravou algo (efeito novo ou replay com linha de inbox); não dispara no ack de duplicata da inbox, que não fez commit. | O R-29 o define "depois do commit e antes do DeleteMessage"; sem commit não há o que provar. | T045 |
| N-11 | No T042, as 50 cópias vão em `MessageGroupId`s distintos (`<walletId>-<i>`). | Com o grupo da wallet, o SQS FIFO entrega uma por vez; com grupos distintos as entregas são de fato simultâneas em instâncias diferentes, e o único efeito tem de vir do banco (constitution III). Teste mais forte, mesmo critério. | T042 |
| N-12 | A linha de log por mensagem é `consumer.message`, com `outcome` (`processed`, `replay`, `duplicate`, `error`), `status`, `receiveCount` e, em erro, `errorClass`, `error` (nome da classe) e `retryInSeconds`. | FR-037 (ids vêm do contexto) e T043, que confere o `ApproximateReceiveCount` 2 da reentrega pelo log. | T045 |

### Revisão da US1 contra o review-checklist.md (T047)

Diff revisado: `submit-wager-transaction.use-case.ts` (origem fila, inbox, causationId), `consume-wager-message.use-case.ts`,
`message-batch.ts`, `wager-transactions.consumer.ts`, `messaging.module.ts`, `wagering.module.ts`, `inbox-message.ts`.

| Item | Resultado | Evidência |
|------|-----------|-----------|
| Dinheiro sem `number` | OK | Nenhuma conta nova com dinheiro; o envelope reusa o `moneySchema` da 001 (string); varredura sem `Number(`/`parseFloat(` no diff. |
| Saldo só sob lock | OK | Efeito novo só em `applyUnderLock`, depois de `wallets.lockById(em, …)`, com o EM da transação. Fora do lock só há a gravação da inbox de um replay (linha própria, sem saldo nem status). |
| Unicidade no banco | OK | Duplicata de mensagem barrada por `inbox_messages_pk`; o 23505 é classificado pelo nome da constraint (`inbox-race`) e relido fora da transação desfeita (`resolveInboxRace`). Idempotência continua nos índices da 001. |
| Outbox na mesma transação | OK | `applyUnderLock`: transação → saldo → ledger → inbox → outbox, tudo com o mesmo `em`; nada é publicado pelo consumidor. T041 prova que a falha antes do commit não deixa nenhuma das quatro linhas. |
| Triggers presentes | OK | `inbox_no_update_delete_trg` e `inbox_no_truncate_trg` com `down`; guardas da 001 intactas (T015, T016). |
| Sem mock em integração e concorrência | OK | `fake-sqs` só em `test/unit/consumer-batching.test.ts`; T039–T043 usam MiniStack e PostgreSQL reais; guardrail T118 verde. |
| Sem relógio nem id no domínio | OK | `receivedAt`/`processedAt` da inbox vêm do `Clock`; nenhum `new Date()`, `Date.now(`, `randomUUID(` ou `Math.random(` em `domain`/`application`. |
| Ordem de lock wallet primeiro | OK | A releitura da inbox e da idempotência acontece depois do `FOR UPDATE` da wallet; a única escrita fora do lock é a inbox do replay, que não toca `wager_transactions`. |
| Ack só depois do commit | OK | `consumeBatch` só chama `apply` depois que `process` resolve; `process` só resolve depois que `unitOfWork.run` confirmou. Erro → `retry` sem delete. T043 (queda entre commit e ack) e T041 provam. |
| DLQ antes de apagar | N/A | A US1 não envia à DLQ (US2). |
| Publisher marca depois do SendMessage | N/A | Publicador é da US3. |
