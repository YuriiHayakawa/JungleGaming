// T088 — WIN e LOSS (US4 cenários 1 a 5; FR-017, FR-018, FR-021, FR-022, FR-045, I-02, I-12, I-14, I-46).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { startApp, type RunningApp } from '../support/app-harness.ts';
import { wagerRequest } from '../support/factories.ts';
import { fetcherFor, type Fetcher, type TransactionResultBody, type WalletBody } from '../support/http.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('win_loss');
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
    await database.db.query<{ status: string; failure_code: string | null; reference_transaction_id: string | null; reference_external_transaction_id: string | null }>(
      'SELECT status, failure_code, reference_transaction_id, reference_external_transaction_id FROM wager_transactions WHERE id = ?',
      [transactionId],
    )
  )[0];

async function placeBet(wallet: WalletBody, amount: string, roundId = 'round-1') {
  const request = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, roundId, money: { amount, currency: 'BRL' } });
  const response = await submitWager<TransactionResultBody>(http, request);
  expect(response.status).toBe(201);
  return { request, result: response.body };
}

describe('WIN (FR-017)', () => {
  test('WIN 50.00 sem referência → 201 PROCESSED, saldo +50 com CREDIT (cenário 1)', async () => {
    const wallet = await openWallet(http, '975.00');
    const request = wagerRequest('WIN', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '50.00', currency: 'BRL' } });
    const response = await submitWager<TransactionResultBody>(http, request);

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '1025.00', currency: 'BRL' }, idempotentReplay: false });
    expect(await ledgerOf(response.body.transactionId)).toEqual([
      { direction: 'CREDIT', amount: '50.00', balance_before: '975.00', balance_after: '1025.00' },
    ]);
    expect(await walletRow(wallet.id)).toEqual({ balance: '1025.00', version: 2 });
    expect(await eventTypesOf(response.body.transactionId)).toEqual(['WalletBalanceChanged', 'WagerTransactionProcessed']);
    expect((await txRow(response.body.transactionId))?.reference_transaction_id).toBeNull();
    await assertWalletMatchesLedger(database.db, wallet.id);
  });

  test('WIN referenciando a BET PROCESSED da mesma rodada → 201 CREDIT e reference_transaction_id resolvido', async () => {
    const wallet = await openWallet(http, '100.00');
    const bet = await placeBet(wallet, '25.00');
    const request = wagerRequest('WIN', {
      walletId: wallet.id,
      playerId: wallet.playerId,
      money: { amount: '60.00', currency: 'BRL' },
      referenceExternalTransactionId: bet.request.externalTransactionId,
    });
    const response = await submitWager<TransactionResultBody>(http, request);

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '135.00', currency: 'BRL' } });
    expect(await txRow(response.body.transactionId)).toMatchObject({
      status: 'PROCESSED',
      reference_transaction_id: bet.result.transactionId,
      reference_external_transaction_id: bet.request.externalTransactionId,
    });
    const [processed] = await database.db.query<{ payload: { data: Record<string, unknown> } }>(
      "SELECT payload FROM outbox_messages WHERE event_type = 'WagerTransactionProcessed' AND payload->'data'->>'transactionId' = ?",
      [response.body.transactionId],
    );
    expect(processed?.payload.data.referenceTransactionId).toBe(bet.result.transactionId);
    await assertWalletMatchesLedger(database.db, wallet.id);
  });

  test('WIN referenciando BET com rodada R2 → 422 REFERENCE_MISMATCH, sem efeito (cenário 3)', async () => {
    const wallet = await openWallet(http, '100.00');
    const bet = await placeBet(wallet, '25.00', 'round-R');
    const request = wagerRequest('WIN', {
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-R2',
      money: { amount: '50.00', currency: 'BRL' },
      referenceExternalTransactionId: bet.request.externalTransactionId,
    });
    const response = await submitWager<TransactionResultBody>(http, request);

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REFERENCE_MISMATCH',
      retryable: false,
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    expect(await ledgerOf(response.body.transactionId)).toEqual([]);
    expect(await walletRow(wallet.id)).toEqual({ balance: '75.00', version: 2 });
    expect(await eventTypesOf(response.body.transactionId)).toEqual(['WagerTransactionRejected']);
    await assertWalletMatchesLedger(database.db, wallet.id);
  });
});

describe('LOSS (FR-018)', () => {
  test('LOSS referenciando BET PROCESSED → 201, sem lançamento, saldo e version iguais, só WagerTransactionProcessed (cenário 2)', async () => {
    const wallet = await openWallet(http, '100.00');
    const bet = await placeBet(wallet, '25.00');
    const before = await walletRow(wallet.id);
    const request = wagerRequest('LOSS', {
      walletId: wallet.id,
      playerId: wallet.playerId,
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: bet.request.externalTransactionId,
    });
    const response = await submitWager<TransactionResultBody>(http, request);

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '75.00', currency: 'BRL' }, idempotentReplay: false });
    expect(await ledgerOf(response.body.transactionId)).toEqual([]);
    expect(await walletRow(wallet.id)).toEqual(before);
    expect(before).toEqual({ balance: '75.00', version: 2 });
    expect(await eventTypesOf(response.body.transactionId)).toEqual(['WagerTransactionProcessed']);
    expect(await txRow(response.body.transactionId)).toMatchObject({
      status: 'PROCESSED',
      failure_code: null,
      reference_transaction_id: bet.result.transactionId,
    });
    await assertWalletMatchesLedger(database.db, wallet.id);
  });

  test('LOSS referenciando uma WIN → 422 INVALID_REFERENCE_KIND (cenário 4)', async () => {
    const wallet = await openWallet(http, '100.00');
    const winRequest = wagerRequest('WIN', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '10.00', currency: 'BRL' } });
    const win = await submitWager<TransactionResultBody>(http, winRequest);
    expect(win.status).toBe(201);

    const request = wagerRequest('LOSS', {
      walletId: wallet.id,
      playerId: wallet.playerId,
      money: { amount: '10.00', currency: 'BRL' },
      referenceExternalTransactionId: winRequest.externalTransactionId,
    });
    const response = await submitWager<TransactionResultBody>(http, request);

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ status: 'REJECTED', failureCode: 'INVALID_REFERENCE_KIND', retryable: false });
    expect(await ledgerOf(response.body.transactionId)).toEqual([]);
    expect(await walletRow(wallet.id)).toEqual({ balance: '110.00', version: 2 });
    expect(await eventTypesOf(response.body.transactionId)).toEqual(['WagerTransactionRejected']);
    await assertWalletMatchesLedger(database.db, wallet.id);
  });

  test('LOSS "0.00" → 201 PROCESSED, sem lançamento, saldo e version inalterados (cenário 5, I-02)', async () => {
    const wallet = await openWallet(http, '975.00');
    const request = wagerRequest('LOSS', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '0.00', currency: 'BRL' } });
    const response = await submitWager<TransactionResultBody>(http, request);

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '975.00', currency: 'BRL' } });
    expect(await ledgerOf(response.body.transactionId)).toEqual([]);
    expect(await walletRow(wallet.id)).toEqual({ balance: '975.00', version: 1 });
    expect(await eventTypesOf(response.body.transactionId)).toEqual(['WagerTransactionProcessed']);
    const [row] = await database.db.query<{ amount: string; observed_balance: string }>(
      'SELECT amount, observed_balance FROM wager_transactions WHERE id = ?',
      [response.body.transactionId],
    );
    expect(row).toEqual({ amount: '0.00', observed_balance: '975.00' });
    await assertWalletMatchesLedger(database.db, wallet.id);
  });
});
