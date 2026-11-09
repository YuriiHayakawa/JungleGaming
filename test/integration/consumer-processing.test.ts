// T039 — consumo pela fila (US1 cenários 1, 5 e 6; FR-001, FR-003, FR-004, FR-005, FR-008, FR-037, FR-038; I-26,
// I-28, I-69; SC-010), com PostgreSQL e MiniStack reais, banco e filas próprios e a app com CONSUMER_ENABLED=true.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { computePayloadHash } from '../../src/wagering/application/payload-hash.ts';
import { startApp, type RunningApp } from '../support/app-harness.ts';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { wagerRequest } from '../support/factories.ts';
import { fetcherFor } from '../support/http.ts';
import { newMessageId, sendEnvelope, wagerEnvelope } from '../support/messages.ts';
import { counts, waitFor, waitForEmpty } from '../support/sqs-client.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { useTestQueues } from '../support/test-queues.ts';
import { openWallet } from '../support/wagering.ts';

const database = useTestDatabase('consumer_processing');
const queues = useTestQueues('consumer-processing');
const CONSUMER = 'wager-transactions-consumer';
let app: RunningApp;

beforeAll(async () => {
  app = await startApp({
    databaseUrl: database.url,
    roles: { consumer: true },
    queues: queues.env(),
    env: { CONSUMER_WAIT_SECONDS: '1' },
  });
});

afterAll(async () => {
  await app?.close();
});

const http = () => fetcherFor(app.baseUrl);

async function transactionByExternalId(externalId: string) {
  const rows = await database.db.query<{ id: string; status: string; failure_code: string | null; correlation_id: string }>(
    'SELECT id, status, failure_code, correlation_id FROM wager_transactions WHERE provider_id = ? AND external_transaction_id = ?',
    ['provider-a', externalId],
  );
  return rows[0];
}

async function waitForTransaction(externalId: string, timeoutMs = 5_000) {
  await waitFor(async () => (await transactionByExternalId(externalId)) !== undefined, timeoutMs);
  const tx = await transactionByExternalId(externalId);
  if (!tx) throw new Error('transaction not found');
  return tx;
}

const inboxRows = (messageId: string) =>
  database.db.query<{ consumer_name: string; message_id: string; payload_hash: string; transaction_id: string }>(
    'SELECT consumer_name, message_id, payload_hash, transaction_id FROM inbox_messages WHERE message_id = ?',
    [messageId],
  );

const eventsOf = (transactionId: string) =>
  database.db.query<{ event_type: string; correlation_id: string; payload: Record<string, unknown> }>(
    "SELECT event_type, correlation_id, payload FROM outbox_messages WHERE payload->'data'->>'transactionId' = ? ORDER BY occurred_at, event_type",
    [transactionId],
  );

describe('BET pela fila', () => {
  test('PROCESSED, saldo 975.00, um DEBIT, uma linha de inbox, eventos com correlationId = causationId = messageId; ack em até 2 s', async () => {
    const wallet = await openWallet(http(), '1000.00');
    const request = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '25.00', currency: 'BRL' } });
    const envelope = wagerEnvelope(request);
    const sentAt = performance.now();
    await sendEnvelope(queues.urls.transactions, envelope);

    const tx = await waitForTransaction(request.externalTransactionId);
    await waitForEmpty(queues.urls.transactions, 5_000);
    expect(performance.now() - sentAt).toBeLessThan(2_000 + 1_000); // SC-010 (2 s), com 1 s de folga do polling de contagem
    expect(tx.status).toBe('PROCESSED');
    expect(tx.correlation_id).toBe(envelope.messageId);

    const [walletRow] = await database.db.query<{ balance: string; version: number }>('SELECT balance, version FROM wallets WHERE id = ?', [wallet.id]);
    expect(walletRow?.balance).toBe('975.00');
    const debits = await database.db.query("SELECT 1 FROM wallet_ledger_entries WHERE transaction_id = ? AND direction = 'DEBIT'", [tx.id]);
    expect(debits).toHaveLength(1);

    const inbox = await inboxRows(envelope.messageId);
    expect(inbox).toEqual([
      { consumer_name: CONSUMER, message_id: envelope.messageId, payload_hash: computePayloadHash(request), transaction_id: tx.id },
    ]);

    const events = await eventsOf(tx.id);
    expect(events.map((e) => e.event_type).sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    for (const event of events) {
      expect(event.correlation_id).toBe(envelope.messageId);
      expect(event.payload.correlationId).toBe(envelope.messageId);
      expect(event.payload.causationId).toBe(envelope.messageId);
    }
    expect(await counts(queues.urls.transactions)).toEqual({ visible: 0, notVisible: 0 });
    await assertWalletMatchesLedger(database.db, wallet.id);
  });

  test('o mesmo envelope reenviado com outro MessageDeduplicationId: nenhum efeito novo, confirmado, inbox com uma linha', async () => {
    const wallet = await openWallet(http(), '1000.00');
    const request = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '25.00', currency: 'BRL' } });
    const envelope = wagerEnvelope(request);
    await sendEnvelope(queues.urls.transactions, envelope);
    const tx = await waitForTransaction(request.externalTransactionId);
    await waitForEmpty(queues.urls.transactions);
    const eventsBefore = (await eventsOf(tx.id)).length;

    await sendEnvelope(queues.urls.transactions, envelope, { deduplicationId: newMessageId('redelivery') });
    await waitForEmpty(queues.urls.transactions);

    const [walletRow] = await database.db.query<{ balance: string; version: number }>('SELECT balance, version FROM wallets WHERE id = ?', [wallet.id]);
    expect(walletRow).toEqual({ balance: '975.00', version: 2 });
    expect(await inboxRows(envelope.messageId)).toHaveLength(1);
    expect((await eventsOf(tx.id)).length).toBe(eventsBefore);
    const all = await database.db.query('SELECT 1 FROM wager_transactions WHERE wallet_id = ? AND kind = ?', [wallet.id, 'BET']);
    expect(all).toHaveLength(1);
    expect(
      app.logs.some((line) => line.includes(envelope.messageId) && line.includes('"outcome":"duplicate"')),
    ).toBe(true);
    await assertWalletMatchesLedger(database.db, wallet.id);
  });

  test('BET sem saldo → REJECTED INSUFFICIENT_FUNDS gravada, inbox gravada, mensagem confirmada (US1 cenário 5)', async () => {
    const wallet = await openWallet(http(), '10.00');
    const request = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '25.00', currency: 'BRL' } });
    const envelope = wagerEnvelope(request);
    await sendEnvelope(queues.urls.transactions, envelope);
    const tx = await waitForTransaction(request.externalTransactionId);
    await waitForEmpty(queues.urls.transactions);
    expect(tx).toMatchObject({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
    expect(await inboxRows(envelope.messageId)).toHaveLength(1);
    expect((await eventsOf(tx.id)).map((e) => e.event_type)).toEqual(['WagerTransactionRejected']);
    await assertWalletMatchesLedger(database.db, wallet.id);
  });

  test('REFUND com referência inexistente → PENDING_REFERENCE gravada, inbox gravada, mensagem confirmada (US1 cenário 6)', async () => {
    const wallet = await openWallet(http(), '100.00');
    const request = wagerRequest('REFUND', {
      walletId: wallet.id,
      playerId: wallet.playerId,
      referenceExternalTransactionId: `missing-${crypto.randomUUID()}`,
    });
    const envelope = wagerEnvelope(request);
    await sendEnvelope(queues.urls.transactions, envelope);
    const tx = await waitForTransaction(request.externalTransactionId);
    await waitForEmpty(queues.urls.transactions);
    expect(tx.status).toBe('PENDING_REFERENCE');
    expect(await inboxRows(envelope.messageId)).toHaveLength(1);
    expect((await eventsOf(tx.id)).map((e) => e.event_type)).toEqual(['WagerTransactionPendingReference']);
    await assertWalletMatchesLedger(database.db, wallet.id);
  });

  test('as linhas de log do processamento trazem messageId, correlationId, transactionId, walletId e providerId, sem valores monetários (FR-037)', async () => {
    const wallet = await openWallet(http(), '100.00');
    const request = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '12.34', currency: 'BRL' } });
    const envelope = wagerEnvelope(request);
    await sendEnvelope(queues.urls.transactions, envelope);
    const tx = await waitForTransaction(request.externalTransactionId);
    await waitForEmpty(queues.urls.transactions);

    const lines = app.logs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.messageId === envelope.messageId);
    expect(lines.length).toBeGreaterThan(0);
    const processed = lines.find((line) => line.msg === 'consumer.message');
    expect(processed).toMatchObject({
      messageId: envelope.messageId,
      correlationId: envelope.messageId,
      transactionId: tx.id,
      walletId: wallet.id,
      providerId: 'provider-a',
      outcome: 'processed',
    });
    for (const line of lines) {
      expect(line).not.toHaveProperty('amount');
      expect(line).not.toHaveProperty('money');
      expect(JSON.stringify(line)).not.toContain('12.34');
    }
    await assertWalletMatchesLedger(database.db, wallet.id);
  });
});
