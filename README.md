# JungleGaming: serviço de transações de apostas

Serviço financeiro que processa transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) vindas de vários provedores,
por HTTP e por fila SQS FIFO. O saldo de cada wallet é materializado e tem um ledger imutável que o acompanha.
Idempotência, unicidade e não-negatividade são garantidas no PostgreSQL, que é a fonte da verdade, e não na memória.
Os eventos de integração saem por uma transactional outbox, com publicação at-least-once e vários publicadores ao mesmo tempo.
Stack: Bun 1.4.4, TypeScript estrito, NestJS 12, MikroORM 7, PostgreSQL 17 e MiniStack (SQS), tudo em Docker Compose.

As decisões técnicas, os trade-offs e as limitações estão em [ARCHITECTURE.md](ARCHITECTURE.md). As interpretações do
enunciado (I-01 a I-76) estão em [docs/interpretacoes.md](docs/interpretacoes.md).

## Sumário

1. [Pré-requisitos](#1-pré-requisitos)
2. [Setup](#2-setup)
3. [Subir o ambiente](#3-subir-o-ambiente)
4. [Variáveis de ambiente](#4-variáveis-de-ambiente)
5. [Migrations](#5-migrations)
6. [Scripts](#6-scripts)
7. [Exemplos de uso (curl)](#7-exemplos-de-uso-curl)
8. [Filas SQS e como inspecioná-las](#8-filas-sqs-e-como-inspecioná-las)
9. [Troubleshooting](#9-troubleshooting)
10. [Estrutura de pastas](#10-estrutura-de-pastas)
11. [Cobertura do enunciado §13](#11-cobertura-do-enunciado-13)
12. [Console de demonstração](#12-console-de-demonstração)

## 1. Pré-requisitos

| Ferramenta | Versão | Observação |
|---|---|---|
| Bun | **1.4.4** | runtime, gerenciador de pacotes e test runner (`bun --version`) |
| Docker Engine | 29.x (validado com 29.5.3) | daemon ativo (`docker info`) |
| Docker Compose | plugin v2 ou superior (validado com **v5.1.4**) | o arquivo usa `name:` no topo, `profiles` e `depends_on` com `service_completed_successfully` |
| curl | qualquer | exemplos deste README; nenhum outro cliente é necessário (nem `aws` CLI nem `jq`) |

Portas usadas no host: **5432** (PostgreSQL, configurável por `POSTGRES_PORT`), **4566** (MiniStack) e **3001 a 3003**
(instâncias da app).

## 2. Setup

1. Clone o repositório e entre na pasta:
   ```bash
   git clone https://github.com/YuriiHayakawa/JungleGaming.git
   cd JungleGaming
   ```
2. Crie o `.env` a partir do exemplo. Os scripts e os testes rodados no host leem esse arquivo. O Compose também lê
   dele o `POSTGRES_PORT`.
   ```bash
   cp .env.example .env
   ```
3. Instale as dependências com o lockfile:
   ```bash
   bun install --frozen-lockfile
   ```
4. Suba o ambiente, como explicado na próxima seção. O Compose constrói a imagem, aplica as migrations e cria as filas.
5. Rode a suíte:
   ```bash
   bun run typecheck && bun run test
   ```

## 3. Subir o ambiente

**Padrão**: PostgreSQL, MiniStack, `migrate`, `queue-init` e `app1` na porta 3001 (HTTP + consumidor).

```bash
docker compose up -d --build
```

**Profile `cluster`**: três instâncias, cada uma com um conjunto de papéis.

```bash
docker compose --profile cluster up -d --build
```

| Instância | Porta | Papéis |
|---|---|---|
| `app1` | 3001 | HTTP + consumidor da fila |
| `app2` | 3002 | HTTP + consumidor + publicador da outbox |
| `app3` | 3003 | HTTP + publicador + worker de PENDING_REFERENCE |

Ordem de subida:

1. `postgres` (com healthcheck) e, em seguida, `migrate`, que roda `migrate:up` e termina.
2. `sqs` (MiniStack, com healthcheck) e, em seguida, `queue-init`, que cria as filas de forma idempotente e termina.
3. As apps, que só sobem depois que os dois serviços acima terminam com código 0.

As apps não têm healthcheck no Compose. Para esperar que fiquem prontas:

```bash
for p in 3001 3002 3003; do until curl -sf localhost:$p/health/ready > /dev/null; do sleep 1; done; echo "$p pronta"; done
```

**`POSTGRES_PORT`**: é a porta do PostgreSQL publicada no host (padrão 5432). Dentro da rede do Compose as apps
continuam usando `postgres:5432`. Se a 5432 estiver ocupada, troque a porta no `.env` e atualize as duas URLs que o
host usa:

```dotenv
POSTGRES_PORT=55432
DATABASE_URL=postgresql://junglegaming:junglegaming@localhost:55432/junglegaming
TEST_DATABASE_ADMIN_URL=postgresql://junglegaming:junglegaming@localhost:55432/postgres
```

Também dá para passar a porta só no comando: `POSTGRES_PORT=55432 docker compose up -d`.

**Para os testes** basta subir o banco e o emulador. Os testes criam bancos e filas próprios por arquivo:

```bash
docker compose up -d postgres sqs
```

**Derrubar**: `docker compose --profile cluster down` mantém os volumes; com `-v`, apaga também os dados.

**Rodar fora do Compose**: com `postgres` e `sqs` no ar, rode `bun run migrate:up && bun run queue:init && bun run dev`.
O `dev` usa o `PORT` do `.env`, que é 3001; pare a `app1` antes ou troque a porta.

## 4. Variáveis de ambiente

Os valores padrão estão no `.env.example` e no código (`src/platform/config/app-config.ts`). A configuração é validada no
boot e a app **não sobe** se uma regra for violada. No Compose, as apps recebem o `.env.example` e sobrescrevem
`DATABASE_URL`, `SQS_ENDPOINT`, `NODE_ENV=production`, `PORT` e os papéis (`*_ENABLED`).

| Variável | Padrão | Função |
|---|---|---|
| `DATABASE_URL` | `postgresql://junglegaming:junglegaming@localhost:5432/junglegaming` | banco da app (obrigatória) |
| `TEST_DATABASE_ADMIN_URL` | `postgresql://junglegaming:junglegaming@localhost:5432/postgres` | banco administrativo dos testes (cria e apaga os bancos por arquivo) |
| `POSTGRES_PORT` | `5432` | porta do PostgreSQL publicada no host (Compose) |
| `PORT` | `3001` | porta HTTP da instância |
| `NODE_ENV` | `development` | `production` desliga os failpoints; o Compose usa `production` |
| `FAILPOINT` | vazio | failpoint de teste (`nome` ou `nome:modo`); ignorado com `NODE_ENV=production` |
| `WALLET_LOCK_TIMEOUT_MS` | `5000` | `lock_timeout` da transação que trava a wallet; ao estourar, 503 sem efeito |
| `DB_POOL_MAX` | `25` | conexões por instância (3 × 25 < `max_connections` 100) |
| `DB_POOL_ACQUIRE_TIMEOUT_MS` | `8000` | espera por conexão do pool; **deve ser maior** que `WALLET_LOCK_TIMEOUT_MS` |
| `HTTP_SERVER_TIMEOUT_MS` | `20000` | timeout do servidor HTTP; **deve ser maior** que pool + lock + 2000 |
| `RETRY_AFTER_SECONDS` | `1` | valor do header `Retry-After` nos 503 |
| `SQS_ENDPOINT` | `http://localhost:4566` | endpoint do MiniStack |
| `AWS_REGION` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `us-east-1` / `test` / `test` | credenciais fictícias do emulador |
| `SQS_TRANSACTIONS_QUEUE` | `wager-transactions.fifo` | fila de entrada |
| `SQS_TRANSACTIONS_DLQ` | `wager-transactions-dlq.fifo` | DLQ da entrada |
| `SQS_EVENTS_QUEUE` | `wager-events.fifo` | fila de saída da outbox |
| `CONSUMER_ENABLED` | `false` | liga o consumidor da fila nesta instância |
| `PUBLISHER_ENABLED` | `false` | liga o publicador da outbox |
| `PENDING_WORKER_ENABLED` | `false` | liga o worker de PENDING_REFERENCE |
| `CONSUMER_NAME` | `wager-transactions-consumer` | `consumer_name` da inbox |
| `CONSUMER_WAIT_SECONDS` | `20` | long polling (1 a 20) |
| `CONSUMER_VISIBILITY_TIMEOUT_SECONDS` | `30` | × 1000 deve ser maior que pool + lock + 2000 |
| `CONSUMER_RETRY_BASE_SECONDS` / `CONSUMER_RETRY_MAX_SECONDS` | `5` / `60` | backoff do erro transitório (`ChangeMessageVisibility`) |
| `CONSUMER_SHUTDOWN_TIMEOUT_MS` | `10000` | prazo da drenagem no encerramento (máx. 25000); + 5 s de margem do handler, dentro do `stop_grace_period` de 30 s |
| `PUBLISHER_BATCH_SIZE` / `PUBLISHER_LEASE_MS` / `PUBLISHER_POLL_MS` | `10` / `30000` / `1000` | lote, lease do claim e intervalo do publicador |
| `PUBLISHER_BACKOFF_MIN_MS` / `PUBLISHER_BACKOFF_MAX_MS` | `1000` / `60000` | backoff de um evento que falhou ao publicar |
| `PENDING_WORKER_BATCH_SIZE` / `PENDING_WORKER_LEASE_MS` / `PENDING_WORKER_POLL_MS` | `10` / `30000` / `1000` | lote, lease e intervalo do worker |
| `PENDING_MAX_ATTEMPTS` | `10` | tentativas de resolver a referência antes de `REFERENCE_NOT_FOUND` |
| `PENDING_TTL_MS` | `600000` | teto de segurança (10 min desde a criação) |
| `PENDING_BACKOFF_BASE_MS` / `PENDING_BACKOFF_MAX_MS` / `PENDING_JITTER_RATIO` | `5000` / `60000` / `0.2` | backoff exponencial com jitter das pendentes |

**Hierarquia de timeouts** (I-51): `WALLET_LOCK_TIMEOUT_MS` < `DB_POOL_ACQUIRE_TIMEOUT_MS` e
`HTTP_SERVER_TIMEOUT_MS` > `DB_POOL_ACQUIRE_TIMEOUT_MS` + `WALLET_LOCK_TIMEOUT_MS` + 2000. A mesma soma limita por
baixo a visibilidade do consumidor e os leases do publicador e do worker. Com isso, o provedor sempre recebe o 503
padronizado, nunca um corte de conexão.

## 5. Migrations

São seis migrations versionadas, reversíveis e escritas em SQL cru, em `migrations/`: wallets e transações, ledger,
outbox, guardas (triggers), inbox e os índices do worker.

```bash
bun run migrate:up     # aplica todas sobre DATABASE_URL
bun run migrate:down   # desfaz todas, na ordem inversa
```

No Compose, o serviço `migrate` roda `migrate:up` antes das apps. O ciclo `up → down → up` é testado em
`test/integration/migrations.test.ts`.

## 6. Scripts

| Script | O que faz | Requer |
|---|---|---|
| `bun run dev` / `bun run start` | sobe a app (`src/main.ts`), com watch no `dev` | `postgres` e `sqs` |
| `bun run typecheck` | `tsc --noEmit` estrito | — |
| `bun run migrate:up` / `migrate:down` | migrations | `postgres` |
| `bun run queue:init` | cria as 3 filas FIFO e o redrive (idempotente) | `sqs` |
| `bun run test:unit` | `test/unit`: domínio, regras e guardrails de código, sem I/O | — |
| `bun run test:integration` | `test/integration`: app em processo contra PostgreSQL e MiniStack reais; banco e filas próprios por arquivo | `postgres` e `sqs` |
| `bun run test:concurrency` | `test/concurrency`: 3 processos reais da app, SIGKILL, e SIGTERM em container Linux | `postgres`, `sqs` e Docker |
| `bun run test` | `test:unit`, `test:integration` e `test:concurrency`, em sequência | idem |
| `bun run test:chaos` | conjunto focado de testes de falha (ver abaixo) | idem |
| `bun run test:load` | teste de carga contra o cluster: 3 cenários (wallets distribuídas, wallet quente, duplicatas) com throughput, p50/p95/p99, status HTTP, lock, outbox e verificação final das invariantes; JSON em `load/results/` | cluster no ar (`docker compose --profile cluster up -d --build`) |

Na máquina de referência a suíte completa leva cerca de 4 minutos.

**`test:chaos`** é um alias para quatro testes de falha que **já fazem parte** de `test:concurrency`. É um conjunto
focado e determinístico de cenários de queda, **não** um harness de caos aleatório:

| Arquivo | Falha provocada |
|---|---|
| `test/concurrency/sigkill-recovery.test.ts` | SIGKILL em instâncias no meio da carga, três vezes; depois confere as invariantes |
| `test/concurrency/crash-before-ack.test.ts` | processo morto entre o commit e o ack da mensagem |
| `test/concurrency/concurrent-publishers.test.ts` | 3 publicadores na mesma outbox, um deles morto entre o envio e a marca |
| `test/concurrency/graceful-sigterm.test.ts` | SIGTERM real em container Linux, com mensagem em andamento e o ready lido durante a drenagem |

**`test:load`** é o teste de carga (diferencial opcional do enunciado). Ele não faz parte de `bun run test`. A
metodologia, o ambiente, os resultados e a análise estão em [docs/load-test.md](docs/load-test.md). Os parâmetros vêm
por env, por exemplo `LOAD_CONCURRENCY=64 LOAD_DURATION_S=60 bun run test:load`. O script sai com código 1 se a
verificação final das invariantes falhar.

## 7. Exemplos de uso (curl)

Os ids variam a cada execução; use os que as respostas devolverem. Erros saem no formato
`{ "error": { "code", "message", "retryable", "correlationId", "details?" } }`. Toda resposta traz o header
`X-Correlation-Id`, que é aceito na requisição ou gerado pelo serviço.

**Criar wallet**: 201; a mesma `playerId` + moeda de novo dá 409 `WALLET_ALREADY_EXISTS`.

```bash
curl -s -X POST localhost:3001/wallets -H 'Content-Type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"100.00","currency":"BRL"}}'
# {"id":"019a…","playerId":"player-1","balance":{"amount":"100.00","currency":"BRL"},"version":1}
W=<id devolvido>
```

**Consultar a wallet**:

```bash
curl -s localhost:3001/wallets/$W
```

**Ledger paginado**, com cursor opaco e `limit` de 1 a 200 (padrão 50):

```bash
curl -s "localhost:3001/wallets/$W/ledger?limit=50"
# {"items":[…],"nextCursor":null}   → com nextCursor, repita com &cursor=<valor>
```

**Submeter transação**. O header `Idempotency-Key` é obrigatório. Primeira vez: 201 `PROCESSED`. Reenvio idêntico: 200
com `idempotentReplay: true`. Mesma chave com outro payload: 409 `IDEMPOTENCY_CONFLICT`. Sem saldo: 422 `REJECTED`
`INSUFFICIENT_FUNDS`. Referência ainda inexistente: 202 `PENDING_REFERENCE`.

```bash
curl -s -X POST localhost:3001/wagering/transactions -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:bet-1' \
  -d '{"providerId":"provider-a","externalTransactionId":"bet-1","playerId":"player-1","walletId":"'$W'",
       "roundId":"r1","gameId":"g1","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
# {"transactionId":"019a…","status":"PROCESSED","balance":{"amount":"75.00","currency":"BRL"},"idempotentReplay":false}
T=<transactionId devolvido>
```

Para REFUND e ROLLBACK, inclua `"referenceExternalTransactionId":"bet-1"` com o mesmo valor da referência.

**Consultar transação** pelo id interno ou pelo id do provedor:

```bash
curl -s localhost:3001/wagering/transactions/$T
curl -s localhost:3001/providers/provider-a/wagering/transactions/bet-1
```

**Reconciliação**: sem corpo e somente leitura. Responde 200 com `consistent`; se houver divergência, `consistent` vem
false, a divergência vai para o log e para a métrica e nada é corrigido.

```bash
curl -s -X POST localhost:3001/wallets/$W/reconciliation
# {"walletId":"…","storedBalance":{"amount":"75.00","currency":"BRL"},"calculatedBalance":{"amount":"75.00","currency":"BRL"},
#  "difference":{"amount":"0.00","currency":"BRL"},"consistent":true,"chainConsistent":true,"checkedEntries":2}
```

**Health**: sem autenticação. O live não consulta nada. O ready checa PostgreSQL e SQS (2 s cada) e responde 503
durante o encerramento.

```bash
curl -i localhost:3001/health/live    # 200 {"status":"ok"}
curl -i localhost:3001/health/ready   # 200 {"status":"ok","checks":{"postgres":"up","sqs":"up"}}
                                      # 503 {"status":"unavailable","checks":{"postgres":"up","sqs":"down"}}
```

**Métricas** em formato de texto Prometheus 0.0.4, por instância:

```bash
curl -s localhost:3001/metrics | grep -v '^#'
# transactions_total{status="PROCESSED"} 1
# outbox_pending_events 0
# reconciliation_divergences_total 0 …
```

## 8. Filas SQS e como inspecioná-las

| Fila | Papel | Grupo / deduplicação |
|---|---|---|
| `wager-transactions.fifo` | entrada (`WagerTransactionRequested`) | `MessageGroupId` = walletId; `MessageDeduplicationId` = messageId |
| `wager-transactions-dlq.fifo` | DLQ da entrada; redrive com `maxReceiveCount` 5 | mensagens enviadas pela aplicação levam `errorCode`, `errorClass`, `receiveCount` e `consumer` |
| `wager-events.fifo` | saída da outbox (eventos de integração) | `MessageGroupId` = aggregateId (walletId); `MessageDeduplicationId` = eventId |

O MiniStack aceita o protocolo JSON do SQS sem assinatura, então dá para inspecionar as filas só com curl:

```bash
sqs() { curl -s -X POST http://localhost:4566/ -H "X-Amz-Target: AmazonSQS.$1" \
  -H 'Content-Type: application/x-amz-json-1.0' -d "$2"; echo; }
Q=http://localhost:4566/000000000000

sqs ListQueues '{}'
sqs GetQueueAttributes '{"QueueUrl":"'$Q'/wager-transactions-dlq.fifo","AttributeNames":["ApproximateNumberOfMessages","ApproximateNumberOfMessagesNotVisible"]}'
# lê sem esconder (VisibilityTimeout 0) e com os atributos da DLQ:
sqs ReceiveMessage '{"QueueUrl":"'$Q'/wager-transactions-dlq.fifo","MaxNumberOfMessages":10,"VisibilityTimeout":0,"MessageAttributeNames":["All"]}'
sqs ReceiveMessage '{"QueueUrl":"'$Q'/wager-events.fifo","MaxNumberOfMessages":10,"VisibilityTimeout":0}'
```

Enviar uma transação pela fila. O corpo segue `specs/002-messaging-reliability/contracts/wager-transaction-requested.schema.json`:

```bash
cat > msg.json <<EOF
{"messageId":"msg-1","type":"WagerTransactionRequested","occurredAt":"2026-11-09T12:00:00.000Z",
 "data":{"providerId":"provider-a","externalTransactionId":"q-bet-1","idempotencyKey":"provider-a:q-bet-1",
 "playerId":"player-1","walletId":"$W","roundId":"r1","gameId":"g1","kind":"BET",
 "money":{"amount":"10.00","currency":"BRL"}}}
EOF
BODY=$(bun -e 'console.log(JSON.stringify(JSON.stringify(JSON.parse(await Bun.file("msg.json").text()))))')
sqs SendMessage '{"QueueUrl":"'$Q'/wager-transactions.fifo","MessageGroupId":"'$W'","MessageDeduplicationId":"msg-1","MessageBody":'"$BODY"'}'
```

Com o `aws` CLI instalado, os mesmos comandos funcionam com `--endpoint-url http://localhost:4566` e as credenciais
`test`/`test`. A imagem do MiniStack não traz `awslocal`.

## 9. Troubleshooting

- **Porta ocupada** (`Bind for 0.0.0.0:5432 failed: port is already allocated`): para o PostgreSQL, use
  `POSTGRES_PORT` (seção 3) e atualize `DATABASE_URL` e `TEST_DATABASE_ADMIN_URL` no `.env`. As portas 4566 e 3001 a
  3003 são fixas no `docker-compose.yml`; libere-as ou pare o que as ocupa (`docker ps`).
- **Docker parado**: `docker info` falha e os testes de integração quebram já no preload, com `ECONNREFUSED` no
  `TEST_DATABASE_ADMIN_URL`. Inicie o Docker e rode `docker compose up -d postgres sqs`.
- **`NODE_ENV=production` desliga os failpoints**: a imagem e o Compose usam `production`, e aí `FAILPOINT` não tem
  efeito. Os testes de queda dependem de failpoint; os harnesses de teste forçam `NODE_ENV=test` nas instâncias que
  sobem, então rode os testes pelos scripts do `package.json`, não contra as apps do Compose.
- **A app não sobe com `ConfigError`**: alguma regra da hierarquia de timeouts (seção 4) foi violada. A mensagem diz
  qual.
- **SIGTERM no Windows**: fora de container, o Windows mata o processo à força e o encerramento gracioso não roda. Por
  isso os testes de SIGTERM rodam em container Linux (`docker compose --profile test run`), e passam também no Docker
  Desktop.
- **Ready em 503 com `"sqs":"down"` depois de reiniciar o `sqs`**: o MiniStack guarda as filas só em memória e volta
  sem nenhuma. Rode `docker compose run --rm queue-init`, que é idempotente; o ready volta a 200 sem reiniciar as apps,
  e a outbox acumulada é publicada.
- **Bancos `jg_test_*` ou filas `jg-*` sobrando** depois de uma execução interrompida: o preload dos testes apaga os
  bancos na próxima execução; as filas de teste são apagadas no fim de cada arquivo.

## 10. Estrutura de pastas

```text
src/
  main.ts, app.module.ts      boot, handler de sinal e composição dos módulos
  shared-kernel/              Money, IntegrationEvent, portas Clock e IdGenerator, erros comuns
  wallets/                    Wallet, WalletLedgerEntry, abertura, consultas de wallet e ledger
  wagering/                   WagerTransaction, regras (WagerRulesService), submissão, recorder, worker de PENDING_REFERENCE
  inbox/                      InboxMessage e repositório
  outbox/                     OutboxMessage, publicador com lease, leitura do atraso da outbox
  messaging/                  porta SqsPort, adapter do SDK, consumidor e classificação de erros
  reconciliation/             reconciliação (função pura + leitura em snapshot)
  health/                     live e ready
  metrics/                    GET /metrics
  platform/                   config, persistência (MikroORM, unit of work, erros pg), HTTP, logging, métricas,
                              correlationId, failpoints, auth no-op, workers e ciclo de vida
  (cada módulo: domain/ → application/ → infrastructure/ e interfaces/)
migrations/                   6 migrations em SQL cru, com up e down
scripts/                      migrate.ts e queue-init.ts
load/                         load-test.ts (bun run test:load) e results/ (só o exemplo curado é versionado)
test/
  unit/                       domínio e guardrails de código (conventions.test.ts)
  integration/                app em processo, PostgreSQL e MiniStack reais, proxies TCP para falhas
  concurrency/                3 processos reais, SIGKILL, SIGTERM em container
  support/                    harnesses, banco por arquivo, filas por arquivo, proxy TCP, assertWalletMatchesLedger
docs/                         enunciado, interpretações (I-01 a I-76) e relatório do teste de carga
specs/                        spec, plan, research, data-model, contracts, tasks e notas das features 001 a 003
```

## 11. Cobertura do enunciado §13

Todos os testes de integração e concorrência rodam contra PostgreSQL e MiniStack reais; o guardrail
`test/unit/conventions.test.ts` impede mocks de banco e de SQS nessas pastas. A invariante final
(`wallet.balance` = saldo reconstruído pelo ledger) é conferida por `assertWalletMatchesLedger`
(`test/support/assert-wallet-matches-ledger.ts`) em 51 arquivos de integração e concorrência.

| Cenário obrigatório | Arquivo(s) que o prova(m) |
|---|---|
| **Unidade** | |
| Money: operações, escala, arredondamento, entradas inválidas | `test/unit/money.test.ts` |
| Invariantes da Wallet | `test/unit/wallet.test.ts`, `test/unit/wallet-ledger-entry.test.ts` |
| Regras de BET, WIN, LOSS, REFUND, ROLLBACK | `test/unit/wager-rules.test.ts`, `test/unit/wager-transaction.test.ts` |
| Conflito de moeda | `test/unit/money.test.ts`, `test/unit/wallet.test.ts`, `test/unit/wager-rules.test.ts` (`CURRENCY_MISMATCH`) |
| Idempotency key com payload divergente | `test/unit/payload-hash.test.ts`, `test/unit/wager-transaction.test.ts` (`matchesPayload`); o 409 de ponta a ponta em `test/integration/idempotency.test.ts` |
| **Integração** | |
| Migrations e constraints | `test/integration/migrations.test.ts`, `test/integration/schema-guards.test.ts`, `test/integration/money-columns.test.ts` |
| Atomicidade entre wallet, ledger, inbox e outbox | `test/integration/atomicity.test.ts` (HTTP), `test/integration/consumer-atomicity.test.ts` (fila, com inbox) |
| Inbox e redelivery | `test/integration/consumer-processing.test.ts`, `test/integration/cross-channel-replay.test.ts` |
| Publishers concorrentes sobre a mesma outbox | `test/integration/outbox-publisher.test.ts` (claim com lease e `SKIP LOCKED`), `test/concurrency/concurrent-publishers.test.ts` |
| Retry e DLQ | `test/integration/consumer-transient-errors.test.ts`, `test/integration/consumer-permanent-errors.test.ts`, `test/integration/consumer-unexpected-errors.test.ts`, `test/integration/outbox-publisher-batch-failure.test.ts` |
| Recuperação após reinicialização | `test/integration/consumer-atomicity.test.ts` (reinício sem failpoint), `test/integration/db-unavailable.test.ts`, `test/integration/dependency-outage.test.ts` |
| **Concorrência** | |
| A mesma aposta 50× em paralelo → um débito | `test/concurrency/idempotent-burst.test.ts` (HTTP), `test/concurrency/message-burst.test.ts` (fila) |
| Disputa pelo saldo da mesma wallet (100.00 e 2 × 80.00) | `test/concurrency/hot-wallet-race.test.ts` (repetido 20 vezes) |
| Wallets distintas em paralelo | `test/concurrency/wallet-isolation.test.ts` |
| ≥ 3 processos/instâncias simultâneos | `test/support/instance-cluster.ts` (`startCluster({ size: 3 })`), usado em `hot-wallet-race`, `idempotent-burst`, `idempotency-race`, `wallet-isolation`, `reversal-race`, `pool-pressure`, `concurrent-wallet-creation` e `reconciliation-under-load`; 3 instâncias com papéis em `message-burst`, `pending-worker-instances` e `concurrent-publishers` |
| Worker morto depois do commit e antes do ack | `test/concurrency/crash-before-ack.test.ts` |
| Dois publishers sobre a mesma outbox | `test/concurrency/concurrent-publishers.test.ts` (3 publicadores, um morto no meio) |
| ROLLBACK ou REFUND entregue antes da referência | `test/integration/pending-reference.test.ts`, `test/integration/pending-reference-worker.test.ts`, `test/concurrency/pending-resolution-race.test.ts`, `test/concurrency/pending-order.test.ts` |
| Reinício do serviço com consistência final comprovada | `test/concurrency/sigkill-recovery.test.ts`, `test/concurrency/crash-recovery.test.ts` |
| Invariante final `wallet.balance == ledger` | `test/support/assert-wallet-matches-ledger.ts`, além da reconciliação sob carga em `test/concurrency/reconciliation-under-load.test.ts` |

## 12. Console de demonstração

Painel opcional para apresentar o sistema ao vivo. Ele não faz parte da API nem dos testes e não muda nada em `src/`.
É uma página única em HTML, CSS e JS puros (`demo/index.html`), servida por um proxy Bun (`demo/server.ts`) que escuta
só em `127.0.0.1:4000` e repassa `/api/1/*`, `/api/2/*` e `/api/3/*` para as instâncias 3001, 3002 e 3003. Uma
instância que não responde vira 502 `{"error":"instance_unreachable"}`.

```bash
docker compose --profile cluster up -d --build
bun run demo          # abra http://127.0.0.1:4000
```

O que mostra:

- o ready das 3 instâncias, atualizado a cada 3 s;
- a criação de uma wallet de 100,00;
- duas BETs de 80,00 disparadas ao mesmo tempo nas instâncias 1 e 2: uma `PROCESSED` e outra `REJECTED`
  `INSUFFICIENT_FUNDS`, saldo final 20,00;
- o replay da primeira BET por outra instância e o conflito com a mesma chave e outro valor (409);
- o ledger da wallet e a reconciliação (selo "consistente" ou "divergente");
- as métricas lidas de `/metrics`;
- a linha do tempo das requisições, com o `correlationId` de cada uma.

O botão "Executar roteiro completo" roda tudo em sequência. Os valores monetários são tratados só como texto.
