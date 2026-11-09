# Implementation Plan: Mensageria Confiável

**Branch**: `002-messaging-reliability` (id da feature; o trabalho segue na branch `main`) | **Date**: 2026-11-08 |
**Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/002-messaging-reliability/spec.md`

**Fontes lidas**: [spec.md](spec.md), `docs/enunciado.md` §3, §7.1, §10 a §13, `docs/interpretacoes.md` (I-01 a I-69),
`.specify/memory/constitution.md` v1.0.1, e o plan, a research e a data-model da feature 001
(`specs/001-wagering-transaction-core/`), cujas decisões R-01 a R-19 continuam valendo.

**Artefatos**: [research.md](research.md) · [data-model.md](data-model.md) · [contracts/](contracts/) ·
[quickstart.md](quickstart.md)

## Summary

Três trabalhadores de fundo, ligados por variável de ambiente, sobre o núcleo transacional da 001:

- **Consumidor da fila de transações**: recebe `WagerTransactionRequested`, deduplica pela inbox, chama o mesmo
  `SubmitWagerTransactionUseCase` do HTTP e grava a inbox na mesma transação SQL do efeito. Só confirma a mensagem
  (DeleteMessage) depois do commit. Erros de negócio são confirmados; transitórios voltam com espera crescente e vão à
  DLQ pelo redrive depois de 5 recebimentos; permanentes são enviados à DLQ pela aplicação, com atributos, e só depois
  apagados da fila principal (FR-001 a FR-013, I-28, I-30, I-68).
- **Publicador da outbox**: reserva lotes de até 10 eventos com lease de 30 s (`FOR UPDATE SKIP LOCKED` que avança
  `next_attempt_at`), publica fora da transação e só marca como publicado depois do SendMessage (FR-016 a FR-022,
  I-31, I-65).
- **Worker de PENDING_REFERENCE**: reserva pendentes vencidas por lease curto, reavalia cada uma sob o lock da wallet
  com as regras da 001 e conclui, reagenda ou rejeita com `REFERENCE_NOT_FOUND`. A chegada de uma referência só puxa o
  `next_reference_attempt_at` das dependentes para agora (FR-023 a FR-032, I-21, I-61 a I-64).

Garantias continuam no banco: inbox com PK `(consumer_name, message_id)`, idempotência e reversão única da 001, ordem
única de lock (wallet primeiro, linhas de transação depois). A fila é otimização (constitution III).

Stack: a da 001 (Bun 1.4.4, TypeScript strict, NestJS 12.2.0, MikroORM 7.2.5, PostgreSQL, decimal.js, Zod) mais
`@aws-sdk/client-sqs` 3.1156.0, contra LocalStack (ou MiniStack, I-43) em container. **Spike S-12 obrigatório antes da
implementação** ([research.md §0](research.md#0-spike-s-12-obrigatório)).

## Technical Context

**Language/Version**: TypeScript strict sobre Bun 1.4.4, sem etapa de build (001, R-01, R-18).

**Primary Dependencies**: as da 001, com as mesmas versões exatas, mais `@aws-sdk/client-sqs` **3.1156.0**
(publicada em 2026-10-22; critério da 001: estável mais recente publicada há pelo menos 14 dias, consultada no registro
npm em 2026-11-08; a `latest` é 3.1164.0, de 2026-11-06). Sem `^` nem `~`. Nenhuma outra dependência nova (R-20).

**Storage**: PostgreSQL. Duas migrations novas: `inbox_messages` e os índices parciais do worker de PENDING_REFERENCE.
Nenhuma coluna nova nas tabelas da 001 (data-model §2).

**Messaging**: SQS emulado. Filas FIFO `wager-transactions.fifo` (entrada), `wager-transactions-dlq.fifo` (DLQ por
redrive com `maxReceiveCount` 5) e `wager-events.fifo` (saída da outbox). `MessageGroupId` = `walletId`;
`MessageDeduplicationId` = `messageId` na entrada e `eventId` na saída (I-29, I-30). Imagem candidata
`localstack/localstack:2026.10.2` (2026-10-22); alternativa `ministackorg/ministack:1.5.32` (2026-10-23), se o
LocalStack exigir token (I-43). Decidido pelo spike S-12.

**Testing**: `bun test`, com PostgreSQL e SQS reais (constitution VII). Cada arquivo de teste usa o próprio banco
(001, R-17) **e as próprias filas**, criadas com prefixo único e apagadas no fim (R-31). Concorrência com 3 processos
reais e papéis diferentes. Término gracioso por SIGTERM testado em container Linux (R-30).

**Target Platform**: Linux em container (`oven/bun:1.4.4`); desenvolvimento local em Windows/macOS/Linux com Docker.

**Project Type**: web-service com trabalhadores de fundo (projeto único).

**Performance Goals**: SC-010 (evento publicado em até 5 s; mensagem processada e confirmada em até 2 s, sem disputa);
SC-005 (pendente concluída em até 5 s depois da referência). Polling de cerca de 1 s no publicador e no worker (I-65).

**Constraints**: hierarquia de tempos validada no boot (R-27): visibilidade da fila e leases maiores que o pior caso de
uma unidade de trabalho (aquisição de conexão + lock + margem); prazo de término gracioso menor que o
`stop_grace_period` do Compose. Nenhum estado em memória como garantia (constitution III, IV).

**Scale/Scope**: 3 filas, 3 trabalhadores, 2 migrations, 3 instâncias no profile `cluster` com papéis diferentes.

**Spike**: S-12 **pendente**; é a primeira task da implementação e bloqueia as demais que tocam SQS. Critérios e
alternativas em [research.md §0](research.md#0-spike-s-12-obrigatório).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Princípios

| # | Princípio | Como o plan atende | Pré | Pós |
|---|-----------|--------------------|-----|-----|
| I | Fontes da verdade e precedência | Toda decisão cita FR/I-xx. As decisões novas do usuário (I-61 a I-69) foram registradas em `docs/interpretacoes.md` antes da spec e deste plan; as leituras que surgiram no plan viraram I-70 a I-73 ([Pendências de decisão](#pendências-de-decisão), todas resolvidas). Opcionais (carga, caos separado, UI, métricas expostas) fora do escopo. | ✅ | ✅ |
| II | Correção financeira | Nenhuma conta nova com dinheiro: o consumidor e o worker reusam `WagerRulesService`, `Wallet` e o gravador de transações da 001 (R-24). A conclusão de uma pendente grava saldo, lançamento e eventos na mesma transação (FR-027). Mensagem com dinheiro como número é payload inválido (FR-002, I-01). Nenhum `number` em dinheiro (T118 da 001 continua valendo). | ✅ | ✅ |
| III | Concorrência por wallet | Ordem única de lock: wallet primeiro, linhas de transação depois (R-26). O worker reserva por lease numa transação mínima com `SKIP LOCKED`, sem lock de wallet, e processa sob o lock da wallet relendo a linha (FR-028). Sem lock global. Corretude com 3 instâncias de papéis diferentes, provada nos testes de concorrência. Leases e inbox no banco, nunca em memória. | ✅ | ✅ |
| IV | Idempotência persistente e mensageria confiável | Inbox com PK `(consumer_name, message_id)` e `payload_hash` (I-28); inbox, transação, saldo, ledger e outbox na mesma transação (FR-003); ack só depois do commit (FR-005); outbox publicada só fora da transação e depois do commit, com lease e `SKIP LOCKED` para publicadores concorrentes (FR-016 a FR-020, I-31, I-65); HTTP e fila no mesmo use case (FR-001); classificação negócio/transitório/permanente (FR-008 a FR-010, I-30, I-66, I-68); SIGTERM conclui ou devolve visibilidade (FR-014, I-34); PENDING_REFERENCE com worker, backoff, limite e `REFERENCE_NOT_FOUND` + evento (FR-023 a FR-025, I-21, I-64). | ✅ | ✅ |
| V | Invariantes impostas pelo schema | `inbox_messages` com PK composta, `CHECK`s de formato e trigger de imutabilidade; índices parciais do worker; nenhuma guarda da 001 é afrouxada; migrations versionadas com `up` e `down`, testadas em `up → down → up`. A resolução de pendente passa pelos triggers de transição e de encadeamento do ledger já existentes. | ✅ | ✅ |
| VI | Domínio encapsulado e portas | `InboxMessage` com construtor privado, `receive` e `rehydrate` (enunciado §6.5). Política de PENDING_REFERENCE como serviço de domínio puro, com jitter vindo de uma porta `RandomSource` (R-25). Portas novas: `SqsPort`, `MetricsPort`, `RandomSource`. Domínio sem `@aws-sdk`, `@nestjs` ou `@mikro-orm` (T118 da 001). | ✅ | ✅ |
| VII | Testes reais | `bun test` para unitários, integração e concorrência; PostgreSQL e SQS reais em containers, sem mocks (T118 estendido às regras de SQS, R-33); 3 processos reais; SIGKILL no meio da carga e SIGTERM em container Linux; `assertWalletMatchesLedger` ao fim de todo teste que toca wallet; cenários §13 do enunciado cobertos na [matriz](#matriz-de-testes). | ✅ | ✅ |
| VIII | Observabilidade e contrato | Logs JSON com `messageId`, `correlationId` (= `messageId` na fila, I-69), `transactionId`, `walletId`, `providerId`, sem valores monetários (FR-037). Porta de métricas com os contadores exigidos (FR-036); exposição e health checks ficam para outra feature, como na 001. Atributos `errorCode` e `errorClass` nas mensagens da DLQ (FR-040, I-68). Replay de FAILED com `retryable` false (I-62). | ✅ | ✅ |
| IX | Documentação | `README.md` e `ARCHITECTURE.md` estão adiados para o fim do projeto por decisão registrada no tasks da 001 (T119, T120); este plan lista o que precisa entrar neles ([Documentação](#documentação)). O gate de documentação da constitution continua pendente até esse fechamento, já anotado. | ✅* | ✅* |
| — | Stack | Bun, TS strict, NestJS, PostgreSQL, MikroORM, MikroORM Migrations, Docker Compose e SQS via LocalStack ou MiniStack. | ✅ | ✅ |

\* IX: exceção temporária decidida pelo usuário em 2026-11-08 (tasks da 001), registrada em
[Complexity Tracking](#complexity-tracking). Não é exceção a princípio NÃO-NEGOCIÁVEL.

### Falhas eliminatórias

| # | Falha | Como é evitada | Prova | Status |
|---|-------|----------------|-------|--------|
| 1 | `number` para dinheiro | dinheiro só passa pelos tipos da 001; envelope valida `amount` como string (FR-002) | unitários do envelope; T118 | ✅ |
| 2 | Saldo negativo por race | conclusão de pendente sob o lock da wallet, com as regras de saldo da 001 (FR-024) | corrida worker × BET, ×20, 3 instâncias | ✅ |
| 3 | Débito ou crédito duplicado | inbox + idempotência + reversão única; worker relê o status sob o lock (FR-007, FR-028) | 50 entregas da mesma mensagem; worker em 3 instâncias; REFUND × ROLLBACK pendentes | ✅ |
| 4 | Idempotência só em memória | inbox e leases no banco; nenhum cache decide nada | revisão + testes com 3 processos | ✅ |
| 5 | Correto só com uma instância | toda coordenação no banco (PK, lease com `SKIP LOCKED`, lock da wallet) | toda a suíte de concorrência com 3 processos | ✅ |
| 6 | Evento publicado antes do commit | o publicador lê só linhas confirmadas da outbox, fora da transação de negócio (FR-020) | queda depois do commit e antes da publicação; atomicidade com failpoint | ✅ |
| 7 | Ledger não auditável | nada muda no ledger; a resolução grava lançamento pelo mesmo caminho da 001 | `assertWalletMatchesLedger` em todos os testes | ✅ |
| 8 | Testes que trocam PG e SQS por mocks | PostgreSQL e SQS reais; T118 estendido proíbe mock de cliente SQS em integração e concorrência (R-33) | estrutura de `test/` + T118 | ✅ |

**Resultado do gate**: aprovado antes e depois do design. Bloqueio de implementação até o spike S-12 aprovar.

## Project Structure

### Documentation (this feature)

```text
specs/002-messaging-reliability/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── wager-transaction-requested.schema.json   # envelope de entrada (FR-002, I-69)
│   ├── integration-events.schema.json            # envelopes publicados em wager-events.fifo (FR-022)
│   └── queues.md                                 # filas, grupos, deduplicação, redrive, atributos da DLQ
├── checklists/
│   └── requirements.md
└── tasks.md                                      # gerado por /speckit-tasks
```

### Source Code (repository root)

Só o que é novo ou muda; o resto segue a estrutura da 001.

```text
src/
├── platform/
│   ├── config/app-config.ts                       # + variáveis de SQS, papéis e tempos (R-27)
│   ├── correlation/request-context.ts             # + messageId e causationId no contexto (FR-037, I-69)
│   ├── logging/json-logger.ts                     # + messageId nas linhas
│   ├── failpoints/failpoints.ts                   # + after_commit_before_ack, before_publish_mark,
│   │                                              #   after_pending_resolution_before_commit (R-29)
│   ├── persistence/pg-errors.ts                   # + inbox_messages_pk → 'inbox-race'
│   ├── metrics/{metrics.port.ts, in-memory-metrics.ts}   # porta + registro em memória (FR-036, R-32)
│   ├── random/{random-source.port.ts, crypto-random-source.ts}   # jitter (R-25)
│   └── workers/{polling-loop.ts, worker-registry.ts}      # laço com backoff e parada; ordem de shutdown (R-28)
├── messaging/
│   ├── application/
│   │   ├── sqs.port.ts                            # SQS_PORT: receive, delete, changeVisibility, send (R-21)
│   │   ├── wager-message.envelope.ts              # Zod do envelope, reusa o schema da submissão (FR-002)
│   │   ├── message-classification.ts              # negócio | transitório | permanente → ação (R-23)
│   │   └── consume-wager-message.use-case.ts      # inbox → use case → ack/visibilidade/DLQ (R-22)
│   ├── infrastructure/aws-sqs.adapter.ts          # @aws-sdk/client-sqs (único lugar que o importa)
│   ├── interfaces/wager-transactions.consumer.ts  # provider Nest: onApplicationBootstrap/onApplicationShutdown
│   └── messaging.module.ts
├── inbox/
│   ├── domain/inbox-message.ts                    # enunciado §6.5
│   └── infrastructure/{inbox-message.schema.ts, inbox-message.mapper.ts, mikro-orm-inbox.repository.ts}
├── outbox/
│   ├── application/publish-outbox.use-case.ts     # claim → send → mark | scheduleRetry (R-34)
│   ├── infrastructure/mikro-orm-outbox.repository.ts  # claim com FOR UPDATE SKIP LOCKED + lease
│   └── interfaces/outbox-publisher.worker.ts      # provider Nest com ciclo de vida
├── wagering/
│   ├── domain/pending-reference-policy.ts         # backoff, jitter, limite e teto (I-21, I-64)
│   ├── domain/wager-transaction.ts                # + scheduleNextReferenceAttempt (I-11)
│   ├── application/transaction-recorder.ts        # gravação de decisão extraída do submit (R-24)
│   ├── application/submit-wager-transaction.use-case.ts  # + inbox opcional, antecipação, origem fila (R-22, R-26)
│   ├── application/resolve-pending-reference.use-case.ts # reavaliação sob lock (FR-024 a FR-031)
│   ├── application/transaction-result.ts          # + FAILED → erro 500 retryable false (I-62)
│   ├── infrastructure/mikro-orm-wager-transaction.repository.ts  # + claim de pendentes, resolução, antecipação
│   └── interfaces/workers/pending-reference.worker.ts
migrations/
├── Migration20261108000100.ts                     # inbox_messages + trigger de imutabilidade
└── Migration20261108000200.ts                     # índices parciais do worker de PENDING_REFERENCE
scripts/sqs-setup.ts                               # cria as filas FIFO e o redrive (Compose e testes)

test/
├── unit/{wager-message-envelope, message-classification, pending-reference-policy, inbox-message,
│         in-memory-metrics, polling-loop}.test.ts  # + casos novos em failpoints, app-config, outbox-message,
│                                                   #   wager-transaction, transaction-result, conventions
├── integration/{inbox-schema, consumer-processing, consumer-permanent-errors, consumer-transient-errors,
│                consumer-atomicity, cross-channel-replay, failed-replay, outbox-publisher, sqs-outage,
│                pending-reference-worker, pending-replay-after-resolution, consumer-shutdown}.test.ts
├── concurrency/{message-burst, crash-before-ack, concurrent-publishers, pending-worker-instances,
│                pending-resolution-race, pending-order, sigkill-recovery, graceful-sigterm}.test.ts
└── support/{test-queues.ts, sqs-client.ts, container-instance.ts}   # + instance-cluster com papéis
docker-compose.yml                                 # + localstack, sqs-init, papéis por instância
```

**Structure Decision**: mantém os módulos por contexto da 001 e acrescenta `messaging` (consumo) e `inbox`. O
publicador fica em `outbox` e o worker em `wagering`, junto dos dados que manipulam. Os trabalhadores são providers do
Nest com `onApplicationBootstrap` (inicia o laço, se o papel estiver ligado) e `onApplicationShutdown` (para o laço e
drena). `@aws-sdk/client-sqs` só é importado em `messaging/infrastructure`; o resto usa a porta `SqsPort`. Domínio
continua importando só domínio, shared-kernel/domain e `decimal.js` (T118).

## Design

### Consumidor da fila de transações (FR-001 a FR-015, FR-037 a FR-040)

Laço (`PollingLoop`, R-28), ligado por `CONSUMER_ENABLED`:

1. `ReceiveMessage` com long polling (`CONSUMER_WAIT_SECONDS`, até 20), até 10 mensagens, pedindo
   `ApproximateReceiveCount`. Mensagens do mesmo `MessageGroupId` são processadas em sequência, grupos diferentes em
   paralelo (R-22).
2. Para cada mensagem, num contexto de requisição próprio (`correlationId` = `causationId` = `messageId`, I-69):
   1. **Envelope** (Zod, `contracts/wager-transaction-requested.schema.json`): JSON inválido, campo ausente,
      `messageId` fora do formato, `type` desconhecido (I-66), `data` inválido (regras da 001, I-60), OPENING (I-08) →
      permanente.
   2. **Inbox, caminho rápido** (fork, fora de transação): mesmo `(consumer_name, message_id)` e mesmo hash → ack sem
      efeito (métrica de duplicata, origem inbox); hash diferente → permanente `INBOX_PAYLOAD_MISMATCH` (I-28).
   3. **Use case** `SubmitWagerTransactionUseCase` com origem fila (chave = `data.idempotencyKey`, inbox anexada):
      - caminho rápido de idempotência: replay → grava a linha de inbox numa transação mínima, apontando a transação
        existente → ack; conflito → permanente `IDEMPOTENCY_CONFLICT`, **sem linha de inbox** (I-68); replay de
        FAILED → ack (I-62);
      - wallet inexistente → permanente `WALLET_NOT_FOUND` (I-20, I-30);
      - sob o lock da wallet: relê a inbox (duplicata confirmada antes → ack) e a idempotência (replay → grava inbox
        na mesma transação); efeito novo → transação, saldo, ledger, outbox **e inbox** na mesma transação (FR-003).
   4. **Resultado**: REJECTED ou PENDING_REFERENCE gravados são negócio → ack (FR-008).
3. **Ack** = `DeleteMessage`, sempre depois do commit (FR-005). Failpoint `after_commit_before_ack` entre os dois
   (R-29).
4. **Transitório** (classificador da 001: conexão, `55P03`, `40P01`/`40001` esgotados, timeout, pool): não apaga;
   `ChangeMessageVisibility` para `min(base × 2^(n−1), teto)` segundos, com `n` = `ApproximateReceiveCount`; a 6ª
   entrega não acontece porque o redrive move a mensagem para a DLQ ao passar de 5 recebimentos (FR-009, I-30).
5. **Permanente**: `SendMessage` para a DLQ com o corpo original, o mesmo grupo, deduplicação pelo `messageId` e os
   atributos `errorCode`, `errorClass` = `permanent`, `receiveCount` e `consumer`; **só depois** `DeleteMessage` na
   fila principal (FR-040, I-68, I-70). Queda entre os dois → a mensagem volta, é classificada de novo e reenviada; a
   deduplicação da DLQ absorve a repetição dentro da janela de 5 min (R-23).
6. **Erro inesperado** (quebra de invariante, erro não classificado): transitório, com o mesmo backoff do passo 4; no
   5º recebimento (`ApproximateReceiveCount` = 5) a aplicação envia à DLQ com `errorCode` `INTERNAL_ERROR` e
   `errorClass` `unexpected`, como no passo 5, e só então apaga da fila principal. O redrive (`maxReceiveCount` 5) fica
   como rede de segurança, sem atributos. O consumidor nunca grava FAILED (FR-009a, I-61, I-71).

Correspondência com o use case da 001: o comando ganha a origem (`http` | `queue`), a inbox opcional e o
`causationId`; o HTTP não muda de comportamento (R-22).

### Publicador da outbox (FR-016 a FR-022, FR-033)

Laço ligado por `PUBLISHER_ENABLED`, polling `PUBLISHER_POLL_MS` (~1 s):

1. **Claim** numa transação curta: `SELECT id ... WHERE published_at IS NULL AND next_attempt_at <= now ORDER BY
   next_attempt_at LIMIT 10 FOR UPDATE SKIP LOCKED` e `UPDATE ... SET next_attempt_at = now + 30 s` dos ids reservados;
   commit. O índice `outbox_pending_idx` da 001 atende a consulta (I-31, I-65).
2. **Publicação**, fora de transação, evento a evento: `SendMessage` em `wager-events.fifo` com o envelope gravado
   (`payload`, sem alteração), `MessageGroupId` = `aggregateId` (walletId), `MessageDeduplicationId` = `eventId`
   (I-29, FR-019, FR-022).
3. **Marca** só depois do SendMessage aceito: `UPDATE ... SET published_at = now WHERE id = ? AND published_at IS NULL`
   (idempotente se dois publicadores marcarem). Failpoint `before_publish_mark` entre o envio e a marca (R-29).
4. **Falha de envio**: `attempts + 1` e `next_attempt_at = now + backoff` (1, 2, 4 … até 60 s), pela regra do
   `OutboxMessage.scheduleRetry` (I-31, I-65), sem afetar os outros eventos do lote (FR-018).
5. **Atraso da outbox** = `now − occurred_at` no momento da marca, registrado na porta de métricas (FR-036).

Queda antes de publicar → o lease expira e outro publicador assume. Queda depois de publicar e antes de marcar →
republicação com o mesmo `eventId` (FR-019). SQS fora → envio falha, o evento é reagendado e a outbox acumula; o HTTP
não depende do publicador (FR-033).

### Worker de PENDING_REFERENCE (FR-023 a FR-032)

Laço ligado por `PENDING_WORKER_ENABLED`, polling `PENDING_WORKER_POLL_MS` (~1 s):

1. **Claim por lease**, transação mínima, sem lock de wallet: `SELECT id, wallet_id ... WHERE status =
   'PENDING_REFERENCE' AND next_reference_attempt_at <= now ORDER BY next_reference_attempt_at, created_at LIMIT n FOR
   UPDATE SKIP LOCKED` e `UPDATE ... SET next_reference_attempt_at = now + lease` (30 s). Commit. Usa o índice parcial
   `wager_tx_pending_due_idx` (R-26, data-model §2.2).
2. **Processamento de cada reservada**, cada uma na própria transação pela unit of work (lock timeout, repetição de
   `40P01`/`40001`):
   1. `FOR UPDATE` da wallet (primeiro lock);
   2. **Ordem do I-63**: antes da reservada, as pendentes mais antigas da mesma wallet e da mesma
      `(provider_id, reference_external_transaction_id)` ainda PENDING_REFERENCE são reavaliadas primeiro, cada uma na
      própria transação. Assim a ordem por `created_at` vale qualquer que seja a instância que reservou (R-26);
   3. relê a linha da pendente sob o lock: se não está mais PENDING_REFERENCE (outra instância concluiu), não faz nada
      (FR-028);
   4. carrega a referência e a reversão existente como no submit, e chama `WagerRulesService.decide` (I-44);
   5. decisão:
      - **aplicar** → `markProcessed` (reescreve `observed_balance` e `reference_transaction_id`, I-67), saldo,
        lançamento, `WalletBalanceChanged` + `WagerTransactionProcessed`;
      - **rejeitar** → `reject` com o código, `WagerTransactionRejected`;
      - **continua pendente** (a referência foi relida nesta avaliação e segue ausente ou pendente) → se
        `PendingReferencePolicy` diz que esgotou (10 tentativas contando esta, ou teto de 10 min desde `created_at`) →
        `reject(REFERENCE_NOT_FOUND)` + evento; senão `scheduleNextReferenceAttempt` (tentativas + 1 e próxima hora com
        backoff e jitter, I-11). Como a referência é sempre reavaliada antes do esgotamento, uma referência que chegou
        antes da última tentativa resolve normalmente (FR-025, I-21, I-64, I-72);
   6. os eventos do worker usam o `correlation_id` gravado na pendente, sem `causationId` (I-69);
   7. ao concluir (PROCESSED ou REJECTED), puxa para agora o `next_reference_attempt_at` das pendentes que referenciam
      esta transação (encadeamento, I-63);
   8. failpoint `after_pending_resolution_before_commit` antes do commit (R-29).
3. **Falha transitória** numa tentativa: rollback sem efeito; a tentativa não conta; o lease expira e a pendente volta
   (Assumptions da spec).
4. **Falha permanente inesperada**: rollback; numa transação separada, sob o lock da wallet, `fail(INTERNAL_ERROR)` →
   FAILED, sem lançamento nem evento (FR-029, I-22, I-61).
5. **`23505` no índice de reversão única** (corrida com outra reversão): repete a reavaliação uma vez, como no submit
   (001, R-12).

**Antecipação** (FR-026, I-21, I-63): quando qualquer transação fica PROCESSED ou REJECTED (pelo HTTP, pela fila ou
pelo worker), na mesma transação, `UPDATE wager_transactions SET next_reference_attempt_at = now WHERE status =
'PENDING_REFERENCE' AND provider_id = ? AND reference_external_transaction_id = ?` (índice
`wager_tx_pending_by_reference_idx`). Não processa as dependentes no caminho da requisição: o worker as pega na próxima
varredura (`PENDING_WORKER_POLL_MS`, ~1 s), na ordem do I-63 e com a ordem de lock wallet primeiro (I-73).

### Ordem única de lock (constitution III, R-26)

Em todo o sistema: **wallet primeiro, linhas de transação depois**. Submit e worker travam a wallet antes de escrever
qualquer transação. As únicas transações que tocam linhas de `wager_transactions` sem travar a wallet são o claim do
worker (só `SKIP LOCKED`, nunca espera) e a antecipação, que roda dentro de uma transação que já travou a wallet da
transação de origem e só faz `UPDATE` das dependentes. Inbox e outbox são linhas próprias, sem ciclo com a wallet.
`40P01` continua tratado (001, R-12).

### HTTP (mudanças da 001)

- Replay de transação FAILED → 500 `INTERNAL_ERROR` com `retryable` false, no envelope do I-38 (FR-030, I-62). Hoje o
  `httpStatusFor` não trata FAILED e o filtro responde `retryable` true; passa a existir um erro de aplicação próprio.
- Replay depois da resolução devolve o estado atual (FR-039, I-67): o `TransactionResult` já lê o estado gravado; o
  status HTTP segue o I-39.
- Antecipação de dependentes ao concluir uma transação (acima).

### Encerramento gracioso (FR-014, FR-015, I-34)

`enableShutdownHooks` (001) dispara `onApplicationShutdown` em SIGTERM e em `app.close()`. Cada trabalhador para de
reservar trabalho novo (aborta o long polling) e drena o que está em andamento até `CONSUMER_SHUTDOWN_TIMEOUT_MS`. O
consumidor devolve a visibilidade (`ChangeMessageVisibility` 0) das mensagens recebidas e não concluídas no prazo. O
`OrmLifecycle` aguarda o `WorkerRegistry` drenar antes de fechar o pool, porque a ordem entre providers no mesmo hook
não é garantida (R-28). O `stop_grace_period` do Compose é maior que o prazo (R-27).

### Indisponibilidade (FR-033 a FR-035)

- **SQS fora**: `ReceiveMessage` e `SendMessage` falham; os laços esperam com backoff (1 a 30 s) e tentam de novo; o
  HTTP segue e a outbox acumula. Volta automática.
- **PostgreSQL fora**: o consumidor trata como transitório (sem ack); publicador e worker falham no claim e esperam. O
  guarda de pool da 001 (T110) descarta conexões perdidas; volta sem reinício.
- Limitação documentada: indisponibilidade do banco mais longa que a soma das esperas de visibilidade (cerca de 75 s com
  o padrão) leva mensagens válidas à DLQ pelo redrive; o redrive manual as recupera (I-61).

### Convenções de implementação

As da 001 continuam (SQL com `?`, EM da transação dentro de `transactional()`, `DecimalType('string')`, injeção só por
`@Inject(TOKEN)`, banco por arquivo de teste). Novas:

- `@aws-sdk/client-sqs` só em `src/messaging/infrastructure/` (T118, R-33).
- Todo laço de fundo usa `PollingLoop`, com parada cooperativa, backoff em erro e `AbortSignal` no long polling.
- Tempo pela porta `Clock`, ids pela `IdGenerator`, jitter pela `RandomSource` (constitution VI).
- Filas por arquivo de teste, criadas e apagadas pelo `test/support/test-queues.ts`, sem `PurgeQueue` como limpeza
  (R-31).

### Deploy local

`docker-compose.yml` ganha:

- `localstack` (imagem fixada pelo spike), healthcheck do serviço SQS;
- `sqs-init`: `bun scripts/sqs-setup.ts`, cria as 3 filas FIFO e o redrive (`maxReceiveCount` 5), depende do
  `localstack` saudável;
- `app1`: HTTP + consumidor; profile `cluster`: `app2` HTTP + consumidor + publicador; `app3` HTTP + publicador +
  worker de PENDING_REFERENCE (papéis por `CONSUMER_ENABLED`, `PUBLISHER_ENABLED`, `PENDING_WORKER_ENABLED`);
- `stop_grace_period: 30s` nas apps.

Scripts novos: `sqs:setup` (`bun scripts/sqs-setup.ts`). Os de teste não mudam; as suítes de integração e concorrência
passam a exigir o `localstack` do Compose no ar.

### Matriz de testes

| Área | Testes | Requisitos |
|------|--------|------------|
| Envelope | JSON inválido; campo ausente; `messageId` vazio, com 129 caracteres ou fora de `[A-Za-z0-9._:-]`; `type` desconhecido; `occurredAt` não ISO; `data` com dinheiro número, OPENING, "system", autorreferência; campos desconhecidos descartados | FR-002, I-57, I-60, I-66, I-69 |
| Classificação | cada erro → ação (ack, visibilidade com backoff, DLQ com `errorCode`); backoff por `ApproximateReceiveCount` | FR-008 a FR-010, I-30, I-68 |
| Política de pendente | sequência 5, 10, 20, 40, 60… (sem jitter = 435 s); jitter dentro dos limites; esgota na 10ª; teto de 10 min; transitório não conta; na última tentativa a referência aplicada ou rejeitada resolve normalmente (I-72) | FR-023, FR-025, I-21, I-64 |
| Domínio | `InboxMessage` (`receive`, `rehydrate`, `markProcessed`); `scheduleNextReferenceAttempt` só em PENDING_REFERENCE; `OutboxMessage.scheduleRetry` 1 a 60 s | enunciado §6.5, I-11, I-65 |
| Schema | migrations `up → down → up`; PK da inbox; `CHECK`s; imutabilidade da inbox; índices parciais no catálogo | constitution V |
| Consumo | BET pela fila = HTTP; inbox, outbox e efeito juntos; REJECTED e PENDING_REFERENCE confirmados; `correlationId`/`causationId` = `messageId` nos eventos; logs com `messageId` | FR-001, FR-003, FR-008, FR-037, FR-038 |
| Permanentes | cada classe → DLQ com 1 recebimento e atributos, nada gravado, removida da fila principal | FR-010, FR-040, SC-004 |
| Transitórios | banco cortado (proxy TCP da 001) → 5 recebimentos → DLQ; banco volta antes do limite → 1 efeito | FR-009, SC-004 |
| Erro inesperado | failpoint `after_ledger_insert_before_commit` pela fila em toda entrega → 4 voltas com backoff e, no 5º recebimento, DLQ enviada pela aplicação com `INTERNAL_ERROR`/`unexpected`; nada gravado, nem inbox, nem FAILED | FR-009a, FR-040, I-71 |
| Atomicidade | failpoint entre o lançamento e o commit pela fila → nada gravado, nem inbox | FR-003, FR-013 |
| Replay cruzado | HTTP depois fila e fila depois HTTP → 1 efeito, a segunda é replay | FR-006, I-28 |
| FAILED | worker com erro permanente (failpoint) → FAILED em transação separada; replay HTTP → 500 `retryable` false; replay pela fila → ack | FR-029, FR-030, FR-012, I-61, I-62 |
| Publicação | evento publicado com o envelope intacto, grupo e deduplicação; falha de envio → reagendado; marcação só depois do envio | FR-016 a FR-022 |
| SQS fora | proxy TCP na frente do LocalStack: HTTP segue, outbox acumula; volta → tudo publicado | FR-033, SC-009 |
| Worker | referência aplicada → PROCESSED + eventos; rejeitada → `REFERENCE_REJECTED`; nunca chega → `REFERENCE_NOT_FOUND` (limites curtos por env); mismatch; overdraw; encadeamento; não reabre depois do NOT_FOUND | FR-023 a FR-031 |
| Replay depois da resolução | 202 antes; 200/422 depois, com o saldo da conclusão; `correlation_id` intacto | FR-039, I-67 |
| Término (in-process) | `app.close()` com mensagens em andamento → concluídas ou devolvidas; nada perdido | FR-014, FR-015, SC-007 |
| Concorrência (3 processos) | mesma mensagem 50× por 3 instâncias → 1 efeito; queda depois do commit e antes do ack → duplicata; 2 publicadores + queda antes da marca → todos publicados, nenhum pendente; worker em 3 instâncias → cada pendente 1 vez; **corrida worker × BET que resolve a pendente**, ×20; REFUND × ROLLBACK pendentes → ordem do I-63 | SC-001 a SC-003, SC-005, SC-008 |
| SIGKILL no meio da carga | 3 instâncias com papéis diferentes, fila + HTTP; SIGKILL aleatório e substituição; ao final: wallet == ledger em todas, todo evento confirmado publicado (e presente na fila de eventos), nenhuma pendente sem próxima tentativa, toda mensagem processada uma vez ou na DLQ | SC-006, SC-008 |
| SIGTERM real | instância em container Linux com mensagens em andamento; `docker kill --signal SIGTERM` → saída 0, nada perdido | FR-014, SC-007 |
| Guardrails (T118) | + nenhum mock de cliente SQS em integração/concorrência; `@aws-sdk` só em `messaging/infrastructure` | constitution VII, R-33 |
| Invariante final | `assertWalletMatchesLedger` em toda wallet tocada | SC-006 |

### Documentação

Adiada para o fim do projeto (tasks da 001). Conteúdo que o `ARCHITECTURE.md` precisará cobrir desta feature: topologia
de filas e deduplicação; inbox e a ordem dos passos do consumidor; classificação de erros e atributos da DLQ; outbox com
lease; worker de PENDING_REFERENCE (lease, ordem do I-63, antecipação, limite e teto); ordem única de lock; encerramento
gracioso; limitações (grupo FIFO bloqueado por retry, ordem de eventos não garantida, DLQ por redrive em queda longa do
banco, janela de deduplicação de 5 min). O `README.md`: LocalStack no Compose, `sqs:setup`, papéis por env e os novos
requisitos das suítes.

## Pendências de decisão

Todas resolvidas em 2026-11-08 e registradas em `docs/interpretacoes.md`:

1. **Códigos de DLQ fora da taxonomia §7** → **I-70**: `MALFORMED_MESSAGE`, `UNSUPPORTED_MESSAGE_TYPE` e
   `INBOX_PAYLOAD_MISMATCH` numa tabela própria da §7; toda mensagem enviada pela aplicação à DLQ leva `errorCode` e
   `errorClass`.
2. **Erro inesperado no consumidor** → **I-71**: transitório, com retry e backoff; no 5º recebimento a aplicação envia
   à DLQ com `INTERNAL_ERROR`/`unexpected`; o redrive fica como rede de segurança. Substitui a proposta original (DLQ
   direta).
3. **Esgotamento** → **I-72**: na última tentativa a referência é reavaliada primeiro; `REFERENCE_NOT_FOUND` só se
   continuar ausente ou pendente.
4. **"Na hora" do I-21** → **I-73**: a antecipação só puxa a próxima tentativa das dependentes; a próxima varredura
   (~1 s, configurável) as processa.
5. **Terceiro failpoint** `after_pending_resolution_before_commit` (modos padrão e `invariant_violation`) → aceito pelo
   usuário junto com o registro de I-70 a I-73; prova o FAILED do worker (FR-029) sem mock (R-29).

## Complexity Tracking

| Item | Por que existe | Alternativa mais simples rejeitada |
|------|----------------|------------------------------------|
| Documentação (Princípio IX) adiada | decisão do usuário registrada no tasks da 001: README e ARCHITECTURE no fim do projeto | escrever agora e reescrever depois das features 2 e 3 |
| `WorkerRegistry` na ordem de shutdown | o Nest não garante a ordem entre providers no mesmo hook; o pool não pode fechar com trabalho em andamento | confiar na ordem de registro dos providers |
| Filas por arquivo de teste | isolamento igual ao banco por arquivo (001, R-17); sem `PurgeQueue` como limpeza | filas compartilhadas com limpeza entre testes |
| Instância em container para o SIGTERM | no Windows o SIGTERM vira término forçado (001, S-10); o encerramento gracioso só é verificável em Linux | testar só com `app.close()` em processo (fica também, mas não prova o sinal real) |
| Reavaliação das irmãs mais antigas antes da reservada | garante a ordem do I-63 com várias instâncias reservando em paralelo | uma única instância de worker (viola constitution III) |
