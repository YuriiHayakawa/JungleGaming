// T112 — consultas de wallet e de transação (US8 cenários 3 a 5; FR-049, FR-052, FR-053, I-07, I-50, I-55, I-58;
// SC-011).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { startApp, type RunningApp } from '../support/app-harness.ts';
import { wagerRequest } from '../support/factories.ts';
import { fetcherFor, type ErrorBody, type Fetcher, type JsonResponse, type TransactionResultBody } from '../support/http.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('queries');
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

async function get<B = Record<string, unknown>>(path: string): Promise<JsonResponse<B>> {
  const started = performance.now();
  const response = await http(path);
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: (text ? JSON.parse(text) : {}) as B, elapsedMs: performance.now() - started };
}

function expectError(response: JsonResponse<unknown>, status: number, code: string, retryable = false): void {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  expect((response.body as ErrorBody).error).toMatchObject({ code, retryable });
}

const enc = encodeURIComponent;

describe('GET /wallets/:walletId (FR-049)', () => {
  test('→ { id, playerId, balance, version }', async () => {
    const wallet = await openWallet(http, '100.00');
    expect((await submitWager(http, wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '30.00', currency: 'BRL' } }))).status).toBe(201);
    const response = await get(`/wallets/${wallet.id}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ id: wallet.id, playerId: wallet.playerId, balance: { amount: '70.00', currency: 'BRL' }, version: 2 });
    await assertWalletMatchesLedger(database.db, wallet.id);
  });

  test('id em maiúsculas encontra a mesma wallet (I-58)', async () => {
    const wallet = await openWallet(http, '5.00');
    const response = await get(`/wallets/${wallet.id.toUpperCase()}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: wallet.id });
  });

  test('inexistente → 404 WALLET_NOT_FOUND; malformado → 400 VALIDATION_ERROR', async () => {
    expectError(await get('/wallets/0192f291-27dd-7d3f-8071-000000000404'), 404, 'WALLET_NOT_FOUND');
    expectError(await get('/wallets/not-a-uuid'), 400, 'VALIDATION_ERROR');
  });
});

describe('transação por id interno e por (provedor, id externo) (FR-052, cenário 3)', () => {
  test('as duas rotas devolvem a mesma transação PROCESSED, com referências e saldo observado', async () => {
    const wallet = await openWallet(http, '100.00');
    const bet = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '25.00', currency: 'BRL' } });
    const betResult = await submitWager<TransactionResultBody>(http, bet);
    const refund = wagerRequest('REFUND', {
      walletId: wallet.id,
      playerId: wallet.playerId,
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const refundResult = await submitWager<TransactionResultBody>(http, refund);
    expect(refundResult.status).toBe(201);

    const byId = await get(`/wagering/transactions/${refundResult.body.transactionId}`);
    const byExternal = await get(`/providers/${enc(refund.providerId)}/wagering/transactions/${enc(refund.externalTransactionId)}`);
    expect(byId.status).toBe(200);
    expect(byExternal.status).toBe(200);
    expect(byExternal.body).toEqual(byId.body);
    expect(byId.body).toEqual({
      transactionId: refundResult.body.transactionId,
      providerId: refund.providerId,
      externalTransactionId: refund.externalTransactionId,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: refund.roundId,
      gameId: refund.gameId,
      kind: 'REFUND',
      money: { amount: '25.00', currency: 'BRL' },
      status: 'PROCESSED',
      referenceExternalTransactionId: bet.externalTransactionId,
      referenceTransactionId: betResult.body.transactionId,
      observedBalance: { amount: '100.00', currency: 'BRL' },
      createdAt: expect.stringMatching(ISO_8601),
      processedAt: expect.stringMatching(ISO_8601),
    });
    await assertWalletMatchesLedger(database.db, wallet.id);
  });

  test('REJECTED → 200 com failureCode e retryable', async () => {
    const wallet = await openWallet(http, '10.00');
    const bet = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '99.00', currency: 'BRL' } });
    const result = await submitWager<TransactionResultBody>(http, bet);
    expect(result.status).toBe(422);
    for (const path of [`/wagering/transactions/${result.body.transactionId}`, `/providers/${enc(bet.providerId)}/wagering/transactions/${enc(bet.externalTransactionId)}`]) {
      const response = await get<Record<string, unknown>>(path);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        transactionId: result.body.transactionId,
        kind: 'BET',
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_FUNDS',
        retryable: false,
        observedBalance: { amount: '10.00', currency: 'BRL' },
      });
      expect(response.body.processedAt).toBeUndefined();
      expect(response.body.referenceTransactionId).toBeUndefined();
    }
    await assertWalletMatchesLedger(database.db, wallet.id);
  });

  test('PENDING_REFERENCE → 200, sem failureCode e com a referência externa', async () => {
    const wallet = await openWallet(http, '10.00');
    const rollback = wagerRequest('ROLLBACK', {
      walletId: wallet.id,
      playerId: wallet.playerId,
      money: { amount: '5.00', currency: 'BRL' },
      referenceExternalTransactionId: `missing-${crypto.randomUUID()}`,
    });
    const result = await submitWager<TransactionResultBody>(http, rollback);
    expect(result.status).toBe(202);
    const response = await get<Record<string, unknown>>(`/wagering/transactions/${result.body.transactionId}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'PENDING_REFERENCE',
      referenceExternalTransactionId: rollback.referenceExternalTransactionId,
      observedBalance: { amount: '10.00', currency: 'BRL' },
    });
    expect(response.body.failureCode).toBeUndefined();
    expect(response.body.retryable).toBeUndefined();
  });

  test('a abertura é consultável pelo id interno (kind OPENING, provider "system")', async () => {
    const wallet = await openWallet(http, '1000.00');
    const [opening] = await database.db.query<{ id: string }>("SELECT id FROM wager_transactions WHERE wallet_id = ? AND kind = 'OPENING'", [wallet.id]);
    const response = await get(`/wagering/transactions/${opening!.id}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      transactionId: opening!.id,
      providerId: 'system',
      externalTransactionId: `opening:${wallet.id}`,
      kind: 'OPENING',
      status: 'PROCESSED',
      money: { amount: '1000.00', currency: 'BRL' },
      observedBalance: { amount: '1000.00', currency: 'BRL' },
    });
  });

  test('id interno em maiúsculas encontra a mesma transação (I-58); ids externos são case-sensitive', async () => {
    const wallet = await openWallet(http, '10.00');
    const bet = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, externalTransactionId: `Ext-${crypto.randomUUID()}` });
    const result = await submitWager<TransactionResultBody>(http, bet);
    expect((await get(`/wagering/transactions/${result.body.transactionId.toUpperCase()}`)).body).toMatchObject({
      transactionId: result.body.transactionId,
    });
    expect((await get(`/providers/${enc(bet.providerId)}/wagering/transactions/${enc(bet.externalTransactionId)}`)).status).toBe(200);
    expectError(
      await get(`/providers/${enc(bet.providerId)}/wagering/transactions/${enc(bet.externalTransactionId.toLowerCase())}`),
      404,
      'TRANSACTION_NOT_FOUND',
    );
  });
});

describe('erros das consultas de transação (cenário 5, I-55, I-50, I-07)', () => {
  test('inexistente pelas duas rotas → 404 TRANSACTION_NOT_FOUND com retryable false', async () => {
    expectError(await get('/wagering/transactions/0192f291-27dd-7d3f-8071-000000000404'), 404, 'TRANSACTION_NOT_FOUND');
    expectError(await get(`/providers/provider-a/wagering/transactions/never-${crypto.randomUUID()}`), 404, 'TRANSACTION_NOT_FOUND');
  });

  test('transactionId malformado → 400; providerId "system" → 400; id externo com mais de 255 → 400', async () => {
    expectError(await get('/wagering/transactions/123'), 400, 'VALIDATION_ERROR');
    expectError(await get('/providers/system/wagering/transactions/anything'), 400, 'VALIDATION_ERROR');
    expectError(await get(`/providers/provider-a/wagering/transactions/${'x'.repeat(256)}`), 400, 'VALIDATION_ERROR');
  });

  test('a abertura não é alcançável pela rota de provedor ("system" recusado)', async () => {
    const wallet = await openWallet(http, '1.00');
    expectError(await get(`/providers/system/wagering/transactions/${enc(`opening:${wallet.id}`)}`), 400, 'VALIDATION_ERROR');
  });
});

describe('SC-011: as rotas GET respondem em menos de 1 s, sem disputa', () => {
  test('wallet, ledger, transação por id e por provedor', async () => {
    const wallet = await openWallet(http, '100.00');
    const bet = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId });
    const result = await submitWager<TransactionResultBody>(http, bet);
    const responses = await Promise.all([
      get(`/wallets/${wallet.id}`),
      get(`/wallets/${wallet.id}/ledger`),
      get(`/wagering/transactions/${result.body.transactionId}`),
      get(`/providers/${enc(bet.providerId)}/wagering/transactions/${enc(bet.externalTransactionId)}`),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.elapsedMs).toBeLessThan(1000);
    }
    await assertWalletMatchesLedger(database.db, wallet.id);
  });
});
