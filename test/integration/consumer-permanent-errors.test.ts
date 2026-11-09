// T050 — erros permanentes (US2 cenário 3; FR-010, FR-040; I-28, I-60, I-66, I-68, I-69, I-70; SC-004): cada caso vai à
// DLQ no 1º recebimento, com os atributos de contracts/queues.md, sai da fila principal e não grava nada (nem inbox).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { startApp, type RunningApp } from '../support/app-harness.ts';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { wagerRequest, type WagerRequest } from '../support/factories.ts';
import { fetcherFor, type WalletBody } from '../support/http.ts';
import { newMessageId, sendEnvelope, wagerEnvelope } from '../support/messages.ts';
import { deleteMessage, receive, sendRaw, waitForEmpty, type ReceivedMessage } from '../support/sqs-client.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { useTestQueues } from '../support/test-queues.ts';
import { openWallet } from '../support/wagering.ts';

const database = useTestDatabase('consumer_permanent');
const queues = useTestQueues('consumer-permanent');
const CONSUMER = 'wager-transactions-consumer';
let app: RunningApp;
let wallet: WalletBody;

beforeAll(async () => {
  app = await startApp({ databaseUrl: database.url, roles: { consumer: true }, queues: queues.env(), env: { CONSUMER_WAIT_SECONDS: '1' } });
  wallet = await openWallet(fetcherFor(app.baseUrl), '100.00');
});

afterAll(async () => {
  await app?.close();
});

/**
 * Tudo o que já foi lido da DLQ neste arquivo. Cada mensagem lida é apagada da DLQ: a DLQ é FIFO, e uma mensagem lida
 * e não apagada bloquearia o grupo (a wallet) para as próximas.
 */
const seenInDlq: ReceivedMessage[] = [];

async function dlqMessageWithBody(body: string, timeoutMs = 10_000): Promise<ReceivedMessage> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = seenInDlq.find((m) => m.body === body);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`message not found in DLQ: ${body.slice(0, 120)}`);
    for (const message of await receive(queues.urls.dlq, { max: 10, waitSeconds: 1 })) {
      seenInDlq.push(message);
      await deleteMessage(queues.urls.dlq, message.receiptHandle);
    }
  }
}

async function expectPermanent(body: string, errorCode: string) {
  const message = await dlqMessageWithBody(body);
  expect(message.attributes).toEqual({ errorCode, errorClass: 'permanent', receiveCount: '1', consumer: CONSUMER });
  await waitForEmpty(queues.urls.transactions, 5_000);
  return message;
}

async function sendBody(body: string, groupId = wallet.id) {
  await sendRaw(queues.urls.transactions, body, { groupId, deduplicationId: newMessageId('dedup') });
}

const bet = (overrides: Partial<WagerRequest> = {}) => wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, ...overrides });

async function expectNothingRecorded(externalId: string, messageId?: string) {
  expect(await database.db.query('SELECT 1 FROM wager_transactions WHERE external_transaction_id = ?', [externalId])).toHaveLength(0);
  if (messageId) expect(await database.db.query('SELECT 1 FROM inbox_messages WHERE message_id = ?', [messageId])).toHaveLength(0);
}

describe('MALFORMED_MESSAGE', () => {
  test('corpo que não é JSON', async () => {
    await sendBody('this is not json');
    await expectPermanent('this is not json', 'MALFORMED_MESSAGE');
  }, 20_000);

  test('envelope incompleto (sem occurredAt)', async () => {
    const envelope = wagerEnvelope(bet()) as unknown as Record<string, unknown>;
    delete envelope.occurredAt;
    const body = JSON.stringify(envelope);
    await sendBody(body);
    const message = await expectPermanent(body, 'MALFORMED_MESSAGE');
    expect(message.groupId).toBe(wallet.id);
    await expectNothingRecorded((envelope.data as WagerRequest).externalTransactionId);
  }, 20_000);

  test('messageId fora do formato', async () => {
    const envelope = wagerEnvelope(bet(), { messageId: 'id with spaces' });
    const body = JSON.stringify(envelope);
    await sendBody(body);
    await expectPermanent(body, 'MALFORMED_MESSAGE');
    await expectNothingRecorded(envelope.data.externalTransactionId);
  }, 20_000);
});

describe('UNSUPPORTED_MESSAGE_TYPE, VALIDATION_ERROR e OPENING_NOT_ALLOWED', () => {
  test('type "Other"', async () => {
    const envelope = wagerEnvelope(bet(), { type: 'Other' });
    const body = JSON.stringify(envelope);
    await sendBody(body);
    const message = await expectPermanent(body, 'UNSUPPORTED_MESSAGE_TYPE');
    expect(message.deduplicationId).toBe(envelope.messageId);
    await expectNothingRecorded(envelope.data.externalTransactionId, envelope.messageId);
  }, 20_000);

  test('amount numérico', async () => {
    const envelope = wagerEnvelope(bet()) as unknown as { messageId: string; data: Record<string, unknown> };
    envelope.data.money = { amount: 10, currency: 'BRL' };
    const body = JSON.stringify(envelope);
    await sendBody(body);
    await expectPermanent(body, 'VALIDATION_ERROR');
    await expectNothingRecorded(String(envelope.data.externalTransactionId), envelope.messageId);
  }, 20_000);

  test('autorreferência (I-60)', async () => {
    const request = wagerRequest('REFUND', { walletId: wallet.id, playerId: wallet.playerId, referenceExternalTransactionId: 'self-1', externalTransactionId: 'self-1' });
    const envelope = wagerEnvelope(request);
    const body = JSON.stringify(envelope);
    await sendBody(body);
    await expectPermanent(body, 'VALIDATION_ERROR');
    await expectNothingRecorded('self-1', envelope.messageId);
  }, 20_000);

  test('providerId "system"', async () => {
    const envelope = wagerEnvelope(bet({ providerId: 'system' }));
    const body = JSON.stringify(envelope);
    await sendBody(body);
    await expectPermanent(body, 'VALIDATION_ERROR');
    await expectNothingRecorded(envelope.data.externalTransactionId, envelope.messageId);
  }, 20_000);

  test('kind OPENING', async () => {
    const envelope = wagerEnvelope(bet()) as unknown as { messageId: string; data: Record<string, unknown> };
    envelope.data.kind = 'OPENING';
    const body = JSON.stringify(envelope);
    await sendBody(body);
    await expectPermanent(body, 'OPENING_NOT_ALLOWED');
    await expectNothingRecorded(String(envelope.data.externalTransactionId), envelope.messageId);
  }, 20_000);
});

describe('WALLET_NOT_FOUND, INBOX_PAYLOAD_MISMATCH e IDEMPOTENCY_CONFLICT', () => {
  test('wallet inexistente', async () => {
    const missing = '0192f291-27dd-7d3f-8071-000000000000';
    const envelope = wagerEnvelope(wagerRequest('BET', { walletId: missing, playerId: 'p' }));
    const body = JSON.stringify(envelope);
    await sendEnvelope(queues.urls.transactions, envelope);
    await expectPermanent(body, 'WALLET_NOT_FOUND');
    await expectNothingRecorded(envelope.data.externalTransactionId, envelope.messageId);
  }, 20_000);

  test('mesmo messageId com outro conteúdo de negócio: venenosa, sem efeito novo', async () => {
    const original = wagerEnvelope(bet({ money: { amount: '1.00', currency: 'BRL' } }));
    await sendEnvelope(queues.urls.transactions, original);
    await waitForEmpty(queues.urls.transactions, 5_000);
    const poisoned = { ...original, data: { ...original.data, money: { amount: '2.00', currency: 'BRL' } } };
    const body = JSON.stringify(poisoned);
    await sendEnvelope(queues.urls.transactions, poisoned, { deduplicationId: newMessageId('again') });
    await expectPermanent(body, 'INBOX_PAYLOAD_MISMATCH');
    const inbox = await database.db.query('SELECT 1 FROM inbox_messages WHERE message_id = ?', [original.messageId]);
    expect(inbox).toHaveLength(1);
    const txs = await database.db.query<{ amount: string }>('SELECT amount FROM wager_transactions WHERE external_transaction_id = ?', [
      original.data.externalTransactionId,
    ]);
    expect(txs).toEqual([{ amount: '1.00' }]);
    await assertWalletMatchesLedger(database.db, wallet.id);
  }, 20_000);

  test('mesma chave com outro conteúdo: IDEMPOTENCY_CONFLICT sem linha de inbox (I-68)', async () => {
    const first = wagerEnvelope(bet({ money: { amount: '1.00', currency: 'BRL' } }));
    await sendEnvelope(queues.urls.transactions, first);
    await waitForEmpty(queues.urls.transactions, 5_000);
    const conflicting = wagerEnvelope({ ...first.data, money: { amount: '3.00', currency: 'BRL' } }, { idempotencyKey: first.data.idempotencyKey });
    const body = JSON.stringify(conflicting);
    await sendEnvelope(queues.urls.transactions, conflicting);
    await expectPermanent(body, 'IDEMPOTENCY_CONFLICT');
    expect(await database.db.query('SELECT 1 FROM inbox_messages WHERE message_id = ?', [conflicting.messageId])).toHaveLength(0);
    await assertWalletMatchesLedger(database.db, wallet.id);
  }, 20_000);

  test('mesmo id externo com outra chave: IDEMPOTENCY_CONFLICT sem linha de inbox (I-68)', async () => {
    const first = wagerEnvelope(bet({ money: { amount: '1.00', currency: 'BRL' } }));
    await sendEnvelope(queues.urls.transactions, first);
    await waitForEmpty(queues.urls.transactions, 5_000);
    const otherKey = wagerEnvelope(first.data, { idempotencyKey: `other-key-${crypto.randomUUID()}` });
    const body = JSON.stringify(otherKey);
    await sendEnvelope(queues.urls.transactions, otherKey);
    await expectPermanent(body, 'IDEMPOTENCY_CONFLICT');
    expect(await database.db.query('SELECT 1 FROM inbox_messages WHERE message_id = ?', [otherKey.messageId])).toHaveLength(0);
    const [row] = await database.db.query<{ count: string }>('SELECT count(*)::text AS count FROM wager_transactions WHERE external_transaction_id = ?', [
      first.data.externalTransactionId,
    ]);
    expect(row?.count).toBe('1');
    await assertWalletMatchesLedger(database.db, wallet.id);
  }, 20_000);
});
