# Quickstart: Mensageria Confiável

**Feature**: `002-messaging-reliability` | Guia de validação ponta a ponta. Os detalhes de contrato estão em
[contracts/](contracts/) e os fluxos em [data-model.md](data-model.md); aqui ficam só os passos e o resultado esperado.

## 1. Pré-requisitos

- Os da 001 (Bun 1.4.4, Docker com Compose) e o ambiente da 001 funcionando.
- Spike S-12 aprovado e a imagem do emulador fixada no `docker-compose.yml` ([research.md §0](research.md)).
- `.env` com as variáveis novas do `.env.example` (SQS, papéis e tempos; research R-27).

## 2. Subir o ambiente

```bash
docker compose --profile cluster up -d --build
# postgres → migrate → localstack → sqs-init (cria as 3 filas FIFO e o redrive) → app1, app2, app3
docker compose ps
```

Esperado: `migrate` e `sqs-init` terminam com código 0; `app1` (HTTP + consumidor), `app2` (HTTP + consumidor +
publicador) e `app3` (HTTP + publicador + worker) no ar, cada um com a linha `http.listening` no log.

Para enviar e ler mensagens, os exemplos usam o `awslocal` de dentro do container do LocalStack (com MiniStack, o
`aws` CLI com `--endpoint-url`). Chame de `Q` a URL de `wager-transactions.fifo`, `DLQ` a da DLQ e `EV` a de
`wager-events.fifo` (`awslocal sqs get-queue-url --queue-name ...`).

## 3. Cenários

### 3.1 Operação pela fila igual à do HTTP (US1)

1. Criar uma wallet com "1000.00" por `POST /wallets` (001).
2. Enviar uma BET de "25.00" em `Q`, com `MessageGroupId` = walletId e `MessageDeduplicationId` = `messageId`, corpo
   conforme o exemplo de [wager-transaction-requested.schema.json](contracts/wager-transaction-requested.schema.json).
3. `GET /providers/provider-a/wagering/transactions/<externalTransactionId>` → PROCESSED, saldo observado "975.00".
4. Reenviar a mesma mensagem com outro `MessageDeduplicationId` (fora da deduplicação da fila): nenhum efeito novo; a
   wallet continua com version 2 e um único DEBIT dessa transação.
5. Enviar a mesma operação por `POST /wagering/transactions` com a mesma chave: 200, `idempotentReplay` true.

### 3.2 Erros permanentes e transitórios (US2)

1. Enviar em `Q` um corpo que não é JSON, um com `type` "Other", um com `amount` numérico e um para uma wallet
   inexistente.
2. Em `DLQ`: as quatro mensagens, cada uma com `errorClass` `permanent` e o `errorCode` de
   [queues.md](contracts/queues.md) (`MALFORMED_MESSAGE`, `UNSUPPORTED_MESSAGE_TYPE`, `VALIDATION_ERROR`,
   `WALLET_NOT_FOUND`), `receiveCount` 1; nenhuma transação gravada.
3. `docker compose stop postgres`, enviar uma BET válida, esperar cerca de 2 min com o banco parado: a mensagem chega à
   `DLQ` pelo redrive, depois de 5 recebimentos, sem os atributos da aplicação. `docker compose start postgres`.

### 3.3 Eventos publicados (US3)

1. Depois do 3.1, ler `EV` (`awslocal sqs receive-message --queue-url $EV --max-number-of-messages 10`): o
   `WalletBalanceChanged` e o `WagerTransactionProcessed` da BET, com `causationId` = `correlationId` = `messageId`,
   conforme [integration-events.schema.json](contracts/integration-events.schema.json).
2. `docker compose stop localstack`; submeter BETs por HTTP: respostas 201 normais. `docker compose start
   localstack` (e o `sqs-init`, se as filas forem recriadas): em alguns segundos os eventos acumulados aparecem em `EV`.

### 3.4 Pendente concluída sozinha (US4)

1. Enviar um ROLLBACK de "40.00" referenciando um id externo que ainda não existe → `GET` da transação: PENDING_REFERENCE.
2. Enviar a BET de "40.00" com esse id externo → em até 5 s, o ROLLBACK aparece PROCESSED com um CREDIT, e os eventos
   dele saem em `EV`.
3. Enviar um REFUND referenciando um id que nunca chegará → cerca de 7 min depois (padrão), REJECTED
   `REFERENCE_NOT_FOUND` e `WagerTransactionRejected` em `EV`.
4. Reenviar a requisição do ROLLBACK do passo 1 por HTTP → 200 com o saldo observado na conclusão (I-67).

### 3.5 Queda abrupta e término gracioso (US5)

1. Com uma carga de mensagens em `Q`, `docker compose kill -s SIGKILL app2` e depois `docker compose up -d app2`.
2. Ao final, conferir por SQL (a reconciliação é de outra feature) que toda wallet tem saldo igual ao ledger, que
   nenhum evento ficou com `published_at` nulo e que nenhuma pendente está vencida há mais que um lease. O teste de
   concorrência `sigkill-recovery` (seção 4) faz essa mesma conferência automaticamente.
3. `docker compose stop app1` (SIGTERM, `stop_grace_period` 30 s): o log mostra o término do consumidor dentro do prazo
   e saída 0; mensagens não concluídas voltam visíveis para `app2`.

## 4. Testes

```bash
docker compose up -d postgres localstack
bun run typecheck
bun run test:unit
bun run test:integration      # PostgreSQL + LocalStack reais; filas e banco próprios por arquivo
bun run test:concurrency      # 3 processos com papéis diferentes; SIGKILL no meio da carga; SIGTERM em container
```

Esperado: tudo verde; em especial `message-burst` (50 entregas → 1 efeito), `crash-before-ack`,
`concurrent-publishers`, `pending-resolution-race` (×20), `sigkill-recovery` e `graceful-sigterm`, todos terminando com
`assertWalletMatchesLedger` (SC-001 a SC-008).
