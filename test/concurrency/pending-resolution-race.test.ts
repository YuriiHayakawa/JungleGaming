// T069 — corrida entre o worker e a BET que resolve a pendente (FR-024, FR-026, FR-028; I-21, I-63, I-73; constitution
// III; falha eliminatória 2), repetida 20 vezes: 2 instâncias com o worker em varredura curta (base 50 ms, sem esgotar)
// reavaliam um REFUND pendente sem parar; a BET referenciada chega por HTTP por uma terceira instância (sem worker) num
// momento aleatório. O REFUND termina PROCESSED uma única vez, nunca REFERENCE_NOT_FOUND por corrida, com exatamente um
// CREDIT de reversão; assertWalletMatchesLedger em cada repetição. PostgreSQL real, processos reais.
import { afterAll, expect, test } from 'bun:test';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { wagerRequest } from '../support/factories.ts';
import { fetcherFor } from '../support/http.ts';
import { startInstance, type Instance } from '../support/instance-cluster.ts';
import { PENDING_WORKER_ENV, effectsOf, transactionByExternalId } from '../support/pending.ts';
import { waitFor } from '../support/sqs-client.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('pending_resolution_race');
const instances: Instance[] = [];
const ROUNDS = 20;

afterAll(async () => {
  for (const instance of instances) await instance.stop();
});

test(`worker × BET que resolve a pendente, ${ROUNDS} rodadas: PROCESSED uma vez, um CREDIT, nunca REFERENCE_NOT_FOUND`, async () => {
  const [workerA, workerB, front] = await Promise.all([
    startInstance({ databaseUrl: database.url, roles: { pendingWorker: true }, env: PENDING_WORKER_ENV }),
    startInstance({ databaseUrl: database.url, roles: { pendingWorker: true }, env: PENDING_WORKER_ENV }),
    startInstance({ databaseUrl: database.url, env: PENDING_WORKER_ENV }),
  ]);
  instances.push(workerA!, workerB!, front!);
  const http = fetcherFor(front!.baseUrl);

  for (let round = 0; round < ROUNDS; round++) {
    const wallet = await openWallet(http, '100.00');
    const bet = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId });
    const refund = wagerRequest('REFUND', {
      walletId: wallet.id,
      playerId: wallet.playerId,
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect((await submitWager(http, refund)).status).toBe(202);
    await Bun.sleep(Math.floor(Math.random() * 400)); // o worker já reavalia; a BET chega num momento qualquer
    expect((await submitWager(http, bet)).status).toBe(201);

    await waitFor(
      async () => (await transactionByExternalId(database.db, refund.externalTransactionId)).status !== 'PENDING_REFERENCE',
      10_000,
      20,
    );
    const row = await transactionByExternalId(database.db, refund.externalTransactionId);
    expect(row.failure_code, `round ${round}`).toBeNull();
    expect(row.status, `round ${round}`).toBe('PROCESSED');
    const betRow = await transactionByExternalId(database.db, bet.externalTransactionId);
    expect(row.reference_transaction_id).toBe(betRow.id);
    const { ledger, events } = await effectsOf(database.db, row.id);
    expect(ledger, `round ${round}`).toEqual([{ direction: 'CREDIT', amount: '10.00' }]);
    expect(events.sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    await assertWalletMatchesLedger(database.db, wallet.id);
  }
  // As reavaliações aconteceram de fato nas duas instâncias (a corrida foi exercitada).
  const evaluated = (instance: Instance) => instance.logs.filter((l) => l.includes('pending_worker.evaluated')).length;
  expect(evaluated(workerA!)).toBeGreaterThan(0);
  expect(evaluated(workerB!)).toBeGreaterThan(0);
}, 180_000);
