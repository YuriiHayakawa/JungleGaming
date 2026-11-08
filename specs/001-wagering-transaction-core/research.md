# Research: Núcleo Transacional de Apostas

**Feature**: `001-wagering-transaction-core` | **Date**: 2026-11-07 | **Plan**: [plan.md](plan.md)

Este documento consolida as decisões técnicas da Fase 0. Cada decisão segue o formato Decision / Rationale /
Alternatives e cita o FR ou I-xx que a motiva.

## 0. Status do spike obrigatório

> **EXECUTADO em 2026-11-07. Os 11 itens foram aprovados pelos seus critérios**, sem precisar das alternativas
> registradas. Dois pontos fora da tabela pediram ajuste: o `bun build` (extra) precisou de
> `--packages external`, e o SIGTERM no Windows mata o processo à força. Os ajustes que o spike trouxe estão em
> [0.3](#03-ajustes-decorrentes-do-spike) e **todos foram aplicados** ao plan.md e à data-model.md. O código
> descartável está em `spike/`.

### 0.1 Ambiente e comandos

- **Máquina**: Windows 10 Pro 10.0.19045. Docker 29.5.3. Bun 1.4.4 (`38afee6c8`), instalado pelo instalador
  oficial em `%USERPROFILE%\.bun\bin`.
- **Banco**: PostgreSQL 17.11 (`postgres:17-alpine`, `SELECT version()` →
  `PostgreSQL 17.11 on x86_64-pc-linux-musl`), via `spike/docker-compose.yml`, porta 55432.
- **Container Linux**: `oven/bun:1.4.4`, digest `sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d`.
- **Dependências**: as da seção 1 instaladas com versão exata. Acrescentado `@types/pg` 8.23.1 (dev) para os
  testes que seguram lock por conexão externa.

Comandos executados a partir de `spike/`:

```bash
bun install
docker compose up -d --wait
bun src/migrate.ts up              # S-08
bun test                           # S-01..S-10 (14 testes, 5 arquivos, 46,6 s)
bun src/migrate.ts down            # S-08 (catálogo conferido via psql)
bun src/migrate.ts up              # S-08
bun x tsc --noEmit -p tsconfig.json                     # S-11
bun build src/http-app.ts --target bun --packages external --outdir dist   # extra: build
docker run --rm -v "$PWD:/app" -w /app oven/bun:1.4.4 bun test test/s10-spawn.test.ts   # S-10 em Linux
```

### 0.2 Resultados

| Id | O que validar sob Bun 1.4.4 | Critério de aprovação | Resultado medido | Status |
|----|-----------------------------|-----------------------|------------------|--------|
| S-01 | NestJS 12.2.0 com `experimentalDecorators: true`, **sem** `emitDecoratorMetadata`, injeção só por `@Inject(TOKEN)` | App sobe, resolve providers por token e atende `GET` e `POST` com `@Body`/`@Param`/`@Headers` | `design:paramtypes` ausente no service e no controller (`undefined`), ou seja, nenhuma metadata de tipos emitida. Provider por `Symbol` e service por `@Inject(Classe)` resolvidos. `GET /ping` 200; `POST /echo/:id` 201 com `@Param`, `@Body` e `@Headers` corretos | **Aprovado** |
| S-02 | `@nestjs/platform-express` 12.2.0 sobre o `node:http` do Bun | 1000 requisições sequenciais e 50 paralelas sem erro | 1000 sequenciais: 0 erros em 148–151 ms. 50 paralelas: 0 erros em 14–16 ms | **Aprovado** |
| S-03 | Timeout do servidor HTTP configurável (`server.setTimeout`, `requestTimeout`, `headersTimeout`, `keepAliveTimeout`) | Requisição que leva 14 s responde normalmente com `HTTP_SERVER_TIMEOUT_MS=20000`; sem corte por ociosidade em ~10 s | 14 s: 200 em 14 015 ms (configurado) e 200 em 14 010 ms (padrão). Complemento S-03b com 25 s: o configurado **corta em 20 007 ms** (`ECONNRESET`), o que prova que o limite é aplicado; o padrão respondeu 200 em 25 008 ms, sem corte | **Aprovado** |
| S-04 | MikroORM 7.2.5 com `EntitySchema` (sem decorators) e driver `@mikro-orm/postgresql` | `MikroORM.init` conecta, `em.fork()` lê e grava entidades mapeadas | `persist`/`flush` em um fork e `findOneOrFail` em outro devolvem instâncias distintas de `WalletRecord` (identity maps isolados), com `balance` `"1000.00"` | **Aprovado** |
| S-05 | `NUMERIC(18,2)` e `BIGINT` chegam como **string** | `SELECT 1000.00::numeric(18,2)` → `"1000.00"`; `seq` → string | SQL cru: `"1000.00"`, `"9999999999999999.99"` e o bigint máximo `"9223372036854775807"`, todos string. Entidade com `new DecimalType('string')`: `"9999999999999999.99"`. Coluna identity `seq` → `"1"` (string). Nenhum type parser extra foi necessário: o MikroORM 7 só sobrescreve os OIDs de data e hora | **Aprovado** |
| S-06 | `em.transactional()` + `LockMode.PESSIMISTIC_WRITE` + `SET LOCAL lock_timeout` | Duas transações na mesma wallet serializam; com lock segurado por fora e `lock_timeout=500ms`, a segunda falha com SQLSTATE `55P03` acessível no erro | Ordem observada: `t1-locked`, `t1-updated:1`, `t2-locked:balance=900.00:version=2`, `t2-stale-update:0`. Em `READ COMMITTED`, t2 enxerga o commit de t1 depois do lock, e `nativeUpdate` com `WHERE version` velho devolve 0 linhas. Um `FOR UPDATE NOWAIT` externo falhou com `55P03`, prova de lock real. Com lock segurado por fora: `DriverException` com `code: "55P03"` após 505 ms | **Aprovado** |
| S-07 | Erro `23505` expõe o **nome da constraint** | O erro capturado traz `constraint` | `UniqueConstraintViolationException` com `code: "23505"` e `constraint` preenchido nos três casos: `spike_tx_idempotency_key_uq` (UNIQUE), `spike_tx_single_reversal_uq` (índice único parcial) e `spike_wallets_player_currency_uq` (`em.insert` de entidade) | **Aprovado** |
| S-08 | MikroORM Migrations com SQL cru: trigger PL/pgSQL, índice único parcial, `up` e `down`, por script programático | `up` cria tudo; `down` remove tudo na ordem inversa; `up` de novo funciona | `up` aplicou as 2 migrations. `down` (`migrator.down({ to: 0 })`) reverteu na ordem inversa; catálogo sem tabelas, triggers, função nem índice, e `spike_migrations` vazia. `up` de novo recriou tudo. Trigger do ledger recusou `UPDATE`, `DELETE` e `TRUNCATE` com `P0001`. Nenhum arquivo de snapshot gerado (`snapshot: false`, `snapshotOnMigrate: false`) | **Aprovado** |
| S-09 | Pool: `max` e timeout de aquisição configuráveis no MikroORM 7 | Com `max=2` e 3 requisições presas, a 3ª falha em `DB_POOL_ACQUIRE_TIMEOUT_MS` com erro identificável | Com `pool.max=2` e `driverOptions.connectionTimeoutMillis=1000`, a 3ª falhou em 1000–1002 ms com `DriverException`, **sem `code`**, mensagem `timeout exceeded when trying to connect`. O `PoolConfig` do MikroORM 7 só tem `min`, `max` e `idleTimeoutMillis`; o timeout de aquisição passa pelo `pg.Pool` via `driverOptions`, que era a alternativa registrada e coincide com o caminho nativo do driver | **Aprovado** (via `driverOptions`) |
| S-10 | `bun test` sobe 3 processos da app com `Bun.spawn`, espera prontidão e os encerra | 3 instâncias atendem em portas distintas; nenhum processo órfão após o teste, inclusive em falha | Boot das 3 instâncias em 325–327 ms; 30 requisições em round-robin atendidas por 3 pids distintos; 0 processos vivos depois do stop. Boot com falha: erro propagado e processo limpo. **Windows**: códigos de saída `[143,143,143]` (SIGTERM vira término forçado e o handler gracioso não roda). **Linux** (`oven/bun:1.4.4`): `[0,0,0]` (encerramento gracioso) | **Aprovado** |
| S-11 | TypeScript 7.0.2 (`tsc --noEmit`) com `experimentalDecorators` e `strict` | Typecheck de um controller e um provider Nest sem erros | `Version 7.0.2`, exit 0 com `strict` e `noUncheckedIndexedAccess`. Os erros iniciais eram só de configuração do spike: faltavam `allowImportingTsExtensions` e `@types/pg`. Teste negativo: um erro de tipo proposital num construtor com `@Inject` foi detectado (TS2345) | **Aprovado** (fallback 6.0.3 desnecessário) |

Verificações extras:

| Extra | Resultado | Status |
|-------|-----------|--------|
| `AsyncLocalStorage` do middleware até o service, atravessando `await` (I-53) | `correlationId` chegou ao service; nas 50 paralelas, 0 vazamentos entre contextos | Aprovado |
| `Bun.randomUUIDv7()` (I-35) | UUID com versão 7 (`01a1b627-bdcb-7335-…`) | Aprovado |
| `bun build --target bun` preserva decorators | **Falhou como planejado**: o bundler tenta resolver dependências opcionais do Nest (`class-transformer`, carregado sob demanda pelo `@nestjs/common`). **Alternativa adotada no spike**: `--packages external`, que gerou um bundle de 3,88 KB com o código da app e mantém `node_modules` em tempo de execução. O bundle sobe, resolve a injeção por token e responde `POST /echo` | Aprovado com alternativa |

Observação de ambiente, não do spike: o `bunx` desta máquina ainda resolve para um atalho quebrado que sobrou da
tentativa via npm (`%APPDATA%\npm\bunx`, `bunx.cmd`, `bunx.ps1`). `bun x` funciona. Recomenda-se rodar
`npm uninstall -g bun` para remover os atalhos.

### 0.3 Ajustes decorrentes do spike

Nenhum item reprovou, mas o spike mostrou detalhes que mudam o texto do plan. Em 2026-11-07, os itens 1, 2, 4, 5
e 7 foram **aplicados** ao plan.md (item 1 na forma decidida pelo usuário: `bun run` do código-fonte, sem
`bun build`). Os itens 3, 6 e 8 e o item do data-model foram aplicados na sequência, também em 2026-11-07
(plan: "Convenções de implementação"; data-model §2, §2.6 e §3).

**plan.md**

1. **Aplicado, com outra solução: sem etapa de build.** A app roda direto do código-fonte (`start`:
   `bun src/main.ts`), e o script `build` e o `dist/` saem do plan. O `Dockerfile` instala só as dependências de
   produção (`bun install --frozen-lockfile --production`) e executa `bun src/main.ts`. A proposta original era
   `bun build ... --packages external`.
2. **Aplicado.** Dependências: `pg` 8.23.1 (direta, para o harness de testes segurar locks por conexão externa e
   para o proxy de indisponibilidade) e `@types/pg` 8.23.1 (dev).
3. **Aplicado** (plan: Convenções de implementação). `tsconfig.json`: `allowImportingTsExtensions: true` (já que `noEmit` é usado e o Bun aceita `.ts` nos
   imports) e `types: ["bun"]`. Alternativa: imports sem extensão.
4. **Aplicado** (R-11 e plan). Timeout de aquisição do pool: `DB_POOL_ACQUIRE_TIMEOUT_MS` vai para `driverOptions.connectionTimeoutMillis`
   do `pg.Pool`; o `PoolConfig` do MikroORM não tem essa opção. O mesmo valor também limita o tempo de abrir uma
   conexão nova, e isso não muda a hierarquia do I-51.
5. **Aplicado** (R-12 e teste no plan). Mapeamento de erros: o timeout de aquisição chega como `DriverException` **sem SQLSTATE** e só pode
   ser identificado pela mensagem `timeout exceeded when trying to connect`, então o classificador precisa de
   uma regra por mensagem para esse caso. O `lock_timeout` chega como `DriverException` genérica com
   `code: "55P03"`, não como classe própria, então a classificação é por `code`. Os `23505` chegam como
   `UniqueConstraintViolationException` com `constraint`.
6. **Aplicado** (plan: Convenções de implementação e Consultas; data-model §3). SQL cru via `em.execute`: placeholders são `?`, não `$1`.
7. **Aplicado** (plan: Deploy e Documentação). Encerramento gracioso: só é verificável em Linux. No Windows o `SIGTERM` do harness vira término forçado
   (saída 143). Os testes desta feature não dependem de encerramento gracioso; o teste de SIGTERM da feature de
   mensageria deve rodar no container. Vale registrar como limitação de ambiente no README.
8. **Aplicado** (plan: Convenções de implementação e scripts; data-model §2.6). Migrations: config com `migrationsList`, `snapshot: false` e `snapshotOnMigrate: false` (sem eles, o
   MikroORM 7 grava arquivos de snapshot); `down` completo via `migrator.down({ to: 0 })`.

**data-model.md**

1. **Aplicado** (data-model §2, com teste `money-columns` no plan). Nenhuma mudança de schema. Só um esclarecimento no mapeamento: as propriedades monetárias do `EntitySchema`
   usam `new DecimalType('string')` explícito. O modo padrão do `DecimalType` segue o `runtimeType` da
   propriedade e poderia virar `number`.

## 1. Versões candidatas (fixadas no `package.json` sem `^` nem `~`)

Critério: a versão estável mais recente publicada há pelo menos 14 dias (até 2026-10-24), consultada no registro
npm em 2026-11-07.

| Pacote | Versão | Publicada em | Observação |
|--------|--------|--------------|------------|
| Bun (runtime) | 1.4.4 | 2026-10-22 | imagem `oven/bun:1.4.4` |
| `@types/bun` | 1.4.4 | 2026-10-22 | |
| `@nestjs/core`, `@nestjs/common`, `@nestjs/platform-express` | 12.2.0 | 2026-10-19 | 12.3.x e 12.4.0 são de 27/10 em diante |
| `reflect-metadata` | 0.2.2 | — | peer do Nest; importado uma vez em `main.ts` |
| `rxjs` | 7.8.2 | — | peer do Nest |
| `@mikro-orm/core`, `@mikro-orm/postgresql`, `@mikro-orm/migrations` | 7.2.5 | 2026-10-09 | 7.2.8 é de 06/11 |
| `pg` | 8.23.1 | 2026-09-30 | fixado de forma exata pelo `@mikro-orm/postgresql` 7.2.5; também dependência direta em `dependencies`, na mesma versão, porque `src/` importa `pg` (tipo `DatabaseError` em `pg-errors.ts` e `PoolConfig` nas `driverOptions`); o harness de testes também usa (conexões externas e proxy) |
| `decimal.js` | 10.6.0 | 2025-07-06 | |
| `zod` | 4.6.7 | 2026-10-12 | |
| `typescript` | 7.0.2 | 2026-07-08 | só typecheck; confirmado no S-11 (fallback 6.0.3 desnecessário) |
| `@types/pg` | 8.23.1 | 2026-08-17 | dev; acrescentado no spike (testes com conexão externa) |
| PostgreSQL | `postgres:17-alpine` | — | 17.11 no spike (`SELECT version()`) |

Todas as versões acima foram instaladas e exercitadas no spike de 2026-11-07 (seção 0), sem troca.

`@mikro-orm/nestjs` **não** é usado (ver R-05).

## 2. Decisões

### R-01 Runtime, linguagem e framework

- **Decision**: Bun 1.4.4 como runtime, gerenciador de pacotes e test runner; TypeScript `strict: true`;
  NestJS 12.2.0 sobre express.
- **Rationale**: stack obrigatória (enunciado §4; constitution, Stack). O Bun transpila TS diretamente; o `tsc`
  serve só para o typecheck estrito exigido no gate de implement.
- **Alternatives**: fastify como adapter, só se S-02 ou S-03 falharem.

### R-02 Injeção sem `emitDecoratorMetadata`

- **Decision**: `experimentalDecorators: true`, `emitDecoratorMetadata: false`. Todo parâmetro de construtor usa
  `@Inject(TOKEN)` com tokens `Symbol` declarados junto das portas (`CLOCK`, `ID_GENERATOR`, `WALLET_REPOSITORY`
  etc.). DTOs são validados por pipe Zod explícito, `@Body(new ZodValidationPipe(schema))`, nunca pelo
  `ValidationPipe` baseado em `design:paramtypes`.
- **Rationale**: elimina a dependência de metadata de tipos emitida pelo compilador, cujo suporte varia entre
  transpiladores; deixa explícitas as dependências das portas (constitution VI).
- **Alternatives**: `emitDecoratorMetadata` (rejeitado: acopla a injeção ao transpilador e esconde dependências);
  `class-validator` (rejeitado: depende de decorators e metadata em DTOs).

### R-03 Money

- **Decision**: `Money` imutável sobre `decimal.js` 10.6.0 com uma instância isolada
  (`Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN })`). `Money.from` só aceita o formato do
  I-01 e normaliza para 2 casas; nenhuma operação arredonda, porque entradas têm no máximo 2 casas e só existem
  soma e subtração. Serialização sempre via `toFixed(2)`. `currency` validada por `^[A-Z]{3}$`.
- **Rationale**: constitution II, FR-001 a FR-004, I-01 a I-05. Precisão 40 cobre com folga a soma de dois valores
  no limite de `NUMERIC(18,2)`.
- **Alternatives**: `bigint` em centavos (rejeitado: obriga conversões em todas as bordas e foge do esqueleto do
  enunciado, que pede `Decimal`); `big.js` (equivalente, mas o enunciado cita decimal).

### R-04 Persistência com MikroORM + EntitySchema + mappers

- **Decision**: o domínio não importa `@mikro-orm` nem `@nestjs` (constitution VI). Cada tabela tem um *record*
  de persistência (classe simples) mapeado por `EntitySchema` e um mapper explícito domínio ↔ record. Valores
  monetários usam `type: 'decimal'` com `precision: 18, scale: 2` em modo string. O mapper chama `Money.from`
  (I-04).
- **Rationale**: enunciado §4 (MikroORM preferencial) e §6.1; constitution VI.
- **Alternatives**: decorators nas entidades (rejeitado pelo pedido do plan e pela constitution VI);
  repositórios com SQL puro sem ORM (rejeitado: a constitution exige MikroORM).

### R-05 EntityManager por execução, sem `@mikro-orm/nestjs`

- **Decision**: um provider próprio cria o `MikroORM` no boot. Cada execução de use case obtém
  `orm.em.fork()` (identity map novo) e roda dentro de `fork.transactional(...)` quando escreve. Nada de
  `RequestContext` global nem de EntityManager compartilhado entre requisições.
- **Rationale**: o identity map compartilhado entre requisições é uma forma de estado em memória que poderia
  servir dado velho como garantia (constitution III). O fork explícito no use case torna o escopo visível e
  testável. `@mikro-orm/nestjs` traz decorators e convenções que não usamos.
- **Alternatives**: `@mikro-orm/nestjs` com `RequestContext` por middleware (rejeitado: escopo implícito e mais
  uma dependência sensível a decorators).

### R-06 Escritas críticas explícitas, não pelo flush do Unit of Work

- **Decision**: dentro da transação de submissão, as escritas usam operações imediatas e ordenadas:
  `em.insert` (transação, ledger, outbox) e `em.nativeUpdate` com `WHERE id = ? AND version = ?` (wallet),
  conferindo o número de linhas afetadas. O lock usa `em.findOne(..., { lockMode: PESSIMISTIC_WRITE })`,
  que gera `SELECT ... FOR UPDATE`. Leituras não críticas usam `em.find`/query builder com mappers.
- **Rationale**: o plan exige ordem conhecida (transação antes do ledger por FK, eventos por último), detecção
  de `23505` por constraint (S-07) e asserção de versão. O flush ordena por grafo de dependências e agrupa
  comandos, o que esconde quais comandos rodaram.
- **Alternatives**: `persist` + `flush` (rejeitado pelos motivos acima); SQL cru para tudo (só como fallback de
  S-06).

### R-07 Estratégia de concorrência: lock pessimista por wallet

- **Decision**: `SELECT ... FOR UPDATE` na linha da wallet, em `READ COMMITTED`, com
  `SET LOCAL lock_timeout = WALLET_LOCK_TIMEOUT_MS` (I-51). A wallet é a única linha travada explicitamente.
  Além disso, o `UPDATE` da wallet tem `WHERE version = esperada` como asserção (0 linhas → erro de invariante,
  500). O `CHECK (balance >= 0)` do banco é a última barreira.
- **Rationale**: FR-038, FR-039, enunciado §8, constitution III. Em `READ COMMITTED`, cada comando depois de
  obter o lock enxerga os commits anteriores; por isso a releitura da idempotência e da referência sob o lock vê
  o estado mais recente. Contenção na mesma wallet vira fila no banco, sem retry na aplicação, e o cenário
  100/80/80 (SC-001) dá resultado determinístico. Wallets distintas não compartilham lock (SC-004).
- **Alternatives**: optimistic locking com retry (rejeitado: com 50 requisições na mesma wallet geraria
  dezenas de retries e risco de esgotar o limite, violando SC-002); update atômico condicionado
  (`UPDATE ... WHERE balance >= x`) sozinho (rejeitado: não cobre a releitura de idempotência e referência sob
  o mesmo isolamento); `SERIALIZABLE` (rejeitado: falhas de serialização viram retries e não acrescentam
  garantia ao lock por linha).

### R-08 Idempotência: caminho rápido + releitura sob lock + unicidade no banco

- **Decision**:
  1. Fora de transação, ler numa **única consulta**
     `WHERE provider_id = ? AND (idempotency_key = ? OR external_transaction_id = ?)`, que usa os dois índices
     únicos e devolve no máximo duas linhas; se a linha da mesma chave existir, ela tem precedência. Mesmo hash →
     replay; hash diferente, ou só o mesmo id externo sob outra chave → 409 (FR-033, FR-034).
  2. Sob o lock da wallet, repetir a mesma consulta única, com o EM da transação; se existir, replay ou 409.
  3. `INSERT` da transação já no status final. Se ocorrer `23505` em `wager_tx_provider_idempotency_uq` ou em
     `wager_tx_provider_external_uq`, a transação sofre rollback, a mesma consulta única é refeita fora dela,
     num fork novo, e a resposta é replay ou 409.
- **Por que uma consulta só, num único snapshot**: em `READ COMMITTED` cada comando tem o próprio snapshot. Com
  duas consultas separadas (primeiro por chave, depois por id externo), a primeira podia rodar antes do commit da
  requisição concorrente idêntica e não achar nada, e a segunda, já depois do commit, achava a linha pelo id
  externo. A requisição era então classificada como "mesmo id externo com outra chave" e recebia 409, embora
  fosse idêntica à vencedora. No teste de 50 envios paralelos da mesma BET (T083), 5 de 50 respostas vinham 409
  com as duas consultas. Com a consulta única, as duas linhas possíveis são vistas no mesmo snapshot, e o
  resultado é 1 × 201 e 49 × 200, sem 409 (corrigido em 2026-11-07, durante a US3).
- **Escopo por provedor (I-56)**: a chave de idempotência só é única dentro do provedor
  (`UNIQUE(provider_id, idempotency_key)`). Dois provedores podem usar a mesma `Idempotency-Key` com ids
  externos diferentes e as duas transações são processadas sem conflito. Como o `payloadHash` inclui o
  `providerId`, a unicidade global da chave transformaria essa coincidência em 409, punindo um provedor pela
  escolha de chaves de outro.
- **Rationale**: I-24, I-26, I-27, I-56, FR-035. Requisições com a mesma chave **e a mesma wallet** são serializadas
  pelo lock e o passo 2 resolve. Mesma chave com **wallets diferentes** (hash diferente, portanto conflito)
  trava wallets diferentes; o PostgreSQL faz o `INSERT` perdedor esperar o commit do vencedor antes de acusar
  `23505`, de modo que a releitura do passo 3 sempre encontra a linha confirmada. É o comportamento descrito no
  I-27 ("quem perde espera o commit de quem ganhou e compara o hash").
- **Por que não `ON CONFLICT`**: `ON CONFLICT DO NOTHING` sem alvo também engoliria a violação do índice de
  reversão única (I-16) e a confundiria com idempotência, e só aceita um alvo por cláusula. A redação do I-27 foi
  ajustada em 2026-11-07 para "INSERT simples com tratamento da violação de unicidade pelo nome da constraint,
  com releitura depois do rollback", que é exatamente esta decisão.
- **Alternatives**: tabela separada de idempotência (rejeitado: duplica as chaves que já estão na transação e
  cria mais uma escrita); `ON CONFLICT DO NOTHING` (rejeitado pelo motivo acima).

### R-09 Hash de payload

- **Decision**: SHA-256 hex (`Bun.CryptoHasher` ou `node:crypto`) do JSON canônico definido no I-25:
  serializador próprio que ordena chaves recursivamente, sem espaços, em UTF-8, sobre
  `{providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money: {amount, currency},
  referenceExternalTransactionId?}`. `amount` entra **normalizado** ("0" e "0.00", "25" e "25.00" geram o mesmo
  hash). `walletId` entra em minúsculas (UUID normalizado na validação, I-58); os demais ids entram exatamente
  como enviados, porque são case-sensitive (I-58). Campos desconhecidos nunca entram (I-57).
- **Rationale**: I-25, I-57, I-58, FR-031. Não depende da ordem de inserção de chaves do `JSON.stringify`.
- **Alternatives**: `JSON.stringify` com array de chaves (rejeitado: não ordena objetos aninhados de forma
  garantida).

### R-10 Ordem de avaliação em serviço de domínio puro

- **Decision**: `WagerRulesService` (domínio, sem I/O) recebe a wallet travada, a transação nova, a referência
  carregada (ou ausente) e um booleano `referenceAlreadyReversed`, e devolve uma decisão: aplicar (com direção),
  rejeitar (com código) ou pendente de referência. A ordem é exatamente a do I-44 / FR-015. O use case faz o
  I/O: carrega a referência por `(provider_id, external_transaction_id)` e, só quando a referência é
  PROCESSED e o tipo é REFUND/ROLLBACK, consulta se já existe reversão PROCESSED.
- **Rationale**: I-44, I-46, FR-015 a FR-027; testável unitariamente, combinação a combinação (constitution
  VII).
- **Alternatives**: regras espalhadas no use case (rejeitado: impede testar a ordem isoladamente).

### R-11 Timeouts e pool (I-51, FR-059)

- **Decision**: variáveis de ambiente com padrões e validação no boot (a app não sobe se a hierarquia for
  violada):

  | Variável | Padrão | Regra |
  |----------|--------|-------|
  | `WALLET_LOCK_TIMEOUT_MS` | 5000 | `SET LOCAL lock_timeout` em toda transação que trava wallet |
  | `DB_POOL_MAX` | 25 por instância | 3 instâncias × 25 = 75 < `max_connections` 100 |
  | `DB_POOL_ACQUIRE_TIMEOUT_MS` | 8000 | DEVE ser > `WALLET_LOCK_TIMEOUT_MS`; vai para `driverOptions.connectionTimeoutMillis` do `pg.Pool`, porque o `PoolConfig` do MikroORM 7 não tem essa opção (S-09) |
  | `HTTP_SERVER_TIMEOUT_MS` | 20000 | DEVE ser > `DB_POOL_ACQUIRE_TIMEOUT_MS` + `WALLET_LOCK_TIMEOUT_MS` + 2000 |
  | `RETRY_AFTER_SECONDS` | 1 | valor do header Retry-After nos 503 |

- **Rationale**: o pior caso de uma requisição é esperar uma conexão (até 8 s) e depois o lock (até 5 s). O
  timeout HTTP precisa cobrir a soma; senão o provedor veria corte de conexão em vez do 503 padronizado (I-51).
  A aplicação **nunca** responde por timeout próprio enquanto uma transação pode estar em andamento: um 503
  emitido antes do fim da transação poderia mentir sobre "sem efeito". Para SC-002, as 50 requisições paralelas
  ficam em fila no lock por poucos ms cada, bem abaixo de 5 s; mesmo numa só instância, 50 > 25 conexões só
  gera espera curta por conexão.
- **Alternatives**: timeout de requisição na aplicação (rejeitado pelo motivo acima); pool por wallet
  (rejeitado: complexidade sem ganho).
- **Limitação documentada**: requisições presas no lock de uma wallet muito disputada ocupam conexões do pool;
  sob saturação extrema, outras wallets da mesma instância podem esperar por conexão (limitada por
  `DB_POOL_ACQUIRE_TIMEOUT_MS`). Vai para ARCHITECTURE.md.

### R-12 Mapeamento de erros de infraestrutura

- **Decision**:

  | Origem | Tratamento | Resposta |
  |--------|------------|----------|
  | Falha de conexão (`ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, SQLSTATE classe `08`), `53300`, `57P01`, `57P02`, `57P03` | rollback | 503 `SERVICE_UNAVAILABLE` + Retry-After |
  | Timeout de aquisição do pool: `DriverException` **sem SQLSTATE**, mensagem `timeout exceeded when trying to connect` (S-09); único caso classificado por mensagem | nada a desfazer (a conexão não foi obtida) | 503 `SERVICE_UNAVAILABLE` + Retry-After |
  | `55P03` lock_not_available: `DriverException` genérica com `code: "55P03"` (S-06), classificada por `code` | rollback | 503 (I-51) |
  | `40P01` deadlock, `40001` serialization_failure | repetir o use case até 2 vezes; depois rollback | 503 |
  | `57014` query_canceled | rollback | 503 |
  | `23505` em `wager_tx_provider_idempotency_uq` ou `wager_tx_provider_external_uq` | rollback + releitura fora | replay ou 409 (R-08, I-56) |
  | `23505` em `wallets_player_currency_uq` | rollback + leitura do id fora | 409 `WALLET_ALREADY_EXISTS` + `details.walletId` (I-52) |
  | `23505` em `wager_tx_single_reversal_uq` | rollback + repetir o use case 1 vez (sob o lock, a 2ª execução detecta `ALREADY_REVERSED`) | resultado normal; se repetir, 500 |
  | `23514` check_violation, `22003` numeric_value_out_of_range, `P0001` dos triggers de guarda, `UPDATE` de wallet com 0 linhas | rollback + log de erro (quebra de invariante: o domínio já deveria ter barrado, ex.: I-54) | 500 `INTERNAL_ERROR` (I-49) |
  | Falha no `COMMIT` por perda de conexão (resultado incerto) | — | 503; o reenvio é seguro porque a idempotência devolve replay se o commit tiver ocorrido |

- **Rationale**: FR-043, FR-044, I-34, I-39, I-49, I-51. Toda resposta 5xx é emitida depois do rollback, nunca
  com transação aberta.
- **Alternatives**: mapear tudo para 500 (rejeitado: o provedor perderia a distinção transitório × inesperado).

### R-13 Validação de entrada com Zod 4

- **Decision**: schemas Zod por endpoint. `amount` é `z.string().regex(I-01)`; número JSON falha por tipo. Campos
  desconhecidos são **descartados** (não entram no hash nem na persistência), no HTTP e na fila, e os conhecidos
  continuam estritos (I-57). `walletId` e `transactionId` são validados como UUID e normalizados para minúsculas;
  `playerId`, `providerId`, `externalTransactionId`, `roundId`, `gameId` e `referenceExternalTransactionId` são
  case-sensitive e não são normalizados (I-50, I-58). `providerId` "system" e `kind` OPENING recusados (I-07, I-08). A regra de referência por
  `kind` (I-13) e o valor zero (I-02) ficam em `superRefine`. Os erros viram 400 com `details` listando os campos.
  A ordem do I-44 é preservada: o header `Idempotency-Key` é checado antes do corpo.
- **Rationale**: FR-001, FR-002, FR-010 a FR-012, I-48, I-50, I-57, I-58.
- **Alternatives**: rejeitar campos desconhecidos (rejeitado: provedores costumam mandar metadados extras; o I-25
  já os exclui do hash).

### R-14 correlationId com AsyncLocalStorage (I-53, FR-060)

- **Decision**: middleware global lê `X-Correlation-Id`; se válido, usa-o; senão, gera UUIDv7 pelo
  `IdGenerator`. Guarda o contexto (`correlationId`, mais `transactionId`, `walletId` e `providerId` quando
  conhecidos) em `AsyncLocalStorage`; o logger JSON e a criação de eventos leem desse contexto; o header de
  resposta e o filtro de exceções também. Nunca gera 400.
- **Rationale**: I-53; constitution VIII (logs com os ids exigidos).
- **Alternatives**: passar o correlationId por parâmetro em todas as camadas (rejeitado: polui as assinaturas do
  domínio; o domínio recebe o correlationId apenas como dado do evento, via use case).

### R-15 Eventos e outbox (apenas escrita)

- **Decision**: classe abstrata `IntegrationEvent<T>` com uma subclasse concreta por evento
  (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`,
  `WagerTransactionPendingReference`). `OutboxMessage.enqueue(event)` gera a linha da outbox, gravada por
  `em.insert` na mesma transação (FR-040, FR-045 a FR-048). `aggregateId = walletId` (I-33). `data` carrega
  `MoneyProps`. Sem publisher nesta feature.
- **Rationale**: enunciado §6.5 e §11; constitution IV.
- **Alternatives**: nenhuma; o publisher é da feature de mensageria.

### R-16 Failpoints (I-40)

- **Decision**: porta `Failpoints` com `hit(name)`. A implementação real lê `FAILPOINT` do ambiente e vira no-op
  quando `NODE_ENV=production`. Pontos desta feature:
  - `after_ledger_insert_before_commit`: lança erro dentro da transação (testa a atomicidade, SC-007).
  - `after_commit_before_response`: encerra o processo (`process.exit(1)`) depois do commit (testa o reenvio
    após queda, SC-007).
  - Modo opcional `FAILPOINT=<nome>:serialization_failure_once`: na 1ª passagem lança um erro com SQLSTATE `40001`,
    que a unit of work repete (R-12); nas seguintes não faz nada. Prova que cada tentativa recomeça do zero
    (`test/integration/transaction-retry.test.ts`). Nome ou modo desconhecido recusa o boot. Acrescentado em 2026-11-07.
- **Rationale**: I-40; testes de falha determinísticos sem mock de banco (constitution VII).
- **Alternatives**: matar o processo por sinal em momento aleatório (rejeitado: não determinístico).

### R-17 Testes

- **Decision**:
  - `test/unit`: domínio puro, sem banco.
  - **Isolamento por banco, sem limpar dados.** Os triggers de guarda recusam `TRUNCATE` e `DELETE` (ledger e
    transações), então os testes nunca limpam tabelas: cada arquivo de teste usa um **banco próprio, criado a
    partir de um template já migrado**.
    - **Preload, uma vez por execução do `bun test`** (`test/support/db-setup.preload.ts`): se o
      `jg_test_template` existir, executa antes `ALTER DATABASE jg_test_template WITH IS_TEMPLATE false
      ALLOW_CONNECTIONS true`, porque o PostgreSQL não apaga um banco marcado como template, nem com `FORCE`;
      depois remove os bancos `jg_test_*` que sobraram de execuções interrompidas, inclusive o template
      (`DROP DATABASE ... WITH (FORCE)`), recria
      `jg_test_template` vazio, aplica as migrations nele pelo mesmo migrator programático da app, fecha todas
      as conexões e marca o banco com `ALTER DATABASE jg_test_template WITH ALLOW_CONNECTIONS false
      IS_TEMPLATE true`, para ninguém se conectar a ele por engano (clonar exige template sem sessões).
    - **Por arquivo** (`test/support/test-database.ts`): no `beforeAll`,
      `CREATE DATABASE jg_test_<arquivo>_<aleatório> TEMPLATE jg_test_template`, e a app, o harness e as
      conexões auxiliares apontam para ele; no `afterAll`, encerra a app e as instâncias e faz
      `DROP DATABASE ... WITH (FORCE)`. Dentro do arquivo, os testes se isolam por ids únicos (wallets e
      jogadores novos por teste).
    - **Exceção**: o teste de migrations (`up → down → up`) cria o próprio banco vazio a partir de `template0`.
    - **Proibido**: `SET session_replication_role = replica`, `ALTER TABLE ... DISABLE TRIGGER`, `TRUNCATE` ou
      `DELETE` em tabelas protegidas, e qualquer outro meio de contornar os triggers para limpar dados. Os
      testes exercitam o schema real, inclusive as guardas.
  - `test/integration`: app em processo (`NestFactory` + porta efêmera) contra o banco do arquivo.
  - `test/concurrency`: harness sobe 3 processos (`Bun.spawn`) apontando para o banco do arquivo, com prontidão
    detectada pela linha de log `http.listening`; o cliente distribui as requisições em round-robin. O
    encerramento gracioso por `SIGTERM` só é verificável em Linux; no Windows vira término forçado (saída 143,
    spike S-10). Os testes desta feature não dependem dele.
  - **Failpoints e `NODE_ENV`** (I-40, R-16): a imagem do `Dockerfile` define `ENV NODE_ENV=production`, e o
    Compose também passa `NODE_ENV: production` às instâncias, o que **desliga todos os failpoints** no container.
    Testes que dependem de failpoint (atomicidade, crash recovery) e rodam em Linux dentro do container DEVEM
    sobrescrever `NODE_ENV=test`. O `app-harness` e o `instance-cluster` já forçam `NODE_ENV=test` nos processos
    que sobem. Anotado em 2026-11-07.
  - Indisponibilidade do banco (US9): proxy TCP de teste (`Bun.listen`/`Bun.connect`) entre a app e o
    PostgreSQL, derrubado no meio do teste.
  - `assertWalletMatchesLedger(walletId)` em todo teste que toca wallet: saldo armazenado = Σ créditos − Σ
    débitos, cadeia `before[n] = after[n-1]` com `before[0] = 0.00`, saldo ≥ 0.
- **Rationale**: constitution VII; SC-001 a SC-010.
- **Alternatives**: Testcontainers (rejeitado: o Compose já é o ambiente obrigatório e evita mais uma
  dependência sob Bun); um banco único para a execução inteira, isolado só por ids (rejeitado: estado
  acumulado entre arquivos e nenhuma forma de começar limpo sem contornar os triggers);
  `session_replication_role = replica` para limpar (rejeitado e proibido: desliga exatamente as guardas que os
  testes precisam provar).

### R-18 Compose e scripts

- **Decision**: `docker-compose.yml` com `postgres` (healthcheck), `migrate` (one-shot que roda
  `migrate:up`, com `depends_on: service_healthy`) e `app1`. O profile `cluster` acrescenta `app2` e `app3`.
  Portas 3001 a 3003. Sem balanceador: os testes e o quickstart escolhem a instância.
  Scripts: `dev`, `start`, `typecheck`, `migrate:up`, `migrate:down`, `test` (unit + integration +
  concurrency), `test:unit`, `test:integration`, `test:concurrency`.
  **Sem etapa de build**: `start` é `bun src/main.ts` (o Bun executa TypeScript direto). O `Dockerfile` parte de
  `oven/bun:1.4.4`, roda `bun install --frozen-lockfile --production` e executa `bun src/main.ts`.
- **Rationale**: pedido do plan; constitution (ambiente inteiro sobe com Compose). O `bun build` só funciona com
  `--packages external` (spike, extra), o que mantém `node_modules` na imagem e não traz ganho para um serviço
  sem front-end; rodar o fonte elimina um artefato e uma etapa.
- **Alternatives**: nginx como balanceador (adiado: não muda a correção e acrescenta configuração);
  `bun build --packages external` (rejeitado pelo motivo acima).

### R-19 Dentro da transação, só o EntityManager da transação

- **Decision**: dentro de `em.transactional(cb)`, **toda** query usa o EntityManager recebido no callback, nunca
  `orm.em`, outro fork, o `pg.Pool` nem qualquer outra conexão do pool. Os repositórios não guardam
  EntityManager: recebem o da execução em cada chamada (a unit of work passa o EM transacional para eles).
  Leituras fora da transação, como o caminho rápido de idempotência e as consultas GET, usam um fork próprio e
  terminam antes de a transação começar.
- **Rationale**:
  1. **Correção**: outra conexão não enxerga as escritas ainda não confirmadas da transação nem está sob o lock
     da wallet. Uma decisão tomada com ela usaria estado errado (constitution III).
  2. **Esgotamento do pool**: a transação segura uma conexão e o lock da wallet. Se ela pedir uma segunda
     conexão enquanto as outras estão presas esperando o mesmo lock, ninguém avança até estourar o
     `lock_timeout` ou o timeout de aquisição. O resultado são 503 espúrios sob carga, ou um impasse que o
     PostgreSQL não detecta porque o ciclo passa pela aplicação.
- **Prova**: teste de concorrência `pool-pressure`: 3 instâncias com `DB_POOL_MAX=5` (por env), 100 requisições
  paralelas na mesma wallet (BETs distintas que cabem no saldo), **nenhum 503**, saldo e ledger corretos. Com
  pool 5, uma única query fora do EM transacional bastaria para travar a fila e gerar 503.
- **Alternatives**: confiar só em revisão de código (rejeitado: o erro só aparece sob carga, e o teste o torna
  observável).

## 3. Pendências

Resolvidas em 2026-11-07 e registradas em `docs/interpretacoes.md`:

- Redação do I-27 ajustada (R-08).
- I-54: crédito que levaria o saldo acima de 9999999999999999.99 → REJECTED `BALANCE_LIMIT_EXCEEDED` (422,
  `retryable` false, GIVE_UP), no último passo do I-44. O `CHECK`/`NUMERIC(18,2)` do banco continua como última
  barreira: se a regra de domínio falhar e o banco recusar (`22003`), a resposta é 500 sem efeito (R-12).
- I-55: `TRANSACTION_NOT_FOUND` (404, `retryable` false) nas consultas de transação.

Em aberto, fora do escopo desta feature:

- **Replay de transação FAILED** gravada pela fila (feature de mensageria): o mapeamento HTTP será decidido
  naquela feature.
