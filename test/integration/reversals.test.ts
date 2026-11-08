// T092 — REFUND e ROLLBACK (US5 cenários 1 a 9; FR-019 a FR-026, FR-045, I-12 a I-18).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { startApp, type RunningApp } from '../support/app-harness.ts';
import { wagerRequest, type WagerKind, type WagerRequest } from '../support/factories.ts';
import { fetcherFor, type ErrorBody, type Fetcher, type TransactionResultBody, type WalletBody } from '../support/http.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('reversals');
let running: RunningApp;
let http: Fetcher;

beforeAll(async () => {
  running = await startApp({ databaseUrl: database.url });
  http = fetcherFor(running.baseUrl);
});
afterAll(async () => {
  await running?.close();
});

const walletRow = async (walletId: string) =>
  (await database.db.query<{ balance: string; version: number }>('SELECT balance, version FROM wallets WHERE id = ?', [walletId]))[0];

const ledgerOf = (transactionId: string) =>
  database.db.query<{ direction: string; amount: string; balance_before: string; balance_after: string }>(
    'SELECT direction, amount, balance_before, balance_after FROM wallet_ledger_entries WHERE transaction_id = ?',
    [transactionId],
  );

const eventTypesOf = async (transactionId: string) =>
  (
    await database.db.query<{ event_type: string }>(
      "SELECT event_type FROM outbox_messages WHERE payload->'data'->>'transactionId' = ? ORDER BY id",
      [transactionId],
    )
  ).map((row) => row.event_type);

const txRow = async (transactionId: string) =>
  (
    await database.db.query<{ status: string; failure_code: string | null; reference_transaction_id: string | null }>(
      'SELECT status, failure_code, reference_transaction_id FROM wager_transactions WHERE id = ?',
      [transactionId],
    )
  )[0];

/** Submete e exige o status HTTP esperado. */
async function submit(request: WagerRequest, expectedStatus: number) {
  const response = await submitWager<TransactionResultBody>(http, request);
  expect(response.status, JSON.stringify(response.body)).toBe(expectedStatus);
  return { request, result: response.body };
}

function op(kind: WagerKind, wallet: WalletBody, amount: string, reference?: WagerRequest): WagerRequest {
  return wagerRequest(kind, {
    walletId: wallet.id,
    playerId: wallet.playerId,
    money: { amount, currency: 'BRL' },
    ...(reference ? { referenceExternalTransactionId: reference.externalTransactionId } : {}),
  });
}

describe('reversões aplicadas', () => {
  test('REFUND 25.00 de BET 25.00 → 201 com CREDIT de 25.00 e referência resolvida (cenário 1)', async () => {
    const wallet = await openWallet(http, '1000.00');
    const bet = await submit(op('BET', wallet, '25.00'), 201);
    const refund = await submit(op('REFUND', wallet, '25.00', bet.request), 201);

    expect(refund.result).toMatchObject({ status: 'PROCESSED', balance: { amount: '1000.00', currency: 'BRL' }, idempotentReplay: false });
    expect(await ledgerOf(refund.result.transactionId)).toEqual([
      { direction: 'CREDIT', amount: '25.00', balance_before: '975.00', balance_after: '1000.00' },
    ]);
    expect(await txRow(refund.result.transactionId)).toEqual({
      status: 'PROCESSED',
      failure_code: null,
      reference_transaction_id: bet.result.transactionId,
    });
    expect(await walletRow(wallet.id)).toEqual({ balance: '1000.00', version: 3 });
    expect(await eventTypesOf(refund.result.transactionId)).toEqual(['WalletBalanceChanged', 'WagerTransactionProcessed']);
    await assertWalletMatchesLedger(database.db, wallet.id);
  });

  test('ROLLBACK 50.00 de WIN 50.00 com saldo 1025.00 → 201 com DEBIT de 50.00 (cenário 2)', async () => {
    const wallet = await openWallet(http, '975.00');
    const win = await submit(op('WIN', wallet, '50.00'), 201);
    expect(win.result.balance.amount).toBe('1025.00');
    const rollback = await submit(op('ROLLBACK', wallet, '50.00', win.request), 201);

    expect(rollback.result).toMatchObject({ status: 'PROCESSED', balance: { amount: '975.00', currency: 'BRL' } });
    expect(await ledgerOf(rollback.result.transactionId)).toEqual([
      { direction: 'DEBIT', amount: '50.00', balance_before: '1025.00', balance_after: '975.00' },
    ]);
    expect((await txRow(rollback.result.transactionId))?.reference_transaction_id).toBe(win.result.transactionId);
    await assertWalletMatchesLedger(database.db, wallet.id);
  });

  test('ROLLBACK de BET → CREDIT', async () => {
    const wallet = await openWallet(http, '100.00');
    const bet = await submit(op('BET', wallet, '40.00'), 201);
    const rollback = await submit(op('ROLLBACK', wallet, '40.00', bet.request), 201);
    expect(await ledgerOf(rollback.result.transactionId)).toEqual([
      { direction: 'CREDIT', amount: '40.00', balance_before: '60.00', balance_after: '100.00' },
    ]);
    await assertWalletMatchesLedger(database.db, wallet.id);
  });

  test('ROLLBACK de um REFUND → DEBIT (cenário do edge case "ROLLBACK de um REFUND")', async () => {
    const wallet = await openWallet(http, '100.00');
    const bet = await submit(op('BET', wallet, '25.00'), 201);
    const refund = await submit(op('REFUND', wallet, '25.00', bet.request), 201);
    const rollback = await submit(op('ROLLBACK', wallet, '25.00', refund.request), 201);

    expect(rollback.result.balance).toEqual({ amount: '75.00', currency: 'BRL' });
    expect(await ledgerOf(rollback.result.transactionId)).toEqual([
      { direction: 'DEBIT', amount: '25.00', balance_before: '100.00', balance_after: '75.00' },
    ]);
    expect((await txRow(rollback.result.transactionId))?.reference_transaction_id).toBe(refund.result.transactionId);
    await assertWalletMatchesLedger(database.db, wallet.id);
  });
});

describe('reversões rejeitadas: 422, sem lançamento, version inalterada, WagerTransactionRejected', () => {
  async function expectRejectedWithoutEffect(wallet: WalletBody, result: TransactionResultBody, code: string, balance: string) {
    expect(result).toMatchObject({ status: 'REJECTED', failureCode: code, retryable: false, balance: { amount: balance, currency: 'BRL' } });
    expect(await ledgerOf(result.transactionId)).toEqual([]);
    expect(await txRow(result.transactionId)).toMatchObject({ status: 'REJECTED', failure_code: code, reference_transaction_id: null });
    expect(await eventTypesOf(result.transactionId)).toEqual(['WagerTransactionRejected']);
    expect((await walletRow(wallet.id))?.balance).toBe(balance);
    await assertWalletMatchesLedger(database.db, wallet.id);
  }

  test('REFUND seguido de ROLLBACK da mesma BET → 422 ALREADY_REVERSED, sem crédito extra (cenário 3)', async () => {
    const wallet = await openWallet(http, '100.00');
    const bet = await submit(op('BET', wallet, '25.00'), 201);
    await submit(op('REFUND', wallet, '25.00', bet.request), 201);
    const before = await walletRow(wallet.id);
    const rollback = await submit(op('ROLLBACK', wallet, '25.00', bet.request), 422);

    await expectRejectedWithoutEffect(wallet, rollback.result, 'ALREADY_REVERSED', '100.00');
    expect(await walletRow(wallet.id)).toEqual(before);
    const credits = await database.db.query("SELECT id FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'CREDIT'", [wallet.id]);
    expect(credits).toHaveLength(2); // abertura + um único REFUND
  });

  test('REFUND repetido da mesma BET (outro id externo) → ALREADY_REVERSED', async () => {
    const wallet = await openWallet(http, '100.00');
    const bet = await submit(op('BET', wallet, '25.00'), 201);
    await submit(op('REFUND', wallet, '25.00', bet.request), 201);
    const second = await submit(op('REFUND', wallet, '25.00', bet.request), 422);
    await expectRejectedWithoutEffect(wallet, second.result, 'ALREADY_REVERSED', '100.00');
  });

  test('REFUND 20.00 de BET 25.00 → 422 AMOUNT_MISMATCH (cenário 5)', async () => {
    const wallet = await openWallet(http, '100.00');
    const bet = await submit(op('BET', wallet, '25.00'), 201);
    const refund = await submit(op('REFUND', wallet, '20.00', bet.request), 422);
    await expectRejectedWithoutEffect(wallet, refund.result, 'AMOUNT_MISMATCH', '75.00');
  });

  test('ROLLBACK de WIN 50.00 com saldo 30.00 → 422 REVERSAL_WOULD_OVERDRAW, saldo 30.00, rejeição registrada (cenário 6)', async () => {
    const wallet = await openWallet(http, '100.00');
    const win = await submit(op('WIN', wallet, '50.00'), 201);
    await submit(op('BET', wallet, '120.00'), 201);
    expect((await walletRow(wallet.id))?.balance).toBe('30.00');
    const rollback = await submit(op('ROLLBACK', wallet, '50.00', win.request), 422);
    await expectRejectedWithoutEffect(wallet, rollback.result, 'REVERSAL_WOULD_OVERDRAW', '30.00');
  });

  test('REFUND de WIN, ROLLBACK de LOSS e ROLLBACK de ROLLBACK → 422 INVALID_REFERENCE_KIND (cenário 7)', async () => {
    const wallet = await openWallet(http, '100.00');
    const win = await submit(op('WIN', wallet, '10.00'), 201);
    const refundOfWin = await submit(op('REFUND', wallet, '10.00', win.request), 422);
    await expectRejectedWithoutEffect(wallet, refundOfWin.result, 'INVALID_REFERENCE_KIND', '110.00');

    const loss = await submit(op('LOSS', wallet, '10.00'), 201);
    const rollbackOfLoss = await submit(op('ROLLBACK', wallet, '10.00', loss.request), 422);
    await expectRejectedWithoutEffect(wallet, rollbackOfLoss.result, 'INVALID_REFERENCE_KIND', '110.00');

    const bet = await submit(op('BET', wallet, '10.00'), 201);
    const rollbackOfBet = await submit(op('ROLLBACK', wallet, '10.00', bet.request), 201);
    expect(rollbackOfBet.result.balance.amount).toBe('110.00');
    const rollbackOfRollback = await submit(op('ROLLBACK', wallet, '10.00', rollbackOfBet.request), 422);
    await expectRejectedWithoutEffect(wallet, rollbackOfRollback.result, 'INVALID_REFERENCE_KIND', '110.00');
  });

  test('REFUND de BET REJECTED → 422 REFERENCE_REJECTED (cenário 8)', async () => {
    const wallet = await openWallet(http, '10.00');
    const bet = await submit(op('BET', wallet, '25.00'), 422);
    expect(bet.result.failureCode).toBe('INSUFFICIENT_FUNDS');
    const refund = await submit(op('REFUND', wallet, '25.00', bet.request), 422);
    await expectRejectedWithoutEffect(wallet, refund.result, 'REFERENCE_REJECTED', '10.00');
  });

  test('REFUND de BET de outra rodada → 422 REFERENCE_MISMATCH', async () => {
    const wallet = await openWallet(http, '100.00');
    const bet = await submit(op('BET', wallet, '25.00'), 201);
    const refund = await submit({ ...op('REFUND', wallet, '25.00', bet.request), roundId: 'other-round' }, 422);
    await expectRejectedWithoutEffect(wallet, refund.result, 'REFERENCE_MISMATCH', '75.00');
  });
});

describe('payload inválido (cenário 9)', () => {
  for (const kind of ['REFUND', 'ROLLBACK'] as const) {
    test(`${kind} sem referenceExternalTransactionId → 400 VALIDATION_ERROR, nada registrado`, async () => {
      const wallet = await openWallet(http, '100.00');
      const request = op(kind, wallet, '25.00');
      const response = await submitWager<ErrorBody>(http, request);
      expect(response.status).toBe(400);
      expect(response.body.error).toMatchObject({ code: 'VALIDATION_ERROR', retryable: false });
      const rows = await database.db.query('SELECT id FROM wager_transactions WHERE external_transaction_id = ?', [
        request.externalTransactionId,
      ]);
      expect(rows).toEqual([]);
      expect(await walletRow(wallet.id)).toEqual({ balance: '100.00', version: 1 });
      await assertWalletMatchesLedger(database.db, wallet.id);
    });
  }
});
