# Review Checklist: diff contra os Princípios II a V (feature 002)

**Feature**: `002-messaging-reliability` | **Gate**: "Revisão" da constitution | **Usado pelas tasks de revisão de cada
história e pela revisão final** (tasks.md)

Os sete primeiros itens são os da 001 (`specs/001-wagering-transaction-core/review-checklist.md`), que continuam
valendo; os quatro últimos são desta feature. Para cada item, marcar **OK**, **N/A** (o diff não toca o assunto) ou
**FALHA** (com arquivo e linha). Um item em FALHA volta para a task de origem antes do checkpoint.

- [ ] **Dinheiro sem `number`**: nenhum `number`, `parseFloat(`, `Number(` ou `+valor` em dinheiro; valores como
  `Money` no domínio, string decimal nos contratos, mensagens e eventos, e `new DecimalType('string')` nas colunas
  monetárias (constitution II).
- [ ] **Saldo só sob lock**: toda escrita que muda saldo ou status de transação acontece dentro de
  `transactional()`, com a wallet travada (`FOR UPDATE`) e só pelo EntityManager da transação, nunca por outra
  conexão do pool (constitution III, 001 R-19). Vale para o consumidor e para o worker de PENDING_REFERENCE.
- [ ] **Unicidade no banco**: as unicidades do diff têm `UNIQUE`, PK ou índice único no banco, e o código trata
  `23505` pelo nome da constraint (inclusive `inbox_messages_pk`); nenhuma garantia só no código nem em memória
  (constitution IV e V).
- [ ] **Outbox na mesma transação**: eventos gravados na outbox na mesma transação SQL do efeito, junto com a inbox
  quando a entrada é a fila; nada publicado nem enviado antes do commit (constitution IV).
- [ ] **Triggers presentes**: as migrations mantêm os triggers de guarda e os `CHECK`s da data-model da 001 e da 002
  (ledger imutável, encadeamento, saldo = cauda do ledger, transições, versão, inbox imutável), com `up` e `down`
  (constitution V).
- [ ] **Sem mock em integração e concorrência**: nenhum `mock(`, `jest.`, `spyOn` em repositório, banco ou cliente SQS,
  nenhum banco em memória e nenhum `SqsPort` falso em `test/integration` ou `test/concurrency` (o fake de SQS só vale
  em `test/unit`); nenhum `TRUNCATE`, `DELETE`, `session_replication_role` ou `DISABLE TRIGGER` como limpeza; nenhum
  `PurgeQueue` como limpeza (constitution VII, T118 da 001 estendido).
- [ ] **Sem relógio nem id no domínio**: nenhum `new Date()` sem argumento, `Date.now(`, `randomUUID(`,
  `randomUUIDv7(` ou `Math.random(` em `src/**/domain` e `src/**/application`; tempo pela porta `Clock`, ids pela
  `IdGenerator` e jitter pela `RandomSource` (constitution VI).
- [ ] **Ordem de lock wallet primeiro**: nenhuma transação escreve linhas de `wager_transactions` antes de travar a
  wallet, exceto o claim do worker (só `FOR UPDATE SKIP LOCKED`, nunca espera) e a antecipação, que roda depois do lock
  da wallet da transação de origem (plan, "Ordem única de lock"; research R-26).
- [ ] **Ack só depois do commit**: o `DeleteMessage` de uma mensagem processada só acontece depois que a transação
  com o efeito (ou com a inbox do replay) foi confirmada; nenhum ack com transação aberta ou desfeita (FR-005, I-28).
- [ ] **DLQ antes de apagar da fila principal**: toda mensagem que a aplicação manda à DLQ é enviada (`SendMessage`
  aceito, com `errorCode` e `errorClass`) antes do `DeleteMessage` na fila principal (FR-040, I-68, I-70, I-71).
- [ ] **Publisher marca como publicado só depois do SendMessage**: `published_at` só é gravado depois do envio aceito
  pela fila de eventos; a marca é idempotente (`WHERE published_at IS NULL`); falha de envio só reagenda (FR-019,
  I-31, I-65).
