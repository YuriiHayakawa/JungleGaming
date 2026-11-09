# Feature Specification: Mensageria Confiável

**Feature Branch**: `002-messaging-reliability` (id da feature; o trabalho segue na branch `main` do repositório, por
decisão do usuário)

**Created**: 2026-11-08

**Status**: Draft

**Input**: User description: "Construir a camada de mensageria do serviço: consumo da fila de transações (SQS) com
inbox, DLQ e encerramento gracioso; publicação confiável dos eventos pela outbox; e o reprocessamento automático de
transações PENDING_REFERENCE." (descrição completa, com problema, usuários, funcionalidades, critérios de aceitação e
fora de escopo, fornecida em `/speckit-specify`)

**Fontes normativas**: `docs/enunciado.md` (seções 3, 7.1, 10, 11, 12 e 13), `docs/interpretacoes.md` (ids I-xx
citados nos requisitos, em especial I-21, I-22, I-27 a I-34, I-40, I-49 e I-60 a I-69) e
`.specify/memory/constitution.md` v1.0.1. Em caso de conflito, prevalece a ordem do Princípio I da constitution.

**Depende de**: feature `001-wagering-transaction-core` (implementada): wallets, ledger, submissão de transações com
idempotência persistente, outbox gravada na mesma transação SQL e PENDING_REFERENCE com o agendamento inicial. Os
requisitos da 001 são citados como `001/FR-xxx`.

## User Scenarios & Testing *(mandatory)*

Atores:

- **Provedor de jogos**: envia operações pela fila de transações, com entrega at-least-once (repete, paraleliza e
  entrega fora de ordem), e consome os eventos de resultado pela fila de eventos.
- **Plataforma**: as várias instâncias do serviço, que trabalham em paralelo sobre os mesmos dados e podem morrer a
  qualquer momento, antes ou depois de um commit.
- **Operador**: acompanha contadores de saúde do processamento (duplicatas, retries, DLQ, atraso da outbox).

### User Story 1 - Enviar operações pela fila com o mesmo resultado do HTTP (Priority: P1)

O provedor publica uma operação na fila de transações e obtém o mesmo efeito financeiro que obteria por HTTP: as
mesmas regras, a mesma ordem de avaliação e a mesma idempotência. A mensagem só é confirmada à fila depois que o
resultado está gravado, e a reentrega de uma mensagem já tratada nunca produz um segundo efeito.

**Why this priority**: é o canal de integração exigido pelo enunciado (§10) e a principal fonte de duplicatas; sem
deduplicação persistente, cada reentrega é risco de débito ou crédito duplicado.

**Independent Test**: publicar uma BET na fila e conferir transação, saldo, ledger, inbox e eventos; reentregar a mesma
mensagem 50 vezes em paralelo por 3 instâncias; enviar a mesma operação por HTTP e pela fila; matar a instância entre
o commit e a confirmação.

**Acceptance Scenarios**:

1. **Given** uma wallet com saldo "1000.00" BRL, **When** chega pela fila uma mensagem `WagerTransactionRequested` com
   uma BET de "25.00", **Then** a transação fica PROCESSED, o saldo vai a "975.00", há um lançamento DEBIT, a mensagem
   fica registrada na inbox e os eventos ficam na outbox, tudo na mesma unidade atômica; só depois disso a mensagem é
   confirmada à fila (I-28, enunciado §10, §11).
2. **Given** nenhuma mensagem com o id M, **When** a mesma mensagem M é entregue 50 vezes, inclusive em paralelo e por
   instâncias diferentes, **Then** existe um único efeito (uma transação, um lançamento, um conjunto de eventos) e todas
   as entregas terminam confirmadas (I-27, I-28).
3. **Given** uma BET já processada por HTTP com a chave K, **When** chega pela fila uma mensagem com a mesma chave K e
   o mesmo conteúdo de negócio, **Then** ela é reconhecida como duplicata (replay), sem novo efeito nem evento, e é
   confirmada (I-26, I-28).
4. **Given** uma mensagem cujo processamento foi confirmado no banco, **When** a instância morre antes de confirmar a
   mensagem à fila e a mensagem é reentregue a outra instância, **Then** a reentrega é tratada como duplicata, sem novo
   efeito, e é confirmada (I-28, I-40).
5. **Given** uma BET sem saldo suficiente pela fila, **When** processada, **Then** a transação fica REJECTED com
   `INSUFFICIENT_FUNDS`, o evento de rejeição é registrado e a mensagem é confirmada, sem novas tentativas (I-30).
6. **Given** um REFUND pela fila cuja referência ainda não existe, **When** processado, **Then** a transação fica
   PENDING_REFERENCE e a mensagem é confirmada; a conclusão fica com o reprocessamento da US4 (I-15, I-21).

---

### User Story 2 - Tratar cada falha do jeito certo: rejeição, nova tentativa ou DLQ (Priority: P1)

A plataforma classifica toda falha no processamento de uma mensagem. Erro de negócio persiste a rejeição e confirma a
mensagem. Erro transitório não confirma: a mensagem volta com espera crescente e, depois do limite de recebimentos,
vai para a DLQ. Erro permanente vai direto para a DLQ, sem novas tentativas.

**Why this priority**: tratar um erro permanente como transitório bloqueia o grupo de mensagens da wallet com retries
inúteis; tratar um transitório como permanente perde operações válidas.

**Independent Test**: provocar cada classe de erro e conferir o destino da mensagem (confirmada, devolvida ou DLQ), o
número de recebimentos e a ausência de efeito parcial.

**Acceptance Scenarios**:

1. **Given** o banco indisponível, **When** uma mensagem válida é recebida, **Then** ela não é confirmada, volta a
   ficar visível com espera crescente e, depois de 5 recebimentos sem sucesso, vai para a DLQ; nenhum efeito parcial é
   gravado (I-30, I-34).
2. **Given** o banco indisponível só durante as primeiras entregas, **When** ele volta antes do limite, **Then** a
   mensagem é processada uma única vez, como se fosse a primeira (I-30).
3. **Given** cada uma das mensagens a seguir, **When** recebida, **Then** vai direto para a DLQ no primeiro
   recebimento, sem efeito e sem novas tentativas, com `errorCode` e `errorClass` como atributos (I-28, I-30, I-60,
   I-66, I-68, I-69):
   - corpo que não é JSON, ou envelope sem `messageId`, `type`, `occurredAt` ou `data`;
   - `messageId` fora do formato (1 a 128 caracteres em `[A-Za-z0-9._:-]`);
   - `data` que viola as regras de payload da 001 (dinheiro como número, referência por kind, autorreferência etc.);
   - `kind` OPENING ou `providerId` "system";
   - wallet inexistente;
   - `type` diferente de `WagerTransactionRequested`;
   - mesmo `messageId` de uma mensagem já registrada na inbox, mas com conteúdo de negócio diferente;
   - conflito de idempotência (mesma chave com conteúdo diferente, ou mesmo id externo com outra chave), sem linha de
     inbox.
4. **Given** a espera pelo lock da wallet estoura, **When** a mensagem é processada, **Then** o caso é tratado como
   transitório: a mensagem não é confirmada e volta depois (I-30, I-51).
5. **Given** uma transação gravada como FAILED pelo reprocessamento (I-61), **When** chega pela fila uma mensagem com a
   mesma chave e o mesmo conteúdo, **Then** é um replay de FAILED: a mensagem é confirmada, sem efeito e sem evento
   (I-62).

---

### User Story 3 - Receber os eventos de negócio sem perda (Priority: P1)

O provedor recebe na fila de eventos todo evento registrado pelo serviço (processada, rejeitada, saldo alterado,
referência pendente), mesmo quando a instância que confirmou a transação morre logo depois do commit. Várias instâncias
publicam ao mesmo tempo, sobre a mesma outbox, sem perder evento nem deixá-lo preso. Duplicatas são possíveis e seguras
pelo `eventId`.

**Why this priority**: o enunciado (§11) exige que eventos confirmados nunca se percam e que a publicação funcione com
publicadores concorrentes; sem isso, a outbox gravada pela 001 nunca sai do serviço.

**Independent Test**: confirmar transações, matar a instância antes da publicação e conferir que outra instância publica
tudo; rodar dois ou mais publicadores sobre a mesma outbox e conferir que cada evento sai ao menos uma vez e nenhum fica
pendente.

**Acceptance Scenarios**:

1. **Given** uma transação confirmada com seus eventos na outbox, **When** a instância morre antes de publicá-los,
   **Then** outra instância assume e publica todos; nenhum evento confirmado se perde (enunciado §11, I-31).
2. **Given** dois ou mais publicadores ativos sobre a mesma outbox, **When** há eventos pendentes, **Then** cada evento
   é publicado ao menos uma vez, os publicadores não ficam presos uns pelos outros e, depois que todos terminam, nenhum
   evento continua pendente (I-31, I-65).
3. **Given** um publicador que publicou um evento e morreu antes de marcá-lo como publicado, **When** a reserva dele
   expira, **Then** o evento é publicado de novo, com o mesmo `eventId`, e a duplicata é segura para o consumidor
   (I-31).
4. **Given** a fila de eventos indisponível, **When** transações são processadas, **Then** o processamento por HTTP
   continua normalmente e a outbox acumula; quando a fila volta, todos os eventos acumulados são publicados (I-34).
5. **Given** eventos de uma mesma wallet, **When** publicados por publicadores concorrentes, **Then** a ordem entre eles
   não é garantida, e cada evento traz o que o consumidor precisa para ordenar e deduplicar (`eventId` e, nos eventos de
   saldo, `walletVersion`) (I-32).

---

### User Story 4 - Concluir sozinha a operação que chegou antes da referência (Priority: P2)

Uma reversão (ou WIN/LOSS com referência) que ficou PENDING_REFERENCE é reavaliada automaticamente, com espera
crescente. Quando a referência chega e é aplicada, a pendente é concluída; se a referência foi rejeitada, a pendente é
rejeitada; se a referência nunca aparece dentro do limite, a pendente termina REJECTED com `REFERENCE_NOT_FOUND`. O
resultado gera lançamento e eventos como qualquer outra transação.

**Why this priority**: completa o fluxo que a 001 deixou no agendamento inicial; sem ele, operações fora de ordem
ficariam pendentes para sempre.

**Independent Test**: enviar um ROLLBACK antes da BET e conferir a conclusão depois que a BET chega; enviar uma reversão
cuja referência nunca chega e conferir o `REFERENCE_NOT_FOUND` dentro do limite; rodar o reprocessamento em várias
instâncias ao mesmo tempo.

**Acceptance Scenarios**:

1. **Given** um REFUND PENDING_REFERENCE de uma BET que ainda não chegou, **When** a BET chega e é aplicada, **Then** o
   REFUND é reavaliado logo em seguida (sem esperar a próxima tentativa agendada), fica PROCESSED com um lançamento
   CREDIT e registra `WalletBalanceChanged` e `WagerTransactionProcessed` (I-21, I-63).
2. **Given** um REFUND PENDING_REFERENCE, **When** a BET referenciada chega e é REJECTED, **Then** o REFUND fica
   REJECTED com `REFERENCE_REJECTED` e registra `WagerTransactionRejected` (I-15).
3. **Given** um REFUND PENDING_REFERENCE cuja referência nunca chega, **When** as 10 tentativas se esgotam (cerca de
   7 min com a configuração padrão) ou o teto de 10 min desde a criação é atingido, **Then** ele fica REJECTED com
   `REFERENCE_NOT_FOUND` e registra `WagerTransactionRejected` (I-21, I-64).
4. **Given** duas pendentes que referenciam a mesma BET (um REFUND e um ROLLBACK), **When** a BET é aplicada, **Then**
   elas são reavaliadas por ordem de criação, cada uma separadamente: a primeira é aplicada e a segunda fica REJECTED
   com `ALREADY_REVERSED` (I-16, I-63).
5. **Given** o reprocessamento rodando em 3 instâncias ao mesmo tempo, **When** a mesma pendente é elegível em todas,
   **Then** ela é concluída uma única vez, com um único lançamento (constitution III).
6. **Given** uma tentativa em que a referência continua ausente, **When** a tentativa termina, **Then** só o contador de
   tentativas e o horário da próxima mudam; o status continua PENDING_REFERENCE (I-11).
7. **Given** um erro permanente inesperado que impede concluir uma pendente, **When** ele ocorre, **Then** a transação é
   marcada FAILED numa unidade separada, auditável, sem lançamento nem alteração de saldo; o replay dela responde 500
   `INTERNAL_ERROR` com `retryable` false por HTTP e é confirmado sem efeito pela fila (I-61, I-62).
8. **Given** uma pendente já REJECTED por `REFERENCE_NOT_FOUND`, **When** a referência chega depois, **Then** a
   pendente não é reaberta (I-21, limitação documentada).

---

### User Story 5 - Encerrar uma instância sem perder trabalho (Priority: P2)

Ao receber o sinal de término, a instância para de receber mensagens novas, conclui as que estão em andamento dentro de
um prazo configurável e devolve à fila a visibilidade das que não concluiu. Publicação e reprocessamento param de
reservar trabalho novo; o que ficou reservado é retomado por outra instância.

**Why this priority**: implantações e reinícios são rotineiros; sem encerramento gracioso, cada um deixaria mensagens
presas até o fim da visibilidade ou trabalho pela metade.

**Independent Test**: enviar o sinal de término com mensagens em andamento e conferir que todas terminam processadas ou
voltam visíveis, sem perda nem efeito duplicado.

**Acceptance Scenarios**:

1. **Given** mensagens em andamento numa instância, **When** ela recebe o sinal de término, **Then** não recebe mais
   nada, conclui as mensagens em andamento dentro do prazo e confirma as que concluiu (I-34).
2. **Given** mensagens recebidas que não terminam dentro do prazo, **When** o prazo acaba, **Then** a visibilidade delas
   é devolvida à fila, e outra instância as processa uma única vez (I-34).
3. **Given** eventos ou pendentes reservados por uma instância que encerra, **When** ela sai, **Then** outra instância
   retoma esse trabalho depois que a reserva expira, sem perda (I-31, I-65).

---

### User Story 6 - Conter a indisponibilidade de uma dependência (Priority: P2)

Se a fila ficar indisponível, o HTTP continua processando e a outbox acumula. Se o banco ficar indisponível, o
consumidor não confirma nada à fila e o reprocessamento não marca nada. Quando a dependência volta, tudo se recompõe sem
reiniciar instâncias.

**Why this priority**: o enunciado assume indisponibilidade temporária do banco e da fila (§3); a falha de uma não pode
derrubar o que depende só da outra.

**Independent Test**: derrubar a fila e depois o banco durante o processamento, restaurar e conferir que nada se perdeu,
nada duplicou e as instâncias continuaram no ar.

**Acceptance Scenarios**:

1. **Given** a fila indisponível, **When** o provedor submete transações por HTTP, **Then** elas são processadas
   normalmente, os eventos ficam na outbox e o consumo e a publicação tentam de novo com espera crescente, sem derrubar a
   instância (I-34).
2. **Given** o banco indisponível, **When** mensagens chegam pela fila, **Then** nenhuma é confirmada nem vai para a DLQ
   antes do limite de recebimentos; com o banco de volta, são processadas uma única vez (I-30, I-34).
3. **Given** qualquer das duas falhas, **When** a dependência volta, **Then** as instâncias retomam o trabalho sem
   reinício.

---

### User Story 7 - Acompanhar a saúde do processamento por contadores (Priority: P3)

O operador dispõe de contadores de transações por status, duplicatas detectadas, retries, mensagens enviadas à DLQ,
conflitos de lock, atraso da outbox e latência de processamento, registrados por uma porta de métricas. A exposição
desses contadores fica para outra feature.

**Why this priority**: necessária para diagnóstico (constitution VIII), mas não altera o resultado financeiro.

**Independent Test**: provocar cada situação (duplicata, retry, DLQ, conflito de lock, evento pendente) e conferir que
o contador correspondente foi registrado.

**Acceptance Scenarios**:

1. **Given** uma reentrega reconhecida como duplicata, **When** tratada, **Then** o contador de duplicatas aumenta, com
   a origem (inbox, idempotência).
2. **Given** uma mensagem que vai para a DLQ, **When** isso acontece, **Then** o contador de DLQ aumenta, com a classe
   do erro.
3. **Given** eventos pendentes na outbox, **When** o publicador os publica, **Then** o atraso entre o registro e a
   publicação é medido.

---

### Edge Cases

- **Mesma mensagem com conteúdo diferente** (mesmo `messageId`, `payloadHash` diferente): mensagem venenosa → DLQ
  direta, sem efeito (I-28).
- **Mensagens diferentes com a mesma chave e o mesmo conteúdo**: a segunda é replay da transação (I-26); as duas ficam
  registradas na inbox e são confirmadas.
- **Mesma chave com conteúdo diferente pela fila** (conflito de idempotência), ou mesmo id externo com outra chave:
  nunca muda com nova tentativa → DLQ direta, sem efeito e sem linha de inbox, com `errorCode` e `errorClass` (I-68).
- **`messageId` fora do formato** (vazio, mais de 128 caracteres, caractere fora de `[A-Za-z0-9._:-]`): mensagem
  malformada → DLQ direta (I-69).
- **Replay depois da resolução**: a mesma requisição de uma pendente já concluída devolve o estado atual (200, 422,
  202 ou o 500 do I-62), com o saldo observado na conclusão (I-67).
- **Mesma operação por HTTP e pela fila**: reconhecida pela idempotência compartilhada; a segunda é replay (I-28).
- **Replay pela fila de uma transação REJECTED ou PENDING_REFERENCE**: confirmado, sem efeito e sem evento (I-26).
- **Replay de FAILED**: HTTP → 500 `INTERNAL_ERROR` com `retryable` false; fila → confirmado sem efeito (I-62).
- **Autorreferência pela fila** (I-60), **dinheiro como número**, **kind OPENING**, **providerId "system"**: payload
  inválido → DLQ direta (I-30).
- **Tipo de mensagem desconhecido** com envelope válido → DLQ direta (I-66).
- **Wallet inexistente** pela fila → DLQ direta, nada gravado (I-20, I-30).
- **Espera pelo lock esgotada** pela fila → transitório, sem confirmação (I-30, I-51).
- **Mensagem em retry bloqueia o grupo da wallet** na fila ordenada até sair (pela confirmação ou pela DLQ): limitação
  documentada (I-32).
- **Processo morto depois do commit e antes da confirmação**: reentrega vira duplicata, sem novo efeito (I-28, I-40).
- **Publicador morto depois de publicar e antes de marcar**: o evento é republicado com o mesmo `eventId` (I-31).
- **Publicador morto antes de publicar**: a reserva expira e outro publicador assume (I-65).
- **Fila de eventos recusando um evento**: o evento volta a ficar pendente com espera crescente, sem bloquear os outros
  eventos do lote (I-31, I-65).
- **Pendente cuja referência existe em outra wallet ou rodada**: no reprocessamento, REJECTED com
  `REFERENCE_MISMATCH` (I-14, I-44).
- **Pendente cuja referência também está pendente**: continua PENDING_REFERENCE; quando a referência for concluída, a
  pendente é antecipada em seguida (encadeamento) (I-15, I-63).
- **Pendente que, na hora da conclusão, deixaria o saldo negativo** (ex.: ROLLBACK de WIN com saldo menor): REJECTED com
  `REVERSAL_WOULD_OVERDRAW` (I-18).
- **Pendente cuja referência já foi revertida por outra transação** no meio tempo: REJECTED com `ALREADY_REVERSED`
  (I-16).
- **Teto de 10 min atingido antes das 10 tentativas** (ex.: tentativas atrasadas por indisponibilidade): REJECTED com
  `REFERENCE_NOT_FOUND` na próxima avaliação (I-64).
- **Indisponibilidade durante uma tentativa de reprocessamento**: a tentativa é desfeita sem efeito e não consome o
  limite de tentativas (Assumptions).
- **Referência que chega depois do `REFERENCE_NOT_FOUND`**: a pendente não é reaberta (I-21).
- **Sinal de término com mensagens em andamento**: concluídas dentro do prazo ou devolvidas à fila (I-34).
- **Duas instâncias reavaliando a mesma pendente**: uma conclui; a outra encontra a transação já terminal e não faz nada
  (constitution III).

## Requirements *(mandatory)*

### Functional Requirements

#### Consumo da fila de transações

- **FR-001**: O sistema DEVE consumir a fila de transações e processar cada mensagem `WagerTransactionRequested` pela
  mesma operação de submissão usada pelo HTTP, com as mesmas regras, a mesma ordem de avaliação (001/FR-015, I-44) e a
  mesma idempotência (001/FR-030 a 001/FR-037) (enunciado §10, constitution IV).
- **FR-002**: O envelope da mensagem DEVE ter `messageId`, `type`, `occurredAt` (ISO-8601) e `data`. O `messageId`
  DEVE ter de 1 a 128 caracteres em `[A-Za-z0-9._:-]`, o mesmo conjunto do correlationId do HTTP (I-53, I-69). `data`
  DEVE seguir as mesmas regras de payload da submissão HTTP, com `idempotencyKey` no lugar do header (I-23, I-48,
  I-50, I-57, I-58, I-60). Envelope inválido, inclusive `messageId` fora do formato, ou `data` inválido é mensagem
  malformada: erro permanente (I-30, I-69).
- **FR-003**: Toda mensagem tratada DEVE ficar registrada numa inbox persistente, única por (consumidor, `messageId`), com
  o hash de conteúdo de negócio (o mesmo `payloadHash` do I-25). Quando a mensagem produz efeito, o registro na inbox, a
  transação, o saldo, o ledger e a outbox DEVEM ser confirmados juntos ou nenhum deles (I-28, enunciado §11,
  constitution IV).
- **FR-004**: Mensagem já registrada na inbox com o mesmo hash DEVE ser confirmada à fila sem novo efeito nem evento.
  Mesmo `messageId` com hash diferente é mensagem venenosa: erro permanente (I-28).
- **FR-005**: A confirmação da mensagem à fila DEVE acontecer somente depois do commit; nenhuma mensagem é confirmada com
  a transação aberta ou desfeita (enunciado §10, constitution IV).
- **FR-006**: A mesma operação enviada por HTTP e pela fila DEVE ser reconhecida como a mesma transação pela idempotência
  compartilhada; a segunda é replay (I-26, I-28).
- **FR-007**: Reentregas, inclusive simultâneas e em instâncias diferentes, NUNCA DEVEM produzir mais de um efeito
  (I-27, I-28; constitution III, IV).

#### Classificação de erros e DLQ

- **FR-008**: Erro de negócio (transação REJECTED ou PENDING_REFERENCE gravada) DEVE ser persistido e a mensagem
  confirmada, sem novas tentativas (I-30).
- **FR-009**: Erro transitório (banco indisponível, falha de conexão, espera de lock esgotada, deadlock ou falha de
  serialização depois das repetições internas, timeout) NÃO DEVE confirmar a mensagem; ela DEVE voltar a ficar visível
  com espera crescente e, depois de 5 recebimentos sem sucesso, ir para a DLQ (I-30, I-34, I-51).
- **FR-010**: Erro permanente DEVE levar a mensagem direto para a DLQ, no primeiro recebimento, sem novas tentativas:
  corpo que não é JSON ou envelope inválido; `data` inválido; `kind` OPENING; `providerId` "system"; wallet inexistente;
  `type` diferente de `WagerTransactionRequested`; mesmo `messageId` com hash diferente; conflito de idempotência (mesma
  chave com conteúdo diferente, ou mesmo id externo com outra chave), que não grava linha de inbox (I-28, I-30, I-60,
  I-66, I-68, I-69).
- **FR-011**: O consumidor da fila NUNCA DEVE gravar FAILED; o registro do erro permanente é a DLQ (I-61).
- **FR-012**: O replay pela fila de uma transação FAILED DEVE ser confirmado, sem efeito e sem evento (I-62).
- **FR-013**: Nenhuma falha, de nenhuma classe, PODE deixar efeito parcial: transação, saldo, ledger, inbox e outbox são
  confirmados juntos ou nenhum (constitution IV).

#### Encerramento gracioso

- **FR-014**: Ao receber o sinal de término, a instância DEVE parar de receber mensagens, concluir as que estão em
  andamento dentro de um prazo configurável e devolver à fila a visibilidade das que não concluiu (I-34, enunciado §10).
- **FR-015**: Ao encerrar, publicação e reprocessamento DEVEM parar de reservar trabalho novo; o trabalho reservado e não
  concluído DEVE ser retomado por outra instância quando a reserva expirar (I-31, I-65).

#### Publicação da outbox

- **FR-016**: O sistema DEVE publicar na fila de eventos todo evento registrado na outbox, ao menos uma vez, inclusive os
  confirmados por uma instância que morreu antes de publicá-los (enunciado §11, I-31).
- **FR-017**: A publicação DEVE funcionar com vários publicadores concorrentes sobre a mesma outbox: cada publicador
  reserva um lote de até 10 eventos por 30 s, sem bloquear os demais; evento reservado e não publicado volta a ficar
  disponível quando a reserva expira (I-31, I-65).
- **FR-018**: Falha ao publicar um evento DEVE incrementar suas tentativas e reagendá-lo com espera crescente de 1 a 60 s,
  sem bloquear os outros eventos (I-31, I-65).
- **FR-019**: Um evento publicado e não marcado (queda entre publicar e marcar) DEVE ser publicado de novo com o mesmo
  `eventId`; o identificador de deduplicação na fila de eventos é o `eventId`, e o agrupamento é por wallet (I-29,
  I-31).
- **FR-020**: Nenhum evento é publicado antes do commit da transação que o registrou; a publicação lê só eventos já
  confirmados (constitution IV, falha eliminatória 6).
- **FR-021**: A ordem entre eventos de uma wallet NÃO é garantida com publicadores concorrentes; os eventos DEVEM trazer
  `eventId` e, nos de saldo, `walletVersion`, para o consumidor ordenar e deduplicar (I-32).
- **FR-022**: Os eventos publicados DEVEM ser o envelope gravado na outbox, sem alteração (enunciado §11, 001/FR-047).

#### Reprocessamento de PENDING_REFERENCE

- **FR-023**: Transações PENDING_REFERENCE DEVEM ser reavaliadas automaticamente quando chega a hora agendada, com espera
  crescente (base 5 s, fator 2, teto 60 s, com jitter) (I-21).
- **FR-024**: Cada reavaliação DEVE aplicar as regras da 001 na ordem do I-44, sob o lock da wallet, com a referência
  relida naquele momento: referência ausente ou ainda pendente → continua PENDING_REFERENCE, só com tentativas e próxima
  hora atualizadas (I-11); referência REJECTED ou FAILED → REJECTED `REFERENCE_REJECTED`; referência inconsistente →
  o código da consistência; referência PROCESSED → seguem `ALREADY_REVERSED` e as regras de saldo (I-14 a I-18, I-44,
  I-54).
- **FR-025**: Esgotadas as 10 tentativas, ou atingido o teto de 10 min contado da criação, o que vier primeiro, a
  transação DEVE ficar REJECTED com `REFERENCE_NOT_FOUND` e registrar `WagerTransactionRejected` (I-21, I-64).
- **FR-026**: Ao processar qualquer transação, as pendentes que a referenciam DEVEM ser reavaliadas logo depois do
  commit, sem esperar a hora agendada, por ordem de criação, cada uma separadamente, sob o lock da wallet (I-21, I-63).
- **FR-027**: A conclusão de uma pendente DEVE gerar lançamento e eventos como qualquer outra transação: na mesma
  unidade atômica, mudança de status, saldo, ledger e outbox (001/FR-040, 001/FR-045).
- **FR-028**: O reprocessamento DEVE ser correto com várias instâncias ao mesmo tempo: cada pendente é concluída no
  máximo uma vez, e a instância que a encontrar já terminal não faz nada (constitution III).
- **FR-029**: Erro permanente inesperado que impeça concluir uma pendente DEVE marcá-la FAILED numa unidade separada,
  depois do rollback da principal, sem lançamento nem alteração de saldo (I-22, I-61).
- **FR-030**: O replay por HTTP de uma transação FAILED DEVE responder 500 `INTERNAL_ERROR` com `retryable` false, no
  formato único de erro (I-38, I-62).
- **FR-031**: Uma pendente REJECTED por `REFERENCE_NOT_FOUND` NÃO DEVE ser reaberta se a referência chegar depois (I-21).
- **FR-032**: Os limites (tentativas, teto, base e teto da espera) DEVEM ser configuráveis, para que os testes usem
  valores curtos sem mudar o comportamento (I-21).

#### Indisponibilidade e observabilidade

- **FR-033**: Com a fila indisponível, o HTTP DEVE continuar processando e a outbox acumulando; consumo e publicação
  DEVEM tentar de novo com espera crescente, sem derrubar a instância (I-34).
- **FR-034**: Com o banco indisponível, o consumidor NÃO DEVE confirmar mensagens nem mandá-las à DLQ antes do limite de
  recebimentos, e o reprocessamento NÃO DEVE gravar nada (I-30, I-34).
- **FR-035**: Quando a dependência volta, as instâncias DEVEM retomar o trabalho sem reinício.
- **FR-036**: O sistema DEVE registrar, por uma porta de métricas, contadores de transações por status, duplicatas
  detectadas (com a origem), retries, mensagens enviadas à DLQ (com a classe do erro), conflitos de lock, atraso da
  outbox e latência de processamento (constitution VIII, enunciado §12). A exposição fica fora desta feature.
- **FR-037**: Os logs do processamento pela fila DEVEM trazer `messageId`, `correlationId`, `transactionId`, `walletId`
  e `providerId` quando conhecidos, sem valores monetários (constitution VIII).

#### Rastreabilidade, replay depois da resolução e DLQ

- **FR-038**: Na fila, a transação e os eventos registrados a partir de uma mensagem DEVEM usar o `messageId` como
  `correlationId` e como `causationId`. Os eventos registrados pelo reprocessamento de uma pendente DEVEM usar o
  `correlation_id` gravado na própria pendente, sem `causationId`. O `correlation_id` de uma transação nunca muda
  (I-53, I-69).
- **FR-039**: O replay de uma transação que estava PENDING_REFERENCE e foi concluída pelo reprocessamento DEVE devolver
  o estado atual gravado: PROCESSED → 200, REJECTED → 422 com `failureCode`, ainda pendente → 202, FAILED → 500 com
  `retryable` false (I-62), sempre com o saldo observado na conclusão. A conclusão reescreve o saldo observado e a
  referência interna resolvida (I-67). Pela fila, todos esses replays são confirmados sem efeito (I-26, I-62).
- **FR-040**: Toda mensagem que a aplicação envia à DLQ por erro permanente DEVE levar `errorCode` (estável, da
  taxonomia ou do motivo da classificação) e `errorClass` (`permanent`) como atributos, para o diagnóstico e o
  redrive; a mensagem só é removida da fila principal depois de aceita pela DLQ (I-30, I-68). As mensagens que chegam à
  DLQ pelo limite de recebimentos (transitórias) são movidas pela própria fila, sem esses atributos.

### Key Entities *(include if feature involves data)*

- **Mensagem de transação**: envelope recebido da fila (`messageId`, `type`, `occurredAt`, `data`), onde `data` é a
  operação de negócio com a chave de idempotência.
- **Registro de inbox**: prova persistente de que uma mensagem foi tratada; único por (consumidor, `messageId`); guarda o
  hash do conteúdo, quando foi recebida e quando foi processada.
- **Evento da outbox** (existente, da 001): ganha o ciclo de publicação, com tentativas, próxima tentativa e data de
  publicação.
- **Transação PENDING_REFERENCE** (existente, da 001): ganha o ciclo de reavaliação, com contador de tentativas e próxima
  tentativa, até ficar PROCESSED, REJECTED ou FAILED.
- **Mensagem na DLQ**: mensagem que esgotou os recebimentos ou teve erro permanente; é o registro auditável do erro na
  fila.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A mesma mensagem entregue 50 vezes, em paralelo e por 3 instâncias, produz exatamente 1 efeito (1
  transação, no máximo 1 lançamento e 1 conjunto de eventos) em 100% das execuções.
- **SC-002**: Com o processo morto entre o commit e a confirmação, 100% das mensagens reentregues são tratadas como
  duplicata, sem novo efeito.
- **SC-003**: Com 2 ou mais publicadores sobre a mesma outbox, 100% dos eventos são publicados ao menos uma vez e, em até
  60 s depois que todos os publicadores restantes estão ativos, nenhum evento continua pendente.
- **SC-004**: 100% das mensagens com erro permanente chegam à DLQ com exatamente 1 recebimento; 100% das mensagens com
  erro transitório persistente chegam à DLQ com exatamente 5 recebimentos.
- **SC-005**: Uma pendente cuja referência é aplicada é concluída em até 5 s depois da aplicação da referência; uma
  pendente sem referência termina REJECTED `REFERENCE_NOT_FOUND` em até 10 min da criação (teto), e normalmente depois da
  10ª tentativa, cerca de 7 min com a configuração padrão.
- **SC-006**: Com instâncias mortas abruptamente no meio de uma carga de operações pela fila e por HTTP, ao final, depois
  da recuperação: 100% das wallets com saldo igual ao reconstruído pelo ledger, 0 eventos confirmados sem publicação, 0
  pendentes sem próxima tentativa agendada e 0 mensagens perdidas (cada uma processada, na DLQ ou ainda na fila).
- **SC-007**: No término gracioso, 0 mensagens em andamento são perdidas: cada uma termina confirmada depois do commit
  ou volta visível para outra instância.
- **SC-008**: SC-001 a SC-007 continuam válidos com 3 ou mais instâncias simultâneas, com papéis diferentes (consumo,
  publicação, reprocessamento).
- **SC-009**: Com a fila indisponível, 100% das submissões por HTTP sem disputa continuam respondendo normalmente, e
  100% dos eventos acumulados são publicados depois da volta da fila.
- **SC-010**: Em ambiente local sem disputa, um evento confirmado é publicado em até 5 s, e uma mensagem válida é
  processada e confirmada em até 2 s depois de visível.

## Assumptions

- Autenticação fora do foco: a fila de transações é canal interno confiável, mas a identidade do provedor na mensagem
  passa pelas mesmas validações de domínio (enunciado §2, I-41).
- Filas: `wager-transactions.fifo` com sua DLQ `wager-transactions-dlq.fifo` na entrada e `wager-events.fifo` na saída
  (I-29). O limite de recebimentos antes da DLQ é 5 (I-30).
- A espera crescente das mensagens transitórias usa o prazo de visibilidade da própria fila; os valores exatos ficam
  para o plan.
- Uma falha de infraestrutura durante uma tentativa de reprocessamento é desfeita sem efeito e não consome o limite de
  tentativas: só conta como tentativa a avaliação concluída em que a referência continua ausente ou pendente. O teto de
  10 min continua valendo (I-64).
- O encerramento gracioso só é verificável em Linux (no container); no Windows o sinal de término vira término forçado
  (spike S-10 da 001). Os testes de término gracioso rodam no container.
- Os critérios de tempo (SC-005, SC-010) valem com a configuração padrão em ambiente local; os testes usam limites
  curtos configuráveis (FR-032).

### Interpretações registradas para esta feature

Os pontos que as interpretações anteriores não cobriam foram registrados em `docs/interpretacoes.md` em 2026-11-08 e
são normativos nesta spec:

- **I-67**: replay depois da resolução de uma PENDING_REFERENCE devolve o estado atual gravado (FR-039).
- **I-68**: conflito de idempotência pela fila é erro permanente, DLQ direta, sem inbox, com `errorCode` e `errorClass`
  (FR-010, FR-040).
- **I-69**: `messageId` como `correlationId` e `causationId` na fila, validado no envelope; eventos do reprocessamento
  com o `correlation_id` da pendente (FR-002, FR-038).

### Fora de escopo

- Endpoint de reconciliação, health checks e exposição de métricas (os contadores são registrados por porta, FR-036).
- Testes de carga, harness de caos separado (a queda abrupta de instâncias no meio da carga está no SC-006) e UI.
- README e ARCHITECTURE.md, adiados para o fim do projeto (tasks da 001, T119 e T120).

### Dependências

- Feature 001 implementada: submissão com idempotência, outbox gravada na mesma transação, PENDING_REFERENCE com
  `reference_attempts` e `next_reference_attempt_at`.
- Fila emulada e armazenamento reais em container para os testes de integração e de concorrência (I-43,
  constitution VII), com 3 ou mais instâncias simultâneas.
