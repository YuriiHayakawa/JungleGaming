// T068 — POST /wagering/transactions (US2 cenários 1, 2 e 5; FR-016, FR-027, FR-036, FR-040, FR-045, FR-047, FR-054,
// FR-061, I-18, I-19, I-20, I-33, I-45, I-54).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { startApp, type RunningApp } from '../support/app-harness.ts';
import { wagerRequest } from '../support/factories.ts';
import { fetcherFor, type ErrorBody, type Fetcher, type TransactionResultBody } from '../support/http.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('submit_transaction');
const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MONEY_PROPS = { amount: expect.stringMatching(/^\d+\.\d{2}$/), currency: expect.stringMatching(/^[A-Z]{3}$/) };
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
  payload: { eventId: string; eventType: string; aggregateId: string; correlationId: string; occurredAt: string; version: number; data: Record<string, unknown> };
}

const eventsOf = (transactionId: string) =>
  database.db.query<OutboxRow>(
    `SELECT id, aggregate_id, event_type, event_version, correlation_id, occurred_at, payload
       FROM outbox_messages WHERE payload->'data'->>'transactionId' = ? ORDER BY id`,
    [transactionId],
  );

const walletRow = async (walletId: string) =>
  (await database.db.query<{ balance: string; version: number }>('SELECT balance, version FROM wallets WHERE id = ?', [walletId]))[0];

const ledgerOf = (transactionId: string) =>
  database.db.query('SELECT direction, amount, currency, balance_before, balance_after FROM wallet_ledger_entries WHERE transaction_id = ?', [
    transactionId,
  ]);

/** Envelope de cada evento: campos do FR-047, coerentes com a linha da outbox. */
function expectEnvelope(row: OutboxRow, walletId: string, correlationId: string): void {
  expect(row.id).toMatch(UUIDV7);
  expect(row.payload.eventId).toBe(row.id);
  expect(row.payload.aggregateId).toBe(walletId);
  expect(row.aggregate_id).toBe(walletId);
  expect(row.payload.correlationId).toBe(correlationId);
  expect(row.correlation_id).toBe(correlationId);
  expect(row.payload.occurredAt).toMatch(ISO_8601);
  expect(new Date(row.payload.occurredAt).getTime()).toBe(row.occurred_at.getTime());
  expect(row.payload.eventType).toBe(row.event_type);
  expect(row.payload.version).toBe(1);
  expect(row.event_version).toBe(1);
}

describe('BET aplicada (cenário 1)', () => {
  test('BET 25.00 sobre 1000.00 → 201 PROCESSED, saldo 975.00; lançamento, version, saldo observado e eventos', async () => {
    const wallet = await openWallet(http, '1000.00');
    const request = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '25.00', currency: 'BRL' } });
    const response = await submitWager(http, request, { 'X-Correlation-Id': 'corr-bet-1' });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      transactionId: expect.stringMatching(UUIDV7),
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    const transactionId = response.body.transactionId;

    expect(await ledgerOf(transactionId)).toEqual([
      { direction: 'DEBIT', amount: '25.00', currency: 'BRL', balance_before: '1000.00', balance_after: '975.00' },
    ]);
    expect(await walletRow(wallet.id)).toEqual({ balance: '975.00', version: 2 });

    const [tx] = await database.db.query(
      `SELECT provider_id, external_transaction_id, idempotency_key, kind, status, amount, currency, observed_balance,
              observed_balance_currency, correlation_id, failure_code, processed_at IS NOT NULL AS processed, payload_hash
         FROM wager_transactions WHERE id = ?`,
      [transactionId],
    );
    expect(tx).toMatchObject({
      provider_id: request.providerId,
      external_transaction_id: request.externalTransactionId,
      idempotency_key: `${request.providerId}:${request.externalTransactionId}`,
      kind: 'BET',
      status: 'PROCESSED',
      amount: '25.00',
      currency: 'BRL',
      observed_balance: '975.00',
      observed_balance_currency: 'BRL',
      correlation_id: 'corr-bet-1',
      failure_code: null,
      processed: true,
    });
    expect((tx as { payload_hash: string }).payload_hash).toMatch(/^[0-9a-f]{64}$/);

    const events = await eventsOf(transactionId);
    expect(events.map((e) => e.event_type)).toEqual(['WalletBalanceChanged', 'WagerTransactionProcessed']);
    const [changed, processed] = events as [OutboxRow, OutboxRow];
    for (const row of events) expectEnvelope(row, wallet.id, 'corr-bet-1');
    expect(new Set(events.map((e) => e.id)).size).toBe(2);
    // ordem de gravação (data-model §1): WalletBalanceChanged antes do evento de status
    expect(changed.id < processed.id).toBe(true);
    expect(new Date(changed.payload.occurredAt).getTime()).toBeLessThanOrEqual(new Date(processed.payload.occurredAt).getTime());

    expect(changed.payload.data).toEqual({
      walletId: wallet.id,
      transactionId,
      direction: 'DEBIT',
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '1000.00', currency: 'BRL' },
      balanceAfter: { amount: '975.00', currency: 'BRL' },
      walletVersion: 2,
    });
    expect(processed.payload.data).toEqual({
      transactionId,
      providerId: request.providerId,
      externalTransactionId: request.externalTransactionId,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: request.roundId,
      gameId: request.gameId,
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      balance: { amount: '975.00', currency: 'BRL' },
      walletVersion: 2,
    });
    for (const value of [changed.payload.data.money, changed.payload.data.balanceBefore, changed.payload.data.balanceAfter, processed.payload.data.money, processed.payload.data.balance]) {
      expect(value).toEqual(MONEY_PROPS);
    }

    await assertWalletMatchesLedger(database.db, wallet.id);
  });

  test('o amount é normalizado ("25" → "25.00") e o walletId em maiúsculas encontra a wallet (I-01, I-58)', async () => {
    const wallet = await openWallet(http, '100.00');
    const request = wagerRequest('BET', { walletId: wallet.id.toUpperCase(), playerId: wallet.playerId, money: { amount: '25', currency: 'BRL' } });
    const response = await submitWager(http, request);
    expect(response.status).toBe(201);
    expect(response.body.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    const [tx] = await database.db.query('SELECT wallet_id, amount FROM wager_transactions WHERE id = ?', [response.body.transactionId]);
    expect(tx).toEqual({ wallet_id: wallet.id, amount: '25.00' });
    await assertWalletMatchesLedger(database.db, wallet.id);
  });
});

describe('rejeições de negócio → 422 com TransactionResult (I-45)', () => {
  test('BET 25.00 sobre 10.00 → INSUFFICIENT_FUNDS; transação persistida, sem lançamento, version inalterada, evento Rejected (cenário 2)', async () => {
    const wallet = await openWallet(http, '10.00');
    const request = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '25.00', currency: 'BRL' } });
    const response = await submitWager(http, request, { 'X-Correlation-Id': 'corr-reject-1' });

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      transactionId: expect.stringMatching(UUIDV7),
      status: 'REJECTED',
      balance: { amount: '10.00', currency: 'BRL' },
      idempotentReplay: false,
      failureCode: 'INSUFFICIENT_FUNDS',
      retryable: false,
    });
    const transactionId = response.body.transactionId;
    const [tx] = await database.db.query(
      'SELECT status, failure_code, observed_balance, observed_balance_currency, processed_at FROM wager_transactions WHERE id = ?',
      [transactionId],
    );
    expect(tx).toEqual({
      status: 'REJECTED',
      failure_code: 'INSUFFICIENT_FUNDS',
      observed_balance: '10.00',
      observed_balance_currency: 'BRL',
      processed_at: null,
    });
    expect(await ledgerOf(transactionId)).toEqual([]);
    expect(await walletRow(wallet.id)).toEqual({ balance: '10.00', version: 1 });

    const events = await eventsOf(transactionId);
    expect(events.map((e) => e.event_type)).toEqual(['WagerTransactionRejected']);
    const rejected = events[0]!;
    expectEnvelope(rejected, wallet.id, 'corr-reject-1');
    expect(rejected.payload.data).toEqual({
      transactionId,
      providerId: request.providerId,
      externalTransactionId: request.externalTransactionId,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: request.roundId,
      gameId: request.gameId,
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      failureCode: 'INSUFFICIENT_FUNDS',
      retryable: false,
      balance: { amount: '10.00', currency: 'BRL' },
    });
    await assertWalletMatchesLedger(database.db, wallet.id);
  });

  test('WIN 10.00 sem referência sobre 9999999999999990.00 → BALANCE_LIMIT_EXCEEDED, sem efeito no saldo (cenário 5, I-54)', async () => {
    const wallet = await openWallet(http, '9999999999999990.00');
    const request = wagerRequest('WIN', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '10.00', currency: 'BRL' } });
    const response = await submitWager(http, request);
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'BALANCE_LIMIT_EXCEEDED',
      retryable: false,
      balance: { amount: '9999999999999990.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(await walletRow(wallet.id)).toEqual({ balance: '9999999999999990.00', version: 1 });
    expect(await ledgerOf(response.body.transactionId)).toEqual([]);
    await assertWalletMatchesLedger(database.db, wallet.id);
  });

  test('jogador que não é dono → WALLET_PLAYER_MISMATCH (I-19)', async () => {
    const wallet = await openWallet(http, '100.00');
    const request = wagerRequest('BET', { walletId: wallet.id, playerId: `${wallet.playerId}-other` });
    const response = await submitWager(http, request);
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ status: 'REJECTED', failureCode: 'WALLET_PLAYER_MISMATCH', retryable: false, balance: { amount: '100.00', currency: 'BRL' } });
    expect(await walletRow(wallet.id)).toEqual({ balance: '100.00', version: 1 });
    await assertWalletMatchesLedger(database.db, wallet.id);
  });

  test('USD em wallet BRL → CURRENCY_MISMATCH; saldo observado na moeda da wallet (I-19)', async () => {
    const wallet = await openWallet(http, '100.00');
    const request = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '5.00', currency: 'USD' } });
    const response = await submitWager(http, request);
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ status: 'REJECTED', failureCode: 'CURRENCY_MISMATCH', balance: { amount: '100.00', currency: 'BRL' } });
    const [tx] = await database.db.query('SELECT currency, observed_balance_currency FROM wager_transactions WHERE id = ?', [response.body.transactionId]);
    expect(tx).toEqual({ currency: 'USD', observed_balance_currency: 'BRL' });
    expect(await walletRow(wallet.id)).toEqual({ balance: '100.00', version: 1 });
    await assertWalletMatchesLedger(database.db, wallet.id);
  });
});

describe('wallet inexistente (I-20)', () => {
  test('→ 404 WALLET_NOT_FOUND, sem linha em wager_transactions e sem evento', async () => {
    const request = wagerRequest('BET', { walletId: '0192f291-27dd-7d3f-8071-000000000000', playerId: 'nobody' });
    const response = await submitWager<ErrorBody>(http, request, { 'X-Correlation-Id': 'corr-404' });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: 'WALLET_NOT_FOUND', message: expect.any(String), retryable: false, correlationId: 'corr-404' },
    });
    const rows = await database.db.query('SELECT id FROM wager_transactions WHERE external_transaction_id = ?', [request.externalTransactionId]);
    expect(rows).toEqual([]);
    const events = await database.db.query("SELECT id FROM outbox_messages WHERE correlation_id = 'corr-404'");
    expect(events).toEqual([]);
  });
});

describe('contrato da resposta', () => {
  test('TransactionResult não traz failureCode nem retryable quando PROCESSED (FR-054)', async () => {
    const wallet = await openWallet(http, '50.00');
    const response = await submitWager<TransactionResultBody>(http, wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId }));
    expect(response.status).toBe(201);
    expect('failureCode' in response.body).toBe(false);
    expect('retryable' in response.body).toBe(false);
    await assertWalletMatchesLedger(database.db, wallet.id);
  });
});
