# Review Checklist: diff contra os Princípios II a V

**Feature**: `001-wagering-transaction-core` | **Gate**: "Revisão" da constitution | **Usado por**: T127, T128,
T129, T130 e T131

Para cada item, marcar **OK**, **N/A** (o diff não toca o assunto) ou **FALHA** (com arquivo e linha). Um item em
FALHA volta para a task de origem antes do checkpoint.

- [ ] **Dinheiro sem `number`**: nenhum `number`, `parseFloat(`, `Number(` ou `+valor` em dinheiro; valores como
  `Money` no domínio, string decimal nos contratos e eventos, e `new DecimalType('string')` nas colunas
  monetárias (constitution II).
- [ ] **Saldo só sob lock**: toda escrita que muda saldo ou status de transação acontece dentro de
  `transactional()`, com a wallet travada (`FOR UPDATE`) e só pelo EntityManager da transação, nunca por outra
  conexão do pool (constitution III, R-19).
- [ ] **Unicidade no banco**: as unicidades do diff têm `UNIQUE` ou índice único no banco, e o código trata
  `23505` pelo nome da constraint; nenhuma garantia só no código nem em memória (constitution IV e V).
- [ ] **Outbox na mesma transação**: eventos gravados na outbox na mesma transação SQL do efeito; nada publicado
  nem enviado antes do commit (constitution IV).
- [ ] **Triggers presentes**: as migrations mantêm os triggers de guarda e os `CHECK`s da data-model §2 (ledger
  imutável, encadeamento, saldo = cauda do ledger, transições, versão), com `up` e `down` (constitution V).
- [ ] **Sem mock em integração e concorrência**: nenhum `mock(`, `jest.`, `spyOn` em repositório ou banco, nem
  banco em memória em `test/integration` ou `test/concurrency`, e nenhum `TRUNCATE`, `DELETE`,
  `session_replication_role` ou `DISABLE TRIGGER` como limpeza (constitution VII, T118).
- [ ] **Sem relógio nem id no domínio**: nenhum `new Date()` sem argumento, `Date.now(`, `randomUUID(` ou
  `randomUUIDv7(` em `src/**/domain` e `src/**/application`; tempo pela porta `Clock` e ids pela porta
  `IdGenerator`; `new Date(x)` com argumento é permitido (constitution VI, T118).
