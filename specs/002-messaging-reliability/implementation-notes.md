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

## US5

| # | Decisão | Motivo | Task |
|---|---------|--------|------|
| N-35 | Limitação observada: o término aborta o long polling só do lado do cliente (plan, "Encerramento gracioso"). No MiniStack, o `ReceiveMessage` abortado continua pendente no servidor até `CONSUMER_WAIT_SECONDS` e pode pegar uma mensagem que fique visível nessa janela (por exemplo, a devolvida por outra instância), escondendo-a por um prazo de visibilidade. Não há perda nem efeito duplicado: a mensagem volta quando a visibilidade vence e a inbox garante um único efeito. O AWS SQS documenta o mesmo comportamento para long polling interrompido. O código segue o plan (aborta o long polling). O T077 isola os cenários do arquivo: depois de fechar um consumidor que pode estar em long polling, espera `CONSUMER_WAIT_SECONDS` + 0,5 s (`closeConsumer`). | Diagnosticado pelos logs: a instância do cenário anterior fechou durante um long polling, e a mensagem devolvida 0,6 s depois no cenário seguinte ficou invisível sem ser processada (`ReceiptHandleIsInvalid` no `retry` atrasado da instância que a devolveu). A espera não enfraquece nenhuma asserção: só impede que um cenário herde o receive pendente do anterior. | T077, T079 |
| N-36 | O consumidor registra no `WorkerRegistry` um trabalhador próprio, cujo `drain(prazo)` espera o laço e, se o prazo esgotar, devolve a visibilidade (0) das mensagens ainda em andamento **antes** de responder. Assim a devolução acontece antes de o `OrmLifecycle` fechar o pool, qualquer que seja a ordem dos hooks. As mensagens recebidas e não iniciadas voltam na hora em que o sinal de parada chega (`consumeBatch`), sem esperar o prazo. Logs: `consumer.message_returned` com `reason` `not_started` ou `shutdown_timeout`. | FR-014 e R-28: o Nest não garante a ordem entre providers no mesmo hook; o `drainAll` é o ponto de sincronização que o `OrmLifecycle` já espera. | T079 |
| N-37 | Uma mensagem devolvida no prazo esgotado continua sendo processada na instância que está saindo: ela termina com rollback (lock ou conexão) ou com commit. No rollback, o `retry` dela tenta redefinir a visibilidade com o receipt handle antigo e pode falhar (`ReceiptHandleIsInvalid`), o que é só registrado. No commit, o ack com o handle antigo pode falhar e a reentrega vira duplicata pela inbox. | O FR-014 pede devolver a visibilidade das não concluídas; interromper uma transação em andamento não é possível sem fechar a conexão. Os dois desfechos são seguros (FR-004, FR-005). | T079 |
| N-38 | O T078 já passou na primeira execução: a drenagem da mensagem em andamento existia desde a Fundação (o `drainAll` espera o laço). O que a US5 acrescentou foi a devolução das não iniciadas e das que estouram o prazo; isso é coberto pelo T077 (cenários 2 e 3). Conferido por mutação: sem a devolução das não iniciadas e sem a do prazo esgotado, os dois cenários falham. | Registro honesto do processo TDD. | T077, T078 |

### Revisão da US5 contra o review-checklist.md

Diff revisado: `message-batch.ts` (`BatchHooks`, devolução das não iniciadas), `wager-transactions.consumer.ts` (drain com devolução).

| Item | Resultado | Evidência |
|------|-----------|-----------|
| Dinheiro sem `number` | N/A | Nenhum valor monetário no diff. |
| Saldo só sob lock | N/A | O diff não escreve saldo nem status. |
| Unicidade no banco | OK | A devolução pode causar uma segunda entrega da mesma mensagem; a unicidade continua sendo a PK da inbox (T077 cenário 3: uma transação e uma linha de inbox depois da devolução). |
| Outbox na mesma transação | N/A | Sem gravação nova. |
| Triggers presentes | N/A | Sem migration. |
| Sem mock em integração e concorrência | OK | T077 em processo e T078 em container com PostgreSQL e MiniStack reais; o "em andamento" é um `FOR UPDATE` real. |
| Sem relógio nem id no domínio | N/A | Sem código de domínio nem de aplicação com tempo. |
| Ordem de lock wallet primeiro | N/A | Sem lock novo. |
| Ack só depois do commit | OK | O ack continua no `apply`, depois do `process` resolvido; a devolução no término usa `ChangeMessageVisibility`, nunca `DeleteMessage`. T078: `consumer.message` (ack) antes de `shutdown.workers_drained`. |
| DLQ antes de apagar | N/A | Sem DLQ nova. |
| Publisher marca só depois do SendMessage | N/A | Publicador não mudou. |

## US6

| # | Decisão | Motivo | Task |
|---|---------|--------|------|
| N-39 | O T081 não exigiu código de produção novo: o endurecimento pedido já estava nos commits anteriores. São eles: o `PollingLoop` com backoff de 1 a 30 s para qualquer erro, sem deixar exceção escapar (N-04, Fundação); o prazo de 5 s por chamada curta ao SQS e a parada do lote do publicador com backoff do laço (N-22); e o worker, que interrompe a rodada com o banco fora sem gravar nada (N-28, US4). O consumidor já classificava falha de banco como transitória, sem ack nem DLQ (US2). O T081 ficou com um teste unitário explícito dos formatos reais de falha numa iteração (erro do SDK do SQS com `$metadata`, `ECONNREFUSED`, `57P01` do PostgreSQL, valor que não é `Error`, `onError` que lança): backoff 1, 2, 4, 8, 16, 30 s, nenhuma rejeição não tratada e volta ao intervalo no primeiro sucesso. | Registro honesto: o T080 passou na primeira execução (2/2), com os dois proxies TCP reais. Não inventei mudança de código para "fazer o teste passar". | T080, T081 |
| N-40 | No T080, a queda do PostgreSQL dura ~4 s com `CONSUMER_RETRY_BASE_SECONDS=1`, o que mantém os recebimentos abaixo do limite de 5. O teste confere que, durante a queda, nada muda no banco (transações, tentativas, outbox e inbox idênticas ao instante do corte), nenhuma mensagem é confirmada e a DLQ fica vazia. Com o banco de volta, sem reinício, as duas mensagens são processadas uma vez, a pendente é concluída e todos os eventos chegam a `wager-events`. | O FR-034 vale "antes do limite de recebimentos"; uma queda maior que a soma das esperas leva mensagens válidas à DLQ pelo redrive, limitação já registrada no plan ("Indisponibilidade"). | T080 |

### Revisão da US6 contra o review-checklist.md

Diff revisado: `test/integration/dependency-outage.test.ts` e `test/unit/polling-loop.test.ts` (sem código de produção novo; ver N-39).

| Item | Resultado | Evidência |
|------|-----------|-----------|
| Dinheiro sem `number` | N/A | Sem código de produção. |
| Saldo só sob lock | N/A | Sem código de produção. O T080 confere que nenhuma escrita acontece com o banco fora. |
| Unicidade no banco | OK | Depois da volta do banco, cada mensagem tem uma linha de inbox e uma transação (T080). |
| Outbox na mesma transação | OK | T080: nada é publicado nem gravado durante a queda; todos os eventos confirmados são publicados depois. |
| Triggers presentes | N/A | Sem migration. |
| Sem mock em integração e concorrência | OK | Proxies TCP reais na frente do PostgreSQL e do MiniStack; nenhum mock de banco nem de SQS. O teste unitário usa erros construídos à mão para o `PollingLoop`, que não fala com banco nem fila. |
| Sem relógio nem id no domínio | N/A | Sem código de produção. |
| Ordem de lock wallet primeiro | N/A | Sem código de produção. |
| Ack só depois do commit | OK | T080: com o banco fora, nenhuma mensagem sai da fila (visíveis + invisíveis = 2) e nenhuma linha de inbox é gravada. |
| DLQ antes de apagar | OK | T080: DLQ vazia durante e depois da queda (falha de infraestrutura própria nunca manda à DLQ). |
| Publisher marca só depois do SendMessage | OK | T080: com o SQS fora, a outbox acumula sem `published_at`; com o SQS de volta, tudo é publicado. |

## US7

| # | Decisão | Motivo | Task |
|---|---------|--------|------|
| N-41 | Pontos de registro, todos pela porta `METRICS` (R-32): `transactions_total{status}` no `TransactionRecorder` (submit pelo HTTP e pela fila, e worker) e no FAILED do worker; `duplicates_total{source="idempotency"}` em todo replay pela idempotência (HTTP ou fila) e `{source="inbox"}` na duplicata da inbox (caminho rápido do consumidor ou releitura no submit); `retries_total{worker}` no `retry` do consumidor, na falha de envio do publicador e na falha transitória de uma reavaliação do worker; `dlq_total{errorCode, errorClass}` depois do envio aceito à DLQ e do delete; `lock_conflicts_total` na unit of work ao ver `55P03`; `outbox_lag_ms` na marca do publicador (US3); `processing_latency_ms{worker}` por mensagem no consumidor (do `process` ao fim do `apply`) e por reavaliação no worker (sem contar `skipped` e `deferred`). | FR-036 e o T083. O `{errorClass}` no `dlq_total` atende a "com a classe do erro" do cenário 2 da US7, junto com o `errorCode` do T082. | T083 |
| N-42 | `transactions_total` conta ao gravar, dentro da transação: uma tentativa da unit of work que sofre rollback depois (deadlock, falha de serialização, failpoint) também é contada. A abertura de wallet (OPENING) não entra no contador. | O R-32 define as métricas como observação, sem garantia; contar depois do commit exigiria levar o resultado até cada chamador. OPENING não é transação de aposta: entra com a wallet, por outro módulo. | T083 |
| N-43 | A latência usa a porta `Clock` (`clock.now()`), não `performance.now()`. | Tempo só pela porta em `application` (constitution VI, guardrail (e)). A resolução é de milissegundos, suficiente para a observação. | T083 |
| N-44 | Os rótulos são só `status`, `source`, `worker`, `errorCode` e `errorClass`; o T082 confere que nenhum rótulo tem formato de número (valor monetário). | FR-037. | T082 |

### Revisão da US7 contra o review-checklist.md

Diff revisado: porta `METRICS` no consumidor, no submit, no recorder, no worker, no publicador e na unit of work (`sqlStateOf` em `pg-errors.ts`), e a ligação nos módulos.

| Item | Resultado | Evidência |
|------|-----------|-----------|
| Dinheiro sem `number` | OK | Nenhum valor monetário passa pela porta; rótulos só de status, origem, trabalhador e código de erro (T082 confere que nenhum rótulo tem formato numérico). |
| Saldo só sob lock | N/A | A instrumentação não escreve saldo nem status; o contador do recorder roda dentro da mesma transação, sem I/O. |
| Unicidade no banco | N/A | Sem unicidade nova. |
| Outbox na mesma transação | N/A | Sem gravação nova. |
| Triggers presentes | N/A | Sem migration. |
| Sem mock em integração e concorrência | OK | T082 lê o `InMemoryMetrics` real da instância (o adaptador de produção da porta), com PostgreSQL e MiniStack reais; o lock esgotado é um `FOR UPDATE` real. |
| Sem relógio nem id no domínio | OK | Latências por `clock.now()`; varredura do diff sem `Date.now(`, `new Date()`, `performance.now` ou `Math.random`. |
| Ordem de lock wallet primeiro | N/A | Sem lock novo. |
| Ack só depois do commit | OK | O `dlq_total` e o `retries_total` são registrados depois das chamadas ao SQS, dentro do `apply`; a ordem ack/DLQ não mudou. |
| DLQ antes de apagar | OK | `dlq_total` só depois do `send` à DLQ e do `delete`. |
| Publisher marca só depois do SendMessage | OK | Só um `retries_total` no ramo de falha de envio; a marca não mudou. |

## Polish

### T084 — guardrails estendidos

`test/unit/conventions.test.ts` ganhou quatro regras, cada uma com autoteste (exemplos que passam e que falham), além da
varredura de `src/**` e `test/**`:

- (f) em `test/integration/**` e `test/concurrency/**`: nenhum import de `fake-sqs`, nenhuma classe `InMemory*Sqs*`/`Fake*Sqs*`,
  nenhum `spyOn` em objeto `sqs` e nenhum `mock.module('@aws-sdk/…')`;
- (g) em `src/**`: `@aws-sdk/` só em `src/messaging/infrastructure/**` (import estático, dinâmico e re-export);
- (h) em `src/**/domain/**` e `src/**/application/**`: nenhum `Math.random(`;
- (i) em `test/**`: nenhum `PurgeQueue`/`PurgeQueueCommand`/`purgeQueue(`.

Resultado: 39 testes, nenhuma violação no repositório.

### T085 — revisão final do diff da feature contra o review-checklist.md

Diff revisado: `330e78c..HEAD` (Fundação, US1 a US7, ajustes N-22 a N-24) mais o T084; 49 arquivos de `src/`/`migrations/`
e 53 de `test/`. Os itens já revisados por história (T047, T057, T065, T076 e as tabelas da US5, US6 e US7) foram
conferidos de novo sobre o código final, com as varreduras abaixo.

| Item | Resultado | Evidência no código final |
|------|-----------|---------------------------|
| Dinheiro sem `number` | OK | Varredura do diff inteiro de `src/` sem `amount`/`balance`/`money` tipados como `number`, sem `Number(` em dinheiro e sem `parseFloat(` (guardrail (c) verde). Saldo e lançamentos só por `Money`; o envelope da fila reusa o `moneySchema` (string); as métricas não carregam valores. |
| Saldo só sob lock | OK | As únicas escritas que mudam saldo ou status de transação: `TransactionRecorder.record` (chamado pelo submit e pelo worker, sempre depois de `wallets.lockById(em, …)` e com o EM da transação), `scheduleNextAttempt` e `markFailed` (worker, depois do lock da wallet). O claim do worker só mexe em `next_reference_attempt_at`/`updated_at`; a antecipação também, dentro da transação que já travou a wallet de origem. |
| Unicidade no banco | OK | `inbox_messages_pk` (23505 → `inbox-race`, relido fora da transação desfeita); idempotência nos índices da 001; `wager_tx_single_reversal_uq` (uma repetição no submit e no worker). "Concluída uma vez" no worker: lock + releitura + `UPDATE … WHERE status = 'PENDING_REFERENCE'` com 1 linha exigida. |
| Outbox na mesma transação | OK | Submit (HTTP e fila) e worker: `outbox.append(em, …)` com o EM da transação do efeito, antes do commit; na fila, a inbox entra no mesmo commit. O publicador só lê linhas confirmadas, num claim próprio. |
| Triggers presentes | OK | `Migration20261108000100` (inbox, `inbox_no_update_delete_trg`, `inbox_no_truncate_trg`) e `Migration20261108000200` (índices parciais do worker), com `up` e `down`; guardas da 001 intactas (`schema-guards` e `migrations` verdes). |
| Sem mock em integração e concorrência | OK | Guardrails (b) e (f) verdes; integração e concorrência só com PostgreSQL e MiniStack reais; indisponibilidade por proxies TCP reais; nenhum `TRUNCATE`/`DELETE`/`PurgeQueue` como limpeza (guardrails (a) e (i)). |
| Sem relógio nem id no domínio | OK | Guardrails (e) e (h) verdes: tempo pela `Clock`, ids pela `IdGenerator`, jitter pela `RandomSource`. |
| Ordem de lock wallet primeiro | OK | Ver "Saldo só sob lock". Exceções previstas: claim do worker (`SKIP LOCKED`, nunca espera) e antecipação (depois do lock da wallet de origem). O claim do publicador não toca wallets nem transações. |
| Ack só depois do commit | OK | `DeleteMessage` só em dois pontos de `consume-wager-message.use-case.ts`: no `ack` (depois de `process` resolver, isto é, depois do commit; failpoint `after_commit_before_ack` entre os dois) e depois do envio aceito à DLQ. O término devolve visibilidade, nunca apaga (US5). |
| DLQ antes de apagar da fila principal | OK | `apply`, ramo `dlq`: `await sqs.send(dlq, { …, attributes: { errorCode, errorClass, … } })` e só então `sqs.delete(...)`; se o envio falha, a exceção sobe e a mensagem fica. |
| Publisher marca como publicado só depois do SendMessage | OK | `published_at` é gravado num único ponto (`markPublished`, `WHERE published_at IS NULL`), chamado depois do `await sqs.send(...)`; falha de envio só reagenda o evento que falhou e devolve os não tentados (N-22), sem marcar. |

Nenhum item reprovado; nenhuma task voltou para a origem.

### T086 — suíte completa

`docker compose up -d postgres sqs` e `bun run typecheck && bun run test` (2026-11-09): saída 0 em 229 s.

| Suíte | Testes | Arquivos | Duração |
|-------|--------|----------|---------|
| typecheck | ok | — | — |
| unit (inclui o T084) | 597 pass, 0 fail | 31 | 0,9 s |
| integration | 216 pass, 0 fail | 36 | 153,4 s |
| concurrency | 23 pass, 0 fail | 18 | 70,6 s |

T087 (quickstart de ponta a ponta) e T088 (README/ARCHITECTURE) não fazem parte desta rodada.
