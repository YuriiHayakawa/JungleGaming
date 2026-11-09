# Research: Mensageria Confiável

**Feature**: `002-messaging-reliability` | **Date**: 2026-11-08 | **Plan**: [plan.md](plan.md)

Decisões técnicas da Fase 0, no formato Decision / Rationale / Alternatives, com o FR ou I-xx que as motiva. A
numeração continua a da feature 001 (R-01 a R-19 seguem valendo); esta feature usa R-20 a R-35 e o spike S-12.

## 0. Spike S-12 (obrigatório)

> **EXECUTADO E APROVADO em 2026-11-08, com duas alternativas adotadas.** O LocalStack 2026.10.2 reprovou no S-12.1
> (exige token); a alternativa registrada, **MiniStack 1.5.32**, foi adotada e aprovou todos os itens de fila (S-12.1 a
> S-12.7 e S-12.9). No S-12.8, o `enableShutdownHooks()` do Nest drena mas não sai com 0 (trava como PID 1, ou sai
> com 143 com `--init`); a alternativa medida, **handler próprio de sinal** que chama `app.close()` e
> `process.exit(0)`, sai com 0 e foi adotada (R-35). As mudanças do §0.4 foram aprovadas pelo usuário e aplicadas ao
> plan, ao quickstart e às tasks em 2026-11-08; a data-model não mudou.

O código descartável ficava em `spike/s12/` (o `spike/` da 001, na raiz, não foi tocado).

> **Código do spike removido em 2026-11-09 (T121 da 001).** O `spike/s12/` nunca foi versionado e foi apagado do
> disco, junto com os containers do projeto Compose `jg-spike-s12`. Nada em `src/`, `test/`, `scripts/`,
> `package.json`, `Dockerfile` ou `docker-compose.yml` dependia dele (conferido por grep). **Os resultados, os comandos
> e as mudanças registrados abaixo continuam valendo como registro.**

### 0.1 Ambiente e comandos

- **Máquina**: Windows 10 Pro 10.0.19045, Docker 29.5.3, Bun 1.4.4 (o mesmo da research da 001, §0.1).
- **Emuladores**:
  - `localstack/localstack:2026.10.2`, digest `sha256:0e95fa70a58fff808cdc4c8deea8cf56a247cdad403c082e33ec37924987e0c3`
    (build 2026-10-22, git `b71ba515`);
  - `ministackorg/ministack:1.5.32`, digest `sha256:c3afdc0f5a5147477b0634cbe2d2ebb032079989a52c8a1e1e59aea7413feb78`
    (68 MB, Python 3.13.17, gateway na porta 4566; no spike, mapeado para 4567 no host). Pronto em 378 ms depois de um
    restart; 24 MiB de memória em repouso. Atende `/_localstack/health` (compatível) com SQS `available`.
- **Container Linux do S-12.8**: `oven/bun:1.4.4`, digest
  `sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d` (o mesmo da 001).
- **SDK**: `@aws-sdk/client-sqs` 3.1156.0 instalado com versão exata em `spike/s12/package.json` (25 pacotes).

Comandos executados:

```bash
docker pull localstack/localstack:2026.10.2
docker compose -f spike/s12/docker-compose.yml up -d localstack       # S-12.1: sai com 55 (licença)
docker compose -f spike/s12/docker-compose.yml --profile ministack up -d ministack
cd spike/s12 && bun install
SQS_ENDPOINT=http://localhost:4567 bun test --timeout 120000         # test/s12.test.ts (10) + test/s12-extra.test.ts (5)
# S-12.8 (Git Bash, MSYS_NO_PATHCONV=1), três variantes:
docker run -d        --name s -v C:/DEV/projetos/JungleGaming:/app -w /app oven/bun:1.4.4 bun spike/s12/src/sigterm-app.ts
docker run -d --init --name s -v C:/DEV/projetos/JungleGaming:/app -w /app oven/bun:1.4.4 bun spike/s12/src/sigterm-app.ts
docker run -d [--init] --name s -v ... oven/bun:1.4.4 bun spike/s12/src/sigterm-app-explicit.ts
docker kill --signal SIGTERM s && docker wait s
```

### 0.2 Resultados

| Id | Resultado medido | Status |
|----|------------------|--------|
| S-12.1 | **LocalStack 2026.10.2**: sai com código 55 em segundos: "License activation failed! No credentials were found in the environment. Please set the LOCALSTACK_AUTH_TOKEN variable". **MiniStack 1.5.32**: sobe sem token e sem variável nenhuma; `CreateQueue` e `ListQueues` com credenciais `test`/`test` funcionam | LocalStack **reprovado**; MiniStack **aprovado** (adotado, I-43) |
| S-12.2 | sem `MessageGroupId` → `MissingParameter: The request must contain the parameter MessageGroupId`; sem `MessageDeduplicationId` (com `ContentBasedDeduplication=false`) → `InvalidParameterValue: The queue should either have ContentBasedDeduplication enabled or MessageDeduplicationId provided explicitly` | **Aprovado** |
| S-12.3 | dois envios com o mesmo `MessageDeduplicationId` devolvem o **mesmo** `MessageId` e só o primeiro é recebido (`payload-1`, e `payload-3`, de outro id); um reenvio com o mesmo id **depois** de a mensagem ser recebida e apagada também é descartado (0 mensagens) | **Aprovado**: deduplicação aplicada de verdade |
| S-12.4 | `ApproximateReceiveCount` na principal: 1, 2, 3, 4, 5; a 6ª tentativa de recebimento não devolve nada e a mensagem aparece na DLQ, com corpo, atributo de mensagem e `MessageGroupId` preservados e `ApproximateReceiveCount` 6; 7,5 s com visibilidade de 1 s | **Aprovado**: redrive aplicado de verdade, no mesmo momento que o SQS (ao tentar a 6ª entrega) |
| S-12.5 | visibilidade 0 → re-recebida em 3 ms; visibilidade 3 s → nada antes de 1 s, re-recebida em 3011 ms; `ApproximateReceiveCount` 1, 2, 3; `VisibilityTimeout` no próprio receive (1 s numa fila de 30 s) → volta em 1004 ms | **Aprovado** |
| S-12.6 | com `g1-a` invisível, o receive seguinte devolve só `g2-a` (nada do grupo G1); num receive de 10, as mensagens de um grupo vêm em ordem (`g-1` … `g-4`) | **Aprovado**: bloqueio por grupo aplicado de verdade |
| S-12.7 | long polling de 20 s abortado aos 300 ms → `AbortError` em 302 ms; long polling de 10 s volta em 605 ms quando a mensagem chega aos 500 ms; atributos `errorCode`/`errorClass` de string ida e volta; endpoint fechado → `Error` com `code` `ECONNREFUSED` em 3 ms, sem travar; `ApproximateNumberOfMessages` 1 e `...NotVisible` 1 conferem com o estado | **Aprovado** |
| S-12.8 | **Variante pedida** (`enableShutdownHooks()` do Nest), como PID 1: o `onApplicationShutdown` roda e drena (801 ms), mas o processo **não sai** (a espera de 180 s estourou; container vivo). O Nest reemite o sinal para o próprio processo depois dos hooks, e o Linux ignora sinal sem handler no PID 1. Com `--init` (tini): drena e sai com **143** (terminado pelo sinal reemitido) em 1128 ms. **Alternativa** (handler próprio: `SIGTERM`/`SIGINT` → `app.close()` → `process.exit(0)`): drena (800 ms) e sai com **0** em 1157 ms como PID 1 e em 1141 ms com `--init` | **Reprovado** pelo critério (saída 0) com `enableShutdownHooks`; **alternativa aprovada** |
| S-12.9 | processo filho recebeu a mensagem (`count=1`), morto com SIGKILL (saída 137): a mensagem voltou em 2010 ms (visibilidade de 2 s) com `ApproximateReceiveCount` 2 | **Aprovado** |

### 0.3 Deduplicação e redrive: aplicados de verdade ou só aceitos?

Medido, não presumido. O MiniStack 1.5.32 **aplica** as três semânticas que o plan usa:

- **Deduplicação FIFO**: descarta o segundo envio com o mesmo `MessageDeduplicationId`, inclusive depois de a primeira
  mensagem ser apagada (comportamento da janela de 5 min do SQS), e devolve o mesmo `MessageId` ao remetente.
- **Redrive para a DLQ**: move a mensagem quando a 6ª entrega seria feita com `maxReceiveCount` 5, preservando corpo,
  atributos e grupo.
- **Bloqueio por grupo**: não entrega outra mensagem do grupo enquanto uma está invisível.

A janela de 5 min em si (expiração da deduplicação depois de 5 min) não foi medida; nenhum requisito depende dela.
Também não foi medido o LocalStack nesses pontos, porque ele não sobe sem token.

### 0.4 Mudanças decorrentes do spike (aplicadas)

Propostas na execução do spike e **aprovadas e aplicadas em 2026-11-08**, com dois acréscimos do usuário: o serviço
`queue-init` idempotente (script `bun` com o SDK, depois do healthcheck; as apps dependem dele com
`service_completed_successfully`) e, no handler de sinal, sinal repetido ignorado, temporizador de segurança e saída 1
em erro no `close()` (R-35). Texto original da proposta:

1. **Emulador = MiniStack 1.5.32** (S-12.1):
   - **plan.md**: Technical Context ("Messaging" e "Testing"), Constitution Check (linha Stack), Deploy local e
     Matriz: trocar "LocalStack" pelo MiniStack fixado; serviço do Compose com nome neutro `sqs`
     (`ministackorg/ministack:1.5.32`), porta 4566, healthcheck por Python (a imagem não tem `curl`, `wget` nem `aws`
     CLI), por exemplo `python -c "import urllib.request; urllib.request.urlopen('http://localhost:4566/_localstack/health')"`.
   - **quickstart.md**: os exemplos com `awslocal` não funcionam (não existe na imagem); usar o `aws` CLI do host com
     `--endpoint-url http://localhost:4566` ou um script `bun scripts/sqs-send.ts`.
   - **data-model.md**: nada muda.
   - **tasks**: a task do spike fica concluída por este registro; a task do Compose usa a imagem do MiniStack.
2. **Término gracioso** (S-12.8):
   - **plan.md** (Encerramento gracioso, R-28, R-30): trocar `app.enableShutdownHooks()` do `src/main.ts` por um handler
     próprio de `SIGTERM`/`SIGINT` que chama `app.close()` (dispara os mesmos `onApplicationShutdown`, inclusive o
     drain do `WorkerRegistry`) e depois `process.exit(0)`, com proteção contra sinal repetido; opcionalmente
     `init: true` no Compose (com o handler próprio, não é necessário: saída 0 como PID 1). Os hooks deixam de receber o
     nome do sinal (`signal` vem `undefined` via `app.close()`); nenhum código do plan depende dele.
   - **Impacto na 001**: o `src/main.ts` atual tem o mesmo problema. Hoje, no container do Compose (`bun src/main.ts`
     como PID 1), um `docker compose stop` drena e depois espera o `SIGKILL` do Docker, saindo com 137. A research da
     001 (S-10) mediu saída 0 em Linux com instâncias filhas do `bun test`, não como PID 1. A correção entra como task
     desta feature.
   - **tasks**: uma task para o handler de sinal no `main.ts`, com teste em container (R-30) conferindo saída 0 como
     PID 1.
   - **data-model.md**: nada muda.

### 0.5 Critérios de aprovação (definidos no plan, antes da execução)

| Id | O que validar | Critério de aprovação | Alternativa |
|----|---------------|-----------------------|-------------|
| S-12.1 | `localstack/localstack:2026.10.2` sobe **sem token** (sem `LOCALSTACK_AUTH_TOKEN`) e atende SQS | container saudável; `CreateQueue`/`ListQueues` funcionam com credenciais fictícias | `ministackorg/ministack:1.5.32` (I-43); se nenhum servir sem token, voltar ao usuário |
| S-12.2 | Filas FIFO | criar `*.fifo` com `FifoQueue=true` e `ContentBasedDeduplication=false`; `SendMessage` exige `MessageGroupId` e `MessageDeduplicationId` | — (FIFO é exigência do enunciado §10) |
| S-12.3 | Deduplicação | dois `SendMessage` com o mesmo `MessageDeduplicationId` em menos de 5 min → 1 mensagem recebida | se o emulador não deduplicar: a inbox já garante (I-28); registrar como diferença do emulador e ajustar os testes que contam mensagens na fila |
| S-12.4 | DLQ por redrive | `RedrivePolicy` com `maxReceiveCount` 5 para uma DLQ FIFO; mensagem recebida e não apagada 5 vezes vai para a DLQ na 6ª tentativa de recebimento, com corpo e atributos preservados | se o emulador não aplicar o redrive: o consumidor move à DLQ quando `ApproximateReceiveCount` > 5 (mesmo resultado observável); registrar |
| S-12.5 | `ChangeMessageVisibility` | visibilidade 0 devolve na hora; visibilidade N segundos devolve depois de ~N s; `ApproximateReceiveCount` cresce a cada recebimento | sem alternativa: necessário para backoff e término gracioso (I-30, I-34) |
| S-12.6 | Grupo FIFO bloqueado | com uma mensagem do grupo G invisível, outra mensagem de G não é entregue; outro grupo é | se o emulador não bloquear: documentar; os testes de ordem por wallet não dependem do bloqueio (o lock da wallet garante) |
| S-12.7 | `@aws-sdk/client-sqs` 3.1156.0 sob Bun 1.4.4 | `ReceiveMessage` com long polling (`WaitTimeSeconds` 20) cancelável por `AbortSignal` em menos de 1 s; `MessageAttributes` de string ida e volta; erro de conexão com o emulador parado chega como erro identificável (sem travar) | versão anterior da mesma linha 3.x; se o cancelamento não funcionar, long polling curto (`WaitTimeSeconds` 1 a 5) |
| S-12.8 | SIGTERM em container Linux | instância `oven/bun:1.4.4` em container com o handler do Nest; `docker kill --signal SIGTERM` → `onApplicationShutdown` roda e o processo sai com 0 dentro do prazo | — (S-10 da 001 já mostrou saída 0 em Linux); se falhar, revisar o plan |
| S-12.9 | SIGKILL no meio de uma mensagem | processo morto com mensagem recebida e não apagada → ela volta depois da visibilidade, com `ApproximateReceiveCount` 2 | — (comportamento padrão do SQS) |

A tabela acima é a de critérios, definida no plan antes da execução; os resultados estão em [0.2](#02-resultados).

## 1. Versões

| Pacote / imagem | Versão | Publicada em | Observação |
|-----------------|--------|--------------|------------|
| `@aws-sdk/client-sqs` | 3.1156.0 | 2026-10-22 | estável mais recente com 14 dias ou mais em 2026-11-08 (critério da 001); `latest` = 3.1164.0 (2026-11-06) |
| `localstack/localstack` | 2026.10.2 | 2026-10-22 | **reprovado no S-12.1**: exige `LOCALSTACK_AUTH_TOKEN` |
| `ministackorg/ministack` | 1.5.32 | 2026-10-23 | **adotado** (I-43): aprovado no S-12 e aplicado ao plan em 2026-11-08 |

As demais versões são as da 001 (research da 001, §1), sem troca.

## 2. Decisões

### R-20 Dependência única nova

- **Decision**: só `@aws-sdk/client-sqs` 3.1156.0, versão exata. Métricas, laços de polling, jitter e encerramento são
  código próprio, sobre portas.
- **Rationale**: constitution (dependências novas justificadas no plan; na dúvida, a solução mais simples). O cliente
  oficial cobre FIFO, atributos e `AbortSignal`.
- **Alternatives**: `sqs-consumer` (rejeitado: esconde o momento do ack e o tratamento da visibilidade, que são
  justamente o que a feature precisa controlar); biblioteca de métricas (rejeitado: a exposição está fora do escopo,
  FR-036).

### R-21 Porta `SqsPort` e adapter

- **Decision**: porta `SQS_PORT` em `src/messaging/application/sqs.port.ts` com `receive(queue, { max, waitSeconds,
  signal })`, `delete(queue, receiptHandle)`, `changeVisibility(queue, receiptHandle, seconds)`, `send(queue, { body,
  groupId, deduplicationId, attributes })` e `approximateCounts(queue)` (usado nos testes e na métrica). Adapter único
  `AwsSqsAdapter` com `@aws-sdk/client-sqs`; URLs das filas resolvidas uma vez no boot por nome.
- **Rationale**: constitution VI (portas); isola o SDK num arquivo; os testes falam com o SQS real pelo mesmo adapter.
- **Alternatives**: usar o cliente direto nos trabalhadores (rejeitado: espalha o SDK e dificulta o T118).

### R-22 Consumidor reutiliza o use case e grava a inbox na mesma transação

- **Decision**: o consumidor valida o envelope, faz o caminho rápido da inbox e chama o
  `SubmitWagerTransactionUseCase` com origem `queue`, a chave vinda de `data.idempotencyKey`, o `causationId` e a
  inbox anexada (`consumerName`, `messageId`, `payloadHash`). O use case:
  1. no caminho rápido de idempotência, em replay, grava a linha de inbox numa transação mínima (sem lock de wallet)
     apontando a transação existente; `23505` em `inbox_messages_pk` → relê a inbox (mesmo hash = duplicata; outro
     hash = venenosa);
  2. sob o lock da wallet, relê a inbox antes da idempotência; em replay grava a inbox na mesma transação; em efeito
     novo grava a inbox depois da transação (FK), antes da outbox;
  3. em conflito de idempotência, não grava inbox (I-68).
  Mensagens do mesmo grupo num lote são processadas em sequência; grupos diferentes, em paralelo.
- **Rationale**: FR-001, FR-003, FR-006, I-26, I-28, I-68; constitution IV ("HTTP e SQS reutilizam o mesmo use case").
  O hash da inbox é o `payloadHash` do I-25, o que deixa o replay cruzado HTTP × fila coerente.
- **Alternatives**: inbox em transação separada antes do use case (rejeitado: quebra a atomicidade do enunciado §11);
  pular o caminho rápido de idempotência na fila (rejeitado: todo replay passaria a disputar o lock da wallet).

### R-23 Classificação de erros e envio à DLQ

- **Decision**:

  | Origem | Classe | Ação |
  |--------|--------|------|
  | transação REJECTED ou PENDING_REFERENCE gravada; replay (inclusive de FAILED, I-62) | negócio | `DeleteMessage` |
  | `transient` ou `retry` esgotado do classificador da 001 (conexão, `55P03`, `57014`, pool, `40P01`/`40001`) | transitório | sem delete; `ChangeMessageVisibility(min(base × 2^(n−1), teto))`, `n` = `ApproximateReceiveCount`; o redrive leva à DLQ depois de 5 |
  | envelope ou JSON inválido, `messageId` fora do formato (I-69) | permanente `MALFORMED_MESSAGE` | DLQ e depois delete |
  | `type` diferente de `WagerTransactionRequested` (I-66) | permanente `UNSUPPORTED_MESSAGE_TYPE` | idem |
  | `data` inválido (I-60 inclusive); OPENING | permanente `VALIDATION_ERROR` / `OPENING_NOT_ALLOWED` | idem |
  | wallet inexistente (I-20) | permanente `WALLET_NOT_FOUND` | idem |
  | mesmo `messageId`, hash diferente (I-28) | permanente `INBOX_PAYLOAD_MISMATCH` | idem |
  | conflito de idempotência (I-68) | permanente `IDEMPOTENCY_CONFLICT`, sem inbox | idem |
  | quebra de invariante ou erro não classificado (I-61, I-71) | inesperado: transitório até o 4º recebimento | no 5º recebimento, DLQ com `INTERNAL_ERROR` e `errorClass` `unexpected`, depois delete; nunca grava FAILED |

  O envio à DLQ repete o corpo original, o `MessageGroupId`, usa o `messageId` como `MessageDeduplicationId` e leva os
  atributos `errorCode`, `errorClass` (`permanent` ou `unexpected`, I-70, I-71), `receiveCount` e `consumer`
  (contracts/queues.md). Só depois do
  envio aceito a mensagem é apagada da fila principal (FR-040).
- **Rationale**: I-30, I-61, I-66, I-68, I-70, I-71; enviar antes de apagar garante que nada se perca se o processo morrer entre os
  dois (a mensagem volta, é reclassificada e reenviada; a deduplicação da DLQ absorve dentro de 5 min).
- **Alternatives**: deixar todo permanente cair no redrive (rejeitado: 5 retries inúteis bloqueando o grupo da wallet,
  e sem atributos de diagnóstico); apagar antes de enviar (rejeitado: perda na queda entre os dois).

### R-24 Gravação de decisão compartilhada (`TransactionRecorder`)

- **Decision**: extrair do `SubmitWagerTransactionUseCase` a parte que aplica a decisão (`record`: REJECT, APPLY com ou
  sem lançamento, PENDING_REFERENCE) para `src/wagering/application/transaction-recorder.ts`, usada pelo submit (que
  insere a transação) e pelo worker (que atualiza a pendente). O recorder também faz a antecipação das dependentes
  quando o resultado é terminal.
- **Rationale**: FR-027 (a conclusão gera lançamento e eventos como qualquer transação); uma só implementação das
  regras de gravação, sem divergência entre caminhos (constitution II).
- **Alternatives**: duplicar a lógica no worker (rejeitado: duas implementações de saldo e ledger).

### R-25 Política de PENDING_REFERENCE e jitter

- **Decision**: `PendingReferencePolicy` (domínio puro) recebe `attempts`, `createdAt`, `now` e um número aleatório da
  porta `RandomSource`:
  - espera antes da tentativa `k` (k ≥ 2): `min(base × 2^(k−1), teto)` com base 5 s e teto 60 s (10, 20, 40, 60, 60 …);
    a 1ª tentativa já foi agendada pela 001 em `created_at` + 5 s;
  - jitter multiplicativo uniforme em `[1 − r, 1 + r]`, `r` = `PENDING_JITTER_RATIO` (padrão 0,2);
  - esgotou: `attempts` ≥ `PENDING_MAX_ATTEMPTS` (10) depois desta avaliação, ou `now − createdAt` ≥ `PENDING_TTL_MS`
    (10 min) (I-64);
  - só conta como tentativa a avaliação concluída com a referência ausente ou pendente.
- **Rationale**: I-21, I-64; sem jitter a soma é 5 + 10 + 20 + 40 + 60 × 6 = 435 s; o teto de 10 min cobre o jitter e
  atrasos. Aleatoriedade por porta mantém os testes determinísticos (constitution VI).
- **Alternatives**: jitter aditivo fixo (rejeitado: proporcional espalha melhor em esperas longas); `Math.random` no
  domínio (rejeitado: T118 e determinismo).

### R-26 Ordem de lock, claim do worker, ordem do I-63 e antecipação

- **Decision**:
  - ordem única: wallet (`FOR UPDATE`) antes de qualquer escrita em linha de transação;
  - claim do worker em transação mínima com `FOR UPDATE SKIP LOCKED` e `UPDATE next_reference_attempt_at = now +
    lease`, sem lock de wallet; como `SKIP LOCKED` nunca espera, o claim não entra em ciclo de espera;
  - processamento sob o lock da wallet, relendo a linha: se não está PENDING_REFERENCE, não faz nada;
  - ordem do I-63: antes da reservada, reavalia (cada uma na própria transação) as irmãs mais antigas da mesma wallet e
    da mesma `(provider_id, reference_external_transaction_id)` ainda PENDING_REFERENCE;
  - antecipação: na transação que conclui uma transação X (PROCESSED ou REJECTED), `UPDATE` do
    `next_reference_attempt_at` para agora nas pendentes que referenciam `(X.provider_id, X.external_transaction_id)`.
    Pendente de outra wallet pode ter a antecipação sobrescrita por uma reavaliação concorrente; o efeito é só atraso
    até a próxima tentativa, e o resultado será `REFERENCE_MISMATCH` de qualquer forma.
- **Rationale**: constitution III; FR-026, FR-028, I-21, I-63. O lock da wallet serializa o worker com a BET que resolve
  a pendente: em READ COMMITTED, quem pega o lock depois enxerga o commit de quem veio antes, então a pendente nunca é
  reavaliada com estado velho (teste de corrida worker × BET).
- **Alternatives**: `SELECT ... FOR UPDATE` das pendentes sob o lock da wallet no claim (rejeitado: claim longo e
  ordem de lock invertida); processar as dependentes no caminho da requisição (rejeitado por instrução do usuário:
  mantém o HTTP curto; o worker garante a ordem e a concorrência).

### R-27 Configuração e hierarquia de tempos

- **Decision**: variáveis novas, validadas no boot (a app não sobe se a hierarquia falhar):

  | Variável | Padrão | Regra |
  |----------|--------|-------|
  | `SQS_ENDPOINT`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | `http://localhost:4566`, `us-east-1`, `test`, `test` | credenciais fictícias do emulador |
  | `SQS_TRANSACTIONS_QUEUE`, `SQS_TRANSACTIONS_DLQ`, `SQS_EVENTS_QUEUE` | nomes do I-29 | terminam em `.fifo` |
  | `CONSUMER_ENABLED`, `PUBLISHER_ENABLED`, `PENDING_WORKER_ENABLED` | `false` | `true` no Compose; os testes ligam por instância |
  | `CONSUMER_NAME` | `wager-transactions-consumer` | `consumer_name` da inbox |
  | `CONSUMER_WAIT_SECONDS` | 20 | 1 a 20 |
  | `CONSUMER_VISIBILITY_TIMEOUT_SECONDS` | 30 | × 1000 > `DB_POOL_ACQUIRE_TIMEOUT_MS` + `WALLET_LOCK_TIMEOUT_MS` + 2000 |
  | `CONSUMER_RETRY_BASE_SECONDS` / `CONSUMER_RETRY_MAX_SECONDS` | 5 / 60 | base ≤ teto |
  | `CONSUMER_SHUTDOWN_TIMEOUT_MS` | 10000 | < `stop_grace_period` do Compose (30 s) |
  | `PUBLISHER_BATCH_SIZE` / `PUBLISHER_LEASE_MS` / `PUBLISHER_POLL_MS` | 10 / 30000 / 1000 | lote 1 a 10 (I-65); lease > timeout de envio |
  | `PUBLISHER_BACKOFF_MIN_MS` / `PUBLISHER_BACKOFF_MAX_MS` | 1000 / 60000 | I-65 |
  | `PENDING_WORKER_BATCH_SIZE` / `PENDING_WORKER_LEASE_MS` / `PENDING_WORKER_POLL_MS` | 10 / 30000 / 1000 | lease > `DB_POOL_ACQUIRE_TIMEOUT_MS` + `WALLET_LOCK_TIMEOUT_MS` + 2000 |
  | `PENDING_MAX_ATTEMPTS` / `PENDING_TTL_MS` | 10 / 600000 | I-64; configuráveis (FR-032) |
  | `PENDING_BACKOFF_BASE_MS` / `PENDING_BACKOFF_MAX_MS` / `PENDING_JITTER_RATIO` | 5000 / 60000 / 0.2 | I-21; razão entre 0 e 0,5 |

- **Rationale**: FR-032; I-51 aplicado às unidades de trabalho de fundo: visibilidade e leases maiores que o pior caso
  de uma unidade, para que outra instância não pegue trabalho ainda em andamento. Papéis desligados por padrão mantêm os
  testes da 001 sem SQS.
- **Alternatives**: papéis ligados por padrão (rejeitado: obrigaria todo teste e todo ambiente a ter SQS).

### R-28 Laço de polling, parada e ordem de shutdown

- **Decision**: `PollingLoop` genérico: executa uma iteração, dorme o intervalo (ou o backoff, de 1 a 30 s, se a
  iteração falhou por indisponibilidade), aceita `stop()` cooperativo com `AbortSignal` repassado ao long polling e
  expõe `drain(timeoutMs)`. `WorkerRegistry` conhece os trabalhadores ativos; cada trabalhador se registra no
  `onApplicationBootstrap` e para no `onApplicationShutdown`; o `OrmLifecycle` chama `registry.drainAll()` antes de
  `orm.close()`. Os hooks são disparados pelo `app.close()` do handler próprio de sinal (R-35).
- **Rationale**: FR-014, FR-015, I-34. O Nest não garante a ordem entre providers no mesmo hook; sem o registry, o pool
  poderia fechar com uma transação de trabalhador em andamento.
- **Alternatives**: `beforeApplicationShutdown` nos trabalhadores (rejeitado pela instrução de usar
  `onApplicationShutdown`; o registry resolve a ordem sem mudar o hook).

### R-29 Failpoints novos

- **Decision**: no padrão do I-40 e do R-16 (porta `FAILPOINTS`, no-op em `NODE_ENV=production`, nome ou modo
  desconhecido recusa o boot):
  - `after_commit_before_ack`: consumidor, depois do commit e antes do `DeleteMessage`; modo padrão encerra o processo;
  - `before_publish_mark`: publicador, depois do `SendMessage` e antes da marca; modo padrão encerra o processo;
  - `after_pending_resolution_before_commit`: worker, antes do commit da reavaliação; modo padrão lança
    `FailpointError`; modo `invariant_violation` lança um erro com SQLSTATE `P0001` (classificado como `invariant`),
    para provar o FAILED (FR-029).
- **Rationale**: I-40; testes de queda determinísticos sem mock (constitution VII). O terceiro foi aceito pelo usuário
  em 2026-11-08 (plan, Pendências de decisão, item 5).
- **Alternatives**: matar o processo por sinal em momento aleatório (rejeitado para esses cenários: não determinístico;
  o SIGKILL aleatório fica no teste de carga, SC-006).

### R-30 SIGTERM real em container

- **Decision**: o teste de término gracioso sobe a instância num container `oven/bun:1.4.4` na rede do Compose
  (`docker compose run`), com e sem `--init`, aponta para o PostgreSQL e o MiniStack (serviço `sqs`) pelos nomes de
  serviço, coloca uma mensagem em andamento e envia `docker kill --signal SIGTERM`. O harness
  (`test/support/container-instance.ts`) espera a saída e confere o código 0 como PID 1 e a drenagem da mensagem
  (concluída e confirmada, ou devolvida e processada uma vez por outra instância). Em todas as plataformas há também o
  teste em processo com `app.close()`, que dispara os mesmos hooks.
- **Rationale**: FR-014, SC-007; no Windows o SIGTERM do `Bun.spawn` vira término forçado (001, S-10).
- **Alternatives**: pular o teste fora de Linux (rejeitado: regra de não pular testes).

### R-35 Handler próprio de sinal no `main.ts`

- **Decision**: `src/main.ts` deixa de chamar `app.enableShutdownHooks()` e registra um handler próprio:
  - `SIGTERM` e `SIGINT` → `app.close()` (dispara os `onApplicationShutdown`, inclusive o drain do `WorkerRegistry`, R-28)
    → `process.exit(0)`;
  - sinal repetido durante o encerramento é ignorado;
  - temporizador de segurança de `CONSUMER_SHUTDOWN_TIMEOUT_MS` + 5 s força `process.exit(1)` (`unref`, para não
    segurar o processo);
  - erro no `close()` sai com 1.
- **Rationale**: spike S-12.8. O `enableShutdownHooks` reemite o sinal depois dos hooks; como PID 1 do container o
  processo não sai, e com `--init` sai com 143. O handler próprio sai com 0 nos dois casos (medido). Corrige também o
  `main.ts` da 001 (FR-014, I-34).
- **Alternatives**: `init: true` no Compose mantendo o `enableShutdownHooks` (rejeitado: saída 143 em vez de 0);
  `process.exit` dentro de um hook (rejeitado: a ordem entre providers não é garantida).

### R-31 Filas por arquivo de teste

- **Decision**: `test/support/test-queues.ts` cria, no `beforeAll`, as três filas com prefixo
  `jg-<arquivo>-<aleatório>-` e o redrive, e as apaga no `afterAll`. As instâncias recebem os nomes por env. Nenhum
  `PurgeQueue` como limpeza.
- **Rationale**: mesmo isolamento do banco por arquivo (001, R-17); contadores de fila e DLQ sem interferência entre
  arquivos.
- **Alternatives**: filas fixas com purge (rejeitado: `PurgeQueue` é assíncrono e tem limite de 60 s, e mistura
  arquivos).

### R-32 Porta de métricas

- **Decision**: `MetricsPort` com `increment(name, labels)` e `observe(name, value, labels)`; adapter
  `InMemoryMetrics` (registro em memória, lido pelos testes via o container do Nest); nomes:
  `transactions_total{status}`, `duplicates_total{source}`, `retries_total{worker}`, `dlq_total{errorCode}`,
  `lock_conflicts_total`, `outbox_lag_ms`, `processing_latency_ms{worker}`.
- **Rationale**: FR-036; constitution VIII. A exposição (endpoint, Prometheus) fica para outra feature; o registro em
  memória não é garantia de nada, só observação.
- **Alternatives**: só logs (rejeitado: o FR-036 pede contadores).

### R-33 Guardrails estendidos (T118)

- **Decision**: o `test/unit/conventions.test.ts` ganha duas regras com autoteste: (a) em `test/integration/**` e
  `test/concurrency/**`, nenhum mock ou fake de cliente SQS (`spyOn` em `sqs`, classes `InMemory*Sqs*`, `mock.module`
  de `@aws-sdk`); (b) `@aws-sdk/` só importado em `src/messaging/infrastructure/**`.
- **Rationale**: constitution VII (falha eliminatória 8) e R-21.
- **Alternatives**: só revisão (rejeitado: a 001 já automatizou essas garantias).

### R-34 Publicador

- **Decision**: claim em transação curta (seleção com `FOR UPDATE SKIP LOCKED` e avanço de `next_attempt_at` em 30 s),
  envio fora de transação evento a evento com `SendMessage`, marca idempotente (`WHERE published_at IS NULL`) só
  depois do envio aceito, falha → `OutboxMessage.scheduleRetry` (attempts + 1, backoff de 1 a 60 s). `SendMessageBatch`
  não é usado.
- **Rationale**: I-31, I-65, FR-016 a FR-022. Envio individual isola falhas por evento e simplifica a marca; o lote do
  claim já limita o custo.
- **Alternatives**: `SendMessageBatch` (adiado: falhas parciais por entrada complicam a marca sem ganho de corretude);
  manter a transação aberta durante o envio (rejeitado: segura lock e conexão enquanto espera a rede).

## 3. Pendências

As leituras de interpretação deste plan foram registradas como I-70 a I-73 em 2026-11-08 ([plan.md, Pendências de
decisão](plan.md#pendências-de-decisão)). O resultado do spike S-12 está no §0.


## 4. Limitações (itens a escrever no `ARCHITECTURE.md`)

- **Testes contra emulador**: todos os testes de integração e de concorrência rodam contra o MiniStack 1.5.32. O spike
  S-12 mediu que ele aplica a deduplicação FIFO, o redrive e o bloqueio por grupo, mas **a fidelidade à AWS real não
  foi validada** em precisão de timers (visibilidade, long polling) e na expiração da janela de deduplicação de 5 min.
  Comportamentos que dependam desses pontos na AWS real ficam como risco documentado.
- **LocalStack**: a versão 2026.10.2 exige `LOCALSTACK_AUTH_TOKEN`; o projeto não depende de conta nem de token
  (I-43).
