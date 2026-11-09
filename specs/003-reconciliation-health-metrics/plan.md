# Implementation Plan: Reconciliação, Health Checks e Métricas

**Branch**: `003-reconciliation-health-metrics` (id da feature; o trabalho segue na branch `main`) | **Date**: 2026-11-09 |
**Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/003-reconciliation-health-metrics/spec.md`

**Fontes lidas**: [spec.md](spec.md), `docs/enunciado.md` §9, §12 e §13, `docs/interpretacoes.md` (I-01 a I-76, em
especial I-34, I-37, I-38, I-41, I-53 e I-74 a I-76), `.specify/memory/constitution.md` v1.0.1, e o plan, a research, a
data-model e as implementation-notes da 001 e da 002 (decisões R-01 a R-35 e N-01 a N-45 continuam valendo).

**Artefatos**: [research.md](research.md) · [data-model.md](data-model.md) · [contracts/](contracts/) ·
[quickstart.md](quickstart.md)

## Summary

Três superfícies operacionais sobre o que a 001 e a 002 já entregam, sem mudar schema nem regra financeira:

- **Reconciliação** (`POST /wallets/:walletId/reconciliation`): numa transação `REPEATABLE READ`, `READ ONLY`, lê o
  saldo da wallet e um agregado do ledger calculado no banco (soma com sinal e cadeia com `lag()`), no mesmo snapshot.
  Uma função pura de domínio compara e decide `consistent`. Divergência → log de erro sem valores, contador
  `reconciliation_divergences_total` e `consistent` false; nunca corrige (FR-001 a FR-012, I-37, I-74).
- **Health** (`GET /health/live` e `GET /health/ready`): live sem dependências; ready checa PostgreSQL e as filas SQS
  em paralelo, com prazo de 2 s cada, e responde 503 também durante o encerramento. Para isso, a drenagem dos
  trabalhadores passa a acontecer **antes** de o servidor HTTP fechar (FR-013 a FR-018, I-34, I-75).
- **Métricas** (`GET /metrics`): texto Prometheus escrito à mão a partir da porta de métricas da 002, com histogramas
  por buckets (memória limitada), lista fechada de rótulos e os gauges da outbox lidos do banco na coleta (FR-019 a
  FR-024, I-76).

Sem spike e sem dependência nova (decisão do usuário; [research.md](research.md) R-36 a R-45).

## Technical Context

**Language/Version**: TypeScript strict sobre Bun 1.4.4, sem etapa de build (001, R-01, R-18).

**Primary Dependencies**: as da 001 e da 002, nas mesmas versões exatas (NestJS 12.2.0, MikroORM 7.2.5, Zod 4.6.7,
decimal.js, `@aws-sdk/client-sqs` 3.1156.0). **Nenhuma dependência nova**: o formato Prometheus é escrito à mão (R-42).

**Storage**: PostgreSQL 17. **Nenhuma migration nova**. Leituras sobre `wallets`, `wallet_ledger_entries`
(`ledger_wallet_seq_idx`) e `outbox_messages` (`outbox_pending_idx`), da 001 ([data-model.md](data-model.md) §2).

**Messaging**: as filas da 002, só lidas (`GetQueueAttributes`) pela `SqsPort` na checagem de ready.

**Testing**: `bun test` com PostgreSQL e MiniStack reais (constitution VII); banco e filas próprios por arquivo (001
R-17, 002 R-31). Divergência num banco sem as guardas, criado só com as migrations de tabelas (R-38). Indisponibilidade
por proxy TCP real (001 R-17), com um modo novo "pendurado". Encerramento pelo mesmo `gracefulShutdown(app)` do handler
de sinal, em processo e em container (R-40).

**Target Platform**: containers Linux (Compose); desenvolvimento em Windows com Docker Desktop (001).

**Project Type**: web service (API HTTP NestJS + trabalhadores de fundo), um único projeto.

**Performance Goals**: reconciliação de uma wallet com 1 000 lançamentos em menos de 1 s sem disputa (SC-008); ready
responde em até ~2 s com uma dependência pendurada (SC-004); `/metrics` com custo constante em memória por série.

**Constraints**: reconciliação somente leitura, sem lock e sem carregar o ledger; nenhum rótulo de métrica com
identificador ou valor monetário; endpoints sem autenticação; logs sem valores monetários (constitution VIII).

**Scale/Scope**: 4 endpoints, 3 módulos novos (`reconciliation`, `health`, `metrics`), ajustes pontuais na plataforma
da 002 (`InMemoryMetrics`, `WorkerRegistry`, handler de sinal, log de requisição, migrações em teste).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.* Verificado antes da Phase 0 e de novo depois
da Phase 1 (mesmo resultado; nenhuma exceção em Complexity Tracking).

### Princípios

| Princípio | Atende? | Como |
|-----------|---------|------|
| I. Fontes da verdade e precedência | Sim | Enunciado §9/§12 e interpretações I-34, I-37, I-74 a I-76 (registradas antes da spec, a pedido do usuário) são as fontes; nenhuma decisão contradiz o enunciado. |
| II. Correção financeira (NÃO-NEGOCIÁVEL) | Sim | Valores como `Money` (decimal.js) e strings com 2 casas; `numeric::text` no SQL; nenhum `number` em dinheiro (só `seq` e contagens). A reconciliação reforça a invariante `wallet.balance == ledger` (001/FR-042) e nunca altera dado. |
| III. Concorrência por wallet (NÃO-NEGOCIÁVEL) | Sim | Reconciliação sem lock, num snapshot `REPEATABLE READ`: sem falso positivo nem bloqueio de escritas (R-36); teste com 3 instâncias e 50 BETs concorrentes. Nenhuma escrita nova, então nenhuma ordem de lock nova. |
| IV. Idempotência persistente e mensageria confiável (NÃO-NEGOCIÁVEL) | Sim (sem mudança) | Nada muda em idempotência, inbox ou outbox; a drenagem antes do `close()` (R-40) mantém as garantias da 002 (ack depois do commit, devolução de visibilidade). |
| V. Invariantes impostas pelo schema | Sim | Schema e triggers intactos. A divergência é provada num banco criado sem as guardas, nunca desligando triggers (R-38); o guardrail T118 continua proibindo `DISABLE TRIGGER`/`session_replication_role`. |
| VI. Domínio encapsulado e portas | Sim | `reconcile` é função pura de domínio; tempo pela `Clock` (idade da outbox), fila pela `SqsPort`, métricas pela `MetricsPort`; `@aws-sdk` continua só em `messaging/infrastructure`. |
| VII. Testes reais (NÃO-NEGOCIÁVEL) | Sim | Integração e concorrência com PostgreSQL e MiniStack reais; proxies TCP reais; container real para SIGTERM; unitários para a função pura e o renderer. Toda leitura termina com `assertWalletMatchesLedger` quando toca wallet. |
| VIII. Observabilidade e contrato de API | Sim | É o objeto da feature: métricas mínimas do enunciado §12 mais divergências; health separados sem autenticação; erros no envelope do I-38 (404/400/503); log de divergência sem valores; correlationId em tudo. |
| IX. Documentação das decisões | Sim | research R-36 a R-45 e limitações (§4); `README`/`ARCHITECTURE` adiados para o fim do projeto por decisão do usuário (como na 001 e na 002), registrados como pendência, não omitidos. |

### Falhas eliminatórias

| # | Falha | Situação |
|---|-------|----------|
| 1 | `number` para dinheiro | Não ocorre: `Money`/string em todo o fluxo; o guardrail (c) da 001 continua verificando. |
| 2 | Saldo negativo por race | Não se aplica: nenhuma escrita nova. |
| 3 | Débito ou crédito duplicado | Não se aplica: nenhuma escrita nova; a drenagem não muda o ack (R-40). |
| 4 | Idempotência só em memória | Não se aplica: idempotência intocada. As métricas são em memória por definição (observação, R-32 da 002), não garantia. |
| 5 | Correta só com uma instância | Não ocorre: reconciliação por snapshot, testada com 3 instâncias; métricas por instância, agregadas pelo monitoramento. |
| 6 | Evento publicado antes do commit | Não se aplica: nada é publicado. |
| 7 | Ausência de ledger auditável | Não ocorre: a reconciliação audita o ledger e sua cadeia. |
| 8 | Testes que substituem PostgreSQL e SQS por mocks | Não ocorre: só reais em integração e concorrência (guardrails (b) e (f)). |

**Gate**: aprovado. Nenhuma violação, nenhuma entrada em Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/003-reconciliation-health-metrics/
├── spec.md
├── plan.md              # este arquivo
├── research.md          # R-36 a R-45
├── data-model.md        # resultado, readiness, séries e leituras (sem schema novo)
├── quickstart.md
├── contracts/
│   ├── http.md          # reconciliação e health
│   └── metrics.md       # exposição Prometheus
├── checklists/
│   └── requirements.md
├── review-checklist.md  # criado pelo /speckit-tasks
└── tasks.md             # criado pelo /speckit-tasks
```

### Source Code (repository root)

```text
src/
├── reconciliation/                                   # NOVO
│   ├── domain/reconciliation.ts                      # reconcile(input) puro → ReconciliationResult (R-37)
│   ├── application/reconcile-wallet.use-case.ts      # snapshot RR/READ ONLY, compara, log + contador (R-36)
│   ├── infrastructure/mikro-orm-reconciliation.reader.ts  # as duas leituras do data-model §2.1
│   ├── interfaces/http/reconciliation.controller.ts  # POST /wallets/:walletId/reconciliation (@Public)
│   └── reconciliation.module.ts
├── health/                                           # NOVO
│   ├── application/readiness.ts                      # readinessOf(checks, draining) puro + checagens com prazo (R-39)
│   ├── infrastructure/postgres.health-check.ts       # SELECT 1
│   ├── infrastructure/sqs.health-check.ts            # approximateCounts das 3 filas pela SqsPort
│   ├── interfaces/http/health.controller.ts          # /health/live, /health/ready (@Public, corpo próprio)
│   └── health.module.ts
├── metrics/                                          # NOVO (exposição; o provider METRICS da 002 continua no AppModule)
│   ├── interfaces/http/metrics.controller.ts         # GET /metrics (@Public)
│   └── metrics.module.ts
├── outbox/infrastructure/outbox-lag.reader.ts        # NOVO: count + min(occurred_at) dos pendentes (R-44)
├── platform/
│   ├── metrics/metrics.port.ts                       # + reconciliation_divergences_total, lista de rótulos (R-43)
│   ├── metrics/in-memory-metrics.ts                  # histogramas por bucket, janela limitada, rótulos validados
│   ├── metrics/prometheus-text.ts                    # NOVO: renderPrometheus puro (R-42)
│   ├── workers/worker-registry.ts                    # + isDraining() (R-40)
│   ├── lifecycle/graceful-shutdown.ts                # NOVO: drainAll → app.close() (R-40)
│   ├── lifecycle/signal-handler.ts                   # close = gracefulShutdown
│   ├── auth/public.decorator.ts                      # NOVO: @Public(), lido pelo guard global (R-41)
│   ├── logging/json-logger.ts                        # /health/* e /metrics em debug (R-41)
│   └── persistence/run-migrations.ts                 # + { to } (R-38)
├── main.ts                                           # handler de sinal com gracefulShutdown
└── app.module.ts                                     # + ReconciliationModule, HealthModule, MetricsModule

test/
├── support/
│   ├── test-database.ts                              # + useBareTestDatabase (só migrations de tabelas, R-38)
│   ├── tcp-proxy.ts                                  # + stall() (aceita e não responde)
│   ├── prometheus.ts                                 # NOVO: parser mínimo do texto, só para asserções
│   └── app-harness.ts                                # + shutdown() = gracefulShutdown(app)
├── unit/{reconciliation, readiness, prometheus-text, in-memory-metrics, graceful-shutdown}.test.ts
├── integration/{reconciliation, reconciliation-divergence, health, health-shutdown, metrics-endpoint}.test.ts
└── concurrency/{reconciliation-under-load, graceful-sigterm (estendido)}.test.ts
```

**Structure Decision**: mesmo projeto único e mesma organização por contexto (`domain`/`application`/
`infrastructure`/`interfaces`) da 001 e da 002. `reconciliation` é contexto próprio (lê wallets e ledger por SQL
próprio, sem reutilizar repositórios de escrita); `health` e `metrics` são contextos operacionais finos. O provider
`METRICS` continua no `AppModule` (002).

## Design

### Reconciliação (FR-001 a FR-012)

1. Controller valida `walletId` com o `walletIdParamSchema` da 001 (400) e chama o use case; ignora o corpo.
2. Use case: `orm.em.fork().transactional(…, { isolationLevel: REPEATABLE_READ })` com `SET TRANSACTION READ ONLY`
   como primeira instrução; reader faz as duas leituras do data-model §2.1. Wallet ausente → `WalletNotFoundError`
   (404). Falha transitória do banco → `ServiceUnavailableError` (503), pelo classificador da 001.
3. Depois do fim da transação, `reconcile(input)` (puro) monta o resultado.
4. `consistent` false → `logger.error('reconciliation.divergence', { walletId, checkedEntries, firstBrokenSeq,
   consistent: false })` (correlationId vem do contexto; nenhum campo monetário, e o `JsonLogger` já remove chaves
   monetárias) e `metrics.increment('reconciliation_divergences_total')`.
5. Resposta 200 com o JSON do [contrato](contracts/http.md).

Nenhuma escrita: `READ ONLY` faz o banco recusar qualquer `INSERT`/`UPDATE` por engano.

### Health (FR-013 a FR-018)

- `GET /health/live` → 200 `{"status":"ok"}`.
- `GET /health/ready` → `Promise.all` das duas checagens, cada uma com `withTimeout(2000)`; `readinessOf(checks,
  registry.isDraining())`; status 200/503 definido no controller com o corpo próprio (sem lançar exceção, para não
  passar pelo filtro do I-38).
- **Encerramento** (R-40): `gracefulShutdown(app)` = `registry.drainAll(CONSUMER_SHUTDOWN_TIMEOUT_MS)` e depois
  `app.close()`. Durante o `drainAll`, o HTTP continua aberto e o ready responde 503. O `OrmLifecycle` continua
  chamando `drainAll` (idempotente) antes de fechar o pool. O handler de sinal (002, R-35) passa a chamar
  `gracefulShutdown` no lugar de `app.close()`; o temporizador de segurança e o "sinal repetido ignorado" não mudam.
- Log de requisição em `debug` para `/health/*` e `/metrics`.

### Métricas (FR-019 a FR-024)

- `InMemoryMetrics` (R-43): histogramas por bucket com contagem e soma, janela das últimas 1 000 observações por série
  (mantém `observations()` dos testes da 002), lista fechada de rótulos (erro de programação fora dela), novo contador
  `reconciliation_divergences_total`; `snapshot()` passa a devolver os histogramas.
- `GET /metrics`: `snapshot()` + `OutboxLagReader.read()` (prazo de 2 s; falha → gauges omitidos e warn) →
  `renderPrometheus` → texto com `Content-Type` do formato 0.0.4.
- Nomes e rótulos no [contrato](contracts/metrics.md).

### Endpoints sem autenticação (FR-018, FR-019, SC-009)

`@Public()` nos três controllers; o `NoopAuthGuard` global lê o metadado (hoje libera tudo; amanhã, com autenticação
real, continua liberando estes). Um teste de integração chama todos sem credencial.

### Matriz de testes

| Arquivo | Tipo | Cobre |
|---------|------|-------|
| `unit/reconciliation.test.ts` | unit | `reconcile`: consistente, sem lançamentos (0.00 e ≠ 0), diferença positiva e negativa, elo quebrado no 1º e no meio, cauda quebrada, soma certa com cadeia errada, `consistent` só com as duas condições (FR-004 a FR-007) |
| `unit/readiness.test.ts` | unit | `readinessOf`: todas as combinações up/down × draining; `withTimeout` desiste no prazo |
| `unit/prometheus-text.test.ts` | unit | `# HELP`/`# TYPE`, counters, histogram cumulativo (`le`, `+Inf`, `_sum`, `_count`), gauges, escape, ordem estável, família vazia |
| `unit/in-memory-metrics.test.ts` (estendido) | unit | buckets, soma e contagem; janela de 1 000; rótulo fora da lista recusado; novo contador |
| `unit/graceful-shutdown.test.ts` | unit | ordem `drainAll` → `close`; `isDraining` verdadeiro desde o início; erro no `close` propaga |
| `integration/reconciliation.test.ts` | integração | consistente depois de BET, WIN, LOSS, REFUND, ROLLBACK, PENDING_REFERENCE resolvida e transações pela fila; wallet sem lançamentos; nada muda nas tabelas (somente leitura); 404, 400, 503 (proxy); correlationId; 1 000 lançamentos em < 1 s (SC-008) |
| `integration/reconciliation-divergence.test.ts` | integração | banco sem guardas (R-38): saldo alterado (diferença ±), elo quebrado, cauda quebrada, soma certa com cadeia quebrada, wallet sem lançamentos com saldo ≠ 0; log `error` sem valores; contador +1 por detecção; dados intactos depois |
| `integration/health.test.ts` | integração | live/ready com tudo no ar; PostgreSQL cortado (proxy) → ready 503 `postgres:down`, live 200; SQS cortado → ready 503 `sqs:down`, POST de transação 201; conexão pendurada (`stall`) → 503 em ≤ 3 s; volta sem reinício; sem credencial; log em debug |
| `integration/health-shutdown.test.ts` | integração | `shutdown()` com mensagem em andamento (lock da wallet segurado por fora): ready 503 durante a drenagem, outras rotas ainda respondem, mensagem concluída uma vez |
| `integration/metrics-endpoint.test.ts` | integração | depois de operações reais (HTTP, fila, replay, duplicata, DLQ, lock esgotado, divergência no banco sem guardas, eventos pendentes): contadores, histogramas e gauges batem com as operações e com o banco; banco fora na coleta → 200 sem os gauges; rótulos sem ids nem valores |
| `concurrency/reconciliation-under-load.test.ts` | concorrência | 3 instâncias; 50 BETs concorrentes numa wallet enquanto outra instância reconcilia em laço: todas as leituras `consistent` true; `assertWalletMatchesLedger` no fim (SC-003) |
| `concurrency/graceful-sigterm.test.ts` (estendido) | concorrência | SIGTERM em container (`app-test` e `app-test-init`): ready lido de dentro do container (`docker exec … bun -e fetch`) responde 503 durante a drenagem; saída 0 |
| `unit/conventions.test.ts` (estendido) | unit | `useBareTestDatabase` só nos testes que provocam divergência (reconciliação e métricas); nenhum rótulo de métrica com `walletId`/`providerId`/`*Id` em `src/**`; os controllers de health, métricas e reconciliação com `@Public()` |

## Pendências de decisão

Nenhuma. Os pontos abertos da descrição foram decididos no research (R-36 a R-45) e registrados como interpretações
I-74 a I-76 antes da spec.

## Complexity Tracking

Sem violações; nada a justificar.
