# Tasks: Reconciliação, Health Checks e Métricas

**Input**: Design documents from `/specs/003-reconciliation-health-metrics/`
**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md),
[contracts/](contracts/), [quickstart.md](quickstart.md), [review-checklist.md](review-checklist.md)

**Tests**: obrigatórios (constitution VII; quality gate "Tasks": toda task de comportamento tem teste). Em cada fase, os
testes são escritos **antes** da implementação e devem falhar primeiro.

**Organization**: uma fase por história (US1 reconciliação, US2 health, US3 métricas), depois da fundação comum. A
numeração recomeça em T001 nesta feature. README e ARCHITECTURE ficam para o fim do projeto (como na 001 e na 002).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: pode rodar em paralelo (arquivo diferente, sem dependência de task incompleta)
- **[Story]**: história da spec (US1, US2, US3)
- Toda task cita o arquivo e os FR, I-xx, SC e decisões R-xx que cobre

## Convenções valendo em todas as tasks

As da 001 e da 002 continuam: SQL com `?`; dentro de `transactional()`, só o EM da transação; dinheiro como
`Money`/string, nunca `number`; domínio sem `@nestjs`, `@mikro-orm` nem `@aws-sdk`; injeção só por `@Inject(TOKEN)`;
banco próprio por arquivo de teste e filas próprias (`useTestQueues`); nenhum `TRUNCATE`/`DELETE`/`PurgeQueue` como
limpeza; `assertWalletMatchesLedger` ao fim de todo teste que toca wallet; tempo, ids e jitter por porta. Novas:

- **Nenhuma escrita** em `src/reconciliation/**`, `src/health/**`, `src/metrics/**` e no `OutboxLagReader`.
- **Divergência só no banco sem guardas**: `useBareTestDatabase` (migrations de tabelas, R-38); nunca desligar trigger.
- **Rótulos de métrica só da lista fechada** (R-43); nunca ids nem valores.
- **Endpoints operacionais com `@Public()`** (R-41).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: suporte de teste e de migração usado pelas três histórias. Nenhuma dependência nova.

- [X] T001 [P] Acrescentar o parâmetro opcional `to` em `src/platform/persistence/run-migrations.ts`
  (`runMigrations(url, 'up', { to: 'Migration20261107000300' })` → `orm.migrator.up({ to })`), sem mudar o
  comportamento sem `to` (R-38); teste em `test/integration/migrations.test.ts`: num banco vazio, com
  `to: 'Migration20261107000300'`, existem `wallets`, `wager_transactions`, `wallet_ledger_entries` e `outbox_messages`
  e **não** existem a função `jg_wallet_matches_ledger_tail` nem o trigger `ledger_before_insert_trg`
- [X] T002 [P] Criar `useBareTestDatabase(tag)` em `test/support/test-database.ts` (R-38): `beforeAll` cria um banco
  vazio `jg_test_<tag>_<aleatório>` **sem** o template e aplica `runMigrations(url, 'up', { to:
  'Migration20261107000300' })`; `afterAll` apaga o banco; mesmo formato de retorno de `useTestDatabase` (`url`, `db`)
- [X] T003 [P] Acrescentar `stall()` em `test/support/tcp-proxy.ts` (R-45): aceita conexões novas e não repassa nem
  responde nada até `restore()` (diferente de `cut()`, que recusa); as conexões penduradas são fechadas no `restore()` e
  no `close()`
- [X] T004 [P] Criar `test/support/prometheus.ts` (R-45): `parsePrometheus(text)` mínimo, só para asserções — devolve
  famílias (`# TYPE`) e amostras `{ name, labels, value }`, recusando linhas fora do formato 0.0.4; e
  `sampleValue(parsed, name, labels?)`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: ajustes de plataforma de que as três histórias dependem: métricas com histogramas por bucket e lista de
rótulos, encerramento que drena antes de fechar o HTTP, `@Public()` e log em debug. **Bloqueia todas as histórias.**

### Testes da fundação (escrever primeiro; devem falhar)

- [X] T005 [P] Estender `test/unit/in-memory-metrics.test.ts` (R-43; FR-020, FR-023, FR-024): histograma de
  `processing_latency_ms` com buckets fixos em ms "5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000,
  +Inf" (contagem por bucket, `sum`, `count`); `observations()` devolve no máximo as últimas 1 000 observações da série;
  rótulo fora de "status, source, worker, errorCode, errorClass, outcome, kind" é recusado com erro; o contador
  `reconciliation_divergences_total` existe; `snapshot()` traz os histogramas
- [X] T006 [P] Escrever `test/unit/graceful-shutdown.test.ts` (R-40; FR-016): `gracefulShutdown(app)` chama
  `WorkerRegistry.drainAll(prazo)` e só depois `app.close()`; `isDraining()` é true desde a primeira chamada de
  `drainAll` e continua true; uma segunda chamada de `drainAll` devolve a mesma promessa; erro no `close()` propaga;
  e, em `test/unit/signal-handler.test.ts`, o handler de sinal usa a função de encerramento recebida (sinal repetido
  ignorado e temporizador de segurança inalterados)
- [X] T007 [P] Escrever `test/unit/public-route.test.ts` (R-41): o decorator `@Public()` grava o metadado lido pelo guard
  global; o guard libera rota com `@Public()`; e o middleware de log de requisição registra `/health/live`,
  `/health/ready` e `/metrics` em nível `debug` e as demais rotas em `info` (com `JsonLogger` capturando as linhas)

### Implementação da fundação

- [X] T008 Estender `src/platform/metrics/metrics.port.ts` e `src/platform/metrics/in-memory-metrics.ts` (R-43):
  `reconciliation_divergences_total` em `COUNTER_NAMES`; lista fechada de rótulos; histogramas por bucket com `sum` e
  `count`; janela das últimas 1 000 observações por série (mantém a API `observations()` dos testes da 002);
  `snapshot()` com `histograms`. Faz o T005 passar; toda a suíte da 002 continua verde
- [X] T009 Implementar o encerramento que drena antes de fechar o HTTP (R-40; FR-016): `isDraining()` em
  `src/platform/workers/worker-registry.ts`; `src/platform/lifecycle/graceful-shutdown.ts` com
  `gracefulShutdown(app, timeoutMs)` (`drainAll` → `app.close()`); `src/main.ts` passa `gracefulShutdown` ao
  `installShutdownSignals`; `test/support/app-harness.ts` ganha `shutdown()` com a mesma função. Faz o T006 passar;
  `test/concurrency/signal-exit.test.ts` e `test/concurrency/graceful-sigterm.test.ts` continuam verdes
- [X] T010 [P] Criar `src/platform/auth/public.decorator.ts` (`@Public()`) e fazer `src/platform/auth/noop-auth.guard.ts`
  ler o metadado pelo `Reflector`; mudar `requestLoggingMiddleware` em `src/platform/logging/json-logger.ts` para nível
  `debug` em `/health/*` e `/metrics` (R-41). Faz o T007 passar

**Checkpoint Fundação**: `bun run typecheck && bun test test/unit && bun run test:integration && bun run test:concurrency`
(a 002 inteira continua verde com as métricas e o encerramento novos).

---

## Phase 3: User Story 1 - Reconciliar uma wallet (Priority: P1) 🎯 MVP

**Goal**: `POST /wallets/:walletId/reconciliation` somente leitura num snapshot, comparação pura, divergência
sinalizada (log + contador + `consistent` false) e nunca corrigida.

**Independent Test**: reconciliar wallets movimentadas (consistentes) e, no banco sem guardas, wallets com saldo ou
cadeia alterados (inconsistentes, com log e contador, dados intactos).

### Testes da User Story 1 (escrever primeiro; devem falhar)

- [ ] T011 [P] [US1] Escrever `test/unit/reconciliation.test.ts` (R-37; FR-004 a FR-007): `reconcile(input)` com
  - wallet consistente (`difference` 0.00, `chainConsistent` true, sem `firstBrokenSeq`);
  - sem lançamentos e saldo 0.00 (consistente, `checkedEntries` 0) e sem lançamentos com saldo ≠ 0 (inconsistente, cadeia
    íntegra);
  - diferença positiva e negativa, com sinal (`stored − calculated`);
  - elo quebrado no primeiro lançamento (`before` ≠ 0) e no meio (`firstBrokenSeq` = menor `seq` quebrado);
  - cauda quebrada (`after` do último ≠ saldo armazenado, `firstBrokenSeq` = último `seq`);
  - soma certa com cadeia quebrada → `consistent` false;
  - moedas diferentes recusadas; nenhum `number` em valor monetário
- [ ] T012 [P] [US1] Escrever `test/integration/reconciliation.test.ts` (US1 cenários 1, 2, 6 e 7; FR-001 a FR-004,
  FR-009 a FR-012; SC-001, SC-008, SC-009; I-37, I-74), com PostgreSQL e MiniStack reais:
  - consistente depois de BET, WIN, LOSS, REFUND, ROLLBACK, uma PENDING_REFERENCE resolvida pelo worker e transações
    pela fila; `checkedEntries` igual à contagem de lançamentos da wallet;
  - wallet com saldo inicial zero: `calculatedBalance` 0.00, `checkedEntries` 0, `consistent` true;
  - somente leitura: linhas de `wallets`, `wallet_ledger_entries`, `wager_transactions` e `outbox_messages` idênticas antes
    e depois; corpo enviado é ignorado;
  - 404 `WALLET_NOT_FOUND`, 400 `VALIDATION_ERROR` e 503 `SERVICE_UNAVAILABLE` com `Retry-After` (banco cortado por
    proxy TCP), no envelope do I-38; header `X-Correlation-Id` ecoado;
  - sem credencial;
  - wallet com 1 000 lançamentos reconciliada em menos de 1 s (SC-008);
  - `assertWalletMatchesLedger` ao fim de cada teste
- [ ] T013 [P] [US1] Escrever `test/integration/reconciliation-divergence.test.ts` (US1 cenários 3 e 4; FR-005 a
  FR-008; SC-002; R-38), com `useBareTestDatabase` e a app subida contra esse banco; cria wallets e transações pela API
  e provoca a divergência com `UPDATE` direto:
  - saldo armazenado maior e menor que o ledger → `consistent` false, `difference` com o sinal certo;
  - `balance_before` de um lançamento do meio alterado → `chainConsistent` false, `firstBrokenSeq` desse lançamento;
  - `balance_after` do último alterado → quebra na cauda;
  - dois desvios que se anulam na soma → `difference` 0.00 e `consistent` false;
  - wallet sem lançamentos com saldo ≠ 0;
  - em cada caso: uma linha `reconciliation.divergence` em nível `error` com `walletId`, `correlationId`,
    `checkedEntries`, `firstBrokenSeq` e `consistent` false, **sem** nenhum campo monetário; `+1` em
    `reconciliation_divergences_total` por detecção (duas reconciliações → +2); saldo e ledger iguais depois (nada
    corrigido)
- [ ] T014 [P] [US1] Escrever `test/concurrency/reconciliation-under-load.test.ts` (US1 cenário 5; FR-002, FR-010;
  SC-003; constitution III): 3 instâncias; 50 BETs concorrentes numa wallet, distribuídas pelas instâncias, enquanto
  outra instância reconcilia a mesma wallet em laço até as BETs terminarem; todas as leituras `consistent` true e
  `checkedEntries` não decrescente; ao fim, uma reconciliação com `checkedEntries` = 1 + BETs aceitas e
  `assertWalletMatchesLedger`

### Implementação da User Story 1

- [ ] T015 [US1] Implementar `src/reconciliation/domain/reconciliation.ts` (R-37; data-model §1): `reconcile(input)`
  puro, sem I/O, com `Money` (decimal.js), regras do data-model ("elo quebrado em n ⇔ (n é o primeiro e before[n] ≠
  0.00) ou (n não é o primeiro e before[n] ≠ after[n−1])"; "cauda quebrada ⇔ existe lançamento e after[último] ≠
  storedBalance"; "consistent ⇔ difference zero e chainConsistent"). Faz o T011 passar
- [ ] T016 [US1] Implementar `src/reconciliation/infrastructure/mikro-orm-reconciliation.reader.ts` (R-36; data-model
  §2.1): as duas consultas, com `?`, `numeric::text`, `lag(balance_after) OVER (ORDER BY seq)`, sem `FOR UPDATE`;
  `seq` convertido para inteiro só depois de conferido como seguro
- [ ] T017 [US1] Implementar `src/reconciliation/application/reconcile-wallet.use-case.ts` (R-36; FR-002, FR-008,
  FR-011): fork do EM, `transactional` com `REPEATABLE READ` e `SET TRANSACTION READ ONLY` como primeira instrução;
  wallet ausente → `WalletNotFoundError`; falha transitória → `ServiceUnavailableError` (classificador da 001); depois
  da transação, `reconcile`; divergência → `logger.error('reconciliation.divergence', …)` sem valores e
  `metrics.increment('reconciliation_divergences_total')`
- [ ] T018 [US1] Implementar `src/reconciliation/interfaces/http/reconciliation.controller.ts` (`@Controller('wallets')`,
  `@Post(':walletId/reconciliation')`, `@HttpCode(200)`, `@Public()`, `walletIdParamSchema` da 001, corpo ignorado) e
  `src/reconciliation/reconciliation.module.ts`, registrado em `src/app.module.ts` ([contracts/http.md](contracts/http.md)).
  Faz o T012, o T013 e o T014 passarem
- [ ] T019 [US1] Revisar o diff da US1 contra o `review-checklist.md`, com atenção a "Reconciliação somente leitura num
  snapshot", "Divergência sinalizada e nunca corrigida" e "Divergência testada sem desligar guardas"; registrar item a
  item em `specs/003-reconciliation-health-metrics/implementation-notes.md`

**Checkpoint US1**: `bun test test/unit/reconciliation.test.ts && bun test --preload ./test/support/db-setup.preload.ts
test/integration/reconciliation.test.ts test/integration/reconciliation-divergence.test.ts
test/concurrency/reconciliation-under-load.test.ts`, com o T019 concluído.

---

## Phase 4: User Story 2 - Saber se a instância está viva e pronta (Priority: P2)

**Goal**: `GET /health/live` e `GET /health/ready` com checagens de 2 s em paralelo e 503 durante o encerramento.

**Independent Test**: live/ready com tudo no ar; banco e fila cortados por proxy; conexão pendurada; ready durante a
drenagem, em processo e em container.

### Testes da User Story 2 (escrever primeiro; devem falhar)

- [ ] T020 [P] [US2] Escrever `test/unit/readiness.test.ts` (R-39; FR-014 a FR-016): `readinessOf(checks, draining)` em
  todas as combinações de `postgres`/`sqs` `up`/`down` × `draining` (200 só com tudo `up` e sem `draining`; corpo
  `{"status":"ok"|"unavailable","checks":{...}}`); `withTimeout(fn, 2000)` devolve `down` quando a checagem não
  termina no prazo (com relógio de teste) e não deixa temporizador pendente
- [ ] T021 [P] [US2] Escrever `test/integration/health.test.ts` (US2 cenários 1, 2, 3, 5 e 6; FR-013 a FR-015, FR-017,
  FR-018; SC-004, SC-005, SC-009; I-34, I-75), com proxies TCP reais na frente do PostgreSQL e do MiniStack:
  - tudo no ar → live 200 `{"status":"ok"}`, ready 200 `{"status":"ok","checks":{"postgres":"up","sqs":"up"}}`;
  - PostgreSQL cortado → ready 503 `postgres:down` em até 3 s, live 200; volta a 200 sem reinício;
  - SQS cortado → ready 503 `sqs:down`, live 200 e `POST /wagering/transactions` respondendo 201 (outbox acumula);
    volta sem reinício;
  - filas inexistentes (configuração com nomes que não existem) → `sqs:down`;
  - conexão pendurada (`stall()`) no PostgreSQL e no SQS → 503 em até 3 s, sem ficar preso;
  - sem credencial; corpo fora do envelope do I-38; linhas `http.request` dessas rotas em nível `debug`
- [ ] T022 [P] [US2] Escrever `test/integration/health-shutdown.test.ts` (US2 cenário 4; FR-016; SC-006; R-40):
  consumidor ligado e uma mensagem presa no lock da wallet segurado por fora; `app.shutdown()` (o mesmo
  `gracefulShutdown` do sinal) sem `await`; enquanto drena, ready responde 503 com `checks` reais e `GET
  /wallets/:walletId` ainda responde 200; o lock é solto; o encerramento termina, a mensagem é processada uma única vez
  e `assertWalletMatchesLedger`
- [ ] T023 [US2] Estender `test/concurrency/graceful-sigterm.test.ts` (FR-016; SC-006; R-40): nas duas variantes
  (`app-test` e `app-test-init`), depois do SIGTERM e antes de soltar o lock, ler o ready de dentro do container
  (`docker exec <id> bun -e "…fetch('http://127.0.0.1:<porta>/health/ready')…"`) e conferir 503; o resto do teste
  (conclusão, ack, saída 0, uma única vez) continua igual

### Implementação da User Story 2

- [ ] T024 [US2] Implementar `src/health/application/readiness.ts` (R-39): `readinessOf` puro e `withTimeout` com
  temporizador cancelado; constante `HEALTH_CHECK_TIMEOUT_MS = 2000` (I-75). Faz o T020 passar
- [ ] T025 [P] [US2] Implementar `src/health/infrastructure/postgres.health-check.ts` (`SELECT 1` num fork do EM) e
  `src/health/infrastructure/sqs.health-check.ts` (`approximateCounts` das filas de transações, DLQ e eventos da
  configuração, em paralelo, pela `SqsPort` da 002), cada um devolvendo `up`/`down` sem lançar (R-39)
- [ ] T026 [US2] Implementar `src/health/interfaces/http/health.controller.ts` (`@Controller('health')`, `@Public()`,
  `GET live` e `GET ready`, status 200/503 definido no controller com o corpo próprio, `isDraining()` do
  `WORKER_REGISTRY`) e `src/health/health.module.ts`, registrado em `src/app.module.ts`
  ([contracts/http.md](contracts/http.md)). Faz o T021, o T022 e o T023 passarem
- [ ] T027 [US2] Revisar o diff da US2 contra o `review-checklist.md`, com atenção a "Health correto" e à drenagem antes
  do `app.close()` (que o ack continua depois do commit e a devolução de visibilidade da 002 não muda); registrar item a
  item em `implementation-notes.md`

**Checkpoint US2**: `bun test test/unit/readiness.test.ts test/unit/graceful-shutdown.test.ts && bun test --preload
./test/support/db-setup.preload.ts test/integration/health.test.ts test/integration/health-shutdown.test.ts
test/concurrency/graceful-sigterm.test.ts test/concurrency/signal-exit.test.ts`, com o T027 concluído.

---

## Phase 5: User Story 3 - Ler as métricas do serviço (Priority: P3)

**Goal**: `GET /metrics` em texto Prometheus escrito à mão, com as métricas da 002, o contador de divergências e os
gauges da outbox lidos na coleta.

**Independent Test**: operações reais e leitura do endpoint; contadores e gauges batem com as operações e com o banco;
nenhum rótulo com id ou valor.

### Testes da User Story 3 (escrever primeiro; devem falhar)

- [ ] T028 [P] [US3] Escrever `test/unit/prometheus-text.test.ts` (R-42; FR-019, FR-020): `renderPrometheus(snapshot,
  gauges)` produz `# HELP` e `# TYPE` por família; contadores com e sem rótulo (sem rótulo aparece com 0 antes do
  primeiro incremento); histograma com `_bucket{le=…}` cumulativo até `+Inf`, `_sum` e `_count`; gauges; ausência dos
  gauges da outbox quando não informados; escape de `\\`, `\"` e `\n` nos valores de rótulo; ordem estável por nome e
  rótulos; texto aceito pelo `parsePrometheus` do T004
- [ ] T029 [P] [US3] Escrever `test/integration/metrics-endpoint.test.ts` (US3 cenários 1 a 6; FR-019 a FR-024; SC-007,
  SC-009; I-76), com PostgreSQL e MiniStack reais, lendo `GET /metrics` com `parsePrometheus`:
  - depois de BET aceita, BET rejeitada, pendente, replay pela idempotência, mensagem duplicada, retry por lock
    esgotado, mensagem malformada (DLQ): `transactions_total{status}`, `duplicates_total{source}`,
    `retries_total{worker}`, `dlq_total{errorCode,errorClass}`, `lock_conflicts_total` e os histogramas
    `processing_latency_ms` e `outbox_lag_ms` batem com as operações;
  - `outbox_pending_events` e `outbox_oldest_pending_age_seconds` iguais ao que o banco mostra (publicador desligado;
    depois de ligá-lo e publicar tudo, ambos 0);
  - `reconciliation_divergences_total` +1 depois de uma divergência num app sobre `useBareTestDatabase`;
  - PostgreSQL cortado (proxy) na coleta → 200 sem os gauges da outbox e com o restante;
  - `Content-Type` `text/plain; version=0.0.4; charset=utf-8`; sem credencial; nenhum rótulo fora da lista fechada,
    nenhum valor de rótulo com formato de UUID ou de número

### Implementação da User Story 3

- [ ] T030 [US3] Implementar `src/platform/metrics/prometheus-text.ts` com `renderPrometheus` puro (R-42; nomes, tipos,
  HELP e buckets de [contracts/metrics.md](contracts/metrics.md)). Faz o T028 passar
- [ ] T031 [US3] Implementar `src/outbox/infrastructure/outbox-lag.reader.ts` (R-44; data-model §2.3): `SELECT count(*),
  min(occurred_at) FROM outbox_messages WHERE published_at IS NULL`, prazo de 2 s, idade pela porta `Clock` em segundos
  (0 sem pendentes); falha → `undefined` e `logger.warn('metrics.outbox_lag_unavailable')`; somente leitura
- [ ] T032 [US3] Implementar `src/metrics/interfaces/http/metrics.controller.ts` (`GET /metrics`, `@Public()`,
  `Content-Type` do formato 0.0.4, `snapshot()` do `METRICS` + `OutboxLagReader` + `renderPrometheus`) e
  `src/metrics/metrics.module.ts`, registrado em `src/app.module.ts`. Faz o T029 passar
- [ ] T033 [US3] Revisar o diff da US3 contra o `review-checklist.md`, com atenção a "Métricas de baixa cardinalidade e
  sem dinheiro" e "Nenhuma escrita nova"; registrar item a item em `implementation-notes.md`

**Checkpoint US3**: `bun test test/unit/prometheus-text.test.ts test/unit/in-memory-metrics.test.ts && bun test
--preload ./test/support/db-setup.preload.ts test/integration/metrics-endpoint.test.ts`, com o T033 concluído.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: guardrails, revisão final, suíte completa e quickstart.

> **Adiado (como na 001 e na 002):** `README.md` e `ARCHITECTURE.md` ficam para o fim do projeto; o conteúdo desta feature
> está no plan e nas limitações do research §4.

- [ ] T034 [P] Estender `test/unit/conventions.test.ts` (T118 da 001, T084 da 002; R-38, R-41, R-43), cada regra com
  autoteste (um exemplo que passa e um que falha): (j) `useBareTestDatabase` só importado por
  `test/integration/reconciliation-divergence.test.ts` e `test/integration/metrics-endpoint.test.ts`; (k) em `src/**`,
  nenhuma chamada `increment(`/`observe(` com rótulo `walletId`, `providerId`, `transactionId`, `messageId`, `eventId`
  ou outra chave terminada em `Id`; (l) em `src/reconciliation/**`, `src/health/**` e `src/metrics/**`, nenhum
  `FOR UPDATE`, `FOR SHARE`, `INSERT`, `UPDATE` ou `DELETE` em SQL; (m) os controllers de `src/reconciliation`,
  `src/health` e `src/metrics` têm `@Public()`
- [ ] T035 Revisar o diff completo da feature contra o `review-checklist.md` (gate de Revisão); registrar item a item em
  `implementation-notes.md`; item reprovado volta para a task de origem antes do T036
- [ ] T036 Executar a suíte completa pelos scripts do `package.json`, com `docker compose up -d postgres sqs`:
  `bun run typecheck && bun run test` (unit, integration e concurrency), tudo verde, inclusive o T034; registrar a
  contagem de testes e a duração
- [ ] T037 Validar o `quickstart.md` de ponta a ponta com `docker compose --profile cluster up -d --build` (cenários §3.1
  a §3.6)
- [ ] T038 **(adiado para o fim do projeto)** Acrescentar ao `README.md` e ao `ARCHITECTURE.md` o conteúdo desta feature
  (plan, research §4)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: sem dependências; T001 → T002 (o helper usa o `to`).
- **Foundational (Phase 2)**: depende do Setup e **bloqueia todas as histórias**.
- **US1 (Phase 3)**: depende da Fundação (T008 para o contador, T010 para `@Public()`); usa T002 e T003.
- **US2 (Phase 4)**: depende da Fundação (T009 para `isDraining` e `shutdown()`); usa T003. Independente da US1.
- **US3 (Phase 5)**: depende da Fundação (T008) e do T004; o teste T029 usa a reconciliação da US1 para provocar a
  divergência (T018) e o T002.
- **Polish (Phase 6)**: depende das três histórias. T035 depois do T034 e antes do T036.

### Arquivos compartilhados (sem [P] entre si)

- `src/app.module.ts`: T018 → T026 → T032
- `src/platform/metrics/in-memory-metrics.ts`: T008
- `test/concurrency/graceful-sigterm.test.ts`: T023
- `test/support/app-harness.ts`: T009
- `implementation-notes.md`: T019 → T027 → T033 → T035

### Ordem dentro de cada história

Testes unitários → testes de integração e concorrência (falhando) → domínio → infraestrutura → use case → controller e
módulo → testes verdes → revisão → checkpoint.

---

## Parallel Examples

### Setup

```text
T001 run-migrations { to }      T003 tcp-proxy stall()      T004 parser Prometheus de teste
```

### Fundação: testes

```text
T005 in-memory-metrics          T006 graceful-shutdown      T007 @Public() e log em debug
```

### User Story 1: testes

```text
T011 reconcile (unit)   T012 reconciliation (integração)   T013 divergência (banco sem guardas)   T014 concorrência
```

### User Story 2 e 3 (depois da Fundação, em paralelo com a US1 se houver equipe)

```text
T020 readiness (unit)   T021 health (proxies)   T022 health durante o encerramento   T028 renderPrometheus (unit)
```

---

## Implementation Strategy

### MVP: Fundação + US1

1. Setup e Fundação (métricas com buckets, encerramento que drena antes, `@Public()`), com a 002 inteira verde.
2. US1: reconciliação somente leitura, divergência no banco sem guardas, concorrência com 50 BETs.
3. **Parar e validar**: checkpoint US1; a invariante `wallet.balance == ledger` passa a ser verificável sob demanda.

### Entrega incremental

1. US2 (health) → checkpoint US2 → o orquestrador já pode usar live/ready.
2. US3 (métricas) → checkpoint US3 → o monitoramento coleta tudo.
3. Polish: guardrails, revisão final, suíte completa e quickstart.

## Notes

- `[P]` = arquivos diferentes, sem dependência de task incompleta.
- Cada história é testável sozinha depois da Fundação; a US3 só usa a US1 para provocar a divergência no seu teste.
- Nenhuma task altera schema, migration ou regra financeira.
- `[X]` só com o teste passando; commit por história seguindo a regra do projeto (Conventional Commits, sem trailer).
