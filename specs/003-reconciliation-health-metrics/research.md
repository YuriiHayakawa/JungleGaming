# Research: Reconciliação, Health Checks e Métricas

**Feature**: `003-reconciliation-health-metrics` | **Data**: 2026-11-09 | **Plan**: [plan.md](plan.md)

As decisões da 001 (R-01 a R-19) e da 002 (R-20 a R-35) continuam valendo. Esta feature acrescenta R-36 a R-45. Não há
spike (decisão do usuário): nenhuma tecnologia nova entra; tudo o que é usado aqui (transações do MikroORM com nível de
isolamento, funções de janela do PostgreSQL, `GetQueueAttributes` pela porta `SqsPort`, proxy TCP de teste, container
de teste) já foi exercitado nas features anteriores.

## 1. Versões

Nenhuma dependência nova (R-20 continua sendo a única dependência acrescentada desde a 001). O formato de texto do
Prometheus é escrito à mão (I-76).

## 2. Decisões

### R-36 Reconciliação num snapshot somente leitura, calculada no banco

- **Decision**: a reconciliação roda numa transação `REPEATABLE READ` e `READ ONLY` (I-37, I-74), aberta por um fork do
  EM, com duas leituras no mesmo snapshot:
  1. a wallet (`balance`, `currency`), **sem** `FOR UPDATE`;
  2. uma única consulta agregada sobre `wallet_ledger_entries` da wallet, com `lag(balance_after) OVER (ORDER BY seq)`,
     que devolve: quantidade de lançamentos, soma com sinal (`CREDIT` +, `DEBIT` −) como texto, o menor `seq` em que o
     elo quebra (`balance_before` ≠ `after` anterior, ou primeiro `before` ≠ 0), e o `seq` e o `balance_after` do
     último lançamento.
  Os valores numéricos chegam como string (`numeric::text`) e viram `Money` (decimal.js). A comparação é uma função
  pura (R-37). O `READ ONLY` é imposto pelo banco (`SET TRANSACTION READ ONLY` como primeira instrução, ou a opção
  equivalente da transação do MikroORM), não por convenção.
- **Rationale**: em `REPEATABLE READ`, as duas leituras veem o mesmo instante; como toda escrita que muda saldo grava
  wallet e lançamento na mesma transação (001/FR-040), uma transação concorrente aparece inteira ou não aparece, então
  não há falso positivo (FR-002, SC-003). Sem `FOR UPDATE`, a reconciliação não espera nem bloqueia escritas (FR-010).
  O agregado no banco mantém a memória constante (FR-009) e usa o índice `ledger_wallet_seq_idx (wallet_id, seq)` da
  001.
- **Alternatives**: `READ COMMITTED` com duas consultas (rejeitado: um commit entre as duas daria falso positivo);
  `FOR SHARE` na wallet (rejeitado: bloqueia escritas e não é necessário com snapshot); carregar o ledger e conferir na
  aplicação (rejeitado: memória proporcional ao ledger, contra o I-74).

### R-37 Comparação como função pura de domínio

- **Decision**: `reconcile(input)` em `src/reconciliation/domain/`, sem I/O, recebe `storedBalance`, `calculatedBalance`
  (`Money`), `checkedEntries`, `firstBrokenLinkSeq` (ou ausente), `lastSeq` e `lastBalanceAfter` (ou ausentes, sem
  lançamentos) e devolve o resultado com `difference`, `chainConsistent`, `firstBrokenSeq` e `consistent`. Regras:
  - `difference = stored − calculated` (`Money.subtract`, com sinal);
  - quebra de elo → `firstBrokenSeq` = o menor `seq` quebrado;
  - sem quebra de elo e com lançamentos, `lastBalanceAfter ≠ stored` → quebra na cauda, `firstBrokenSeq = lastSeq`;
  - sem lançamentos → cadeia íntegra por vacuidade (a divergência aparece em `difference` se o saldo não for 0.00);
  - `consistent = difference.isZero() && chainConsistent`.
  `firstBrokenSeq` é exposto como inteiro JSON; o `seq` (bigint) é convertido só depois de conferido como inteiro seguro.
- **Rationale**: a regra que decide `consistent` fica testável em unitário, com todos os casos de borda (vazio, só
  soma, só cadeia, cauda, diferença negativa), como pede o usuário; o banco só agrega.
- **Alternatives**: decidir no SQL (rejeitado: regra financeira fora do domínio, difícil de testar isoladamente).

### R-38 Divergência provocada num banco sem as guardas, nunca desligando triggers

- **Decision**: as guardas do armazenamento (`Migration20261107000400`: ledger imutável e encadeado, saldo = cauda do
  ledger, transições) tornam impossível produzir uma divergência num banco migrado. O caminho de divergência é testado
  num banco **criado só com as migrations de tabelas** (`Migration20261107000100` a `…000300`: wallets, transações,
  ledger e outbox), sem a `…000400` e sem as da 002 (a da inbox depende da função `jg_forbid_mutation` da `…000400`).
  - `runMigrations(url, 'up', { to })` ganha o parâmetro `to` (o `migrator.up({ to })` do MikroORM);
  - o suporte de teste ganha `useBareTestDatabase(tag)`: cria um banco vazio (sem o template), aplica as migrations até
    `Migration20261107000300` e o apaga no fim;
  - a app sobe contra esse banco (o boot não valida o schema; só as tabelas usadas pela reconciliação e pela criação de
    wallet e submissão HTTP precisam existir); o teste cria wallets e transações pela API e provoca a divergência com
    `UPDATE` direto (`wallets.balance`, `wallet_ledger_entries.balance_before`), o que só é possível porque as guardas
    não existem ali.
  Nunca `DISABLE TRIGGER`, `session_replication_role`, `DELETE` nem `TRUNCATE` (T118 da 001); o guardrail continua
  valendo e ganha uma regra: `useBareTestDatabase` só pode ser importado pelos testes que provocam divergência (reconciliação e
  métricas; T034 desta feature).
- **Rationale**: prova o caminho de erro com o banco real, sem enfraquecer nenhuma guarda num banco que as tem.
- **Alternatives**: `DISABLE TRIGGER` ou `session_replication_role` (proibidos); só unitário (insuficiente: o SQL do
  agregado e da cadeia também precisa ser provado contra dados quebrados).

### R-39 Readiness: checagens em paralelo, prazo de 2 s, fila checada em todo papel

- **Decision**: `GET /health/ready` roda em paralelo:
  - **postgres**: `SELECT 1` num fork do EM;
  - **sqs**: `approximateCounts` (`GetQueueAttributes`) pela `SqsPort` da 002, para as três filas da configuração
    (transações, DLQ e eventos);
  cada uma com prazo fixo de 2 s (`Promise.race` com temporizador cancelado no fim; I-75). Resultado: `up` ou `down` por
  dependência; 200 se as duas estão `up` e a instância não está encerrando; senão 503. A agregação é uma função pura
  (testada em unitário). Liveness não consulta nada.
- **Rationale**: o prazo próprio garante resposta mesmo com conexão pendurada (FR-015); em paralelo, a pior resposta
  leva cerca de 2 s (SC-004). O enunciado §9 define ready como "PostgreSQL e SQS alcançáveis", sem exceção por papel.
- **Alternatives**: checar só as dependências do papel ligado (rejeitado: contraria o enunciado §9 e o I-75);
  `ListQueues` (rejeitado: não prova que as filas desta configuração existem).

### R-40 Readiness 503 durante o encerramento: drenar antes de fechar o servidor HTTP

- **Decision**: o `app.close()` do Nest fecha o servidor HTTP antes de disparar os `onApplicationShutdown`; durante a
  drenagem dos trabalhadores (002, R-28), ninguém conseguiria consultar o ready. O encerramento passa a ser:
  1. o handler de sinal (002, R-35) chama `gracefulShutdown(app)`;
  2. `gracefulShutdown` chama `WorkerRegistry.drainAll(prazo)` **com o HTTP ainda aberto** e, só então, `app.close()`;
  3. o `WorkerRegistry` ganha `isDraining()` (true desde a primeira chamada de `drainAll`); o ready responde 503 quando
     `isDraining()`;
  4. dentro do `app.close()`, a chamada do `OrmLifecycle` a `drainAll` devolve a mesma promessa, já resolvida
     (idempotente desde a 002).
  O handler continua ignorando sinais repetidos e mantém o temporizador de segurança (prazo + 5 s). Os testes em
  processo usam o mesmo `gracefulShutdown(app)` (o harness o expõe), e o teste em container consulta o ready de dentro
  do container durante a drenagem.
- **Rationale**: FR-016/SC-006; é também o comportamento esperado por orquestradores: deixar de ser "pronta" antes de
  parar de atender. Durante a drenagem, o HTTP continua atendendo normalmente (as submissões em andamento terminam).
- **Alternatives**: `beforeApplicationShutdown` para drenar (rejeitado na 002, R-28, e ainda dependeria da ordem dos
  hooks); flag só no handler de sinal (rejeitado: com o servidor já fechado, ninguém lê o 503).

### R-41 Endpoints operacionais: sem autenticação, corpo próprio, log em debug

- **Decision**: os controllers de health e métricas e a rota de reconciliação levam um decorator `@Public()` (metadado
  lido pelo guard global, hoje `NoopAuthGuard`), para que continuem sem autenticação quando houver uma (I-41, I-75,
  I-76). Health responde com o próprio corpo, inclusive no 503 (status definido no controller, sem passar pelo filtro de
  exceções, fora do envelope do I-38). O middleware de log de requisição registra `/health/*` e `/metrics` em nível
  `debug` (as demais rotas continuam em `info`).
- **Rationale**: FR-018, FR-019; health e métricas são consultados a cada poucos segundos e não podem inundar o log.
- **Alternatives**: excluir as rotas do log (rejeitado: perde diagnóstico).

### R-42 Exposição Prometheus escrita à mão

- **Decision**: `renderPrometheus(snapshot, gauges)` em `src/platform/metrics/prometheus-text.ts`, função pura:
  formato de texto 0.0.4 (`Content-Type: text/plain; version=0.0.4; charset=utf-8`), `# HELP` e `# TYPE` por família,
  séries ordenadas por nome e rótulos, valores de rótulo escapados (`\\`, `\"`, `\n`), contadores, gauges e histogramas
  (`_bucket{le=…}` cumulativos, `+Inf`, `_sum`, `_count`). Os nomes da 002 são mantidos (`transactions_total`,
  `duplicates_total`, `retries_total`, `dlq_total`, `lock_conflicts_total`, `processing_latency_ms`, `outbox_lag_ms`),
  mais `reconciliation_divergences_total` e os gauges `outbox_pending_events` e `outbox_oldest_pending_age_seconds`.
- **Rationale**: I-76 (sem dependência nova); o formato é simples e estável; a função pura é testada em unitário contra
  exemplos esperados e com um parser mínimo de teste.
- **Alternatives**: `prom-client` (rejeitado: dependência nova); renomear para unidades base (`_seconds`) (rejeitado
  nesta feature: os nomes já são usados pelos testes e pelas notas da 002; a unidade fica explícita no sufixo `_ms`).

### R-43 Histogramas com buckets fixos e memória limitada; rótulos em lista permitida

- **Decision**: o `InMemoryMetrics` da 002 guarda todas as observações num array sem limite, o que vira vazamento de
  memória quando a exposição é usada em produção. Passa a guardar, por série de observação: contagem, soma, contagem
  por bucket (limites fixos em ms: 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000) e uma janela das
  últimas 1 000 observações, que mantém a API `observations()` usada pelos testes da 002. A porta passa a recusar (erro
  de programação) rótulos fora da lista permitida: `status`, `source`, `worker`, `errorCode`, `errorClass`, `outcome`,
  `kind`; o novo contador `reconciliation_divergences_total` entra em `COUNTER_NAMES`.
- **Rationale**: memória constante por série (FR-024); FR-023 imposto no código, não só por revisão (nenhum `walletId`,
  `providerId` ou id vira rótulo).
- **Alternatives**: resumo com quantis (rejeitado: não agrega entre instâncias); manter o array (rejeitado: cresce sem
  limite).

### R-44 Atraso da outbox medido na leitura

- **Decision**: `OutboxLagReader` (infraestrutura da outbox) roda, a cada leitura de `/metrics`, numa consulta só:
  `SELECT count(*), min(occurred_at) FROM outbox_messages WHERE published_at IS NULL`, coberta pelo índice parcial
  `outbox_pending_idx` da 001 (só linhas pendentes). A idade é `clock.now() − min(occurred_at)` em segundos (0 sem
  pendentes). Prazo de 2 s; falha ou prazo esgotado → os dois gauges são omitidos, a coleta responde 200 com o restante e
  uma linha `metrics.outbox_lag_unavailable` vai ao log em nível warn (FR-022).
- **Rationale**: I-76 ("calculado na hora da leitura, consulta barata"); o histograma `outbox_lag_ms` da 002 mede o
  atraso de quem já foi publicado, e o gauge mede o que está parado agora, inclusive com o publicador fora.
- **Alternatives**: gauge atualizado pelo publicador (rejeitado: com o publicador parado, o gauge congelaria no valor
  antigo, justamente quando importa).

### R-45 Testes

- **Decision** (matriz completa no plan):
  - unitário: `reconcile` (todas as regras), agregação do ready, `renderPrometheus`, histogramas e lista de rótulos do
    `InMemoryMetrics`, `gracefulShutdown` (ordem drenar → fechar, sinal repetido);
  - integração (PostgreSQL e MiniStack reais): reconciliação consistente depois de todos os tipos de transação (HTTP e
    fila), somente leitura, 404/400/503, correlationId; divergência no banco sem guardas (saldo, cadeia, cauda,
    diferença negativa, wallet sem lançamentos com saldo ≠ 0) com log e contador; health com proxies TCP (banco cortado,
    fila cortada com o POST funcionando, conexão pendurada) e durante o `gracefulShutdown`; métricas depois de
    operações reais, gauges da outbox contra o banco, banco fora na coleta, rótulos;
  - concorrência: 3 instâncias, 50 BETs concorrentes numa wallet enquanto outra instância reconcilia em laço: todas as
    leituras `consistent` true; SIGTERM em container com o ready lido de dentro do container durante a drenagem;
  - o suporte de teste ganha um modo "pendurado" no proxy TCP (`stall()`: aceita a conexão e não responde), para provar
    o prazo de 2 s sem esperar o timeout do driver.
- **Rationale**: constitution VII; SC-001 a SC-009.

## 3. Pendências

Nenhuma. Não há `NEEDS CLARIFICATION` no Technical Context.

## 4. Limitações (itens a escrever no `ARCHITECTURE.md`, adiado)

- A reconciliação só detecta; num banco com as guardas, uma divergência só aparece se alguém alterar o banco por fora
  das guardas (ou se as guardas tiverem defeito). Não há correção automática nem reconciliação em lote.
- As métricas são por instância e reiniciam com o processo; a agregação entre instâncias é do sistema de
  monitoramento.
- Os nomes das métricas de latência estão em milissegundos (`_ms`), não na unidade base do Prometheus.
- Readiness checa a fila mesmo numa instância só HTTP; com a fila fora, ela fica "não pronta" e continua atendendo.
