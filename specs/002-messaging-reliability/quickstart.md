# Quickstart: Mensageria Confiável

**Feature**: `002-messaging-reliability` | Guia de validação ponta a ponta. Os detalhes de contrato estão em
[contracts/](contracts/) e os fluxos em [data-model.md](data-model.md); aqui ficam só os passos e o resultado esperado.

## 1. Pré-requisitos

- Os da 001 (Bun 1.4.4, Docker com Compose) e o ambiente da 001 funcionando.
- Emulador MiniStack `ministackorg/ministack:1.5.32` (serviço `sqs` do Compose), adotado no spike S-12
  ([research.md §0](research.md)); o LocalStack 2026.10.2 exige token e não é usado.
- Para os exemplos com fila: o `aws` CLI v2 no host, com credenciais fictícias (`AWS_ACCESS_KEY_ID=test`,
  `AWS_SECRET_ACCESS_KEY=test`, `AWS_REGION=us-east-1`). Sem o CLI, os mesmos passos podem ser feitos com um script `bun`
  sobre o `@aws-sdk/client-sqs` (o próprio `scripts/queue-init.ts` serve de base).
- `.env` com as variáveis novas do `.env.example` (SQS, papéis e tempos; research R-27).

## 2. Subir o ambiente

```bash
docker compose --profile cluster up -d --build
# postgres → migrate; sqs (MiniStack, healthcheck em Python) → queue-init (cria as 3 filas FIFO e o redrive, idempotente)
# → app1, app2, app3 (dependem de migrate e queue-init com service_completed_successfully)
docker compose ps
```

Esperado: `migrate` e `queue-init` terminam com código 0 (rodar `docker compose run --rm queue-init` de novo também
termina com 0, sem duplicar filas); `app1` (HTTP + consumidor), `app2` (HTTP + consumidor +
publicador) e `app3` (HTTP + publicador + worker) no ar, cada um com a linha `http.listening` no log.

Para enviar e ler mensagens, os exemplos usam o `aws` CLI do host apontado para o emulador: `alias awsq="aws
--endpoint-url http://localhost:4566"` (a imagem do MiniStack não traz `awslocal` nem o `aws` CLI). Chame de `Q` a
URL de `wager-transactions.fifo`, `DLQ` a da DLQ e `EV` a de
`wager-events.fifo` (`awsq sqs get-queue-url --queue-name ...`). Envio: `awsq sqs send-message --queue-url $Q
--message-group-id <walletId> --message-deduplication-id <messageId> --message-body file://msg.json`.

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

1. Depois do 3.1, ler `EV` (`awsq sqs receive-message --queue-url $EV --max-number-of-messages 10 --message-attribute-names All`): o
   `WalletBalanceChanged` e o `WagerTransactionProcessed` da BET, com `causationId` = `correlationId` = `messageId`,
   conforme [integration-events.schema.json](contracts/integration-events.schema.json).
2. `docker compose stop sqs`; submeter BETs por HTTP: respostas 201 normais. `docker compose start sqs` e
   `docker compose run --rm queue-init` (idempotente; necessário se o emulador tiver perdido as filas no reinício, o que
   o spike não mediu): em alguns segundos os eventos
   acumulados aparecem em `EV`.

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
3. `docker compose stop app1` (SIGTERM, `stop_grace_period` 30 s): o handler próprio de sinal (R-35) fecha a app; o log
   mostra o término do consumidor dentro do prazo
   e saída 0; mensagens não concluídas voltam visíveis para `app2`.

## 4. Testes

```bash
docker compose up -d postgres sqs
bun run typecheck
bun run test:unit
bun run test:integration      # PostgreSQL + MiniStack reais; filas e banco próprios por arquivo
bun run test:concurrency      # 3 processos com papéis diferentes; SIGKILL no meio da carga; SIGTERM em container
                              # Linux (docker compose run, com e sem --init): saída 0 como PID 1
```

Esperado: tudo verde; em especial `message-burst` (50 entregas → 1 efeito), `crash-before-ack`,
`concurrent-publishers`, `pending-resolution-race` (×20), `sigkill-recovery` e `graceful-sigterm`, todos terminando com
`assertWalletMatchesLedger` (SC-001 a SC-008).
