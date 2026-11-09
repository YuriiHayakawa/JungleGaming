// T107 — banco indisponível: 503 sem efeito parcial e reenvio seguro depois que ele volta, sem reiniciar a app
// (US9 cenários 1 a 3; FR-043, I-34, SC-007). A app fala com o PostgreSQL através do proxy TCP do T106; o teste lê e
// segura locks direto no banco, sem passar pelo proxy.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { startApp, type RunningApp } from '../support/app-harness.ts';
import { wagerRequest, walletRequest } from '../support/factories.ts';
import { fetcherFor, postJson, type ErrorBody, type Fetcher, type TransactionResultBody } from '../support/http.ts';
import { startTcpProxy, type TcpProxy } from '../support/tcp-proxy.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('db_unavailable');
let proxy: TcpProxy;
let running: RunningApp;
let http: Fetcher;

beforeAll(async () => {
  proxy = await startTcpProxy(database.url);
  running = await startApp({ databaseUrl: proxy.url });
  http = fetcherFor(running.baseUrl);
});
afterAll(async () => {
  await running?.close();
  proxy?.close();
});

/** Contagens do pg.Pool real da app (lidas, não substituídas): clientes no pool e quantos estão livres. */
async function poolCounts(): Promise<{ total: number; idle: number; waiting: number }> {
  const pool = (await running.orm.em.getConnection().getNativeClient()) as unknown as {
    totalCount: number;
    idleCount: number;
    waitingCount: number;
  };
  return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount };
}

async function counts(walletId: string) {
  const [row] = await database.db.query<Record<string, string>>(
    `SELECT (SELECT count(*) FROM wager_transactions WHERE wallet_id = ?)::text AS txs,
            (SELECT count(*) FROM wallet_ledger_entries WHERE wallet_id = ?)::text AS entries,
            (SELECT count(*) FROM outbox_messages WHERE aggregate_id = ?)::text AS events,
            (SELECT balance::text || '/' || version::text FROM wallets WHERE id = ?) AS wallet`,
    [walletId, walletId, walletId, walletId],
  );
  return row;
}

function expectUnavailable(response: { status: number; body: ErrorBody; headers: Headers }): void {
  expect(response.status, JSON.stringify(response.body)).toBe(503);
  expect(response.body.error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', retryable: true });
  expect(response.headers.get('retry-after')).toBe('1');
}

describe('banco fora (cenário 1)', () => {
  test('com o proxy cortado, BET e POST /wallets → 503; depois do restore, sem reiniciar, o reenvio → 201 com 1 efeito', async () => {
    const wallet = await openWallet(http, '100.00');
    const before = await counts(wallet.id);
    const bet = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '10.00', currency: 'BRL' } });
    const newWallet = walletRequest();

    proxy.cut();
    try {
      for (let i = 0; i < 2; i++) {
        expectUnavailable(await submitWager<ErrorBody>(http, bet));
        expectUnavailable(await postJson<ErrorBody>(http, '/wallets', newWallet));
      }
    } finally {
      proxy.restore();
    }
    expect(await counts(wallet.id)).toEqual(before);
    expect(await database.db.query('SELECT id FROM wallets WHERE player_id = ?', [newWallet.playerId])).toEqual([]);

    // cenário 3: a mesma requisição, sem reiniciar a app, é processada como se fosse a primeira
    const retried = await submitWager<TransactionResultBody>(http, bet);
    expect(retried.status, JSON.stringify(retried.body)).toBe(201);
    expect(retried.body).toMatchObject({ status: 'PROCESSED', idempotentReplay: false, balance: { amount: '90.00', currency: 'BRL' } });
    expect(await database.db.query('SELECT id FROM wager_transactions WHERE external_transaction_id = ?', [bet.externalTransactionId])).toHaveLength(1);
    expect(await database.db.query("SELECT id FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'", [wallet.id])).toHaveLength(1);

    const created = await postJson(http, '/wallets', newWallet);
    expect(created.status).toBe(201);
    await assertWalletMatchesLedger(database.db, wallet.id);
  });
});

describe('corte no meio da transação (cenário 2)', () => {
  test('a transação esperando o lock perde a conexão → 503, nenhuma linha parcial; o reenvio → 201 com 1 efeito', async () => {
    const wallet = await openWallet(http, '100.00');
    const before = await counts(wallet.id);
    const bet = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '25.00', currency: 'BRL' } });

    // segura o lock da wallet direto no banco: a BET abre a transação (via proxy) e fica esperando no FOR UPDATE
    const holder = await database.db.connect();
    let pendingResponse: Promise<{ status: number; body: ErrorBody; headers: Headers }> | undefined;
    try {
      await holder.q.query('BEGIN');
      await holder.q.query('SELECT id FROM wallets WHERE id = ? FOR UPDATE', [wallet.id]);
      pendingResponse = submitWager<ErrorBody>(http, bet);

      // espera o backend da app estar de fato dentro da transação, bloqueado no lock
      let waiting = false;
      for (let i = 0; i < 200 && !waiting; i++) {
        const rows = await database.db.query(
          "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%for update%'",
        );
        waiting = rows.length > 0;
        if (!waiting) await Bun.sleep(10);
      }
      expect(waiting).toBe(true);

      proxy.cut();
      expectUnavailable(await pendingResponse);
    } finally {
      proxy.restore();
      await holder.q.query('ROLLBACK').catch(() => {});
      holder.release();
    }

    // o PostgreSQL desfaz a transação da conexão perdida: nada ficou pela metade
    for (let i = 0; i < 100; i++) {
      const rows = await database.db.query("SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
      if (rows.length === 0) break;
      await Bun.sleep(20);
    }
    expect(await counts(wallet.id)).toEqual(before);

    // T110: o cliente que perdeu a conexão no meio da transação foi devolvido e descartado; nenhum ficou emprestado
    const afterCut = await poolCounts();
    expect(afterCut.total - afterCut.idle).toBe(0);
    expect(afterCut.waiting).toBe(0);

    const retried = await submitWager<TransactionResultBody>(http, bet);
    expect(retried.status, JSON.stringify(retried.body)).toBe(201);
    expect(retried.body).toMatchObject({ idempotentReplay: false, balance: { amount: '75.00', currency: 'BRL' } });
    const afterRetry = await poolCounts();
    expect(afterRetry.total - afterRetry.idle).toBe(0);
    expect(await database.db.query('SELECT id FROM wallet_ledger_entries WHERE transaction_id = ?', [retried.body.transactionId])).toHaveLength(1);
    await assertWalletMatchesLedger(database.db, wallet.id);
  });
});
