---

description: "Tasks da feature 001-wagering-transaction-core"
---

# Tasks: Núcleo Transacional de Apostas

**Input**: documentos de design em `/specs/001-wagering-transaction-core/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md),
[contracts/openapi.yaml](contracts/openapi.yaml), [quickstart.md](quickstart.md)

**Tests**: obrigatórios. O gate de Tasks da constitution exige teste para toda task de comportamento, e o Princípio
VII exige PostgreSQL real, paralelismo real e `assertWalletMatchesLedger` ao fim de todo teste que toca wallet.
Testes de domínio puro vêm antes da implementação; testes de integração e de concorrência de cada história são
escritos antes e precisam **falhar** antes da implementação.

**Spike**: já executado e aprovado (research §0); não há task de spike. A remoção de `spike/` está na fase final.

**Organization**: uma fase por user story, na ordem da spec: US1, US2 e US3 (P1); US4, US5, US6, US7 e US9 (P2);
US8 (P3).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: pode rodar em paralelo (arquivo diferente, sem dependência de task incompleta)
- **[Story]**: história da spec (US1 … US9)
- Toda task cita o arquivo e os FR, I-xx e SC que cobre

## Convenções valendo em todas as tasks

Do plan, "Convenções de implementação", e do research:

- **SQL escrito à mão**: placeholders `?` com parâmetros, nunca `$1` nem concatenação; única exceção é o
  `SET LOCAL lock_timeout`.
- **Dentro de `transactional()`**: só o EntityManager da transação (R-19). Os repositórios recebem o EM em cada
  chamada.
- **Dinheiro**: `Money` no domínio; `new DecimalType('string')` em toda coluna monetária; nunca `number`,
  `parseFloat` ou `Number()`.
- **Domínio**: `src/**/domain` não importa `@nestjs` nem `@mikro-orm`; construtores `private` com factories, e
  `rehydrate` sem revalidar transições.
- **Injeção**: só por `@Inject(TOKEN)`, sem `emitDecoratorMetadata`.
- **Banco nos testes**: cada arquivo de teste usa o próprio banco (`test/support/test-database.ts`). É proibido
  usar `TRUNCATE` ou `DELETE` como limpeza de dados, e `session_replication_role` ou `DISABLE TRIGGER` em
  qualquer caso. Só `schema-guards.test.ts` e `migrations.test.ts` podem escrever `TRUNCATE` ou `DELETE`, e só
  dentro de `expect(...).rejects`, para provar que as guardas recusam. Verificado pelo T118.
- **Sem mocks em integração e concorrência**: nenhum `mock(`, `jest.`, `spyOn` em repositório ou banco, nem banco
  em memória (T118).
- **Invariante final**: todo teste de integração e de concorrência que toca wallet termina com
  `assertWalletMatchesLedger` (SC-006).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: scaffold do projeto com as versões validadas no spike.

- [X] T001 Criar `package.json` com versões **exatas** (sem `^`/`~`, research §1) e instalar com `bun install`, gerando `bun.lock`:
  - **dependências**: `@nestjs/core`, `@nestjs/common` e `@nestjs/platform-express` 12.2.0; `@mikro-orm/core`, `@mikro-orm/postgresql` e `@mikro-orm/migrations` 7.2.5; `decimal.js` 10.6.0; `zod` 4.6.7; `reflect-metadata` 0.2.2; `rxjs` 7.8.2; `pg` 8.23.1;
  - **dev**: `typescript` 7.0.2, `@types/bun` 1.4.4, `@types/pg` 8.23.1;
  - **scripts** (plan, "Deploy local"): `dev`=`bun --watch src/main.ts`, `start`=`bun src/main.ts`, `typecheck`=`tsc --noEmit`, `migrate:up`=`bun scripts/migrate.ts up`, `migrate:down`=`bun scripts/migrate.ts down`, `test:unit`=`bun test test/unit`, `test:integration`=`bun test --preload ./test/support/db-setup.preload.ts test/integration`, `test:concurrency`=`bun test --preload ./test/support/db-setup.preload.ts test/concurrency`, `test`=os três em sequência;
  - sem script `build` (R-18).
- [X] T002 [P] Criar `tsconfig.json` com: `strict: true`, `noUncheckedIndexedAccess: true`, `experimentalDecorators: true`, `emitDecoratorMetadata: false`, `useDefineForClassFields: false`, `module: "Preserve"`, `moduleResolution: "bundler"`, `allowImportingTsExtensions: true`, `noEmit: true`, `types: ["bun"]`, `skipLibCheck: true`, `target`/`lib` `ES2023`, `include: ["src", "test", "scripts", "migrations"]` (plan, "Convenções de implementação"; spike S-11)
- [X] T003 [P] Criar `bunfig.toml` com timeout padrão de teste de 60 s em `[test]`, sem preload global; o preload de banco é só dos scripts de integração e de concorrência (R-17)
- [X] T004 [P] Criar `.gitignore` com `node_modules/`, `.env`, `coverage/`, `*.log` e `dist/`
- [X] T005 [P] Criar `.env.example` com os padrões do research R-11 e o banco do Compose: `DATABASE_URL=postgresql://junglegaming:junglegaming@localhost:5432/junglegaming`, `TEST_DATABASE_ADMIN_URL=postgresql://junglegaming:junglegaming@localhost:5432/postgres`, `PORT=3001`, `WALLET_LOCK_TIMEOUT_MS=5000`, `DB_POOL_MAX=25`, `DB_POOL_ACQUIRE_TIMEOUT_MS=8000`, `HTTP_SERVER_TIMEOUT_MS=20000`, `RETRY_AFTER_SECONDS=1`, `FAILPOINT=` e `NODE_ENV=development` (I-40, I-51)
- [X] T006 [P] Criar `Dockerfile` a partir de `oven/bun:1.4.4`: copiar `package.json` e `bun.lock`, rodar `bun install --frozen-lockfile --production`, copiar `src/`, `migrations/` e `scripts/`, e usar `CMD ["bun", "src/main.ts"]`, sem etapa de build (R-18)
- [X] T007 [P] Criar `docker-compose.yml` (R-18):
  - `postgres` (`postgres:17-alpine`, usuário, senha e banco `junglegaming`, porta 5432, healthcheck `pg_isready`);
  - `migrate` (build do Dockerfile, `command: bun run migrate:up`, `depends_on: postgres: service_healthy`);
  - `app1` (porta 3001, `depends_on: migrate: service_completed_successfully`);
  - profile `cluster` com `app2` e `app3` (portas 3002 e 3003);
  - variáveis de ambiente lidas do `.env.example`.

**Checkpoint**: `docker compose up -d postgres` sobe saudável e `bun install --frozen-lockfile` funciona.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: shared-kernel, platform, persistência, migrations e infraestrutura de teste.

**⚠️ CRITICAL**: nenhuma user story começa antes desta fase terminar.

### Testes de domínio e plataforma (escrever primeiro; devem falhar)

- [X] T008 [P] Escrever `test/unit/money.test.ts` (FR-001 a FR-004, I-01, I-03, I-05):
  - **entradas válidas e normalização**: "0", "25", "25.5", "25.50", "9999999999999999.99", normalizadas para 2 casas;
  - **entradas inválidas** (`InvalidMoneyError`): "25.001", "-1", " 1", "1e3", "NaN", "Infinity", "" e acima de 9999999999999999.99;
  - **regex de entrada**: `^(0|[1-9]\d*)(\.\d{1,2})?$`;
  - **moeda**: fora de `^[A-Z]{3}$` é recusada;
  - **valor não-string**: `Money.from` com `amount` não-string lança erro;
  - **sem arredondamento**: `0.10 + 0.20 = "0.30"` exato;
  - **operações**: `add` e `subtract` entre BRL e USD lançam `CurrencyMismatchError`; `negate`, `isZero`, `isPositive`, `isNegative`, `isLessThan`, `equals`; imutabilidade (operações devolvem nova instância); `toJSON()` → `{ amount: "x.yy", currency }`.
- [X] T009 [P] Escrever `test/unit/integration-event.test.ts`: uma subclasse de teste de `IntegrationEvent<T>` serializa em `toJSON()` com `eventId`, `eventType`, `aggregateId`, `correlationId`, `causationId?`, `occurredAt` em ISO-8601, `version` e `data` (enunciado §11, FR-047)
- [X] T010 [P] Escrever `test/unit/outbox-message.test.ts`: `OutboxMessage.enqueue(event)` com `id` = `eventId`, `payload` = `toJSON()`, `attempts` 0, `nextAttemptAt` = `occurredAt`, não publicado; `isPending`, `isDue(now)`, `markPublished(at)`, `scheduleRetry(now)` (attempts + 1 e backoff); `rehydrate` (enunciado §6.5, data-model §1)
- [X] T011 [P] Escrever `test/unit/app-config.test.ts`: lê e valida as variáveis do T005; recusa (lança erro) quando `DB_POOL_ACQUIRE_TIMEOUT_MS <= WALLET_LOCK_TIMEOUT_MS` ou `HTTP_SERVER_TIMEOUT_MS <= DB_POOL_ACQUIRE_TIMEOUT_MS + WALLET_LOCK_TIMEOUT_MS + 2000`; recusa `WALLET_LOCK_TIMEOUT_MS` que não seja inteiro positivo, porque é interpolado no `SET LOCAL` (FR-059, I-51, R-11)
- [X] T012 [P] Escrever `test/unit/correlation.test.ts` para `resolveCorrelationId(header)` (I-53, FR-060):
  - devolve o header quando ele tem 1 a 128 caracteres em `[A-Za-z0-9._:-]`;
  - devolve um UUIDv7 gerado quando o header está ausente, vazio, tem 129 ou mais caracteres, tem espaço ou caractere fora do conjunto, ou vem como array;
  - nunca lança erro.
- [X] T013 [P] Escrever `test/unit/json-logger.test.ts`: cada linha é JSON com `level`, `msg`, `time`, `correlationId`, `transactionId`, `walletId` e `providerId` do contexto de requisição quando presentes; valores monetários (`amount`, `money`, `balance`) passados em campos extras são removidos (FR-058, constitution VIII)
- [X] T014 [P] Escrever `test/unit/failpoints.test.ts`: com `FAILPOINT=after_ledger_insert_before_commit`, `hit()` desse nome lança `FailpointError`; `after_commit_before_response` chama o `exit` injetado; outros nomes não fazem nada; com `NODE_ENV=production` nenhum failpoint dispara (I-40, R-16)
- [X] T015 [P] Escrever `test/unit/pg-errors.test.ts` cobrindo a tabela do research R-12, com erros construídos no formato observado no spike:
  - **503 `SERVICE_UNAVAILABLE`**: `DriverException` sem `code` com a mensagem `timeout exceeded when trying to connect`; `code` `55P03`; classe `08`; `ECONNREFUSED`; `57P01`; `53300`; `57014`;
  - **repetir**: `40P01` e `40001`;
  - **`UniqueConstraintViolationException` por nome de constraint**: `wager_tx_provider_idempotency_uq` e `wager_tx_provider_external_uq` → releitura de idempotência; `wallets_player_currency_uq` → wallet duplicada; `wager_tx_single_reversal_uq` → repetir uma vez;
  - **quebra de invariante (500)**: `23514`, `22003` e `P0001`.
- [X] T016 [P] Escrever `test/unit/global-exception-filter.test.ts` (I-38, I-39, FR-055, FR-056, FR-058):
  - cada erro de aplicação vira o status correto, com corpo `{ error: { code, message, retryable, correlationId, details? } }`;
  - `VALIDATION_ERROR`, `OPENING_NOT_ALLOWED` e `IDEMPOTENCY_KEY_REQUIRED` → 400; `WALLET_NOT_FOUND` e `TRANSACTION_NOT_FOUND` → 404; `IDEMPOTENCY_CONFLICT` e `WALLET_ALREADY_EXISTS` (com `details.walletId`) → 409; `SERVICE_UNAVAILABLE` → 503 com header `Retry-After` = `RETRY_AFTER_SECONDS`; erro desconhecido → 500 `INTERNAL_ERROR` com `retryable` true;
  - a mensagem nunca contém o payload.
- [X] T017 [P] Escrever `test/unit/zod-validation-pipe.test.ts`: o pipe com um schema Zod devolve o valor parseado (campos desconhecidos descartados, I-57) ou lança `VALIDATION_ERROR` com `details.issues` (`path` e `message`) (R-13)
- [X] T124 [P] Escrever `test/unit/unit-of-work.test.ts` (R-12, R-19, FR-043; gate de Tasks da constitution):
  - **deadlock**: uma função de trabalho que sempre lança `DriverException` com `code` `40P01` é executada exatamente 3 vezes (1 + 2 repetições) e termina em `ServiceUnavailableError`;
  - **serialização**: o mesmo com `40001`;
  - **sucesso na repetição**: uma função que falha com `40P01` na 1ª chamada e passa na 2ª devolve o resultado, com 2 execuções;
  - **sem repetição** para `transient` (`55P03`), para `23505` e para `invariant`: 1 execução só;
  - a função de trabalho recebe o EntityManager passado pelo unit of work, sem banco (o EM é um objeto de teste opaco; o teste não substitui o PostgreSQL de nenhum teste de integração).

### Shared-kernel e outbox (implementação)

- [X] T018 [P] Criar `src/shared-kernel/domain/errors.ts`: `DomainError` (base), `InvalidMoneyError`, `CurrencyMismatchError`, `InvalidTransactionStateError`, `InsufficientBalanceError`, `BalanceLimitExceededError`, `InvalidLedgerEntryError`
- [X] T019 Implementar `src/shared-kernel/domain/money.ts`: `Money` imutável sobre `Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN })`; construtor privado; `from`, `zero` e as operações do enunciado §6.1; serializa com `toFixed(2)`. Faz o T008 passar (R-03, FR-001 a FR-004)
- [X] T020 [P] Criar as portas `src/shared-kernel/domain/clock.port.ts` (`CLOCK`, `Clock.now(): Date`) e `src/shared-kernel/domain/id-generator.port.ts` (`ID_GENERATOR`, `next(): string`), e os adaptadores `src/shared-kernel/infrastructure/system-clock.ts` e `src/shared-kernel/infrastructure/uuidv7-id-generator.ts` (`Bun.randomUUIDv7()`). Criar também os doubles determinísticos de teste `test/support/fakes.ts`: `FixedClock` e `SequentialIdGenerator`, que gera UUIDv7 válidos em sequência. Testar em `test/unit/uuidv7-id-generator.test.ts` que o adaptador real e o `SequentialIdGenerator` geram ids no formato UUIDv7 (`/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/`, em minúsculas, I-58), distintos e crescentes em ordem lexicográfica (I-35, constitution VI)
- [X] T021 Implementar `src/shared-kernel/domain/integration-event.ts`: classe abstrata do enunciado §11, com construtor `protected`, `eventType` e `version` abstratos e `data` com `MoneyProps`. Faz o T009 passar
- [X] T022 Implementar `src/outbox/domain/outbox-message.ts` conforme data-model §1. Faz o T010 passar
- [X] T023 [P] Criar `src/shared-kernel/application/errors.ts` com os erros de aplicação, cada um com `code`, `retryable` e `details?`: `ValidationError`, `OpeningNotAllowedError`, `IdempotencyKeyRequiredError`, `IdempotencyConflictError`, `WalletNotFoundError`, `WalletAlreadyExistsError` (com `walletId`), `TransactionNotFoundError`, `ServiceUnavailableError`, `InternalError` (taxonomia de `docs/interpretacoes.md` §7)

### Platform (implementação)

- [X] T024 [P] Implementar `src/platform/config/app-config.ts` com leitura, validação e hierarquia de timeouts; a app não sobe se a configuração for inválida. Faz o T011 passar (FR-059, I-51)
- [X] T025 [P] Implementar `src/platform/correlation/request-context.ts` (`AsyncLocalStorage` com `correlationId` e, quando conhecidos, `transactionId`, `walletId` e `providerId`) e `src/platform/correlation/correlation.middleware.ts`:
  - usa `resolveCorrelationId` com o `IdGenerator`;
  - grava o header `X-Correlation-Id` na resposta;
  - nunca rejeita a requisição.
  Faz o T012 passar (I-53, FR-060).
- [X] T026 Implementar `src/platform/logging/json-logger.ts`: `LoggerService` do Nest que escreve uma linha JSON por evento, lendo o contexto do T025 e removendo valores monetários, e um middleware de log de requisição (método, rota, status, duração). Faz o T013 passar (FR-058, constitution VIII)
- [X] T027 [P] Implementar `src/platform/failpoints/failpoints.ts`: porta `FAILPOINTS` com `hit(name)` e implementação que lê `FAILPOINT`, é no-op em `NODE_ENV=production` e recebe a função de `exit` injetada. Faz o T014 passar (I-40, R-16)
- [X] T028 [P] Implementar `src/platform/persistence/pg-errors.ts`: `classifyDbError(err)`, que devolve `transient`, `retry`, `idempotency-race`, `wallet-duplicate`, `reversal-race` ou `invariant`, exatamente como na tabela do R-12; o timeout de aquisição é o único caso identificado por mensagem. Importa de `pg` o tipo `DatabaseError` para ler `code` e `constraint` do erro original do driver quando a exceção do MikroORM o carrega. Faz o T015 passar
- [X] T029 Implementar `src/platform/http/global-exception.filter.ts` (envelope do I-38, status do FR-055, `Retry-After` nos 503, `correlationId` do contexto, log de erro sem payload) e `src/platform/http/zod-validation.pipe.ts`. Faz o T016 e o T017 passarem
- [X] T030 [P] Criar `src/platform/auth/noop-auth.guard.ts` (guard global que sempre permite) e `src/platform/auth/provider-identity.port.ts` (porta `PROVIDER_IDENTITY` com implementação no-op; o desenho com Keycloak vai para o `ARCHITECTURE.md` da raiz) (I-41, constitution VI)

### Persistência e migrations

- [X] T031 Implementar `src/platform/persistence/mikro-orm.config.ts`, com `clientUrl` vindo do config, `pool: { min: 0, max: DB_POOL_MAX }`, `driverOptions: { connectionTimeoutMillis: DB_POOL_ACQUIRE_TIMEOUT_MS }`, tipado com `PoolConfig` importado de `pg` (S-09), `extensions: [Migrator]` e `migrations: { migrationsList, tableName: 'mikro_orm_migrations', snapshot: false, snapshotOnMigrate: false }`. Implementar também `src/platform/persistence/run-migrations.ts` com `runMigrations(url, 'up' | 'down')`, que usa `migrator.up()` e `migrator.down({ to: 0 })` (data-model §2.6, S-08)
- [X] T032 [P] Criar `migrations/Migration20261107000100.ts`:
  - `up`: copia **literalmente** o DDL de data-model §2.1 (`wallets`) e §2.2 (`wager_transactions`, incluindo `wager_tx_provider_idempotency_uq UNIQUE (provider_id, idempotency_key)`, `wager_tx_provider_external_uq`, `wager_tx_ledger_key_uq`, todos os `CHECK` e o índice parcial `wager_tx_single_reversal_uq ... WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'`);
  - `down`: `DROP TABLE wager_transactions` e depois `DROP TABLE wallets`;
  - um `addSql` por comando (I-16, I-24, I-56).
- [X] T033 [P] Criar `migrations/Migration20261107000200.ts`: `up` com o DDL de data-model §2.3 (`wallet_ledger_entries`, com `seq bigint GENERATED ALWAYS AS IDENTITY`, `ledger_wallet_tx_uq`, `ledger_arithmetic_ck`, as FKs compostas `ledger_wallet_fk` e `ledger_transaction_fk`, e o índice `ledger_wallet_seq_idx`); `down` com `DROP TABLE wallet_ledger_entries` (I-36)
- [X] T034 [P] Criar `migrations/Migration20261107000300.ts`: `up` com o DDL de data-model §2.4 (`outbox_messages`, `outbox_event_type_ck` e o índice parcial `outbox_pending_idx`); `down` com `DROP TABLE outbox_messages`
- [X] T035 [P] Criar `migrations/Migration20261107000400.ts`:
  - `up`: as funções e triggers de data-model §2.5, copiados literalmente: `jg_forbid_mutation`, `ledger_no_update_delete_trg`, `ledger_no_truncate_trg`, `jg_ledger_before_insert` (com o filtro `wallet_id = NEW.wallet_id AND transaction_id = tx.reference_transaction_id` no ROLLBACK), `jg_wallet_matches_ledger_tail` (constraint trigger `DEFERRABLE INITIALLY DEFERRED`), `jg_wallets_guard` e `jg_wager_tx_guard`, mais `wager_tx_no_truncate_trg`;
  - `down`: `DROP TRIGGER` e `DROP FUNCTION` na ordem inversa (FR-041, FR-042, FR-009, FR-028, SC-008).
- [X] T036 Criar `scripts/migrate.ts`: `bun scripts/migrate.ts up|down`, usando `runMigrations` do T031 sobre `DATABASE_URL`; termina com código 0 em sucesso e diferente de 0 em erro (S-08)
- [X] T037 Implementar `src/platform/persistence/orm.provider.ts` (token `ORM`, `MikroORM.init` no boot e fechamento no shutdown; fork por execução, sem `@mikro-orm/nestjs`, R-05) e `src/platform/persistence/unit-of-work.ts`:
  - `run(work: (em) => Promise<T>)` abre um fork, faz `fork.transactional(cb, { isolationLevel: READ_COMMITTED })` e executa `SET LOCAL lock_timeout = '<n>ms'` como primeiro comando (n é o inteiro validado);
  - passa **o EM da transação** ao `work` (R-19);
  - repete o trabalho inteiro até 2 vezes em `retry` (`40P01`/`40001`);
  - converte `transient` em `ServiceUnavailableError` sempre depois do rollback, inclusive quando o `COMMIT` falha por perda de conexão (R-12).
- [X] T038 Criar `src/app.module.ts` e `src/main.ts`:
  - `import 'reflect-metadata'` e validação do config, que encerra com código 1 se for inválido;
  - providers de `CLOCK`, `ID_GENERATOR`, `FAILPOINTS`, `ORM` e `PROVIDER_IDENTITY`;
  - middlewares de correlationId e de log, `GlobalExceptionFilter`, `NoopAuthGuard` e logger JSON;
  - `server.setTimeout`, `requestTimeout`, `headersTimeout` e `keepAliveTimeout` = `HTTP_SERVER_TIMEOUT_MS` (S-03, I-51);
  - `enableShutdownHooks()`;
  - depois do `listen`, uma linha de log `{"event":"http.listening","port":…}` (R-17).

### Infraestrutura de teste

- [X] T039 Criar `test/support/db.ts` (cliente `pg` admin a partir de `TEST_DATABASE_ADMIN_URL`, helpers de consulta com `?` e conversão para `$n` só dentro do helper) e `test/support/db-setup.preload.ts`, que roda uma vez por execução (R-17):
  - se `jg_test_template` existir, executa antes `ALTER DATABASE jg_test_template WITH IS_TEMPLATE false ALLOW_CONNECTIONS true`, porque o PostgreSQL não apaga um banco marcado como template, nem com `FORCE`;
  - apaga os bancos `jg_test_*` que sobraram, inclusive o template, com `DROP DATABASE ... WITH (FORCE)`;
  - recria `jg_test_template` e aplica `runMigrations(..., 'up')`;
  - fecha as conexões;
  - executa `ALTER DATABASE jg_test_template WITH ALLOW_CONNECTIONS false IS_TEMPLATE true`.
- [X] T040 Criar `test/support/test-database.ts` com `useTestDatabase(fileTag)`:
  - no `beforeAll`, `CREATE DATABASE jg_test_<fileTag>_<aleatório> TEMPLATE jg_test_template` e exposição de `url` e de um cliente `pg`;
  - no `afterAll`, fecha os clientes e faz `DROP DATABASE ... WITH (FORCE)`;
  - nenhuma função de limpeza de dados (R-17, constitution VII).
- [X] T041 [P] Criar `test/support/assert-wallet-matches-ledger.ts` com `assertWalletMatchesLedger(db, walletId)` (SC-006, FR-042, constitution VII). Lendo por SQL cru (`?`), confere com `Money`, sem `number`:
  - `wallets.balance` = Σ créditos − Σ débitos;
  - a cadeia está encadeada (`balance_before[0] = 0.00` e `balance_before[n] = balance_after[n-1]`, por `seq`);
  - o `balance_after` do último lançamento é igual ao saldo;
  - saldo ≥ 0;
  - todo lançamento tem transação PROCESSED.
  Também `assertAllWalletsMatchLedger(db)`.
- [X] T042 [P] Criar `test/support/app-harness.ts`: `startApp({ databaseUrl, env })` sobe a app em processo (`NestFactory` + porta efêmera) com overrides de env; expõe `baseUrl`, `app.get(ORM)` e `close()` (R-17)
- [X] T043 [P] Criar `test/support/instance-cluster.ts`: `startCluster({ size: 3, databaseUrl, env })` sobe `bun src/main.ts` com `Bun.spawn` em portas livres, espera a linha `http.listening` (timeout de 15 s), oferece um cliente HTTP round-robin e `stop()`, que manda `SIGTERM` e, depois de 5 s, `SIGKILL`, sem deixar processo órfão nem em falha. No Windows o término é forçado (saída 143); nenhum teste depende disso (S-10, R-17)
- [X] T044 [P] Criar `test/support/factories.ts`: builders de payload HTTP (`walletRequest`, `wagerRequest` por kind, com `providerId`, `externalTransactionId` e `playerId` únicos por chamada, dinheiro como string) e `idempotencyKeyFor(req)` = `{providerId}:{externalTransactionId}`

### Testes de infraestrutura (banco real)

- [X] T045 [P] Escrever `test/integration/migrations.test.ts` sobre um banco próprio criado de `template0`:
  - `up → down → up` via `runMigrations`;
  - o mesmo ciclo pelo script real: `Bun.spawn(['bun', 'scripts/migrate.ts', 'up'])` e depois `down`, com `DATABASE_URL` apontando para um segundo banco próprio, conferindo código de saída 0 em cada passo e código ≠ 0 com uma `DATABASE_URL` inválida (T036);
  - depois de cada passo, confere no catálogo (`pg_tables`, `pg_trigger`, `pg_proc`, `pg_indexes`) as 4 tabelas, todos os triggers e funções da data-model §2.5, o índice parcial `wager_tx_single_reversal_uq` e `outbox_pending_idx` (e a ausência deles depois do `down`);
  - nenhum arquivo `.snapshot*` foi criado no repositório (constitution V, S-08).
- [X] T046 [P] Escrever `test/integration/schema-guards.test.ts` (SC-008, FR-008, FR-025, FR-029, FR-039, FR-041, FR-042, I-16, I-24, I-36, I-56). Monta as linhas por SQL direto (`?`) no banco do arquivo, respeitando as próprias constraints, e prova cada guarda da data-model §2:
  - **unicidades**: `wallets_player_currency_uq`; `wager_tx_provider_idempotency_uq`, com a mesma chave aceita em outro provedor; `wager_tx_provider_external_uq`; `wager_tx_single_reversal_uq`, que barra REFUND seguido de ROLLBACK PROCESSED da mesma referência;
  - **CHECKs da transação**: `wager_tx_amount_ck` (0 só em LOSS), `wager_tx_reference_by_kind_ck`, `wager_tx_failure_code_ck` e `wager_tx_failure_code_value_ck` (aceita `BALANCE_LIMIT_EXCEEDED`), `wager_tx_opening_identity_ck`, `wager_tx_processed_reversal_ck`;
  - **CHECKs da wallet e do ledger**: `wallets_balance_non_neg_ck`, `ledger_arithmetic_ck`;
  - **FKs compostas**: `ledger_wallet_fk` e `ledger_transaction_fk`, com moeda, wallet e valor errados recusados;
  - **triggers**: `UPDATE`, `DELETE` e `TRUNCATE` no ledger recusados com `P0001`, cada comando escrito inline em `await expect(db.query('...')).rejects` (regra do T118); lançamento para transação não PROCESSED recusado; cadeia quebrada recusada; `wallet_ledger_tail_mismatch` no `COMMIT`; wallet com `version` sem mudança de saldo recusada; transição de estado terminal recusada; `DELETE` e `TRUNCATE` em `wager_transactions` recusados, também inline em `expect(...).rejects`.
- [X] T047 [P] Escrever `test/integration/platform-smoke.test.ts`:
  - `startApp` sobe contra o banco do arquivo e escreve `http.listening`;
  - a resposta traz o header `X-Correlation-Id`;
  - com `HTTP_SERVER_TIMEOUT_MS` abaixo da hierarquia, um processo via `Bun.spawn` encerra com código ≠ 0 antes de escutar (FR-059, I-51, FR-060).
- [X] T125 [P] Escrever `test/integration/deadlock.test.ts`, com deadlock real no banco do arquivo, sem mock (R-12, gate de Tasks):
  - duas conexões `pg` abrem transação; a 1ª trava a linha A e a 2ª trava a linha B (`SELECT ... FOR UPDATE` em SQL cru, `?`); em seguida a 1ª pede B e a 2ª pede A;
  - exatamente uma das duas recebe `40P01` do PostgreSQL;
  - o erro capturado, passado por `classifyDbError` (T028), devolve `retry`;
  - o mesmo erro, vindo de uma consulta pelo EntityManager do MikroORM (`em.execute` dentro de `transactional`), chega com `code` `40P01` e também é classificado como `retry`;
  - as duas transações terminam em rollback ou commit, sem conexão presa.

**Checkpoint**: `bun run typecheck && bun run test:unit && bun run test:integration` verdes, incluindo o T124 (`unit-of-work`) e o T125 (`deadlock`). Fundação pronta.

---

## Phase 3: User Story 1 - Abrir wallet com saldo inicial auditável (Priority: P1) 🎯 MVP

**Goal**: `POST /wallets` cria a wallet; saldo > 0 gera OPENING PROCESSED, um lançamento CREDIT e
`WalletBalanceChanged`; a duplicata responde 409 com `details.walletId`.

**Independent Test**: criar wallets com saldo positivo e zero e conferir as linhas por SQL e com
`assertWalletMatchesLedger`; disparar 10 criações simultâneas em 3 instâncias.

### Testes da User Story 1 (escrever primeiro; devem falhar)

- [X] T048 [P] [US1] Escrever `test/unit/wallet.test.ts` (FR-005, FR-009, FR-039, I-06, I-54):
  - `Wallet.open` nasce com `version` 1 e o saldo inicial;
  - `debit` e `credit` devolvem um `WalletLedgerEntry` coerente e incrementam `version` em 1;
  - débito que deixaria o saldo negativo lança `InsufficientBalanceError`;
  - crédito que passaria de 9999999999999999.99 lança `BalanceLimitExceededError`;
  - moeda diferente lança `CurrencyMismatchError`;
  - `rehydrate` reconstrói o estado sem validar transições.
- [X] T049 [P] [US1] Escrever `test/unit/wallet-ledger-entry.test.ts`: `create` aceita só `balanceBefore ± money = balanceAfter` conforme a direção, `money > 0`, `balanceAfter ≥ 0` e moeda única, e recusa o resto com `InvalidLedgerEntryError`; `isBalanced()`; todos os campos `readonly` (enunciado §6.4, FR-029)
- [X] T050 [P] [US1] Escrever `test/unit/wager-transaction.test.ts` (FR-028, I-11, I-12, I-13, I-07):
  - **transições válidas do I-11**: PENDING → PROCESSED, REJECTED, PENDING_REFERENCE ou FAILED; PENDING_REFERENCE → PROCESSED, REJECTED ou FAILED;
  - **estados terminais**: qualquer transição a partir de PROCESSED, REJECTED ou FAILED lança `InvalidTransactionStateError`, inclusive `fail()` em estado terminal; `fail(code)` a partir de PENDING funciona;
  - **create**: BET com referência, REFUND ou ROLLBACK sem referência e kind OPENING vindo de provedor são recusados;
  - **abertura**: `createOpening` usa a identidade do I-07 (`system`, `opening:{walletId}`, `system:opening:{walletId}`, `opening`, `system`);
  - **consultas**: `requiresReference`, `affectsBalance` (false em LOSS), `ledgerDirectionFor` (BET → DEBIT; WIN, REFUND e OPENING → CREDIT; ROLLBACK → inverso da referência), `matchesPayload`, `observedBalance`, `correlationId`;
  - `rehydrate` sem revalidar.
- [X] T051 [P] [US1] Escrever `test/unit/failure-code.test.ts`: cada código da taxonomia de `docs/interpretacoes.md` §7 tem o `retryable` e a ação definidos lá, inclusive `BALANCE_LIMIT_EXCEEDED` (false, GIVE_UP, I-54) e `TRANSACTION_NOT_FOUND` (false, I-55); separa os códigos persistíveis dos que são só de resposta HTTP (data-model §1)
- [X] T052 [P] [US1] Escrever `test/integration/create-wallet.test.ts` com `useTestDatabase` e `startApp` (US1 cenários 1, 2, 3 e 5; FR-005 a FR-008, FR-046, I-06, I-07, I-09, I-10, I-52). Cada teste termina com `assertWalletMatchesLedger`.
  - saldo "1000.00" → 201 com `id`, `playerId`, `balance` `{ "amount": "1000.00", "currency": "BRL" }` e `version` 1;
  - por SQL, nesse caso: uma transação OPENING PROCESSED com a identidade do I-07 e `observed_balance` "1000.00", um lançamento CREDIT (antes "0.00", depois "1000.00") e exatamente um `WalletBalanceChanged` na outbox, sem `WagerTransactionProcessed`;
  - **payload desse `WalletBalanceChanged`** (FR-047): `eventId` UUIDv7 igual ao `id` da linha da outbox; `aggregateId` = `walletId`; `correlationId` = o da requisição; `occurredAt` em ISO-8601; `eventType` "WalletBalanceChanged"; `version` 1; `data` com `walletId`, `transactionId` da abertura, `direction` "CREDIT", `money` `{ "amount": "1000.00", "currency": "BRL" }`, `balanceBefore` "0.00", `balanceAfter` "1000.00" (todos os valores como string) e `walletVersion` 1;
  - saldo "0.00" → wallet sem OPENING, sem lançamento e sem evento;
  - duplicata do mesmo `playerId` e moeda → 409 `WALLET_ALREADY_EXISTS` com `error.details.walletId` igual ao da primeira, sem outros dados e sem efeito;
  - mesmo jogador em USD → 201;
  - validação → 400 `VALIDATION_ERROR`: `playerId` vazio ou com mais de 255 caracteres, `amount` como número JSON, "-1", moeda "brl".
- [X] T053 [P] [US1] Escrever `test/concurrency/concurrent-wallet-creation.test.ts` com `startCluster({ size: 3 })` (US1 cenário 4; I-10, I-52; SC-005):
  - 10 `POST /wallets` simultâneos para o mesmo jogador e moeda, distribuídos nas 3 instâncias → exatamente 1 resposta 201 e 9 respostas 409 `WALLET_ALREADY_EXISTS`, todas com o mesmo `error.details.walletId`, igual ao da 201;
  - existe 1 wallet e 1 lançamento de abertura;
  - termina com `assertWalletMatchesLedger`.

### Implementação da User Story 1

- [X] T054 [P] [US1] Implementar `src/wallets/domain/ledger-direction.ts` (`DEBIT` e `CREDIT`) e `src/wallets/domain/wallet-ledger-entry.ts` (`create` validado e `rehydrate`; sem `seq` no domínio). Faz o T049 passar
- [X] T055 [US1] Implementar `src/wallets/domain/wallet.ts` (aggregate root do enunciado §6.2 e da data-model §1: `open`, `rehydrate`, `debit` e `credit` devolvendo o lançamento, limite do I-54). Faz o T048 passar
- [X] T056 [P] [US1] Implementar `src/wagering/domain/failure-code.ts` (enum, `retryable`, ação e conjunto dos códigos persistíveis). Faz o T051 passar
- [X] T057 [US1] Implementar `src/wagering/domain/wager-transaction.ts`, com os campos do enunciado §6.3 mais `observedBalance`, `correlationId`, `referenceAttempts` e `nextReferenceAttemptAt` (data-model §1), as transições do I-11, `create`, `createOpening` e `rehydrate`. Faz o T050 passar
- [X] T058 [P] [US1] Implementar `src/wallets/domain/events/wallet-balance-changed.event.ts`: `WalletBalanceChanged` v1, com `data` `{ walletId, transactionId, direction, money, balanceBefore, balanceAfter, walletVersion }` em `MoneyProps` e `aggregateId` = `walletId` (I-33, enunciado §11)
- [X] T059 [P] [US1] Criar `src/wallets/infrastructure/wallet.schema.ts` e `src/wallets/infrastructure/ledger-entry.schema.ts` (EntitySchema, com `balance`, `amount`, `balance_before` e `balance_after` usando `new DecimalType('string')`, `precision: 18` e `scale: 2`; `seq` lido como string), e os mappers `src/wallets/infrastructure/wallet.mapper.ts` e `src/wallets/infrastructure/ledger-entry.mapper.ts`, que reidratam com `Money.from` (I-04, data-model §2)
- [X] T060 [P] [US1] Criar `src/wagering/infrastructure/wager-transaction.schema.ts` (`amount` e `observed_balance` nullable com `new DecimalType('string')`, `precision: 18`, `scale: 2`; `observed_balance_currency`; `correlation_id`; `reference_attempts`; `next_reference_attempt_at`) e `src/wagering/infrastructure/wager-transaction.mapper.ts` (data-model §2.2)
- [X] T061 [P] [US1] Criar `src/outbox/infrastructure/outbox-message.schema.ts`, `src/outbox/infrastructure/outbox-message.mapper.ts` e `src/outbox/infrastructure/mikro-orm-outbox.writer.ts`, com `append(em, messages)` via `em.insert` (R-15, data-model §2.4)
- [X] T062 [US1] Implementar os repositórios. Todos recebem o `em` como parâmetro em cada método, sem guardar EntityManager (R-19); o SQL cru usa `?`.
  - **`src/wallets/infrastructure/mikro-orm-wallet.repository.ts`**: `insert(em, wallet)`, `findById(em, id)`, `lockById(em, id)` com `LockMode.PESSIMISTIC_WRITE`, `updateBalance(em, wallet, expectedVersion)` com `nativeUpdate ... WHERE id = ? AND version = ?` (0 linhas → erro de invariante), e `findIdByPlayerAndCurrency(em, playerId, currency)`;
  - **`src/wallets/infrastructure/mikro-orm-ledger.repository.ts`**: `insert(em, entry)`;
  - **`src/wagering/infrastructure/mikro-orm-wager-transaction.repository.ts`**: `insert(em, tx)`.
- [X] T063 [US1] Implementar `src/wallets/application/create-wallet.use-case.ts` (I-06, I-07, I-09, I-10, I-52, FR-005 a FR-008, FR-046):
  - numa só transação, via unit of work: `Wallet.open`; se o saldo for > 0, também `createOpening` → PROCESSED com `observedBalance`, o lançamento CREDIT (antes 0.00) e o `WalletBalanceChanged` na outbox; `version` continua 1;
  - em `wallet-duplicate` (`23505` em `wallets_player_currency_uq`): depois do rollback, lê o id com `findIdByPlayerAndCurrency` num fork novo e lança `WalletAlreadyExistsError(walletId)`;
  - o `correlationId` vem do contexto de requisição.
- [X] T064 [US1] Criar `src/wallets/interfaces/http/wallet.dto.ts` e `src/wallets/interfaces/http/wallets.controller.ts`, e registrar o `WalletsModule` em `src/app.module.ts`:
  - **DTO** (Zod): `playerId` string 1–255; `initialBalance.amount` string `^(0|[1-9]\d*)(\.\d{1,2})?$` ≤ 9999999999999999.99, aceitando "0.00"; `currency` `^[A-Z]{3}$`;
  - **controller**: `POST /wallets` → 201 `{ id, playerId, balance, version }`, com o `ZodValidationPipe` explícito;
  - **contexto de log** (constitution VIII, C1): logo depois de criada a wallet, grava `walletId` no contexto da requisição (T025); no 409, grava o `walletId` existente.
- [X] T127 [US1] Revisar o diff da US1 contra `specs/001-wagering-transaction-core/review-checklist.md` (gate de Revisão da constitution, Princípios II a V) e registrar o resultado item a item na descrição da entrega; qualquer item reprovado volta para a task de origem antes do checkpoint

**Checkpoint US1**: `bun test test/unit/wallet.test.ts test/unit/wallet-ledger-entry.test.ts test/unit/wager-transaction.test.ts test/unit/failure-code.test.ts && bun test --preload ./test/support/db-setup.preload.ts test/integration/create-wallet.test.ts test/concurrency/concurrent-wallet-creation.test.ts`, com o T127 concluído.

---

## Phase 4: User Story 2 - Apostar sem nunca ficar com saldo negativo (Priority: P1) 🎯 MVP

**Goal**: `POST /wagering/transactions` aplica BET com lock por wallet; sem saldo, a transação fica REJECTED
(422) e é persistida; correto com 3 instâncias.

**Independent Test**: BETs dentro e fora do saldo; o cenário 100/80/80 em paralelo real repetido 20 vezes; colunas
de dinheiro como string; atomicidade com failpoint.

### Testes da User Story 2 (escrever primeiro; devem falhar)

- [X] T065 [P] [US2] Escrever `test/unit/wager-rules.test.ts`, parte da US2 (I-44 passos 5.1 e 5.5, FR-014 a FR-016, FR-027, FR-061, I-18, I-19, I-54):
  - `WALLET_PLAYER_MISMATCH` prevalece sobre `CURRENCY_MISMATCH`, que prevalece sobre o saldo;
  - BET dentro do saldo → `Apply(DEBIT)`; BET acima do saldo → `Reject(INSUFFICIENT_FUNDS)`;
  - crédito sem referência a partir de "9999999999999990.00": "+10.00" → `Reject(BALANCE_LIMIT_EXCEEDED)` e "+9.99" → `Apply(CREDIT)`;
  - a decisão é pura, sem I/O.
- [X] T066 [P] [US2] Escrever `test/unit/payload-hash.test.ts` (FR-031, I-25):
  - o JSON canônico ordena as chaves recursivamente, sem espaços, em UTF-8, e o hash é SHA-256 em hex de 64 caracteres;
  - a ordem das chaves na entrada não muda o hash;
  - **uma LOSS com `amount` "0" e outra com "0.00" geram o mesmo `payloadHash`**, assim como "25" e "25.00";
  - `referenceExternalTransactionId` ausente é omitido;
  - `idempotencyKey`, `messageId`, `occurredAt` e campos desconhecidos não alteram o hash (I-57);
  - `walletId` em maiúsculas e em minúsculas geram o mesmo hash (normalizado, I-58);
  - `playerId`, `providerId`, `externalTransactionId`, `roundId`, `gameId` e `referenceExternalTransactionId` com caixa diferente geram hashes **diferentes** (case-sensitive, I-58).
- [X] T067 [P] [US2] Escrever `test/unit/wager-transaction-dto.test.ts` para o schema Zod da submissão (FR-001, FR-002, FR-010 a FR-012, I-01, I-02, I-03, I-05, I-07, I-08, I-13, I-50, I-57, I-58, R-13):
  - `amount` como número JSON → erro;
  - "25.001", "-1", "1e3" e "" → erro; "25" → "25.00";
  - zero aceito só em LOSS;
  - acima de 9999999999999999.99 → erro;
  - moeda fora de `^[A-Z]{3}$` → erro;
  - kind OPENING → `OPENING_NOT_ALLOWED`; providerId "system" → erro;
  - BET com referência → erro; REFUND ou ROLLBACK sem referência → erro;
  - `walletId` que não é UUID → erro, e UUID em maiúsculas é normalizado para minúsculas (I-58);
  - `playerId`, `providerId`, `externalTransactionId`, `roundId`, `gameId` e `referenceExternalTransactionId` são preservados exatamente como enviados, sem mudança de caixa (I-58);
  - strings fora de 1–255 → erro;
  - campos desconhecidos são descartados e não geram erro (I-57); um campo conhecido com tipo errado continua dando erro.
- [X] T068 [P] [US2] Escrever `test/integration/submit-transaction.test.ts` (US2 cenários 1, 2 e 5; FR-016, FR-027, FR-036, FR-040, FR-045, FR-054, FR-061, I-18, I-19, I-20, I-45, I-54). Cada teste termina com `assertWalletMatchesLedger`.
  - BET "25.00" sobre "1000.00" → 201 `PROCESSED`, `balance` "975.00", `idempotentReplay` false;
  - por SQL, nesse caso: lançamento DEBIT (antes "1000.00", depois "975.00"), `version` +1, `observed_balance` "975.00", `correlation_id` gravado e outbox com `WalletBalanceChanged` e `WagerTransactionProcessed`;
  - **payload de cada evento** (FR-047, I-33): `eventId` único e igual ao `id` da linha da outbox; `aggregateId` = `walletId`; `correlationId` = o da requisição; `occurredAt` em ISO-8601; `eventType` e `version` 1 coerentes com a linha (`event_type`, `event_version`); todo valor monetário em `data` como string com 2 casas (`money`, `balanceBefore`, `balanceAfter`, `balance`), nunca número; os campos de `data` conforme a tabela de eventos da data-model §1;
  - **ordem de gravação** (data-model §1): `WalletBalanceChanged` é inserido antes do `WagerTransactionProcessed` da mesma transação (ordem de inserção na outbox, com `occurredAt` do primeiro ≤ o do segundo);
  - na rejeição abaixo, o `WagerTransactionRejected` traz `failureCode`, `retryable` false e `balance` observado como string;
  - BET "25.00" sobre "10.00" → 422 com corpo `TransactionResult` (`status` REJECTED, `failureCode` `INSUFFICIENT_FUNDS`, `retryable` false, `balance` "10.00"), transação persistida sem lançamento, `version` inalterada e evento `WagerTransactionRejected`;
  - WIN "10.00" sem referência sobre "9999999999999990.00" → 422 `BALANCE_LIMIT_EXCEEDED`, sem efeito no saldo;
  - wallet inexistente → 404 `WALLET_NOT_FOUND`, sem linha em `wager_transactions`;
  - jogador que não é dono → 422 `WALLET_PLAYER_MISMATCH`;
  - USD em wallet BRL → 422 `CURRENCY_MISMATCH`.
- [X] T069 [P] [US2] Escrever `test/integration/money-columns.test.ts`: o teste de NUMERIC como string, pelo desenho da linha `money-columns` da matriz do plan (FR-003, I-03, I-04, constitution II). Sem desligar triggers; termina com `assertWalletMatchesLedger` nas duas wallets.
  - **Wallet A**: aberta com "9999999999999999.99" e depois uma BET "0.10";
  - **Wallet B**: aberta com "0.10" e depois uma BET "0.10";
  - **colunas cobertas**: `wallets.balance`, `wager_transactions.amount` e `observed_balance`, `wallet_ledger_entries.amount`, `balance_before` e `balance_after` recebem os dois valores;
  - **verificação**: relê pelas entidades mapeadas, com `em.findOneOrFail` num fork novo, e confere para cada coluna e valor que `typeof === "string"`, que o texto é idêntico (`toBe`) e que `Money.from` reidrata o mesmo valor; confere também por SQL cru com `?`.
- [X] T070 [P] [US2] Escrever `test/integration/atomicity.test.ts`, o teste com failpoint de atomicidade (FR-040, SC-007, I-40, falha eliminatória 6). Sobe a app com `FAILPOINT=after_ledger_insert_before_commit` e submete uma BET:
  - a resposta é 500 `INTERNAL_ERROR` com `retryable` true;
  - nenhuma linha nova em `wager_transactions`, `wallet_ledger_entries` e `outbox_messages`, e `wallets.balance` e `version` intactos;
  - depois de reiniciar a app sem o failpoint, o reenvio da mesma requisição → 201 com `idempotentReplay` false e exatamente 1 lançamento;
  - termina com `assertWalletMatchesLedger`.
- [X] T071 [P] [US2] Escrever `test/concurrency/hot-wallet-race.test.ts` com `startCluster({ size: 3 })`, que é **critério de parada do MVP** (US2 cenários 3 e 4; SC-001, SC-005, falha eliminatória 2). Repetir 20 vezes com uma wallet nova a cada vez:
  - saldo "100.00" e duas BETs distintas de "80.00" enviadas simultaneamente por instâncias diferentes;
  - exatamente 1 PROCESSED e 1 REJECTED `INSUFFICIENT_FUNDS`;
  - saldo final "20.00" e exatamente 1 DEBIT dessas apostas;
  - `assertWalletMatchesLedger` em cada repetição.
- [X] T072 [P] [US2] Escrever `test/concurrency/wallet-isolation.test.ts` com `startCluster({ size: 3 })` (SC-004, FR-038):
  - 20 wallets recebem BETs em paralelo e todas terminam com o resultado esperado;
  - com uma conexão `pg` externa segurando `FOR UPDATE` na wallet A, uma BET na wallet B responde 201 em menos de 1 s. O lock externo representa a "disputa contínua" do SC-004: é o pior caso de contenção numa wallet (lock segurado o tempo todo), e é determinístico, ao contrário de uma rajada de requisições;
  - termina com `assertAllWalletsMatchLedger`.
- [X] T073 [P] [US2] Escrever `test/concurrency/lock-timeout.test.ts`, o teste de lock-timeout (FR-059, I-51, US2/US9):
  - cluster com `WALLET_LOCK_TIMEOUT_MS=500`, `DB_POOL_ACQUIRE_TIMEOUT_MS=1000` e `HTTP_SERVER_TIMEOUT_MS=4000`, respeitando a hierarquia;
  - uma conexão externa segura `FOR UPDATE` na wallet;
  - a BET responde 503 `SERVICE_UNAVAILABLE` com `Retry-After` entre 450 e 1500 ms;
  - sem nenhuma linha nova;
  - depois de soltar o lock, o reenvio → 201;
  - termina com `assertWalletMatchesLedger`.
- [X] T074 [P] [US2] Escrever `test/concurrency/pool-pressure.test.ts`, o teste de pool-pressure (R-19, FR-038):
  - 3 instâncias com `DB_POOL_MAX=5`;
  - 100 BETs distintas de "1.00" em paralelo na mesma wallet com saldo "1000.00";
  - **nenhuma resposta 503**: 100 respostas 201;
  - saldo final "900.00" e 100 DEBITs;
  - termina com `assertWalletMatchesLedger`.

### Implementação da User Story 2

- [X] T075 [P] [US2] Implementar `src/wagering/domain/events/wager-transaction-processed.event.ts` e `src/wagering/domain/events/wager-transaction-rejected.event.ts` (v1, `aggregateId` = `walletId`, `data` conforme a tabela de eventos da data-model §1, dinheiro como `MoneyProps`; I-33, FR-045)
- [X] T076 [US2] Implementar `src/wagering/domain/wager-rules.service.ts`: `decide({ wallet, transaction, reference, referenceAlreadyReversed })` → `Apply { direction? } | Reject { code } | PendingReference`, com a estrutura completa da ordem do I-44. Nesta história ficam ativos os passos 5.1 (`WALLET_PLAYER_MISMATCH`, `CURRENCY_MISMATCH`) e 5.5 (saldo: `INSUFFICIENT_FUNDS` e `BALANCE_LIMIT_EXCEEDED`); os passos de referência ficam para US4, US5 e US6. Faz a parte da US2 do T065 passar (FR-015)
- [X] T077 [P] [US2] Implementar `src/wagering/application/canonical-json.ts` e `src/wagering/application/payload-hash.ts` (I-25, I-57, I-58 e R-09; `amount` normalizado e `walletId` em minúsculas antes do hash; demais ids sem normalização; campos desconhecidos fora). Faz o T066 passar
- [X] T078 [P] [US2] Implementar `src/wagering/application/transaction-result.ts`: `{ transactionId, status, balance, idempotentReplay, failureCode?, retryable? }`, com `failureCode` e `retryable` só em REJECTED, e o status HTTP correspondente (201, 202 ou 422; 200 no replay de PROCESSED) (FR-054, FR-055, I-39, I-45)
- [X] T079 [US2] Implementar `src/wagering/interfaces/http/wager-transaction.dto.ts`: o schema Zod do T067 com `superRefine` para a referência por kind e o zero só em LOSS; campos desconhecidos descartados (`strip`, I-57); `walletId` normalizado para minúsculas e os demais ids preservados (I-58); OPENING → `OpeningNotAllowedError`; o header `Idempotency-Key` é validado **antes** do corpo (ausente ou vazio → `IDEMPOTENCY_KEY_REQUIRED`; mais de 255 → `VALIDATION_ERROR`; I-44 passos 1 e 2, I-48). Faz o T067 passar
- [X] T080 [US2] Implementar `src/wagering/application/submit-wager-transaction.use-case.ts`, versão sem idempotência (o replay vem na US3; data-model §3, I-44, R-07, R-19):
  - calcula o hash e cria `WagerTransaction.create` com o `correlationId` do contexto, e grava o `transactionId` no contexto da requisição (T025);
  - wallet inexistente (leitura num fork, fora da transação) → `WalletNotFoundError`;
  - pelo unit of work: `lockById`, `WagerRulesService.decide`, transição para PROCESSED ou REJECTED com `observedBalance`, `insert` da transação, `updateBalance` com versão esperada, `insert` do lançamento, eventos na outbox e `failpoints.hit('after_ledger_insert_before_commit')` antes do commit;
  - depois do commit, `failpoints.hit('after_commit_before_response')`;
  - toda query dentro da transação usa o EM recebido.
  Faz o T068, o T069 e o T070 passarem.
- [X] T081 [US2] Implementar `src/wagering/interfaces/http/wagering.controller.ts` com `POST /wagering/transactions` (`@Headers('idempotency-key')`, `@Body` com pipe Zod e resposta montada a partir de `TransactionResult` com o status do T078, sem passar pelo filtro; I-45) e registrar o `WageringModule` em `src/app.module.ts`. **Contexto de log** (constitution VIII, C1): logo depois da validação, grava `walletId` e `providerId` no contexto da requisição (T025); o use case grava `transactionId` assim que a transação é criada ou encontrada (T080), para que todo log da requisição a partir daí traga os três. Faz o T071 ao T074 passarem
- [X] T128 [US2] Revisar o diff da US2 contra `specs/001-wagering-transaction-core/review-checklist.md` (gate de Revisão da constitution, Princípios II a V), com atenção ao lock por wallet, à outbox na mesma transação e às colunas de dinheiro; registrar o resultado item a item; item reprovado volta para a task de origem antes do checkpoint
- [X] T132 [US2] Corrigir a repetição interna da submissão (R-12, R-19; correção pedida depois do checkpoint da US2): em `src/wagering/application/submit-wager-transaction.use-case.ts`, a `WagerTransaction` passa a ser criada **dentro** do callback do `unitOfWork.run`, com uma instância PENDING nova, id novo e eventIds novos a cada tentativa (o mesmo em `src/wallets/application/create-wallet.use-case.ts`: wallet, abertura e evento novos por tentativa); cada tentativa abre um fork novo do EntityManager (teste unitário em `test/unit/unit-of-work.test.ts`); o `transactionId` só entra no contexto de log depois da checagem de wallet existente. Failpoint `FAILPOINT=after_ledger_insert_before_commit:serialization_failure_once` (R-16), que lança um erro com SQLSTATE 40001 só na 1ª passagem (`test/unit/failpoints.test.ts`). Teste de integração `test/integration/transaction-retry.test.ts`: a BET termina 201 com 1 transação, 1 débito, 1 lançamento, eventos gravados uma vez e `assertWalletMatchesLedger` verde

**Checkpoint US2**: `bun test test/unit/wager-rules.test.ts test/unit/payload-hash.test.ts test/unit/wager-transaction-dto.test.ts && bun test --preload ./test/support/db-setup.preload.ts test/integration/submit-transaction.test.ts test/integration/money-columns.test.ts test/integration/atomicity.test.ts test/concurrency/hot-wallet-race.test.ts test/concurrency/wallet-isolation.test.ts test/concurrency/lock-timeout.test.ts test/concurrency/pool-pressure.test.ts`, com o T128 concluído.

---

## Phase 5: User Story 3 - Reenviar com segurança (idempotência persistente) (Priority: P1) 🎯 MVP

**Goal**: replay devolve o resultado original com o saldo observado; payload diferente → 409; escopo por provedor
(I-56); 50 envios paralelos → 1 débito.

**Independent Test**: reenvio sequencial e 50 paralelos da mesma BET; chave reutilizada com payload diferente; dois
provedores com a mesma chave.

### Testes da User Story 3 (escrever primeiro; devem falhar)

- [X] T082 [P] [US3] Escrever `test/integration/idempotency.test.ts` (US3 cenários 1, 2, 4, 5 e 6; FR-032 a FR-036, I-24, I-25, I-26, I-56). Cada teste termina com `assertWalletMatchesLedger`.
  - BET PROCESSED com saldo observado "975.00", reenviada depois que o saldo mudou para "900.00" → 200, mesmo `transactionId`, `balance` "975.00", `idempotentReplay` true e nenhum lançamento novo;
  - replay de uma REJECTED → 422 com o mesmo `failureCode` e saldo, e `idempotentReplay` true;
  - mesma chave do mesmo provedor com `amount` "26.00" → 409 `IDEMPOTENCY_CONFLICT`;
  - mesmo `(providerId, externalTransactionId)` com outra chave → 409;
  - **dois provedores (`provider-a` e `provider-b`) com a mesma `Idempotency-Key` e `externalTransactionId` diferentes → 201 e 201, duas transações e dois débitos, sem conflito** (I-56);
  - a mesma requisição com `X-Correlation-Id` diferente e campos desconhecidos extras → replay, não conflito;
  - nenhum replay nem 409 registra evento novo na outbox (FR-047).
- [X] T083 [P] [US3] Escrever `test/concurrency/idempotent-burst.test.ts` com `startCluster({ size: 3 })`, que é **critério de parada do MVP** (US3 cenário 3; SC-002, SC-005, FR-035, falha eliminatória 3):
  - a mesma BET com a mesma chave, enviada 50 vezes em paralelo distribuída nas 3 instâncias;
  - exatamente 1 DEBIT;
  - 50 de 50 respostas com o mesmo `transactionId`: 1 com `idempotentReplay` false (201) e 49 com true (200);
  - **nenhuma resposta 409, 500 ou 503**;
  - termina com `assertWalletMatchesLedger`.
- [X] T126 [P] [US3] Escrever `test/concurrency/idempotency-race.test.ts` com `startCluster({ size: 3 })` (FR-034, FR-035, I-24, I-27, I-56, R-08 passo 3; edge case "mesma chave, payload diferente, em paralelo"). Cada cenário repetido 10 vezes, com chave nova a cada vez:
  - **(a) payloads diferentes na mesma wallet**: a mesma `Idempotency-Key` do mesmo provedor em 10 requisições paralelas, 5 com `amount` "10.00" e 5 com "20.00"; o mesmo lock serializa todas;
  - **(b) `walletId` diferentes**: a mesma `Idempotency-Key` e o mesmo `externalTransactionId` em 10 requisições paralelas, metade na wallet X e metade na wallet Y (hash diferente); cada grupo trava uma wallet diferente, o que força o `INSERT` concorrente e o `23505` em `wager_tx_provider_idempotency_uq`, tratado pela releitura depois do rollback;
  - **esperado nos dois**: exatamente 1 efeito (1 transação e no máximo 1 lançamento); as requisições com o mesmo hash da vencedora recebem replay (200 ou 422, com o mesmo `transactionId` e `idempotentReplay` true, ou 201 na própria vencedora); todas as outras recebem 409 `IDEMPOTENCY_CONFLICT`; nenhuma 500 ou 503;
  - termina com `assertWalletMatchesLedger` nas wallets envolvidas.

### Implementação da User Story 3

- [X] T084 [US3] Estender `src/wagering/infrastructure/mikro-orm-wager-transaction.repository.ts` com `findByProviderAndIdempotencyKey(em, providerId, key)` e `findByProviderAndExternalId(em, providerId, externalId)`, que usam `wager_tx_provider_idempotency_uq` e `wager_tx_provider_external_uq` (I-56, data-model §2.2)
- [X] T085 [US3] Estender `src/wagering/application/submit-wager-transaction.use-case.ts` com a idempotência do research R-08:
  - **ordem do I-44 (FR-015, passos 3 e 4)**: o caminho rápido de idempotência roda **antes** da busca da wallet que o T080 criou. Assim, o replay de uma transação existente nunca passa pela checagem de wallet inexistente, e a validação do payload (passo 2) continua antes das duas;
  - **caminho rápido** num fork, fora da transação: mesmo hash → replay; hash diferente → `IdempotencyConflictError`;
  - **contexto de log** (C1): quando o caminho rápido ou a releitura encontram a transação, gravam o `transactionId` dela no contexto da requisição (T025);
  - **releitura das duas chaves sob o lock**, com o EM da transação;
  - **`idempotency-race`** (`23505` em `wager_tx_provider_idempotency_uq` ou `wager_tx_provider_external_uq`): depois do rollback, relê num fork novo e decide entre replay e conflito;
  - **replay**: monta o `TransactionResult` com os dados gravados (`status`, `failureCode`, `observed_balance`) e `idempotentReplay` true, sem registrar eventos e sem alterar o `correlation_id` gravado.
  (FR-033 a FR-035, FR-037, I-26, I-27, I-56)
- [X] T086 [US3] Ajustar `src/wagering/interfaces/http/wagering.controller.ts` para responder com o status do replay (PROCESSED → 200, PENDING_REFERENCE → 202, REJECTED → 422) e `idempotentReplay` true (I-26, I-39, FR-033). Faz o T082, o T083 e o T126 passarem
- [X] T129 [US3] Revisar o diff da US3 contra `specs/001-wagering-transaction-core/review-checklist.md` (gate de Revisão da constitution, Princípios II a V), com atenção à unicidade no banco, à releitura sob lock, ao tratamento de `23505` pelo nome da constraint e à ausência de estado em memória na decisão de idempotência; registrar o resultado item a item; item reprovado volta para a task de origem antes do checkpoint

**Checkpoint US3 (fim do MVP)**: `bun test --preload ./test/support/db-setup.preload.ts test/integration/idempotency.test.ts test/concurrency/idempotent-burst.test.ts test/concurrency/idempotency-race.test.ts test/concurrency/hot-wallet-race.test.ts`, com o T129 concluído. O MVP só está pronto com o 100/80/80 (T071) e as 50 BETs paralelas (T083) verdes em 3 instâncias.

---

## Phase 6: User Story 4 - Registrar o resultado da rodada com WIN e LOSS (Priority: P2)

**Goal**: WIN credita; LOSS (inclusive "0.00") fica PROCESSED sem lançamento; a referência opcional aponta só para
BET da mesma rodada.

**Independent Test**: WIN e LOSS com e sem referência sobre uma BET PROCESSED.

### Testes da User Story 4 (escrever primeiro; devem falhar)

- [X] T087 [P] [US4] Estender `test/unit/wager-rules.test.ts` com WIN e LOSS (I-12, I-13, I-14, I-46, FR-017, FR-018, FR-021, FR-022):
  - LOSS → `Apply` sem direção;
  - WIN → `Apply(CREDIT)`;
  - WIN ou LOSS referenciando uma BET com rodada, jogador, wallet ou moeda diferente → `REFERENCE_MISMATCH`;
  - WIN ou LOSS referenciando algo que não é BET → `INVALID_REFERENCE_KIND`;
  - `REFERENCE_MISMATCH` prevalece sobre `INVALID_REFERENCE_KIND`.
- [X] T088 [P] [US4] Escrever `test/integration/win-loss.test.ts` (US4 cenários 1 a 5; FR-017, FR-018, FR-021, FR-022, I-02, I-12, I-46). Cada teste termina com `assertWalletMatchesLedger`.
  - WIN "50.00" sem referência → 201 e saldo +50 com CREDIT;
  - LOSS referenciando uma BET PROCESSED → 201, sem lançamento, saldo e `version` iguais, só `WagerTransactionProcessed` na outbox;
  - WIN com rodada R2 → 422 `REFERENCE_MISMATCH`;
  - LOSS referenciando uma WIN → 422 `INVALID_REFERENCE_KIND`;
  - **LOSS "0.00" → 201 PROCESSED, sem lançamento, saldo e `version` inalterados**.

### Implementação da User Story 4

- [X] T089 [US4] Ativar em `src/wagering/domain/wager-rules.service.ts` o passo 5.2 do I-44 para WIN e LOSS (`REFERENCE_MISMATCH`, depois `INVALID_REFERENCE_KIND`) e a decisão de LOSS sem direção. Faz o T087 passar (I-14, I-46)
- [X] T090 [US4] Estender `src/wagering/application/submit-wager-transaction.use-case.ts`:
  - quando há referência, carrega-a sob o lock com `findByProviderAndExternalId(em, providerId, referenceExternalTransactionId)` e grava `reference_transaction_id` quando ela é resolvida;
  - LOSS PROCESSED não atualiza a wallet nem insere lançamento e registra só `WagerTransactionProcessed` (I-12, FR-018, FR-045).
  Faz o T088 passar.

**Checkpoint US4**: `bun test test/unit/wager-rules.test.ts && bun test --preload ./test/support/db-setup.preload.ts test/integration/win-loss.test.ts`

---

## Phase 7: User Story 5 - Reverter com REFUND e ROLLBACK uma única vez (Priority: P2)

**Goal**: REFUND credita uma BET; ROLLBACK inverte BET, WIN ou REFUND; uma reversão por transação no total;
códigos `AMOUNT_MISMATCH`, `ALREADY_REVERSED`, `REVERSAL_WOULD_OVERDRAW` e `REFERENCE_REJECTED`.

**Independent Test**: cada combinação de reversão e referência; REFUND × ROLLBACK simultâneos.

### Testes da User Story 5 (escrever primeiro; devem falhar)

- [X] T091 [P] [US5] Estender `test/unit/wager-rules.test.ts` com as reversões (I-12, I-14 a I-18, FR-019 a FR-026):
  - REFUND de BET → `Apply(CREDIT)`;
  - ROLLBACK de BET → CREDIT; de WIN → DEBIT; de REFUND → DEBIT;
  - REFUND de algo que não é BET → `INVALID_REFERENCE_KIND`; ROLLBACK de LOSS, de ROLLBACK ou de OPENING → `INVALID_REFERENCE_KIND`;
  - valor diferente → `AMOUNT_MISMATCH`;
  - referência REJECTED ou FAILED → `REFERENCE_REJECTED`;
  - `referenceAlreadyReversed` → `ALREADY_REVERSED`;
  - ROLLBACK de WIN acima do saldo → `REVERSAL_WOULD_OVERDRAW`, distinto de `INSUFFICIENT_FUNDS`;
  - **precedência do I-44**: `REFERENCE_MISMATCH` > `INVALID_REFERENCE_KIND` > `AMOUNT_MISMATCH` > `REFERENCE_REJECTED` > `ALREADY_REVERSED` > saldo.
- [X] T092 [P] [US5] Escrever `test/integration/reversals.test.ts` (US5 cenários 1 a 9; FR-019 a FR-026, I-12 a I-18). Cada teste termina com `assertWalletMatchesLedger`.
  - REFUND de BET → CREDIT;
  - ROLLBACK de WIN → DEBIT;
  - REFUND seguido de ROLLBACK da mesma BET → 422 `ALREADY_REVERSED`, sem crédito extra;
  - REFUND "20.00" para uma BET de "25.00" → 422 `AMOUNT_MISMATCH`;
  - ROLLBACK de WIN "50.00" com saldo "30.00" → 422 `REVERSAL_WOULD_OVERDRAW`, saldo "30.00";
  - REFUND de WIN e ROLLBACK de LOSS ou de ROLLBACK → 422 `INVALID_REFERENCE_KIND`;
  - REFUND de BET REJECTED → 422 `REFERENCE_REJECTED`;
  - REFUND ou ROLLBACK sem referência → 400;
  - ROLLBACK de um REFUND → DEBIT.
- [X] T093 [P] [US5] Escrever `test/concurrency/reversal-race.test.ts` com `startCluster({ size: 3 })` (US5 cenário 4; SC-003, FR-025, I-16, falha eliminatória 3). Repetir 20 vezes:
  - um REFUND e um ROLLBACK simultâneos da mesma BET PROCESSED;
  - no máximo 1 PROCESSED; o outro termina REJECTED `ALREADY_REVERSED`;
  - exatamente 1 CREDIT de reversão;
  - `assertWalletMatchesLedger` em cada repetição.

### Implementação da User Story 5

- [X] T094 [US5] Ativar em `src/wagering/domain/wager-rules.service.ts` as regras de REFUND e ROLLBACK nos passos 5.2 (`INVALID_REFERENCE_KIND` por kind, `AMOUNT_MISMATCH`), 5.3 (REJECTED ou FAILED → `REFERENCE_REJECTED`), 5.4 (`ALREADY_REVERSED`) e 5.5 (`REVERSAL_WOULD_OVERDRAW`), com a direção inversa do ROLLBACK. Faz o T091 passar (I-44)
- [X] T095 [US5] Estender `src/wagering/infrastructure/mikro-orm-wager-transaction.repository.ts` com `existsProcessedReversal(em, referenceTransactionId)`: `SELECT 1 ... WHERE reference_transaction_id = ? AND kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'`, que usa `wager_tx_single_reversal_uq` (I-16)
- [X] T096 [US5] Estender `src/wagering/application/submit-wager-transaction.use-case.ts` (R-10, R-12, FR-025):
  - sob o lock, consulta `existsProcessedReversal` só quando a referência é PROCESSED e o kind é REFUND ou ROLLBACK;
  - em `reversal-race` (`23505` em `wager_tx_single_reversal_uq`), repete o use case **uma** vez; se repetir, `InternalError`. A repetição recomeça do zero, como no T132: transação de domínio, ids e eventos novos e fork novo. **Teste de integração** (em `test/integration/reversals.test.ts` ou arquivo próprio): o `23505` do índice de reversão provocado só na 1ª passagem termina com 1 reversão, 1 lançamento e `assertWalletMatchesLedger` verde.
  Faz o T092 e o T093 passarem.
- [X] T130 [US5] Revisar o diff da US5 contra `specs/001-wagering-transaction-core/review-checklist.md` (gate de Revisão da constitution, Princípios II a V), com atenção à reversão única garantida pelo índice parcial e à checagem sob o lock da wallet; registrar o resultado item a item; item reprovado volta para a task de origem antes do checkpoint

**Checkpoint US5**: `bun test test/unit/wager-rules.test.ts && bun test --preload ./test/support/db-setup.preload.ts test/integration/reversals.test.ts test/concurrency/reversal-race.test.ts`, com o T130 concluído.

---

## Phase 8: User Story 6 - Aceitar como pendente a operação que chega antes da referência (Priority: P2)

**Goal**: referência ausente ou pendente → PENDING_REFERENCE (202), sem efeito no saldo, com evento; replay → 202.

**Independent Test**: ROLLBACK de um id externo inexistente; referência existente mas pendente; replay.

### Testes da User Story 6 (escrever primeiro; devem falhar)

- [ ] T097 [P] [US6] Estender `test/unit/wager-rules.test.ts` com o passo 5.3 do I-44 (I-15, I-44, FR-023, FR-024):
  - referência ausente, PENDING ou PENDING_REFERENCE → `PendingReference`;
  - **precedência**: referência existente, PENDING_REFERENCE e com rodada diferente → `REFERENCE_MISMATCH`; REFUND com valor diferente e referência pendente → `AMOUNT_MISMATCH`;
  - `WALLET_PLAYER_MISMATCH` prevalece mesmo com a referência ausente.
  Estender também `test/unit/wager-transaction.test.ts`: `markPendingReference(observedBalance, nextAttemptAt)` define `referenceAttempts` 0 e `nextReferenceAttemptAt` (I-11, I-21).
- [ ] T098 [P] [US6] Escrever `test/integration/pending-reference.test.ts` (US6 cenários 1 a 3; FR-023, FR-045, I-15, I-21, I-26, I-39). Cada teste termina com `assertWalletMatchesLedger`.
  - ROLLBACK de um id externo inexistente → 202 `PENDING_REFERENCE`, saldo observado inalterado, sem `failureCode`, sem lançamento;
  - por SQL: `reference_attempts` 0, `next_reference_attempt_at` = criação + 5 s, e `WagerTransactionPendingReference` na outbox;
  - **payload desse evento** (FR-047): `eventId` igual ao `id` da linha da outbox; `aggregateId` = `walletId`; `correlationId` = o da requisição; `occurredAt` em ISO-8601; `eventType` "WagerTransactionPendingReference"; `version` 1; `data` com os identificadores, `kind`, `money` como string, `referenceExternalTransactionId` e `nextAttemptAt` igual ao `next_reference_attempt_at` gravado; nenhum `WalletBalanceChanged`;
  - referência existente em PENDING_REFERENCE → a reversão também fica PENDING_REFERENCE;
  - replay → 202 com o mesmo `transactionId` e `idempotentReplay` true;
  - a referência de outro provedor com o mesmo id externo não é encontrada → PENDING_REFERENCE.

### Implementação da User Story 6

- [ ] T099 [P] [US6] Implementar `src/wagering/domain/events/wager-transaction-pending-reference.event.ts` (v1, `data` com os identificadores, `kind`, `money`, `referenceExternalTransactionId` e `nextAttemptAt`; I-33)
- [ ] T100 [US6] Ativar em `src/wagering/domain/wager-rules.service.ts` o passo 5.3 para referência ausente, PENDING ou PENDING_REFERENCE → `PendingReference`, depois das checagens de consistência quando a referência existe. Faz o T097 passar (I-15, I-44)
- [ ] T101 [US6] Estender `src/wagering/application/submit-wager-transaction.use-case.ts`: na decisão `PendingReference`, `markPendingReference` com `nextAttemptAt` = `clock.now()` + 5 s (base do I-21) e `observedBalance` = saldo atual; insere a transação e `WagerTransactionPendingReference`, sem tocar na wallet; `TransactionResult` com status 202 (I-39). Faz o T098 passar

**Checkpoint US6**: `bun test test/unit/wager-rules.test.ts test/unit/wager-transaction.test.ts && bun test --preload ./test/support/db-setup.preload.ts test/integration/pending-reference.test.ts`

---

## Phase 9: User Story 7 - Decidir o próximo passo sem interpretar texto (Priority: P2)

**Goal**: as cinco situações sempre distinguíveis, com o mesmo formato em todos os endpoints; correlationId em
todas as respostas.

**Independent Test**: provocar cada situação em cada endpoint aplicável; correlationId válido, inválido e ausente.

### Testes da User Story 7 (escrever primeiro; devem falhar)

- [ ] T102 [P] [US7] Escrever `test/integration/http-contract.test.ts` (US7 cenários 1 a 3; FR-054 a FR-058, SC-009, SC-011, I-38, I-39, I-45, I-48, I-50):
  - **cinco situações na submissão**: payload inválido → 400; conflito de idempotência → 409; rejeição de negócio → 422 com corpo `TransactionResult`; aceite pendente → 202; falha transitória → 503 com `Retry-After`, provocada pelo lock externo do T073; os cinco status são distintos;
  - **envelope**: 400, 404, 409 e 503 usam `{ error: { code, message, retryable, correlationId } }`, com `retryable` de acordo com a taxonomia §7;
  - **edge cases da spec**: `Idempotency-Key` ausente ou vazio → `IDEMPOTENCY_KEY_REQUIRED`; chave com mais de 255 → `VALIDATION_ERROR`; JSON malformado → 400 `VALIDATION_ERROR`; `playerId` com mais de 255 → 400; `walletId` malformado no corpo → 400;
  - **I-59**: rota inexistente (ex.: `GET /nao-existe`) e método inexistente numa rota existente (ex.: `DELETE /wallets`) → 404 `ROUTE_NOT_FOUND`, `retryable` false, no envelope do I-38; `Content-Type` não suportado (ex.: `text/plain`) e corpo acima do limite do servidor → 400 `VALIDATION_ERROR`, sem ecoar o corpo;
  - **ordem do I-44 (FR-015, passos 1 a 3)**, com casos combinados: chave ausente **e** corpo inválido → 400 `IDEMPOTENCY_KEY_REQUIRED` (o header vem antes do corpo); corpo inválido com uma chave já usada por uma transação existente → 400 `VALIDATION_ERROR`, **não** 409 (a validação vem antes da idempotência); o replay de uma transação existente não depende da busca da wallet (passo 3 antes do 4);
  - **sem eco**: nenhuma `message` contém o `amount` enviado;
  - **SC-011**: cada operação sem disputa responde em menos de 1 s.
- [ ] T103 [P] [US7] Escrever `test/integration/correlation-id.test.ts`, o teste de correlationId válido, inválido e ausente (FR-060, I-53, R-14):
  - `X-Correlation-Id: abc-123` → volta igual no header e em `error.correlationId` quando há erro, e fica gravado em `wager_transactions.correlation_id` e no `correlationId` dos eventos da outbox;
  - **ausente** → o header de resposta traz um UUIDv7 gerado;
  - **inválido** (129 caracteres, com espaço, vazio) → nunca 400; a operação segue e a resposta traz um UUIDv7 gerado;
  - **replay** com outro correlationId → a resposta usa o correlationId da requisição atual, o `correlation_id` gravado não muda e nenhum evento novo é registrado;
  - vale também para `POST /wallets`;
  - **logs da requisição** (constitution VIII, FR-058, FR-060): o teste captura o stdout da app (instância via `startCluster` com 1 processo, ou um destino de log injetado no `startApp`) e, para uma BET processada, confere que as linhas JSON da requisição trazem `correlationId` igual ao da resposta e `walletId`, `providerId` e `transactionId` corretos a partir do momento em que são conhecidos; e que **nenhuma** linha contém as chaves `amount` ou `money` nem o valor enviado. O mesmo para um `POST /wallets`, que traz `correlationId` e `walletId`.

### Implementação da User Story 7

- [ ] T104 [US7] Ajustar `src/platform/http/global-exception.filter.ts` para mapear os erros do próprio Nest e do body-parser: JSON malformado, `Content-Type` diferente de JSON, corpo acima do limite e corpo vazio viram 400 `VALIDATION_ERROR` no envelope do I-38, sem ecoar o corpo; rota ou método inexistente vira 404 `ROUTE_NOT_FOUND` (I-59; o mapeamento do filtro já foi feito no ajuste do I-59, aqui fica a cobertura ponta a ponta) (FR-056, FR-058). Faz o T102 passar
- [ ] T105 [US7] Garantir em `src/wallets/application/create-wallet.use-case.ts` e em `src/wagering/application/submit-wager-transaction.use-case.ts` que o `correlationId` do contexto é passado para a entidade e para todos os eventos, e que o replay não altera o valor gravado (FR-060, I-53). Faz o T103 passar

**Checkpoint US7**: `bun test --preload ./test/support/db-setup.preload.ts test/integration/http-contract.test.ts test/integration/correlation-id.test.ts`

---

## Phase 10: User Story 9 - Falha momentânea sem efeito parcial (Priority: P2)

**Goal**: banco indisponível, pool esgotado ou queda depois do commit → 503 (ou replay no reenvio), sem efeito
parcial.

**Independent Test**: proxy TCP derrubado; pool com 1 conexão ocupada; processo morto depois do commit.

### Testes da User Story 9 (escrever primeiro; devem falhar)

- [ ] T106 [P] [US9] Criar `test/support/tcp-proxy.ts`: proxy TCP entre a app e o PostgreSQL (`Bun.listen`/`Bun.connect`), com `cut()` para derrubar as conexões existentes e recusar novas, e `restore()` (R-17)
- [ ] T107 [US9] Escrever `test/integration/db-unavailable.test.ts`, com a app apontando para o proxy do T106 (US9 cenários 1 a 3; FR-043, I-34, SC-007). Termina com `assertWalletMatchesLedger`.
  - com o proxy cortado, BET e `POST /wallets` → 503 `SERVICE_UNAVAILABLE`, `retryable` true e `Retry-After`;
  - corte no meio de uma transação → nenhuma linha parcial;
  - depois do `restore()`, sem reiniciar a app, o reenvio → 201 com `idempotentReplay` false e exatamente 1 efeito.
- [ ] T108 [P] [US9] Escrever `test/integration/pool-acquire-timeout.test.ts`, o teste de timeout de aquisição do pool (FR-043, FR-059, I-51, spike S-09):
  - `startApp` com `DB_POOL_MAX=1`, `WALLET_LOCK_TIMEOUT_MS=200`, `DB_POOL_ACQUIRE_TIMEOUT_MS=500` e `HTTP_SERVER_TIMEOUT_MS=3000`;
  - a única conexão é ocupada por `app.get(ORM).em.fork().execute('select pg_sleep(2)')`, pelo handle in-process que o `app-harness` já expõe;
  - **sem endpoint de teste e sem failpoint**: nada novo no código de produção. Nenhuma rota de teste existe em `src/` (o T118 verifica), e o teste não usa nenhum failpoint. Os failpoints da feature (`after_ledger_insert_before_commit`, `after_commit_before_response`), usados no T070 e no T109, ficam atrás da porta `FAILPOINTS`, que não faz nada com `NODE_ENV=production` (I-40, T014, T027);
  - a BET submetida → 503 `SERVICE_UNAVAILABLE` com `Retry-After` em 450–1500 ms, sem efeito;
  - depois de liberar a conexão (fim do `pg_sleep`), o reenvio → 201 com exatamente 1 efeito;
  - termina com `assertWalletMatchesLedger`.
- [ ] T109 [P] [US9] Escrever `test/concurrency/crash-recovery.test.ts` (SC-007, I-40, R-16):
  - uma instância com `FAILPOINT=after_commit_before_response` recebe uma BET; a conexão cai e o processo sai;
  - outra instância, sem failpoint e no mesmo banco, recebe o reenvio → 200 com o mesmo `transactionId` do commit, `idempotentReplay` true e exatamente 1 DEBIT;
  - termina com `assertWalletMatchesLedger`.

### Implementação da User Story 9

- [ ] T110 [US9] Endurecer `src/platform/persistence/unit-of-work.ts` e `src/platform/persistence/pg-errors.ts` (R-12, FR-043, I-34):
  - erro durante o `COMMIT` (perda de conexão) e erro de conexão no meio da transação → `ServiceUnavailableError` depois do rollback;
  - leituras fora de transação, como o caminho rápido e a busca da wallet, também passam pelo classificador;
  - a app continua no ar com o banco fora e volta a atender quando ele volta, sem reinício (o pool descarta conexões quebradas).
  Faz o T107 ao T109 passarem.

**Checkpoint US9**: `bun test --preload ./test/support/db-setup.preload.ts test/integration/db-unavailable.test.ts test/integration/pool-acquire-timeout.test.ts test/concurrency/crash-recovery.test.ts`

---

## Phase 11: User Story 8 - Auditar wallet, ledger e transações (Priority: P3)

**Goal**: `GET /wallets/:id`, ledger paginado com cursor opaco e estável, e transação por id interno ou por
(provedor, id externo).

**Independent Test**: paginar o ledger inteiro durante escrita; consultar transações pelos dois caminhos; 404 e 400.

### Testes da User Story 8 (escrever primeiro; devem falhar)

- [ ] T111 [P] [US8] Escrever `test/unit/ledger-cursor.test.ts` (I-36, I-47):
  - `encode(seq)` gera o base64url do `seq` em decimal, e `decode` faz a volta;
  - `decode` recusa base64url inválido, texto que não é inteiro de 1 a 19 dígitos e valor acima de 9223372036854775807;
  - o `seq` é tratado como string ou `bigint`, nunca `number`;
  - `limit` padrão 50; não inteiro, < 1 ou > 200 → erro.
- [ ] T112 [P] [US8] Escrever `test/integration/queries.test.ts` (US8 cenários 3 a 5; FR-049, FR-052, FR-053, I-07, I-50, I-55):
  - `GET /wallets/:id` → `{ id, playerId, balance, version }`;
  - `GET /wagering/transactions/:id` e `GET /providers/:p/wagering/transactions/:x` devolvem a mesma transação, com status 200 mesmo quando ela é REJECTED ou PENDING_REFERENCE, e trazem tipo, valor, status, `failureCode`, referências e `observedBalance`;
  - a abertura é consultável pelo id interno;
  - wallet inexistente → 404 `WALLET_NOT_FOUND`; transação inexistente pelas duas rotas → 404 `TRANSACTION_NOT_FOUND` com `retryable` false;
  - `walletId` ou `transactionId` malformado na rota → 400 `VALIDATION_ERROR`; o mesmo id em maiúsculas encontra a mesma wallet ou transação (I-58);
  - providerId "system" na rota → 400;
  - **SC-011**: cada uma das rotas GET (wallet, ledger, transação por id e por provedor) responde em menos de 1 s, sem disputa.
- [ ] T113 [P] [US8] Escrever `test/integration/ledger-pagination.test.ts` (US8 cenários 1, 2 e 4; FR-050, FR-051, SC-010, I-36, I-47):
  - 120 lançamentos paginados com `limit` 50 → páginas de 50, 50 e 20, em ordem crescente, cada lançamento uma vez, e `nextCursor` null no fim;
  - com BETs sendo criadas em paralelo durante a paginação → nenhum lançamento já visto se repete nem é pulado;
  - cursor adulterado, `limit` 0, 201 ou "abc" → 400 `VALIDATION_ERROR`;
  - wallet inexistente → 404;
  - termina com `assertWalletMatchesLedger`.

### Implementação da User Story 8

- [ ] T114 [P] [US8] Implementar `src/wallets/application/ledger-cursor.ts`. Faz o T111 passar
- [ ] T115 [US8] Estender os repositórios (EM por parâmetro, SQL com `?`; FR-050, FR-052):
  - `src/wallets/infrastructure/mikro-orm-ledger.repository.ts`: `listPage(em, walletId, afterSeq, limit)` com `WHERE wallet_id = ? AND seq > ? ORDER BY seq LIMIT ?`, buscando `limit + 1`;
  - `src/wagering/infrastructure/mikro-orm-wager-transaction.repository.ts`: `findById(em, id)`.
- [ ] T116 [US8] Implementar `src/wallets/application/get-wallet.use-case.ts`, `src/wallets/application/list-ledger.use-case.ts` (`nextCursor` vindo do item extra) e `src/wagering/application/get-transaction.use-case.ts` (por id e por provedor + id externo; `TransactionNotFoundError`), todos em fork de leitura, sem transação de escrita (FR-049 a FR-053, I-55)
- [ ] T117 [US8] Expor as rotas de consulta (FR-049 a FR-053, contrato em `contracts/openapi.yaml`):
  - **`src/wallets/interfaces/http/wallets.controller.ts`**: `GET /wallets/:walletId` e `GET /wallets/:walletId/ledger`;
  - **`src/wagering/interfaces/http/wagering.controller.ts`**: `GET /wagering/transactions/:transactionId`;
  - **`src/wagering/interfaces/http/providers.controller.ts`**: `GET /providers/:providerId/wagering/transactions/:externalTransactionId`;
  - **validação**: params e query com Zod (UUID; strings de 1 a 255; "system" recusado; `limit` e `cursor` do T114);
  - **representação** `Transaction` e `LedgerPage` conforme o contrato.
  Faz o T112 e o T113 passarem.

**Checkpoint US8**: `bun test test/unit/ledger-cursor.test.ts && bun test --preload ./test/support/db-setup.preload.ts test/integration/queries.test.ts test/integration/ledger-pagination.test.ts`

---

## Phase 12: Polish & Cross-Cutting Concerns

**Purpose**: documentação, guardrails automáticos, limpeza do spike e a suíte completa.

- [ ] T118 [P] Escrever `test/unit/conventions.test.ts`, guardrail que varre o código-fonte e aponta arquivo e linha de cada violação (constitution II, V, VI e VII; falhas eliminatórias 1 e 8; plan, "Isolamento de testes" e "Guardrails de código"):
  - **Limpeza de dados em `test/**`**: `TRUNCATE` e `DELETE` são proibidos **como limpeza de dados**. Os padrões procurados são comandos SQL, não mensagens de erro: `/\bDELETE\s+FROM\b/i` e `/\bTRUNCATE\s+(TABLE\s+)?(ONLY\s+)?"?[a-z_][a-z0-9_]*"?\s*($|[;'"\x60,)]|\s+(CASCADE|RESTRICT|RESTART|CONTINUE)\b)/i`.
    - **Fora da lista de permitidos**: qualquer ocorrência falha.
    - **Lista de permitidos**: só `test/integration/schema-guards.test.ts` e `test/integration/migrations.test.ts`. Nesses arquivos, cada ocorrência precisa estar escrita inline como argumento de uma chamada envolvida por `expect(...)` e seguida de `.rejects` no mesmo statement. A checagem procura, para cada ocorrência, um `expect(` aberto antes dela e um `.rejects` depois, sem `;` entre os três. SQL guardado em variável e executado fora de `expect(...).rejects` falha.
  - **Desligar guardas em `test/**`**: nenhum `session_replication_role` nem `DISABLE TRIGGER`, em qualquer arquivo e sem lista de permitidos.
  - **Sem mocks em `test/integration/**` e `test/concurrency/**`** (constitution VII, falha eliminatória 8):
    - nenhum `mock(` nem `mock.module(`, e nenhum import de `mock` de `bun:test`;
    - nenhum `jest.`;
    - nenhum `spyOn(` cujo primeiro argumento seja repositório, ORM, EntityManager, pool ou cliente de banco (`/spyOn\(\s*[\w.]*(repo|repository|orm|entityManager|\bem\b|pool|db|client)/i`);
    - nenhum banco em memória: `pg-mem`, `better-sqlite3`, `bun:sqlite`, `:memory:`, nem classes `InMemory*Repository`.
    Os doubles de `test/support/fakes.ts` (`FixedClock`, `SequentialIdGenerator`) e o `exit` injetado nos failpoints continuam permitidos.
  - **`src/**`**: nenhum placeholder `$1` em SQL, nenhum `parseFloat(`, nenhum `Number(` aplicado a `amount` ou `balance`, e nenhuma rota de teste (controller ou rota com `test`, `debug` ou `__` no path).
  - **`src/**/domain/**`**: imports só de `src/**/domain/**` (de qualquer módulo), de `src/shared-kernel/domain/**` e do pacote `decimal.js` (o tipo decimal exato sobre o qual o `Money` é construído, R-03; desvio aceito em 2026-11-08); nunca de `application`, `infrastructure`, `interfaces`, `platform`, `@nestjs`, `@mikro-orm` nem de qualquer outro pacote externo (plan, "Structure Decision"). Autoteste: **passam** `import { Wallet } from '../../wallets/domain/wallet.ts'`, `import { Money } from '../../shared-kernel/domain/money.ts'` dentro de `src/wagering/domain/` e `import Decimal from 'decimal.js'` dentro de `src/shared-kernel/domain/`; **falham** `import { x } from '../application/payload-hash.ts'`, `import { y } from '../../platform/persistence/pg-errors.ts'`, `import { z } from '../infrastructure/wager-transaction.schema.ts'`, `import { Inject } from '@nestjs/common'`, `import { LockMode } from '@mikro-orm/core'`, `import { z } from 'zod'` e `import Big from 'big.js'` (outro pacote externo, mesmo que também decimal).
  - **`src/**/domain/**` e `src/**/application/**`**: nenhum `new Date()` **sem argumento** (padrão `/\bnew\s+Date\s*\(\s*\)/`) e nenhum `Date.now(`, que leem o relógio; tempo só pela porta `Clock`. `new Date(x)` **com argumento** é permitido, porque só constrói uma data a partir de um valor já conhecido (ex.: `new Date(now.getTime() + delayMs)`). Nenhum `randomUUID(`, `randomUUIDv7(` (inclusive `Bun.randomUUIDv7(` e `crypto.randomUUID(`); ids só pela porta `IdGenerator` (constitution VI).
  - **Autoteste do guardrail**: cada regra roda contra trechos de código de exemplo embutidos no próprio teste, um que deve passar e um que deve falhar; por exemplo, `await expect(db.query('DELETE FROM wallet_ledger_entries')).rejects.toThrow()` passa na lista de permitidos e a mesma query fora de `expect` falha. Para a regra do relógio: **passam** `new Date(now.getTime() + 5000)`, `new Date(state.createdAt)` e `new Date('2026-11-07T00:00:00Z')`; **falham** `new Date()`, `new Date( )`, `const t = new Date ()` e `Date.now()`.
- [ ] T119 [P] Escrever `README.md`: pré-requisitos (Bun 1.4.4, Docker); `bun install`; `docker compose up -d` e `--profile cluster`; variáveis de ambiente do `.env.example` e a hierarquia de timeouts; `migrate:up` e `migrate:down`; todos os scripts de teste e o que exigem; exemplos do quickstart §4; a limitação do `SIGTERM` gracioso no Windows; link para o `ARCHITECTURE.md` da raiz e para `docs/interpretacoes.md` (constitution IX, plan "Documentação")
- [ ] T120 [P] Escrever `ARCHITECTURE.md` **na raiz do repositório** (constitution IX, enunciado §14, plan "Documentação"), cobrindo:
  - justificativa do MikroORM (EntitySchema, mappers, escritas explícitas; R-04 a R-06);
  - mapeamento do Money (R-03, I-04, `DecimalType('string')`);
  - estratégia transacional e de concorrência (R-07, R-08, R-19) e hierarquia de timeouts (R-11);
  - `payloadHash` (I-25) e idempotência por provedor (I-56);
  - máquina de estados (I-11);
  - taxonomia de `failureCode` e mapeamento HTTP (I-39, I-45, §7);
  - triggers de guarda e por que existem;
  - autenticação: guard no-op e desenho com Keycloak (I-41);
  - **política de retry, DLQ e PENDING_REFERENCE** (constitution IX):
    - **retry**: falha transitória responde 503 `SERVICE_UNAVAILABLE` com `Retry-After` (`RETRY_AFTER_SECONDS`), sem efeito; o reenvio é seguro por idempotência; deadlock (`40P01`) e falha de serialização (`40001`) são repetidos internamente até 2 vezes antes do 503 (R-12);
    - **PENDING_REFERENCE**: nesta feature, só o agendamento inicial (`reference_attempts` 0, `next_reference_attempt_at` = criação + 5 s, base do I-21); o worker com backoff exponencial, teto, jitter, limite de 10 tentativas ou TTL de 10 min e `REFERENCE_NOT_FOUND` fica para a feature 2;
    - **DLQ**: fora do escopo desta feature (não há consumo de fila), prevista para a feature de mensageria (I-30);
  - limitações: pool sob wallet muito disputada, sem balanceador, sem métricas e health nesta feature, `SIGTERM` gracioso só verificável em Linux.
- [ ] T121 Remover o spike (só depois que o T045, o T046 e o T047 estiverem verdes e o scaffold estiver pronto): rodar `docker compose -f spike/docker-compose.yml down -v` e apagar o diretório `spike/` inteiro. Os resultados ficam em `research.md` §0; conferir que nada em `src/`, `test/` ou `scripts/` importa de `spike/`
- [ ] T131 Revisar o diff completo da feature contra `specs/001-wagering-transaction-core/review-checklist.md` (gate de Revisão da constitution, Princípios II a V), incluindo o que entrou depois das revisões T127 a T130 (US4, US6, US7, US9, US8 e Polish); registrar o resultado item a item na descrição da entrega; item reprovado volta para a task de origem antes do T122
- [ ] T122 Executar a suíte completa com o PostgreSQL do Compose, pelos scripts de `package.json`: `bun run typecheck && bun run test` (unit, integration e concurrency). Tudo verde, inclusive o T118, e registrar a saída (contagem de testes e duração) na descrição da entrega
- [ ] T123 Validar o quickstart de ponta a ponta: `docker compose --profile cluster up -d --build`, seguido dos fluxos do `quickstart.md` §4 nas portas 3001 a 3003 (abertura, BET e replay entre instâncias, rejeição, reversão, pendência, LOSS "0.00", contrato de erros e `docker compose stop postgres` → 503 → `start` → reenvio com 1 efeito)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: sem dependências.
- **Foundational (Phase 2)**: depende do Setup e **bloqueia todas as histórias**.
- **US1 (Phase 3)**: depende da Fundação. Traz `Wallet`, `WagerTransaction`, os schemas e os repositórios básicos.
- **US2 (Phase 4)**: depende da US1 (wallet aberta, entidades e repositórios).
- **US3 (Phase 5)**: depende da US2, porque estende o use case de submissão.
- **US4 (Phase 6)**: depende da US3 (usa `findByProviderAndExternalId`).
- **US5 (Phase 7)**: depende da US4 (carga da referência).
- **US6 (Phase 8)**: depende da US5 (passo 5.3 completo do I-44).
- **US7 (Phase 9)**: depende da US6 (precisa das cinco situações, inclusive o 202).
- **US9 (Phase 10)**: depende da US3 (replay no reenvio). Pode correr em paralelo com US4 a US7 se houver equipe, porque não toca as regras.
- **US8 (Phase 11)**: depende da US1 e da US2 (precisa de lançamentos). Pode correr em paralelo com US3 a US9.
- **Polish (Phase 12)**: depende de todas as histórias. O T121 depende só do T045 ao T047. O T131 (revisão final) vem depois do T118 ao T121 e antes do T122.

### Ids fora de ordem

Os ids T001 a T123 são estáveis. As tasks acrescentadas depois da análise (T124 a T131) ficam na fase e na posição
onde devem ser executadas: T124 e T125 na Fundação, T126 na US3, T127 na US1, T128 na US2, T129 na US3, T130 na US5
e T131 no Polish. A ordem de execução é a ordem em que aparecem no arquivo, não a ordem numérica.

### Ordem dentro de cada história

Testes de domínio puro → testes de integração e concorrência (falhando) → domínio → infraestrutura → use case →
controller → testes verdes → checkpoint.

### Arquivos compartilhados (sem [P] entre si)

- `src/wagering/domain/wager-rules.service.ts`: T076 → T089 → T094 → T100
- `src/wagering/application/submit-wager-transaction.use-case.ts`: T080 → T085 → T090 → T096 → T101 → T105
- `test/unit/wager-rules.test.ts`: T065 → T087 → T091 → T097
- `src/wagering/infrastructure/mikro-orm-wager-transaction.repository.ts`: T062 → T084 → T095 → T115

---

## Parallel Examples

### Fundação: testes

```bash
Task: "test/unit/money.test.ts (T008)"
Task: "test/unit/app-config.test.ts (T011)"
Task: "test/unit/correlation.test.ts (T012)"
Task: "test/unit/pg-errors.test.ts (T015)"
Task: "test/unit/global-exception-filter.test.ts (T016)"
```

### Fundação: migrations

```bash
Task: "migrations/Migration20261107000100.ts (T032)"
Task: "migrations/Migration20261107000200.ts (T033)"
Task: "migrations/Migration20261107000300.ts (T034)"
Task: "migrations/Migration20261107000400.ts (T035)"
```

### User Story 1

```bash
Task: "test/unit/wallet.test.ts (T048)"
Task: "test/unit/wager-transaction.test.ts (T050)"
Task: "test/integration/create-wallet.test.ts (T052)"
Task: "test/concurrency/concurrent-wallet-creation.test.ts (T053)"
# depois:
Task: "src/wallets/infrastructure/*.schema.ts (T059)"
Task: "src/wagering/infrastructure/wager-transaction.schema.ts (T060)"
Task: "src/outbox/infrastructure/* (T061)"
```

### User Story 2: testes de concorrência

```bash
Task: "test/concurrency/hot-wallet-race.test.ts (T071)"
Task: "test/concurrency/wallet-isolation.test.ts (T072)"
Task: "test/concurrency/lock-timeout.test.ts (T073)"
Task: "test/concurrency/pool-pressure.test.ts (T074)"
```

---

## Implementation Strategy

### MVP: US1 + US2 + US3

1. Phase 1 (Setup) e Phase 2 (Fundação), com o checkpoint verde.
2. US1: abertura auditável e 409 com `walletId` sob concorrência.
3. US2: BET com lock por wallet, colunas de dinheiro como string, atomicidade e contenção.
4. US3: idempotência persistente, escopo por provedor e replay.
5. **Critério de parada do MVP**, em 3 instâncias, todos verdes:
   - `test/concurrency/hot-wallet-race.test.ts` (100/80/80, 20 repetições, T071);
   - `test/concurrency/idempotent-burst.test.ts` (50 BETs paralelas → 1 débito e 50 respostas com o mesmo id, sem 409, 500 ou 503, T083);
   - revisões T127, T128 e T129 concluídas contra `review-checklist.md`;
   - `assertWalletMatchesLedger` verde em todos os testes.
6. Parar e validar antes de seguir para P2.

### Entrega incremental

MVP → US4 (WIN e LOSS) → US5 (reversões) → US6 (pendência) → US7 (contrato de respostas) → US9 (falhas
transitórias) → US8 (auditoria) → Polish. Cada checkpoint mantém verdes os testes das histórias anteriores.

---

## Notes

- `[P]` significa arquivo diferente e nenhuma dependência de task incompleta; tasks no mesmo arquivo nunca têm `[P]` entre si.
- Os testes de integração e de concorrência de cada história precisam falhar antes da implementação.
- Nenhum teste usa mock de PostgreSQL. Os doubles permitidos são `FixedClock`, `SequentialIdGenerator` e `exit` injetado nos failpoints.
- Cada commit deve deixar `bun run typecheck` verde.
