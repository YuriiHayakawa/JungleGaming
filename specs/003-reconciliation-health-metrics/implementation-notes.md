# Implementation notes: Reconciliação, Health Checks e Métricas (003)

Decisões tomadas durante o `/speckit-implement` para pontos que **não** envolvem regra financeira (dinheiro, saldo,
ledger, idempotência ou outbox), com a leitura mais conservadora em cada caso, mais os requisitos extras decididos pelo
usuário antes da implementação. Formato: decisão, motivo, task. As notas da 002 (N-01 a N-45) continuam valendo; as
desta feature usam o prefixo **N3-**.

## Requisitos extras do usuário (2026-11-09)

Decididos pelo usuário antes da implementação; prevalecem sobre o texto das tasks onde ele diverge.

| # | Requisito | Onde se aplica | Diferença em relação ao texto das tasks |
|---|-----------|----------------|------------------------------------------|
| E-1 | Encerramento (R-40): o `/health/ready` passa a responder 503 **no instante em que o sinal chega**, antes de iniciar a drenagem; o HTTP continua aberto durante a drenagem. Os testes de sinal em container da 002 (sem init e com init) e os de término gracioso em processo continuam verdes, e o teste novo prova o 503 durante a drenagem. | `WorkerRegistry.beginShutdown()`, opção `beginShutdown` do handler de sinal (chamada de forma síncrona, antes do log e do `close()`), `gracefulShutdown` (também chama `beginShutdown` antes de `drainAll`). | O R-40 ligava o `isDraining()` só na primeira chamada de `drainAll`. Agora ele liga antes, no sinal; `drainAll` continua ligando também, para quem encerra sem sinal. |
| E-2 | Métricas (R-43): a porta **nunca** lança erro no caminho de negócio. Rótulo fora da lista fechada: em produção, a amostra é descartada com um log de aviso (uma vez por métrica e rótulo); só em modo de teste (`NODE_ENV=test`) a violação falha. Teste unitário dos dois modos. | `InMemoryMetrics` (opções `nodeEnv` e `warn`), `AppModule` (passa `config.nodeEnv` e o logger em warn). | O T005/R-43 pediam "rótulo fora da lista é recusado com erro" sempre. Agora só em `NODE_ENV=test`. |
| E-3 | A reconciliação roda `READ ONLY` e `REPEATABLE READ`; o cálculo no banco (`SUM` e `lag()`), sem carregar o ledger em memória; divergência: log nível error sem valores monetários, contador e `consistent=false`, nunca corrige. | US1 (T016, T017). | Igual ao plan; registrado como requisito explícito. |
| E-4 | O banco do teste de divergência usa um **template próprio** criado só com as migrations de tabelas; nunca `DISABLE TRIGGER` nem `session_replication_role`. | `db-setup.preload.ts` (cria `jg_test_template_bare`), `useBareTestDatabase` (clona dele). | O T002 dizia "cria um banco vazio sem o template e aplica as migrations". Agora as migrations de tabelas são aplicadas uma vez, no template próprio, e cada arquivo clona dele (mesmo isolamento por arquivo do R-17). |

## Setup e Fundação

| # | Decisão | Motivo | Task |
|---|---------|--------|------|
| N3-01 | `runMigrations(url, 'up', { to })` recusa `to` com `down`. | `to` só existe para criar o template sem guardas (R-38); um `down` parcial não é usado por ninguém e poderia desfazer migrations por engano. | T001 |
| N3-02 | O preload apaga todo banco `jg_test_%` que sobrou, desmarcando antes os que forem template (agora são dois: `jg_test_template` e `jg_test_template_bare`). | O PostgreSQL não apaga banco marcado como template; antes só o template principal era desmarcado. | T002 (E-4) |
| N3-03 | `stall()` pendura também as conexões já abertas (não só as novas) e o `restore()` fecha todas as que passaram pelo modo pendurado. | Com o pool do PostgreSQL, uma conexão ociosa já aberta responderia o `SELECT 1` do ready e o teste de "dependência pendurada" não provaria nada. Como bytes são descartados enquanto pendurado, essas conexões não podem continuar depois do `restore()`. | T003 |
| N3-04 | Autotestes dos helpers de teste: `test/unit/prometheus-parser.test.ts` (parser do T004) e `test/integration/tcp-proxy-stall.test.ts` (modo pendurado do T003, contra o PostgreSQL real). | Regra do usuário: `[X]` só com teste passando. Os helpers são usados pelas histórias, mas sem autoteste só seriam validados indiretamente. | T003, T004 |
| N3-05 | A política do E-2 vale para toda violação de contrato da porta, não só rótulo: nome desconhecido e valor de observação não finito também são descartados com aviso fora de `NODE_ENV=test`. O aviso é `metrics.sample_dropped` com `metric` e `label` (o **nome** do rótulo, ou `<name>`/`<value>`), nunca o valor do rótulo, que pode ser um id. A amostra inteira é descartada, não só o rótulo. | "Nunca lança no caminho de negócio" (E-2) só é verdade se nenhuma validação da porta lançar fora de teste. Descartar só o rótulo misturaria a série com outra. | T008 |
| N3-06 | `new InMemoryMetrics()` sem `nodeEnv` usa o `NODE_ENV` do processo; a app sempre passa o `config.nodeEnv`. | Um adaptador criado sem opções em produção continua seguro (não lança); no `bun test`, `NODE_ENV` é `test`. | T008 |
| N3-07 | Teste unitário da 002 `a ordem dos rótulos não importa` passou a usar `{ status, kind }` em vez de `{ status, origin }`; a asserção é a mesma. O teste `snapshot devolve…` passou a conferir também `histograms`. | `origin` não está na lista fechada (R-43) e falharia em modo de teste. Nenhuma asserção foi relaxada: o que o teste prova (ordem dos rótulos) é igual. | T005 |
| N3-08 | `snapshot()` mantém `observations` (a janela) e ganha `histograms` (contagem, soma e contagem por bucket, não cumulativa; o renderer acumula). | O teste de integração da 002 (`metrics.test.ts`) lê `snapshot().observations`; manter evita mexer num teste já aprovado. | T008 |
| N3-09 | O handler de sinal ganhou a opção `beginShutdown`, chamada de forma síncrona antes do log `shutdown.started` e do `close()`; um erro nela é ignorado. O `close` do `main.ts` passou a ser `gracefulShutdown(app, CONSUMER_SHUTDOWN_TIMEOUT_MS)`. Sinal repetido e temporizador de segurança sem mudança. | E-1. O erro é ignorado porque marcar "não pronta" é sinal para o orquestrador e não pode impedir o encerramento. | T009 |
| N3-10 | `gracefulShutdown` guarda a promessa por app (chamadas repetidas devolvem a mesma); no harness, `close()` e `shutdown()` compartilham a mesma promessa (o primeiro que for chamado decide). | Idempotência pedida no T006; evita um `app.close()` duplo quando o teste chama `shutdown()` e o `afterAll` chama `close()`. | T009 |
| N3-11 | `NoopAuthGuard` recebe o `Reflector` por `@Inject(Reflector)` e expõe `isPublic(context)`; `canActivate` continua devolvendo `true` para tudo (no-op), com o ponto de extensão comentado. | R-41: o metadado já é lido hoje, para que a autenticação real só precise mudar o ramo não público. | T010 |
| N3-12 | `isOperationalRoute(path)`: `/metrics` exato e prefixo `/health/`, sem query string. `/health` e `/metricsx` continuam em info. | Só as rotas da 003 (FR-018); um prefixo solto (`/metrics*`) pegaria rotas futuras por engano. | T010 |

### Revisão da Fundação contra o review-checklist.md

Diff revisado: `run-migrations.ts`, `db-setup.preload.ts`, `db.ts`, `test-database.ts`, `tcp-proxy.ts`, `prometheus.ts`,
`metrics.port.ts`, `in-memory-metrics.ts`, `app.module.ts`, `worker-registry.ts`, `graceful-shutdown.ts`,
`signal-handler.ts`, `main.ts`, `app-harness.ts`, `public.decorator.ts`, `noop-auth.guard.ts`, `json-logger.ts`.

| Item | Resultado | Evidência |
|------|-----------|-----------|
| Dinheiro sem `number` | N/A | Nenhum valor monetário no diff; os `number` das métricas são contagens e latências em ms. |
| Nenhuma escrita nova | OK | Nenhum SQL de escrita em `src/`; o preload só cria e migra bancos de teste. |
| Triggers presentes | OK | Nenhuma migration alterada. O template sem guardas nunca recebe a `Migration20261107000400` (`to: 'Migration20261107000300'`); o template completo continua com todas (`migrations.test.ts` e `schema-guards.test.ts` verdes). Nenhum `DISABLE TRIGGER`/`session_replication_role` (guardrail (a) verde). |
| Sem mock em integração e concorrência | OK | `stall()` é o mesmo proxy TCP real, testado contra o PostgreSQL real (`tcp-proxy-stall.test.ts`). |
| Sem relógio nem id no domínio | OK | Nada em `domain`/`application`; guardrails (e) e (h) verdes. |
| Erros no envelope único | N/A | Nenhum endpoint novo ainda. |
| Reconciliação somente leitura num snapshot | N/A | US1. |
| Divergência sinalizada e nunca corrigida | N/A | US1. |
| Divergência testada sem desligar guardas | OK (parcial) | O template próprio do E-4 existe e não tem triggers nem funções de guarda (teste de sanidade no `reconciliation-divergence.test.ts`). |
| Health correto | OK (parcial) | `isDraining()` verdadeiro desde o sinal (síncrono) e durante a drenagem; drenagem antes do `app.close()` (T006). Os testes em container da 002 (`signal-exit`, `graceful-sigterm`, com e sem init) continuam verdes com o `gracefulShutdown`. O endpoint entra na US2. |
| Métricas de baixa cardinalidade e sem dinheiro | OK | Lista fechada imposta pela porta (erro em teste, descarte com aviso fora dele, E-2); histogramas com memória constante (buckets + janela de 1 000). |
| Endpoints sem autenticação | N/A | `@Public()` existe e é lido pelo guard; os controllers entram nas histórias. |

### Checkpoint da Fundação

Rodado sobre a árvore exata do commit da Fundação (os testes da US1, já escritos, ficaram fora da árvore durante a
rodada, porque o código deles ainda não existia): `bun run typecheck` ok; `bun run test:unit` 639 pass (597 + 42
novos: métricas, encerramento, `@Public()`, handler de sinal e parser de teste); `bun run test:integration` 221 pass em
152 s (219 + o T001 e o autoteste do `stall()`); `bun run test:concurrency` 23 pass em 70 s (inclui `signal-exit` e
`graceful-sigterm` em container, com e sem init, já com o `gracefulShutdown`).

## US1 — Reconciliação

| # | Decisão | Motivo | Task |
|---|---------|--------|------|
| N3-13 | Além de `SET TRANSACTION READ ONLY` como primeira instrução (com `isolationLevel: REPEATABLE_READ` na transação do MikroORM), a transação lê `current_setting('transaction_isolation')` e `current_setting('transaction_read_only')` antes das leituras; se não for `repeatable read` e `on`, lança `ReconciliationSnapshotError` (500, erro de programação). | E-3: o snapshot `REPEATABLE READ`/`READ ONLY` fica conferido pelo próprio banco a cada execução, não por convenção; toda execução dos testes de integração e de concorrência prova o modo. Custo: uma consulta trivial a mais. | T017 |
| N3-14 | O saldo recalculado chega como `numeric::text` com sinal e vira `Money` por `signedMoney` (tira o `-`, `Money.from` e `negate()`), sem passar por `number`. Limitação: num ledger adulterado cuja soma com sinal passe de 9999999999999999.99 em módulo, `Money.from` recusa e a reconciliação responde 500 em vez de 200 inconsistente. | `Money.from` só aceita o formato não negativo do I-01 (contrato de entrada); a soma de um ledger adulterado pode ser negativa. Com as guardas da 001, a soma é sempre o saldo (≤ limite); o caso só existe com o banco adulterado além dos CHECKs por lançamento. Não altero o `Money` (shared kernel, regra de dinheiro). | T016 |
| N3-15 | `storedBalance`, `calculatedBalance` e `difference` entraram na lista de chaves monetárias que o `JsonLogger` nunca escreve. | Defesa em profundidade do FR-008: mesmo que alguém passe o resultado inteiro ao log, os valores não saem. O log de divergência já não os inclui. | T017 |
| N3-16 | `firstBrokenSeq` e `checkedEntries` são `number` JSON; o `seq` (`bigint`) só vira `number` depois de conferido como inteiro seguro (`safeInteger`); fora disso, erro de programação. | R-37. São posições e contagens, não dinheiro. | T016 |
| N3-17 | T013, "dois desvios que se anulam na soma": como a soma com sinal só depende de `direction` e `amount` (e `amount` está preso por FK ao valor da transação), o caso é provocado deslocando `balance_before`/`balance_after` de dois lançamentos em sentidos opostos (+5 e −5): saldo armazenado e soma iguais, `difference` 0.00, cadeia quebrada. Casos adicionais: primeiro lançamento com `before` ≠ 0 e o deslocamento do último (elo e cauda quebrados no mesmo `seq`). | Os CHECKs por lançamento continuam ativos no banco sem guardas, então toda adulteração mantém `after = before ± amount`. Uma quebra "só de cauda" sem mudar o saldo armazenado não é possível sem alterar `amount`; o caso de cauda pelo saldo armazenado está nos testes de saldo maior/menor. | T013 |
| N3-18 | T014: as 50 BETs vão round-robin para as 3 instâncias e **cada uma das 3** reconcilia a mesma wallet em laço ao mesmo tempo (465 leituras na rodada registrada). Saldo 300.00 e BETs de 10.00: 30 aceitas, 20 rejeitadas. | "3 instâncias" e "outra instância reconcilia" juntos: toda leitura disputa com escritas da própria instância e das outras, o que é mais forte que um reconciliador separado. Mesmo critério: todas `consistent` true e `checkedEntries` não decrescente por laço. | T014 |
| N3-19 | Processo TDD: os testes da US1 foram escritos antes do código e vistos vermelhos (`reconciliation.test.ts` sem o módulo; `reconciliation-divergence.test.ts` 1 pass, 9 fail por rota inexistente). Um bug do próprio teste apareceu no verde: `SELECT seq::text AS seq … ORDER BY seq` ordenava pelo alias texto ("10" < "9"); corrigido com outro alias. O SQL de produção ordena pelo `bigint` dentro do CTE e não tem esse problema. Mutação conferida: com `READ COMMITTED` e 20 ms entre as duas leituras, o T014 falha com um falso positivo (`difference` 10.00, `consistent` false); com o código real, passa. | Registro honesto, como no N-21 e N-33 da 002. | T011–T014 |

### Revisão da US1 contra o review-checklist.md (T019)

Diff revisado: `src/reconciliation/**` (domínio, reader, use case, controller, módulo), `app.module.ts` (import do
módulo), `json-logger.ts` (chaves monetárias), os quatro arquivos de teste.

| Item | Resultado | Evidência |
|------|-----------|-----------|
| Dinheiro sem `number` | OK | Saldos e diferença como `Money` (decimal.js) de ponta a ponta; SQL devolve `balance::text`, `sum(...)::text` e `balance_after::text`; resposta com strings de 2 casas (`toJSON`). Os únicos `number` são `checkedEntries` e `seq`. Varredura do diff sem `Number(`/`parseFloat(` em dinheiro (guardrail (c)). |
| Nenhuma escrita nova | OK | Nenhum `INSERT`/`UPDATE`/`DELETE` em `src/reconciliation/**`; a transação é `READ ONLY` (o banco recusaria). `reconciliation.test.ts`: wallets, ledger, transações, outbox e inbox idênticos linha a linha antes e depois. |
| Triggers presentes | OK | Nenhuma migration tocada; o banco sem guardas é o template próprio (E-4), com sanidade no próprio teste (nenhum trigger, nenhuma função de guarda). |
| Sem mock em integração e concorrência | OK | PostgreSQL e MiniStack reais; o 503 é o proxy TCP real cortado; T014 com 3 processos reais. |
| Sem relógio nem id no domínio | OK | `reconcile` não lê tempo nem gera id; nada de `new Date()`, `Date.now(`, `randomUUID(`, `Math.random(` no diff. |
| Erros no envelope único | OK | 400 (`walletIdParamSchema` da 001), 404 (`WalletNotFoundError`), 503 com `Retry-After` (`ServiceUnavailableError` pelo `classifyDbError` da 001) e 500, todos pelo filtro global; testados no T012. |
| Reconciliação somente leitura num snapshot | OK | `transactional(…, { isolationLevel: REPEATABLE_READ })` + `SET TRANSACTION READ ONLY` como primeira instrução + conferência do modo pelo banco (N3-13); saldo e agregado na mesma transação; nenhum `FOR UPDATE`/`FOR SHARE`; soma com `sum(CASE …)` e cadeia com `lag(balance_after) OVER (ORDER BY seq)` no banco, uma linha devolvida (1 000 lançamentos em ~4 ms no T012). T014 e a mutação do N3-19 provam o snapshot. |
| Divergência sinalizada e nunca corrigida | OK | `consistent` false na resposta 200; `logger.error('reconciliation.divergence', { walletId, checkedEntries, firstBrokenSeq?, consistent: false })` com o `correlationId` do contexto e sem nenhum valor monetário (T013 confere chaves e valores); `+1` em `reconciliation_divergences_total` por detecção (duas → +2); nenhum caminho de escrita existe no módulo; T013 confere wallet e ledger idênticos depois. |
| Divergência testada sem desligar guardas | OK | Só `useBareTestDatabase` (template próprio, E-4) no T013; nenhum `DISABLE TRIGGER`/`session_replication_role`; a comparação também é testada como função pura (T011, 22 casos). |
| Health correto | N/A | US2. |
| Métricas de baixa cardinalidade e sem dinheiro | OK | O contador novo não tem rótulo. |
| Endpoints sem autenticação | OK | `@Public()` na rota; T012 chama sem credencial nenhuma. |

### Checkpoint da US1

`bun test test/unit/reconciliation.test.ts` 22 pass; `reconciliation.test.ts` 11 pass (1 000 lançamentos em 4,2 ms);
`reconciliation-divergence.test.ts` 10 pass; `reconciliation-under-load.test.ts` 1 pass (169 + 143 + 153 leituras, todas
consistentes). Suítes completas sobre a árvore do commit da US1: `bun run typecheck` ok; `bun run test:unit` 654 pass;
`bun run test:integration` 242 pass em 164 s; `bun run test:concurrency` 24 pass em 75 s.

## US2 — Health

| # | Decisão | Motivo | Task |
|---|---------|--------|------|
| N3-20 | `withTimeout(check, ms, timers?)` recebe os temporizadores por parâmetro (padrão: os globais) e devolve `up`/`down`, nunca rejeita: o temporizador é cancelado no fim e uma checagem que termine depois do prazo é descartada com a rejeição tratada. | "Com relógio de teste" do T020 sem acoplar o application a um relógio novo; e nenhuma `unhandledRejection` quando a dependência responde (ou falha) depois dos 2 s (o T021 confere que não houve nenhuma). | T024 |
| N3-21 | Checagem do SQS: `approximateCounts` (`GetQueueAttributes`) das três filas da configuração em paralelo; fila inexistente cai como erro do `GetQueueUrl` (N-01 da 002 não guarda a falha). O prazo de 2 s corta a espera do ready, mas a chamada do SDK continua até o próprio prazo (5 s por tentativa, 2 tentativas, N-22 da 002) e é descartada. | R-39. Cancelar a chamada exigiria mudar a `SqsPort` da 002; o descarte é suficiente para o ready responder no prazo. | T025 |
| N3-22 | Checagem do PostgreSQL: `SELECT 1` num fork do EM, fora de transação (sem `lock_timeout`, que não se aplica). Limitação: com o banco pendurado (TCP aceito e sem resposta), cada consulta do ready segura uma conexão do pool até a conexão cair; consultas repetidas do ready durante um travamento longo podem ocupar várias conexões. O prazo do ready continua garantido (2 s). | O `statement_timeout` não ajuda quando o servidor não recebe nada; é o mesmo comportamento de qualquer consulta da app com o banco pendurado. Registrado para o ARCHITECTURE.md (limitações). | T025 |
| N3-23 | `@Public()` no controller inteiro de health; o 503 é definido com `@Res({ passthrough: true })` e `status()`, devolvendo o corpo próprio, sem lançar exceção (fora do envelope do I-38). | R-41; contracts/http.md. | T026 |
| N3-24 | T023: `ContainerInstance.fetchInside(path)` lê a app de dentro do container (`docker exec <id> bun -e "fetch('http://127.0.0.1:3000…')"`), na porta 3000 do profile `test`. O teste lê o ready antes do SIGTERM (200) e logo depois dele, com a mensagem ainda presa no lock (503 com `postgres` e `sqs` up, live 200, nenhuma linha de inbox); o resto do teste da 002 (conclusão, ack, saída 0, uma única vez, ordem dos logs) não mudou. Em vez do `Bun.sleep(1000)` entre o SIGTERM e a soltura do lock, o tempo das duas leituras `docker exec` faz esse papel. | Prova do E-1 e do SC-006 em container, nas duas variantes (sem e com init), sem publicar porta no host. | T023 |
| N3-25 | Processo TDD: T020 e T021/T022 vistos vermelhos (módulo inexistente; 2 pass e 8 fail). O T023 não foi executado vermelho antes do código; em troca, a mutação "voltar ao `app.close()` da 002, sem drenagem antes e sem `beginShutdown`" derruba as duas variantes (ECONNREFUSED no ready lido de dentro do container: o HTTP fechou antes da drenagem). | Registro honesto, como no N-21 da 002. | T020–T023 |

### Revisão da US2 contra o review-checklist.md (T027)

Diff revisado: `src/health/**` (readiness, checagens, controller, módulo), `app.module.ts` (import do módulo),
`test/support/container-instance.ts` (`fetchInside`), `test/concurrency/graceful-sigterm.test.ts`, `health.test.ts`,
`health-shutdown.test.ts`, `readiness.test.ts`.

| Item | Resultado | Evidência |
|------|-----------|-----------|
| Dinheiro sem `number` | N/A | Nenhum valor monetário em health. |
| Nenhuma escrita nova | OK | Só `SELECT 1` e `GetQueueAttributes`; nenhum `INSERT`/`UPDATE`/`DELETE`/lock em `src/health/**` (varredura). |
| Triggers presentes | N/A | Sem migration. |
| Sem mock em integração e concorrência | OK | Indisponibilidade só por proxies TCP reais (cortado e pendurado) na frente do PostgreSQL e do MiniStack; SIGTERM real em container; o "em andamento" é um `FOR UPDATE` real. O temporizador manual só existe no unitário do `withTimeout`. |
| Sem relógio nem id no domínio | OK | Nada de `new Date()`, `Date.now(`, `Math.random(` em `src/health/**`; o único tempo é o temporizador do prazo, injetável. |
| Erros no envelope único | OK | Health fica fora do envelope por definição (I-75): 200/503 com corpo próprio, conferido no T021 (`error` ausente). |
| Health correto | OK | live não consulta nada (200 com o banco cortado ou pendurado, em < 500 ms); ready com `Promise.all` das duas checagens, 2 s cada (pendurado: 503 entre 1,9 e 3 s); 503 com o estado real de cada dependência; 503 desde o instante do encerramento (`beginShutdown` síncrono no sinal, E-1) e durante toda a drenagem, em processo (T022) e em container nas duas variantes (T023); drenagem antes do `app.close()` (o HTTP continua atendendo `GET /wallets/:id` e `/health/live` durante a drenagem); log em `debug`. O ack continua depois do commit (a mensagem em andamento conclui com `consumer.message` `processed` antes de `shutdown.workers_drained`, fila vazia, uma linha de inbox) e a devolução de visibilidade da 002 não mudou (`consumer.message_returned` ausente no caminho feliz; `consumer-shutdown.test.ts` da 002 verde). |
| Métricas de baixa cardinalidade e sem dinheiro | N/A | Health não registra métrica. |
| Endpoints sem autenticação | OK | `@Public()` no controller; T021 chama sem nenhum header. |
| Reconciliação / divergência | N/A | — |

### Checkpoint da US2

`readiness.test.ts` 15 pass; `health.test.ts` + `health-shutdown.test.ts` 10 pass; `graceful-sigterm.test.ts` +
`signal-exit.test.ts` 4 pass (container, com e sem init). Suítes completas sobre a árvore do commit da US2:
`bun run typecheck` ok; `bun run test:unit` 669 pass; `bun run test:integration` 252 pass em 170 s;
`bun run test:concurrency` 24 pass em 76 s.

## US3 — Métricas

| # | Decisão | Motivo | Task |
|---|---------|--------|------|
| N3-26 | Exposição: famílias em ordem de nome e séries em ordem do texto dos rótulos (`le` sempre por último); histograma sem nenhuma observação aparece só com `# HELP`/`# TYPE` (sem amostras zeradas); contador sem rótulo (`lock_conflicts_total`, `reconciliation_divergences_total`) aparece com 0 antes do primeiro incremento; contador rotulado sem incremento não inventa série. | contracts/metrics.md ("família sem observação: HELP e TYPE; contadores sem rótulo com 0"). Inventar séries rotuladas zeradas exigiria a lista de valores de cada rótulo, que não existe para `errorCode`. | T030 |
| N3-27 | Banco fora (ou prazo de 2 s esgotado) na coleta: os dois gauges da outbox somem por inteiro, inclusive `# HELP`/`# TYPE`; o aviso `metrics.outbox_lag_unavailable` leva só o nome da classe do erro. | FR-022 e contracts/metrics.md ("os dois gauges são omitidos"). Uma família declarada sem amostra seria lida como "sem pendentes" por algumas ferramentas. | T030, T031 |
| N3-28 | O controller injeta o token `METRICS` tipado como `Pick<InMemoryMetrics, 'snapshot'>`: o `snapshot()` não faz parte da `MetricsPort` (que continua só com `increment`/`observe`). | A porta de escrita usada pelos casos de uso não muda; a leitura é detalhe do adaptador em memória, que é o provider de `METRICS` (002). | T032 |
| N3-29 | A idade do pendente mais antigo é `clock.now() − min(occurred_at)` (porta `Clock`, relógio do serviço, como assumido na spec); negativa vira 0. | Spec, Assumptions. Diferença de relógio entre app e banco não entra, porque `occurred_at` é gravado com o `Clock` da app (001). | T031 |
| N3-30 | T029: a app principal fala com o banco por um proxy TCP (para a coleta com o banco fora) e fica sem publicador; uma segunda app, com publicador, esvazia a outbox quando o teste pede os gauges em 0; uma terceira, sobre o banco sem guardas (E-4), provoca a divergência. Os histogramas expostos são comparados com o que a porta em memória registrou (`_count`, `_sum`, `+Inf` = `_count`), e todo contador exposto é comparado com o da instância. | US3 cenários 1 a 6 numa só app seria impossível: a mesma instância não pode ter o publicador desligado (para medir pendentes) e ligado (para esvaziar). | T029 |
| N3-31 | Processo TDD: T028 e T029 vistos vermelhos (módulo inexistente; 0 pass e 10 fail). No primeiro verde, o typecheck e o unitário pegaram um erro meu: o heredoc do shell usado para escrever o renderer cortou as barras invertidas dos escapes; corrigido antes de qualquer commit. | Registro honesto. | T028–T030 |

### Revisão da US3 contra o review-checklist.md (T033)

Diff revisado: `src/platform/metrics/prometheus-text.ts`, `src/outbox/infrastructure/outbox-lag.reader.ts`,
`src/metrics/**` (controller e módulo), `app.module.ts` (import do módulo), `prometheus-text.test.ts`,
`metrics-endpoint.test.ts`.

| Item | Resultado | Evidência |
|------|-----------|-----------|
| Dinheiro sem `number` | OK | Nenhum valor monetário passa pela exposição; os `number` são contagens, latências em ms, quantidade de pendentes e idade em segundos. |
| Nenhuma escrita nova | OK | O `OutboxLagReader` só faz `SELECT count(*)::text, min(occurred_at) … WHERE published_at IS NULL` (índice parcial `outbox_pending_idx`); nenhum `INSERT`/`UPDATE`/`DELETE`/lock em `src/metrics/**` nem no reader (varredura). |
| Triggers presentes | N/A | Sem migration. |
| Sem mock em integração e concorrência | OK | T029 com PostgreSQL e MiniStack reais; banco fora por proxy TCP real; DLQ, duplicata, lock esgotado e divergência provocados de verdade. |
| Sem relógio nem id no domínio | OK | A idade usa a porta `Clock`; o renderer é puro; nada de `new Date()`/`Date.now(` no diff. |
| Erros no envelope único | N/A | `/metrics` não tem caminho de erro: banco fora → 200 sem os gauges. |
| Métricas de baixa cardinalidade e sem dinheiro | OK | Rótulos só da lista fechada (imposta pela porta, E-2; o T029 confere toda amostra exposta: nenhum rótulo fora da lista, nenhum valor com formato de UUID ou de número, nem o `walletId` nem o `providerId` usados no teste); histogramas com memória constante (buckets + janela de 1 000); gauges da outbox lidos na coleta e omitidos com o banco fora. |
| Endpoints sem autenticação | OK | `@Public()` no controller; T029 chama sem nenhum header. |
| Reconciliação / divergência / health | N/A | — (o T029 só usa a reconciliação da US1 para provocar a divergência). |

### Checkpoint da US3

`prometheus-text.test.ts` 8 pass; `in-memory-metrics.test.ts` 14 pass; `metrics-endpoint.test.ts` 10 pass. Suítes completas sobre a árvore do commit da US3:
`bun run typecheck` ok; `bun run test:unit` 677 pass; `bun run test:integration` 262 pass em 174 s;
`bun run test:concurrency` 24 pass em 77 s.
