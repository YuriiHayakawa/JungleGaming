// T102 — contrato HTTP: as cinco situações sempre distinguíveis e o envelope único de erro (US7 cenários 1 a 3;
// FR-054 a FR-058, SC-009, SC-011, I-38, I-39, I-44, I-45, I-48, I-50, I-59).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { FAILURE_TAXONOMY, type TaxonomyCode } from '../../src/wagering/domain/failure-code.ts';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { startApp, type RunningApp } from '../support/app-harness.ts';
import { idempotencyKeyFor, wagerRequest, walletRequest } from '../support/factories.ts';
import { fetcherFor, postJson, type ErrorBody, type Fetcher, type TransactionResultBody } from '../support/http.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('http_contract');
let running: RunningApp;
let http: Fetcher;

beforeAll(async () => {
  // hierarquia do I-51 respeitada (500 < 1000; 4000 > 1000 + 500 + 2000): o 503 por lock sai em ~500 ms
  running = await startApp({
    databaseUrl: database.url,
    env: { WALLET_LOCK_TIMEOUT_MS: '500', DB_POOL_ACQUIRE_TIMEOUT_MS: '1000', HTTP_SERVER_TIMEOUT_MS: '4000' },
  });
  http = fetcherFor(running.baseUrl);
});
afterAll(async () => {
  await running?.close();
});

/** Envelope do I-38, com `retryable` igual ao da taxonomia §7. */
function expectEnvelope(response: { status: number; body: unknown; headers: Headers }, status: number, code: TaxonomyCode): void {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  const body = response.body as ErrorBody;
  expect(Object.keys(body)).toEqual(['error']);
  expect(body.error).toMatchObject({ code, retryable: FAILURE_TAXONOMY[code].retryable });
  expect(typeof body.error.message).toBe('string');
  expect(body.error.correlationId).toBe(response.headers.get('x-correlation-id') ?? '<missing header>');
}

async function raw(path: string, init: RequestInit) {
  const started = performance.now();
  const response = await http(path, init);
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, body: text ? (JSON.parse(text) as unknown) : {}, elapsedMs: performance.now() - started };
}

describe('as cinco situações da submissão têm status distintos (cenário 2)', () => {
  test('400, 409, 422, 202 e 503', async () => {
    const wallet = await openWallet(http, '10.00');
    const statuses: number[] = [];

    // payload inválido → 400
    const invalid = await submitWager<ErrorBody>(http, { ...wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId }), money: { amount: '1.001', currency: 'BRL' } });
    expectEnvelope(invalid, 400, 'VALIDATION_ERROR');
    statuses.push(invalid.status);

    // conflito de idempotência → 409
    const bet = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '1.00', currency: 'BRL' } });
    expect((await submitWager(http, bet)).status).toBe(201);
    const conflict = await submitWager<ErrorBody>(http, { ...bet, money: { amount: '2.00', currency: 'BRL' } });
    expectEnvelope(conflict, 409, 'IDEMPOTENCY_CONFLICT');
    statuses.push(conflict.status);

    // rejeição de negócio → 422 com corpo TransactionResult (I-45)
    const rejected = await submitWager<TransactionResultBody>(
      http,
      wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '999.00', currency: 'BRL' } }),
    );
    expect(rejected.status).toBe(422);
    expect(rejected.body).toEqual({
      transactionId: expect.any(String),
      status: 'REJECTED',
      balance: { amount: '9.00', currency: 'BRL' },
      idempotentReplay: false,
      failureCode: 'INSUFFICIENT_FUNDS',
      retryable: false,
    });
    statuses.push(rejected.status);

    // aceite pendente → 202
    const pending = await submitWager<TransactionResultBody>(
      http,
      wagerRequest('ROLLBACK', {
        walletId: wallet.id,
        playerId: wallet.playerId,
        money: { amount: '1.00', currency: 'BRL' },
        referenceExternalTransactionId: `missing-${crypto.randomUUID()}`,
      }),
    );
    expect(pending.status).toBe(202);
    expect(pending.body).toMatchObject({ status: 'PENDING_REFERENCE', idempotentReplay: false });
    statuses.push(pending.status);

    // falha transitória → 503 com Retry-After, provocada pelo lock externo do T073
    const holder = await database.db.connect();
    try {
      await holder.q.query('BEGIN');
      await holder.q.query('SELECT id FROM wallets WHERE id = ? FOR UPDATE', [wallet.id]);
      const unavailable = await submitWager<ErrorBody>(http, wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId }));
      expectEnvelope(unavailable, 503, 'SERVICE_UNAVAILABLE');
      expect(unavailable.headers.get('retry-after')).toBe('1');
      statuses.push(unavailable.status);
    } finally {
      await holder.q.query('ROLLBACK').catch(() => {});
      holder.release();
    }

    expect(statuses).toEqual([400, 409, 422, 202, 503]);
    expect(new Set(statuses).size).toBe(5);
    await assertWalletMatchesLedger(database.db, wallet.id);
  });
});

describe('envelope único e taxonomia (cenários 1 e 3)', () => {
  test('400, 404 e 409 em POST /wallets usam o envelope com retryable false', async () => {
    expectEnvelope(await postJson(http, '/wallets', { playerId: '', initialBalance: { amount: '1.00', currency: 'BRL' } }), 400, 'VALIDATION_ERROR');
    const request = walletRequest();
    expect((await postJson(http, '/wallets', request)).status).toBe(201);
    const duplicate = await postJson<ErrorBody>(http, '/wallets', request);
    expectEnvelope(duplicate, 409, 'WALLET_ALREADY_EXISTS');
    expect(Object.keys(duplicate.body.error.details ?? {})).toEqual(['walletId']);
  });

  test('wallet inexistente na submissão → 404 WALLET_NOT_FOUND no envelope', async () => {
    const response = await submitWager<ErrorBody>(http, wagerRequest('BET', { walletId: '0192f291-27dd-7d3f-8071-000000000001', playerId: 'nobody' }));
    expectEnvelope(response, 404, 'WALLET_NOT_FOUND');
  });

  test('toda rejeição de negócio traz failureCode da taxonomia com retryable false', async () => {
    const wallet = await openWallet(http, '10.00');
    const cases = [
      wagerRequest('BET', { walletId: wallet.id, playerId: 'intruder' }),
      wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '1.00', currency: 'USD' } }),
      wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '11.00', currency: 'BRL' } }),
    ];
    const codes: string[] = [];
    for (const request of cases) {
      const response = await submitWager<TransactionResultBody>(http, request);
      expect(response.status).toBe(422);
      expect(response.body.retryable).toBe(false);
      expect(FAILURE_TAXONOMY[response.body.failureCode as TaxonomyCode]).toBeDefined();
      codes.push(response.body.failureCode!);
    }
    expect(codes).toEqual(['WALLET_PLAYER_MISMATCH', 'CURRENCY_MISMATCH', 'INSUFFICIENT_FUNDS']);
    await assertWalletMatchesLedger(database.db, wallet.id);
  });
});

describe('balance obrigatório em todo corpo de resultado (ajuste N-13)', () => {
  // TransactionResult.balance só pode faltar numa FAILED, que nunca é corpo de resultado (vira o envelope 500, I-62).
  // Este teste falha se algum 201, 200, 202 ou 422, novo ou em replay, sair sem o saldo observado.
  const expectBalance = (response: { status: number; body: TransactionResultBody }, status: number, amount: string) => {
    expect(response.status, JSON.stringify(response.body)).toBe(status);
    expect(response.body.balance, `${status} sem balance: ${JSON.stringify(response.body)}`).toEqual({ amount, currency: 'BRL' });
  };

  test('201, 200, 202 e 422 (novos e replays) trazem balance como string decimal', async () => {
    const wallet = await openWallet(http, '10.00');
    const base = { walletId: wallet.id, playerId: wallet.playerId };
    const bet = wagerRequest('BET', { ...base, money: { amount: '1.00', currency: 'BRL' } });
    const rejected = wagerRequest('BET', { ...base, money: { amount: '999.00', currency: 'BRL' } });
    const pending = wagerRequest('REFUND', { ...base, money: { amount: '1.00', currency: 'BRL' }, referenceExternalTransactionId: `missing-${crypto.randomUUID()}` });
    const loss = wagerRequest('LOSS', { ...base, money: { amount: '0.00', currency: 'BRL' } });

    expectBalance(await submitWager<TransactionResultBody>(http, bet), 201, '9.00');
    expectBalance(await submitWager<TransactionResultBody>(http, bet), 200, '9.00');
    expectBalance(await submitWager<TransactionResultBody>(http, rejected), 422, '9.00');
    expectBalance(await submitWager<TransactionResultBody>(http, rejected), 422, '9.00');
    expectBalance(await submitWager<TransactionResultBody>(http, pending), 202, '9.00');
    expectBalance(await submitWager<TransactionResultBody>(http, pending), 202, '9.00');
    expectBalance(await submitWager<TransactionResultBody>(http, loss), 201, '9.00'); // PROCESSED sem lançamento
    expectBalance(await submitWager<TransactionResultBody>(http, loss), 200, '9.00');
    await assertWalletMatchesLedger(database.db, wallet.id);
  });
});

describe('edge cases da spec', () => {
  test('Idempotency-Key ausente ou vazio → IDEMPOTENCY_KEY_REQUIRED; mais de 255 → VALIDATION_ERROR', async () => {
    const wallet = await openWallet(http, '10.00');
    const body = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId });
    expectEnvelope(await postJson(http, '/wagering/transactions', body), 400, 'IDEMPOTENCY_KEY_REQUIRED');
    expectEnvelope(await postJson(http, '/wagering/transactions', body, { 'Idempotency-Key': '' }), 400, 'IDEMPOTENCY_KEY_REQUIRED');
    expectEnvelope(await postJson(http, '/wagering/transactions', body, { 'Idempotency-Key': 'k'.repeat(256) }), 400, 'VALIDATION_ERROR');
    await assertWalletMatchesLedger(database.db, wallet.id);
  });

  test('JSON malformado → 400 VALIDATION_ERROR, nas duas rotas de escrita', async () => {
    for (const path of ['/wallets', '/wagering/transactions']) {
      const response = await raw(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'k-malformed' },
        body: '{"playerId": "p1", "initialBalance": ',
      });
      expectEnvelope(response, 400, 'VALIDATION_ERROR');
    }
  });

  test('playerId com mais de 255 e walletId malformado no corpo → 400 VALIDATION_ERROR', async () => {
    const wallet = await openWallet(http, '10.00');
    const long = wagerRequest('BET', { walletId: wallet.id, playerId: 'p'.repeat(256) });
    expectEnvelope(await submitWager(http, long), 400, 'VALIDATION_ERROR');
    const badUuid = wagerRequest('BET', { walletId: 'not-a-uuid', playerId: wallet.playerId });
    expectEnvelope(await submitWager(http, badUuid), 400, 'VALIDATION_ERROR');
    expectEnvelope(await postJson(http, '/wallets', { playerId: 'p'.repeat(256), initialBalance: { amount: '1.00', currency: 'BRL' } }), 400, 'VALIDATION_ERROR');
    await assertWalletMatchesLedger(database.db, wallet.id);
  });
});

describe('I-59: rota, método, Content-Type e tamanho do corpo', () => {
  test('rota inexistente → 404 ROUTE_NOT_FOUND', async () => {
    expectEnvelope(await raw('/nao-existe', { method: 'GET' }), 404, 'ROUTE_NOT_FOUND');
    expectEnvelope(await raw('/nao-existe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }), 404, 'ROUTE_NOT_FOUND');
  });

  test('método inexistente numa rota existente → 404 ROUTE_NOT_FOUND', async () => {
    expectEnvelope(await raw('/wallets', { method: 'DELETE' }), 404, 'ROUTE_NOT_FOUND');
    expectEnvelope(await raw('/wagering/transactions', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' }), 404, 'ROUTE_NOT_FOUND');
  });

  test('Content-Type não suportado (text/plain) → 400 VALIDATION_ERROR, sem ecoar o corpo', async () => {
    const secret = 'eco-proibido-31415.92';
    const wallet = await openWallet(http, '10.00');
    const body = JSON.stringify({ ...wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId }), note: secret });
    for (const path of ['/wallets', '/wagering/transactions']) {
      const response = await raw(path, { method: 'POST', headers: { 'Content-Type': 'text/plain', 'Idempotency-Key': 'k-text' }, body });
      expectEnvelope(response, 400, 'VALIDATION_ERROR');
      expect(response.text).not.toContain(secret);
    }
    await assertWalletMatchesLedger(database.db, wallet.id);
  });

  test('corpo acima do limite do servidor → 400 VALIDATION_ERROR, sem ecoar o corpo', async () => {
    const filler = 'x'.repeat(200 * 1024);
    for (const path of ['/wallets', '/wagering/transactions']) {
      const response = await raw(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'k-big' },
        body: JSON.stringify({ playerId: 'p', initialBalance: { amount: '1.00', currency: 'BRL' }, filler }),
      });
      expectEnvelope(response, 400, 'VALIDATION_ERROR');
      expect(response.text).not.toContain('xxxxxxxxxx');
    }
  });

  test('corpo vazio com Content-Type JSON → 400 VALIDATION_ERROR', async () => {
    for (const path of ['/wallets', '/wagering/transactions']) {
      expectEnvelope(await raw(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'k-empty' } }), 400, 'VALIDATION_ERROR');
    }
  });
});

describe('ordem do I-44 (FR-015, passos 1 a 4)', () => {
  test('chave ausente e corpo inválido → IDEMPOTENCY_KEY_REQUIRED (o header vem antes do corpo)', async () => {
    expectEnvelope(await postJson(http, '/wagering/transactions', { kind: 'BET' }), 400, 'IDEMPOTENCY_KEY_REQUIRED');
  });

  test('corpo inválido com a chave de uma transação existente → 400 VALIDATION_ERROR, não 409', async () => {
    const wallet = await openWallet(http, '10.00');
    const bet = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '1.00', currency: 'BRL' } });
    expect((await submitWager(http, bet)).status).toBe(201);
    const invalid = await postJson(http, '/wagering/transactions', { ...bet, money: { amount: '-1', currency: 'BRL' } }, { 'Idempotency-Key': idempotencyKeyFor(bet) });
    expectEnvelope(invalid, 400, 'VALIDATION_ERROR');
    await assertWalletMatchesLedger(database.db, wallet.id);
  });

  test('a idempotência vem antes da wallet: a chave existente com walletId inexistente → 409, não 404', async () => {
    const wallet = await openWallet(http, '10.00');
    const bet = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '1.00', currency: 'BRL' } });
    expect((await submitWager(http, bet)).status).toBe(201);
    const response = await submitWager<ErrorBody>(http, { ...bet, walletId: '0192f291-27dd-7d3f-8071-00000000dead' });
    expectEnvelope(response, 409, 'IDEMPOTENCY_CONFLICT');
    const replay = await submitWager<TransactionResultBody>(http, bet);
    expect(replay.status).toBe(200);
    expect(replay.body.idempotentReplay).toBe(true);
    await assertWalletMatchesLedger(database.db, wallet.id);
  });
});

describe('sem eco do payload (FR-058)', () => {
  test('nenhuma resposta de erro contém o amount enviado', async () => {
    const wallet = await openWallet(http, '10.00');
    const amounts = ['98765.432', '-4242.42', '1e9'];
    for (const amount of amounts) {
      const response = await raw('/wagering/transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `k-${crypto.randomUUID()}` },
        body: JSON.stringify({ ...wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId }), money: { amount, currency: 'BRL' } }),
      });
      expectEnvelope(response, 400, 'VALIDATION_ERROR');
      expect(response.text).not.toContain(amount);
    }
    const walletResponse = await raw('/wallets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: 'p', initialBalance: { amount: '55555.555', currency: 'BRL' } }),
    });
    expectEnvelope(walletResponse, 400, 'VALIDATION_ERROR');
    expect(walletResponse.text).not.toContain('55555.555');
    await assertWalletMatchesLedger(database.db, wallet.id);
  });
});

describe('SC-011: operação sem disputa responde em menos de 1 s', () => {
  test('criação de wallet, BET, replay, rejeição, pendência e erro de validação', async () => {
    const created = await postJson<{ id: string; playerId: string }>(http, '/wallets', walletRequest({ initialBalance: { amount: '50.00', currency: 'BRL' } }));
    expect(created.status).toBe(201);
    const wallet = created.body;
    const bet = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId });
    const timings = [
      created.elapsedMs,
      (await submitWager(http, bet)).elapsedMs,
      (await submitWager(http, bet)).elapsedMs,
      (await submitWager(http, wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '999.00', currency: 'BRL' } }))).elapsedMs,
      (
        await submitWager(
          http,
          wagerRequest('REFUND', { walletId: wallet.id, playerId: wallet.playerId, referenceExternalTransactionId: `missing-${crypto.randomUUID()}` }),
        )
      ).elapsedMs,
      (await submitWager(http, { ...bet, externalTransactionId: 'x', money: { amount: 'abc', currency: 'BRL' } })).elapsedMs,
    ];
    for (const ms of timings) expect(ms).toBeLessThan(1000);
    await assertWalletMatchesLedger(database.db, wallet.id);
  });
});
