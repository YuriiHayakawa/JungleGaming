// T070 — ordem das pendentes da mesma referência (US4 cenário 4; FR-026; I-16, I-63), repetida 10 vezes: um REFUND e
// depois um ROLLBACK pendentes da mesma BET, com 3 instâncias de worker; a BET chega → o mais antigo (REFUND) é aplicado e
// o outro fica REJECTED ALREADY_REVERSED, sempre nessa ordem. PostgreSQL real, processos reais.
import { afterAll, expect, test } from 'bun:test';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { wagerRequest } from '../support/factories.ts';
import { fetcherFor } from '../support/http.ts';
import { startInstance, type Instance } from '../support/instance-cluster.ts';
import { PENDING_WORKER_ENV, effectsOf, transactionByExternalId } from '../support/pending.ts';
import { waitFor } from '../support/sqs-client.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('pending_order');
const instances: Instance[] = [];
const ROUNDS = 10;

afterAll(async () => {
  for (const instance of instances) await instance.stop();
});

test(`REFUND e ROLLBACK pendentes da mesma BET, ${ROUNDS} rodadas com 3 workers: o mais antigo aplicado, o outro ALREADY_REVERSED`, async () => {
  instances.push(
    ...(await Promise.all(
      [0, 1, 2].map(() => startInstance({ databaseUrl: database.url, roles: { pendingWorker: true }, env: PENDING_WORKER_ENV })),
    )),
  );
  const https = instances.map((i) => fetcherFor(i.baseUrl));

  for (let round = 0; round < ROUNDS; round++) {
    const wallet = await openWallet(https[round % 3]!, '100.00');
    const base = { walletId: wallet.id, playerId: wallet.playerId };
    const bet = wagerRequest('BET', base);
    const refund = wagerRequest('REFUND', { ...base, referenceExternalTransactionId: bet.externalTransactionId });
    const rollback = wagerRequest('ROLLBACK', { ...base, referenceExternalTransactionId: bet.externalTransactionId });
    expect((await submitWager(https[0]!, refund)).status).toBe(202);
    await Bun.sleep(5); // created_at estritamente crescente
    expect((await submitWager(https[1]!, rollback)).status).toBe(202);
    await Bun.sleep(Math.floor(Math.random() * 200));
    expect((await submitWager(https[2]!, bet)).status).toBe(201);

    await waitFor(async () => {
      const rows = await Promise.all([refund, rollback].map((r) => transactionByExternalId(database.db, r.externalTransactionId)));
      return rows.every((row) => row.status !== 'PENDING_REFERENCE');
    }, 10_000, 20);
    const older = await transactionByExternalId(database.db, refund.externalTransactionId);
    const newer = await transactionByExternalId(database.db, rollback.externalTransactionId);
    expect(older.created_at.getTime()).toBeLessThan(newer.created_at.getTime());
    expect({ round, status: older.status, code: older.failure_code }).toEqual({ round, status: 'PROCESSED', code: null });
    expect({ round, status: newer.status, code: newer.failure_code }).toEqual({ round, status: 'REJECTED', code: 'ALREADY_REVERSED' });
    expect((await effectsOf(database.db, older.id)).ledger).toEqual([{ direction: 'CREDIT', amount: '10.00' }]);
    expect((await effectsOf(database.db, newer.id)).ledger).toEqual([]);
    await assertWalletMatchesLedger(database.db, wallet.id);
  }
}, 180_000);
