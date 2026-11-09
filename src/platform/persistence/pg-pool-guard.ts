import type { Pool, PoolClient } from 'pg';

/**
 * Devolve ao pool, descartando-o, o cliente que perde a conexão enquanto está emprestado (R-12, FR-043, T110).
 *
 * Por que existe: o MikroORM 7 executa transações pelo kysely, cujo `rollback()` e `commit()` só chamam
 * `release()` depois que o comando dá certo. Numa conexão que caiu no meio da transação os dois sempre falham, e o
 * cliente ficava emprestado para sempre: cada queda vazava um slot do pool até o pool esgotar e toda requisição
 * virar 503 por timeout de aquisição, além de travar o `pool.end()` no encerramento. Provado por
 * `test/integration/db-unavailable.test.ts` (corte no meio da transação).
 *
 * Como funciona, só com a API pública do `pg`: os eventos `acquire` e `release` do pool dizem quais clientes estão
 * emprestados; quando um deles emite `end` (conexão encerrada, esperada ou não), o guarda chama `release(err)`, que
 * faz o pg-pool remover e destruir o cliente. Depois disso o `release` do cliente vira no-op, porque o kysely ainda
 * pode chamá-lo no `finally` de uma leitura fora de transação; o cliente destruído nunca volta a ser emprestado.
 * A requisição que estava usando o cliente já recebeu o erro de conexão e responde 503 depois do rollback.
 */
export function releaseClientsLostWhileCheckedOut(pool: Pool): void {
  const checkedOut = new Set<PoolClient>();
  const guarded = new WeakSet<PoolClient>();

  pool.on('acquire', (client) => {
    checkedOut.add(client);
    if (guarded.has(client)) return;
    guarded.add(client);
    client.once('end', () => {
      if (!checkedOut.has(client)) return;
      checkedOut.delete(client);
      const release = client.release;
      client.release = () => {};
      release(new Error('connection lost while checked out'));
    });
  });
  pool.on('release', (_err, client) => {
    checkedOut.delete(client);
  });
  pool.on('remove', (client) => {
    checkedOut.delete(client);
  });
}
