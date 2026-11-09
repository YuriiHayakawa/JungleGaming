# Teste de carga

Diferencial opcional do enunciado (§14): `bun run test:load`. O enunciado não fixa meta de RPS. Este relatório descreve
o ambiente, a metodologia, os números medidos e, principalmente, o que eles **não** provam.

Resumo:

- **Correção sob carga**: em 3 execuções (cerca de 99 mil requisições no total, 201 wallets por execução), **nenhuma**
  inconsistência:
  - todas as wallets reconciliadas com `consistent: true`, nenhum saldo negativo;
  - o saldo esperado pelo cliente, somando só as respostas 201, é igual ao armazenado em todas as wallets;
  - 100% das duplicatas foram reconhecidas como replay, e nenhuma resposta foi 5xx.
- **Capacidade do HTTP** neste ambiente: cerca de 390 a 445 req/s com wallets distribuídas e 32 requisições em voo,
  p99 de cerca de 172 ms. Numa única wallet quente: 73 a 152 req/s, com p99 acima de 1 s.
- **Gargalo real**: a **publicação da outbox**, de 96 a 168 eventos/s, contra cerca de 740 eventos/s gerados. O
  backlog chega a 19–24 mil eventos e o mais antigo espera até 4 min. Parte disso é o emulador (MiniStack com um núcleo
  saturado), parte é o desenho do publicador (`SendMessage` evento a evento).

## 1. Ambiente

Tudo numa única máquina. O gerador de carga, as 3 instâncias, o PostgreSQL e o emulador de SQS disputam a mesma CPU.

| Item | Valor |
|---|---|
| CPU | Intel Core i5-10400F, 2,9 GHz, 6 núcleos e 12 threads |
| Memória | 15,9 GB |
| SO | Windows 10 Pro 10.0.19045 |
| Docker | Docker Desktop 4.77.0 (Engine 29.5.3, backend WSL2, kernel 6.18.54.1); VM com 12 CPUs e 7,7 GB |
| Compose | v5.1.4, profile `cluster`: `app1` (HTTP + consumidor), `app2` (HTTP + consumidor + publicador), `app3` (HTTP + publicador + worker) |
| App | Bun 1.4.4, NestJS 12.2.0, MikroORM 7.2.5; `NODE_ENV=production`; log JSON em nível info de toda requisição |
| Banco | PostgreSQL 17.11 (`postgres:17-alpine`, configuração padrão: `max_connections` 100, `shared_buffers` 128 MB); `DB_POOL_MAX` 25 por instância |
| Fila | **MiniStack 1.5.32** (emulador em Python), **não a AWS** |
| Cliente | `load/load-test.ts` no host Windows, Bun 1.4.4, `fetch` com keep-alive |

## 2. Metodologia

**Cliente** (`load/load-test.ts`): sem dependências. É um pool de concorrência de *workers* em laço fechado: cada
worker manda uma requisição, espera a resposta e manda a próxima. A latência é medida com `performance.now()` em volta
do `fetch` e da leitura do corpo. As requisições alternam entre as 3 instâncias (round-robin). A configuração vem por
env (`LOAD_*`).

**Preparação**: 200 wallets distribuídas e 1 wallet quente, todas com saldo de 100000000.00 BRL. O saldo alto evita
rejeições e mantém a mistura comparável entre os cenários. Antes de medir, há 5 s de aquecimento, sem medição.

**Mistura de operações**: BET 50%, WIN 30% (sem referência, I-13) e LOSS 20% (valor 0.00). Os valores são 1.00. Cada
requisição tem `externalTransactionId` e `Idempotency-Key` novos. Rejeições, reversões e pendências não fazem parte da
carga.

**Cenários**, todos com 32 requisições em voo e 30 s de duração:

| Cenário | O que exercita |
|---|---|
| A, wallets distribuídas | operações espalhadas aleatoriamente entre as 200 wallets |
| B, wallet quente | a mesma mistura, toda numa única wallet: o custo do lock pessimista por wallet |
| C, duplicatas | como A, mas 20% das requisições reenviam uma requisição já respondida, com a mesma chave e o mesmo corpo, por uma instância qualquer |

**Medido por cenário**:

- throughput (respostas por segundo de relógio), p50, p95, p99, máximo e média de latência;
- contagem por status HTTP (inclusive 503 e erro de rede, se houver);
- reenvios reconhecidos como replay (`idempotentReplay: true`).

Do `/metrics` das 3 instâncias, lido antes e depois de cada cenário:

- deltas de `transactions_total`, `duplicates_total{source="idempotency"}` e `lock_conflicts_total` (`55P03`, lock
  esgotado);
- os gauges `outbox_pending_events` e `outbox_oldest_pending_age_seconds`, amostrados a cada 250 ms. São calculados no
  banco, então são iguais em qualquer instância.

**Isolamento entre cenários**: cada cenário só começa com a outbox vazia. Depois da carga, o script mede quantos
eventos ficaram pendentes, quanto tempo levam para zerar e a vazão média de publicação nesse intervalo.

**Consumidor de eventos (downstream simulado)**: o script consome `wager-events.fifo` (`ReceiveMessage` +
`DeleteMessageBatch`) durante a execução, como faria um sistema downstream. Sem isso, a fila cresce sem limite, e o
MiniStack degrada (ver §4.3).

**Verificação final**, toda pela API pública:

- `POST /wallets/:id/reconciliation` em cada wallet tocada: `consistent` precisa ser true;
- nenhum saldo negativo;
- o **saldo esperado pelo cliente**, isto é, inicial − BETs com 201 + WINs com 201, somados em centavos `BigInt`,
  precisa ser igual ao saldo armazenado. Wallets com alguma resposta incerta (erro de rede ou 5xx) ficariam fora dessa
  conta; não houve nenhuma.

Se a verificação falha, o script sai com código 1.

**Execuções**: 3 execuções completas, em sequência. Antes de cada uma, a outbox vazia e o MiniStack reiniciado (filas
vazias) com `queue-init`. O banco **não** foi zerado entre execuções: tinha cerca de 174 mil transações e 505 MB ao fim.
O `docker stats` foi amostrado a cada cerca de 3 s.

## 3. Resultados

As três execuções, lado a lado. O JSON completo de uma delas (a 2ª) está em
[`load/results/example.json`](../load/results/example.json).

### 3.1 HTTP

| Cenário | Execução | Requisições | req/s | p50 ms | p95 ms | p99 ms | máx ms | Status |
|---|---|---|---|---|---|---|---|---|
| A distribuídas | 1 | 13 381 | 445,4 | 68,2 | 130,9 | 171,8 | 315,8 | 201: 100% |
| | 2 | 12 021 | 400,0 | 75,7 | 132,3 | 172,0 | 301,4 | 201: 100% |
| | 3 | 11 754 | 390,8 | 78,0 | 135,7 | 173,9 | 292,9 | 201: 100% |
| B wallet quente | 1 | 4 468 | 147,9 | 24,2 | 943,1 | 1 177,3 | 1 638,6 | 201: 100% |
| | 2 | 4 594 | 152,0 | 23,0 | 925,2 | 1 051,5 | 1 260,5 | 201: 100% |
| | 3 | 2 222 | 73,0 | 58,6 | 1 305,0 | 1 480,0 | 1 704,3 | 201: 100% |
| C duplicatas | 1 | 17 652 | 587,6 | 44,7 | 127,7 | 169,3 | 377,6 | 201: 79,7%, 200 (replay): 20,3% |
| | 2 | 17 631 | 586,7 | 48,2 | 125,9 | 159,1 | 311,1 | 201: 79,9%, 200 (replay): 20,1% |
| | 3 | 15 622 | 520,1 | 55,0 | 142,8 | 202,4 | 359,6 | 201: 79,8%, 200 (replay): 20,2% |

- **Taxa de erro**: 0 em todos os cenários. Nenhum 4xx, nenhum 5xx (503 inclusive) e nenhum erro de rede.
- **Duplicatas reconhecidas** (C): 3576/3576, 3539/3539 e 3152/3152 reenvios voltaram como replay, com o mesmo
  `transactionId`. O `duplicates_total{source="idempotency"}` do servidor subiu exatamente o mesmo número.
- **Conflitos de lock** (`lock_conflicts_total`, ou seja, `55P03` com espera acima de `WALLET_LOCK_TIMEOUT_MS` = 5 s): 0
  em todos os cenários, inclusive na wallet quente.
- **Contagem cruzada**: o número de 201 do cliente é igual ao delta de `transactions_total{status="PROCESSED"}` do
  servidor em todos os cenários.

### 3.2 Outbox

| Cenário | Execução | Pico de pendentes | Idade máx. do mais antigo | Pendentes ao parar | Drenagem | Publicação média |
|---|---|---|---|---|---|---|
| A | 1 / 2 / 3 | 21 596 / 18 926 / 18 609 | 133 / 118 / 111 s | 21 597 / 18 963 / 18 645 | 134 / 118 / 111 s | 162 / 160 / 168 eventos/s |
| B | 1 / 2 / 3 | 5 427 / 5 521 / 980 | 54 / 55 / 9 s | 5 440 / 5 533 / 984 | 54 / 55 / 9 s | 101 / 100 / 105 eventos/s |
| C | 1 / 2 / 3 | 24 144 / 24 139 / 21 083 | 245 / 244 / 219 s | 24 149 / 24 157 / 21 103 | 245 / 245 / 219 s | 99 / 99 / 96 eventos/s |

### 3.3 Invariantes

Nas 3 execuções: **201/201 wallets consistentes** na reconciliação, **0 saldos negativos**, e **saldo esperado pelo
cliente = saldo armazenado em 201/201**.

### 3.4 CPU (`docker stats`, execução inteira, inclusive as drenagens)

| Container | Média (exec. 1 / 2 / 3) | Pico (exec. 1 / 2 / 3) |
|---|---|---|
| `sqs` (MiniStack) | 97 / 97 / 97% | 113 / 120 / 113% |
| `postgres` | 45 / 69 / 89% | 566 / 795 / 844% |
| `app1` | 17 / 15 / 14% | 155 / 116 / 129% |
| `app2` | 22 / 22 / 20% | 152 / 118 / 118% |
| `app3` | 21 / 22 / 20% | 153 / 121 / 111% |

100% equivale a um núcleo.

## 4. Análise

### 4.1 Cenário A: o teto provável é CPU, das instâncias e da máquina

Durante a carga, cada instância passa de 100% de CPU. O Bun executa o JavaScript numa thread, e os picos acima de 100%
são GC e I/O. Ao mesmo tempo, o PostgreSQL chega a 5–8 núcleos, o MiniStack ocupa 1 e o gerador de carga também
consome CPU. Somados, os picos se aproximam dos 12 threads da máquina, então não dá para dizer que sobrava CPU. A
hipótese mais provável para o teto de cerca de 400 req/s é a soma de duas coisas:

- o custo por requisição dentro de cada instância: Nest/Express, validação Zod, MikroORM, várias idas ao banco por
  transação e log JSON de cada requisição;
- a disputa pela CPU de uma máquina só.

**Não fiz profiling** para separar essas parcelas.

O throughput caiu de 445 para 391 req/s ao longo das execuções, e a CPU média do PostgreSQL subiu de 45% para 89%.
Coincide com o banco crescendo sem ser zerado (174 mil transações e 505 MB ao fim), mas também não isolei essa causa.

### 4.2 Cenário B: o lock por wallet serializa, e a cauda é longa

- **Vazão**: numa única wallet, cada transação espera a anterior. Com cerca de 150 req/s, cada transação segura o lock
  por cerca de 6,6 ms (lock, releituras, `INSERT`s, `UPDATE`, trigger do ledger e commit). A Lei de Little confere: 150
  req/s × 0,21 s de latência média ≈ 32 requisições em voo.
- **Cauda**: a p50 é baixa (23 ms), mas a p95 fica perto de 1 s. As requisições na fila do lock não são atendidas em
  ordem de chegada. Uma hipótese compatível, **não verificada**: no PostgreSQL, quando o dono do lock faz commit, quem
  esperava volta a disputar a linha, e quem chegou depois pode passar na frente.
- **Lock esgotado**: nenhum `55P03`. As esperas ficaram bem abaixo dos 5 s do `WALLET_LOCK_TIMEOUT_MS`.
- **3ª execução**: deu metade da vazão (73 req/s) e o dobro da p50. Não sei explicar com certeza. Hipóteses compatíveis
  com os dados: a linha da wallet quente acumula versões mortas a cada `UPDATE` (o autovacuum entra no meio), e o banco
  estava maior. É o cenário mais sensível a ruído; com 3 execuções, não dá para estimar a variância.
- **O que isso confirma**: o trade-off descrito no ARCHITECTURE §6. A wallet quente não falha, não gera 503 nem
  inconsistência; ela fica lenta para quem está na fila. Wallets distribuídas não sentem esse custo.

### 4.3 Cenário C: duplicatas custam menos que transações novas

O throughput é maior que no A, e a latência menor. Um replay sai pelo caminho rápido: uma consulta fora de transação,
sem lock e sem escrita. Todas as duplicatas foram reconhecidas pelo banco, e o contador do servidor bate com o cliente.

### 4.4 Outbox: o gargalo de verdade

Cada requisição gera em média cerca de 1,8 evento: BET e WIN geram `WagerTransactionProcessed` e
`WalletBalanceChanged`; LOSS, só o primeiro. No cenário A isso dá cerca de 740 eventos/s, contra 96 a 168 eventos/s
publicados. O backlog cresce cerca de 600 eventos por segundo de carga, e a idade do mais antigo chega a 4 min.
**Nenhum evento ficou para trás**: a outbox zerou depois de cada cenário. Não conferi evento a evento o que o
consumidor simulado recebeu. O atraso, porém, é real.

Duas causas, uma do ambiente e outra do desenho:

1. **MiniStack**. O emulador é um processo Python que fica em cerca de 97% de CPU (um núcleo) a execução inteira.
   Medições feitas durante o experimento:
   - na primeira tentativa, sem consumidor de eventos, a fila `wager-events` acumulou 80 mil mensagens, cada
     `SendMessage` levava cerca de 90 ms e a publicação caiu para cerca de 105 eventos/s;
   - com o emulador reiniciado (fila vazia), a publicação subiu para cerca de 370 eventos/s;
   - mesmo com o consumidor simulado, a vazão cai do cenário A (cerca de 160/s) para o C (cerca de 98/s) dentro da
     mesma execução.

   A AWS SQS não tem esse limite de um núcleo, então **estes números não dizem quanto o publicador entregaria na AWS**.
2. **Desenho do publicador**. O envio é evento a evento (`SendMessage`), em sequência, dentro de cada um dos 2
   publicadores (app2 e app3). A vazão máxima é cerca de 2 / latência do `SendMessage`. Mesmo com 10 ms por envio,
   seriam cerca de 200 eventos/s, abaixo dos 740 gerados.

   O `SendMessageBatch` (até 10 por chamada), envios em paralelo dentro do lote ou mais publicadores aumentariam a
   vazão. O `SendMessageBatch` foi adiado na 002 (R-34) porque falhas parciais complicam a marca. Este teste mostra o
   custo dessa decisão: sob carga sustentada acima de cerca de 100 a 170 eventos/s, neste ambiente, o atraso da outbox
   cresce sem limite enquanto a carga durar.

### 4.5 O que os números **não** provam

- **Não são capacidade de produção.** Cliente, 3 instâncias, banco e emulador dividem os 12 threads de uma máquina de
  desktop, numa VM WSL2 do Docker Desktop no Windows. O gerador de carga em Bun também consome CPU.
- **Laço fechado subestima a latência.** Cada worker só manda a próxima requisição quando a anterior volta, então,
  quando o servidor fica lento, a taxa de chegada cai junto (*coordinated omission*). Num modelo de chegada aberta
  (taxa fixa), a p99 em saturação seria pior. Não medi a curva latência × taxa nem o ponto de saturação; só
  concorrência 32.
- **A mistura é favorável.** Não há rejeições, reversões, pendências nem fila de entrada (só HTTP). O consumidor da
  fila e o worker de PENDING_REFERENCE ficaram ociosos.
- **Amostra pequena.** São 3 execuções de 30 s por cenário. A variação entre execuções (até 2× no cenário B) mostra que
  intervalos de confiança exigiriam mais repetições e execuções mais longas.
- **O banco não foi zerado** entre execuções, e a tendência de queda no throughput pode vir disso.
- **Fila emulada.** Os números da outbox dependem do MiniStack (§4.4). A AWS SQS real não foi testada.
- **Sem profiling.** As causas do teto do cenário A e da cauda do cenário B são hipóteses compatíveis com os dados,
  não diagnósticos.

## 5. Como reproduzir

```bash
docker compose --profile cluster up -d --build
for p in 3001 3002 3003; do until curl -sf localhost:$p/health/ready > /dev/null; do sleep 1; done; done
bun run test:load
```

Para repetir em condições iguais às deste relatório, antes de cada execução espere `outbox_pending_events` voltar a 0
e reinicie o emulador, que volta sem filas:

```bash
docker compose restart sqs && docker compose run --rm queue-init
```

Parâmetros por env (padrões entre parênteses):

| Variável | Padrão | Função |
|---|---|---|
| `LOAD_URLS` | `http://localhost:3001,…:3002,…:3003` | instâncias, alternadas em round-robin |
| `LOAD_WALLETS` | 200 | wallets do cenário A e C |
| `LOAD_CONCURRENCY` | 32 | requisições em voo |
| `LOAD_DURATION_S` | 30 | duração de cada cenário |
| `LOAD_WARMUP_S` | 5 | aquecimento, não medido |
| `LOAD_DUPLICATE_RATIO` | 0.2 | fração de reenvios no cenário C |
| `LOAD_SCENARIOS` | `A,B,C` | cenários a rodar |
| `LOAD_EVENT_SINK` | ligado | `0` desliga o consumidor de eventos simulado |
| `LOAD_DRAIN_TIMEOUT_S` | 1200 | espera máxima pela outbox vazia |

O resultado sai como tabela no terminal e como JSON em `load/results/load-<execução>.json`. Esses arquivos são
ignorados pelo git, exceto o `example.json` curado. O script sai com código 1 se a verificação final falhar.
