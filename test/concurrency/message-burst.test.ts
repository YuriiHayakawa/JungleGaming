// T042 — rajada de entregas com 3 instâncias consumidoras reais (US1 cenário 2; FR-007; I-27, I-28; SC-001, SC-008).
// Para forçar entregas simultâneas em instâncias diferentes, as cópias vão em MessageGroupIds distintos (o grupo FIFO
// da wallet serializaria a entrega): a garantia de um único efeito tem de vir do banco, não da fila (constitution III).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { wagerRequest } from '../support/factories.ts';
import { startCluster, type Cluster } from '../support/instance-cluster.ts';
import { newMessageId, sendEnvelope, wagerEnvelope } from '../support/messages.ts';
import { counts, waitFor, waitForEmpty } from '../support/sqs-client.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { useTestQueues } from '../support/test-queues.ts';
import { openWallet } from '../support/wagering.ts';

const database = useTestDatabase('message_burst');
const queues = useTestQueues('message-burst');
const COPIES = 50;
let cluster: Cluster;

beforeAll(async () => {
  cluster = await startCluster({
    size: 3,
    databaseUrl: database.url,
    roles: { consumer: true },
    queues: queues.env(),
    env: { CONSUMER_WAIT_SECONDS: '1', CONSUMER_RETRY_BASE_SECONDS: '1' },
  });
}, 60_000);

afterAll(async () => {
  await cluster?.stop();
});

async function effects(externalId: string) {
  const txs = await database.db.query<{ id: string }>('SELECT id FROM wager_transactions WHERE external_transaction_id = ?', [externalId]);
  const ids = txs.map((t) => t.id);
  const ledger = ids.length
    ? await database.db.query('SELECT 1 FROM wallet_ledger_entries WHERE transaction_id = ANY(?)', [ids])
    : [];
  const events = ids.length
    ? await database.db.query("SELECT 1 FROM outbox_messages WHERE payload->'data'->>'transactionId' = ANY(?)", [ids])
    : [];
  return { txs: ids, ledger: ledger.length, events: events.length };
}

describe('50 entregas por 3 instâncias → 1 efeito', () => {
  test('(a) o mesmo envelope 50 vezes com MessageDeduplicationIds distintos: 1 transação, 1 lançamento, 1 linha de inbox, um conjunto de eventos', async () => {
    const wallet = await openWallet(cluster.fetch, '1000.00');
    const request = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '25.00', currency: 'BRL' } });
    const envelope = wagerEnvelope(request);
    await Promise.all(
      Array.from({ length: COPIES }, (_, i) =>
        sendEnvelope(queues.urls.transactions, envelope, { deduplicationId: newMessageId(`copy${i}`), groupId: `${wallet.id}-${i}` }),
      ),
    );

    await waitForEmpty(queues.urls.transactions, 90_000);
    const result = await effects(request.externalTransactionId);
    expect(result.txs).toHaveLength(1);
    expect(result.ledger).toBe(1);
    expect(result.events).toBe(2); // WalletBalanceChanged + WagerTransactionProcessed
    const inbox = await database.db.query<{ transaction_id: string }>('SELECT transaction_id FROM inbox_messages WHERE message_id = ?', [
      envelope.messageId,
    ]);
    expect(inbox).toEqual([{ transaction_id: result.txs[0]! }]);
    expect(await counts(queues.urls.dlq)).toEqual({ visible: 0, notVisible: 0 });
    const [row] = await database.db.query<{ balance: string }>('SELECT balance FROM wallets WHERE id = ?', [wallet.id]);
    expect(row?.balance).toBe('975.00');
    // as entregas foram distribuídas: mais de uma instância processou cópias
    const handledBy = cluster.instances.filter((i) => i.logs.some((l) => l.includes(envelope.messageId))).length;
    expect(handledBy).toBeGreaterThan(1);
    await assertWalletMatchesLedger(database.db, wallet.id);
  }, 120_000);

  test('(b) 50 envelopes com messageIds distintos, mesma chave e mesmo conteúdo: 1 efeito e 50 linhas de inbox na mesma transação', async () => {
    const wallet = await openWallet(cluster.fetch, '1000.00');
    const request = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '25.00', currency: 'BRL' } });
    const envelopes = Array.from({ length: COPIES }, () => wagerEnvelope(request));
    await Promise.all(
      envelopes.map((envelope, i) => sendEnvelope(queues.urls.transactions, envelope, { groupId: `${wallet.id}-${i}` })),
    );

    const ids = envelopes.map((e) => e.messageId);
    await waitFor(
      async () => (await database.db.query('SELECT 1 FROM inbox_messages WHERE message_id = ANY(?)', [ids])).length === COPIES,
      90_000,
      250,
    );
    await waitForEmpty(queues.urls.transactions, 30_000);
    const result = await effects(request.externalTransactionId);
    expect(result.txs).toHaveLength(1);
    expect(result.ledger).toBe(1);
    expect(result.events).toBe(2);
    const inbox = await database.db.query<{ transaction_id: string }>(
      'SELECT DISTINCT transaction_id FROM inbox_messages WHERE message_id = ANY(?)',
      [ids],
    );
    expect(inbox).toEqual([{ transaction_id: result.txs[0]! }]);
    expect(await counts(queues.urls.dlq)).toEqual({ visible: 0, notVisible: 0 });
    await assertWalletMatchesLedger(database.db, wallet.id);
  }, 120_000);
});
