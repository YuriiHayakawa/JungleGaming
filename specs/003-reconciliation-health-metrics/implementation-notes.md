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
