# Feature Specification: Reconciliação, Health Checks e Métricas

**Feature Branch**: `003-reconciliation-health-metrics` (id da feature; o trabalho segue na branch `main` do
repositório, por decisão do usuário)

**Created**: 2026-11-09

**Status**: Draft

**Input**: User description: "Expor a verificação de consistência financeira, os health checks e as métricas do
serviço." (descrição completa, com problema, usuários, funcionalidades, critérios de aceitação e fora de escopo,
fornecida em `/speckit-specify`)

**Fontes normativas**: `docs/enunciado.md` (seções 9, 12 e 13), `docs/interpretacoes.md` (ids I-xx citados nos
requisitos, em especial I-34, I-37, I-38, I-53 e I-74 a I-76) e `.specify/memory/constitution.md` v1.0.1 (Princípio
VIII). Em caso de conflito, prevalece a ordem do Princípio I da constitution.

**Depende de**: `001-wagering-transaction-core` (wallets, ledger encadeado, envelope único de erro, correlationId) e
`002-messaging-reliability` (filas, término gracioso, contadores registrados pela porta de métricas), ambas
implementadas. Os requisitos delas são citados como `001/FR-xxx` e `002/FR-xxx`.

## Problema

Sem esta feature, uma divergência entre o saldo armazenado e o ledger, uma dependência fora do ar ou um acúmulo de
eventos na outbox só aparecem quando alguém reclama. As invariantes financeiras são garantidas pelo armazenamento
(001), mas ninguém consegue **verificar** uma wallet sob demanda; o orquestrador de containers não sabe se uma
instância pode receber tráfego; e os contadores que a 002 já registra não são visíveis de fora do processo.

## User Scenarios & Testing *(mandatory)*

Atores:

- **Operador**: verifica, sob demanda, se o saldo de uma wallet bate com o ledger e se a cadeia de lançamentos está
  íntegra. Precisa de uma resposta objetiva e de um sinal claro quando algo diverge, sem nenhuma correção automática.
- **Orquestrador de containers**: decide se reinicia uma instância (viva ou não) e se manda tráfego para ela (pronta ou
  não), consultando endpoints separados, sem credenciais.
- **Sistema de monitoramento**: coleta periodicamente as métricas do serviço, em formato de texto padrão de mercado,
  sem credenciais.

### User Story 1 - Reconciliar uma wallet (Priority: P1)

O operador pede a reconciliação de uma wallet e recebe, numa única leitura consistente, o saldo armazenado, o saldo
recalculado a partir do ledger, a diferença entre os dois, quantos lançamentos foram verificados e se a cadeia de
lançamentos está íntegra. Quando algo diverge, a resposta diz que a wallet está inconsistente, a divergência é
registrada em log e contada em métrica, e nada é corrigido.

**Why this priority**: a correção financeira é o principal critério de avaliação (constitution II); a reconciliação é a
forma de o operador comprovar, sob demanda, a invariante `wallet.balance == saldo reconstruído pelo ledger` (enunciado
§13) e de detectar qualquer violação que escape das garantias do armazenamento.

**Independent Test**: criar wallets, movimentá-las (BET, WIN, LOSS, REFUND, ROLLBACK) e reconciliar: todas
consistentes. Num ambiente de teste sem as guardas do armazenamento, alterar o saldo de uma wallet por fora e
reconciliar: inconsistente, com log e contador, e o saldo continua alterado (nada foi corrigido).

**Acceptance Scenarios**:

1. **Given** uma wallet com movimentações processadas, **When** o operador a reconcilia, **Then** a resposta é 200 com
   `consistent` true, `chainConsistent` true, `difference` 0.00, `storedBalance` igual a `calculatedBalance` e
   `checkedEntries` igual ao número de lançamentos da wallet, sem `firstBrokenSeq` (I-74).
2. **Given** uma wallet criada com saldo zero e sem lançamentos, **When** reconciliada, **Then** `calculatedBalance` é
   0.00, `checkedEntries` é 0 e `consistent` é true.
3. **Given** uma wallet cujo saldo armazenado foi alterado sem lançamento correspondente (divergência provocada num
   ambiente de teste sem as guardas do armazenamento), **When** reconciliada, **Then** a resposta é 200 com
   `consistent` false e `difference` com o sinal de stored − calculated; uma linha de log de erro é registrada e o
   contador de divergências aumenta em 1; o saldo armazenado e o ledger continuam exatamente como estavam.
4. **Given** uma wallet cuja cadeia de lançamentos está quebrada (o saldo antes de um lançamento não é o saldo depois
   do anterior) mesmo com a soma correta, **When** reconciliada, **Then** `chainConsistent` é false, `firstBrokenSeq`
   indica o primeiro lançamento da quebra e `consistent` é false.
5. **Given** escritas concorrentes na wallet (50 BETs entrando em paralelo), **When** o operador reconcilia em laço
   durante as escritas, **Then** toda leitura retorna `consistent` true: nunca há falso positivo de divergência.
6. **Given** um `walletId` inexistente, **When** reconciliado, **Then** a resposta é 404 `WALLET_NOT_FOUND` no envelope
   único de erro; **Given** um `walletId` malformado, **Then** 400 `VALIDATION_ERROR`.
7. **Given** uma reconciliação, **When** ela termina (consistente ou não), **Then** nenhum dado foi alterado: saldo,
   `version`, ledger, transações e outbox iguais aos de antes.

---

### User Story 2 - Saber se a instância está viva e pronta (Priority: P2)

O orquestrador consulta dois endpoints separados: um responde se o processo está vivo; o outro, se a instância está
pronta para receber tráfego, isto é, se o banco e a fila respondem e se ela não está encerrando.

**Why this priority**: sem readiness, o orquestrador manda tráfego para uma instância que não alcança o banco ou que
está saindo; sem liveness separado, uma dependência fora do ar faria o orquestrador reiniciar instâncias saudáveis em
série. É exigência do enunciado §9 e §12 e da constitution VIII, mas não altera o resultado financeiro.

**Independent Test**: com tudo no ar, live e ready respondem 200; cortar o banco (proxy) e conferir ready 503 e live
200; cortar a fila e conferir ready 503 com as submissões HTTP funcionando; enviar o sinal de término e conferir ready
503 durante o encerramento.

**Acceptance Scenarios**:

1. **Given** uma instância no ar com banco e fila alcançáveis, **When** o orquestrador consulta live e ready, **Then**
   ambos respondem 200; ready traz o estado de cada dependência como disponível (I-75).
2. **Given** o banco indisponível, **When** consultados, **Then** ready responde 503 indicando o banco indisponível e
   live continua respondendo 200, dentro do prazo de checagem.
3. **Given** a fila indisponível, **When** consultados, **Then** ready responde 503 indicando a fila indisponível, live
   responde 200, e as submissões de transação por HTTP continuam sendo processadas normalmente (I-34, 002/FR-033).
4. **Given** uma instância que recebeu o sinal de término e está concluindo o trabalho em andamento, **When** ready é
   consultado durante o encerramento, **Then** responde 503, mesmo com banco e fila disponíveis.
5. **Given** qualquer estado, **When** os endpoints de health são chamados sem credenciais, **Then** respondem
   normalmente (nenhuma autenticação exigida).
6. **Given** uma dependência que não responde (conexão pendurada), **When** ready é consultado, **Then** a checagem
   desiste no prazo configurado e ready responde 503, sem ficar pendurado.

---

### User Story 3 - Ler as métricas do serviço (Priority: P3)

O sistema de monitoramento lê, num endpoint de texto em formato padrão de coleta, os contadores, medidores e
histogramas do serviço: transações por status, duplicatas, retries, mensagens na DLQ, conflitos de lock, latência de
processamento, divergências de reconciliação e o atraso da outbox.

**Why this priority**: os contadores já existem desde a 002 (002/FR-036), mas só dentro do processo; expô-los fecha o
requisito de observabilidade (enunciado §12, constitution VIII), sem efeito sobre o resultado financeiro.

**Independent Test**: executar operações reais (transações aceitas e rejeitadas, replay, duplicata, divergência
provocada, eventos pendentes) e ler o endpoint: cada contador reflete as operações, o atraso da outbox reflete os
eventos pendentes e nenhum rótulo carrega identificador ou valor monetário.

**Acceptance Scenarios**:

1. **Given** transações processadas, rejeitadas e pendentes, **When** o monitoramento lê as métricas, **Then** o
   contador de transações por status reflete as que foram confirmadas (contadas só depois do commit, N-45 da 002).
2. **Given** um replay pela idempotência, uma mensagem duplicada, um retry, uma mensagem na DLQ e um conflito de lock,
   **When** lidas as métricas, **Then** cada contador correspondente aparece com o rótulo de origem ou classe.
3. **Given** uma divergência detectada pela reconciliação, **When** lidas as métricas, **Then** o contador de
   divergências de reconciliação aumentou em 1.
4. **Given** eventos pendentes na outbox, **When** lidas as métricas, **Then** os medidores mostram a quantidade de
   pendentes e a idade do pendente mais antigo, calculados no momento da leitura; sem pendentes, ambos são zero.
5. **Given** qualquer leitura, **When** inspecionados os rótulos, **Then** nenhum contém `walletId`, `providerId`,
   identificadores de transação ou de mensagem, nem valores monetários.
6. **Given** o endpoint de métricas, **When** chamado sem credenciais, **Then** responde normalmente.

---

### Edge Cases

- **Wallet sem lançamentos**: `calculatedBalance` 0.00, `checkedEntries` 0, cadeia íntegra por vacuidade; consistente
  se e somente se o saldo armazenado for 0.00.
- **Diferença negativa**: saldo armazenado menor que o recalculado → `difference` negativa, com sinal, no formato
  monetário da 001 (001/FR-003).
- **Soma correta e cadeia quebrada**: dois desvios que se anulam na soma ainda são detectados pela cadeia
  (`chainConsistent` false, `firstBrokenSeq`).
- **Primeiro lançamento com saldo anterior diferente de zero**: quebra da cadeia no primeiro lançamento.
- **Último saldo depois do lançamento diferente do saldo armazenado**: quebra da cadeia (reportada mesmo que a soma
  também divirja).
- **Reconciliação com o banco indisponível**: 503 `SERVICE_UNAVAILABLE` com `Retry-After`, como qualquer operação
  (001/FR-043); nada é logado como divergência nem contado.
- **Reconciliação concorrente com escritas**: a leitura é de um único instante; uma escrita concorrente aparece inteira
  ou não aparece, nunca pela metade.
- **Corpo enviado na reconciliação**: ignorado; a operação não recebe parâmetros além do `walletId`.
- **Reconciliações repetidas de uma wallet divergente**: cada uma registra o log e soma 1 ao contador (a métrica conta
  detecções, não wallets distintas).
- **Fila sem as filas criadas** (provisionamento não executado): a checagem da fila falha e ready responde 503.
- **Dependência pendurada**: a checagem tem prazo próprio; ready nunca fica preso esperando.
- **Instância recém-iniciada**: live e ready só respondem depois que o servidor começa a aceitar conexões.
- **Reinício da instância**: os contadores voltam a zero (são por instância, desde o início do processo); os
  medidores da outbox não dependem disso, pois são lidos do banco a cada coleta.
- **Banco indisponível durante a coleta de métricas**: o endpoint continua respondendo com as métricas em memória e
  omite os medidores da outbox, que dependem do banco.
- **Rótulos com alta cardinalidade**: proibidos por requisito; nenhum dado de entrada do cliente vira rótulo.

## Requirements *(mandatory)*

### Functional Requirements

#### Reconciliação

- **FR-001**: O operador DEVE poder reconciliar uma wallet por `POST /wallets/:walletId/reconciliation`, sem corpo; um
  corpo enviado é ignorado (I-74, enunciado §9).
- **FR-002**: A reconciliação DEVE ser somente leitura e ler o saldo armazenado e o ledger num único instante
  consistente do armazenamento, de forma que uma escrita concorrente apareça inteira ou não apareça (I-37, I-74). Ela
  NUNCA altera saldo, `version`, ledger, transações, inbox ou outbox, e NUNCA corrige uma divergência (enunciado §9).
- **FR-003**: A resposta DEVE ser 200 com `walletId`, `storedBalance`, `calculatedBalance`, `difference`, `consistent`,
  `checkedEntries` e `chainConsistent`, e com `firstBrokenSeq` somente quando a cadeia estiver quebrada (I-74). Os
  valores monetários seguem o formato da 001 (string com 2 casas e moeda da wallet, 001/FR-003); nenhum valor monetário
  passa por representação binária de ponto flutuante (constitution II).
- **FR-004**: `calculatedBalance` DEVE ser a soma dos créditos menos a soma dos débitos do ledger da wallet, 0.00 sem
  lançamentos; `checkedEntries` é a quantidade de lançamentos lidos (I-74, 001/FR-042).
- **FR-005**: `difference` DEVE ser `storedBalance − calculatedBalance`, com sinal (I-74).
- **FR-006**: A cadeia de lançamentos DEVE ser verificada em ordem de registro: o saldo anterior do primeiro lançamento
  é 0.00; o saldo anterior de cada lançamento é igual ao saldo posterior do anterior; o saldo posterior do último é
  igual ao saldo armazenado. `chainConsistent` é false na primeira violação, e `firstBrokenSeq` identifica o lançamento
  onde ela ocorre (I-37, I-74, 001/FR-029, 001/FR-041).
- **FR-007**: `consistent` DEVE ser true se e somente se `difference` for zero e `chainConsistent` for true (I-74).
- **FR-008**: Toda divergência detectada (`consistent` false) DEVE gerar uma linha de log em nível de erro com
  `walletId`, `correlationId`, `checkedEntries`, `firstBrokenSeq` (quando houver) e `consistent` false, sem valores
  monetários, e somar 1 ao contador `reconciliation_divergences_total`; a resposta continua 200 (I-37, I-74,
  enunciado §9, constitution VIII).
- **FR-009**: O cálculo da soma e da cadeia DEVE ser feito pelo armazenamento, sem trazer os lançamentos para a
  aplicação, para que o custo de memória não cresça com o tamanho do ledger (I-74).
- **FR-010**: A reconciliação NÃO DEVE travar a wallet nem esperar por escritas em andamento; escritas concorrentes
  seguem normalmente (constitution III).
- **FR-011**: Wallet inexistente DEVE responder 404 `WALLET_NOT_FOUND` e `walletId` malformado 400 `VALIDATION_ERROR`,
  no envelope único de erro (I-38, 001/FR-053, 001/FR-056, 001/FR-057); indisponibilidade temporária do armazenamento
  DEVE responder 503 `SERVICE_UNAVAILABLE` com `Retry-After` (001/FR-043).
- **FR-012**: A reconciliação DEVE carregar o `correlationId` da requisição no log e no header de resposta
  (001/FR-060, I-53).

#### Health checks

- **FR-013**: `GET /health/live` DEVE responder 200 `{"status":"ok"}` sempre que o processo responder, sem consultar
  dependências (I-75, enunciado §9).
- **FR-014**: `GET /health/ready` DEVE checar o banco (uma consulta trivial) e a fila (leitura de atributos das filas
  usadas pelo serviço), cada checagem com prazo de 2 s, e responder 200
  `{"status":"ok","checks":{"postgres":"up","sqs":"up"}}` quando todas passarem (I-75).
- **FR-015**: Se alguma checagem falhar ou esgotar o prazo, `GET /health/ready` DEVE responder 503
  `{"status":"unavailable","checks":{...}}` com o estado (`up` ou `down`) de cada dependência (I-75).
- **FR-016**: Desde o início do término gracioso (a instância parou de reservar trabalho novo e está drenando, 002/FR-014,
  002/FR-015) até a saída, `GET /health/ready` DEVE responder 503, mesmo com as dependências disponíveis (I-75).
- **FR-017**: Com a fila indisponível, ready responde 503 e as submissões de transação por HTTP DEVEM continuar sendo
  processadas e respondidas normalmente (I-34, 002/FR-033). Com o banco indisponível, live continua respondendo 200
  (I-34).
- **FR-018**: Os endpoints de health NÃO DEVEM exigir autenticação; usam corpo próprio, fora do envelope único de erro,
  e são registrados em log em nível debug (I-75, enunciado §9, constitution VIII).

#### Métricas

- **FR-019**: `GET /metrics` DEVE expor as métricas no formato de texto de exposição padrão do Prometheus, sem
  autenticação e sem dependência nova (I-76, enunciado §12).
- **FR-020**: As métricas expostas DEVEM incluir, no mínimo, tudo o que a 002 registra pela porta de métricas
  (002/FR-036): transações por status (contadas só depois do commit, N-45 da 002), duplicatas por origem, retries por
  trabalhador, mensagens enviadas à DLQ por código e classe, conflitos de lock e latência de processamento como
  histograma; mais o contador `reconciliation_divergences_total` (FR-008) (I-76, constitution VIII).
- **FR-021**: O atraso da outbox DEVE ser exposto como medidores calculados no momento da leitura: quantidade de eventos
  pendentes de publicação e idade, em segundos, do pendente mais antigo (zero sem pendentes), por uma consulta de
  baixo custo ao armazenamento (I-76).
- **FR-022**: Se o armazenamento não responder durante a leitura, `GET /metrics` DEVE responder com as métricas em
  memória e omitir os medidores da outbox, sem falhar a coleta inteira.
- **FR-023**: Os rótulos DEVEM ter baixa cardinalidade (status, outcome, source, kind e os já usados pela 002, como
  worker, errorCode e errorClass); NUNCA `walletId`, `providerId`, ids de transação, de mensagem ou de evento, nem
  valores monetários (I-76, 002/FR-037).
- **FR-024**: As métricas em memória DEVEM ser por instância, acumuladas desde o início do processo; o monitoramento
  agrega as instâncias (I-76).

### Key Entities *(include if feature involves data)*

- **Resultado de reconciliação**: snapshot calculado sob demanda de uma wallet (saldo armazenado, saldo recalculado,
  diferença, consistência, lançamentos verificados, integridade da cadeia e primeiro lançamento quebrado). Não é
  persistido; a divergência deixa rastro só no log e no contador.
- **Estado de prontidão**: por dependência (`postgres`, `sqs`), `up` ou `down`, mais o estado de encerramento da
  instância. Não é persistido.
- **Série de métrica**: nome, rótulos de baixa cardinalidade e valor (contador, medidor ou histograma), por instância.
- Entidades existentes usadas sem mudança: Wallet, WalletLedgerEntry (com a sequência de registro) e OutboxMessage
  (001, 002).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% das wallets movimentadas pelos fluxos da 001 e da 002 (todos os tipos de transação, pela API e pela
  fila) são reconciliadas como consistentes, com diferença 0.00.
- **SC-002**: 100% das divergências provocadas (saldo alterado e cadeia quebrada) são detectadas, cada uma com uma linha
  de log de erro e um incremento do contador, e nenhuma é corrigida.
- **SC-003**: Zero falsos positivos em reconciliações repetidas durante 50 apostas concorrentes na mesma wallet.
- **SC-004**: Com o banco ou a fila indisponível, ready passa a responder 503 em até 3 s por consulta (prazo de checagem
  mais margem), e live responde 200 em 100% das consultas.
- **SC-005**: Com a fila indisponível, 100% das submissões de transação por HTTP são respondidas como com a fila no ar.
- **SC-006**: Durante todo o término gracioso, 100% das consultas a ready respondem 503.
- **SC-007**: Depois de um conjunto conhecido de operações reais, cada contador exposto em `/metrics` bate com a
  quantidade de operações realizadas, e os medidores da outbox batem com os eventos pendentes no banco.
- **SC-008**: A reconciliação de uma wallet com 1 000 lançamentos responde em menos de 1 s sem disputa, sem trazer os
  lançamentos para a memória da aplicação.
- **SC-009**: Nenhum dos endpoints desta feature (reconciliação, health e métricas) exige autenticação, e nenhum rótulo
  de métrica nem linha de log desta feature contém valor monetário.

## Assumptions

- A autenticação está fora do foco (enunciado §2); estes endpoints são operacionais e ficam sem autenticação, como os
  demais da 001 (I-41). Em produção, a exposição de `/metrics` e da reconciliação ficaria restrita pela rede.
- Em operação normal, as guardas do armazenamento (001) impedem divergências; a reconciliação é a verificação sob
  demanda e a rede de segurança. Por isso, os cenários de divergência só podem ser provocados em teste, num banco
  criado sem as guardas, nunca desligando as guardas de um banco que as tem (proibido pela 001).
- A reconciliação é feita uma wallet por vez, sob demanda; não há reconciliação em lote nem agendada, nem histórico
  persistido de reconciliações.
- Ready checa a fila em toda instância, qualquer que seja o papel ligado (consumidor, publicador, worker), porque o
  enunciado §9 define ready como "PostgreSQL e SQS alcançáveis". Uma instância só HTTP com a fila fora fica "não pronta"
  e continua atendendo (FR-017); o orquestrador decide o que fazer com isso.
- O prazo de 2 s por checagem de ready é fixo nesta feature (I-75).
- As métricas em memória são as da 002 (porta de métricas), acrescidas do contador de divergências; a exposição não
  persiste nada e reinicia com o processo.
- A idade do pendente mais antigo é medida a partir do registro do evento (`occurred_at`), pelo relógio do serviço.

### Interpretações registradas para esta feature

Registradas em `docs/interpretacoes.md` (§11) em 2026-11-09 e normativas nesta spec:

- **I-74**: reconciliação somente leitura num snapshot, com campos, regras da cadeia, sinalização e cálculo no banco.
- **I-75**: liveness e readiness, prazo de 2 s por checagem, 503 durante o encerramento, sem autenticação.
- **I-76**: métricas em texto Prometheus escrito à mão, medidores da outbox calculados na leitura, rótulos de baixa
  cardinalidade.

Já vigentes e aplicadas aqui: I-34 (comportamento com banco ou fila fora), I-37 (reconciliação em REPEATABLE READ, READ
ONLY), I-38 (envelope único de erro) e I-53 (correlationId).

### Fora de escopo

- Testes de carga e harness de caos separado (constitution VII: scripts opcionais, nunca substituem os testes).
- Interface gráfica, dashboards, alertas e OpenTelemetry.
- Correção automática de divergências, reconciliação em lote ou agendada e histórico de reconciliações.
- `README.md` e `ARCHITECTURE.md`, adiados para o fim do projeto (como na 001 e na 002).

### Dependências

- `001-wagering-transaction-core`: ledger encadeado com saldo antes e depois, guardas do armazenamento, envelope de
  erro, correlationId.
- `002-messaging-reliability`: porta de métricas e contadores (inclusive N-45), WorkerRegistry e término gracioso,
  configuração das filas.
