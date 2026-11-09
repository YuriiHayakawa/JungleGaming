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

## Ajustes pedidos antes da US4 (2026-11-09)

| # | Decisão | Motivo | Task |
|---|---------|--------|------|
| N-22 | Fecha a limitação do N-20. (a) O cliente SQS das chamadas curtas (SendMessage, DeleteMessage, ChangeMessageVisibility, GetQueueUrl, GetQueueAttributes) usa prazo de **5 s por tentativa com 1 nova tentativa** (`maxAttempts` 2); só o ReceiveMessage usa um segundo cliente com 30 s (long polling de até 20 s). Uma chamada curta leva no máximo ~10 s, abaixo do lease de 30 s. (b) O publicador **para o lote na primeira falha de envio**: o evento que falhou recebe `attempts + 1` e backoff (`OutboxMessage.scheduleRetry`); os reservados e ainda não tentados são **devolvidos** (`next_attempt_at` = agora, sem incrementar `attempts`, `WHERE published_at IS NULL`). (c) Uma rodada com falha de envio faz o laço do publicador aplicar o backoff de 1 a 30 s (`PublishRoundFailedError`), em vez de voltar ao intervalo normal. Falha ao devolver é só registrada (`publisher.release_failed`): o lease vence e os eventos voltam. | Pedido do usuário (ajuste 1). (c) é a leitura conservadora do FR-033 ("tentar de novo com espera crescente") e do plan ("os laços esperam com backoff de 1 a 30 s"): sem ela, com a fila fora, cada varredura bateria no SQS de novo a cada `PUBLISHER_POLL_MS`. Os testes T058 ("falha de envio") e T059 (SQS fora) foram reescritos para a nova regra, mantendo o que provam: o primeiro acompanha cada evento e confere 1 s e depois 2 s de backoff por evento; o segundo confere que nenhum evento fica preso no lease e que tudo é publicado depois da volta. Teste novo: `outbox-publisher-batch-failure.test.ts` (lote de 10 com SQS fora → 1 com `attempts` 1 e 9 devolvidos com `attempts` 0; escrito depois do código, não foi visto vermelho antes). | T063, T081 |
| N-23 | Claim do publicador com `ORDER BY next_attempt_at, id`. | Pedido do usuário (ajuste 2): ordem determinística no empate. Coberto pelo teste do N-22, que iguala o `next_attempt_at` de todos os eventos antes da rodada; com `id DESC` o teste fica vermelho (mutação conferida). | T062 |
| N-24 | Testes que falham se um resultado não FAILED sair sem `balance`: unitário (`transaction-result.test.ts`: PROCESSED, REJECTED e PENDING_REFERENCE trazem o saldo; sem saldo observado, o guarda recusa; só FAILED pode sair sem) e de contrato HTTP (`http-contract.test.ts`: 201, 200, 202 e 422, novos e em replay, sempre com `balance`). | Pedido do usuário (ajuste 3), para fechar o risco do N-13. Mutação conferida: tirar o `balance` dos não PROCESSED derruba os dois. | T044 (N-13) |

## US4

| # | Decisão | Motivo | Task |
|---|---------|--------|------|
| N-25 | A 1ª tentativa de uma pendente nova fica em `created_at` + `PENDING_BACKOFF_BASE_MS` (padrão 5000), e não mais na constante de 5 s do submit da 001. | O data-model diz "a 1ª tentativa foi agendada em created_at + 5 s, a base do backoff do I-21", e o FR-032 pede a base configurável. Com o padrão, o comportamento é idêntico ao da 001; os testes usam base curta. | T072 |
| N-26 | `reference_attempts` conta as avaliações que **reagendaram**; a avaliação que esgota rejeita com `REFERENCE_NOT_FOUND` sem incrementar (o `reject` do domínio não toca nas tentativas). Com 10 tentativas, a linha rejeitada fica com 9. | A data-model só define o incremento em `scheduleNextReferenceAttempt`; mudar `reject` alteraria o domínio da 001. A contagem do esgotamento (`attemptsAfterThis = reference_attempts + 1`) inclui a avaliação atual, como no I-64. | T074 |
| N-27 | Ordem do I-63 sob o lock: antes de **concluir** (aplicar ou rejeitar) uma pendente, o worker confere, já com a wallet travada, se ainda existe irmã mais antiga pendente (mesma wallet e mesma referência). Se existe, não grava nada (`deferred`), avalia as irmãs (cada uma na própria transação) e tenta de novo, até 3 rodadas; depois disso, a pendente volta quando o lease vence. Reagendamento e esgotamento não são adiados. | A leitura das irmãs antes do lock (plan, passo 2.2) não basta: entre a avaliação da irmã (referência ainda ausente) e a da reservada, a BET pode chegar, e a mais nova seria aplicada primeiro. A conferência sob o lock fecha a janela sem mudar a ordem de lock. Teste de mutação: sem ela, o T070 fica vermelho. | T074 |
| N-28 | Falha transitória numa reavaliação: lock da wallet esgotado (`55P03`) só pula aquela pendente e segue o lote; qualquer outra falha transitória (banco fora, conexão perdida, pool esgotado) interrompe a rodada e o laço aplica o backoff de 1 a 30 s. Nos dois casos, nada é gravado, a tentativa não conta e a pendente volta quando o lease vence. | Uma wallet disputada não pode atrasar as outras pendentes do lote; com o banco fora, insistir em cada pendente só gastaria o prazo do lease (FR-034). | T074 |
| N-29 | "Erro permanente inesperado" (FR-029) é todo erro que não é transitório nem a 1ª violação do índice de reversão única: quebra de invariante (`P0001`, `23514` etc.), erro desconhecido e a 2ª violação do índice. Vira FAILED `INTERNAL_ERROR` numa transação separada, sob o lock da wallet e com `WHERE status = 'PENDING_REFERENCE'`; se essa marcação também falhar, a pendente volta pelo lease. | Plan, "Worker", itens 3 a 5. Mesma separação do submit, onde esses erros viram 500. | T074 |
| N-30 | O failpoint `after_pending_resolution_before_commit` dispara em toda reavaliação que grava (conclusão, esgotamento ou reagendamento), antes do commit; não dispara quando a linha já não está pendente nem no adiamento. | data-model §3.3, passo 7, vale para todos os ramos. | T074 |
| N-31 | `bootstrap()` e `startApp()` aceitam um `RandomSource` opcional; o padrão continua `CryptoRandomSource`. | O T066 pede `FixedRandom` nos testes de integração em processo; sem a porta no bootstrap, o jitter da app seria aleatório. Produção não muda. | T066 |
| N-32 | O claim do worker ordena por `next_reference_attempt_at, created_at, id` e atualiza `updated_at` junto com o lease. A antecipação também atualiza `updated_at`. | Desempate determinístico, como no ajuste do publicador (N-23); `updated_at` como na data-model §3.3 e §3.4. | T073 |
| N-33 | Os testes da US4 foram escritos antes da implementação; só o T067 foi executado em vermelho antes dela (3 falhas por timeout). T066 e T068–T071 dependiam do worker inexistente. A ordem do I-63 foi conferida por mutação: sem o adiamento e sem as irmãs, o T070 falha. | Registro honesto do processo TDD, como no N-21. | T066–T071 |
| N-34 | Cada reavaliação gera uma linha de log `pending_worker.evaluated` (`outcome`, `status`, `failureCode`, `referenceAttempts`), com `correlationId`, `transactionId`, `walletId` e `providerId` no contexto. Falhas: `pending_worker.attempt_failed` (transitória), `pending_worker.failed` (FAILED) e `pending_worker.poll_failed` (rodada). | FR-037 para o worker e prova, no T069, de que as duas instâncias reavaliaram de fato. | T074, T075 |

### Revisão da US4 contra o review-checklist.md (T076)

Diff revisado: `transaction-recorder.ts` (extraído do submit), `submit-wager-transaction.use-case.ts`, `resolve-pending-reference.use-case.ts`,
`mikro-orm-wager-transaction.repository.ts` (claim, irmãs, resolução, reagendamento, FAILED, antecipação),
`pending-reference.worker.ts`, `wagering.module.ts`, `app.module.ts`/`main.ts` (porta do RandomSource).

| Item | Resultado | Evidência |
|------|-----------|-----------|
| Dinheiro sem `number` | OK | Saldo e lançamento só por `Money` (`wallet.debit/credit`, `wallet.balance`); o repositório grava `observedBalance.amount` (string). Os únicos `number` são tempo (`delayBefore`, lease) e contagens. Varredura sem `Number(`/`parseFloat(` no diff. |
| Saldo só sob lock | OK | `evaluateUnderLock`: `wallets.lockById(em, …)` é a primeira instrução; recorder, reagendamento e outbox usam o mesmo `em`. O FAILED (`fail`) também trava a wallet antes de gravar. Nenhuma escrita por fork. |
| Unicidade no banco | OK | Nenhuma unicidade nova. Corrida de reversão: `23505` em `wager_tx_single_reversal_uq` → uma repetição; a 2ª vira FAILED (N-29). "Concluída uma vez" vem do lock da wallet + releitura + `UPDATE … WHERE status = 'PENDING_REFERENCE'` (1 linha, senão erro). T068: 30 pendentes em 3 instâncias, um lançamento cada. |
| Outbox na mesma transação | OK | `evaluateUnderLock`: `outbox.append(em, …)` antes do commit; o FAILED não gera evento. T066 (FAILED): só o `WagerTransactionPendingReference` original na outbox. |
| Triggers presentes | N/A | Sem migration nova (os índices do worker entraram na Fundação). As atualizações passam pelo `jg_wager_tx_guard` da 001 (PENDING_REFERENCE → PENDING_REFERENCE/PROCESSED/REJECTED/FAILED). |
| Sem mock em integração e concorrência | OK | T066–T071 com PostgreSQL real e processos reais; o banco "fora" é um proxy TCP cortado e o conflito de lock é um `FOR UPDATE` real segurado pelo teste. `FixedRandom` é um adaptador da porta `RandomSource`, não um mock de banco nem de SQS. |
| Sem relógio nem id no domínio | OK | `clock.now()` e `random.next()` por porta; `new Date(x.getTime() + delay)` só com argumento. Varredura sem `new Date()`, `Date.now(`, `randomUUID` ou `Math.random` no diff de `src/`. |
| Ordem de lock wallet primeiro | OK | Claim: `SELECT … FOR UPDATE SKIP LOCKED` + lease, sem lock de wallet, transação própria (nunca espera). Reavaliação: lock da wallet → releitura da linha → escrita. Irmãs: lidas num fork sem lock e reavaliadas, cada uma na própria transação, sob o lock. Antecipação: dentro da transação que já travou a wallet de origem, só `UPDATE` das dependentes. |
| Ack só depois do commit | N/A | Sem consumo novo. |
| DLQ antes de apagar | N/A | Sem DLQ nova. |
| Publisher marca só depois do SendMessage | N/A | O publicador não mudou na US4 (os ajustes N-22/N-23 foram revisados antes, no commit próprio). |
| Releitura sob o lock (atenção pedida pelo T076) | OK | `transactions.findById(em, pending.id)` depois do lock; status ≠ PENDING_REFERENCE → `skipped`, sem escrita. Referência e reversão existente também relidas sob o lock. T069: 20 rodadas de worker × BET, sempre PROCESSED, um CREDIT, nunca `REFERENCE_NOT_FOUND`. |
