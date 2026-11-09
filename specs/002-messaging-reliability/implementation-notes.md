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

## US2

| # | Decisão | Motivo | Task |
|---|---------|--------|------|
| N-13 | `TransactionResult.balance` passou a ser opcional e o `toTransactionResult` aceita FAILED (com `failureCode` e `retryable` false); o `httpStatusFor` lança `FailedTransactionReplayError` para FAILED. | O replay de FAILED pela fila precisa seguir o caminho normal de replay para gravar a inbox (contracts/queues.md: "replay … inclusive de FAILED … inbox gravada"); só o HTTP transforma FAILED em 500. O schema permite FAILED sem saldo observado (`wager_tx_observed_balance_ck`), embora o worker sempre o tenha (I-61). Nenhum saldo é inventado. | T056 |
| N-14 | `FailedTransactionReplayError` não é registrado como `http.unexpected_error`. | É um estado terminal conhecido (I-62), não uma falha desta requisição. | T056 |
| N-15 | O envio à DLQ usa `MessageDeduplicationId` = `messageId` quando o envelope o tem válido; senão, o id da mensagem no SQS. O `MessageGroupId` é o da mensagem original. | contracts/queues.md (grupo original, deduplicação pelo `messageId`); sem `messageId` válido o id do SQS é estável entre reentregas da mesma mensagem. | T055 |
| N-16 | Transitório no 5º recebimento continua `retry` (a aplicação não envia à DLQ); quem leva à DLQ é o redrive no 6º recebimento, sem atributos. | I-30 e contracts/queues.md (o redrive é o caminho do transitório; só o inesperado é enviado pela aplicação no 5º, I-71). | T054 |

### Revisão da US2 contra o review-checklist.md (T057)

Diff revisado: `message-classification.ts`, `consume-wager-message.use-case.ts` (classificação e DLQ),
`transaction-result.ts`, `global-exception.filter.ts`, `errors.ts`.

| Item | Resultado | Evidência |
|------|-----------|-----------|
| Dinheiro sem `number` | OK | Nenhuma conta com dinheiro; `retryDelaySeconds` e atributos de DLQ são contagens, não valores. |
| Saldo só sob lock | OK | A US2 não escreve saldo nem status; o replay de FAILED não muda a transação (T053 confere status e wallet). |
| Unicidade no banco | OK | Conflitos e duplicatas continuam detectados pelas constraints da 001 e por `inbox_messages_pk`; a classificação só lê o tipo do erro. |
| Outbox na mesma transação | OK | Nenhum evento novo; replay de FAILED pela fila não grava evento (T053). |
| Triggers presentes | N/A | Sem migration nova. |
| Sem mock em integração e concorrência | OK | `fake-sqs` só em `test/unit/consume-wager-message.test.ts`; T050–T053 com MiniStack e PostgreSQL reais (o proxy TCP repassa o protocolo real). |
| Sem relógio nem id no domínio | OK | Nada de tempo ou id novo; a espera vem do `ApproximateReceiveCount`. |
| Ordem de lock wallet primeiro | N/A | Nenhuma escrita nova em `wager_transactions`. |
| Ack só depois do commit | OK | `submissionAction` só é avaliado depois que `submit` resolveu; erros nunca geram ack; transitórios e inesperados (n < 5) só mudam a visibilidade (T051, T052). |
| DLQ antes de apagar | OK | `apply` (`dlq`): `sqs.send(dlq, …)` aguardado antes de `sqs.delete(principal, …)`; se o envio falhar, a exceção sobe e o delete não acontece (T049 com o fake: ordem `send` → `delete` e nenhum delete quando o send falha; T050 e T052 com o MiniStack: mensagem na DLQ com os atributos e ausente da principal). |
| Ausência de FAILED no consumidor | OK | O consumidor não chama `fail` nem grava FAILED; inesperado vai à DLQ no 5º recebimento (T052 confere zero linhas FAILED). |
| Publisher marca depois do SendMessage | N/A | Publicador é da US3. |

## US3

| # | Decisão | Motivo | Task |
|---|---------|--------|------|
| N-17 | `OutboxMessage.scheduleRetry(now, backoff?)` ganhou o backoff opcional (padrão 1 a 60 s, os valores de antes); o publicador passa `PUBLISHER_BACKOFF_MIN_MS`/`MAX_MS`. | As variáveis existem (R-27, T002) com os mesmos padrões do I-65; sem isso ficariam validadas e ignoradas. Com os padrões, o comportamento é idêntico ao da 001 (teste unitário 1, 2, 4 … 60 s). | T063 |
| N-18 | O claim usa duas instruções na transação curta (`SELECT … FOR UPDATE SKIP LOCKED` e `UPDATE … WHERE id IN (…)`), com placeholders `?` gerados por quantidade, e roda pela unit of work (lock_timeout e conversão de falha transitória). | Fidelidade ao data-model §3.2; listas de parâmetros explícitas evitam depender da expansão de arrays do driver. | T062 |
| N-19 | Falha ao marcar (`markPublished`) ou ao reagendar depois de um envio é registrada e não interrompe o lote; o evento volta pelo lease. | Publicação ao menos uma vez (FR-019): reenvio com o mesmo eventId é seguro; derrubar o lote atrasaria os outros eventos (FR-018). | T063 |
| N-20 | Limitação registrada: o prazo de uma chamada ao SQS é 30 s com até 2 tentativas do SDK (N-02), maior que o lease padrão de 30 s numa falha extrema; nesse caso outro publicador pode republicar o evento antes do primeiro terminar. O efeito é só uma duplicata com o mesmo eventId (deduplicada pela fila FIFO em 5 min e tolerada pelo consumidor, I-31). O ajuste fino do prazo de envio fica para a US6 (T081, falhas de SQS). | Não afeta corretude; registrado para não esconder a diferença em relação ao "lease > timeout de envio" do R-27. | T063, T081 |
| N-21 | Os testes da US3 (T058–T061) foram escritos antes da implementação, mas não executados em vermelho antes dela: dependiam de um módulo inexistente (`mikro-orm-outbox.repository.ts`) e de eventos de log do publicador, então não podiam passar. | Registro honesto do processo TDD. | T058–T061 |

### Revisão da US3 contra o review-checklist.md (T065)

Diff revisado: `mikro-orm-outbox.repository.ts`, `publish-outbox.use-case.ts`, `outbox-publisher.worker.ts`, `outbox.module.ts`,
`outbox-message.ts` (backoff configurável), `app.module.ts`.

| Item | Resultado | Evidência |
|------|-----------|-----------|
| Dinheiro sem `number` | OK | O publicador não lê valores; o corpo é o `payload` jsonb gravado, com dinheiro já em string. |
| Saldo só sob lock | N/A | O publicador não escreve saldo nem status de transação. |
| Unicidade no banco | OK | Sem unicidade nova; a publicação repetida é segura pelo `eventId` (deduplicação FIFO e consumidor). |
| Outbox na mesma transação | OK | O publicador só lê linhas já confirmadas (o claim roda numa transação própria depois do commit do efeito); nada é publicado dentro da transação de negócio (FR-020). |
| Triggers presentes | N/A | Sem migration nova. |
| Sem mock em integração e concorrência | OK | T058–T061 com MiniStack e PostgreSQL reais; a indisponibilidade da fila é um proxy TCP real cortado. |
| Sem relógio nem id no domínio | OK | `now` vem do `Clock`; `scheduleRetry` deriva do `now` recebido. Varredura sem `new Date()`/`Date.now(` no diff. |
| Ordem de lock wallet primeiro | N/A | O publicador não toca `wager_transactions` nem `wallets`. |
| Ack só depois do commit | N/A | Sem consumo novo. |
| DLQ antes de apagar | N/A | Sem DLQ nova. |
| Publisher marca como publicado só depois do SendMessage | OK | `publish`: `await sqs.send(…)` → failpoint `before_publish_mark` → `markPublished` (`UPDATE … SET published_at = ? WHERE id = ? AND published_at IS NULL`, idempotente). Falha no envio → só `scheduleRetry` (`attempts`, `next_attempt_at`), nunca marca. T058 (falha de envio: `published_at` nulo, 1 s e 2 s), T060 (queda entre envio e marca: tudo publicado, nada pendente). |
| Claim com `SKIP LOCKED` | OK | `claim`: `SELECT … WHERE published_at IS NULL AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ? FOR UPDATE SKIP LOCKED` + avanço do lease, numa transação curta; dois claims seguidos não repetem linhas (T058) e 3 publicadores não se bloqueiam (T060, T061). |
