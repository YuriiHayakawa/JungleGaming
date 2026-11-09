# Review Checklist: diff contra os Princípios II a V e VIII (feature 003)

**Feature**: `003-reconciliation-health-metrics` | **Gate**: "Revisão" da constitution | **Usado pelas tasks de revisão
de cada história e pela revisão final** (tasks.md)

Os itens da 001 e da 002 que esta feature pode tocar continuam valendo; os seis últimos são desta feature. Para cada
item, marcar **OK**, **N/A** (o diff não toca o assunto) ou **FALHA** (com arquivo e linha). Um item em FALHA volta para
a task de origem antes do checkpoint.

- [ ] **Dinheiro sem `number`**: nenhum `number`, `parseFloat(`, `Number(` ou `+valor` em dinheiro; saldos e diferenças
  como `Money`; o SQL devolve `numeric` como texto (`::text`); respostas com string de 2 casas (constitution II).
- [ ] **Nenhuma escrita nova**: o diff não grava em `wallets`, `wallet_ledger_entries`, `wager_transactions`,
  `inbox_messages` nem `outbox_messages`; nenhum `INSERT`, `UPDATE` ou `DELETE` em `src/reconciliation/**`,
  `src/health/**`, `src/metrics/**` nem no `OutboxLagReader` (constitution III e IV).
- [ ] **Triggers presentes**: nenhuma migration alterada ou removida; nenhum trigger ou guarda desligado em nenhum banco
  migrado por completo (constitution V).
- [ ] **Sem mock em integração e concorrência**: PostgreSQL e MiniStack reais; indisponibilidade só por proxy TCP real;
  nenhum `mock(`, `spyOn` em banco ou SQS, fake de `SqsPort`, `TRUNCATE`, `DELETE`, `PurgeQueue`,
  `session_replication_role` nem `DISABLE TRIGGER` (constitution VII, guardrails T118 e T084 da 002).
- [ ] **Sem relógio nem id no domínio**: nenhum `new Date()` sem argumento, `Date.now(`, `randomUUID(` ou `Math.random(`
  em `src/**/domain` e `src/**/application`; a idade da outbox usa a porta `Clock` (constitution VI).
- [ ] **Erros no envelope único**: 400, 404, 500 e 503 da reconciliação no formato do I-38, com `retryable` da
  taxonomia; health fora do envelope por definição (I-75) (constitution VIII).
- [ ] **Reconciliação somente leitura num snapshot**: transação `REPEATABLE READ` com `READ ONLY` imposto pelo banco;
  saldo e agregado do ledger lidos na mesma transação; nenhum `FOR UPDATE`/`FOR SHARE`; soma e cadeia calculadas no
  banco, sem carregar os lançamentos na aplicação (I-37, I-74; FR-002, FR-009, FR-010).
- [ ] **Divergência sinalizada e nunca corrigida**: `consistent` false na resposta 200, log em nível `error` sem valores
  monetários (`walletId`, `correlationId`, `checkedEntries`, `firstBrokenSeq`, `consistent`), +1 em
  `reconciliation_divergences_total`; nenhum caminho que ajuste saldo ou ledger (enunciado §9; FR-008).
- [ ] **Divergência testada sem desligar guardas**: os testes de divergência usam só `useBareTestDatabase` (migrations de
  tabelas, sem a `Migration20261107000400`); a comparação também é testada como função pura (R-37, R-38).
- [ ] **Health correto**: live sem consultar dependências; ready com prazo de 2 s por checagem, em paralelo, 503 com o
  estado de cada dependência e 503 durante o encerramento (`isDraining`); drenagem antes do `app.close()`; corpo
  próprio; log em `debug` (I-75; FR-013 a FR-018; R-39, R-40).
- [ ] **Métricas de baixa cardinalidade e sem dinheiro**: rótulos só da lista fechada (`status`, `source`, `worker`,
  `errorCode`, `errorClass`, `outcome`, `kind`); nunca `walletId`, `providerId`, ids nem valores; histogramas com
  memória limitada; gauges da outbox lidos na coleta e omitidos se o banco falhar (I-76; FR-020 a FR-024; R-42 a R-44).
- [ ] **Endpoints sem autenticação**: reconciliação, health e métricas marcados com `@Public()` e testados sem credencial
  (FR-018, FR-019; SC-009).
