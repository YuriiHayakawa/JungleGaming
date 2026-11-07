<!--
SYNC IMPACT REPORT
==================
Version change: 1.0.0 → 1.0.1
Bump rationale: PATCH solicitado — correções de redação que alinham o texto à intenção já
declarada dos princípios (crédito nunca duplicado; DLQ para o que não se resolve com retry;
opcionais nunca substituem obrigatórios). Nenhum princípio adicionado, removido ou renomeado.

Princípios modificados (títulos inalterados):
- IV. Idempotência Persistente e Mensageria Confiável — classificação de erros corrigida:
  transitório → retry com backoff até o limite e depois DLQ; permanente (mensagem malformada,
  wallet inexistente, OPENING, payloadHash de inbox divergente) → DLQ imediata, sem retries;
  negócio → REJECTED persistido e ack.
- V. Invariantes Impostas pelo Schema — "uma reversão por referência e tipo" substituído por
  uma reversão por transação referenciada, compartilhada entre REFUND e ROLLBACK (índice único
  parcial sobre reference_transaction_id, kind IN (REFUND, ROLLBACK), status PROCESSED).
- VII. Testes Reais — bun test restrito a unitários/integração/concorrência; test:load e
  test:chaos via bun run, opcionais, nunca substituem os obrigatórios.
- IX. Documentação das Decisões — README passa a citar test:chaos junto de test:load
  (consequência de VII).

Seções adicionadas: nenhuma.
Seções removidas: nenhuma.

Templates dependentes: não modificados por este comando (leem a constitution em runtime).
- .specify/templates/plan-template.md — "Constitution Check" deve listar os gates da seção
  "Falhas Eliminatórias e Quality Gates" (verificação manual recomendada).

Follow-up TODOs:
- README.md e ARCHITECTURE.md ainda não existem; são exigidos pelo Princípio IX.
- ARCHITECTURE.md / docs/interpretacoes.md devem registrar a taxonomia final de erros
  permanentes do consumidor SQS e a definição do índice único parcial de reversão.
- (resolvido) docs/interpretacoes.md agora existe no repositório.
-->

# JungleGaming Constitution

Serviço financeiro distribuído que processa transações de apostas (BET, WIN, LOSS, REFUND,
ROLLBACK) de múltiplos provedores de jogos, com entrega at-least-once. O sistema DEVE
permanecer correto quando mensagens forem duplicadas, entregues fora de ordem, processadas
simultaneamente por várias instâncias, ou quando o processo morrer antes ou depois do commit.

## Core Principles

### I. Fontes da Verdade e Precedência

- `docs/enunciado.md` é a referência absoluta dos requisitos. Em caso de dúvida sobre
  comportamento, escopo ou contrato, o arquivo DEVE ser relido antes de decidir.
- `docs/interpretacoes.md` registra decisões adicionais sobre pontos que o enunciado deixa em
  aberto e tem força de norma. Toda interpretação nova adotada durante specify, clarify, plan ou
  implement DEVE ser registrada nele antes de ser usada como premissa.
- Ordem de precedência: `docs/enunciado.md` > esta constitution > `docs/interpretacoes.md` >
  spec > plan > tasks. Esta constitution prevalece sobre specs, plans e tasks; um artefato que
  a contrarie é inválido até ser corrigido.
- Todo plan DEVE conter uma seção "Constitution Check" com verificação explícita, item a item,
  contra os princípios desta constitution e contra a lista de Falhas Eliminatórias.
- Itens opcionais (testes de carga, harness de caos, UI de demonstração, OpenTelemetry,
  dashboards, double-entry) NUNCA podem comprometer, atrasar ou enfraquecer requisitos
  obrigatórios. Só são iniciados depois que os requisitos obrigatórios relacionados estão
  prontos e testados.

**Rationale**: um único ponto de referência evita que decisões implícitas se espalhem por
artefatos e divirjam do que será avaliado.

### II. Correção Financeira (NÃO-NEGOCIÁVEL)

- É PROIBIDO usar `number`, `float`, `double` ou qualquer tipo de ponto flutuante para
  representar dinheiro, em qualquer camada: domínio, DTO, ORM, SQL, eventos, logs e testes.
- `Money` é um value object imutável sobre um tipo decimal exato; toda operação retorna nova
  instância. Nos contratos trafega como `{ "amount": "25.00", "currency": "BRL" }`, com
  `amount` em string decimal de escala fixa de 2 casas.
- Entradas inválidas são rejeitadas: NaN, Infinity, notação científica, string vazia, mais de
  2 casas decimais e valores negativos em contratos de entrada.
- No banco, valor em `NUMERIC(18,2)` e moeda em coluna própria (ISO-4217). O valor NUNCA é
  convertido para `number` na leitura nem na escrita; a reidratação produz `Money`.
- O modelo é multi-moeda: operação entre moedas diferentes lança erro de domínio, e a moeda da
  operação DEVE ser igual à da wallet. Mesmo assumindo BRL como moeda única no escopo, o
  conflito de moeda DEVE ser testado.
- O ledger é imutável: lançamentos NUNCA são alterados nem excluídos. Todo movimento de saldo
  tem exatamente um lançamento, e todo lançamento corresponde a um movimento de saldo.
  Operações sem efeito no saldo (LOSS, qualquer REJECTED) não geram lançamento. Correções são
  feitas apenas por novos lançamentos (ex.: ROLLBACK).
- O saldo NUNCA fica negativo. `wallet.balance` DEVE ser sempre igual ao saldo reconstruído
  pelo ledger.
- Divergências de reconciliação NUNCA são corrigidas silenciosamente: DEVEM ser logadas,
  contabilizadas em métrica e sinalizadas na resposta (`consistent: false` + `difference`).

**Rationale**: correção financeira é o principal critério de avaliação; ponto flutuante,
ledger mutável ou correção silenciosa tornam o sistema não auditável.

### III. Concorrência por Wallet (NÃO-NEGOCIÁVEL)

- A unidade de concorrência é a `walletId`. Wallets distintas DEVEM poder ser processadas em
  paralelo.
- É PROIBIDO lock global compartilhado por todas as wallets.
- É PROIBIDO implementar saldo como read → calculate → update sem controle de concorrência
  (lock pessimista por linha, optimistic locking com retry limitado, update atômico
  condicionado, ou combinação justificada em ARCHITECTURE.md).
- A solução DEVE ser correta com 3 ou mais instâncias simultâneas da aplicação. É PROIBIDO
  usar cache ou estado em memória como garantia de correção, idempotência ou ordenação.
- Ordenação e deduplicação do broker (SQS FIFO, `MessageGroupId`, deduplication id) são
  otimização; o banco é a garantia final de todas as invariantes.
- Cenário obrigatório: saldo 100.00 BRL e duas BETs de 80.00 BRL simultâneas resultam em
  exatamente uma PROCESSED, uma REJECTED por saldo insuficiente, saldo final 20.00 BRL e
  exatamente um lançamento DEBIT, sem que nenhum retry duplique o débito.

**Rationale**: múltiplas instâncias e redelivery tornam qualquer garantia local inválida; só
o banco é compartilhado por todas as instâncias.

### IV. Idempotência Persistente e Mensageria Confiável (NÃO-NEGOCIÁVEL)

- Toda deduplicação vive em tabelas do banco: idempotência por `Idempotency-Key` (fonte da
  verdade na API) e inbox por `(consumerName, messageId)` na fila.
- `payloadHash` é o hash de um JSON canônico (chaves ordenadas) do subconjunto de campos de
  negócio; header e metadados de transporte não entram. O algoritmo DEVE estar documentado.
- Mesma chave com payload diferente é conflito, NUNCA replay. Replay devolve o resultado
  original, incluindo o saldo observado naquele momento, com `idempotentReplay: true`.
- Transação, alteração de saldo, ledger, inbox (quando a entrada é SQS) e outbox DEVEM
  participar da MESMA transação SQL: ou tudo é confirmado, ou nada.
- Nenhum evento é publicado antes do commit. Eventos saem exclusivamente pela outbox. O ack da
  mensagem SQS ocorre somente depois do commit.
- A publicação da outbox é at-least-once e DEVE ser segura com múltiplos publishers
  concorrentes (ex.: `FOR UPDATE SKIP LOCKED` ou lease), sem perder nem duplicar
  indefinidamente. Consumidores DEVEM tolerar duplicatas.
- HTTP e SQS reutilizam o mesmo use case de aplicação.
- Erros são classificados em três categorias, com tratamento distinto:
  - negócio: terminal, persistido como REJECTED com `failureCode`, mensagem recebe ack;
  - transitório (ex.: PostgreSQL ou SQS indisponível, timeout, conflito de lock esgotado):
    retry com backoff até o limite de tentativas e, esgotado o limite, DLQ
    (`wager-transactions-dlq.fifo`);
  - permanente (mensagem malformada, wallet inexistente, `kind` OPENING, `payloadHash`
    divergente para um `(consumerName, messageId)` já registrado na inbox): DLQ imediata, sem
    retries.
- Em SIGTERM, mensagens em andamento são concluídas ou têm a visibilidade devolvida.
- Referências ausentes geram PENDING_REFERENCE, reprocessadas por worker com backoff
  exponencial e limite/TTL justificado; esgotado o limite, REJECTED com `failureCode`
  específico e evento publicado.

**Rationale**: entrega at-least-once e falhas entre commit e ack são certas; apenas
deduplicação persistente e atomicidade transacional impedem efeitos duplicados ou perdidos.

### V. Invariantes Impostas pelo Schema

- Unicidade, imutabilidade do ledger e não-negatividade do saldo DEVEM ser impostas no banco,
  nunca só em código: `UNIQUE` (wallet por `playerId + currency`, idempotency key,
  `(providerId, externalTransactionId)`, inbox, um lançamento por transação/wallet, uma
  reversão por transação referenciada, compartilhada entre REFUND e ROLLBACK — índice único
  parcial sobre `reference_transaction_id` para `kind` REFUND ou ROLLBACK com `status`
  PROCESSED), `CHECK` (saldo ≥ 0, valores > 0, aritmética do lançamento), triggers que
  bloqueiam `UPDATE`/`DELETE` no ledger e índices parciais onde aplicável.
- A unicidade de reversão NÃO é por tipo: REFUND e ROLLBACK sobre a mesma BET creditariam duas
  vezes, violando a invariante de crédito não duplicado.
- Toda alteração de schema é feita por migration versionada e reversível (`up` e `down`),
  testada nos testes de integração. É proibido `schema:update`/sincronização automática fora de
  testes descartáveis.

**Rationale**: o desenho de schema, constraints e índices é avaliado diretamente; o banco é a
última linha de defesa quando o código falha ou corre em paralelo.

### VI. Domínio Encapsulado e Portas

- Classes de domínio têm construtor `private`/`protected` e factories estáticas (`create`,
  `from`, `open`, `receive`, `enqueue`, `rehydrate`). `rehydrate` reconstrói estado persistido
  sem revalidar regras de transição.
- Transições de estado são explícitas e documentadas. Estados terminais (PROCESSED, REJECTED,
  FAILED) nunca mudam; tentar transicioná-los lança erro de programação
  (`InvalidTransactionStateError`), não um caminho de negócio.
- `OPENING` é interno: não pode ser submetido pela API nem pela fila.
- O domínio não depende de ORM, de tipos monetários do ORM nem de decorators do NestJS. A
  persistência usa entidades de ORM separadas e mappers explícitos domínio ↔ persistência.
- Relógio e geração de ids entram por portas (`Clock`, `IdGenerator`), permitindo testes
  determinísticos. É proibido chamar `new Date()`/`Date.now()` ou gerar ids diretamente no
  domínio e nos use cases.
- Eventos de integração são subclasses concretas de `IntegrationEvent<T>`, com `eventType` e
  `version` no tipo, e `data` carregando `MoneyProps` (string), nunca instâncias de `Money`.
- Autenticação está fora do foco: `AuthGuard` no-op + porta `ProviderIdentityPort`, com o
  desenho alvo (IdP externo, ex.: Keycloak/Zitadel) documentado em ARCHITECTURE.md. Health
  checks ficam abertos; a identidade do provedor na mensagem continua sujeita às validações de
  domínio.

**Rationale**: invariantes encapsuladas e dependências invertidas tornam as regras testáveis
sem infraestrutura e impedem que detalhes de framework vazem para o domínio.

### VII. Testes Reais (NÃO-NEGOCIÁVEL)

- Testes automatizados (unitários, integração e concorrência) rodam com `bun test`.
- Testes de carga e de caos são scripts executados com `bun run` (`test:load`, `test:chaos`),
  são opcionais e NUNCA substituem os testes obrigatórios nem contam como cobertura deles.
- Unitários cobrem o domínio: Money (escala, arredondamento, entradas inválidas), invariantes da
  Wallet, regras de BET, WIN, LOSS, REFUND e ROLLBACK, conflito de moeda e idempotency key com
  payload divergente.
- Integração e concorrência usam PostgreSQL e SQS (LocalStack ou MiniStack) reais em
  containers. É PROIBIDO substituí-los por mocks, fakes em memória ou bancos alternativos
  nesses testes.
- Testes de concorrência usam paralelismo real (requisições/processos simultâneos, múltiplas
  instâncias); simulação sequencial não conta como teste de concorrência.
- Cobertura mínima de cenários: os listados na seção 13 de `docs/enunciado.md`, incluindo 50
  submissões paralelas da mesma BET, cenário 100/80/80, ≥ 3 instâncias, worker morto entre
  commit e ack, dois publishers na mesma outbox, reversão antes da referência e reinício com
  consistência final.
- Invariante final de todo teste de integração e concorrência:
  `wallet.balance == saldo reconstruído pelo ledger`.
- Nenhuma feature está pronta sem seus testes passando.

**Rationale**: as falhas mais graves (race, duplicidade, perda após crash) só aparecem com
infraestrutura e paralelismo reais.

### VIII. Observabilidade e Contrato de API

- Toda rejeição carrega um `failureCode` estável, legível por máquina, com flag `retryable`,
  suficiente para o provedor decidir entre reenviar, corrigir o payload ou desistir. A
  taxonomia é documentada. Reversão que produziria saldo negativo tem `failureCode` distinto
  de BET sem saldo.
- A API distingue de forma consistente, em todos os endpoints, por status HTTP e corpo:
  payload inválido, conflito de idempotência, rejeição de negócio, aceite com processamento
  pendente e falha transitória de infraestrutura. Essas situações NUNCA são colapsadas no
  mesmo código.
- Logs são JSON estruturados com `correlationId`, `messageId`, `transactionId`, `walletId` e
  `providerId` quando aplicáveis, sem dados sensíveis nem payloads financeiros completos.
- Métricas cobrem, no mínimo: transações por status, duplicatas detectadas, retries,
  mensagens em DLQ, conflitos de lock, outbox lag, latência de processamento e divergências de
  reconciliação.
- Health checks separados: `GET /health/live` (processo vivo) e `GET /health/ready`
  (PostgreSQL e SQS alcançáveis), ambos sem autenticação.

**Rationale**: o provedor precisa decidir reenvio sem interpretar mensagens de texto, e a
operação precisa diagnosticar falhas sem expor dados financeiros.

### IX. Documentação das Decisões

- `README.md` DEVE conter setup, pré-requisitos e comandos (subir o ambiente, migrations,
  testes unitários/integração/concorrência e, se existirem, `bun run test:load` e
  `bun run test:chaos`).
- `ARCHITECTURE.md` DEVE registrar decisões, trade-offs e limitações, incluindo
  obrigatoriamente: justificativa do ORM, mapeamento do Money, estratégia transacional, estratégia
  de concorrência, algoritmo do `payloadHash`, transições de estado, taxonomia de
  `failureCode`, mapeamento de status HTTP, política de retry/DLQ/PENDING_REFERENCE e o
  desenho de autenticação.
- Documentação é atualizada na mesma entrega que muda o comportamento descrito.

**Rationale**: a clareza das decisões técnicas é critério de avaliação e base da apresentação.

## Stack e Restrições Técnicas

| Item | Escolha obrigatória |
|------|---------------------|
| Runtime / package manager / test runner | Bun 1.x (`bun install`, `bun run`, `bun test`) |
| Linguagem | TypeScript com `strict: true` (sem `any` implícito; sem desligar flags estritas) |
| Framework | NestJS |
| Banco | PostgreSQL |
| ORM | MikroORM (Unit of Work, `EntityManager.transactional()`, `LockMode`) |
| Mensageria | AWS SQS via LocalStack ou MiniStack (`wager-transactions.fifo` + DLQ) |
| Orquestração local | Docker Compose (app, PostgreSQL, SQS emulado, múltiplas instâncias) |
| Migrations | Versionadas e reversíveis, via MikroORM Migrations |

- Prisma, TypeORM e outros ORMs não são usados; trocar de ORM exige emenda desta constitution.
- Dependências novas DEVEM ser compatíveis com Bun e justificadas no plan quando afetarem
  domínio, persistência ou mensageria.
- O ambiente inteiro DEVE subir com Docker Compose, sem dependências manuais fora do README.

## Falhas Eliminatórias e Quality Gates

As falhas abaixo bloqueiam qualquer feature, independentemente do restante estar pronto:

1. `number`/float/double para dinheiro em qualquer camada;
2. saldo negativo causado por race;
3. débito ou crédito duplicado;
4. idempotência apenas em memória;
5. solução correta somente com uma instância;
6. evento publicado antes do commit;
7. ausência de ledger auditável;
8. testes que substituem completamente PostgreSQL e SQS por mocks.

Quality gates obrigatórios:

- **Plan**: o "Constitution Check" DEVE marcar cada princípio (I–IX) e cada falha eliminatória
  como atendido ou justificar a exceção em "Complexity Tracking". Exceção a princípio marcado
  NÃO-NEGOCIÁVEL ou a falha eliminatória não é admitida.
- **Tasks**: toda task de comportamento tem task de teste correspondente (unidade, integração
  ou concorrência conforme o Princípio VII).
- **Implement**: uma feature só é concluída com `tsc` estrito sem erros, `bun test` verde
  (incluindo integração com containers reais), migrations com `up`/`down` exercitados e
  documentação (README/ARCHITECTURE) atualizada.
- **Revisão**: toda mudança que toque dinheiro, saldo, ledger, idempotência, inbox/outbox ou
  schema é revisada explicitamente contra os Princípios II–V.

## Governance

- Esta constitution prevalece sobre specs, plans, tasks e práticas informais; só
  `docs/enunciado.md` está acima dela. Conflito entre esta constitution e o enunciado é
  resolvido a favor do enunciado, com emenda imediata desta constitution.
- **Emendas**: propostas via `/speckit-constitution`, com descrição da mudança, motivação,
  impacto em specs/plans/tasks existentes e plano de migração quando aplicável. A emenda só
  vale após o arquivo ser atualizado com nova versão e data.
- **Versionamento semântico**:
  - MAJOR: remoção ou redefinição incompatível de princípio ou de gate;
  - MINOR: novo princípio/seção ou expansão material de regra existente;
  - PATCH: esclarecimentos, redação e correções sem efeito semântico.
- **Conformidade**: todo plan inclui o Constitution Check; `/speckit-analyze` DEVE ser
  executado antes de `/speckit-implement` e tratar violações desta constitution como CRITICAL.
  Interpretações novas são registradas em `docs/interpretacoes.md` antes de serem usadas.
- Complexidade adicional (camadas, abstrações, dependências) DEVE ser justificada no plan;
  na dúvida, prefere-se a solução mais simples que preserve as invariantes.

**Version**: 1.0.1 | **Ratified**: 2026-11-07 | **Last Amended**: 2026-11-07
