// T103 — correlationId válido, inválido e ausente, e logs da requisição (FR-058, FR-060, I-53, R-14; constitution VIII).
// As linhas de log vêm do destino injetado no `startApp` (o mesmo JsonLogger da app, sem mock).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { startApp, type RunningApp } from '../support/app-harness.ts';
import { wagerRequest, walletRequest } from '../support/factories.ts';
import { fetcherFor, postJson, type ErrorBody, type Fetcher, type TransactionResultBody, type WalletBody } from '../support/http.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('correlation_id');
const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let running: RunningApp;
let http: Fetcher;

beforeAll(async () => {
  running = await startApp({ databaseUrl: database.url });
  http = fetcherFor(running.baseUrl);
});
afterAll(async () => {
  await running?.close();
});

type LogLine = Record<string, unknown>;
const parsedLogs = (): LogLine[] => running.logs.map((line) => JSON.parse(line) as LogLine);
const linesOf = (correlationId: string) => parsedLogs().filter((line) => line.correlationId === correlationId);
/** O `http.request` é escrito no `finish` da resposta; espera ele aparecer. */
async function requestLinesOf(correlationId: string): Promise<LogLine[]> {
  for (let i = 0; i < 50; i++) {
    const lines = linesOf(correlationId);
    if (lines.some((line) => line.msg === 'http.request')) return lines;
    await Bun.sleep(10);
  }
  return linesOf(correlationId);
}

describe('X-Correlation-Id válido', () => {
  test('volta igual no header, fica gravado na transação e nos eventos da outbox', async () => {
    const wallet = await openWallet(http, '100.00');
    const request = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId });
    const response = await submitWager<TransactionResultBody>(http, request, { 'X-Correlation-Id': 'abc-123' });
    expect(response.status).toBe(201);
    expect(response.headers.get('x-correlation-id')).toBe('abc-123');

    const [row] = await database.db.query<{ correlation_id: string }>('SELECT correlation_id FROM wager_transactions WHERE id = ?', [
      response.body.transactionId,
    ]);
    expect(row?.correlation_id).toBe('abc-123');
    const events = await database.db.query<{ correlation_id: string; payload: { correlationId: string } }>(
      "SELECT correlation_id, payload FROM outbox_messages WHERE payload->'data'->>'transactionId' = ?",
      [response.body.transactionId],
    );
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.correlation_id).toBe('abc-123');
      expect(event.payload.correlationId).toBe('abc-123');
    }
    await assertWalletMatchesLedger(database.db, wallet.id);
  });

  test('em erro, volta em error.correlationId e no header', async () => {
    const response = await postJson<ErrorBody>(http, '/wallets', { playerId: '' }, { 'X-Correlation-Id': 'abc-123.err:1' });
    expect(response.status).toBe(400);
    expect(response.headers.get('x-correlation-id')).toBe('abc-123.err:1');
    expect(response.body.error.correlationId).toBe('abc-123.err:1');
  });

  test('vale para POST /wallets: header, evento de abertura', async () => {
    const response = await postJson<WalletBody>(http, '/wallets', walletRequest(), { 'X-Correlation-Id': 'wallet-corr-1' });
    expect(response.status).toBe(201);
    expect(response.headers.get('x-correlation-id')).toBe('wallet-corr-1');
    const [event] = await database.db.query<{ correlation_id: string }>(
      "SELECT correlation_id FROM outbox_messages WHERE aggregate_id = ? AND event_type = 'WalletBalanceChanged'",
      [response.body.id],
    );
    expect(event?.correlation_id).toBe('wallet-corr-1');
    const [opening] = await database.db.query<{ correlation_id: string }>("SELECT correlation_id FROM wager_transactions WHERE wallet_id = ? AND kind = 'OPENING'", [
      response.body.id,
    ]);
    expect(opening?.correlation_id).toBe('wallet-corr-1');
    await assertWalletMatchesLedger(database.db, response.body.id);
  });
});

describe('X-Correlation-Id ausente ou inválido: nunca 400, o serviço gera um UUIDv7', () => {
  test('ausente → UUIDv7 gerado no header e na transação', async () => {
    const wallet = await openWallet(http, '100.00');
    const response = await submitWager<TransactionResultBody>(http, wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId }));
    expect(response.status).toBe(201);
    const generated = response.headers.get('x-correlation-id');
    expect(generated).toMatch(UUIDV7);
    const [row] = await database.db.query<{ correlation_id: string }>('SELECT correlation_id FROM wager_transactions WHERE id = ?', [
      response.body.transactionId,
    ]);
    expect(row?.correlation_id).toBe(generated!);
    await assertWalletMatchesLedger(database.db, wallet.id);
  });

  const invalid: Array<[string, string]> = [
    ['129 caracteres', 'c'.repeat(129)],
    ['com espaço', 'abc 123'],
    ['vazio', ''],
    ['caractere fora do conjunto', 'abc/123'],
  ];
  for (const [label, header] of invalid) {
    test(`inválido (${label}) → a operação segue e a resposta traz um UUIDv7 gerado`, async () => {
      const wallet = await openWallet(http, '100.00');
      const response = await submitWager<TransactionResultBody>(http, wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId }), {
        'X-Correlation-Id': header,
      });
      expect(response.status).toBe(201);
      expect(response.headers.get('x-correlation-id')).toMatch(UUIDV7);
      const walletResponse = await postJson(http, '/wallets', walletRequest(), { 'X-Correlation-Id': header });
      expect(walletResponse.status).toBe(201);
      expect(walletResponse.headers.get('x-correlation-id')).toMatch(UUIDV7);
      await assertWalletMatchesLedger(database.db, wallet.id);
    });
  }
});

describe('replay com outro correlationId (I-53)', () => {
  test('a resposta usa o correlationId atual; o gravado não muda; nenhum evento novo', async () => {
    const wallet = await openWallet(http, '100.00');
    const request = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId });
    const original = await submitWager<TransactionResultBody>(http, request, { 'X-Correlation-Id': 'original-corr' });
    expect(original.status).toBe(201);
    const eventsBefore = await database.db.query('SELECT id FROM outbox_messages WHERE aggregate_id = ?', [wallet.id]);

    const replay = await submitWager<TransactionResultBody>(http, request, { 'X-Correlation-Id': 'replay-corr' });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ transactionId: original.body.transactionId, idempotentReplay: true });
    expect(replay.headers.get('x-correlation-id')).toBe('replay-corr');

    const [row] = await database.db.query<{ correlation_id: string }>('SELECT correlation_id FROM wager_transactions WHERE id = ?', [
      original.body.transactionId,
    ]);
    expect(row?.correlation_id).toBe('original-corr');
    expect(await database.db.query('SELECT id FROM outbox_messages WHERE aggregate_id = ?', [wallet.id])).toEqual(eventsBefore);
    expect(await database.db.query("SELECT id FROM outbox_messages WHERE correlation_id = 'replay-corr'")).toEqual([]);
    await assertWalletMatchesLedger(database.db, wallet.id);
  });
});

describe('logs da requisição (constitution VIII, FR-058, FR-060)', () => {
  test('BET processada: as linhas trazem correlationId, walletId, providerId e transactionId; nenhuma traz amount/money', async () => {
    const wallet = await openWallet(http, '100.00');
    const amount = '37.19';
    const request = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount, currency: 'BRL' } });
    const response = await submitWager<TransactionResultBody>(http, request, { 'X-Correlation-Id': 'log-bet-1' });
    expect(response.status).toBe(201);

    const lines = await requestLinesOf('log-bet-1');
    const requestLine = lines.find((line) => line.msg === 'http.request');
    expect(requestLine).toMatchObject({
      level: 'info',
      correlationId: 'log-bet-1',
      walletId: wallet.id,
      providerId: request.providerId,
      transactionId: response.body.transactionId,
      method: 'POST',
      route: '/wagering/transactions',
      status: 201,
    });
    // a partir do momento em que são conhecidos, os ids estão certos em toda linha da requisição
    for (const line of lines) {
      if ('walletId' in line) expect(line.walletId).toBe(wallet.id);
      if ('providerId' in line) expect(line.providerId).toBe(request.providerId);
      if ('transactionId' in line) expect(line.transactionId).toBe(response.body.transactionId);
    }
    // nenhuma linha (de nenhuma requisição) carrega valor monetário
    for (const raw of running.logs) {
      const parsed = JSON.parse(raw) as LogLine;
      expect(Object.keys(parsed)).not.toContain('amount');
      expect(Object.keys(parsed)).not.toContain('money');
      expect(raw).not.toContain(`"amount"`);
      expect(raw).not.toContain(`"money"`);
    }
    expect(lines.map((line) => JSON.stringify(line)).join('\n')).not.toContain(amount);
  });

  test('replay e conflito: a linha da requisição traz o transactionId da linha existente', async () => {
    const wallet = await openWallet(http, '100.00');
    const request = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId });
    const original = await submitWager<TransactionResultBody>(http, request);
    await submitWager(http, request, { 'X-Correlation-Id': 'log-replay-1' });
    await submitWager(http, { ...request, money: { amount: '99.00', currency: 'BRL' } }, { 'X-Correlation-Id': 'log-conflict-1' });

    for (const [correlationId, status] of [['log-replay-1', 200], ['log-conflict-1', 409]] as const) {
      const requestLine = (await requestLinesOf(correlationId)).find((line) => line.msg === 'http.request');
      expect(requestLine).toMatchObject({ transactionId: original.body.transactionId, walletId: wallet.id, status });
    }
    await assertWalletMatchesLedger(database.db, wallet.id);
  });

  test('POST /wallets: as linhas trazem correlationId e walletId, sem saldo', async () => {
    const response = await postJson<WalletBody>(http, '/wallets', walletRequest({ initialBalance: { amount: '4321.09', currency: 'BRL' } }), {
      'X-Correlation-Id': 'log-wallet-1',
    });
    expect(response.status).toBe(201);
    const lines = await requestLinesOf('log-wallet-1');
    expect(lines.find((line) => line.msg === 'http.request')).toMatchObject({
      correlationId: 'log-wallet-1',
      walletId: response.body.id,
      route: '/wallets',
      status: 201,
    });
    const text = lines.map((line) => JSON.stringify(line)).join('\n');
    expect(text).not.toContain('4321.09');
    expect(text).not.toContain('"balance"');
    expect(text).not.toContain('"initialBalance"');
  });
});
