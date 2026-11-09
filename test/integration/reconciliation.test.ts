// T012 — reconciliação consistente, somente leitura, erros e desempenho (US1 cenários 1, 2, 6 e 7; FR-001 a FR-004,
// FR-009 a FR-012; SC-001, SC-008, SC-009; I-37, I-74), com PostgreSQL e MiniStack reais. Uma app com consumidor e
// worker de PENDING_REFERENCE movimenta as wallets pela API e pela fila; uma segunda app fala com o banco através de um
// proxy TCP real, para o 503. Toda wallet tocada termina com assertWalletMatchesLedger.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { startApp, type RunningApp } from '../support/app-harness.ts';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { wagerRequest } from '../support/factories.ts';
import { fetcherFor, postJson, type ErrorBody, type Fetcher, type TransactionResultBody, type WalletBody } from '../support/http.ts';
import { newMessageId, sendEnvelope, wagerEnvelope } from '../support/messages.ts';
import { PENDING_WORKER_ENV } from '../support/pending.ts';
import { waitFor } from '../support/sqs-client.ts';
import { startTcpProxy, type TcpProxy } from '../support/tcp-proxy.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { useTestQueues } from '../support/test-queues.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('reconciliation');
const queues = useTestQueues('reconciliation');
let app: RunningApp;
let http: Fetcher;
let proxy: TcpProxy;
let proxied: RunningApp;

beforeAll(async () => {
  app = await startApp({
    databaseUrl: database.url,
    roles: { consumer: true, pendingWorker: true },
    queues: queues.env(),
    env: { ...PENDING_WORKER_ENV, CONSUMER_WAIT_SECONDS: '1' },
  });
  http = fetcherFor(app.baseUrl);
  proxy = await startTcpProxy(database.url);
  proxied = await startApp({ databaseUrl: proxy.url, env: { WALLET_LOCK_TIMEOUT_MS: '1000', DB_POOL_ACQUIRE_TIMEOUT_MS: '2000' } });
});

afterAll(async () => {
  await proxied?.close();
  proxy?.close();
  await app?.close();
});

interface ReconciliationBody {
  walletId: string;
  storedBalance: { amount: string; currency: string };
  calculatedBalance: { amount: string; currency: string };
  difference: { amount: string; currency: string };
  consistent: boolean;
  chainConsistent: boolean;
  checkedEntries: number;
  firstBrokenSeq?: number;
}

function reconcile<B = ReconciliationBody>(fetcher: Fetcher, walletId: string, body?: unknown, headers: Record<string, string> = {}) {
  return postJson<B>(fetcher, `/wallets/${walletId}/reconciliation`, body ?? '', headers);
}

async function ledgerCount(walletId: string): Promise<number> {
  const [row] = await database.db.query<{ n: string }>('SELECT count(*)::text AS n FROM wallet_ledger_entries WHERE wallet_id = ?', [walletId]);
  return Number.parseInt(row!.n, 10);
}

async function statusOf(externalId: string): Promise<string | undefined> {
  const rows = await database.db.query<{ status: string }>(
    'SELECT status FROM wager_transactions WHERE provider_id = ? AND external_transaction_id = ?',
    ['provider-a', externalId],
  );
  return rows[0]?.status;
}

/** Fotografia das tabelas tocáveis: cada linha inteira, em ordem estável. */
async function tablesSnapshot(): Promise<Record<string, string>> {
  const [row] = await database.db.query<Record<string, string>>(
    `SELECT
       (SELECT coalesce(string_agg(row_to_json(w)::text, '|' ORDER BY w.id), '') FROM wallets w) AS wallets,
       (SELECT coalesce(string_agg(row_to_json(l)::text, '|' ORDER BY l.seq), '') FROM wallet_ledger_entries l) AS ledger,
       (SELECT coalesce(string_agg(row_to_json(t)::text, '|' ORDER BY t.id), '') FROM wager_transactions t) AS transactions,
       (SELECT coalesce(string_agg(row_to_json(o)::text, '|' ORDER BY o.id), '') FROM outbox_messages o) AS outbox,
       (SELECT coalesce(string_agg(row_to_json(i)::text, '|' ORDER BY i.message_id), '') FROM inbox_messages i) AS inbox`,
  );
  return row!;
}

function expectConsistent(response: { status: number; body: ReconciliationBody }, wallet: { id: string }, balance: string, entries: number) {
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body).toEqual({
    walletId: wallet.id,
    storedBalance: { amount: balance, currency: 'BRL' },
    calculatedBalance: { amount: balance, currency: 'BRL' },
    difference: { amount: '0.00', currency: 'BRL' },
    consistent: true,
    chainConsistent: true,
    checkedEntries: entries,
  });
}

describe('wallet consistente (US1 cenário 1; SC-001)', () => {
  test('depois de BET, WIN, LOSS, REFUND, ROLLBACK, PENDING_REFERENCE resolvida e transações pela fila', async () => {
    const wallet = await openWallet(http, '100.00');
    const base = { walletId: wallet.id, playerId: wallet.playerId };
    const ok = async (request: ReturnType<typeof wagerRequest>, expected: number) => {
      const response = await submitWager<TransactionResultBody>(http, request);
      expect(response.status, JSON.stringify(response.body)).toBe(expected);
      return response;
    };

    const bet1 = wagerRequest('BET', { ...base, roundId: 'r1', money: { amount: '10.00', currency: 'BRL' } });
    await ok(bet1, 201); // 90.00
    const win1 = wagerRequest('WIN', { ...base, roundId: 'r1', money: { amount: '25.00', currency: 'BRL' }, referenceExternalTransactionId: bet1.externalTransactionId });
    await ok(win1, 201); // 115.00
    await ok(wagerRequest('LOSS', { ...base, roundId: 'r1', money: { amount: '0.00', currency: 'BRL' }, referenceExternalTransactionId: bet1.externalTransactionId }), 201);
    const bet2 = wagerRequest('BET', { ...base, roundId: 'r2', money: { amount: '20.00', currency: 'BRL' } });
    await ok(bet2, 201); // 95.00
    await ok(wagerRequest('REFUND', { ...base, roundId: 'r2', money: { amount: '20.00', currency: 'BRL' }, referenceExternalTransactionId: bet2.externalTransactionId }), 201); // 115.00
    await ok(wagerRequest('ROLLBACK', { ...base, roundId: 'r1', money: { amount: '25.00', currency: 'BRL' }, referenceExternalTransactionId: win1.externalTransactionId }), 201); // 90.00

    // Reversão antes da referência: PENDING_REFERENCE resolvida pelo worker quando a BET chega.
    const bet3 = wagerRequest('BET', { ...base, roundId: 'r3', money: { amount: '5.00', currency: 'BRL' } });
    const refund3 = wagerRequest('REFUND', { ...base, roundId: 'r3', money: { amount: '5.00', currency: 'BRL' }, referenceExternalTransactionId: bet3.externalTransactionId });
    await ok(refund3, 202);
    await ok(bet3, 201); // 85.00
    await waitFor(async () => (await statusOf(refund3.externalTransactionId)) === 'PROCESSED', 15_000, 50); // 90.00

    // Pela fila: uma BET e uma WIN.
    const queuedBet = wagerRequest('BET', { ...base, roundId: 'r4', money: { amount: '7.50', currency: 'BRL' } });
    const queuedWin = wagerRequest('WIN', { ...base, roundId: 'r4', money: { amount: '1.25', currency: 'BRL' } });
    await sendEnvelope(queues.urls.transactions, wagerEnvelope(queuedBet, { messageId: newMessageId('recon-bet') }));
    await sendEnvelope(queues.urls.transactions, wagerEnvelope(queuedWin, { messageId: newMessageId('recon-win') }));
    await waitFor(async () => (await statusOf(queuedBet.externalTransactionId)) === 'PROCESSED', 15_000, 50);
    await waitFor(async () => (await statusOf(queuedWin.externalTransactionId)) === 'PROCESSED', 15_000, 50); // 83.75

    const entries = await ledgerCount(wallet.id);
    // abertura + BET, WIN, BET, REFUND, ROLLBACK, BET, REFUND, BET e WIN da fila (a LOSS não gera lançamento)
    expect(entries).toBe(10);
    expectConsistent(await reconcile(http, wallet.id), wallet, '83.75', entries);
    // Outra leitura dá o mesmo resultado.
    expectConsistent(await reconcile(http, wallet.id), wallet, '83.75', entries);
    await assertWalletMatchesLedger(database.db, wallet.id);
  }, 60_000);

  test('wallet com saldo inicial zero: calculatedBalance 0.00, checkedEntries 0, consistent true (US1 cenário 2)', async () => {
    const wallet = await openWallet(http, '0.00');
    expectConsistent(await reconcile(http, wallet.id), wallet, '0.00', 0);
    await assertWalletMatchesLedger(database.db, wallet.id);
  });
});

describe('somente leitura (US1 cenário 7; FR-002)', () => {
  test('nada muda em wallets, ledger, transações, outbox e inbox; o corpo enviado é ignorado', async () => {
    const wallet = await openWallet(http, '50.00');
    expect((await submitWager(http, wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId }))).status).toBe(201);
    // Espera o consumidor e o worker ficarem quietos (nada pendente para eles nesta wallet).
    await Bun.sleep(300);
    const before = await tablesSnapshot();

    const plain = await reconcile(http, wallet.id);
    const withBody = await reconcile(http, wallet.id, {
      storedBalance: { amount: '1.00', currency: 'BRL' },
      walletId: '00000000-0000-7000-8000-000000000000',
      fix: true,
    });
    expect(withBody.status).toBe(200);
    expect(withBody.body).toEqual(plain.body);
    expect(plain.body.walletId).toBe(wallet.id);

    expect(await tablesSnapshot()).toEqual(before);
    await assertWalletMatchesLedger(database.db, wallet.id);
  });
});

describe('erros no envelope único (US1 cenário 6; FR-011, FR-012; I-38)', () => {
  test('wallet inexistente → 404 WALLET_NOT_FOUND', async () => {
    const response = await reconcile<ErrorBody>(http, '0192f291-27dd-7d3f-8071-000000000001');
    expect(response.status).toBe(404);
    expect(response.body.error).toMatchObject({ code: 'WALLET_NOT_FOUND', retryable: false });
  });

  test.each(['not-a-uuid', '123', '0192f291-27dd-7d3f-8071'])('walletId malformado (%s) → 400 VALIDATION_ERROR', async (walletId) => {
    const response = await reconcile<ErrorBody>(http, walletId);
    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ code: 'VALIDATION_ERROR', retryable: false });
  });

  test('banco indisponível (proxy cortado) → 503 SERVICE_UNAVAILABLE com Retry-After; nada contado como divergência', async () => {
    const wallet = await openWallet(fetcherFor(proxied.baseUrl), '10.00');
    proxy.cut();
    try {
      const response = await reconcile<ErrorBody>(fetcherFor(proxied.baseUrl), wallet.id);
      expect(response.status, JSON.stringify(response.body)).toBe(503);
      expect(response.body.error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', retryable: true });
      expect(response.headers.get('retry-after')).toBe('1');
      expect(proxied.metrics.counter('reconciliation_divergences_total')).toBe(0);
      expect(proxied.logs.some((l) => l.includes('reconciliation.divergence'))).toBe(false);
    } finally {
      proxy.restore();
    }
    // Volta sem reinício.
    await waitFor(async () => (await reconcile(fetcherFor(proxied.baseUrl), wallet.id)).status === 200, 10_000, 200);
    await assertWalletMatchesLedger(database.db, wallet.id);
  });

  test('X-Correlation-Id ecoado na resposta e presente no envelope de erro', async () => {
    const wallet = await openWallet(http, '1.00');
    const ok = await reconcile(http, wallet.id, undefined, { 'X-Correlation-Id': 'recon-corr-1' });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-correlation-id')).toBe('recon-corr-1');
    const missing = await reconcile<ErrorBody>(http, '0192f291-27dd-7d3f-8071-000000000002', undefined, { 'X-Correlation-Id': 'recon-corr-2' });
    expect(missing.headers.get('x-correlation-id')).toBe('recon-corr-2');
    expect(missing.body.error.correlationId).toBe('recon-corr-2');
    await assertWalletMatchesLedger(database.db, wallet.id);
  });

  test('sem credencial nenhuma: responde normalmente (SC-009)', async () => {
    const wallet = await openWallet(http, '3.00');
    const response = await fetch(`${app.baseUrl}/wallets/${wallet.id}/reconciliation`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(((await response.json()) as ReconciliationBody).consistent).toBe(true);
    await assertWalletMatchesLedger(database.db, wallet.id);
  });
});

describe('desempenho (SC-008)', () => {
  test('wallet com 1 000 lançamentos reconciliada em menos de 1 s', async () => {
    const wallet: WalletBody = await openWallet(http, '1000.00');
    const bets = Array.from({ length: 999 }, () =>
      wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '0.01', currency: 'BRL' } }),
    );
    for (let i = 0; i < bets.length; i += 10) {
      const responses = await Promise.all(bets.slice(i, i + 10).map((bet) => submitWager(http, bet)));
      for (const response of responses) expect(response.status).toBe(201);
    }
    expect(await ledgerCount(wallet.id)).toBe(1000);

    await reconcile(http, wallet.id); // aquece conexão e plano
    const started = performance.now();
    const response = await reconcile(http, wallet.id);
    const elapsed = performance.now() - started;
    expectConsistent(response, wallet, '990.01', 1000);
    expect(elapsed).toBeLessThan(1000);
    console.log(`reconciliation: 1000 entries in ${elapsed.toFixed(1)} ms`);
    await assertWalletMatchesLedger(database.db, wallet.id);
  }, 120_000);
});
