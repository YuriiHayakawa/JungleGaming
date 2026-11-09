// T021 — liveness e readiness com dependências reais atrás de proxies TCP (US2 cenários 1, 2, 3, 5 e 6; FR-013 a
// FR-015, FR-017, FR-018; SC-004, SC-005, SC-009; I-34, I-75). A app fala com o PostgreSQL e com o MiniStack através de
// proxies TCP reais (cortados ou pendurados pelo teste); nada é mockado.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { startApp, type RunningApp } from '../support/app-harness.ts';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { wagerRequest } from '../support/factories.ts';
import { fetcherFor, type Fetcher } from '../support/http.ts';
import { SQS_ENDPOINT, waitFor } from '../support/sqs-client.ts';
import { startTcpProxy, type TcpProxy } from '../support/tcp-proxy.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { useTestQueues } from '../support/test-queues.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('health');
const queues = useTestQueues('health');
let pgProxy: TcpProxy;
let sqsProxy: TcpProxy;
let app: RunningApp;
let http: Fetcher;
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => void unhandled.push(reason);

beforeAll(async () => {
  process.on('unhandledRejection', onUnhandled);
  pgProxy = await startTcpProxy(database.url);
  sqsProxy = await startTcpProxy(SQS_ENDPOINT);
  app = await startApp({
    databaseUrl: pgProxy.url,
    queues: queues.env(sqsProxy.url.replace(/\/$/, '')),
    env: { WALLET_LOCK_TIMEOUT_MS: '1000', DB_POOL_ACQUIRE_TIMEOUT_MS: '2000' },
  });
  http = fetcherFor(app.baseUrl);
});

afterAll(async () => {
  process.off('unhandledRejection', onUnhandled);
  pgProxy?.restore();
  sqsProxy?.restore();
  await app?.close();
  pgProxy?.close();
  sqsProxy?.close();
});

interface HealthResponse {
  status: number;
  body: Record<string, unknown>;
  contentType: string | null;
  elapsedMs: number;
}

async function get(path: string, fetcher: Fetcher = http): Promise<HealthResponse> {
  const started = performance.now();
  const response = await fetcher(path);
  const text = await response.text();
  return {
    status: response.status,
    body: JSON.parse(text) as Record<string, unknown>,
    contentType: response.headers.get('content-type'),
    elapsedMs: performance.now() - started,
  };
}

const READY_OK = { status: 'ok', checks: { postgres: 'up', sqs: 'up' } };
const readyIsOk = async () => (await get('/health/ready')).status === 200;

describe('tudo no ar (US2 cenário 1)', () => {
  test('live 200 {"status":"ok"} e ready 200 com cada dependência up', async () => {
    const live = await get('/health/live');
    expect(live.status).toBe(200);
    expect(live.body).toEqual({ status: 'ok' });

    const ready = await get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual(READY_OK);
    expect(ready.contentType).toContain('application/json');
  });

  test('sem credencial e com corpo próprio, fora do envelope de erro (FR-018; SC-009)', async () => {
    const response = await fetch(`${app.baseUrl}/health/ready`, { headers: {} });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect('error' in body).toBe(false);
  });
});

describe('PostgreSQL fora (US2 cenário 2; SC-004)', () => {
  test('cortado: ready 503 postgres down em até 3 s, live 200; volta a 200 sem reinício', async () => {
    pgProxy.cut();
    try {
      const ready = await get('/health/ready');
      expect(ready.status).toBe(503);
      expect(ready.body).toEqual({ status: 'unavailable', checks: { postgres: 'down', sqs: 'up' } });
      expect(ready.elapsedMs).toBeLessThan(3000);
      expect('error' in ready.body).toBe(false);
      const live = await get('/health/live');
      expect(live.status).toBe(200);
      expect(live.body).toEqual({ status: 'ok' });
    } finally {
      pgProxy.restore();
    }
    await waitFor(readyIsOk, 10_000, 200);
    expect((await get('/health/ready')).body).toEqual(READY_OK);
  });

  test('pendurado (conexão aceita e sem resposta): ready 503 postgres down em até 3 s, sem ficar preso (US2 cenário 6)', async () => {
    await get('/health/ready'); // garante conexões abertas no pool, que também ficam penduradas
    pgProxy.stall();
    try {
      const ready = await get('/health/ready');
      expect(ready.status).toBe(503);
      expect(ready.body).toEqual({ status: 'unavailable', checks: { postgres: 'down', sqs: 'up' } });
      expect(ready.elapsedMs).toBeGreaterThanOrEqual(1900);
      expect(ready.elapsedMs).toBeLessThan(3000);
      const live = await get('/health/live');
      expect(live.status).toBe(200);
      expect(live.elapsedMs).toBeLessThan(500);
    } finally {
      pgProxy.restore();
    }
    await waitFor(readyIsOk, 15_000, 250);
  });
});

describe('SQS fora (US2 cenário 3; FR-017; SC-005)', () => {
  test('cortado: ready 503 sqs down, live 200 e POST /wagering/transactions 201; volta sem reinício', async () => {
    const wallet = await openWallet(http, '100.00');
    sqsProxy.cut();
    try {
      const ready = await get('/health/ready');
      expect(ready.status).toBe(503);
      expect(ready.body).toEqual({ status: 'unavailable', checks: { postgres: 'up', sqs: 'down' } });
      expect(ready.elapsedMs).toBeLessThan(3000);
      expect((await get('/health/live')).status).toBe(200);

      // As submissões por HTTP continuam como com a fila no ar; a outbox acumula (I-34).
      for (let i = 0; i < 3; i++) {
        const response = await submitWager(http, wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId }));
        expect(response.status, JSON.stringify(response.body)).toBe(201);
      }
      const pending = await database.db.query("SELECT 1 FROM outbox_messages WHERE aggregate_id = ? AND published_at IS NULL", [wallet.id]);
      expect(pending.length).toBeGreaterThanOrEqual(6);
    } finally {
      sqsProxy.restore();
    }
    await waitFor(readyIsOk, 15_000, 250);
    await assertWalletMatchesLedger(database.db, wallet.id);
  }, 30_000);

  test('pendurado: ready 503 sqs down em até 3 s, sem ficar preso (US2 cenário 6)', async () => {
    sqsProxy.stall();
    try {
      const ready = await get('/health/ready');
      expect(ready.status).toBe(503);
      expect(ready.body).toEqual({ status: 'unavailable', checks: { postgres: 'up', sqs: 'down' } });
      expect(ready.elapsedMs).toBeGreaterThanOrEqual(1900);
      expect(ready.elapsedMs).toBeLessThan(3000);
    } finally {
      sqsProxy.restore();
    }
    await waitFor(readyIsOk, 20_000, 250);
  }, 30_000);

  test('filas inexistentes (configuração com nomes que não existem): sqs down', async () => {
    const missing = await startApp({
      databaseUrl: database.url,
      env: {
        SQS_TRANSACTIONS_QUEUE: `jg-missing-${crypto.randomUUID().slice(0, 8)}-wager-transactions.fifo`,
        SQS_TRANSACTIONS_DLQ: `jg-missing-${crypto.randomUUID().slice(0, 8)}-wager-transactions-dlq.fifo`,
        SQS_EVENTS_QUEUE: `jg-missing-${crypto.randomUUID().slice(0, 8)}-wager-events.fifo`,
      },
    });
    try {
      const ready = await get('/health/ready', fetcherFor(missing.baseUrl));
      expect(ready.status).toBe(503);
      expect(ready.body).toEqual({ status: 'unavailable', checks: { postgres: 'up', sqs: 'down' } });
      expect((await get('/health/live', fetcherFor(missing.baseUrl))).status).toBe(200);
    } finally {
      await missing.close();
    }
  });
});

describe('log (FR-018; R-41)', () => {
  test('as linhas http.request de /health/live e /health/ready saem em nível debug', async () => {
    await get('/health/live');
    await get('/health/ready');
    const lines = app.logs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.msg === 'http.request' && typeof entry.route === 'string' && entry.route.startsWith('/health/'));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(new Set(lines.map((l) => l.route))).toEqual(new Set(['/health/live', '/health/ready']));
    for (const line of lines) expect(line.level).toBe('debug');
    // As demais rotas continuam em info.
    const others = app.logs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.msg === 'http.request' && entry.route === '/wallets');
    expect(others.length).toBeGreaterThan(0);
    for (const line of others) expect(line.level).toBe('info');
  });

  test('nenhuma rejeição não tratada durante os cortes e travamentos', () => {
    expect(unhandled).toEqual([]);
  });
});
