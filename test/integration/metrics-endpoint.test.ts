// T029 — GET /metrics depois de operações reais (US3 cenários 1 a 6; FR-019 a FR-024; SC-007, SC-009; I-76), lido com
// o parser do formato 0.0.4 (T004). PostgreSQL e MiniStack reais. A app principal fala com o banco através de um proxy
// TCP real (para a coleta com o banco fora); o publicador fica desligado nela, para que os eventos fiquem pendentes, e
// liga numa segunda app quando o teste quer a outbox vazia. A divergência é provocada numa terceira app, sobre o banco
// sem guardas (template próprio, E-4).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { startApp, type RunningApp } from '../support/app-harness.ts';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { wagerRequest } from '../support/factories.ts';
import { fetcherFor, postJson, type Fetcher, type WalletBody } from '../support/http.ts';
import { newMessageId, sendEnvelope, wagerEnvelope } from '../support/messages.ts';
import { parsePrometheus, sampleValue, type ParsedPrometheus } from '../support/prometheus.ts';
import { drainQueue, sendRaw, waitFor, waitForEmpty } from '../support/sqs-client.ts';
import { startTcpProxy, type TcpProxy } from '../support/tcp-proxy.ts';
import { useBareTestDatabase, useTestDatabase } from '../support/test-database.ts';
import { useTestQueues } from '../support/test-queues.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('metrics_endpoint');
const bare = useBareTestDatabase('metrics_endpoint_bare');
const queues = useTestQueues('metrics-endpoint');
let proxy: TcpProxy;
let app: RunningApp;
let http: Fetcher;
let wallet: WalletBody;

const ALLOWED_LABELS = new Set(['status', 'source', 'worker', 'errorCode', 'errorClass', 'outcome', 'kind', 'le']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

beforeAll(async () => {
  proxy = await startTcpProxy(database.url);
  app = await startApp({
    databaseUrl: proxy.url,
    roles: { consumer: true },
    queues: queues.env(),
    env: {
      CONSUMER_WAIT_SECONDS: '1',
      CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '6',
      CONSUMER_RETRY_BASE_SECONDS: '1',
      WALLET_LOCK_TIMEOUT_MS: '300',
      DB_POOL_ACQUIRE_TIMEOUT_MS: '2000',
    },
  });
  http = fetcherFor(app.baseUrl);
  wallet = await openWallet(http, '1000.00');
});

afterAll(async () => {
  proxy?.restore();
  await app?.close();
  proxy?.close();
});

interface Scrape {
  status: number;
  contentType: string | null;
  text: string;
  parsed: ParsedPrometheus;
}

async function scrape(fetcher: Fetcher = http): Promise<Scrape> {
  const response = await fetcher('/metrics');
  const text = await response.text();
  return { status: response.status, contentType: response.headers.get('content-type'), text, parsed: parsePrometheus(text) };
}

const value = (s: Scrape, name: string, labels: Record<string, string> = {}) => sampleValue(s.parsed, name, labels) ?? 0;
const base = () => ({ walletId: wallet.id, playerId: wallet.playerId });

async function pendingInDatabase(): Promise<{ pending: number; oldest: Date | null }> {
  const [row] = await database.db.query<{ pending: string; oldest: Date | null }>(
    'SELECT count(*)::text AS pending, min(occurred_at) AS oldest FROM outbox_messages WHERE published_at IS NULL',
  );
  return { pending: Number.parseInt(row!.pending, 10), oldest: row!.oldest };
}

describe('contadores depois de operações reais (US3 cenários 1 e 2; SC-007)', () => {
  test('transações por status, contadas depois do commit', async () => {
    const before = await scrape();
    expect((await submitWager(http, wagerRequest('BET', base()))).status).toBe(201);
    expect((await submitWager(http, wagerRequest('BET', { ...base(), money: { amount: '99999.00', currency: 'BRL' } }))).status).toBe(422);
    expect((await submitWager(http, wagerRequest('REFUND', { ...base(), referenceExternalTransactionId: `never-${crypto.randomUUID()}` }))).status).toBe(202);
    const after = await scrape();
    expect(value(after, 'transactions_total', { status: 'PROCESSED' })).toBe(value(before, 'transactions_total', { status: 'PROCESSED' }) + 1);
    expect(value(after, 'transactions_total', { status: 'REJECTED' })).toBe(value(before, 'transactions_total', { status: 'REJECTED' }) + 1);
    expect(value(after, 'transactions_total', { status: 'PENDING_REFERENCE' })).toBe(
      value(before, 'transactions_total', { status: 'PENDING_REFERENCE' }) + 1,
    );
  });

  test('replay pela idempotência e mensagem duplicada → duplicates_total{source}', async () => {
    const before = await scrape();
    const bet = wagerRequest('BET', base());
    expect((await submitWager(http, bet)).status).toBe(201);
    expect((await submitWager(http, bet)).status).toBe(200);

    const envelope = wagerEnvelope(wagerRequest('BET', base()), { messageId: newMessageId('metrics-dup') });
    await sendEnvelope(queues.urls.transactions, envelope);
    await waitForEmpty(queues.urls.transactions, 10_000);
    await sendEnvelope(queues.urls.transactions, envelope, { deduplicationId: `${envelope.messageId}-again` });
    await waitFor(async () => value(await scrape(), 'duplicates_total', { source: 'inbox' }) === value(before, 'duplicates_total', { source: 'inbox' }) + 1, 10_000, 100);

    const after = await scrape();
    expect(value(after, 'duplicates_total', { source: 'idempotency' })).toBe(value(before, 'duplicates_total', { source: 'idempotency' }) + 1);
    expect(value(after, 'duplicates_total', { source: 'inbox' })).toBe(value(before, 'duplicates_total', { source: 'inbox' }) + 1);
  }, 30_000);

  test('lock esgotado na fila → retries_total{worker="consumer"}, lock_conflicts_total e processing_latency_ms', async () => {
    const before = await scrape();
    const holder = await database.db.connect();
    await holder.q.query('BEGIN');
    await holder.q.query('SELECT id FROM wallets WHERE id = ? FOR UPDATE', [wallet.id]);
    try {
      await sendEnvelope(queues.urls.transactions, wagerEnvelope(wagerRequest('BET', base()), { messageId: newMessageId('metrics-locked') }));
      await waitFor(async () => value(await scrape(), 'retries_total', { worker: 'consumer' }) > value(before, 'retries_total', { worker: 'consumer' }), 10_000, 100);
    } finally {
      await holder.q.query('ROLLBACK').catch(() => {});
      holder.release();
    }
    await waitForEmpty(queues.urls.transactions, 15_000);
    const after = await scrape();
    expect(value(after, 'lock_conflicts_total')).toBeGreaterThan(value(before, 'lock_conflicts_total'));
    const countBefore = value(before, 'processing_latency_ms_count', { worker: 'consumer' });
    const countAfter = value(after, 'processing_latency_ms_count', { worker: 'consumer' });
    expect(countAfter).toBeGreaterThan(countBefore);
    // Histograma coerente: +Inf = _count; buckets cumulativos; o mesmo que a porta em memória registrou.
    expect(value(after, 'processing_latency_ms_bucket', { worker: 'consumer', le: '+Inf' })).toBe(countAfter);
    const inMemory = app.metrics.snapshot().histograms.find((h) => h.name === 'processing_latency_ms' && h.labels.worker === 'consumer');
    expect(inMemory?.count).toBe(countAfter);
    expect(value(after, 'processing_latency_ms_sum', { worker: 'consumer' })).toBe(inMemory!.sum);
  }, 30_000);

  test('mensagem malformada → dlq_total{errorCode="MALFORMED_MESSAGE",errorClass="permanent"}', async () => {
    const labels = { errorCode: 'MALFORMED_MESSAGE', errorClass: 'permanent' };
    const before = value(await scrape(), 'dlq_total', labels);
    await sendRaw(queues.urls.transactions, '{ not json', { groupId: 'metrics-endpoint-malformed', deduplicationId: newMessageId('malformed') });
    await waitFor(async () => value(await scrape(), 'dlq_total', labels) === before + 1, 10_000, 100);
    await drainQueue(queues.urls.dlq, { quietMs: 500, timeoutMs: 3_000 });
  });

  test('cada contador exposto é igual ao da porta em memória da instância', async () => {
    const s = await scrape();
    for (const series of app.metrics.snapshot().counters) {
      expect(value(s, series.name, series.labels), `${series.name}${JSON.stringify(series.labels)}`).toBe(series.value);
    }
  });
});

describe('gauges da outbox lidos do banco (US3 cenário 4; FR-021)', () => {
  test('publicador desligado: pendentes e idade do mais antigo iguais ao banco; depois de publicar tudo, ambos 0', async () => {
    const s = await scrape();
    const db = await pendingInDatabase();
    expect(db.pending).toBeGreaterThan(0);
    expect(value(s, 'outbox_pending_events')).toBe(db.pending);
    const expectedAge = (Date.now() - new Date(db.oldest!).getTime()) / 1000;
    const age = value(s, 'outbox_oldest_pending_age_seconds');
    expect(age).toBeGreaterThan(0);
    expect(Math.abs(age - expectedAge)).toBeLessThan(2);

    // Um publicador em outra instância esvazia a outbox; a coleta seguinte mostra 0 e 0.
    const publisher = await startApp({ databaseUrl: database.url, roles: { publisher: true }, queues: queues.env(), env: { PUBLISHER_POLL_MS: '100' } });
    try {
      await waitFor(async () => (await pendingInDatabase()).pending === 0, 20_000, 100);
    } finally {
      await publisher.close();
    }
    const empty = await scrape();
    expect(sampleValue(empty.parsed, 'outbox_pending_events')).toBe(0);
    expect(sampleValue(empty.parsed, 'outbox_oldest_pending_age_seconds')).toBe(0);
    await drainQueue(queues.urls.events, { quietMs: 500, timeoutMs: 5_000 });
  }, 40_000);
});

describe('divergência de reconciliação (US3 cenário 3)', () => {
  test('reconciliation_divergences_total +1 depois de uma divergência num app sobre o banco sem guardas', async () => {
    const divergent = await startApp({ databaseUrl: bare.url });
    try {
      const fetcher = fetcherFor(divergent.baseUrl);
      const before = value(await scrape(fetcher), 'reconciliation_divergences_total');
      const target = await openWallet(fetcher, '10.00');
      await bare.db.query("UPDATE wallets SET balance = '11.00' WHERE id = ?", [target.id]);
      const response = await postJson<{ consistent: boolean }>(fetcher, `/wallets/${target.id}/reconciliation`, '');
      expect(response.status).toBe(200);
      expect(response.body.consistent).toBe(false);
      expect(value(await scrape(fetcher), 'reconciliation_divergences_total')).toBe(before + 1);
    } finally {
      await divergent.close();
    }
    // Na instância principal (sem divergência) o contador continua 0.
    expect(sampleValue((await scrape()).parsed, 'reconciliation_divergences_total')).toBe(0);
  });
});

describe('banco fora durante a coleta (FR-022)', () => {
  test('200 sem os gauges da outbox e com o restante; aviso no log', async () => {
    proxy.cut();
    try {
      const s = await scrape();
      expect(s.status).toBe(200);
      expect(s.parsed.families.has('outbox_pending_events')).toBe(false);
      expect(s.parsed.families.has('outbox_oldest_pending_age_seconds')).toBe(false);
      expect(s.parsed.families.get('transactions_total')?.type).toBe('counter');
      expect(value(s, 'transactions_total', { status: 'PROCESSED' })).toBeGreaterThan(0);
      expect(app.logs.some((l) => l.includes('"msg":"metrics.outbox_lag_unavailable"') && l.includes('"level":"warn"'))).toBe(true);
    } finally {
      proxy.restore();
    }
    await waitFor(async () => (await scrape()).parsed.families.has('outbox_pending_events'), 10_000, 200);
  });
});

describe('contrato da exposição (US3 cenários 5 e 6; FR-019, FR-023; SC-009)', () => {
  test('Content-Type 0.0.4, sem credencial, rótulos só da lista fechada, nenhum valor com cara de id ou de número', async () => {
    const response = await fetch(`${app.baseUrl}/metrics`); // sem nenhum header
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
    const parsed = parsePrometheus(await response.text());
    const labelled = parsed.samples.filter((s) => Object.keys(s.labels).length > 0);
    expect(labelled.length).toBeGreaterThan(0);
    for (const sample of parsed.samples) {
      for (const [key, raw] of Object.entries(sample.labels)) {
        expect(ALLOWED_LABELS.has(key), `${sample.name}: rótulo ${key}`).toBe(true);
        if (key === 'le') continue;
        expect(raw, `${sample.name}{${key}}`).not.toMatch(UUID);
        expect(raw, `${sample.name}{${key}}`).not.toMatch(/^-?\d+(\.\d+)?$/);
        expect(raw).not.toBe(wallet.id);
        expect(raw).not.toBe('provider-a');
      }
    }
  });

  test('a requisição a /metrics é logada em nível debug', async () => {
    await scrape();
    const lines = app.logs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.msg === 'http.request' && entry.route === '/metrics');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.level).toBe('debug');
    await assertWalletMatchesLedger(database.db, wallet.id);
  });
});
