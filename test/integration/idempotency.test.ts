// T082 — idempotência persistente (US3 cenários 1, 2, 4, 5 e 6; FR-032 a FR-036, FR-047, I-24, I-25, I-26, I-53, I-56,
// I-57).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { startApp, type RunningApp } from '../support/app-harness.ts';
import { idempotencyKeyFor, wagerRequest } from '../support/factories.ts';
import { fetcherFor, postJson, type ErrorBody, type Fetcher, type TransactionResultBody } from '../support/http.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('idempotency');
let running: RunningApp;
let http: Fetcher;

beforeAll(async () => {
  running = await startApp({ databaseUrl: database.url });
  http = fetcherFor(running.baseUrl);
});
afterAll(async () => {
  await running?.close();
});

const outboxCount = async () =>
  (await database.db.query<{ n: string }>('SELECT count(*)::text AS n FROM outbox_messages'))[0]!.n;
const ledgerCount = async (walletId: string) =>
  (await database.db.query<{ n: string }>('SELECT count(*)::text AS n FROM wallet_ledger_entries WHERE wallet_id = ?', [walletId]))[0]!.n;

describe('replay (cenários 1 e 2)', () => {
  test('BET PROCESSED reenviada depois que o saldo mudou → 200, mesmo transactionId, saldo observado original (I-26)', async () => {
    const wallet = await openWallet(http, '1000.00');
    const original = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '25.00', currency: 'BRL' } });
    const first = await submitWager(http, original);
    expect(first.status).toBe(201);
    expect(first.body.balance.amount).toBe('975.00');

    // o saldo muda para 900.00 com outra BET
    const other = await submitWager(http, wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '75.00', currency: 'BRL' } }));
    expect(other.body.balance.amount).toBe('900.00');

    const entriesBefore = await ledgerCount(wallet.id);
    const eventsBefore = await outboxCount();
    const replay = await submitWager(http, original);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({
      transactionId: first.body.transactionId,
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: true,
    });
    expect(await ledgerCount(wallet.id)).toBe(entriesBefore);
    expect(await outboxCount()).toBe(eventsBefore);
    const [row] = await database.db.query<{ balance: string }>('SELECT balance FROM wallets WHERE id = ?', [wallet.id]);
    expect(row?.balance).toBe('900.00');
    await assertWalletMatchesLedger(database.db, wallet.id);
  });

  test('replay de uma REJECTED → 422 com o mesmo transactionId, failureCode e saldo, idempotentReplay true', async () => {
    const wallet = await openWallet(http, '10.00');
    const request = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '25.00', currency: 'BRL' } });
    const first = await submitWager(http, request);
    expect(first.status).toBe(422);

    // o saldo muda depois da rejeição; o replay continua devolvendo o saldo observado original
    await submitWager(http, wagerRequest('WIN', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '90.00', currency: 'BRL' } }));
    const eventsBefore = await outboxCount();
    const replay = await submitWager(http, request);
    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({
      transactionId: first.body.transactionId,
      status: 'REJECTED',
      balance: { amount: '10.00', currency: 'BRL' },
      idempotentReplay: true,
      failureCode: 'INSUFFICIENT_FUNDS',
      retryable: false,
    });
    expect(await outboxCount()).toBe(eventsBefore);
    const rows = await database.db.query('SELECT id FROM wager_transactions WHERE external_transaction_id = ?', [request.externalTransactionId]);
    expect(rows).toHaveLength(1);
    await assertWalletMatchesLedger(database.db, wallet.id);
  });
});

describe('conflito (cenários 4 e 5)', () => {
  test('mesma chave do mesmo provedor com amount "26.00" → 409 IDEMPOTENCY_CONFLICT, sem efeito nem evento', async () => {
    const wallet = await openWallet(http, '100.00');
    const request = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '25.00', currency: 'BRL' } });
    expect((await submitWager(http, request)).status).toBe(201);
    const entriesBefore = await ledgerCount(wallet.id);
    const eventsBefore = await outboxCount();

    const conflict = await postJson<ErrorBody>(
      http,
      '/wagering/transactions',
      { ...request, money: { amount: '26.00', currency: 'BRL' } },
      { 'Idempotency-Key': idempotencyKeyFor(request), 'X-Correlation-Id': 'corr-conflict' },
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({
      error: { code: 'IDEMPOTENCY_CONFLICT', message: expect.any(String), retryable: false, correlationId: 'corr-conflict' },
    });
    expect(await ledgerCount(wallet.id)).toBe(entriesBefore);
    expect(await outboxCount()).toBe(eventsBefore);
    const [row] = await database.db.query<{ balance: string }>('SELECT balance FROM wallets WHERE id = ?', [wallet.id]);
    expect(row?.balance).toBe('75.00');
    await assertWalletMatchesLedger(database.db, wallet.id);
  });

  test('mesmo (providerId, externalTransactionId) com outra chave → 409 IDEMPOTENCY_CONFLICT (I-24)', async () => {
    const wallet = await openWallet(http, '100.00');
    const request = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId });
    expect((await submitWager(http, request)).status).toBe(201);
    const eventsBefore = await outboxCount();

    const conflict = await submitWager<ErrorBody>(http, request, { 'Idempotency-Key': 'another-key-for-the-same-external-id' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', retryable: false });
    expect(await outboxCount()).toBe(eventsBefore);
    const rows = await database.db.query('SELECT idempotency_key FROM wager_transactions WHERE external_transaction_id = ?', [request.externalTransactionId]);
    expect(rows).toEqual([{ idempotency_key: idempotencyKeyFor(request) }]);
    await assertWalletMatchesLedger(database.db, wallet.id);
  });
});

describe('escopo por provedor (I-56)', () => {
  test('provider-a e provider-b com a mesma Idempotency-Key e ids externos diferentes → 201 e 201, dois débitos', async () => {
    const wallet = await openWallet(http, '100.00');
    const sharedKey = `shared-key-${crypto.randomUUID()}`;
    const fromA = wagerRequest('BET', { providerId: 'provider-a', walletId: wallet.id, playerId: wallet.playerId, money: { amount: '10.00', currency: 'BRL' } });
    const fromB = wagerRequest('BET', { providerId: 'provider-b', walletId: wallet.id, playerId: wallet.playerId, money: { amount: '10.00', currency: 'BRL' } });

    const a = await submitWager(http, fromA, { 'Idempotency-Key': sharedKey });
    const b = await submitWager(http, fromB, { 'Idempotency-Key': sharedKey });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body.transactionId).not.toBe(b.body.transactionId);
    expect([a.body.idempotentReplay, b.body.idempotentReplay]).toEqual([false, false]);

    const rows = await database.db.query<{ provider_id: string }>(
      'SELECT provider_id FROM wager_transactions WHERE idempotency_key = ? ORDER BY provider_id',
      [sharedKey],
    );
    expect(rows.map((r) => r.provider_id)).toEqual(['provider-a', 'provider-b']);
    const debits = await database.db.query("SELECT id FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'", [wallet.id]);
    expect(debits).toHaveLength(2);
    const [row] = await database.db.query<{ balance: string }>('SELECT balance FROM wallets WHERE id = ?', [wallet.id]);
    expect(row?.balance).toBe('80.00');
    await assertWalletMatchesLedger(database.db, wallet.id);
  });
});

describe('o que não entra no hash (cenário 6; I-25, I-53, I-57)', () => {
  test('a mesma requisição com outro X-Correlation-Id e campos desconhecidos extras → replay, sem evento e sem mudar o correlation_id gravado', async () => {
    const wallet = await openWallet(http, '100.00');
    const request = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '5.00', currency: 'BRL' } });
    const first = await submitWager(http, request, { 'X-Correlation-Id': 'corr-original' });
    expect(first.status).toBe(201);
    const eventsBefore = await outboxCount();

    const replay = await postJson<TransactionResultBody>(
      http,
      '/wagering/transactions',
      { ...request, metadata: { source: 'retry' }, extra: 'ignored', money: { ...request.money, note: 'x' } },
      { 'Idempotency-Key': idempotencyKeyFor(request), 'X-Correlation-Id': 'corr-replay' },
    );
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ transactionId: first.body.transactionId, idempotentReplay: true });
    expect(replay.headers.get('x-correlation-id')).toBe('corr-replay');
    expect(await outboxCount()).toBe(eventsBefore);
    const [row] = await database.db.query<{ correlation_id: string }>('SELECT correlation_id FROM wager_transactions WHERE id = ?', [
      first.body.transactionId,
    ]);
    expect(row?.correlation_id).toBe('corr-original');
    await assertWalletMatchesLedger(database.db, wallet.id);
  });

  test('"25" e "25.00" e walletId em maiúsculas são a mesma requisição → replay (I-01, I-58)', async () => {
    const wallet = await openWallet(http, '100.00');
    const request = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '25.00', currency: 'BRL' } });
    const first = await submitWager(http, request);
    const replay = await submitWager(http, { ...request, walletId: wallet.id.toUpperCase(), money: { amount: '25', currency: 'BRL' } }, {
      'Idempotency-Key': idempotencyKeyFor(request),
    });
    expect(replay.status).toBe(200);
    expect(replay.body.transactionId).toBe(first.body.transactionId);
    await assertWalletMatchesLedger(database.db, wallet.id);
  });
});
