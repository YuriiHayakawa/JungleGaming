---

description: "Tasks da feature 002-messaging-reliability"
---

# Tasks: Mensageria Confiável

**Input**: documentos de design em `/specs/002-messaging-reliability/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md),
[contracts/](contracts/), [quickstart.md](quickstart.md), [review-checklist.md](review-checklist.md)

**Tests**: obrigatórios (gate de Tasks da constitution: toda task de comportamento tem teste). Unitários puros vêm antes
da implementação; testes de integração e de concorrência de cada história são escritos antes e precisam **falhar**
antes da implementação. Integração e concorrência só com **PostgreSQL e MiniStack reais** em container.

**Spike**: S-12 executado e aprovado em 2026-11-08 (research §0), com o MiniStack 1.5.32 no lugar do LocalStack e o
handler próprio de sinal no lugar do `enableShutdownHooks()`. Não há task de spike.

**Organization**: Setup, Fundação e uma fase por história na ordem da spec: US1, US2 e US3 (P1, MVP); US4, US5 e US6
(P2); US7 (P3); Polish.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: pode rodar em paralelo (arquivo diferente, sem dependência de task incompleta)
- **[Story]**: história da spec (US1 … US7)
- Toda task cita o arquivo e os FR, I-xx, SC e decisões R-xx que cobre

## Convenções valendo em todas as tasks

As da 001 continuam (tasks da 001, "Convenções"): SQL com `?`; dentro de `transactional()`, só o EM da transação;
dinheiro como `Money`/string, nunca `number`; domínio sem `@nestjs`, `@mikro-orm` nem `@aws-sdk`; injeção só por
`@Inject(TOKEN)`; banco próprio por arquivo de teste; nenhum `TRUNCATE`/`DELETE` como limpeza; `assertWalletMatchesLedger`
ao fim de todo teste que toca wallet. Novas:

- **SQS só pela porta**: `@aws-sdk/client-sqs` é importado só em `src/messaging/infrastructure/` (R-21, R-33). Os testes
  de suporte (`test/support/`) podem usar o SDK direto para semear e inspecionar filas.
- **Fake de SQS só em `test/unit/`**: `test/support/fake-sqs.ts` implementa `SqsPort` em memória e só pode ser importado
  por testes unitários. Em `test/integration/` e `test/concurrency/` é proibido (verificado pelo T084).
- **Filas próprias por arquivo de teste** (`useTestQueues`, R-31), com prefixo único, apagadas no fim; nenhum
  `PurgeQueue` como limpeza.
- **Ordem única de lock**: wallet (`FOR UPDATE`) antes de qualquer escrita em `wager_transactions`; exceções só o claim
  do worker (`SKIP LOCKED`) e a antecipação depois do lock da wallet de origem (R-26).
- **Ack só depois do commit**, **DLQ antes do delete**, **marca da outbox só depois do SendMessage** (review-checklist).
- **Papéis por env**: `CONSUMER_ENABLED`, `PUBLISHER_ENABLED` e `PENDING_WORKER_ENABLED` desligados por padrão; cada teste
  liga o papel que precisa (R-27).
- **Tempo, ids e jitter por porta** (`Clock`, `IdGenerator`, `RandomSource`).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: dependência nova, variáveis de ambiente e o emulador no Compose.

- [X] T001 Acrescentar em `package.json` a dependência `"@aws-sdk/client-sqs": "3.1156.0"` (versão exata, sem `^`/`~`,
  research §1, R-20) e o script `"queue:init": "bun scripts/queue-init.ts"`; rodar `bun install` e commitar o
  `bun.lock` atualizado
- [X] T002 [P] Acrescentar ao `.env.example` as variáveis do research R-27 com os padrões: `SQS_ENDPOINT=http://localhost:4566`,
  `AWS_REGION=us-east-1`, `AWS_ACCESS_KEY_ID=test`, `AWS_SECRET_ACCESS_KEY=test`,
  `SQS_TRANSACTIONS_QUEUE=wager-transactions.fifo`, `SQS_TRANSACTIONS_DLQ=wager-transactions-dlq.fifo`,
  `SQS_EVENTS_QUEUE=wager-events.fifo`, `CONSUMER_ENABLED=false`, `PUBLISHER_ENABLED=false`,
  `PENDING_WORKER_ENABLED=false`, `CONSUMER_NAME=wager-transactions-consumer`, `CONSUMER_WAIT_SECONDS=20`,
  `CONSUMER_VISIBILITY_TIMEOUT_SECONDS=30`, `CONSUMER_RETRY_BASE_SECONDS=5`, `CONSUMER_RETRY_MAX_SECONDS=60`,
  `CONSUMER_SHUTDOWN_TIMEOUT_MS=10000`, `PUBLISHER_BATCH_SIZE=10`, `PUBLISHER_LEASE_MS=30000`, `PUBLISHER_POLL_MS=1000`,
  `PUBLISHER_BACKOFF_MIN_MS=1000`, `PUBLISHER_BACKOFF_MAX_MS=60000`, `PENDING_WORKER_BATCH_SIZE=10`,
  `PENDING_WORKER_LEASE_MS=30000`, `PENDING_WORKER_POLL_MS=1000`, `PENDING_MAX_ATTEMPTS=10`, `PENDING_TTL_MS=600000`,
  `PENDING_BACKOFF_BASE_MS=5000`, `PENDING_BACKOFF_MAX_MS=60000`, `PENDING_JITTER_RATIO=0.2` (FR-032, I-21, I-64, I-65)
- [X] T003 [P] Atualizar `docker-compose.yml` (plan, "Deploy local"; research §0.4):
  - serviço `sqs`: `image: ministackorg/ministack:1.5.32`, porta `4566:4566`, healthcheck
    `["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:4566/_localstack/health')"]`
    (a imagem não tem `curl`, `wget` nem `aws` CLI);
  - serviço `queue-init`: `build: .`, `command: ["bun", "run", "queue:init"]`, `SQS_ENDPOINT: http://sqs:4566` e os nomes
    das filas, `depends_on: sqs: condition: service_healthy`;
  - `app1`, `app2` e `app3` dependem de `migrate` e de `queue-init` com `condition: service_completed_successfully`;
    recebem `SQS_ENDPOINT: http://sqs:4566`; papéis: `app1` `CONSUMER_ENABLED=true`; `app2` `CONSUMER_ENABLED=true` e
    `PUBLISHER_ENABLED=true`; `app3` `PUBLISHER_ENABLED=true` e `PENDING_WORKER_ENABLED=true`; `stop_grace_period: 30s`;
  - profile `test` com os serviços `app-test` (sem `init`) e `app-test-init` (`init: true`), `build: .`,
    `command: ["bun", "src/main.ts"]`, sem portas publicadas, usados pelo harness de container (T034, R-30).

**Checkpoint**: `docker compose up -d postgres sqs` sobe com os dois serviços saudáveis e `bun install --frozen-lockfile`
funciona.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: schema, portas, configuração, failpoints, laço de fundo, handler de sinal, envelope e infraestrutura de
teste de fila.

**⚠️ CRITICAL**: nenhuma história começa antes desta fase terminar.

### Testes de fundação (escrever primeiro; devem falhar)

- [X] T004 [P] Estender `test/unit/app-config.test.ts` (FR-032, R-27): lê as variáveis do T002 com os padrões; booleanos
  só `true`/`false`; nomes de fila terminam em `.fifo`; `PUBLISHER_BATCH_SIZE` e `PENDING_WORKER_BATCH_SIZE` de 1 a 10;
  `PENDING_JITTER_RATIO` de 0 a 0,5; `CONSUMER_WAIT_SECONDS` de 1 a 20; recusa (lança) quando
  `CONSUMER_VISIBILITY_TIMEOUT_SECONDS × 1000 ≤ DB_POOL_ACQUIRE_TIMEOUT_MS + WALLET_LOCK_TIMEOUT_MS + 2000`, quando
  `PUBLISHER_LEASE_MS` ou `PENDING_WORKER_LEASE_MS` não passam do mesmo limite, quando
  `CONSUMER_RETRY_BASE_SECONDS > CONSUMER_RETRY_MAX_SECONDS` e quando `CONSUMER_SHUTDOWN_TIMEOUT_MS > 25000` (prazo + 5 s
  de margem precisa caber nos 30 s do `stop_grace_period`)
- [X] T005 [P] Estender `test/unit/failpoints.test.ts` (I-40, R-29): `after_commit_before_ack` e `before_publish_mark`
  chamam o `exit` injetado no modo padrão; `after_pending_resolution_before_commit` lança `FailpointError` no modo padrão
  e, no modo `invariant_violation`, um erro com `code` `P0001` que `classifyDbError` classifica como `invariant`;
  `NODE_ENV=production` desliga os três; modo desconhecido recusa o boot
- [X] T006 [P] Escrever `test/unit/inbox-message.test.ts` (enunciado §6.5; data-model §1): `InboxMessage.receive` com
  `messageId` "1 a 128 caracteres em `[A-Za-z0-9._:-]`", `consumerName` "1 a 64 caracteres", `payloadHash`
  `^[0-9a-f]{64}$` e `transactionId` UUID, recusando o resto; `markProcessed(at)` uma vez só (a segunda lança
  `InvalidTransactionStateError`); `isProcessed`, `matchesPayload`; `rehydrate` sem revalidar (I-28, I-69)
- [X] T007 [P] Escrever `test/unit/pending-reference-policy.test.ts` (I-21, I-64, I-72, R-25): com `random` fixo em 0,5
  (sem efeito de jitter) as esperas antes das tentativas 2 a 10 são 10, 20, 40, 60, 60, 60, 60, 60, 60 s e a 10ª
  acontece 435 s depois da criação (5 s da 001 + a soma); o jitter fica em `[1 − r, 1 + r]` para `random` 0 e 0,999;
  `isExhausted` é verdadeiro com 10 tentativas depois desta avaliação ou com `now − createdAt ≥ ttlMs` (10 min), e falso
  antes; os limites vêm da configuração
- [X] T008 [P] Estender `test/unit/wager-transaction.test.ts` (I-11, I-67): `scheduleNextReferenceAttempt(nextAt, at)`
  só a partir de PENDING_REFERENCE (incrementa `referenceAttempts`, define `nextReferenceAttemptAt`, mantém o status;
  em PENDING, PROCESSED, REJECTED ou FAILED lança `InvalidTransactionStateError`); `markProcessed`, `reject` e `fail` a
  partir de PENDING_REFERENCE deixam `nextReferenceAttemptAt` nulo, preservam `referenceAttempts` e (no
  `markProcessed`) reescrevem `observedBalance` e `referenceTransactionId`; `correlationId` nunca muda
- [X] T009 [P] Escrever `test/unit/wager-message-envelope.test.ts` (FR-002, I-57, I-60, I-66, I-69,
  `contracts/wager-transaction-requested.schema.json`): o exemplo do contrato é aceito; corpo que não é JSON, envelope
  sem `messageId`, `type`, `occurredAt` ou `data`, `messageId` vazio, com 129 caracteres ou com caractere fora de
  `[A-Za-z0-9._:-]` e `occurredAt` não ISO-8601 → `MALFORMED_MESSAGE`; `type` "Other" com envelope válido →
  `UNSUPPORTED_MESSAGE_TYPE`; `data` com `amount` numérico, sem `idempotencyKey`, com autorreferência ou `providerId`
  "system" → `VALIDATION_ERROR`; `kind` OPENING → `OPENING_NOT_ALLOWED`; campos desconhecidos descartados; `walletId` em
  maiúsculas normalizado
- [X] T010 [P] Escrever `test/unit/in-memory-metrics.test.ts` (FR-036, R-32): `increment(name, labels)` e
  `observe(name, value, labels)` acumulam por nome e rótulos; `snapshot()` devolve contadores e observações; nomes
  aceitos: `transactions_total`, `duplicates_total`, `retries_total`, `dlq_total`, `lock_conflicts_total`,
  `outbox_lag_ms`, `processing_latency_ms`; nome desconhecido lança erro
- [X] T011 [P] Escrever `test/unit/polling-loop.test.ts` (FR-014, FR-015, FR-033, R-28): o `PollingLoop` executa a
  iteração, espera o intervalo, aplica backoff de 1 a 30 s quando a iteração lança erro de indisponibilidade, para no
  `stop()` abortando o `AbortSignal` repassado à iteração, e `drain(timeoutMs)` espera a iteração em andamento até o
  prazo; o `WorkerRegistry` registra trabalhadores e `drainAll()` para e drena todos (com iterações de teste, sem banco
  nem fila)
- [X] T012 [P] Escrever `test/unit/signal-handler.test.ts` (FR-014, I-34, R-35), com `process`, `exit` e temporizadores
  injetados: `SIGTERM` e `SIGINT` chamam `close()` e depois `exit(0)`; um segundo sinal durante o encerramento é
  ignorado (`close()` chamado uma vez); `close()` que rejeita → `exit(1)`; `close()` que não termina → `exit(1)` depois
  de `CONSUMER_SHUTDOWN_TIMEOUT_MS` + 5000; o temporizador de segurança não segura o processo (`unref`)
- [X] T013 [P] Estender `test/unit/pg-errors.test.ts` (I-28, R-22): `23505` com `constraint` `inbox_messages_pk` →
  `inbox-race`; os casos da 001 continuam iguais
- [X] T014 [P] Escrever `test/integration/queue-init.test.ts` (plan "Deploy local"; I-29, I-30), contra o MiniStack do
  Compose com um prefixo único de nomes: `bun scripts/queue-init.ts` via `Bun.spawn` termina com 0 e cria
  `<prefixo>wager-transactions-dlq.fifo`, `<prefixo>wager-transactions.fifo` (com `RedrivePolicy` para a DLQ e
  `maxReceiveCount` 5) e `<prefixo>wager-events.fifo`, todas com `FifoQueue=true` e `ContentBasedDeduplication=false`;
  rodar de novo termina com 0 sem erro nem fila duplicada; com `SQS_ENDPOINT` inválido termina com código ≠ 0; apaga
  as filas no fim
- [X] T015 [P] Estender `test/integration/migrations.test.ts` (constitution V; data-model §2.3): `up → down → up` passa a
  conferir no catálogo `inbox_messages`, `inbox_transaction_idx`, os triggers `inbox_no_update_delete_trg` e
  `inbox_no_truncate_trg`, e os índices `wager_tx_pending_due_idx` e `wager_tx_pending_by_reference_idx` (e a ausência
  deles depois do `down`)
- [X] T016 [P] Estender `test/integration/schema-guards.test.ts` (data-model §2.1; I-28, I-69; arquivo da lista de
  permitidos do T118 da 001): `inbox_messages_pk` barra o mesmo `(consumer_name, message_id)`; `inbox_message_id_ck`
  recusa `message_id` fora de `^[A-Za-z0-9._:-]{1,128}$`; `inbox_payload_hash_ck`, `inbox_consumer_name_ck` e
  `inbox_processed_after_ck` recusam valores inválidos; a FK recusa `transaction_id` inexistente; `UPDATE`, `DELETE` e
  `TRUNCATE` em `inbox_messages` recusados com `P0001`, cada comando inline em `await expect(db.query('...')).rejects`

### Implementação da fundação

- [X] T017 [P] Criar `migrations/Migration20261108000100.ts`: `up` copia literalmente o DDL de data-model §2.1
  (`inbox_messages` com `consumer_name varchar(64)`, `message_id varchar(128)`, `payload_hash char(64)`,
  `transaction_id uuid NOT NULL REFERENCES wager_transactions (id)`, `received_at` e `processed_at timestamptz NOT NULL`,
  `inbox_messages_pk PRIMARY KEY (consumer_name, message_id)`, os quatro `CHECK`s, `inbox_transaction_idx` e os dois
  triggers com `jg_forbid_mutation`); `down` remove triggers e tabela na ordem inversa; um `addSql` por comando
- [X] T018 [P] Criar `migrations/Migration20261108000200.ts`: `up` com os dois índices parciais de data-model §2.2
  (`wager_tx_pending_due_idx ON wager_transactions (next_reference_attempt_at, created_at) WHERE status =
  'PENDING_REFERENCE'` e `wager_tx_pending_by_reference_idx ON wager_transactions (provider_id,
  reference_external_transaction_id, created_at) WHERE status = 'PENDING_REFERENCE'`); `down` remove os dois
- [X] T019 Registrar as duas migrations em `MIGRATIONS` de `src/platform/persistence/mikro-orm.config.ts`, depois das
  quatro da 001; o template de teste (`test/support/db-setup.preload.ts`) passa a aplicá-las sem mudança de código. Faz o
  T015 e o T016 passarem
- [X] T020 [P] Implementar `src/inbox/domain/inbox-message.ts` (data-model §1) e
  `src/inbox/infrastructure/{inbox-message.schema.ts, inbox-message.mapper.ts, mikro-orm-inbox.repository.ts}`
  (`insert(em, inbox)` e `findByConsumerAndMessageId(em, consumerName, messageId)`, EM por chamada, R-19), registrando o
  schema em `src/platform/persistence/entity-schemas.ts`. Faz o T006 passar
- [X] T021 [P] Implementar `src/wagering/domain/pending-reference-policy.ts` (R-25) e
  `src/platform/random/{random-source.port.ts, crypto-random-source.ts}` (porta `RANDOM_SOURCE`, `next()` em `[0, 1)`,
  com `crypto.getRandomValues`), mais o double `FixedRandom` em `test/support/fakes.ts`. Faz o T007 passar
- [X] T022 Implementar em `src/wagering/domain/wager-transaction.ts` o `scheduleNextReferenceAttempt` e o
  `nextReferenceAttemptAt` nulo ao sair de PENDING_REFERENCE (data-model §1); ajustar
  `src/wagering/infrastructure/wager-transaction.mapper.ts` se preciso. Faz o T008 passar sem quebrar os testes da 001
- [X] T023 [P] Implementar `src/platform/metrics/{metrics.port.ts, in-memory-metrics.ts}` (porta `METRICS`, R-32) e
  registrar o provider no `src/app.module.ts`. Faz o T010 passar
- [X] T024 Implementar em `src/platform/config/app-config.ts` as variáveis e a hierarquia do T004 (R-27). Faz o T004
  passar
- [X] T025 [P] Implementar em `src/platform/failpoints/failpoints.ts` os três failpoints novos e o modo
  `invariant_violation` (R-29). Faz o T005 passar
- [X] T026 [P] Acrescentar em `src/platform/persistence/pg-errors.ts` o `inbox_messages_pk` → `inbox-race`. Faz o T013
  passar
- [X] T027 Criar a porta `src/messaging/application/sqs.port.ts` (`SQS_PORT`: `receive(queue, { max, waitSeconds,
  visibilitySeconds?, signal })` devolvendo `messageId`, `receiptHandle`, `body`, `receiveCount`, `groupId` e atributos;
  `delete`; `changeVisibility`; `send(queue, { body, groupId, deduplicationId, attributes })`; `approximateCounts`) e o
  adapter `src/messaging/infrastructure/aws-sqs.adapter.ts`, único arquivo de `src/` que importa
  `@aws-sdk/client-sqs`, com URLs resolvidas por nome no boot e `abortSignal` no long polling (R-21; spike S-12.7)
- [X] T028 Criar `src/messaging/infrastructure/queue-provisioning.ts` (`provisionQueues(client, names)`: DLQ, principal com
  `RedrivePolicy` `maxReceiveCount` 5 e eventos, todas FIFO com `ContentBasedDeduplication=false`; idempotente:
  `CreateQueue` com os mesmos atributos e `SetQueueAttributes` quando divergem) e `scripts/queue-init.ts` (lê
  `SQS_ENDPOINT` e os nomes, chama `provisionQueues`, sai com 0 ou ≠ 0). Faz o T014 passar
- [X] T029 [P] Criar `test/support/fake-sqs.ts`: `SqsPort` em memória para **testes unitários apenas** (visibilidade,
  `receiveCount`, grupo FIFO bloqueado, DLQ capturada, falha injetável), com comentário de que é proibido em
  `test/integration/**` e `test/concurrency/**` (T084)
- [X] T030 [P] Criar `test/support/test-queues.ts` (`useTestQueues(tag)`: no `beforeAll`, `provisionQueues` com prefixo
  `jg-<tag>-<aleatório>-`; expõe nomes, URLs e o env para as instâncias; no `afterAll`, apaga as filas; sem `PurgeQueue`;
  R-31) e `test/support/sqs-client.ts` (enviar envelope com grupo e deduplicação, receber tudo de uma fila, ler a DLQ com
  atributos, contar `ApproximateNumberOfMessages` e `...NotVisible`, esperar a fila esvaziar)
- [X] T031 Implementar `src/platform/workers/{polling-loop.ts, worker-registry.ts}` (R-28) e fazer o `OrmLifecycle`
  (`src/platform/persistence/orm.provider.ts`) chamar `registry.drainAll()` antes de `orm.close()`. Faz o T011 passar
- [X] T032 Implementar `src/platform/lifecycle/signal-handler.ts` (`installShutdownSignals`, R-35) e trocar no
  `src/main.ts` o `app.enableShutdownHooks()` pelo handler: `SIGTERM` e `SIGINT` → `app.close()` → `process.exit(0)`;
  sinal repetido ignorado; temporizador de segurança de `CONSUMER_SHUTDOWN_TIMEOUT_MS` + 5000 → `process.exit(1)`; erro
  no `close()` → `process.exit(1)`. Faz o T012 passar e mantém verdes os testes da 001 que usam `app.close()`
- [X] T033 Estender `test/support/app-harness.ts` e `test/support/instance-cluster.ts` para aceitar papéis
  (`CONSUMER_ENABLED`, `PUBLISHER_ENABLED`, `PENDING_WORKER_ENABLED`) e o env das filas de `useTestQueues`, com papéis
  desligados por padrão; o `RunningApp` expõe `app.get(METRICS)` e o `SqsPort` (R-27, R-31)
- [X] T034 [P] Criar `test/support/container-instance.ts` (R-30): `startContainerInstance({ service: 'app-test' |
  'app-test-init', env })` constrói a imagem uma vez (`docker compose --profile test build`), sobe com `docker compose
  --profile test run -d` na rede do Compose (PostgreSQL em `postgres:5432` com o banco do arquivo, MiniStack em
  `sqs:4566`), espera a linha `http.listening` no log, expõe `kill(signal)`, `wait()` (código de saída), `logs()` e
  remove o container no fim
- [X] T035 Escrever `test/concurrency/signal-exit.test.ts` (FR-014, I-34, R-35; spike S-12.8): com `app-test` (sem
  `init`, a app é o PID 1) e com `app-test-init` (`init: true`), `SIGTERM` → o log mostra o encerramento (drain do
  `WorkerRegistry` e fechamento do ORM) e a saída é 0 em menos de `CONSUMER_SHUTDOWN_TIMEOUT_MS` + 5 s; um segundo
  `SIGTERM` durante o encerramento não muda o resultado. A drenagem de mensagem em andamento entra no T078 (US5)
- [X] T036 Implementar `src/messaging/application/wager-message.envelope.ts` (FR-002, I-66, I-69,
  `contracts/wager-transaction-requested.schema.json`): schema Zod do envelope, reaproveitando o schema de submissão da
  001 para `data` (com `idempotencyKey` 1 a 255), e a tradução de erro para o código de DLQ (`MALFORMED_MESSAGE`,
  `UNSUPPORTED_MESSAGE_TYPE`, `VALIDATION_ERROR`, `OPENING_NOT_ALLOWED`; I-70). Faz o T009 passar
- [X] T037 Acrescentar `messageId` e `causationId` ao contexto de requisição (`src/platform/correlation/request-context.ts`)
  e `messageId` às linhas do `src/platform/logging/json-logger.ts`, com teste em `test/unit/json-logger.test.ts`
  (FR-037, I-69)

**Checkpoint**: `bun run typecheck && bun run test:unit && bun run test:integration && bun run test:concurrency` verdes,
inclusive T014, T015, T016 e T035, com `docker compose up -d postgres sqs`. Fundação pronta.

---

## Phase 3: User Story 1 - Enviar operações pela fila com o mesmo resultado do HTTP (Priority: P1) 🎯 MVP

**Goal**: o consumidor processa `WagerTransactionRequested` pelo mesmo use case do HTTP, com inbox na mesma transação e
ack só depois do commit; reentregas nunca duplicam efeito.

**Independent Test**: BET pela fila igual à do HTTP; 50 entregas da mesma mensagem por 3 instâncias; replay cruzado HTTP
× fila; queda entre o commit e o ack.

### Testes da User Story 1 (escrever primeiro; devem falhar)

- [X] T038 [P] [US1] Escrever `test/unit/consumer-batching.test.ts` (R-22), com o `fake-sqs` e um processador de teste:
  mensagens do mesmo `MessageGroupId` num lote são processadas em sequência e na ordem; grupos diferentes, em paralelo;
  o ack de cada mensagem só é chamado depois que o processador dela resolve
- [X] T039 [P] [US1] Escrever `test/integration/consumer-processing.test.ts` (US1 cenários 1, 5 e 6; FR-001, FR-003,
  FR-004, FR-005, FR-008, FR-037, FR-038; I-26, I-28, I-69; SC-010), com `useTestQueues`, banco próprio e app com
  `CONSUMER_ENABLED=true`. Cada teste termina com `assertWalletMatchesLedger`.
  - BET "25.00" pela fila sobre "1000.00" → PROCESSED, saldo "975.00", um DEBIT, uma linha de inbox
    (`consumer_name`, `message_id`, `payload_hash` igual ao do I-25, `transaction_id`), eventos na outbox com
    `correlationId` = `causationId` = `messageId`; a mensagem sai da fila (`ApproximateNumberOfMessages` e `...NotVisible`
    0) em até 2 s;
  - o mesmo envelope reenviado com outro `MessageDeduplicationId` → nenhum efeito novo, a mensagem é confirmada e a
    inbox continua com uma linha;
  - BET sem saldo → REJECTED `INSUFFICIENT_FUNDS` gravada, inbox gravada, mensagem confirmada;
  - REFUND com referência inexistente → PENDING_REFERENCE gravada, inbox gravada, mensagem confirmada;
  - as linhas de log do processamento trazem `messageId`, `correlationId`, `transactionId`, `walletId` e `providerId`,
    sem `amount` nem `money`
- [X] T040 [P] [US1] Escrever `test/integration/cross-channel-replay.test.ts` (US1 cenário 3; FR-006; I-26, I-28): BET por
  HTTP e depois pela fila com a mesma chave → a mensagem é replay (sem efeito, sem evento), confirmada, com inbox
  apontando a transação existente; BET pela fila e depois por HTTP → 200 com `idempotentReplay` true; termina com
  `assertWalletMatchesLedger`
- [X] T041 [P] [US1] Escrever `test/integration/consumer-atomicity.test.ts` (FR-003, FR-013; constitution IV), com
  `FAILPOINT=after_ledger_insert_before_commit` e `CONSUMER_RETRY_BASE_SECONDS=1`: a mensagem não gera nenhuma linha
  (transação, ledger, outbox nem inbox) e não é confirmada (volta a ficar visível); depois de reiniciar a app sem
  failpoint, é processada uma única vez; termina com `assertWalletMatchesLedger`
- [X] T042 [P] [US1] Escrever `test/concurrency/message-burst.test.ts` com 3 instâncias consumidoras (US1 cenário 2;
  FR-007; I-27, I-28; SC-001, SC-008): (a) o mesmo envelope enviado 50 vezes com `MessageDeduplicationId` distintos →
  exatamente 1 transação, no máximo 1 lançamento, 1 linha de inbox, um conjunto de eventos, e todas as entregas
  confirmadas; (b) 50 envelopes com `messageId` distintos e a mesma chave e o mesmo conteúdo → 1 efeito e 50 linhas de
  inbox apontando a mesma transação; termina com `assertWalletMatchesLedger`
- [X] T043 [P] [US1] Escrever `test/concurrency/crash-before-ack.test.ts` (US1 cenário 4; FR-005; I-28, I-40; SC-002):
  uma instância com `FAILPOINT=after_commit_before_ack` processa a mensagem e sai (código 1) depois do commit; outra
  instância recebe a reentrega depois da visibilidade, reconhece a duplicata pela inbox e confirma; exatamente 1 efeito
  e `ApproximateReceiveCount` 2 na reentrega; termina com `assertWalletMatchesLedger`

### Implementação da User Story 1

- [X] T044 [US1] Estender `src/wagering/application/submit-wager-transaction.use-case.ts` (R-22; FR-003, FR-006; I-26,
  I-28, I-68, I-69): o comando ganha `origin` (`http` | `queue`), `inbox?` (`consumerName`, `messageId`, `payloadHash`) e
  `causationId?`; no caminho rápido, replay de origem fila grava a inbox numa transação mínima apontando a transação
  existente (`23505` em `inbox_messages_pk` → relê a inbox); sob o lock da wallet relê a inbox antes da idempotência;
  replay grava a inbox na mesma transação; efeito novo grava a inbox depois da transação e antes da outbox; conflito de
  idempotência não grava inbox; os eventos levam o `causationId`. O caminho HTTP não muda (testes da 001 verdes)
- [X] T045 [US1] Implementar `src/messaging/application/consume-wager-message.use-case.ts` (plan, "Consumidor"; FR-001 a
  FR-008): contexto de requisição por mensagem (`correlationId` = `causationId` = `messageId`); envelope (T036); caminho
  rápido da inbox; chamada do use case com origem fila; resultado gravado ou replay → `delete` depois do commit; failpoint
  `after_commit_before_ack` entre o commit e o `delete`; erro sem classificação ainda → a mensagem não é apagada (a
  classificação completa entra na US2)
- [X] T046 [US1] Implementar `src/messaging/interfaces/wager-transactions.consumer.ts` (provider Nest com
  `onApplicationBootstrap`, que inicia o `PollingLoop` se `CONSUMER_ENABLED`, e `onApplicationShutdown`, que para o laço),
  com long polling, lote de até 10 e processamento sequencial por grupo, e `src/messaging/messaging.module.ts`
  registrado em `src/app.module.ts` com `SQS_PORT` → `AwsSqsAdapter`. Faz o T038 a T043 passarem
- [X] T047 [US1] Revisar o diff da US1 contra `specs/002-messaging-reliability/review-checklist.md` (gate de Revisão,
  Princípios II a V), com atenção a "ack só depois do commit", inbox na mesma transação e ordem de lock; registrar o
  resultado item a item; item reprovado volta para a task de origem

**Checkpoint US1**: `bun test test/unit/consumer-batching.test.ts && bun test --preload ./test/support/db-setup.preload.ts
test/integration/consumer-processing.test.ts test/integration/cross-channel-replay.test.ts
test/integration/consumer-atomicity.test.ts test/concurrency/message-burst.test.ts test/concurrency/crash-before-ack.test.ts`,
com o T047 concluído.

---

## Phase 4: User Story 2 - Tratar cada falha do jeito certo: rejeição, nova tentativa ou DLQ (Priority: P1) 🎯 MVP

**Goal**: classificação completa: negócio confirma; transitório volta com backoff e cai na DLQ pelo redrive; permanente
vai à DLQ pela aplicação antes do delete; inesperado é transitório e vai à DLQ pela aplicação no 5º recebimento.

**Independent Test**: provocar cada classe de erro e conferir destino, número de recebimentos, atributos e ausência de
efeito.

### Testes da User Story 2 (escrever primeiro; devem falhar)

- [X] T048 [P] [US2] Escrever `test/unit/message-classification.test.ts` (R-23; FR-008 a FR-010, FR-009a, FR-040; I-30,
  I-61, I-68, I-70, I-71): cada origem de erro vira a ação certa (`ack`, `retry` com visibilidade, `dlq` com
  `errorCode`/`errorClass`); visibilidade `min(base × 2^(n−1), teto)` para `n` = 1 a 4 com base 5 e teto 60
  (5, 10, 20, 40 s); erro inesperado com `n` < 5 → `retry`, com `n` = 5 → `dlq` `INTERNAL_ERROR`/`unexpected`;
  permanentes → `dlq` com `errorClass` `permanent` já no 1º recebimento
- [X] T049 [P] [US2] Escrever `test/unit/consume-wager-message.test.ts` com o `fake-sqs` (FR-040; I-68, I-70): numa
  mensagem permanente, o `send` à DLQ (com `errorCode`, `errorClass`, `receiveCount` e `consumer`) acontece antes do
  `delete`; se o `send` falhar, o `delete` não é chamado e a mensagem continua na fila
- [X] T050 [P] [US2] Escrever `test/integration/consumer-permanent-errors.test.ts` (US2 cenário 3; FR-010, FR-040; I-28,
  I-60, I-66, I-68, I-69, I-70; SC-004): cada caso vai à DLQ no 1º recebimento, com os atributos de
  `contracts/queues.md`, sai da fila principal e não grava nada (nem inbox): corpo que não é JSON e envelope incompleto
  (`MALFORMED_MESSAGE`); `messageId` fora do formato (`MALFORMED_MESSAGE`); `type` "Other" (`UNSUPPORTED_MESSAGE_TYPE`);
  `amount` numérico e autorreferência (`VALIDATION_ERROR`); `providerId` "system" (`VALIDATION_ERROR`); OPENING
  (`OPENING_NOT_ALLOWED`); wallet inexistente (`WALLET_NOT_FOUND`); mesmo `messageId` com outro conteúdo
  (`INBOX_PAYLOAD_MISMATCH`); mesma chave com outro conteúdo e mesmo id externo com outra chave
  (`IDEMPOTENCY_CONFLICT`, sem linha de inbox)
- [X] T051 [P] [US2] Escrever `test/integration/consumer-transient-errors.test.ts` (US2 cenários 1, 2 e 4; FR-009, FR-034;
  I-30, I-34, I-51; SC-004), com a app atrás do proxy TCP da 001 para o PostgreSQL e `CONSUMER_RETRY_BASE_SECONDS=1`:
  banco cortado em todas as entregas → a mensagem chega à DLQ pelo redrive depois de 5 recebimentos, sem os atributos da
  aplicação, e nada é gravado; banco cortado só nas 2 primeiras entregas → 1 efeito; lock da wallet segurado por fora
  (`FOR UPDATE`) → a mensagem não é confirmada e, solto o lock, é processada uma vez; termina com
  `assertWalletMatchesLedger`
- [X] T052 [P] [US2] Escrever `test/integration/consumer-unexpected-errors.test.ts` (US2 cenário 4a; FR-009a, FR-011,
  FR-040; I-61, I-71; SC-004), com `FAILPOINT=after_ledger_insert_before_commit` sempre ativo e
  `CONSUMER_RETRY_BASE_SECONDS=1`: as 4 primeiras entregas voltam com espera crescente; no 5º recebimento a aplicação
  envia a mensagem à DLQ com `errorCode` `INTERNAL_ERROR` e `errorClass` `unexpected` e a apaga da principal; nada é
  gravado e nenhuma transação fica FAILED
- [X] T053 [P] [US2] Escrever `test/integration/failed-replay.test.ts` (US2 cenário 5; FR-012, FR-030; I-62): com uma
  transação FAILED semeada por SQL respeitando as constraints (`status` FAILED, `failure_code` `INTERNAL_ERROR`), o
  replay por HTTP → 500 `INTERNAL_ERROR` com `retryable` false no envelope do I-38, e o replay pela fila → confirmado,
  sem efeito nem evento

### Implementação da User Story 2

- [X] T054 [US2] Implementar `src/messaging/application/message-classification.ts` (R-23). Faz o T048 passar
- [X] T055 [US2] Completar `src/messaging/application/consume-wager-message.use-case.ts` (FR-008 a FR-013, FR-040; I-30,
  I-68, I-70, I-71): transitório e inesperado com `n` < 5 → `changeVisibility` com o backoff; inesperado no 5º
  recebimento e permanentes → `send` à DLQ com os atributos e, só depois do envio aceito, `delete`; o consumidor nunca
  grava FAILED. Faz o T049 a T052 passarem
- [X] T056 [US2] Implementar o replay de FAILED (FR-030; I-62): em `src/wagering/application/transaction-result.ts` o
  status FAILED gera um erro de aplicação próprio (500, `INTERNAL_ERROR`, `retryable` false) mapeado por
  `src/platform/http/global-exception.filter.ts`, com teste em `test/unit/global-exception-filter.test.ts`; pela fila,
  o replay de FAILED é confirmado. Faz o T053 passar
- [X] T057 [US2] Revisar o diff da US2 contra o `review-checklist.md`, com atenção a "DLQ antes de apagar da fila
  principal" e à ausência de FAILED no consumidor; registrar item a item

**Checkpoint US2**: `bun test test/unit/message-classification.test.ts test/unit/consume-wager-message.test.ts && bun test
--preload ./test/support/db-setup.preload.ts test/integration/consumer-permanent-errors.test.ts
test/integration/consumer-transient-errors.test.ts test/integration/consumer-unexpected-errors.test.ts
test/integration/failed-replay.test.ts`, com o T057 concluído.

---

## Phase 5: User Story 3 - Receber os eventos de negócio sem perda (Priority: P1) 🎯 MVP

**Goal**: publicação da outbox ao menos uma vez com publicadores concorrentes, lease e marca só depois do envio; teste
de SIGKILL no meio da carga com as invariantes.

**Independent Test**: publicar com 2 ou mais publicadores, matar um entre o envio e a marca, e conferir que tudo saiu;
derrubar o SQS e conferir o acúmulo e a recuperação.

### Testes da User Story 3 (escrever primeiro; devem falhar)

- [X] T058 [P] [US3] Escrever `test/integration/outbox-publisher.test.ts` (US3 cenários 1, 3 e 5; FR-016 a FR-022; I-29,
  I-31, I-32, I-65; SC-010), com `PUBLISHER_ENABLED=true` e `PUBLISHER_POLL_MS=100`: os eventos de uma BET aparecem em
  `wager-events` em até 5 s com o corpo igual ao `payload` gravado, `MessageGroupId` = `aggregateId` e deduplicação pelo
  `eventId`; `published_at` gravado; com a fila de eventos inacessível (proxy TCP na frente do MiniStack cortado), o
  envio falha, `published_at` continua nulo, `attempts` vira 1 e `next_attempt_at` avança 1 s, depois 2 s; o claim
  reserva no máximo 10 eventos e avança `next_attempt_at` em 30 s
- [X] T059 [P] [US3] Escrever `test/integration/sqs-outage.test.ts` (US3 cenário 4; FR-033, FR-035; I-34; SC-009), com o
  proxy TCP na frente do MiniStack: com o proxy cortado, 10 BETs por HTTP respondem 201 e os eventos ficam pendentes na
  outbox; o consumidor e o publicador continuam vivos (sem exceção não tratada) e esperam com backoff; com o proxy
  restaurado, sem reiniciar a app, todos os eventos são publicados; termina com `assertWalletMatchesLedger`
- [X] T060 [P] [US3] Escrever `test/concurrency/concurrent-publishers.test.ts` (US3 cenários 2 e 3; FR-017, FR-019;
  I-31, I-65; SC-003, SC-008): 3 instâncias publicadoras e 200 eventos gerados por HTTP; uma delas com
  `FAILPOINT=before_publish_mark` sai depois do primeiro envio; ao final todo `eventId` aparece ao menos uma vez em
  `wager-events`, nenhuma linha fica com `published_at` nulo em até 60 s, e qualquer repetição tem o mesmo `eventId`
- [X] T061 [P] [US3] Escrever `test/concurrency/sigkill-recovery.test.ts`, o teste de SIGKILL no meio da carga
  (SC-006, SC-008; FR-007, FR-013, FR-016): 3 instâncias com papéis diferentes (consumidor; consumidor + publicador;
  publicador), carga mista pela fila e por HTTP em 20 wallets (BET, WIN, LOSS, REFUND de BET existente e de referência
  inexistente); durante a carga, `SIGKILL` de uma instância aleatória três vezes, com substituição por outra de mesmo
  papel; ao final, depois da recuperação (fila principal vazia e outbox sem pendentes): `assertAllWalletsMatchLedger`;
  todo evento confirmado tem `published_at` e aparece em `wager-events`; toda mensagem enviada está processada uma vez
  (uma linha de inbox) ou na DLQ; nenhuma PENDING_REFERENCE sem `next_reference_attempt_at` (nenhuma pendência
  esquecida). A US4 estende este teste com o papel de worker

### Implementação da User Story 3

- [X] T062 [US3] Implementar `src/outbox/infrastructure/mikro-orm-outbox.repository.ts` (data-model §3.2; R-34): `claim(em,
  now, batch, leaseMs)` em transação curta com `FOR UPDATE SKIP LOCKED` e avanço de `next_attempt_at`;
  `markPublished(em, id, at)` com `WHERE published_at IS NULL`; `scheduleRetry(em, message)` com os valores de
  `OutboxMessage.scheduleRetry`; SQL com `?`
- [X] T063 [US3] Implementar `src/outbox/application/publish-outbox.use-case.ts` (FR-016 a FR-022; I-31, I-65): claim →
  `send` evento a evento (corpo = `payload`, grupo = `aggregate_id`, deduplicação = `id`) → failpoint
  `before_publish_mark` → marca só depois do envio aceito; falha de envio → `scheduleRetry`, sem afetar os outros do
  lote; atraso da outbox medido na marca (`outbox_lag_ms`)
- [X] T064 [US3] Implementar `src/outbox/interfaces/outbox-publisher.worker.ts` (provider com ciclo de vida, ligado por
  `PUBLISHER_ENABLED`, `PollingLoop` com `PUBLISHER_POLL_MS`) e registrá-lo num módulo carregado pelo `src/app.module.ts`.
  Faz o T058 a T061 passarem
- [X] T065 [US3] Revisar o diff da US3 contra o `review-checklist.md`, com atenção a "publisher marca como publicado só
  depois do SendMessage" e ao claim com `SKIP LOCKED`; registrar item a item

**Checkpoint US3 (fim do MVP da 002)**: `bun test --preload ./test/support/db-setup.preload.ts
test/integration/outbox-publisher.test.ts test/integration/sqs-outage.test.ts test/concurrency/concurrent-publishers.test.ts
test/concurrency/sigkill-recovery.test.ts`, com o T065 concluído.

---

## Phase 6: User Story 4 - Concluir sozinha a operação que chegou antes da referência (Priority: P2)

**Goal**: worker de PENDING_REFERENCE com lease, ordem do I-63, antecipação, limite e teto, FAILED só no worker.

**Independent Test**: ROLLBACK antes da BET concluído depois que a BET chega; referência que nunca chega →
`REFERENCE_NOT_FOUND`; 3 instâncias de worker; corrida worker × BET.

### Testes da User Story 4 (escrever primeiro; devem falhar)

- [X] T066 [P] [US4] Escrever `test/integration/pending-reference-worker.test.ts` (US4 cenários 1 a 3, 6 a 8; FR-023 a
  FR-031, FR-038; I-11, I-15, I-21, I-61, I-64, I-69, I-72, I-73; SC-005), com `PENDING_WORKER_ENABLED=true`,
  `PENDING_WORKER_POLL_MS=100`, `PENDING_BACKOFF_BASE_MS=100`, `PENDING_BACKOFF_MAX_MS=400`, `PENDING_MAX_ATTEMPTS=3` e
  `FixedRandom`. Cada teste termina com `assertWalletMatchesLedger`.
  - REFUND pendente; a BET chega → na mesma transação da BET, o `next_reference_attempt_at` do REFUND vai para agora
    (I-73); em até 5 s o REFUND fica PROCESSED com CREDIT, `reference_transaction_id` e `observed_balance` reescritos,
    e eventos com o `correlation_id` da pendente e sem `causationId`;
  - a BET chega REJECTED → o REFUND fica REJECTED `REFERENCE_REJECTED` com `WagerTransactionRejected`;
  - referência que nunca chega → depois de 3 tentativas, REJECTED `REFERENCE_NOT_FOUND` com evento; entre as
    tentativas só `reference_attempts` e `next_reference_attempt_at` mudam;
  - `PENDING_TTL_MS` curto → REJECTED `REFERENCE_NOT_FOUND` antes da 3ª tentativa;
  - a referência chega logo antes da última tentativa → a pendente resolve normalmente, sem `REFERENCE_NOT_FOUND` (I-72);
  - referência em outra rodada → `REFERENCE_MISMATCH`; ROLLBACK de WIN com saldo menor → `REVERSAL_WOULD_OVERDRAW`;
  - pendente de pendente → resolve em cadeia depois que a primeira referência chega;
  - depois do `REFERENCE_NOT_FOUND`, a referência que chega não reabre a pendente;
  - `FAILPOINT=after_pending_resolution_before_commit:invariant_violation` → a pendente fica FAILED (`failure_code`
    `INTERNAL_ERROR`) numa transação separada, sem lançamento nem evento;
  - PostgreSQL cortado (proxy) durante uma tentativa → nada gravado e a tentativa não conta
- [X] T067 [P] [US4] Escrever `test/integration/pending-replay-after-resolution.test.ts` (FR-039; I-62, I-67): a mesma
  requisição de uma pendente responde 202 antes e, depois da resolução, 200 (PROCESSED) ou 422 (REJECTED, com
  `failureCode`) com o saldo observado na conclusão; o `correlation_id` gravado não muda; uma pendente que ficou FAILED
  pelo worker responde 500 com `retryable` false
- [X] T068 [P] [US4] Escrever `test/concurrency/pending-worker-instances.test.ts` (US4 cenário 5; FR-028; SC-005, SC-008):
  3 instâncias com o worker ligado e 30 pendentes cujas referências chegam juntas → cada pendente concluída uma única vez,
  com no máximo um lançamento; termina com `assertAllWalletsMatchLedger`
- [X] T069 [P] [US4] Escrever `test/concurrency/pending-resolution-race.test.ts`, o teste de corrida entre o worker e a
  BET que resolve a pendente (FR-024, FR-026, FR-028; I-21, I-63, I-73; constitution III; falha eliminatória 2), repetido
  20 vezes: 2 instâncias com o worker em varredura curta (base 50 ms) reavaliando um REFUND pendente sem parar; a BET
  referenciada chega por HTTP por uma terceira instância num momento aleatório → o REFUND termina PROCESSED uma única
  vez, nunca `REFERENCE_NOT_FOUND` por corrida, com exatamente um CREDIT de reversão; `assertWalletMatchesLedger` em cada
  repetição
- [X] T070 [P] [US4] Escrever `test/concurrency/pending-order.test.ts` (US4 cenário 4; FR-026; I-16, I-63), repetido 10
  vezes: um REFUND e depois um ROLLBACK pendentes da mesma BET, com 3 instâncias de worker; a BET chega → o mais antigo
  é aplicado e o outro fica REJECTED `ALREADY_REVERSED`, sempre nessa ordem
- [X] T071 [US4] Estender `test/concurrency/sigkill-recovery.test.ts` (SC-006): uma das instâncias passa a ter também o
  papel de worker; as referências das pendentes da carga chegam no fim; depois da recuperação, nenhuma PENDING_REFERENCE
  cuja referência foi enviada continua pendente

### Implementação da User Story 4

- [X] T072 [US4] Extrair de `src/wagering/application/submit-wager-transaction.use-case.ts` a gravação de decisão para
  `src/wagering/application/transaction-recorder.ts` (R-24), com a antecipação das dependentes (data-model §3.4) quando o
  resultado é PROCESSED ou REJECTED, usada pelo submit; toda a suíte da 001 e da US1 a US3 continua verde
- [X] T073 [US4] Estender `src/wagering/infrastructure/mikro-orm-wager-transaction.repository.ts` (data-model §3.3, §3.4):
  `claimDuePending(em, now, batch, leaseMs)` com `FOR UPDATE SKIP LOCKED`; `findOlderSiblings(em, tx)`;
  `updateResolution(em, tx)` com `WHERE id = ? AND status = 'PENDING_REFERENCE'` (1 linha, senão quebra de invariante);
  `scheduleNextAttempt(em, tx)`; `markFailed(em, tx)`; `anticipateDependents(em, providerId, externalId, now)`; SQL com `?`
- [X] T074 [US4] Implementar `src/wagering/application/resolve-pending-reference.use-case.ts` (plan, "Worker"; FR-023 a
  FR-031; I-21, I-61, I-63, I-64, I-72): por pendente reservada, irmãs mais antigas primeiro, cada uma numa transação da
  unit of work com lock da wallet; relê a linha; avalia com `WagerRulesService`; aplica pelo recorder; esgotamento só com
  a referência ausente ou pendente; eventos com o `correlation_id` da pendente; failpoint antes do commit; `23505` no
  índice de reversão → repete uma vez; erro permanente inesperado → FAILED em transação separada; transitório → sem
  efeito e sem contar tentativa
- [X] T075 [US4] Implementar `src/wagering/interfaces/workers/pending-reference.worker.ts` (provider com ciclo de vida,
  ligado por `PENDING_WORKER_ENABLED`, `PollingLoop` com `PENDING_WORKER_POLL_MS`, claim por lease) e registrá-lo no
  `src/wagering/wagering.module.ts`. Faz o T066 a T071 passarem
- [X] T076 [US4] Revisar o diff da US4 contra o `review-checklist.md`, com atenção à ordem de lock (claim com
  `SKIP LOCKED`, processamento sob o lock da wallet, antecipação depois do lock de origem) e à releitura sob o lock;
  registrar item a item

**Checkpoint US4**: `bun test test/unit/pending-reference-policy.test.ts && bun test --preload
./test/support/db-setup.preload.ts test/integration/pending-reference-worker.test.ts
test/integration/pending-replay-after-resolution.test.ts test/concurrency/pending-worker-instances.test.ts
test/concurrency/pending-resolution-race.test.ts test/concurrency/pending-order.test.ts test/concurrency/sigkill-recovery.test.ts`,
com o T076 concluído.

---

## Phase 7: User Story 5 - Encerrar uma instância sem perder trabalho (Priority: P2)

**Goal**: término gracioso com mensagem em andamento, devolução de visibilidade e retomada de trabalho reservado.

**Independent Test**: sinal de término com mensagens em andamento, em processo e em container Linux.

### Testes da User Story 5 (escrever primeiro; devem falhar)

- [X] T077 [P] [US5] Escrever `test/integration/consumer-shutdown.test.ts` (US5 cenários 1 a 3; FR-014, FR-015; I-31,
  I-34, I-65; SC-007), com `app.close()` em processo: uma mensagem em andamento (presa no lock da wallet segurado por fora
  por 1 s) termina confirmada depois do commit; mensagens recebidas e ainda não iniciadas voltam visíveis
  (`ChangeMessageVisibility` 0) e são processadas uma vez por outra instância; com `CONSUMER_SHUTDOWN_TIMEOUT_MS` curto,
  a mensagem que não termina no prazo volta visível e é processada uma vez; eventos e pendentes reservados por uma
  instância encerrada são retomados por outra depois do lease; termina com `assertWalletMatchesLedger`
- [X] T078 [P] [US5] Escrever `test/concurrency/graceful-sigterm.test.ts` (FR-014; I-34; SC-007; R-30, R-35), com
  `container-instance` em `app-test` e em `app-test-init` com o consumidor ligado: uma mensagem em andamento (lock da
  wallet segurado por fora); `SIGTERM` → a instância conclui a mensagem, confirma e sai com 0 como PID 1; a mensagem é
  processada uma única vez

### Implementação da User Story 5

- [X] T079 [US5] Implementar a drenagem do consumidor em `src/messaging/interfaces/wager-transactions.consumer.ts` (FR-014):
  no `onApplicationShutdown`, aborta o long polling, conclui as mensagens em andamento até
  `CONSUMER_SHUTDOWN_TIMEOUT_MS` e devolve a visibilidade das não concluídas e das não iniciadas; publicador e worker
  param de reservar trabalho novo (FR-015). Faz o T077 e o T078 passarem

**Checkpoint US5**: `bun test --preload ./test/support/db-setup.preload.ts test/integration/consumer-shutdown.test.ts
test/concurrency/graceful-sigterm.test.ts test/concurrency/signal-exit.test.ts`

---

## Phase 8: User Story 6 - Conter a indisponibilidade de uma dependência (Priority: P2)

**Goal**: instâncias sobrevivem à queda do SQS ou do PostgreSQL e retomam sem reinício.

**Independent Test**: derrubar a fila e depois o banco durante o processamento e conferir que nada se perdeu.

### Testes da User Story 6 (escrever primeiro; devem falhar)

- [ ] T080 [P] [US6] Escrever `test/integration/dependency-outage.test.ts` (US6 cenários 1 a 3; FR-033 a FR-035; I-30,
  I-34), com proxies TCP na frente do PostgreSQL e do MiniStack e os três papéis ligados: SQS cortado → HTTP responde,
  consumidor, publicador e worker esperam com backoff de 1 a 30 s sem derrubar o processo; PostgreSQL cortado → nenhuma
  mensagem é confirmada nem vai à DLQ antes do limite, publicador e worker não gravam nada; com os dois restaurados, sem
  reinício, tudo é processado e publicado uma vez; termina com `assertWalletMatchesLedger`

### Implementação da User Story 6

- [ ] T081 [US6] Endurecer `src/platform/workers/polling-loop.ts` e os três trabalhadores (FR-033 a FR-035): falha de
  SQS (`ECONNREFUSED`, timeout, erro do SDK) e de PostgreSQL (classificador da 001) numa iteração → log, backoff e nova
  tentativa, nunca exceção não tratada; o laço do consumidor não apaga nem manda à DLQ por falha de infraestrutura
  própria. Faz o T080 passar

**Checkpoint US6**: `bun test --preload ./test/support/db-setup.preload.ts test/integration/dependency-outage.test.ts
test/integration/sqs-outage.test.ts`

---

## Phase 9: User Story 7 - Acompanhar a saúde do processamento por contadores (Priority: P3)

**Goal**: contadores registrados pela porta de métricas em cada ponto de decisão.

**Independent Test**: provocar duplicata, retry, DLQ, conflito de lock e evento pendente e conferir o contador.

### Testes da User Story 7 (escrever primeiro; devem falhar)

- [ ] T082 [P] [US7] Escrever `test/integration/metrics.test.ts` (US7 cenários 1 a 3; FR-036; constitution VIII), lendo
  `app.get(METRICS).snapshot()`: duplicata pela inbox e pela idempotência → `duplicates_total{source}`; transitório →
  `retries_total{worker="consumer"}`; permanente → `dlq_total{errorCode}`; lock esgotado → `lock_conflicts_total`;
  publicação → `outbox_lag_ms`; mensagem e pendente processadas → `processing_latency_ms{worker}`; transação gravada →
  `transactions_total{status}`

### Implementação da User Story 7

- [ ] T083 [US7] Instrumentar com a porta `METRICS` o consumidor, o publicador, o worker, o
  `src/wagering/application/transaction-recorder.ts` e o `src/platform/persistence/unit-of-work.ts` (`55P03` →
  `lock_conflicts_total`), sem valores monetários nos rótulos (FR-036, FR-037). Faz o T082 passar

**Checkpoint US7**: `bun test --preload ./test/support/db-setup.preload.ts test/integration/metrics.test.ts`

---

## Phase 10: Polish & Cross-Cutting Concerns

**Purpose**: guardrails, revisão final, suíte completa e quickstart.

> **Adiado (decisão de 2026-11-08, como na 001):** `README.md` e `ARCHITECTURE.md` ficam para o fim do projeto, depois
> das features 2 e 3 (tasks da 001, T119 e T120). O conteúdo que esta feature precisa deixar neles está no plan
> ("Documentação") e nas limitações do research §4 (testes contra emulador, sem validação de fidelidade à AWS real). A
> remoção de `spike/s12/` acompanha o T121 da 001.

- [ ] T084 [P] Estender `test/unit/conventions.test.ts` (T118 da 001; R-33; constitution VII): (a) em
  `test/integration/**` e `test/concurrency/**`, nenhum import de `test/support/fake-sqs.ts`, nenhuma classe
  `InMemory*Sqs*` ou `Fake*Sqs*`, nenhum `spyOn` em objeto `sqs`, e nenhum `mock.module` de `@aws-sdk`; (b) em `src/**`,
  `@aws-sdk/` só importado em `src/messaging/infrastructure/**`; (c) em `src/**/domain/**` e `src/**/application/**`,
  nenhum `Math.random(`; (d) em `test/**`, nenhum `PurgeQueue` como limpeza; cada regra com autoteste (um exemplo que passa
  e um que falha)
- [ ] T085 Revisar o diff completo da feature contra o `review-checklist.md` (gate de Revisão), incluindo o que entrou
  depois das revisões por história (US5, US6, US7 e Polish); registrar item a item; item reprovado volta para a task de
  origem antes do T086
- [ ] T086 Executar a suíte completa pelos scripts do `package.json`, com `docker compose up -d postgres sqs`:
  `bun run typecheck && bun run test` (unit, integration e concurrency), tudo verde, inclusive o T084; registrar a
  contagem de testes e a duração
- [ ] T087 Validar o `quickstart.md` de ponta a ponta: `docker compose --profile cluster up -d --build` e os cenários
  §3.1 a §3.5 com o `aws` CLI do host (`--endpoint-url http://localhost:4566`), inclusive `docker compose stop app1` com
  saída 0 e `queue-init` rodado duas vezes sem erro
- [ ] T088 **(adiado para o fim do projeto, depois das features 2 e 3)** Acrescentar ao `README.md` e ao `ARCHITECTURE.md`
  o conteúdo desta feature listado no plan ("Documentação") e no research §4

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: sem dependências.
- **Foundational (Phase 2)**: depende do Setup e **bloqueia todas as histórias**.
- **US1 (Phase 3)**: depende da Fundação.
- **US2 (Phase 4)**: depende da US1 (completa o consumidor).
- **US3 (Phase 5)**: depende da Fundação; pode correr em paralelo com US1 e US2 se houver equipe, exceto o T061
  (SIGKILL), que precisa do consumidor da US1 e da classificação da US2.
- **US4 (Phase 6)**: depende da US1 (submit estendido) e da US3 (o T071 estende o teste de SIGKILL).
- **US5 (Phase 7)**: depende da US1, da US3 e da US4 (drena os três trabalhadores).
- **US6 (Phase 8)**: depende da US1, da US3 e da US4.
- **US7 (Phase 9)**: depende de todas as histórias anteriores (instrumenta os três trabalhadores).
- **Polish (Phase 10)**: depende de todas as histórias. O T085 vem depois do T084 e antes do T086.

### Arquivos compartilhados (sem [P] entre si)

- `src/wagering/application/submit-wager-transaction.use-case.ts`: T044 → T072
- `src/messaging/application/consume-wager-message.use-case.ts`: T045 → T055
- `src/messaging/interfaces/wager-transactions.consumer.ts`: T046 → T079 → T081 → T083
- `src/platform/workers/polling-loop.ts`: T031 → T081
- `test/concurrency/sigkill-recovery.test.ts`: T061 → T071
- `src/wagering/infrastructure/mikro-orm-wager-transaction.repository.ts`: T073 (depois do que a 001 já fez)
- `src/app.module.ts`: T023 → T046 → T064

### Ordem dentro de cada história

Testes unitários → testes de integração e concorrência (falhando) → infraestrutura → use case → provider → testes verdes
→ revisão → checkpoint.

---

## Parallel Examples

### Fundação: testes

```bash
Task: "test/unit/app-config.test.ts (T004)"
Task: "test/unit/failpoints.test.ts (T005)"
Task: "test/unit/inbox-message.test.ts (T006)"
Task: "test/unit/pending-reference-policy.test.ts (T007)"
Task: "test/unit/wager-message-envelope.test.ts (T009)"
Task: "test/unit/signal-handler.test.ts (T012)"
Task: "test/integration/queue-init.test.ts (T014)"
```

### Fundação: implementação independente

```bash
Task: "migrations/Migration20261108000100.ts (T017)"
Task: "migrations/Migration20261108000200.ts (T018)"
Task: "src/inbox/** (T020)"
Task: "src/wagering/domain/pending-reference-policy.ts + src/platform/random/** (T021)"
Task: "src/platform/metrics/** (T023)"
```

### User Story 1: testes

```bash
Task: "test/integration/consumer-processing.test.ts (T039)"
Task: "test/integration/cross-channel-replay.test.ts (T040)"
Task: "test/concurrency/message-burst.test.ts (T042)"
Task: "test/concurrency/crash-before-ack.test.ts (T043)"
```

### User Story 4: testes

```bash
Task: "test/integration/pending-reference-worker.test.ts (T066)"
Task: "test/concurrency/pending-resolution-race.test.ts (T069)"
Task: "test/concurrency/pending-order.test.ts (T070)"
```

---

## Implementation Strategy

### MVP da 002: US1 + US2 + US3 (P1)

1. Phase 1 (Setup) e Phase 2 (Fundação), com o checkpoint verde.
2. US1: consumidor com inbox na mesma transação e ack depois do commit.
3. US2: classificação completa e DLQ antes do delete.
4. US3: publicador com lease e marca depois do envio, e o teste de SIGKILL no meio da carga.
5. **Critério de parada do MVP**, com 3 instâncias reais, PostgreSQL e MiniStack, todos verdes:
   - `test/concurrency/message-burst.test.ts` (50 entregas → 1 efeito, T042);
   - `test/concurrency/crash-before-ack.test.ts` (T043);
   - `test/concurrency/concurrent-publishers.test.ts` (T060);
   - `test/concurrency/sigkill-recovery.test.ts` (T061: wallet == ledger, nenhum evento perdido, nenhuma pendência sem
     próxima tentativa, toda mensagem processada uma vez ou na DLQ);
   - `test/integration/consumer-permanent-errors.test.ts` e `consumer-unexpected-errors.test.ts` (SC-004);
   - revisões T047, T057 e T065 concluídas contra o `review-checklist.md`;
   - suítes da 001 continuam verdes.
6. Parar e validar antes de seguir para P2.

### Entrega incremental

MVP → US4 (worker de PENDING_REFERENCE) → US5 (término gracioso) → US6 (queda de dependência) → US7 (métricas) → Polish.
Cada checkpoint mantém verdes os testes das histórias anteriores e da 001.

---

## Notes

- `[P]` significa arquivo diferente e nenhuma dependência de task incompleta; tasks no mesmo arquivo nunca têm `[P]`
  entre si.
- Os testes de integração e de concorrência de cada história precisam falhar antes da implementação.
- Nenhum teste de integração ou concorrência usa mock de PostgreSQL ou de SQS. Os doubles permitidos são `FixedClock`,
  `SequentialIdGenerator`, `FixedRandom`, o `exit` injetado nos failpoints e no handler de sinal, e o `fake-sqs` **só em
  `test/unit/`**.
- Cada commit deve deixar `bun run typecheck` verde.
