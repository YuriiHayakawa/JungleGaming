# Feature Specification: Núcleo Transacional de Apostas

**Feature Branch**: `001-wagering-transaction-core` (id da feature e nome da branch no repositório git)

**Created**: 2026-11-07

**Status**: Draft

**Input**: User description: "Construir o núcleo transacional de apostas de um serviço financeiro para provedores de jogos: wallets, ledger auditável, transações (BET, WIN, LOSS, REFUND, ROLLBACK) via HTTP e idempotência persistente." (descrição completa, com problema, usuários, funcionalidades, contratos, critérios de aceitação, edge cases e fora de escopo, fornecida em `/speckit-specify`)

**Fontes normativas**: `docs/enunciado.md` (seções 3, 6, 7, 8 e 9), `docs/interpretacoes.md` (ids I-xx citados
nos requisitos, incluindo I-44 a I-58, registrados para esta feature) e `.specify/memory/constitution.md`
v1.0.1. Em caso de conflito, prevalece a ordem definida no Princípio I da constitution.

## Clarifications

### Session 2026-11-07

- Q: Quando uma requisição precisa esperar outra operação na mesma wallet terminar, quanto tempo ela pode esperar
  e o que deve responder se o tempo acabar? → A: Espera limitada e configurável (`WALLET_LOCK_TIMEOUT_MS`, padrão
  5000), aplicada como limite de espera por lock na transação. Ao estourar, a transação sofre rollback sem efeito
  e a resposta é 503 `SERVICE_UNAVAILABLE` com Retry-After. O timeout de aquisição de conexão e o timeout HTTP do
  servidor ficam acima desse limite, para que o provedor sempre receba o 503 padronizado e nunca um corte de
  conexão (I-51).
- Q: Quando o provedor tenta criar uma wallet que já existe para o mesmo jogador e moeda, a resposta 409 deve
  dizer qual é o id da wallet existente? → A: Sim. O 409 `WALLET_ALREADY_EXISTS` traz apenas
  `error.details.walletId` (sem saldo, `version` ou outros dados). O id é lido depois da violação de unicidade,
  fora da tentativa que falhou, quando a wallet vencedora já está confirmada. Em criações simultâneas, todas as
  perdedoras recebem o mesmo `walletId`. Continua sem replay: nenhum efeito nem evento é registrado (I-52).
- Q: De onde vem o `correlationId` de cada requisição: o provedor pode enviar o dele ou o serviço sempre gera
  um? → A: O serviço aceita o header `X-Correlation-Id` (1 a 128 caracteres em `[A-Za-z0-9._:-]`). Se o header
  faltar ou for inválido, o serviço gera um UUIDv7 e segue, NUNCA responde 400. No replay, a resposta usa o
  `correlationId` da requisição atual, nenhum evento é registrado e a transação original mantém o seu. O mesmo
  valor aparece no header da resposta, em `error.correlationId`, nos logs e nos eventos registrados pela
  requisição (I-53).
- Q: Uma LOSS pode ter valor "0.00"? → A: Sim, só LOSS, que não move saldo nem gera lançamento. BET, WIN, REFUND e
  ROLLBACK com valor zero continuam 400 `VALIDATION_ERROR`; saldo inicial "0.00" continua aceito (I-02 ajustado).

## User Scenarios & Testing *(mandatory)*

Atores:

- **Provedor de jogos**: sistema externo que cria wallets e submete operações de aposta, com entrega
  at-least-once (repete, paraleliza e entrega fora de ordem).
- **Operador**: pessoa ou sistema interno que consulta saldos, ledger e estado das transações para auditoria.

### User Story 1 - Abrir wallet com saldo inicial auditável (Priority: P1)

O provedor cria uma wallet para um jogador em uma moeda, com saldo inicial. Quando o saldo inicial é maior que
zero, o sistema registra uma transação interna de abertura e o lançamento de crédito correspondente, de modo que
o saldo nasça já explicado pelo ledger. Um jogador tem no máximo uma wallet por moeda, inclusive quando duas
criações chegam ao mesmo tempo.

**Why this priority**: sem wallet não existe nenhuma outra operação; a abertura é também o primeiro ponto onde a
invariante "saldo == ledger" precisa valer.

**Independent Test**: criar wallets com saldo positivo e zero, consultar wallet e ledger e verificar o saldo
reconstruído; disparar criações simultâneas para o mesmo jogador e moeda.

**Acceptance Scenarios**:

1. **Given** nenhum wallet para o jogador P em BRL, **When** o provedor cria uma wallet com saldo inicial
   "1000.00" BRL, **Then** a resposta é de criação com `id`, `playerId`, `balance` `{ "amount": "1000.00",
   "currency": "BRL" }` e `version` 1, e o ledger contém exatamente um lançamento CREDIT de "1000.00" com saldo
   antes "0.00" e saldo depois "1000.00", vinculado a uma transação interna de abertura PROCESSED (I-06, I-07).
2. **Given** nenhum wallet para P em BRL, **When** o provedor cria uma wallet com saldo inicial "0.00",
   **Then** a wallet é criada com saldo "0.00", `version` 1, nenhuma transação de abertura e nenhum lançamento
   (I-06).
3. **Given** uma wallet existente para P em BRL, **When** o provedor tenta criar outra para P em BRL, **Then** a
   resposta é conflito (409, `WALLET_ALREADY_EXISTS`) com `error.details.walletId` igual ao id da wallet
   existente e nenhum outro dado dela, sem replay e sem nenhum efeito ou evento (I-10, I-52).
4. **Given** nenhum wallet para P em BRL, **When** 10 requisições de criação para P em BRL chegam
   simultaneamente, **Then** exatamente uma é criada e as outras 9 recebem conflito com o mesmo
   `error.details.walletId`, igual ao id da criada; existe uma única wallet e, se o saldo inicial for positivo, um
   único lançamento de abertura (I-10, I-52).
5. **Given** uma wallet de P em BRL, **When** o provedor cria uma wallet para P em USD, **Then** a criação é
   aceita, pois a unicidade é por jogador e moeda (I-05).

---

### User Story 2 - Apostar sem nunca ficar com saldo negativo (Priority: P1)

O provedor submete uma BET e o valor é debitado do saldo do jogador. Sem saldo suficiente, a transação é
registrada como rejeitada, sem alterar saldo nem gerar lançamento. Quando duas apostas disputam o mesmo saldo,
inclusive em instâncias diferentes do serviço, só as que cabem no saldo são aplicadas.

**Why this priority**: é a operação de maior volume e o principal risco financeiro (saldo negativo por race,
débito duplicado).

**Independent Test**: com uma wallet aberta, submeter BETs dentro e fora do saldo e o cenário 100/80/80 em
paralelo real, verificando status, saldo, ledger e a invariante final.

**Acceptance Scenarios**:

1. **Given** wallet com saldo "1000.00" BRL, **When** o provedor submete BET de "25.00" BRL, **Then** a resposta
   é de criação com `status` PROCESSED, `balance` "975.00", `idempotentReplay` false, um lançamento DEBIT de
   "25.00" (antes "1000.00", depois "975.00") e a `version` da wallet incrementada em 1.
2. **Given** wallet com saldo "10.00", **When** o provedor submete BET de "25.00", **Then** a resposta é rejeição
   de negócio (422) com `status` REJECTED, `failureCode` `INSUFFICIENT_FUNDS`, `retryable` false e `balance`
   observado "10.00"; o saldo, a `version` e o ledger não mudam e a transação fica registrada (I-18, I-19).
3. **Given** wallet com saldo "100.00", **When** duas BETs distintas de "80.00" são processadas simultaneamente,
   **Then** exatamente uma fica PROCESSED, a outra REJECTED com `INSUFFICIENT_FUNDS`, o saldo final é "20.00" e
   existe exatamente um lançamento DEBIT dessas apostas.
4. **Given** o cenário anterior executado com 3 ou mais instâncias do serviço atendendo as requisições,
   **When** as apostas chegam por instâncias diferentes, **Then** o resultado é idêntico ao cenário 3.
5. **Given** wallet com saldo "9999999999999990.00", **When** o provedor submete WIN de "10.00", **Then** a
   resposta é rejeição de negócio (422) com `status` REJECTED, `failureCode` `BALANCE_LIMIT_EXCEEDED`, `retryable`
   false e `balance` observado "9999999999999990.00"; o saldo, a `version` e o ledger não mudam e a transação fica
   registrada (I-54).

---

### User Story 3 - Reenviar com segurança (idempotência persistente) (Priority: P1)

O provedor reenvia a mesma requisição depois de timeout ou erro de rede. Uma requisição idêntica devolve o
resultado original (mesmo `transactionId`, `status` e saldo observado naquele momento) marcado como replay e
nunca gera novo efeito. A mesma chave com conteúdo diferente é conflito, nunca replay.

**Why this priority**: a entrega at-least-once torna o reenvio rotineiro; sem isso todo retry vira risco de
débito ou crédito duplicado.

**Independent Test**: submeter uma BET, reenviá-la sequencialmente e 50 vezes em paralelo, alterar um campo de
negócio mantendo a chave e reutilizar o (provedor, id externo) com outra chave.

**Acceptance Scenarios**:

1. **Given** uma BET PROCESSED com saldo observado "975.00", **When** a mesma requisição é reenviada depois que
   o saldo mudou para "900.00", **Then** a resposta tem o mesmo `transactionId`, `status` PROCESSED, `balance`
   "975.00", `idempotentReplay` true e status 200; nenhum lançamento novo é criado (I-26, I-39).
2. **Given** uma BET REJECTED, **When** a mesma requisição é reenviada, **Then** a resposta repete a rejeição
   original (422, mesmo `transactionId`, `failureCode` e saldo observado) com `idempotentReplay` true (I-26).
3. **Given** nenhuma transação com a chave K, **When** a mesma BET com a chave K é enviada 50 vezes em paralelo,
   **Then** existe um único débito, todas as 50 respostas referenciam o mesmo `transactionId`, exatamente uma
   tem `idempotentReplay` false e as demais true (I-27).
4. **Given** uma transação registrada com a chave K, **When** chega uma requisição com a chave K e qualquer campo
   de negócio diferente (ex.: valor "26.00"), **Then** a resposta é conflito de idempotência (409,
   `IDEMPOTENCY_CONFLICT`) e nada é alterado (I-24, I-25).
5. **Given** uma transação do provedor A com id externo X e chave K1, **When** chega outra requisição do
   provedor A com id externo X e chave K2, **Then** a resposta é conflito de idempotência (409) (I-24).
6. **Given** uma requisição idêntica à original, exceto por metadados de transporte e pela própria chave de
   idempotência no header, **When** o hash de payload é calculado, **Then** ele é o mesmo do original, pois só
   os campos de negócio entram no hash (I-25).

---

### User Story 4 - Registrar o resultado da rodada com WIN e LOSS (Priority: P2)

O provedor informa o desfecho da rodada: WIN credita o valor; LOSS registra o resultado sem movimentar saldo. A
referência à BET é opcional.

**Why this priority**: fecha o ciclo de uma rodada; depende das stories 1 a 3.

**Independent Test**: com uma BET PROCESSED, submeter WIN e LOSS com e sem referência e verificar saldo, ledger
e a validação da referência.

**Acceptance Scenarios**:

1. **Given** wallet com saldo "975.00", **When** o provedor submete WIN de "50.00" sem referência, **Then** a
   transação fica PROCESSED, o saldo vai a "1025.00" e há um lançamento CREDIT de "50.00" (I-12).
2. **Given** uma BET PROCESSED na rodada R, **When** o provedor submete LOSS referenciando essa BET, **Then** a
   transação fica PROCESSED, o saldo e a `version` não mudam e nenhum lançamento é criado (I-12, I-13).
3. **Given** uma BET PROCESSED na rodada R, **When** o provedor submete WIN referenciando essa BET mas com rodada
   R2, **Then** a transação é REJECTED com `REFERENCE_MISMATCH` (I-14).
4. **Given** uma WIN PROCESSED, **When** o provedor submete LOSS referenciando essa WIN, **Then** a transação é
   REJECTED com `INVALID_REFERENCE_KIND` (I-13, I-46).
5. **Given** wallet com saldo "975.00" e `version` N, **When** o provedor submete LOSS de "0.00", **Then** a
   transação fica PROCESSED, nenhum lançamento é criado e o saldo continua "975.00" com `version` N (I-02, I-12).

---

### User Story 5 - Reverter com REFUND e ROLLBACK uma única vez (Priority: P2)

O provedor desfaz o efeito de uma transação aplicada. REFUND credita de volta uma BET; ROLLBACK aplica o inverso
da referência (BET → crédito, WIN → débito, REFUND → débito). A reversão exige referência existente e
aplicada, com o mesmo provedor, jogador, wallet, moeda e rodada, e valor igual ao original. Cada transação
referenciada pode ser revertida uma única vez no total, contando REFUND e ROLLBACK juntos. Uma reversão que
deixaria o saldo negativo é rejeitada com código próprio, diferente do de aposta sem saldo.

**Why this priority**: reversões são a segunda maior fonte de crédito duplicado; dependem das stories 1 a 4.

**Independent Test**: para cada combinação de tipo de reversão e tipo de referência, verificar efeito no saldo,
ledger e códigos de rejeição; disparar REFUND e ROLLBACK simultâneos sobre a mesma BET.

**Acceptance Scenarios**:

1. **Given** uma BET PROCESSED de "25.00", **When** o provedor submete REFUND de "25.00" referenciando-a,
   **Then** o REFUND fica PROCESSED com um lançamento CREDIT de "25.00" (I-12).
2. **Given** uma WIN PROCESSED de "50.00" e saldo "1025.00", **When** o provedor submete ROLLBACK de "50.00"
   referenciando-a, **Then** o ROLLBACK fica PROCESSED com um lançamento DEBIT de "50.00" (I-12).
3. **Given** uma BET já revertida por REFUND, **When** o provedor submete ROLLBACK referenciando a mesma BET,
   **Then** a transação é REJECTED com `ALREADY_REVERSED` e não há crédito adicional (I-16).
4. **Given** uma BET PROCESSED, **When** um REFUND e um ROLLBACK referenciando-a são processados
   simultaneamente, **Then** no máximo um é aplicado e o outro é REJECTED com `ALREADY_REVERSED` (I-16).
5. **Given** uma BET PROCESSED de "25.00", **When** o provedor submete REFUND de "20.00", **Then** a transação é
   REJECTED com `AMOUNT_MISMATCH` (I-17).
6. **Given** uma WIN PROCESSED de "50.00" e saldo atual "30.00", **When** o provedor submete ROLLBACK da WIN,
   **Then** a transação é REJECTED com `REVERSAL_WOULD_OVERDRAW` (distinto de `INSUFFICIENT_FUNDS`), o saldo
   continua "30.00" e a rejeição fica registrada (I-18).
7. **Given** uma WIN PROCESSED, **When** o provedor submete REFUND referenciando-a, **Then** a transação é
   REJECTED com `INVALID_REFERENCE_KIND`; o mesmo vale para ROLLBACK de LOSS ou de ROLLBACK (I-14).
8. **Given** uma BET REJECTED, **When** o provedor submete REFUND referenciando-a, **Then** a transação é
   REJECTED com `REFERENCE_REJECTED` (I-15).
9. **Given** REFUND ou ROLLBACK sem `referenceExternalTransactionId`, **When** submetido, **Then** a resposta é
   payload inválido (400) e nada é registrado (I-13).

---

### User Story 6 - Aceitar como pendente a operação que chega antes da referência (Priority: P2)

Uma operação com referência (tipicamente REFUND ou ROLLBACK) pode chegar antes da transação referenciada. Ela é
aceita e registrada como pendente de referência, e a resposta indica aceite pendente. O reprocessamento
posterior pertence a outra feature.

**Why this priority**: sem isso operações fora de ordem seriam perdidas ou rejeitadas indevidamente.

**Independent Test**: submeter um ROLLBACK cuja referência não existe e verificar resposta, estado registrado,
ausência de efeito no saldo e replay.

**Acceptance Scenarios**:

1. **Given** nenhuma transação do provedor A com id externo X, **When** o provedor A submete ROLLBACK
   referenciando X, **Then** a resposta é aceite pendente (202) com `status` PENDING_REFERENCE, saldo observado
   inalterado e sem `failureCode`; nenhum lançamento é criado (I-15, I-39).
2. **Given** a referência X existe mas está PENDING_REFERENCE, **When** chega uma reversão referenciando X,
   **Then** a reversão também fica PENDING_REFERENCE (I-15).
3. **Given** um ROLLBACK PENDING_REFERENCE, **When** a mesma requisição é reenviada, **Then** a resposta é o mesmo
   aceite pendente (202, mesmo `transactionId`) com `idempotentReplay` true (I-26).

---

### User Story 7 - Decidir o próximo passo sem interpretar texto (Priority: P2)

Toda resposta que não seja sucesso traz um código de falha estável e um indicador de reenvio, e as cinco
situações (payload inválido, conflito de idempotência, rejeição de negócio, aceite pendente e falha transitória)
são sempre distinguíveis, do mesmo jeito em todos os endpoints.

**Why this priority**: é o contrato que permite ao provedor automatizar retries com segurança; atravessa todas
as stories anteriores.

**Independent Test**: provocar cada situação em cada endpoint aplicável e verificar status, formato e código.

**Acceptance Scenarios**:

1. **Given** qualquer endpoint, **When** o payload é inválido, **Then** a resposta é 400 no formato único de erro
   `{ error: { code, message, retryable, correlationId, details? } }` com `retryable` false (I-38, I-39).
2. **Given** uma submissão de transação, **When** cada uma das cinco situações ocorre, **Then** cada uma recebe
   um status distinto: 400, 409, 422, 202 e 503, respectivamente (I-39).
3. **Given** uma rejeição de negócio, **When** o provedor lê a resposta, **Then** encontra `failureCode` da
   taxonomia de `docs/interpretacoes.md` §7 e `retryable` false (I-18, I-19, I-45).

---

### User Story 8 - Auditar wallet, ledger e transações (Priority: P3)

O operador consulta uma wallet, percorre seu ledger paginado com cursor estável e opaco, vê saldo antes e depois
em cada lançamento, e consulta qualquer transação pelo id interno ou pelo par provedor + id externo.

**Why this priority**: necessário para auditoria e para os testes de invariante, mas não altera estado.

**Independent Test**: após uma sequência de operações, paginar o ledger inteiro, reconstruir o saldo e consultar
cada transação pelos dois caminhos.

**Acceptance Scenarios**:

1. **Given** uma wallet com 120 lançamentos, **When** o operador pagina o ledger sem cursor e com `limit` 50,
   seguindo o cursor devolvido, **Then** recebe 50, 50 e 20 lançamentos em ordem crescente de registro, cada um
   exatamente uma vez, e a última página indica que não há próxima (I-36).
2. **Given** a paginação em andamento, **When** novos lançamentos são criados na mesma wallet, **Then** as
   páginas seguintes continuam sem duplicar nem pular lançamentos já vistos (I-36).
3. **Given** uma transação conhecida, **When** o operador a consulta pelo id interno e pelo par
   (provedor, id externo), **Then** ambas as consultas retornam a mesma transação com tipo, valor, status,
   `failureCode` quando houver, referência quando houver e saldo observado.
4. **Given** um cursor adulterado ou um `limit` fora de 1 a 200, **When** o operador consulta o ledger,
   **Then** a resposta é payload inválido (400) (I-36, I-47).
5. **Given** uma wallet ou transação inexistente, **When** consultada, **Then** a resposta é 404 no formato
   único de erro, com `WALLET_NOT_FOUND` ou `TRANSACTION_NOT_FOUND` (I-55).

---

### User Story 9 - Falha momentânea sem efeito parcial (Priority: P2)

Se o armazenamento ficar indisponível durante uma operação, a resposta indica indisponibilidade com orientação
de nova tentativa e nada fica registrado pela metade, de modo que reenviar é sempre seguro.

**Why this priority**: o enunciado assume indisponibilidade temporária do banco; o provedor precisa poder
reenviar sem medo.

**Independent Test**: interromper o armazenamento durante submissões e criações, verificar a resposta, restaurar,
reenviar e conferir que existe exatamente um efeito.

**Acceptance Scenarios**:

1. **Given** o armazenamento indisponível, **When** o provedor submete uma transação ou cria uma wallet,
   **Then** a resposta é 503 com `SERVICE_UNAVAILABLE`, `retryable` true e orientação de espera (Retry-After)
   (I-34, I-39).
2. **Given** a falha ocorreu no meio do processamento, **When** o armazenamento volta, **Then** não existe
   transação, lançamento, alteração de saldo ou evento registrado parcialmente para aquela requisição.
3. **Given** a falha anterior, **When** o provedor reenvia a mesma requisição, **Then** ela é processada uma única
   vez, como se fosse a primeira (`idempotentReplay` false).

---

### Edge Cases

- **Valor zero** em BET, WIN, REFUND ou ROLLBACK → 400 `VALIDATION_ERROR`; LOSS de "0.00" é aceita e fica
  PROCESSED sem efeito no saldo; saldo inicial "0.00" na criação de wallet é aceito (I-02).
- **Mais de 2 casas decimais** ("25.001") → 400; "25" e "25.5" são aceitos e normalizados para "25.00" e
  "25.50" (I-01).
- **amount como número JSON** (`25.00` sem aspas) → 400 (I-01).
- **Sinal, espaços, notação científica, NaN, Infinity, string vazia** → 400 (I-01).
- **Valor acima de 9999999999999999.99** → 400 (I-03).
- **Crédito que levaria o saldo acima de 9999999999999999.99** (WIN, REFUND ou ROLLBACK de BET) → REJECTED
  `BALANCE_LIMIT_EXCEEDED`, 422, sem alterar saldo nem gerar lançamento (I-54).
- **Moeda fora de `^[A-Z]{3}$`** → 400; **moeda válida mas diferente da wallet** (USD em wallet BRL) → REJECTED
  `CURRENCY_MISMATCH` (I-05, I-19).
- **Jogador que não é dono da wallet** → REJECTED `WALLET_PLAYER_MISMATCH` (I-19).
- **Wallet inexistente** → 404 `WALLET_NOT_FOUND`; nada é registrado e o reenvio depois da criação da wallet é
  processado normalmente (I-20).
- **Transação inexistente** nas consultas por id interno ou por (provedor, id externo) → 404
  `TRANSACTION_NOT_FOUND`, `retryable` false (I-55).
- **`kind` OPENING** na API → 400 `OPENING_NOT_ALLOWED`; **providerId "system"** → 400 (I-07, I-08).
- **BET com referência** → 400; **REFUND/ROLLBACK sem referência** → 400 (I-13).
- **Autorreferência** (`referenceExternalTransactionId` igual ao `externalTransactionId` da própria transação, com
  comparação exata e com caixa) em WIN, LOSS, REFUND ou ROLLBACK → 400 `VALIDATION_ERROR`, validada na borda antes
  da idempotência; nada é registrado. Vale também para a mensagem da fila (I-60).
- **Referência rejeitada** (REJECTED ou FAILED) → REJECTED `REFERENCE_REJECTED`; **referência pendente**
  (PENDING ou PENDING_REFERENCE) → PENDING_REFERENCE, desde que as checagens de consistência anteriores passem
  (I-15, I-44).
- **Referência existente porém pendente e inconsistente** (ex.: rodada diferente, ou REFUND com valor
  diferente) → rejeitada na hora com o código da consistência (`REFERENCE_MISMATCH`, `INVALID_REFERENCE_KIND` ou
  `AMOUNT_MISMATCH`), sem passar por PENDING_REFERENCE (I-44).
- **Referência de outro provedor** com o mesmo id externo: não é encontrada, pois a resolução é por
  (providerId, id externo) → PENDING_REFERENCE (I-14, I-15).
- **ROLLBACK de LOSS** ou de ROLLBACK → REJECTED `INVALID_REFERENCE_KIND` (I-14). **ROLLBACK de OPENING**: a
  regra existe no domínio, mas só é alcançável por ele; via HTTP vira PENDING_REFERENCE, porque a referência é
  resolvida pelo providerId da requisição e a abertura pertence ao provedor reservado "system", que nunca é
  aceito na entrada (I-07, I-14).
- **Valor de reversão diferente do original** → REJECTED `AMOUNT_MISMATCH` (I-17).
- **Segunda reversão da mesma referência**, por qualquer tipo → REJECTED `ALREADY_REVERSED` (I-16).
- **ROLLBACK de um REFUND** é permitido (o REFUND é outra transação) e debita o valor (I-12).
- **Chave de idempotência ausente ou vazia** → 400 `IDEMPOTENCY_KEY_REQUIRED`; **chave com mais de 255
  caracteres** → 400 `VALIDATION_ERROR` (I-23, I-48).
- **Mesmo (provedor, id externo) com chave diferente** → 409 `IDEMPOTENCY_CONFLICT` (I-24).
- **Mesma `Idempotency-Key` usada por dois provedores**, com ids externos diferentes → as duas transações são
  processadas de forma independente, sem conflito (I-56).
- **Mesma chave, payload diferente**, inclusive chegando em paralelo com o original → 409 para quem não venceu,
  sem replay (I-24, I-27).
- **Cursor inválido ou adulterado** no ledger, ou `limit` fora de 1 a 200 → 400 `VALIDATION_ERROR` (I-36, I-47).
- **Ids malformados**: walletId ou transactionId que não são UUID, no corpo ou na rota → 400 `VALIDATION_ERROR`;
  playerId e demais identificadores textuais vazios ou com mais de 255 caracteres → 400 `VALIDATION_ERROR`
  (I-50).
- **Indisponibilidade do armazenamento** no meio da operação → 503 sem efeito parcial (I-34).
- **`X-Correlation-Id` ausente, vazio, com mais de 128 caracteres ou com caracteres fora de `[A-Za-z0-9._:-]`**
  → a operação segue normalmente com um `correlationId` gerado pelo serviço; nunca 400 (I-53).
- **Wallet muito disputada**: a requisição que não consegue acesso à wallet dentro do limite de espera (padrão
  5 s) → 503 `SERVICE_UNAVAILABLE` com Retry-After, sem efeito; o reenvio é seguro (I-51).
- **Erro inesperado** durante o processamento → 500 `INTERNAL_ERROR`, `retryable` true, sem efeito persistido
  (I-39, I-49).
- **Rota ou método inexistente** → 404 `ROUTE_NOT_FOUND`, `retryable` false, no formato único de erro; **JSON
  malformado, `Content-Type` não suportado ou corpo acima do limite** → 400 `VALIDATION_ERROR` (I-59).

## Requirements *(mandatory)*

### Functional Requirements

#### Dinheiro

- **FR-001**: O sistema DEVE aceitar valores monetários apenas como string decimal no formato
  `^(0|[1-9]\d*)(\.\d{1,2})?$`, normalizando para exatamente 2 casas, e DEVE rejeitar como payload inválido
  número JSON, mais de 2 casas, sinal, espaços, notação científica, NaN, Infinity e string vazia (I-01).
- **FR-002**: Valores de BET, WIN, REFUND e ROLLBACK DEVEM ser maiores que zero (zero → 400 `VALIDATION_ERROR`);
  LOSS PODE ter valor "0.00", pois não move saldo nem gera lançamento; o saldo inicial de wallet PODE ser "0.00";
  nenhum valor PODE exceder 9999999999999999.99 (I-02, I-03).
- **FR-003**: Todo valor monetário DEVE ser respondido como `{ "amount": "<string com 2 casas>", "currency":
  "<ISO-4217>" }` e NUNCA perder precisão em nenhuma etapa, da entrada ao armazenamento e de volta (I-01, I-04).
- **FR-004**: `currency` DEVE seguir `^[A-Z]{3}$`; o modelo DEVE ser multi-moeda, e qualquer operação entre moedas
  diferentes DEVE ser tratada como erro de domínio (I-05).

#### Wallet e abertura

- **FR-005**: O provedor DEVE poder criar uma wallet informando `playerId` e `initialBalance`; a wallet nasce
  com `version` 1 (I-06).
- **FR-006**: Saldo inicial maior que zero DEVE gerar, na mesma unidade atômica da criação, uma transação interna
  de abertura PROCESSED e um lançamento CREDIT com saldo antes "0.00"; a abertura NÃO incrementa a `version`.
  Saldo inicial "0.00" NÃO gera abertura nem lançamento (I-06).
- **FR-007**: A transação de abertura DEVE ter identidade reservada: providerId "system", id externo
  `opening:{walletId}`, chave `system:opening:{walletId}`, rodada "opening" e jogo "system" (I-07).
- **FR-008**: DEVE existir no máximo uma wallet por (playerId, currency), garantido pelo armazenamento mesmo sob
  criação simultânea em várias instâncias; a tentativa duplicada DEVE responder 409 `WALLET_ALREADY_EXISTS` com
  `error.details.walletId` da wallet existente, e somente esse dado dela. A duplicata NÃO é replay: não produz
  efeito nem registra evento. Em criações simultâneas, todas as perdedoras DEVEM receber o id da wallet vencedora,
  já confirmada (I-10, I-52).
- **FR-009**: A `version` da wallet DEVE incrementar em exatamente 1 a cada alteração de saldo e somente nesse
  caso (enunciado §6.2; I-06).

#### Submissão de transação

- **FR-010**: O provedor DEVE submeter BET, WIN, LOSS, REFUND e ROLLBACK com providerId, externalTransactionId,
  playerId, walletId, roundId, gameId, kind, money e, quando aplicável, referenceExternalTransactionId
  (enunciado §9).
- **FR-011**: `kind` OPENING DEVE ser rejeitado com 400 `OPENING_NOT_ALLOWED`, e providerId "system" DEVE ser
  rejeitado como payload inválido em qualquer entrada externa (I-07, I-08).
- **FR-012**: BET com referência DEVE ser payload inválido; REFUND e ROLLBACK sem referência DEVEM ser payload
  inválido; WIN e LOSS PODEM ter referência, que só pode apontar para BET (I-13, I-46).
- **FR-013**: Wallet inexistente DEVE responder 404 `WALLET_NOT_FOUND` sem registrar a transação (I-20).
- **FR-014**: playerId diferente do dono da wallet DEVE resultar em REJECTED `WALLET_PLAYER_MISMATCH`, e moeda
  diferente da wallet em REJECTED `CURRENCY_MISMATCH` (I-19).
- **FR-015**: As regras DEVEM ser avaliadas nesta ordem, e a primeira regra violada define a resposta (I-44):
  1. header `Idempotency-Key` (I-23, I-48);
  2. validação do payload: formatos, kind, OPENING, providerId "system" e regras de referência por kind (I-13);
  3. idempotência: replay ou conflito (I-24, I-26);
  4. existência da wallet: 404 (I-20);
  5. regras de negócio:
     1. `WALLET_PLAYER_MISMATCH`, `CURRENCY_MISMATCH`;
     2. se a transação tem referência e ela existe, em qualquer estado: `REFERENCE_MISMATCH`,
        `INVALID_REFERENCE_KIND` e `AMOUNT_MISMATCH` (este só para REFUND e ROLLBACK);
     3. estado da referência: REJECTED ou FAILED → `REFERENCE_REJECTED`; ausente, PENDING ou PENDING_REFERENCE →
        PENDING_REFERENCE;
     4. `ALREADY_REVERSED` (só REFUND e ROLLBACK);
     5. saldo: `INSUFFICIENT_FUNDS` (BET) ou `REVERSAL_WOULD_OVERDRAW` (reversão que debita); em créditos,
        `BALANCE_LIMIT_EXCEEDED` (I-54).

#### Regras por tipo

- **FR-016**: BET DEVE debitar o valor e gerar um lançamento DEBIT; sem saldo suficiente DEVE ser REJECTED
  `INSUFFICIENT_FUNDS` (I-12, I-18).
- **FR-017**: WIN DEVE creditar o valor e gerar um lançamento CREDIT (I-12).
- **FR-018**: LOSS DEVE ser registrada como PROCESSED sem movimentar saldo, sem lançamento e sem alterar a
  `version` (I-12).
- **FR-019**: REFUND DEVE referenciar uma BET PROCESSED e creditar o mesmo valor (I-12, I-14).
- **FR-020**: ROLLBACK DEVE referenciar BET, WIN ou REFUND PROCESSED e aplicar o inverso: BET → crédito, WIN →
  débito, REFUND → débito (I-12, I-14).
- **FR-021**: A referência DEVE ser resolvida por (providerId da requisição, referenceExternalTransactionId).
  Quando existe, em qualquer estado, DEVE ter o mesmo jogador, wallet, moeda e rodada; senão REJECTED
  `REFERENCE_MISMATCH` (FR-015, passo 5.2; I-14).
- **FR-022**: Tipo de referência não permitido DEVE resultar em REJECTED `INVALID_REFERENCE_KIND` (REFUND de
  não-BET; ROLLBACK de LOSS, ROLLBACK ou OPENING; WIN ou LOSS de não-BET) (FR-015, passo 5.2; I-14, I-46).
- **FR-023**: Conforme o estado da referência: ausente, PENDING ou PENDING_REFERENCE → a transação fica
  PENDING_REFERENCE; REJECTED ou FAILED → REJECTED `REFERENCE_REJECTED`; PROCESSED → seguem as regras dos
  passos seguintes (FR-015, passo 5.3; I-15).
- **FR-024**: O valor de REFUND e ROLLBACK DEVE ser igual ao da referência; senão REJECTED `AMOUNT_MISMATCH`
  (FR-015, passo 5.2; I-17).
- **FR-025**: Cada transação DEVE poder ser revertida no máximo uma vez no total, contando REFUND e ROLLBACK
  juntos, garantido pelo armazenamento mesmo sob concorrência; a tentativa seguinte DEVE ser REJECTED
  `ALREADY_REVERSED` (FR-015, passo 5.4; I-16).
- **FR-026**: Reversão que deixaria o saldo negativo DEVE ser REJECTED `REVERSAL_WOULD_OVERDRAW`, código distinto
  de `INSUFFICIENT_FUNDS`, e permanecer auditável (I-18).
- **FR-061**: Crédito (WIN, REFUND ou ROLLBACK de BET) cujo saldo resultante excederia 9999999999999999.99 DEVE
  ser REJECTED `BALANCE_LIMIT_EXCEEDED` (`retryable` false), avaliado no último passo da ordem do FR-015 (I-54).
- **FR-027**: Transação REJECTED DEVE ser registrada com seu `failureCode`, sem alterar saldo nem `version` e sem
  gerar lançamento (I-19).
- **FR-028**: As transições de estado DEVEM seguir exclusivamente: PENDING → PROCESSED | REJECTED |
  PENDING_REFERENCE | FAILED; PENDING_REFERENCE → PROCESSED | REJECTED | FAILED. PROCESSED, REJECTED e FAILED
  NUNCA mudam (I-11).
- **FR-029**: Uma transação de saldo DEVE produzir no máximo um lançamento por wallet, e todo lançamento DEVE
  satisfazer saldo antes ± valor = saldo depois, com saldo depois ≥ 0 (enunciado §6.4; I-36).

#### Idempotência

- **FR-030**: A submissão de transação DEVE exigir o header `Idempotency-Key` com 1 a 255 caracteres; ausente ou
  vazio → 400 `IDEMPOTENCY_KEY_REQUIRED`; mais de 255 caracteres → 400 `VALIDATION_ERROR`. O default recomendado
  ao provedor é `{providerId}:{externalTransactionId}` (I-23, I-48).
- **FR-031**: O sistema DEVE calcular um hash de payload sobre o JSON canônico dos campos de negócio definidos em
  I-25, excluindo header, chave de idempotência e metadados de transporte (I-25).
- **FR-032**: Os pares (providerId, chave de idempotência) e (providerId, externalTransactionId) DEVEM ser únicos,
  garantidos pelo armazenamento. A idempotência é escopada por provedor: a mesma chave usada por provedores
  diferentes não conflita (I-24, I-56).
- **FR-033**: Requisição com chave já registrada para o mesmo provedor e mesmo hash DEVE devolver o resultado original: mesmo
  `transactionId`, `status`, `failureCode` e saldo observado, com `idempotentReplay` true e o mesmo status HTTP
  do original, exceto 201, que vira 200 no replay (I-26, I-39).
- **FR-034**: Chave já registrada para o mesmo provedor com hash diferente, ou (providerId, externalTransactionId)
  já registrado com outra chave, DEVE responder 409 `IDEMPOTENCY_CONFLICT`, nunca replay e sem efeito (I-24, I-56).
- **FR-035**: Requisições concorrentes com a mesma chave do mesmo provedor DEVEM convergir: exatamente uma produz o efeito, e as
  demais aguardam o resultado dela e o devolvem como replay (mesmo hash) ou conflito (hash diferente) (I-27).
- **FR-036**: Todo resultado registrado (PROCESSED, REJECTED, PENDING_REFERENCE) DEVE guardar o saldo observado
  no momento do processamento (I-26).
- **FR-037**: A deduplicação DEVE depender apenas do armazenamento compartilhado, nunca de memória local de uma
  instância (constitution IV).

#### Concorrência e atomicidade

- **FR-038**: Operações sobre a mesma wallet DEVEM ser serializadas por wallet, sem lost update, de forma correta
  com 3 ou mais instâncias simultâneas; operações em wallets distintas NÃO PODEM se bloquear mutuamente
  (enunciado §8; constitution III).
- **FR-039**: O saldo NUNCA PODE ficar negativo, imposto também pelo armazenamento (constitution II, V).
- **FR-040**: A transação, a alteração de saldo e `version`, o lançamento e o registro dos eventos de integração
  DEVEM ser confirmados juntos ou nenhum deles (enunciado §6.5, §11).
- **FR-041**: O ledger DEVE ser imutável: lançamentos NUNCA são alterados nem excluídos, e o armazenamento DEVE
  recusar tentativas de alteração ou exclusão (I-36).
- **FR-042**: Para toda wallet, o saldo armazenado DEVE ser igual ao saldo reconstruído pela soma do ledger
  (créditos − débitos) a qualquer momento observável (constitution II).
- **FR-043**: Indisponibilidade temporária do armazenamento DEVE responder 503 `SERVICE_UNAVAILABLE` com
  `retryable` true e Retry-After, sem efeito parcial (I-34, I-39).
- **FR-044**: Erro inesperado DEVE responder 500 `INTERNAL_ERROR` com `retryable` true, desfazendo todo efeito da
  requisição, sem gravar FAILED (I-39, I-49).
- **FR-059**: A espera por acesso a uma wallet ocupada DEVE ser limitada por um valor configurável
  (`WALLET_LOCK_TIMEOUT_MS`, padrão 5000 ms). Ao estourar, a requisição DEVE ser desfeita sem efeito e responder
  503 `SERVICE_UNAVAILABLE` com `retryable` true e Retry-After. Os limites de espera por conexão ao armazenamento e
  de duração da requisição HTTP DEVEM ser maiores que esse valor, para que o provedor sempre receba o 503
  padronizado e nunca um corte de conexão (I-51).

#### Eventos de integração (registro, sem publicação)

- **FR-045**: Na mesma unidade atômica do resultado, o sistema DEVE registrar para publicação futura:
  WagerTransactionProcessed para toda transação aplicada, inclusive LOSS; WalletBalanceChanged somente quando o
  saldo muda; WagerTransactionRejected para toda rejeição de negócio; WagerTransactionPendingReference ao entrar
  em PENDING_REFERENCE (I-33).
- **FR-046**: A abertura DEVE registrar WalletBalanceChanged e NÃO DEVE registrar WagerTransactionProcessed; wallet
  criada com saldo "0.00" não registra evento (I-06, I-09).
- **FR-047**: Cada evento DEVE ter identificador único, `aggregateId` igual ao walletId, `correlationId`, data de
  ocorrência, tipo e versão, e valores monetários como string decimal. Replays e respostas 400, 404, 409, 500 e
  503 NÃO registram eventos (I-33; enunciado §11).
- **FR-048**: Esta feature NÃO publica eventos; eles permanecem registrados como pendentes de publicação.

#### Consultas

- **FR-049**: O operador DEVE consultar uma wallet por id, obtendo `id`, `playerId`, `balance` e `version`.
- **FR-050**: O operador DEVE paginar o ledger de uma wallet com cursor opaco e estável, em ordem crescente de
  registro, `limit` padrão 50 e máximo 200; cada lançamento mostra id, transação, direção, valor, saldo antes,
  saldo depois e data (I-36).
- **FR-051**: Cursor inválido ou adulterado, ou `limit` fora de 1 a 200, DEVE responder 400 `VALIDATION_ERROR`
  (I-47).
- **FR-052**: O operador DEVE consultar uma transação pelo id interno e pelo par (providerId, externalTransactionId),
  obtendo tipo, valor, status, `failureCode`, referência externa e interna quando houver, saldo observado e
  datas.
- **FR-053**: Wallet inexistente DEVE responder 404 `WALLET_NOT_FOUND` e transação inexistente DEVE responder 404
  `TRANSACTION_NOT_FOUND`, ambos com `retryable` false, no formato único de erro (I-20, I-55).

#### Contrato de resposta

- **FR-054**: A resposta de submissão DEVE conter `transactionId`, `status`, `balance` (saldo observado) e
  `idempotentReplay`; quando REJECTED, também `failureCode` e `retryable` (enunciado §9; I-45).
- **FR-055**: Os status HTTP DEVEM ser: 201 processada (200 no replay); 202 PENDING_REFERENCE; 400 payload
  inválido, inclusive JSON malformado, `Content-Type` não suportado e corpo acima do limite (I-59); 404 não
  encontrado, inclusive rota ou método inexistente (`ROUTE_NOT_FOUND`, I-59); 409 conflito de idempotência ou wallet duplicada; 422 rejeição de negócio; 503
  falha transitória com Retry-After; 500 erro inesperado. O mapeamento DEVE ser o mesmo em todos os endpoints
  (I-39).
- **FR-056**: Respostas 400, 404, 409, 500 e 503 DEVEM usar o formato único
  `{ error: { code, message, retryable, correlationId, details? } }` (I-38, I-45).
- **FR-057**: Todo `failureCode` e todo `error.code` DEVEM pertencer à taxonomia de `docs/interpretacoes.md` §7,
  com o `retryable` ali definido.
- **FR-058**: Mensagens de erro NÃO DEVEM ecoar o payload financeiro completo.
- **FR-060**: Toda requisição, em qualquer endpoint, DEVE ter um `correlationId`: o valor do header
  `X-Correlation-Id` quando ele tem de 1 a 128 caracteres em `[A-Za-z0-9._:-]`; caso contrário, um UUIDv7 gerado
  pelo serviço. Header ausente ou inválido NUNCA DEVE causar 400. O mesmo valor DEVE aparecer no header
  `X-Correlation-Id` da resposta, em `error.correlationId` quando houver erro, nos logs da requisição e nos eventos
  que ela registrar. A transação DEVE guardar o `correlationId` com que foi processada; o replay responde com o
  `correlationId` da requisição atual, sem alterar o da transação original e sem registrar eventos (I-53).

### Key Entities *(include if feature involves data)*

- **Valor monetário (Money)**: quantia exata com 2 casas mais moeda ISO-4217; imutável; operações só entre a
  mesma moeda.
- **Wallet**: saldo de um jogador em uma moeda; atributos: id, jogador, moeda, saldo, `version`, datas de criação
  e atualização. Única por (jogador, moeda). Saldo nunca negativo.
- **Transação de aposta (WagerTransaction)**: operação submetida pelo provedor ou abertura interna; atributos:
  id interno, provedor, id externo, chave de idempotência, hash de payload, wallet, jogador, rodada, jogo, tipo,
  valor, referência externa e referência interna resolvida, status, `failureCode`, saldo observado,
  `correlationId` com que foi processada, datas. Única
  por (provedor, chave) e por (provedor, id externo). Revertida no máximo uma vez.
- **Lançamento de ledger (WalletLedgerEntry)**: registro imutável de um movimento de saldo; atributos: id,
  wallet, transação, direção (DEBIT/CREDIT), valor, saldo antes, saldo depois, data, posição sequencial para
  paginação. No máximo um por (wallet, transação).
- **Evento de integração registrado**: fato de negócio pendente de publicação (WagerTransactionProcessed,
  WagerTransactionRejected, WalletBalanceChanged, WagerTransactionPendingReference), com id, wallet como agregado,
  correlação, tipo, versão, data e dados.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: No cenário de saldo 100.00 com duas BETs de 80.00 simultâneas, repetido ao menos 20 vezes, 100%
  das execuções terminam com exatamente uma PROCESSED, uma REJECTED `INSUFFICIENT_FUNDS`, saldo 20.00 e um único
  lançamento de débito dessas apostas.
- **SC-002**: A mesma BET enviada 50 vezes em paralelo produz exatamente 1 débito, e 50 de 50 respostas
  referenciam o mesmo `transactionId` (1 original, 49 replays), sem nenhuma resposta 409, 500 ou 503.
- **SC-003**: REFUND e ROLLBACK simultâneos sobre a mesma BET, repetidos ao menos 20 vezes, nunca aplicam mais de
  uma reversão.
- **SC-004**: Com 20 wallets distintas recebendo operações em paralelo, todas terminam com o resultado esperado; e
  uma operação em uma wallet conclui normalmente enquanto outra wallet está sob disputa contínua.
- **SC-005**: Os critérios SC-001 a SC-004 continuam válidos com 3 ou mais instâncias do serviço atendendo
  simultaneamente.
- **SC-006**: Ao final de 100% dos cenários de teste, para 100% das wallets, o saldo armazenado é igual ao saldo
  reconstruído pelo ledger, e nenhuma wallet tem saldo negativo.
- **SC-007**: Nenhum cenário de falha (indisponibilidade do armazenamento, erro inesperado, requisições
  concorrentes) deixa transação, lançamento, saldo ou evento parcial; o reenvio após a recuperação gera
  exatamente um efeito.
- **SC-008**: 100% das tentativas de alterar ou excluir um lançamento do ledger são recusadas pelo armazenamento.
- **SC-009**: Para 100% das respostas que não são sucesso, o provedor decide entre reenviar, corrigir o payload ou
  desistir usando apenas status, código e `retryable`, sem ler a mensagem de texto; as cinco situações nunca
  compartilham o mesmo status.
- **SC-010**: Paginar o ledger completo de uma wallet com o cursor retorna cada lançamento exatamente uma vez e em
  ordem, inclusive com novos lançamentos sendo criados durante a paginação.
- **SC-011**: Em ambiente local sem disputa, operações individuais de criação, submissão e consulta respondem em
  menos de 1 segundo.

## Assumptions

- Autenticação fora do foco: os endpoints usam um guard no-op e a identidade do provedor vem do payload, sujeita
  às validações de domínio (I-41; constitution VI).
- Testes de fluxo usam BRL; o conflito de moeda é testado com BRL vs USD (I-05).
- O operador usa os mesmos endpoints de consulta que o provedor; não há perfil de acesso distinto nesta feature.
- A transação de abertura é consultável pelo id interno, aparece no ledger e não pode ser submetida nem
  referenciada por provedores (a resolução por providerId nunca a encontra, porque "system" é rejeitado na
  entrada).
- Replay de uma transação PENDING_REFERENCE devolve o aceite pendente original; como mudar de estado depois
  depende do worker (fora de escopo), o comportamento do replay após a resolução será definido na feature do
  worker.
- Ids internos são gerados pelo serviço (UUIDv7, I-35); o provedor só fornece os próprios ids externos.

### Fora de escopo (outras features)

- Consumo de SQS, inbox e DLQ (I-28, I-30) e o status FAILED gravado pela fila (I-22).
- Publicação da outbox (I-31, I-32).
- Worker de reprocessamento de PENDING_REFERENCE, esgotamento por limite/TTL (`REFERENCE_NOT_FOUND`) e a
  otimização de reprocessar pendentes ao processar a referência (I-21).
- Endpoint de reconciliação (I-37), health checks e métricas (I-34).
- Testes de carga e de caos (I-42) e UI.

### Dependências

- Ambiente local com armazenamento real em container para os testes de integração e de concorrência
  (constitution VII), e capacidade de executar 3 ou mais instâncias simultâneas do serviço.
- Taxonomia de códigos em `docs/interpretacoes.md` §7 como fonte única dos `failureCode` e `retryable`.
