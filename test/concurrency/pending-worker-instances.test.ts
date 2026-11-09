// T068 — worker de PENDING_REFERENCE em 3 instâncias (US4 cenário 5; FR-028; SC-005, SC-008): 30 pendentes (REFUND) cujas
// referências (BET) chegam juntas, por HTTP, nas três instâncias. Cada pendente é concluída uma única vez, com no máximo
// um lançamento e um evento de conclusão; termina com assertAllWalletsMatchLedger. PostgreSQL real, processos reais.
import { afterAll, expect, test } from 'bun:test';
import { assertAllWalletsMatchLedger } from '../support/assert-wallet-matches-ledger.ts';
import { wagerRequest, type WagerRequest } from '../support/factories.ts';
import { fetcherFor } from '../support/http.ts';
import { startInstance, type Instance } from '../support/instance-cluster.ts';
import { PENDING_WORKER_ENV, effectsOf, transactionByExternalId } from '../support/pending.ts';
import { waitFor } from '../support/sqs-client.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('pending_worker_instances');
const instances: Instance[] = [];

afterAll(async () => {
  for (const instance of instances) await instance.stop();
});

test('3 instâncias, 30 pendentes cujas referências chegam juntas: cada uma concluída uma única vez', async () => {
  instances.push(
    ...(await Promise.all(
      [0, 1, 2].map(() => startInstance({ databaseUrl: database.url, roles: { pendingWorker: true }, env: PENDING_WORKER_ENV })),
    )),
  );
  const https = instances.map((i) => fetcherFor(i.baseUrl));

  const bets: WagerRequest[] = [];
  const refunds: WagerRequest[] = [];
  for (let w = 0; w < 10; w++) {
    const wallet = await openWallet(https[w % 3]!, '1000.00');
    for (let k = 0; k < 3; k++) {
      const bet = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId });
      const refund = wagerRequest('REFUND', {
        walletId: wallet.id,
        playerId: wallet.playerId,
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      expect((await submitWager(https[(w + k) % 3]!, refund)).status).toBe(202);
      bets.push(bet);
      refunds.push(refund);
    }
  }
  // As pendentes já estão sendo reavaliadas pelas três instâncias; as referências chegam juntas.
  await Bun.sleep(300);
  const responses = await Promise.all(bets.map((bet, i) => submitWager(https[i % 3]!, bet)));
  expect(responses.every((r) => r.status === 201)).toBe(true);

  await waitFor(async () => {
    const rows = await Promise.all(refunds.map((r) => transactionByExternalId(database.db, r.externalTransactionId)));
    return rows.every((row) => row.status !== 'PENDING_REFERENCE');
  }, 30_000, 100);

  for (const refund of refunds) {
    const row = await transactionByExternalId(database.db, refund.externalTransactionId);
    expect(row.status).toBe('PROCESSED');
    const { ledger, events } = await effectsOf(database.db, row.id);
    expect(ledger).toEqual([{ direction: 'CREDIT', amount: '10.00' }]);
    expect(events.sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  }
  expect(await assertAllWalletsMatchLedger(database.db)).toBe(10);
}, 120_000);
