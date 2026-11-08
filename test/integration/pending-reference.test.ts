// T098 — PENDING_REFERENCE: operação que chega antes da referência (US6 cenários 1 a 3; FR-023, FR-045, FR-047, I-15,
// I-21, I-26, I-33, I-39).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { startApp, type RunningApp } from '../support/app-harness.ts';
import { wagerRequest, type WagerKind, type WagerRequest } from '../support/factories.ts';
import { fetcherFor, type Fetcher, type TransactionResultBody, type WalletBody } from '../support/http.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('pending_reference');
const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
let running: RunningApp;
let http: Fetcher;

beforeAll(async () => {
  running = await startApp({ databaseUrl: database.url });
  http = fetcherFor(running.baseUrl);
});
afterAll(async () => {
  await running?.close();
});

interface OutboxRow extends Record<string, unknown> {
  id: string;
  aggregate_id: string;
  event_type: string;
  event_version: number;
  correlation_id: string;
  occurred_at: Date;
  payload: {
    eventId: string;
    eventType: string;
    aggregateId: string;
    correlationId: string;
    occurredAt: string;
    version: number;
    causationId?: string;
    data: Record<string, unknown>;
  };
}

const eventsOf = (transactionId: string) =>
  database.db.query<OutboxRow>(
    `SELECT id, aggregate_id, event_type, event_version, correlation_id, occurred_at, payload
       FROM outbox_messages WHERE payload->'data'->>'transactionId' = ? ORDER BY id`,
    [transactionId],
  );

interface TxRow extends Record<string, unknown> {
  status: string;
  failure_code: string | null;
  reference_transaction_id: string | null;
  reference_external_transaction_id: string | null;
  reference_attempts: number;
  next_reference_attempt_at: Date | null;
  created_at: Date;
  processed_at: Date | null;
  observed_balance: string;
  observed_balance_currency: string;
  correlation_id: string;
}

const txRow = async (transactionId: string) =>
  (
    await database.db.query<TxRow>(
      `SELECT status, failure_code, reference_transaction_id, reference_external_transaction_id, reference_attempts,
              next_reference_attempt_at, created_at, processed_at, observed_balance, observed_balance_currency, correlation_id
         FROM wager_transactions WHERE id = ?`,
      [transactionId],
    )
  )[0];

const walletRow = async (walletId: string) =>
  (await database.db.query<{ balance: string; version: number }>('SELECT balance, version FROM wallets WHERE id = ?', [walletId]))[0];

const ledgerCount = async (walletId: string) =>
  (await database.db.query('SELECT id FROM wallet_ledger_entries WHERE wallet_id = ?', [walletId])).length;

function op(kind: WagerKind, wallet: WalletBody, amount: string, referenceExternalTransactionId?: string, extra: Partial<WagerRequest> = {}) {
  return wagerRequest(kind, {
    walletId: wallet.id,
    playerId: wallet.playerId,
    money: { amount, currency: 'BRL' },
    ...(referenceExternalTransactionId !== undefined ? { referenceExternalTransactionId } : {}),
    ...extra,
  });
}

describe('referência inexistente (cenário 1)', () => {
  test('ROLLBACK de id externo inexistente → 202 PENDING_REFERENCE, saldo inalterado, sem failureCode e sem lançamento', async () => {
    const wallet = await openWallet(http, '100.00');
    const ledgerBefore = await ledgerCount(wallet.id);
    const request = op('ROLLBACK', wallet, '25.00', `never-arrived-${crypto.randomUUID()}`);
    const response = await submitWager<TransactionResultBody>(http, request, { 'X-Correlation-Id': 'corr-pending-1' });

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      transactionId: expect.stringMatching(UUIDV7),
      status: 'PENDING_REFERENCE',
      balance: { amount: '100.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(await walletRow(wallet.id)).toEqual({ balance: '100.00', version: 1 });
    expect(await ledgerCount(wallet.id)).toBe(ledgerBefore);

    // por SQL: tentativas 0 e primeira tentativa agendada para criação + 5 s (base do I-21)
    const row = await txRow(response.body.transactionId);
    expect(row).toMatchObject({
      status: 'PENDING_REFERENCE',
      failure_code: null,
      reference_transaction_id: null,
      reference_external_transaction_id: request.referenceExternalTransactionId,
      reference_attempts: 0,
      processed_at: null,
      observed_balance: '100.00',
      observed_balance_currency: 'BRL',
      correlation_id: 'corr-pending-1',
    });
    expect(row!.next_reference_attempt_at!.getTime()).toBe(row!.created_at.getTime() + 5000);

    // evento: só WagerTransactionPendingReference, nenhum WalletBalanceChanged
    const events = await eventsOf(response.body.transactionId);
    expect(events.map((e) => e.event_type)).toEqual(['WagerTransactionPendingReference']);
    const [event] = events;
    expect(event!.id).toMatch(UUIDV7);
    expect(event!.payload.eventId).toBe(event!.id);
    expect(event!.payload.aggregateId).toBe(wallet.id);
    expect(event!.aggregate_id).toBe(wallet.id);
    expect(event!.payload.correlationId).toBe('corr-pending-1');
    expect(event!.correlation_id).toBe('corr-pending-1');
    expect(event!.payload.occurredAt).toMatch(ISO_8601);
    expect(new Date(event!.payload.occurredAt).getTime()).toBe(event!.occurred_at.getTime());
    expect(event!.payload.eventType).toBe('WagerTransactionPendingReference');
    expect(event!.payload.version).toBe(1);
    expect(event!.event_version).toBe(1);
    expect(event!.payload.causationId).toBeUndefined();
    expect(event!.payload.data).toEqual({
      transactionId: response.body.transactionId,
      providerId: request.providerId,
      externalTransactionId: request.externalTransactionId,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: request.roundId,
      gameId: request.gameId,
      kind: 'ROLLBACK',
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: request.referenceExternalTransactionId,
      nextAttemptAt: row!.next_reference_attempt_at!.toISOString(),
    });
    expect(await database.db.query("SELECT id FROM outbox_messages WHERE aggregate_id = ? AND event_type = 'WalletBalanceChanged'", [wallet.id])).toHaveLength(
      1, // só o da abertura
    );
    await assertWalletMatchesLedger(database.db, wallet.id);
  });

  test('REFUND e WIN com referência inexistente também ficam PENDING_REFERENCE (I-15, I-46)', async () => {
    const wallet = await openWallet(http, '50.00');
    for (const kind of ['REFUND', 'WIN', 'LOSS'] as const) {
      const response = await submitWager<TransactionResultBody>(http, op(kind, wallet, '10.00', `missing-${crypto.randomUUID()}`));
      expect(response.status, kind).toBe(202);
      expect(response.body).toMatchObject({ status: 'PENDING_REFERENCE', balance: { amount: '50.00', currency: 'BRL' } });
      expect(response.body.failureCode).toBeUndefined();
      expect(response.body.retryable).toBeUndefined();
    }
    expect(await walletRow(wallet.id)).toEqual({ balance: '50.00', version: 1 });
    await assertWalletMatchesLedger(database.db, wallet.id);
  });

  test('a referência de outro provedor com o mesmo id externo não é encontrada → PENDING_REFERENCE', async () => {
    const wallet = await openWallet(http, '100.00');
    const sharedExternalId = `shared-${crypto.randomUUID()}`;
    const betOfB = op('BET', wallet, '25.00', undefined, { providerId: 'provider-b', externalTransactionId: sharedExternalId });
    expect((await submitWager(http, betOfB)).status).toBe(201);

    const refundOfA = op('REFUND', wallet, '25.00', sharedExternalId, { providerId: 'provider-a' });
    const response = await submitWager<TransactionResultBody>(http, refundOfA);
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ status: 'PENDING_REFERENCE', balance: { amount: '75.00', currency: 'BRL' } });
    expect((await txRow(response.body.transactionId))?.reference_transaction_id).toBeNull();
    expect(await walletRow(wallet.id)).toEqual({ balance: '75.00', version: 2 });
    await assertWalletMatchesLedger(database.db, wallet.id);
  });
});

describe('referência existente porém pendente (cenário 2)', () => {
  test('reversão referenciando uma transação PENDING_REFERENCE também fica PENDING_REFERENCE', async () => {
    const wallet = await openWallet(http, '100.00');
    const refund = op('REFUND', wallet, '25.00', `missing-bet-${crypto.randomUUID()}`);
    const refundResponse = await submitWager<TransactionResultBody>(http, refund);
    expect(refundResponse.status).toBe(202);

    const rollback = op('ROLLBACK', wallet, '25.00', refund.externalTransactionId);
    const response = await submitWager<TransactionResultBody>(http, rollback);
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ status: 'PENDING_REFERENCE', balance: { amount: '100.00', currency: 'BRL' } });
    // a referência existe, mas não foi resolvida (só PROCESSED grava reference_transaction_id)
    expect(await txRow(response.body.transactionId)).toMatchObject({
      status: 'PENDING_REFERENCE',
      reference_transaction_id: null,
      reference_external_transaction_id: refund.externalTransactionId,
    });
    expect((await eventsOf(response.body.transactionId)).map((e) => e.event_type)).toEqual(['WagerTransactionPendingReference']);
    expect(await walletRow(wallet.id)).toEqual({ balance: '100.00', version: 1 });
    await assertWalletMatchesLedger(database.db, wallet.id);
  });

  test('referência pendente e inconsistente é rejeitada na hora (I-44): rodada diferente → 422 REFERENCE_MISMATCH', async () => {
    const wallet = await openWallet(http, '100.00');
    const refund = op('REFUND', wallet, '25.00', `missing-bet-${crypto.randomUUID()}`, { roundId: 'round-A' });
    expect((await submitWager(http, refund)).status).toBe(202);

    const rollback = op('ROLLBACK', wallet, '25.00', refund.externalTransactionId, { roundId: 'round-B' });
    const response = await submitWager<TransactionResultBody>(http, rollback);
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_MISMATCH' });
    await assertWalletMatchesLedger(database.db, wallet.id);
  });
});

describe('replay (cenário 3)', () => {
  test('a mesma requisição reenviada → 202 com o mesmo transactionId e idempotentReplay true, sem evento novo', async () => {
    const wallet = await openWallet(http, '100.00');
    const request = op('ROLLBACK', wallet, '25.00', `never-arrived-${crypto.randomUUID()}`);
    const original = await submitWager<TransactionResultBody>(http, request, { 'X-Correlation-Id': 'corr-pending-original' });
    expect(original.status).toBe(202);

    // o saldo muda entre o original e o replay; o replay devolve o saldo observado original
    expect((await submitWager(http, op('BET', wallet, '10.00'))).status).toBe(201);
    const replay = await submitWager<TransactionResultBody>(http, request, { 'X-Correlation-Id': 'corr-pending-replay' });
    expect(replay.status).toBe(202);
    expect(replay.body).toEqual({
      transactionId: original.body.transactionId,
      status: 'PENDING_REFERENCE',
      balance: { amount: '100.00', currency: 'BRL' },
      idempotentReplay: true,
    });
    expect(replay.headers.get('x-correlation-id')).toBe('corr-pending-replay');
    expect((await txRow(original.body.transactionId))?.correlation_id).toBe('corr-pending-original');
    expect(await eventsOf(original.body.transactionId)).toHaveLength(1);
    expect(await database.db.query("SELECT id FROM outbox_messages WHERE correlation_id = 'corr-pending-replay'")).toEqual([]);
    await assertWalletMatchesLedger(database.db, wallet.id);
  });
});
