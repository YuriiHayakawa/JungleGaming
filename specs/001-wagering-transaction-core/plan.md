# Implementation Plan: Núcleo Transacional de Apostas

**Branch**: `001-wagering-transaction-core` | **Date**: 2026-11-07 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-wagering-transaction-core/spec.md`

**Fontes lidas**: [spec.md](spec.md), `docs/enunciado.md` §4 a §9 e §11 a §13, `docs/interpretacoes.md` (I-01 a
I-58), `.specify/memory/constitution.md` v1.0.1.

**Artefatos**: [research.md](research.md) · [data-model.md](data-model.md) ·
[contracts/openapi.yaml](contracts/openapi.yaml) · [quickstart.md](quickstart.md)

## Summary

Serviço HTTP que cria wallets com abertura auditável, aplica BET, WIN, LOSS, REFUND e ROLLBACK com idempotência
persistente e mantém o saldo sempre igual ao ledger, inclusive com 3 ou mais instâncias.

Abordagem:
- **Lock pessimista por linha da wallet** (`SELECT ... FOR UPDATE` com `lock_timeout` limitado), em
  `READ COMMITTED`. Sob o lock, a idempotência e a referência são relidas e as regras rodam num serviço de domínio
  puro, na ordem do I-44.
- **Gravação atômica**: transação, saldo, ledger e eventos da outbox vão numa única transação SQL.
- **Defesa no banco**: unicidade, não-negatividade, imutabilidade, encadeamento do ledger e "saldo = cauda do
  ledger" são impostos por constraints e triggers.

Stack: Bun 1.4.4, TypeScript strict, NestJS 12.2.0, MikroORM 7.2.5 com EntitySchema, PostgreSQL, decimal.js e Zod.
Nada de SQS nesta feature.

## Technical Context

**Language/Version**: TypeScript strict sobre Bun 1.4.4 (runtime, package manager e test runner). O Bun
transpila e executa o código-fonte direto, sem etapa de build; `tsc` 7.0.2 faz só o typecheck (confirmado no
spike S-11).

**Primary Dependencies**: NestJS 12.2.0 (`core`, `common`, `platform-express`), MikroORM 7.2.5 (`core`,
`postgresql`, `migrations`), decimal.js 10.6.0, Zod 4.6.7, `reflect-metadata` 0.2.2, `rxjs` 7.8.2, `pg` 8.23.1
(dependência direta em `dependencies`, porque `src/` importa `pg`: os tipos de erro do driver em
`pg-errors.ts` e o `PoolConfig` das opções passadas em `driverOptions`; o harness de testes também o usa). Dev: `typescript` 7.0.2, `@types/bun` 1.4.4, `@types/pg` 8.23.1. Versões
exatas, sem `^` (research §1).

**Storage**: PostgreSQL (`postgres:17-alpine` no Compose). Dinheiro em `NUMERIC(18,2)` + coluna de moeda, lido
como string (I-04, spike S-05).

**Testing**: `bun test`: unitários puros; integração contra PostgreSQL real; concorrência com 3 processos da app
via `Bun.spawn`. Cada arquivo de teste usa um banco próprio, clonado de um template já migrado, sem `TRUNCATE`,
`DELETE` nem `session_replication_role` (research R-17). Sem mocks de banco (constitution VII).

**Target Platform**: Linux em container (`oven/bun:1.4.4`); desenvolvimento local em Windows/macOS/Linux com
Docker.

**Project Type**: web-service (API HTTP, projeto único).

**Performance Goals**: SC-011 (< 1 s por operação sem disputa, em ambiente local); SC-002 (50 submissões
paralelas da mesma BET sem nenhum 409, 500 ou 503). Teste de carga fora de escopo.

**Constraints**: `WALLET_LOCK_TIMEOUT_MS` 5000 < `DB_POOL_ACQUIRE_TIMEOUT_MS` 8000;
`HTTP_SERVER_TIMEOUT_MS` 20000 > 8000 + 5000 + 2000 (I-51, FR-059). Nenhum estado em memória como garantia
(constitution III, IV). Domínio sem `@nestjs` e sem `@mikro-orm` (constitution VI).

**Scale/Scope**: 6 endpoints, 4 tabelas, 4 migrations, 3 instâncias no profile `cluster`, pool de 25 conexões por
instância.

**Spike**: executado em 2026-11-07; S-01 a S-11 aprovados pelos seus critérios
([research.md §0](research.md#0-status-do-spike-obrigatório)). Os ajustes que ele trouxe estão aplicados neste
plan: execução sem build, `pg` e `@types/pg` fixados, timeout de aquisição pelo `pg.Pool` com teste próprio,
`SIGTERM` gracioso testável só em Linux e as convenções de [Implementação](#convenções-de-implementação)
(`tsconfig`, placeholders `?`, migrations sem snapshot e `DecimalType('string')`). Não há `NEEDS CLARIFICATION`
no contexto técnico.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Princípios

| # | Princípio | Como o plan atende | Pré | Pós |
|---|-----------|--------------------|-----|-----|
| I | Fontes da verdade e precedência | Decisões citam FR/I-xx. As interpretações novas surgidas no plan (redação do I-27, I-54 `BALANCE_LIMIT_EXCEEDED`, I-55 `TRANSACTION_NOT_FOUND`, I-56 idempotência por provedor, I-57 campos desconhecidos descartados e I-58 normalização só de `walletId` e `transactionId`) já estão registradas em `docs/interpretacoes.md` e propagadas para spec, data-model, research e tasks. Itens opcionais (carga, caos, UI) fora do escopo. | ✅ | ✅ |
| II | Correção financeira | `Money` sobre decimal.js, string com 2 casas (research R-03). `NUMERIC(18,2)` + moeda, lido como string (S-05). Conflito de moeda é erro de domínio e é testado. Ledger imutável por trigger. Um lançamento por movimento: `UNIQUE(wallet_id, transaction_id)` + trigger que exige transação PROCESSED que move saldo. Saldo ≥ 0 por `CHECK`. `wallet.balance` = cauda do ledger por constraint trigger diferido (data-model §2.5). Reconciliação é de outra feature. | ✅ | ✅ |
| III | Concorrência por wallet | `FOR UPDATE` só na linha da wallet, sem lock global (R-07). Nada de read → calculate → update sem controle: o cálculo acontece sob o lock, e o `UPDATE` tem `WHERE version = esperada`. Correção com 3 instâncias provada nos testes de concorrência (SC-005). Sem cache; EntityManager forkado por execução (R-05). | ✅ | ✅ |
| IV | Idempotência persistente e mensageria | Deduplicação só no banco: `UNIQUE(provider_id, idempotency_key)` (escopo por provedor, I-56) e `UNIQUE(provider_id, external_transaction_id)`, com caminho rápido, releitura sob lock e tratamento de `23505` pelo nome da constraint (R-08). Payload diferente → 409, nunca replay. Replay devolve o saldo observado gravado (I-26). Transação + saldo + ledger + outbox numa só transação SQL; nenhum evento é publicado (FR-048). HTTP é a única entrada nesta feature; o use case fica pronto para reuso pela fila. Inbox, publisher e DLQ: N/A nesta feature. | ✅ | ✅ |
| V | Invariantes no schema | `UNIQUE`, `CHECK`, índice único parcial de reversão (I-16), FKs compostas (moeda, wallet e valor do lançamento), triggers de imutabilidade, de transição de estado, de versão e de encadeamento (data-model §2). 4 migrations versionadas com `up` e `down`, testadas em `up → down → up`. Sem `schema:update`. | ✅ | ✅ |
| VI | Domínio encapsulado e portas | Construtores privados + factories; `rehydrate` sem revalidar. Transições explícitas com `InvalidTransactionStateError`. OPENING interno. EntitySchema + mappers, domínio sem ORM nem Nest. Portas `Clock`, `IdGenerator`, `Failpoints`, `ProviderIdentityPort`. `AuthGuard` no-op (I-41). Eventos como subclasses de `IntegrationEvent` com `MoneyProps`. | ✅ | ✅ |
| VII | Testes reais | Tudo com `bun test`. Unitários do domínio. Integração com PostgreSQL real (SQS não se aplica nesta feature). Concorrência com 3 processos reais e requisições paralelas. `assertWalletMatchesLedger` ao fim de todo teste. Matriz de testes abaixo. | ✅ | ✅ |
| VIII | Observabilidade e contrato de API | `failureCode` + `retryable` da taxonomia §7. Status distintos para as 5 situações (FR-055). Logs JSON com `correlationId`, `transactionId`, `walletId`, `providerId` (`messageId` só existe na fila), sem valores financeiros completos. Métricas e health checks: fora do escopo da spec; ficam para a feature de observabilidade, sem bloquear este gate. | ✅ | ✅ |
| IX | Documentação | README.md e ARCHITECTURE.md entram como tarefas desta feature, com o conteúdo mínimo listado em [Documentação](#documentação). | ✅ | ✅ |
| — | Stack | Bun, TS strict, NestJS, PostgreSQL, MikroORM, MikroORM Migrations, Docker Compose. SQS ausente por escopo (entra na feature de mensageria). | ✅ | ✅ |

### Falhas eliminatórias

| # | Falha | Como é evitada | Prova | Status |
|---|-------|----------------|-------|--------|
| 1 | `number` para dinheiro | `Money`/decimal.js em todas as camadas; Zod recusa número JSON; NUMERIC lido como string (S-05); nenhum `parseFloat`/`Number()` em valores (regra de revisão) | unitários de Money; integração lendo NUMERIC | ✅ |
| 2 | Saldo negativo por race | lock da wallet + cálculo sob lock + `CHECK (balance >= 0)` + `ledger_balance_after_ck` | SC-001 com 20 repetições e 3 instâncias | ✅ |
| 3 | Débito ou crédito duplicado | unicidade de (provedor, chave) e de (provedor, id externo); releitura sob lock; `UNIQUE(wallet_id, transaction_id)`; índice de reversão única | SC-002, SC-003 | ✅ |
| 4 | Idempotência só em memória | nenhuma estrutura em memória participa da decisão; fork de EntityManager por execução | revisão + SC-002 em 3 instâncias | ✅ |
| 5 | Correto só com uma instância | toda garantia vem do banco compartilhado | toda a suíte de concorrência roda com 3 processos | ✅ |
| 6 | Evento publicado antes do commit | não há publicação nesta feature; eventos só são inseridos na outbox dentro da transação | `atomicity.test.ts`: com failpoint, nenhuma linha na outbox | ✅ |
| 7 | Ledger não auditável | lançamentos imutáveis, encadeados, com saldo antes e depois; paginação estável | `schema-guards.test.ts`, `ledger-pagination.test.ts` | ✅ |
| 8 | Testes que trocam PG e SQS por mocks | integração e concorrência só com PostgreSQL real; SQS não existe nesta feature | estrutura de `test/` | ✅ |

**Resultado do gate**: aprovado antes e depois do design, sem violações. O spike foi executado e aprovado.

## Project Structure

### Documentation (this feature)

```text
specs/001-wagering-transaction-core/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── openapi.yaml
├── checklists/
│   └── requirements.md
├── review-checklist.md  # gate de Revisão da constitution (Princípios II a V), usado por T127 a T131
└── tasks.md             # gerado por /speckit-tasks
```

### Source Code (repository root)

```text
src/
├── main.ts                                   # bootstrap: reflect-metadata, timeouts HTTP (I-51), shutdown hooks
├── app.module.ts
├── platform/
│   ├── config/app-config.ts                  # leitura e validação de env, incluindo a hierarquia de timeouts
│   ├── correlation/correlation.middleware.ts # X-Correlation-Id → AsyncLocalStorage (I-53)
│   ├── correlation/request-context.ts
│   ├── http/global-exception.filter.ts       # envelope { error } e mapeamento de status (I-38, I-39, I-45)
│   ├── http/zod-validation.pipe.ts
│   ├── http/money.schema.ts                  # schemas Zod compartilhados: money, identificador 1–255, UUID (I-01, I-50, I-58)
│   ├── auth/noop-auth.guard.ts               # I-41
│   ├── auth/provider-identity.port.ts
│   ├── logging/json-logger.ts                # logger JSON + middleware de log de requisição
│   ├── failpoints/failpoints.ts              # I-40 (no-op em production); FAILPOINT=<nome>[:<modo>] (R-16)
│   └── persistence/
│       ├── entity-schemas.ts                 # lista dos EntitySchemas de todas as tabelas (R-04)
│       ├── mikro-orm.config.ts
│       ├── run-migrations.ts                 # up/down programático, usado por scripts/migrate.ts e pelo preload de testes
│       ├── orm.provider.ts                   # MikroORM.init + fork por execução (R-05)
│       ├── unit-of-work.ts                   # transactional + SET LOCAL lock_timeout
│       └── pg-errors.ts                      # SQLSTATE/constraint → erro de aplicação (R-12)
├── shared-kernel/
│   ├── domain/money.ts
│   ├── domain/clock.port.ts
│   ├── domain/id-generator.port.ts
│   ├── domain/integration-event.ts           # IntegrationEvent<T>, IntegrationEventProps, EventContext
│   ├── domain/errors.ts                      # erros de domínio
│   ├── application/errors.ts                 # erros de aplicação (código, retryable, details), mapeados pelo filtro
│   └── infrastructure/{system-clock.ts, uuidv7-id-generator.ts}
├── wallets/
│   ├── domain/{wallet.ts, wallet-ledger-entry.ts, ledger-direction.ts}
│   ├── domain/events/wallet-balance-changed.event.ts
│   ├── application/{create-wallet.use-case.ts, get-wallet.use-case.ts, list-ledger.use-case.ts, ledger-cursor.ts}
│   ├── infrastructure/{wallet.schema.ts, ledger-entry.schema.ts, wallet.mapper.ts, ledger-entry.mapper.ts,
│   │                   mikro-orm-wallet.repository.ts, mikro-orm-ledger.repository.ts}
│   ├── interfaces/http/{wallets.controller.ts, wallet.dto.ts}
│   └── wallets.module.ts                     # módulo Nest do contexto (providers por token, R-02)
├── wagering/
│   ├── domain/{wager-transaction.ts, failure-code.ts, wager-rules.service.ts}
│   ├── domain/events/{wager-transaction-processed.event.ts, wager-transaction-rejected.event.ts,
│   │                  wager-transaction-pending-reference.event.ts}
│   ├── application/{submit-wager-transaction.use-case.ts, payload-hash.ts, canonical-json.ts,
│   │                get-transaction.use-case.ts, transaction-result.ts}
│   ├── infrastructure/{wager-transaction.schema.ts, wager-transaction.mapper.ts,
│   │                   mikro-orm-wager-transaction.repository.ts}
│   ├── interfaces/http/{wagering.controller.ts, providers.controller.ts, wager-transaction.dto.ts}
│   └── wagering.module.ts                    # módulo Nest do contexto (providers por token, R-02)
└── outbox/
    ├── domain/outbox-message.ts
    └── infrastructure/{outbox-message.schema.ts, outbox-message.mapper.ts, mikro-orm-outbox.writer.ts}

migrations/
├── Migration20261107000100.ts                # wallets, wager_transactions
├── Migration20261107000200.ts                # wallet_ledger_entries
├── Migration20261107000300.ts                # outbox_messages
└── Migration20261107000400.ts                # funções e triggers de guarda
scripts/migrate.ts                            # up | down via API programática (S-08)

test/
├── unit/{money, integration-event, outbox-message, app-config, correlation, json-logger, failpoints,
│         pg-errors, global-exception-filter, zod-validation-pipe, unit-of-work, uuidv7-id-generator, wallet,
│         wallet-ledger-entry, wager-transaction, failure-code, wager-rules, payload-hash, wager-transaction-dto,
│         ledger-cursor, conventions}.test.ts
├── integration/{migrations, schema-guards, platform-smoke, deadlock, create-wallet, submit-transaction,
│                money-columns, atomicity, transaction-retry, idempotency, win-loss, reversals, pending-reference,
│                http-contract, correlation-id, db-unavailable, pool-acquire-timeout, queries,
│                ledger-pagination}.test.ts
├── concurrency/{concurrent-wallet-creation, hot-wallet-race, wallet-isolation, lock-timeout, pool-pressure,
│                idempotent-burst, idempotency-race, reversal-race, crash-recovery}.test.ts
└── support/{db.ts, db-setup.preload.ts, test-database.ts, assert-wallet-matches-ledger.ts, app-harness.ts,
             instance-cluster.ts, factories.ts, fakes.ts, http.ts, wagering.ts, tcp-proxy.ts}

docs/{enunciado.md, interpretacoes.md}
docker-compose.yml · Dockerfile · .env.example · .gitignore · bunfig.toml · tsconfig.json · package.json ·
bun.lock · README.md · ARCHITECTURE.md (na raiz, como pedem o enunciado §14 e a constitution IX)
```

**Structure Decision**: projeto único com módulos por contexto (`wallets`, `wagering`, `outbox`), cada um com
`domain` → `application` → `infrastructure` / `interfaces`. `platform` concentra as preocupações transversais e
`shared-kernel` o que o domínio compartilha. Dependências só apontam para dentro: `domain` importa só `domain` (de
qualquer módulo, ex.: `wagering/domain` usa `Wallet` e `LedgerDirection` de `wallets/domain`),
`shared-kernel/domain` e o pacote `decimal.js` (o tipo decimal exato sobre o qual o `Money` é construído, R-03);
nunca `application`, `infrastructure`, `interfaces`, `platform`, `@nestjs`, `@mikro-orm` nem outro pacote externo.
Verificado pelo T118.

## Design

### Submissão de transação (`SubmitWagerTransactionUseCase`)

Ordem de avaliação do I-44 / FR-015, decisões em research R-06 a R-10:

1. **Header** `Idempotency-Key`: ausente ou vazio → 400 `IDEMPOTENCY_KEY_REQUIRED`; mais de 255 caracteres → 400
   `VALIDATION_ERROR` (I-48).
2. **Payload** (Zod): formatos (I-01, I-03, I-05, I-50), kind (OPENING → `OPENING_NOT_ALLOWED`, I-08), providerId
   "system" (I-07), referência por kind (I-13), zero só em LOSS (I-02). Normaliza `amount` e o UUID; calcula o
   `payloadHash` (I-25, R-09).
3. **Caminho rápido** sem lock: **uma única consulta**, num só snapshot, por `(provider, chave)` OU
   `(provider, externalId)` → replay ou 409 (FR-033, FR-034, I-56). Duas consultas separadas podiam ver estados
   diferentes (a primeira antes do commit da concorrente, a segunda depois) e devolver 409 a uma requisição
   idêntica: 5 de 50 respostas no teste de 50 envios paralelos (research R-08).
4. **Wallet** inexistente → 404 `WALLET_NOT_FOUND`, sem persistir (I-20).
5. **Transação SQL** (data-model §3). Toda query aqui usa o EntityManager da transação, nunca outra conexão do
   pool (research R-19):
   - `lock_timeout`, `FOR UPDATE` da wallet e releitura da idempotência pela mesma consulta única por
     `(provider, chave)` OU `(provider, externalId)`;
   - carga da referência e checagem de reversão existente;
   - `WagerRulesService.decide`;
   - `INSERT` da transação no status final, `UPDATE` da wallet com asserção de versão, `INSERT` do lançamento e
     dos eventos;
   - failpoint `after_ledger_insert_before_commit`;
   - `COMMIT`.
6. **Conflito tardio** `23505` em `wager_tx_provider_idempotency_uq` ou `wager_tx_provider_external_uq` →
   releitura fora da transação, pela mesma consulta única num fork novo → replay ou 409 (R-08). `23505` do
   índice de reversão → repetir 1 vez (R-12).
7. **Resposta** (FR-054, FR-055, I-45): 201, 202 ou 422 com `TransactionResult`; replay com 200, 202 ou 422 e
   `idempotentReplay` true. Failpoint `after_commit_before_response` antes de responder.

Invariante de projeto: **toda escrita que muda saldo ou status de transação de uma wallet acontece com essa
wallet travada.** A referência de outra wallet só é lida, e só por atributos imutáveis (player, wallet, moeda,
rodada), então essa leitura não precisa de lock.

### Criação de wallet (`CreateWalletUseCase`)

Numa transação: `INSERT` da wallet (version 1, saldo inicial). Se o saldo for maior que zero, também a transação
OPENING com a identidade do I-07 (criada PENDING e marcada PROCESSED em memória), o lançamento CREDIT
(antes 0.00) e o `WalletBalanceChanged` (I-06, I-09). Saldo "0.00" não gera nada além da wallet (FR-046).

Se der `23505` em `wallets_player_currency_uq`: rollback, leitura do id existente fora da transação (a vencedora
já está confirmada, porque o PostgreSQL só reporta a violação depois que a concorrente decide) e resposta 409
`WALLET_ALREADY_EXISTS` com `details.walletId` (I-52).

### Consultas

- `GET /wallets/:id` → `Wallet` (FR-049).
- `GET /wallets/:id/ledger`: `WHERE wallet_id = ? AND seq > ? ORDER BY seq LIMIT ?`, com parâmetros walletId,
  cursor decodificado (0 sem cursor) e `limit + 1`; o item extra define `nextCursor`.
  - O cursor é o base64url do `seq` em texto decimal.
  - Cursor inválido é o que não decodifica, não é inteiro de 1 a 19 dígitos ou excede o maior `bigint`; ele e
    `limit` fora de 1 a 200 → 400 (I-36, I-47).
  - Wallet inexistente → 404.
- `GET /wagering/transactions/:id` e `GET /providers/:p/wagering/transactions/:x` → `Transaction`, sempre com
  status 200 quando a transação existe. Senão 404 `TRANSACTION_NOT_FOUND` (I-55). Na rota
  por provedor, providerId "system" → 400 (I-07).

Todas as leituras usam um EntityManager forkado e não abrem transação de escrita.

### HTTP, erros e correlationId

- Controllers finos. Pipe Zod explícito. `GlobalExceptionFilter` converte erros de aplicação e de infraestrutura
  no envelope `{ error }` (I-38) com o status do FR-055. Os 503 levam `Retry-After` (I-34).
- O resultado de negócio (201, 200, 202, 422) é montado pelo controller a partir de `TransactionResult`, sem
  passar pelo filtro (I-45).
- O middleware de correlationId roda antes de tudo, inclusive antes da validação, e nunca rejeita (I-53, FR-060).
  O logger JSON registra uma linha por requisição: método, rota, status, duração e os ids do contexto, sem
  valores monetários (FR-058).

### Convenções de implementação

Vindas do spike (research §0.3):

- **`tsconfig.json`**: `strict: true`, `noUncheckedIndexedAccess: true`, `experimentalDecorators: true`,
  `emitDecoratorMetadata: false`, `module: "Preserve"`, `moduleResolution: "bundler"`,
  `allowImportingTsExtensions: true` (imports com `.ts`; exige `noEmit: true`, que o `typecheck` já usa, e o Bun
  executa o fonte direto), `types: ["bun"]`, `skipLibCheck: true`.
- **SQL escrito à mão** (`em.execute`, `Migration.execute`, query builder com fragmentos crus): placeholders `?`
  com parâmetros, nunca `$1` e nunca valores concatenados. Única exceção: `SET LOCAL lock_timeout`, que não
  aceita parâmetro e recebe o inteiro de `WALLET_LOCK_TIMEOUT_MS` validado no boot (data-model §3).
- **Migrations**: registradas por `migrationsList`, com `snapshot: false` e `snapshotOnMigrate: false`, para o
  MikroORM 7 não gravar arquivos de snapshot. `migrate:down` desfaz todas (`migrator.down({ to: 0 })`)
  (data-model §2.6).
- **Dinheiro no ORM**: toda coluna monetária do `EntitySchema` usa `new DecimalType('string')` com
  `precision: 18, scale: 2`: `wallets.balance`, `wager_transactions.amount` e `observed_balance`,
  `wallet_ledger_entries.amount`, `balance_before` e `balance_after` (data-model §2). Provado pelo teste
  `money-columns`.

### Concorrência e timeouts

Hierarquia e pool em research R-11; mapeamento de erros em R-12. A app só responde 5xx depois do rollback. Nunca
há timeout de requisição na aplicação, porque um 503 com a transação ainda viva mentiria sobre "sem efeito".

- **Timeout de aquisição do pool**: `DB_POOL_ACQUIRE_TIMEOUT_MS` é passado em
  `driverOptions.connectionTimeoutMillis` do `pg.Pool`, porque o `PoolConfig` do MikroORM 7 não tem essa opção
  (spike S-09). O erro chega como `DriverException` sem SQLSTATE, com a mensagem
  `timeout exceeded when trying to connect`, e é o único caso que o classificador `pg-errors.ts` identifica por
  mensagem; vira 503 `SERVICE_UNAVAILABLE`. O `lock_timeout` é classificado pelo `code` `55P03` (S-06).
- **Regra do EntityManager** (research R-19): dentro de `transactional()`, toda query usa o EntityManager da
  transação, nunca outra conexão do pool. Os repositórios recebem o EM da execução em cada chamada. Provado
  pelo teste `pool-pressure`.

### Deploy local

O `docker-compose.yml` tem três serviços padrão e dois no profile `cluster` (research R-18):

- `postgres`, com healthcheck;
- `migrate`, que roda `bun run migrate:up` e depende do postgres saudável;
- `app1`, na porta 3001, que depende do `migrate` concluído com sucesso;
- `app2` e `app3`, nas portas 3002 e 3003, no profile `cluster`.

O `Dockerfile` parte de `oven/bun:1.4.4`, roda `bun install --frozen-lockfile --production` e executa
`bun src/main.ts`. **Não há etapa de build**: o Bun executa o TypeScript direto. O spike mostrou que `bun build`
só funciona com `--packages external`, que mantém `node_modules` na imagem de qualquer forma (research R-18).

O encerramento gracioso por `SIGTERM` (shutdown hooks do Nest) só é verificável em Linux, como no container. No
Windows, o `SIGTERM` enviado pelo harness vira término forçado (saída 143, spike S-10). Nenhum teste desta
feature depende de encerramento gracioso; o teste de `SIGTERM` da feature de mensageria deve rodar no container.

Scripts do `package.json`:

| Script | Comando |
|--------|---------|
| `dev` | `bun --watch src/main.ts` |
| `start` | `bun src/main.ts` |
| `typecheck` | `tsc --noEmit` |
| `migrate:up` | `bun scripts/migrate.ts up` |
| `migrate:down` | `bun scripts/migrate.ts down` (desfaz todas: `migrator.down({ to: 0 })`) |
| `test:unit` | `bun test test/unit` |
| `test:integration` | `bun test --preload ./test/support/db-setup.preload.ts test/integration` |
| `test:concurrency` | idem, com `test/concurrency` |
| `test` | os três em sequência |

### Matriz de testes

| Área | Testes | Requisitos |
|------|--------|------------|
| Money | formato do I-01 (válidos, normalização, inválidos, número JSON), limite do I-03, sem arredondamento implícito (`0.10 + 0.20 = 0.30`), conflito BRL × USD, imutabilidade | FR-001 a FR-004 |
| Wallet / ledger | open (version 1), debit/credit (version +1, lançamento coerente), saldo negativo recusado, aritmética do `WalletLedgerEntry.create` | FR-005, FR-009, FR-029 |
| WagerTransaction | todas as transições válidas e inválidas do I-11, inclusive `fail()` e tentativa em estado terminal, `requiresReference`, `affectsBalance`, `ledgerDirectionFor` | FR-028, I-11, I-12 |
| WagerRulesService | cada código do I-44 isolado e combinações que provam a precedência (ex.: referência pendente com rodada diferente → `REFERENCE_MISMATCH`; REFUND com valor errado e referência pendente → `AMOUNT_MISMATCH`); crédito no limite (`9999999999999990.00` + `10.00` → `BALANCE_LIMIT_EXCEEDED`; `+ 9.99` → aplica) | FR-015 a FR-027, FR-061, I-44, I-46, I-54 |
| Idempotência | replay com o status do original (201 → 200); mesma chave do mesmo provedor com payload diferente → 409; mesmo (provedor, id externo) com outra chave → 409; **dois provedores com a mesma `Idempotency-Key` e ids externos diferentes → as duas processadas (201 e 201), sem conflito** | FR-032 a FR-035, I-24, I-26, I-56 |
| Hash | ordem de chaves irrelevante; "0" e "0.00" de LOSS → mesmo hash; "25" e "25.00" → mesmo hash; referência ausente omitida; campos fora do hash e campos desconhecidos não alteram o resultado (I-57); `walletId` em maiúsculas e minúsculas → mesmo hash, os demais ids com caixa diferente → hash diferente (I-58) | FR-031, I-25, I-57, I-58 |
| Corrida de idempotência (`idempotency-race`) | a mesma `Idempotency-Key` em paralelo (a) com payloads diferentes na mesma wallet e (b) com `walletId` diferentes, que provoca o `23505` e a releitura depois do rollback; 1 efeito, mesmo hash → replay, o resto → 409, nenhum 500 ou 503 | FR-034, FR-035, I-27, I-56, R-08 |
| Config | recusa de boot quando a hierarquia de timeouts é violada | FR-059, I-51 |
| Unit of work e deadlock | unitário: `40P01` e `40001` executados 3 vezes e depois `ServiceUnavailableError`, sucesso na repetição, sem repetição para os outros erros; integração (`deadlock`): deadlock real com duas transações em SQL cru travando duas linhas em ordem oposta, o `40P01` chega ao `pg-errors` (por `pg` e pelo MikroORM) e é classificado como `retry`; integração (`transaction-retry`): `40001` na 1ª passagem, via failpoint, termina com um só efeito (transação, ids e eventos novos por tentativa) | R-12, gate de Tasks |
| Migrations pelo script | `bun scripts/migrate.ts up` e `down` via `Bun.spawn`, código de saída 0 e ≠ 0 com `DATABASE_URL` inválida | constitution V, S-08 |
| Eventos (payload e ordem) | em cada evento gravado: `eventId` = `id` da outbox, `aggregateId` = `walletId`, `correlationId`, `occurredAt` ISO-8601, `eventType`, `version` 1 e dinheiro como string; `WalletBalanceChanged` gravado antes do evento de status | FR-045 a FR-047, I-33 |
| Logs da requisição | as linhas JSON da requisição trazem `correlationId`, `walletId`, `providerId` e `transactionId` assim que conhecidos, e nunca `amount`/`money` | constitution VIII, FR-058, FR-060 |
| Migrations / schema | `up → down → up`; cada `CHECK`, `UNIQUE`, FK composta e trigger da data-model §2, exercitados por SQL direto; nenhum arquivo de snapshot gerado no repositório depois de `up` e `down` | constitution V, SC-008 |
| Colunas de dinheiro (`money-columns`) | Grava pelos use cases reais (criação de wallet e submissão), que já satisfazem constraints e triggers, e cobre `9999999999999999.99` e `0.10` em cada coluna. **Wallet A**: aberta com `9999999999999999.99` (`wallets.balance`, `amount` e `observed_balance` da abertura, `amount` e `balance_after` do lançamento) e depois uma BET de `0.10` (`balance_before` = máximo; `amount` da transação e do lançamento = `0.10`). **Wallet B**: aberta com `0.10` (saldo, `amount`, `observed_balance` e `balance_after` = `0.10`) e depois uma BET de `0.10` (`balance_before` = `0.10`). Relê cada linha com `em.findOneOrFail` das entidades mapeadas num fork novo (sem identity map) e confere, para cada coluna e valor: `typeof` é `"string"`, o texto é idêntico ao esperado (`toBe`, sem conversão) e `Money.from` reidrata o mesmo valor. Confere também por SQL cru com `?` que o banco guardou exatamente o valor. Nada de desligar triggers | FR-003, I-03, I-04, constitution II |
| Atomicidade | failpoint entre ledger e commit → nenhuma linha nova em transações, ledger e outbox; wallet intacta; reenvio processa 1 vez | FR-040, SC-007 |
| HTTP | os 5 tipos de situação com status e corpo; todos os edge cases da spec; replay com o status do original; 409 com walletId; correlationId válido, inválido e ausente; tempo < 1 s | FR-054 a FR-060, SC-009, SC-011 |
| Indisponibilidade | proxy TCP derrubado → 503 + Retry-After, sem efeito; reenvio após restaurar → 1 efeito | FR-043, US9 |
| Timeout de aquisição do pool | app em processo com `DB_POOL_MAX=1`, `WALLET_LOCK_TIMEOUT_MS=200`, `DB_POOL_ACQUIRE_TIMEOUT_MS=500` e `HTTP_SERVER_TIMEOUT_MS=3000` (a hierarquia continua válida); a única conexão é ocupada por um `pg_sleep` pelo handle in-process do ORM exposto pelo `app-harness`, **sem endpoint de teste e sem failpoint** (nada novo em produção; os failpoints da feature são no-op em `NODE_ENV=production`, I-40); a submissão → 503 `SERVICE_UNAVAILABLE` + Retry-After em ~500 ms, sem efeito; reenvio após liberar → 1 efeito | FR-043, FR-059, I-51, S-09 |
| Isolamento de testes | cada arquivo roda num banco clonado do template; `TRUNCATE` e `DELETE` são proibidos como limpeza de dados, e só `schema-guards.test.ts` e `migrations.test.ts` (lista de permitidos) podem escrevê-los, inline em `expect(...).rejects`, para provar que as guardas recusam; `session_replication_role` e `DISABLE TRIGGER` são proibidos em qualquer arquivo. Verificado automaticamente por `test/unit/conventions.test.ts` | constitution V, VII |
| Guardrails de código (`conventions`) | varredura estática com arquivo e linha de cada violação, e autoteste de cada regra com exemplos que passam e que falham: (a) as regras de limpeza acima; (b) em `test/integration` e `test/concurrency`, nenhum `mock(`, `jest.`, `spyOn` em repositório, ORM, EntityManager, pool ou cliente de banco, nem banco em memória (`pg-mem`, `bun:sqlite`, `:memory:`, `InMemory*Repository`); (c) em `src/`, nenhum `$1`, nenhum `parseFloat(` e nenhum `Number(` em `amount` ou `balance`, e nenhuma rota de teste; (d) em `src/**/domain`, imports só de `src/**/domain`, `src/shared-kernel/domain` e do pacote `decimal.js` (nunca `application`, `infrastructure`, `interfaces`, `platform`, `@nestjs`, `@mikro-orm` ou outro pacote externo); (e) em `src/**/domain` e `src/**/application`, nenhum `new Date()` sem argumento, `Date.now(`, `randomUUID(` ou `randomUUIDv7(` (`new Date(x)` com argumento é permitido) | constitution II, VI, VII; falhas eliminatórias 1 e 8 |
| Revisão (gate da constitution) | diff de cada história crítica e da feature inteira revisado contra `review-checklist.md` (T127 a T131), com resultado item a item | constitution, gate de Revisão (Princípios II a V) |
| Concorrência (3 processos) | 100/80/80 ×20; mesma BET 50× (1 débito, 50 respostas com o mesmo id, nenhum 409/500/503); REFUND × ROLLBACK ×20; 20 wallets em paralelo; lock segurado em A não atrasa B; 10 criações simultâneas → 1 wallet e 9 × 409 com o mesmo walletId; lock timeout → 503 sem efeito; crash depois do commit → reenvio vira replay; **`pool-pressure`: 3 instâncias com `DB_POOL_MAX=5`, 100 requisições paralelas na mesma wallet → nenhum 503**, saldo e ledger corretos | SC-001 a SC-007, FR-059, I-52, R-19 |
| Invariante final | `assertWalletMatchesLedger` em todas as wallets tocadas | SC-006 |

### Documentação

- `README.md`: pré-requisitos, `bun install`, Compose (padrão e `cluster`), variáveis de ambiente, migrations,
  todos os scripts de teste e exemplos do quickstart, com link para o `ARCHITECTURE.md` da raiz e para
  `docs/interpretacoes.md`.
- `ARCHITECTURE.md`, **na raiz do repositório** (enunciado §14, constitution IX), iniciado nesta feature:
  - justificativa do MikroORM, com EntitySchema, mappers e escritas explícitas (R-04 a R-06);
  - mapeamento do Money (R-03, I-04);
  - estratégia transacional e de concorrência (R-07, R-08) e hierarquia de timeouts (R-11);
  - `payloadHash` (I-25);
  - máquina de estados (I-11);
  - taxonomia de `failureCode` e mapeamento HTTP (I-39, I-45);
  - triggers de guarda;
  - autenticação: guard no-op e desenho com Keycloak (I-41);
  - **política de retry, DLQ e PENDING_REFERENCE** (constitution IX):
    - **retry**: falha transitória → 503 `SERVICE_UNAVAILABLE` com `Retry-After`, sem efeito, e o reenvio é seguro
      por idempotência; deadlock (`40P01`) e falha de serialização (`40001`) são repetidos internamente até 2
      vezes antes do 503 (R-12);
    - **PENDING_REFERENCE**: nesta feature, só o agendamento inicial (`next_reference_attempt_at` = criação + 5 s,
      I-21); o worker com backoff, limite e `REFERENCE_NOT_FOUND` fica para a feature 2;
    - **DLQ**: fora do escopo desta feature, que não consome fila; prevista para a feature de mensageria (I-30);
  - limitações: pool sob wallet muito disputada; sem balanceador no Compose; sem métricas e sem health nesta
    feature; encerramento gracioso por `SIGTERM` só verificável em Linux (também no README, como limitação de
    ambiente de desenvolvimento no Windows).

## Pendências de decisão

Resolvidas em 2026-11-07 e registradas em `docs/interpretacoes.md`:

- **I-27** (redação ajustada): `INSERT` simples com tratamento da violação de unicidade pelo nome da constraint e
  releitura depois do rollback (research R-08).
- **I-54**: crédito que levaria o saldo acima de 9999999999999999.99 → REJECTED `BALANCE_LIMIT_EXCEEDED` (422,
  `retryable` false, GIVE_UP), no último passo do I-44 (FR-061).
- **I-55**: `TRANSACTION_NOT_FOUND` (404, `retryable` false) nas duas consultas de transação (FR-053).

- **I-56**: idempotência escopada por provedor, `UNIQUE(provider_id, idempotency_key)` (R-08).
- **I-57**: campos desconhecidos no corpo (HTTP e fila) são descartados, sem 400 e fora do `payloadHash` (R-13).
- **I-58**: só `walletId` e `transactionId` são normalizados para minúsculas; os demais ids são case-sensitive
  (R-09, R-13).

Spike: executado e aprovado em 2026-11-07 (research §0). Todos os ajustes do research §0.3 estão aplicados neste
plan e na data-model.

Nenhuma pendência em aberto.

## Complexity Tracking

Nenhuma violação da constitution. Itens acima do mínimo, mantidos por reforçarem invariantes avaliadas:

| Item | Por que existe | Alternativa mais simples rejeitada |
|------|----------------|------------------------------------|
| Triggers de encadeamento do ledger e de "saldo = cauda do ledger" (diferido) | põem a invariante saldo = ledger (FR-042) no banco, não só no código (constitution V) | só o teste `assertWalletMatchesLedger`: pega o erro depois que ele acontece, não impede |
| FKs compostas no ledger (moeda, wallet e valor) | impedem lançamento em moeda, wallet ou valor diferente do da transação | `CHECK` local não alcança outra tabela |
| Caminho rápido de idempotência fora do lock | replays não disputam o lock da wallet nem atrasam a fila do SC-002 | só a releitura sob lock: correta, mas serializa todo replay |
