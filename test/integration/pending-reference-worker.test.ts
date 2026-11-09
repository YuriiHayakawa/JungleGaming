// T066 — worker de PENDING_REFERENCE (US4 cenários 1 a 3, 6 a 8; FR-023 a FR-031, FR-038; I-11, I-15, I-21, I-61, I-64,
// I-69, I-72, I-73; SC-005), com PostgreSQL real. Uma app "ociosa" (worker desligado) prepara os cenários pela API; o
// worker roda numa app própria por cenário (só um worker por vez no banco do arquivo), com poll de 100 ms, base 100 ms,
// teto 400 ms, 3 tentativas e FixedRandom(0,5) (fator de jitter exatamente 1). Cada teste termina com
// assertWalletMatchesLedger.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { startApp, type RunningApp } from '../support/app-harness.ts';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { FixedRandom } from '../support/fakes.ts';
import { wagerRequest, type WagerRequest } from '../support/factories.ts';
import { fetcherFor, type Fetcher, type WalletBody } from '../support/http.ts';
import { waitFor } from '../support/sqs-client.ts';
import { startTcpProxy } from '../support/tcp-proxy.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('pending_worker');

const FAST = {
  PENDING_WORKER_POLL_MS: '100',
  PENDING_BACKOFF_BASE_MS: '100',
  PENDING_BACKOFF_MAX_MS: '400',
  PENDING_MAX_ATTEMPTS: '3',
};

let idle: RunningApp;
let http: Fetcher;

beforeAll(async () => {
  // Mesmos limites do worker, mas sem o papel: as pendentes criadas aqui têm a 1ª tentativa em created_at + 100 ms.
  idle = await startApp({ databaseUrl: database.url, env: FAST });
  http = fetcherFor(idle.baseUrl);
});
afterAll(async () => {
  await idle?.close();
});

async function withWorker<T>(env: Record<string, string>, fn: (app: RunningApp) => Promise<T>, databaseUrl = database.url): Promise<T> {
  const app = await startApp({ databaseUrl, roles: { pendingWorker: true }, env: { ...FAST, ...env }, random: new FixedRandom(0.5) });
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

interface TxRow extends Record<string, unknown> {
  id: string;
  external_transaction_id: string;
  status: string;
  failure_code: string | null;
  observed_balance: string | null;
  reference_transaction_id: string | null;
  reference_attempts: number;
  next_reference_attempt_at: Date | null;
  correlation_id: string;
  processed_at: Date | null;
  updated_at: Date;
  created_at: Date;
}

const rowOf = async (externalId: string): Promise<TxRow> => {
  const rows = await database.db.query<TxRow>('SELECT * FROM wager_transactions WHERE external_transaction_id = ?', [externalId]);
  expect(rows).toHaveLength(1);
  return rows[0]!;
};

const eventsOf = (transactionId: string) =>
  database.db.query<{ event_type: string; correlation_id: string; payload: { causationId?: string; data: Record<string, unknown> } }>(
    "SELECT event_type, correlation_id, payload FROM outbox_messages WHERE payload->'data'->>'transactionId' = ? ORDER BY id",
    [transactionId],
  );

const ledgerOf = (transactionId: string) =>
  database.db.query<{ direction: string; amount: string; balance_after: string }>(
    'SELECT direction, amount, balance_after FROM wallet_ledger_entries WHERE transaction_id = ?',
    [transactionId],
  );

async function waitStatus(externalId: string, status: string, timeoutMs = 5_000): Promise<TxRow> {
  await waitFor(async () => (await rowOf(externalId)).status === status, timeoutMs, 20);
  return rowOf(externalId);
}

async function submit(request: WagerRequest, expected: number) {
  const response = await submitWager(http, request);
  expect(response.status, JSON.stringify(response.body)).toBe(expected);
  return response.body;
}

function base(wallet: WalletBody) {
  return { walletId: wallet.id, playerId: wallet.playerId };
}

describe('antecipação e conclusão (cenário 1; I-21, I-63, I-69, I-73)', () => {
  test('a BET puxa o REFUND para agora na mesma transação; o worker o conclui com CREDIT e eventos da pendente, sem causationId', async () => {
    // App sem worker e com a base padrão (5 s): a pendente ainda não venceu quando a BET chega.
    const slow = await startApp({ databaseUrl: database.url });
    let wallet: WalletBody;
    let betExternal: string;
    let refund: WagerRequest;
    try {
      const slowHttp = fetcherFor(slow.baseUrl);
      wallet = await openWallet(slowHttp, '100.00');
      betExternal = `bet-${crypto.randomUUID()}`;
      refund = wagerRequest('REFUND', { ...base(wallet), referenceExternalTransactionId: betExternal });
      expect((await submitWager(slowHttp, refund)).status).toBe(202);
      const before = await rowOf(refund.externalTransactionId);
      expect(before.next_reference_attempt_at!.getTime()).toBe(before.created_at.getTime() + 5_000);

      expect((await submitWager(slowHttp, wagerRequest('BET', { ...base(wallet), externalTransactionId: betExternal }))).status).toBe(201);
      const bet = await rowOf(betExternal);
      const anticipated = await rowOf(refund.externalTransactionId);
      expect(anticipated.status).toBe('PENDING_REFERENCE');
      expect(anticipated.reference_attempts).toBe(0);
      // Mesmo instante da conclusão da BET: gravado na transação dela (FR-026).
      expect(anticipated.next_reference_attempt_at!.getTime()).toBe(bet.processed_at!.getTime());
    } finally {
      await slow.close();
    }

    await withWorker({}, async () => {
      const done = await waitStatus(refund.externalTransactionId, 'PROCESSED', 5_000);
      const bet = await rowOf(betExternal);
      const pending = (await rowOf(refund.externalTransactionId));
      expect(done.reference_transaction_id).toBe(bet.id);
      expect(done.observed_balance).toBe('100.00'); // reescrito na conclusão (I-67): 100 − 10 + 10
      expect(done.next_reference_attempt_at).toBeNull();
      expect(done.correlation_id).toBe(pending.correlation_id);
      expect(await ledgerOf(done.id)).toEqual([{ direction: 'CREDIT', amount: '10.00', balance_after: '100.00' }]);
      const events = await eventsOf(done.id);
      expect(events.map((e) => e.event_type)).toEqual(['WagerTransactionPendingReference', 'WalletBalanceChanged', 'WagerTransactionProcessed']);
      for (const event of events.slice(1)) {
        expect(event.correlation_id).toBe(done.correlation_id);
        expect(event.payload.causationId).toBeUndefined();
      }
    });
    await assertWalletMatchesLedger(database.db, wallet!.id);
  }, 30_000);
});

describe('resoluções pelo worker', () => {
  test('a BET chega REJECTED → o REFUND fica REJECTED REFERENCE_REJECTED com WagerTransactionRejected (cenário 2)', async () => {
    const wallet = await openWallet(http, '5.00');
    const betExternal = `bet-${crypto.randomUUID()}`;
    const refund = wagerRequest('REFUND', { ...base(wallet), referenceExternalTransactionId: betExternal });
    await submit(refund, 202);
    await submit(wagerRequest('BET', { ...base(wallet), externalTransactionId: betExternal }), 422); // INSUFFICIENT_FUNDS
    await withWorker({}, async () => {
      const done = await waitStatus(refund.externalTransactionId, 'REJECTED');
      expect(done.failure_code).toBe('REFERENCE_REJECTED');
      expect(done.observed_balance).toBe('5.00');
      expect(await ledgerOf(done.id)).toEqual([]);
      expect((await eventsOf(done.id)).map((e) => e.event_type)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
    });
    await assertWalletMatchesLedger(database.db, wallet.id);
  }, 30_000);

  test('referência que nunca chega: só attempts e a próxima hora mudam; na 3ª tentativa, REFERENCE_NOT_FOUND; a referência tardia não reabre (cenários 3, 6 e 8)', async () => {
    const wallet = await openWallet(http, '100.00');
    const betExternal = `bet-${crypto.randomUUID()}`;
    const refund = wagerRequest('REFUND', { ...base(wallet), referenceExternalTransactionId: betExternal });
    await submit(refund, 202);
    const initial = await rowOf(refund.externalTransactionId);
    const stable = (row: TxRow) => ({
      status: row.status,
      failure_code: row.failure_code,
      observed_balance: row.observed_balance,
      reference_transaction_id: row.reference_transaction_id,
      correlation_id: row.correlation_id,
      processed_at: row.processed_at,
      created_at: row.created_at.getTime(),
    });

    const seen = new Map<number, TxRow>();
    await withWorker({}, async () => {
      await waitFor(async () => {
        const row = await rowOf(refund.externalTransactionId);
        if (row.status === 'PENDING_REFERENCE') {
          expect(stable(row)).toEqual(stable(initial)); // I-11: o resto da linha não muda entre as tentativas
          if (!seen.has(row.reference_attempts)) seen.set(row.reference_attempts, row);
        }
        return row.status !== 'PENDING_REFERENCE';
      }, 5_000, 10);
    });

    // Espera antes da tentativa k: min(100 × 2^(k−1), 400), sem jitter (FixedRandom 0,5) → 200 ms e 400 ms.
    expect(seen.get(1)!.next_reference_attempt_at!.getTime() - seen.get(1)!.updated_at.getTime()).toBe(200);
    expect(seen.get(2)!.next_reference_attempt_at!.getTime() - seen.get(2)!.updated_at.getTime()).toBe(400);

    const rejected = await rowOf(refund.externalTransactionId);
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.failure_code).toBe('REFERENCE_NOT_FOUND');
    expect(rejected.reference_attempts).toBe(2); // as duas que reagendaram; a 3ª esgota e rejeita
    expect(rejected.next_reference_attempt_at).toBeNull();
    expect(await ledgerOf(rejected.id)).toEqual([]);
    expect((await eventsOf(rejected.id)).map((e) => e.event_type)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);

    // A referência que chega depois não reabre a pendente (FR-031).
    await submit(wagerRequest('BET', { ...base(wallet), externalTransactionId: betExternal }), 201);
    await withWorker({}, async () => {
      await Bun.sleep(600);
      const after = await rowOf(refund.externalTransactionId);
      expect(after.status).toBe('REJECTED');
      expect(after.failure_code).toBe('REFERENCE_NOT_FOUND');
      expect(after.updated_at.getTime()).toBe(rejected.updated_at.getTime());
      expect(await ledgerOf(rejected.id)).toEqual([]);
    });
    await assertWalletMatchesLedger(database.db, wallet.id);
  }, 30_000);

  test('PENDING_TTL_MS curto: REFERENCE_NOT_FOUND antes da 3ª tentativa (I-64)', async () => {
    await withWorker({ PENDING_TTL_MS: '300' }, async (app) => {
      const wallet = await openWallet(fetcherFor(app.baseUrl), '100.00');
      const refund = wagerRequest('REFUND', { ...base(wallet), referenceExternalTransactionId: `bet-${crypto.randomUUID()}` });
      expect((await submitWager(fetcherFor(app.baseUrl), refund)).status).toBe(202);
      const done = await waitStatus(refund.externalTransactionId, 'REJECTED', 5_000);
      expect(done.failure_code).toBe('REFERENCE_NOT_FOUND');
      expect(done.reference_attempts).toBeLessThan(2);
      expect(done.updated_at.getTime() - done.created_at.getTime()).toBeGreaterThanOrEqual(300);
      await assertWalletMatchesLedger(database.db, wallet.id);
    });
  }, 30_000);

  test('a referência chega logo antes da última tentativa → resolve normalmente, sem REFERENCE_NOT_FOUND (I-72)', async () => {
    // Base 500 ms e teto 2 s: depois da 2ª tentativa há 2 s até a última, tempo de sobra para a BET chegar.
    const env = { PENDING_BACKOFF_BASE_MS: '500', PENDING_BACKOFF_MAX_MS: '2000' };
    await withWorker(env, async (app) => {
      const appHttp = fetcherFor(app.baseUrl);
      const wallet = await openWallet(appHttp, '100.00');
      const betExternal = `bet-${crypto.randomUUID()}`;
      const refund = wagerRequest('REFUND', { ...base(wallet), referenceExternalTransactionId: betExternal });
      expect((await submitWager(appHttp, refund)).status).toBe(202);
      await waitFor(async () => (await rowOf(refund.externalTransactionId)).reference_attempts === 2, 5_000, 20);
      expect((await submitWager(appHttp, wagerRequest('BET', { ...base(wallet), externalTransactionId: betExternal }))).status).toBe(201);
      const done = await waitStatus(refund.externalTransactionId, 'PROCESSED', 5_000);
      expect(done.reference_attempts).toBe(2);
      expect(await ledgerOf(done.id)).toHaveLength(1);
      await assertWalletMatchesLedger(database.db, wallet.id);
    });
  }, 30_000);

  test('referência em outra rodada → REFERENCE_MISMATCH', async () => {
    const wallet = await openWallet(http, '100.00');
    const betExternal = `bet-${crypto.randomUUID()}`;
    const refund = wagerRequest('REFUND', { ...base(wallet), roundId: 'round-a', referenceExternalTransactionId: betExternal });
    await submit(refund, 202);
    await submit(wagerRequest('BET', { ...base(wallet), roundId: 'round-b', externalTransactionId: betExternal }), 201);
    await withWorker({}, async () => {
      const done = await waitStatus(refund.externalTransactionId, 'REJECTED');
      expect(done.failure_code).toBe('REFERENCE_MISMATCH');
      expect(await ledgerOf(done.id)).toEqual([]);
    });
    await assertWalletMatchesLedger(database.db, wallet.id);
  }, 30_000);

  test('ROLLBACK de WIN com saldo menor na conclusão → REVERSAL_WOULD_OVERDRAW (I-18)', async () => {
    const wallet = await openWallet(http, '100.00');
    const winExternal = `win-${crypto.randomUUID()}`;
    const rollback = wagerRequest('ROLLBACK', { ...base(wallet), money: { amount: '50.00', currency: 'BRL' }, referenceExternalTransactionId: winExternal });
    await submit(rollback, 202);
    await submit(wagerRequest('WIN', { ...base(wallet), externalTransactionId: winExternal, money: { amount: '50.00', currency: 'BRL' } }), 201); // 150
    await submit(wagerRequest('BET', { ...base(wallet), money: { amount: '120.00', currency: 'BRL' } }), 201); // 30
    await withWorker({}, async () => {
      const done = await waitStatus(rollback.externalTransactionId, 'REJECTED');
      expect(done.failure_code).toBe('REVERSAL_WOULD_OVERDRAW');
      expect(done.observed_balance).toBe('30.00');
      expect(await ledgerOf(done.id)).toEqual([]);
    });
    await assertWalletMatchesLedger(database.db, wallet.id);
  }, 30_000);

  test('pendente de pendente: resolve em cadeia depois que a primeira referência chega (I-15, I-63)', async () => {
    const wallet = await openWallet(http, '100.00');
    const betExternal = `bet-${crypto.randomUUID()}`;
    const refund = wagerRequest('REFUND', { ...base(wallet), referenceExternalTransactionId: betExternal });
    await submit(refund, 202);
    const rollback = wagerRequest('ROLLBACK', { ...base(wallet), referenceExternalTransactionId: refund.externalTransactionId });
    await submit(rollback, 202); // a referência existe, mas está PENDING_REFERENCE
    await submit(wagerRequest('BET', { ...base(wallet), externalTransactionId: betExternal }), 201); // 90
    await withWorker({}, async () => {
      const first = await waitStatus(refund.externalTransactionId, 'PROCESSED');
      const second = await waitStatus(rollback.externalTransactionId, 'PROCESSED');
      expect(second.reference_transaction_id).toBe(first.id);
      expect(await ledgerOf(first.id)).toEqual([{ direction: 'CREDIT', amount: '10.00', balance_after: '100.00' }]);
      expect(await ledgerOf(second.id)).toEqual([{ direction: 'DEBIT', amount: '10.00', balance_after: '90.00' }]);
    });
    await assertWalletMatchesLedger(database.db, wallet.id);
  }, 30_000);
});

describe('falhas durante a tentativa', () => {
  test('PostgreSQL cortado (proxy): nada gravado e a tentativa não conta; com o banco de volta, conclui sem reinício', async () => {
    const proxy = await startTcpProxy(database.url);
    try {
      await withWorker({ PENDING_WORKER_LEASE_MS: '4000', WALLET_LOCK_TIMEOUT_MS: '500', DB_POOL_ACQUIRE_TIMEOUT_MS: '1000' }, async (app) => {
        const wallet = await openWallet(http, '100.00');
        const betExternal = `bet-${crypto.randomUUID()}`;
        const refund = wagerRequest('REFUND', { ...base(wallet), referenceExternalTransactionId: betExternal });
        proxy.cut();
        await submit(refund, 202); // pela app ociosa, direto no banco
        await Bun.sleep(1_200); // várias varreduras com o banco fora
        const during = await rowOf(refund.externalTransactionId);
        expect(during.status).toBe('PENDING_REFERENCE');
        expect(during.reference_attempts).toBe(0);
        const logged = app.logs.map((l) => JSON.parse(l) as Record<string, unknown>);
        expect(logged.some((l) => l.msg === 'pending_worker.poll_failed')).toBe(true);

        await submit(wagerRequest('BET', { ...base(wallet), externalTransactionId: betExternal }), 201);
        proxy.restore();
        const done = await waitStatus(refund.externalTransactionId, 'PROCESSED', 40_000);
        expect(done.reference_attempts).toBe(0);
        expect(await ledgerOf(done.id)).toHaveLength(1);
        await assertWalletMatchesLedger(database.db, wallet.id);
      }, proxy.url);
    } finally {
      proxy.close();
    }
  }, 60_000);

  test('lock da wallet segurado por fora durante a tentativa (55P03): rollback sem efeito e a tentativa não conta', async () => {
    const wallet = await openWallet(http, '100.00');
    const refund = wagerRequest('REFUND', { ...base(wallet), referenceExternalTransactionId: `bet-${crypto.randomUUID()}` });
    await submit(refund, 202);
    const holder = await database.db.connect();
    try {
      await holder.q.query('BEGIN');
      await holder.q.query('SELECT id FROM wallets WHERE id = ? FOR UPDATE', [wallet.id]);
      await withWorker({ PENDING_WORKER_LEASE_MS: '4000', WALLET_LOCK_TIMEOUT_MS: '300', DB_POOL_ACQUIRE_TIMEOUT_MS: '1000' }, async (app) => {
        await waitFor(async () => app.logs.some((l) => l.includes('pending_worker.attempt_failed')), 5_000, 20);
        const failure = app.logs.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === 'pending_worker.attempt_failed')!;
        expect(failure.errorClass).toBe('transient');
        const row = await rowOf(refund.externalTransactionId);
        expect(row.status).toBe('PENDING_REFERENCE');
        expect(row.reference_attempts).toBe(0);
      });
    } finally {
      await holder.q.query('ROLLBACK').catch(() => {});
      holder.release();
    }
    await assertWalletMatchesLedger(database.db, wallet.id);
  }, 30_000);
});

describe('erro permanente inesperado (cenário 7; FR-029; I-61)', () => {
  test('FAILPOINT=after_pending_resolution_before_commit:invariant_violation → FAILED INTERNAL_ERROR, sem lançamento nem evento', async () => {
    const wallet = await openWallet(http, '100.00');
    const betExternal = `bet-${crypto.randomUUID()}`;
    const refund = wagerRequest('REFUND', { ...base(wallet), referenceExternalTransactionId: betExternal });
    await submit(refund, 202);
    await submit(wagerRequest('BET', { ...base(wallet), externalTransactionId: betExternal }), 201); // 90
    await withWorker({ FAILPOINT: 'after_pending_resolution_before_commit:invariant_violation' }, async (app) => {
      const failed = await waitStatus(refund.externalTransactionId, 'FAILED');
      expect(failed.failure_code).toBe('INTERNAL_ERROR');
      expect(failed.next_reference_attempt_at).toBeNull();
      expect(failed.observed_balance).toBe('100.00'); // o da criação: a conclusão foi desfeita
      expect(await ledgerOf(failed.id)).toEqual([]);
      expect((await eventsOf(failed.id)).map((e) => e.event_type)).toEqual(['WagerTransactionPendingReference']);
      const logged = app.logs.map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(logged.some((l) => l.msg === 'pending_worker.failed' && l.transactionId === failed.id)).toBe(true);
      const balance = await database.db.query<{ balance: string }>('SELECT balance FROM wallets WHERE id = ?', [wallet.id]);
      expect(balance[0]!.balance).toBe('90.00');
    });
    await assertWalletMatchesLedger(database.db, wallet.id);
  }, 30_000);
});
