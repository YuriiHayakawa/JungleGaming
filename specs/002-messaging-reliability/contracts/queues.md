# Contrato de filas

**Feature**: `002-messaging-reliability` | Fontes: enunciado §10 e §11, I-28 a I-32, I-34, I-61 a I-69

## Topologia

| Fila | Tipo | Quem envia | Quem consome | `MessageGroupId` | `MessageDeduplicationId` |
|------|------|------------|--------------|------------------|--------------------------|
| `wager-transactions.fifo` | FIFO, `ContentBasedDeduplication=false` | provedor | consumidor (`CONSUMER_ENABLED`) | `walletId` | `messageId` (I-29) |
| `wager-transactions-dlq.fifo` | FIFO, DLQ da anterior | redrive (transitórios, depois de 5 recebimentos) e a aplicação (permanentes) | operação (redrive manual) | o da mensagem original | `messageId` |
| `wager-events.fifo` | FIFO, `ContentBasedDeduplication=false` | publicador (`PUBLISHER_ENABLED`) | provedor | `aggregateId` (walletId) | `eventId` (I-29) |

- `RedrivePolicy` de `wager-transactions.fifo`: `{ "deadLetterTargetArn": <DLQ>, "maxReceiveCount": 5 }` (I-30).
- Visibilidade padrão de `wager-transactions.fifo`: `CONSUMER_VISIBILITY_TIMEOUT_SECONDS` (30), maior que o pior caso
  de processamento de uma mensagem (research R-27).
- A deduplicação do SQS FIFO cobre 5 min; fora dela, duplicatas chegam e são absorvidas pela inbox (entrada) ou pelo
  `eventId` (saída) (I-28, I-31).
- Ordem: o SQS FIFO entrega na ordem dentro de um grupo, mas uma mensagem em retry bloqueia o grupo (a wallet) até sair
  (I-32, limitação). Na saída, com publicadores concorrentes, a ordem entre eventos de uma wallet não é garantida
  (I-32).
- Os nomes são configuráveis (`SQS_TRANSACTIONS_QUEUE`, `SQS_TRANSACTIONS_DLQ`, `SQS_EVENTS_QUEUE`); os testes usam
  filas próprias com prefixo único (research R-31).

## Entrada: `wager-transactions.fifo`

Corpo: [wager-transaction-requested.schema.json](wager-transaction-requested.schema.json). Resultado por mensagem:

| Situação | Ação na fila | Inbox | Efeito |
|----------|--------------|-------|--------|
| processada (PROCESSED, REJECTED ou PENDING_REFERENCE) | `DeleteMessage` depois do commit | gravada na mesma transação | transação, saldo, ledger e outbox conforme a 001 |
| duplicata (mesmo `messageId` e mesmo hash) | `DeleteMessage` | já existia | nenhum |
| replay pela idempotência (inclusive cruzado com HTTP; inclusive de FAILED, I-62) | `DeleteMessage` | gravada, apontando a transação existente | nenhum |
| transitória | sem delete; `ChangeMessageVisibility` com espera crescente; DLQ pelo redrive depois de 5 recebimentos | não | nenhum |
| inesperada (I-71) | como a transitória até o 4º recebimento; no 5º, `SendMessage` à DLQ com `INTERNAL_ERROR`/`unexpected` e, só depois, `DeleteMessage` | não | nenhum |
| permanente | `SendMessage` à DLQ com atributos e, só depois, `DeleteMessage` | não | nenhum |

## DLQ: atributos das mensagens enviadas pela aplicação

Mensagens que chegam à DLQ pelo redrive (transitórias) mantêm o corpo e os atributos originais, sem os atributos
abaixo (rede de segurança). As enviadas pela aplicação (permanentes no 1º recebimento; erro inesperado no 5º, I-71)
repetem o corpo original e levam (FR-040, I-68, I-70):

| Atributo (`String`) | Valor |
|---------------------|-------|
| `errorCode` | código da tabela abaixo |
| `errorClass` | `permanent` (erros permanentes do I-30) ou `unexpected` (erro inesperado, I-71) |
| `receiveCount` | `ApproximateReceiveCount` no momento da classificação |
| `consumer` | `CONSUMER_NAME` |

### Códigos (`errorCode`)

| Código | Quando | Origem |
|--------|--------|--------|
| `MALFORMED_MESSAGE` | corpo não é JSON; envelope sem `messageId`, `type`, `occurredAt` ou `data`; `messageId` fora de `^[A-Za-z0-9._:-]{1,128}$`; `occurredAt` não ISO-8601 | I-30, I-69, I-70 (exclusivo de DLQ) |
| `UNSUPPORTED_MESSAGE_TYPE` | envelope válido com `type` diferente de `WagerTransactionRequested` | I-66, I-70 (exclusivo de DLQ) |
| `VALIDATION_ERROR` | `data` viola as regras de payload da 001 (formatos, referência por kind, zero só em LOSS, autorreferência, "system") | I-30, I-60, taxonomia §7 |
| `OPENING_NOT_ALLOWED` | `kind` OPENING | I-08, taxonomia §7 |
| `WALLET_NOT_FOUND` | wallet inexistente | I-20, I-30, taxonomia §7 |
| `INBOX_PAYLOAD_MISMATCH` | mesmo `messageId` já registrado na inbox com outro `payloadHash` | I-28, I-70 (exclusivo de DLQ) |
| `IDEMPOTENCY_CONFLICT` | mesma chave do mesmo provedor com conteúdo diferente, ou mesmo id externo com outra chave | I-68, taxonomia §7 |
| `INTERNAL_ERROR` | erro inesperado (quebra de invariante ou erro não classificado) que persistiu até o 5º recebimento; nas entregas anteriores foi tratado como transitório; `errorClass` `unexpected`; o consumidor nunca grava FAILED | I-61, I-71, taxonomia §7 |

Na DLQ, nenhum desses valores vai para `failure_code` nem para resposta HTTP. `MALFORMED_MESSAGE`, `UNSUPPORTED_MESSAGE_TYPE` e
`INBOX_PAYLOAD_MISMATCH` são exclusivos de DLQ, na tabela própria da taxonomia §7 (I-70); os demais são da tabela
principal da §7.

## Saída: `wager-events.fifo`

Corpo: [integration-events.schema.json](integration-events.schema.json), o envelope gravado na outbox, sem alteração.
Entrega ao menos uma vez: um publicador que morre depois de enviar e antes de marcar provoca republicação com o mesmo
`eventId` (I-31). O consumidor deve deduplicar por `eventId` e, nos eventos de saldo, ordenar por `walletVersion`.
