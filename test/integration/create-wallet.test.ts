// T052 — POST /wallets (US1 cenários 1, 2, 3 e 5; FR-005 a FR-008, FR-046, FR-047, I-06, I-07, I-09, I-10, I-52).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { startApp, type RunningApp } from '../support/app-harness.ts';
import { walletRequest } from '../support/factories.ts';
import { fetcherFor, postJson, type ErrorBody, type Fetcher, type WalletBody } from '../support/http.ts';
import { useTestDatabase } from '../support/test-database.ts';

const database = useTestDatabase('create_wallet');
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

const counts = async (walletId: string) => {
  const [row] = await database.db.query<{ txs: string; entries: string; events: string }>(
    `SELECT (SELECT count(*) FROM wager_transactions WHERE wallet_id = ?)::text AS txs,
            (SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = ?)::text AS entries,
            (SELECT count(*) FROM outbox_messages WHERE aggregate_id = ?)::text AS events`,
    [walletId, walletId, walletId],
  );
  return row;
};

describe('saldo inicial positivo (cenário 1)', () => {
  test('201 com id, playerId, balance e version 1; abertura, lançamento e evento gravados juntos', async () => {
    const request = walletRequest({ initialBalance: { amount: '1000.00', currency: 'BRL' } });
    const response = await postJson<WalletBody>(http, '/wallets', request, { 'X-Correlation-Id': 'corr-open-1' });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: expect.stringMatching(UUIDV7),
      playerId: request.playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
    const walletId = response.body.id;

    const [wallet] = await database.db.query('SELECT player_id, currency, balance, version FROM wallets WHERE id = ?', [walletId]);
    expect(wallet).toEqual({ player_id: request.playerId, currency: 'BRL', balance: '1000.00', version: 1 });

    // OPENING PROCESSED com a identidade do I-07
    const txs = await database.db.query(
      `SELECT id, provider_id, external_transaction_id, idempotency_key, round_id, game_id, kind, status, amount, currency,
              observed_balance, observed_balance_currency, correlation_id, processed_at IS NOT NULL AS processed,
              failure_code, reference_external_transaction_id, payload_hash
         FROM wager_transactions WHERE wallet_id = ?`,
      [walletId],
    );
    expect(txs).toHaveLength(1);
    const opening = txs[0] as Record<string, unknown>;
    expect(opening).toMatchObject({
      provider_id: 'system',
      external_transaction_id: `opening:${walletId}`,
      idempotency_key: `system:opening:${walletId}`,
      round_id: 'opening',
      game_id: 'system',
      kind: 'OPENING',
      status: 'PROCESSED',
      amount: '1000.00',
      currency: 'BRL',
      observed_balance: '1000.00',
      observed_balance_currency: 'BRL',
      correlation_id: 'corr-open-1',
      processed: true,
      failure_code: null,
      reference_external_transaction_id: null,
    });
    expect(opening.payload_hash).toMatch(/^[0-9a-f]{64}$/);

    // um lançamento CREDIT antes 0.00 → depois 1000.00
    const entries = await database.db.query(
      'SELECT transaction_id, direction, amount, currency, balance_before, balance_after FROM wallet_ledger_entries WHERE wallet_id = ?',
      [walletId],
    );
    expect(entries).toEqual([
      {
        transaction_id: opening.id,
        direction: 'CREDIT',
        amount: '1000.00',
        currency: 'BRL',
        balance_before: '0.00',
        balance_after: '1000.00',
      },
    ]);

    // exatamente um WalletBalanceChanged; nenhum WagerTransactionProcessed (I-09)
    const events = await database.db.query<{ id: string; event_type: string; event_version: number; correlation_id: string; payload: Record<string, unknown> }>(
      'SELECT id, event_type, event_version, correlation_id, payload FROM outbox_messages WHERE aggregate_id = ?',
      [walletId],
    );
    expect(events.map((e) => e.event_type)).toEqual(['WalletBalanceChanged']);
    const event = events[0]!;
    expect(event.event_version).toBe(1);
    expect(event.correlation_id).toBe('corr-open-1');
    expect(event.payload).toEqual({
      eventId: event.id,
      eventType: 'WalletBalanceChanged',
      aggregateId: walletId,
      correlationId: 'corr-open-1',
      occurredAt: expect.stringMatching(ISO_8601),
      version: 1,
      data: {
        walletId,
        transactionId: opening.id,
        direction: 'CREDIT',
        money: { amount: '1000.00', currency: 'BRL' },
        balanceBefore: { amount: '0.00', currency: 'BRL' },
        balanceAfter: { amount: '1000.00', currency: 'BRL' },
        walletVersion: 1,
      },
    });
    expect(event.id).toMatch(UUIDV7);

    await assertWalletMatchesLedger(database.db, walletId);
  });

  test('o saldo inicial é normalizado para 2 casas ("25" → "25.00")', async () => {
    const response = await postJson<WalletBody>(http, '/wallets', walletRequest({ initialBalance: { amount: '25', currency: 'BRL' } }));
    expect(response.status).toBe(201);
    expect(response.body.balance).toEqual({ amount: '25.00', currency: 'BRL' });
    await assertWalletMatchesLedger(database.db, response.body.id);
  });
});

describe('saldo inicial 0.00 (cenário 2)', () => {
  test('wallet sem OPENING, sem lançamento e sem evento (I-06, FR-046)', async () => {
    const response = await postJson<WalletBody>(http, '/wallets', walletRequest({ initialBalance: { amount: '0.00', currency: 'BRL' } }));
    expect(response.status).toBe(201);
    expect(response.body.balance).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(response.body.version).toBe(1);
    expect(await counts(response.body.id)).toEqual({ txs: '0', entries: '0', events: '0' });
    await assertWalletMatchesLedger(database.db, response.body.id);
  });
});

describe('duplicata e unicidade por (playerId, currency) (cenários 3 e 5)', () => {
  test('mesma wallet → 409 WALLET_ALREADY_EXISTS só com details.walletId, sem efeito nem evento (I-10, I-52)', async () => {
    const request = walletRequest({ initialBalance: { amount: '50.00', currency: 'BRL' } });
    const first = await postJson<WalletBody>(http, '/wallets', request);
    expect(first.status).toBe(201);
    const before = await counts(first.body.id);

    const duplicate = await postJson<ErrorBody>(http, '/wallets', { ...request, initialBalance: { amount: '999.00', currency: 'BRL' } }, {
      'X-Correlation-Id': 'corr-dup',
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toEqual({
      error: {
        code: 'WALLET_ALREADY_EXISTS',
        message: expect.any(String),
        retryable: false,
        correlationId: 'corr-dup',
        details: { walletId: first.body.id },
      },
    });
    expect(await counts(first.body.id)).toEqual(before);
    const [{ wallets }] = (await database.db.query<{ wallets: string }>(
      'SELECT count(*)::text AS wallets FROM wallets WHERE player_id = ?',
      [request.playerId],
    )) as [{ wallets: string }];
    expect(wallets).toBe('1');
    const [{ events }] = (await database.db.query<{ events: string }>(
      "SELECT count(*)::text AS events FROM outbox_messages WHERE correlation_id = 'corr-dup'",
    )) as [{ events: string }];
    expect(events).toBe('0');
    await assertWalletMatchesLedger(database.db, first.body.id);
  });

  test('mesmo jogador em USD → 201 (unicidade é por jogador e moeda, I-05)', async () => {
    const brl = walletRequest({ initialBalance: { amount: '10.00', currency: 'BRL' } });
    const first = await postJson<WalletBody>(http, '/wallets', brl);
    const second = await postJson<WalletBody>(http, '/wallets', { playerId: brl.playerId, initialBalance: { amount: '10.00', currency: 'USD' } });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);
    expect(second.body.balance).toEqual({ amount: '10.00', currency: 'USD' });
    await assertWalletMatchesLedger(database.db, first.body.id);
    await assertWalletMatchesLedger(database.db, second.body.id);
  });
});

describe('validação → 400 VALIDATION_ERROR', () => {
  test.each([
    ['playerId vazio', { playerId: '', initialBalance: { amount: '1.00', currency: 'BRL' } }],
    ['playerId com 256 caracteres', { playerId: 'x'.repeat(256), initialBalance: { amount: '1.00', currency: 'BRL' } }],
    ['amount como número JSON', { playerId: 'p-num', initialBalance: { amount: 1, currency: 'BRL' } }],
    ['amount "-1"', { playerId: 'p-neg', initialBalance: { amount: '-1', currency: 'BRL' } }],
    ['amount "25.001"', { playerId: 'p-3dp', initialBalance: { amount: '25.001', currency: 'BRL' } }],
    ['amount acima do limite', { playerId: 'p-max', initialBalance: { amount: '10000000000000000.00', currency: 'BRL' } }],
    ['moeda "brl"', { playerId: 'p-cur', initialBalance: { amount: '1.00', currency: 'brl' } }],
    ['sem initialBalance', { playerId: 'p-missing' }],
  ])('%s', async (_label, body) => {
    const response = await postJson<ErrorBody>(http, '/wallets', body);
    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ code: 'VALIDATION_ERROR', retryable: false });
    const [{ wallets }] = (await database.db.query<{ wallets: string }>(
      'SELECT count(*)::text AS wallets FROM wallets WHERE player_id = ?',
      [String((body as { playerId?: unknown }).playerId ?? '')],
    )) as [{ wallets: string }];
    expect(wallets).toBe('0');
  });
});
