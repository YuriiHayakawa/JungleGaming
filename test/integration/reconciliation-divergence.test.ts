// T013 — divergência detectada, sinalizada e nunca corrigida (US1 cenários 3 e 4; FR-005 a FR-008; SC-002; R-38).
// Banco clonado do template "sem guardas" (só as migrations de tabelas; as funções e triggers da
// Migration20261107000400 nunca existiram nele): wallets e transações nascem pela API real e a divergência é provocada
// com UPDATE direto, que ali é possível. Nenhum trigger é desligado em nenhum banco. Os CHECKs das tabelas continuam
// ativos, então toda adulteração do ledger mantém a aritmética de cada lançamento (after = before ± amount).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { startApp, type RunningApp } from '../support/app-harness.ts';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { wagerRequest } from '../support/factories.ts';
import { fetcherFor, postJson, type Fetcher, type WalletBody } from '../support/http.ts';
import { useBareTestDatabase } from '../support/test-database.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useBareTestDatabase('reconciliation_divergence');
let app: RunningApp;
let http: Fetcher;

beforeAll(async () => {
  app = await startApp({ databaseUrl: database.url });
  http = fetcherFor(app.baseUrl);
});

afterAll(async () => {
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

const MONEY_FIELD = /amount|balance|difference|money|calculated|stored/i;
const MONEY_VALUE = /\d+\.\d{2}/;

test('o banco do arquivo não tem as guardas (sanidade do R-38)', async () => {
  const triggers = await database.db.query("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal");
  expect(triggers).toEqual([]);
  const guard = await database.db.query("SELECT 1 FROM pg_proc WHERE proname = 'jg_wallet_matches_ledger_tail'");
  expect(guard).toEqual([]);
});

/** Wallet de 100.00 com BETs de 10.00, 20.00 e 5.00 (saldo 65.00): lançamentos 0→100, 100→90, 90→70, 70→65. */
async function movedWallet(): Promise<{ wallet: WalletBody; seqs: number[] }> {
  const wallet = await openWallet(http, '100.00');
  for (const amount of ['10.00', '20.00', '5.00']) {
    const response = await submitWager(http, wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount, currency: 'BRL' } }));
    expect(response.status).toBe(201);
  }
  await assertWalletMatchesLedger(database.db, wallet.id); // íntegra antes da adulteração
  // Ordena pelo bigint, não pelo texto ('10' < '9' em ordem de texto).
  const rows = await database.db.query<{ seq_text: string }>(
    'SELECT seq::text AS seq_text FROM wallet_ledger_entries WHERE wallet_id = ? ORDER BY seq',
    [wallet.id],
  );
  return { wallet, seqs: rows.map((r) => Number.parseInt(r.seq_text, 10)) };
}

/** Linha inteira da wallet e do ledger, para provar que nada foi corrigido. */
async function rowsOf(walletId: string): Promise<string> {
  const [row] = await database.db.query<{ snapshot: string }>(
    `SELECT (SELECT row_to_json(w)::text FROM wallets w WHERE w.id = ?) || '#' ||
            coalesce((SELECT string_agg(row_to_json(l)::text, '|' ORDER BY l.seq) FROM wallet_ledger_entries l WHERE l.wallet_id = ?), '') AS snapshot`,
    [walletId, walletId],
  );
  return row!.snapshot;
}

function divergenceLines(correlationId: string): Array<Record<string, unknown>> {
  return app.logs
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.msg === 'reconciliation.divergence' && entry.correlationId === correlationId);
}

/** Reconcilia e confere os efeitos da divergência: 200, uma linha de log sem dinheiro, +1 no contador, nada corrigido. */
async function reconcileDivergent(walletId: string, tag: string): Promise<ReconciliationBody> {
  const before = await rowsOf(walletId);
  const counterBefore = app.metrics.counter('reconciliation_divergences_total');
  const correlationId = `divergence-${tag}-${crypto.randomUUID().slice(0, 8)}`;

  const response = await postJson<ReconciliationBody>(http, `/wallets/${walletId}/reconciliation`, '', { 'X-Correlation-Id': correlationId });

  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body.walletId).toBe(walletId);
  expect(response.body.consistent).toBe(false);
  expect(app.metrics.counter('reconciliation_divergences_total')).toBe(counterBefore + 1);

  const lines = divergenceLines(correlationId);
  expect(lines).toHaveLength(1);
  const line = lines[0]!;
  expect(line.level).toBe('error');
  expect(line.walletId).toBe(walletId);
  expect(line.checkedEntries).toBe(response.body.checkedEntries);
  expect(line.consistent).toBe(false);
  if (response.body.firstBrokenSeq !== undefined) expect(line.firstBrokenSeq).toBe(response.body.firstBrokenSeq);
  else expect('firstBrokenSeq' in line).toBe(false);
  // Nenhum campo nem valor monetário na linha (FR-008, constitution VIII).
  for (const [key, value] of Object.entries(line)) {
    expect(key).not.toMatch(MONEY_FIELD);
    if (typeof value === 'string' && key !== 'time') expect(value).not.toMatch(MONEY_VALUE);
  }

  expect(await rowsOf(walletId)).toBe(before); // nada corrigido
  return response.body;
}

describe('saldo armazenado alterado (US1 cenário 3)', () => {
  test('maior que o ledger: difference positiva, cauda quebrada', async () => {
    const { wallet, seqs } = await movedWallet();
    await database.db.query("UPDATE wallets SET balance = '72.50' WHERE id = ?", [wallet.id]);
    const body = await reconcileDivergent(wallet.id, 'stored-higher');
    expect(body).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '72.50', currency: 'BRL' },
      calculatedBalance: { amount: '65.00', currency: 'BRL' },
      difference: { amount: '7.50', currency: 'BRL' },
      consistent: false,
      chainConsistent: false,
      firstBrokenSeq: seqs[3],
      checkedEntries: 4,
    });
  });

  test('menor que o ledger: difference negativa', async () => {
    const { wallet, seqs } = await movedWallet();
    await database.db.query("UPDATE wallets SET balance = '50.00' WHERE id = ?", [wallet.id]);
    const body = await reconcileDivergent(wallet.id, 'stored-lower');
    expect(body.difference).toEqual({ amount: '-15.00', currency: 'BRL' });
    expect(body.calculatedBalance).toEqual({ amount: '65.00', currency: 'BRL' });
    expect(body.chainConsistent).toBe(false);
    expect(body.firstBrokenSeq).toBe(seqs[3]);
  });

  test('wallet sem lançamentos com saldo ≠ 0: difference = saldo, cadeia íntegra por vacuidade', async () => {
    const wallet = await openWallet(http, '0.00');
    await database.db.query("UPDATE wallets SET balance = '3.00' WHERE id = ?", [wallet.id]);
    const body = await reconcileDivergent(wallet.id, 'empty-ledger');
    expect(body).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '3.00', currency: 'BRL' },
      calculatedBalance: { amount: '0.00', currency: 'BRL' },
      difference: { amount: '3.00', currency: 'BRL' },
      consistent: false,
      chainConsistent: true,
      checkedEntries: 0,
    });
  });
});

describe('cadeia quebrada (US1 cenário 4)', () => {
  test('balance_before de um lançamento do meio alterado: firstBrokenSeq desse lançamento, soma certa', async () => {
    const { wallet, seqs } = await movedWallet();
    // 90→70 vira 95→75 (a aritmética do lançamento continua certa; o elo com o anterior, 90, quebra).
    await database.db.query("UPDATE wallet_ledger_entries SET balance_before = '95.00', balance_after = '75.00' WHERE seq = ?", [seqs[2]]);
    const body = await reconcileDivergent(wallet.id, 'middle-link');
    expect(body.difference).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(body.chainConsistent).toBe(false);
    expect(body.firstBrokenSeq).toBe(seqs[2]);
    expect(body.checkedEntries).toBe(4);
  });

  test('primeiro lançamento com balance_before ≠ 0: quebra no primeiro', async () => {
    const { wallet, seqs } = await movedWallet();
    await database.db.query("UPDATE wallet_ledger_entries SET balance_before = '1.00', balance_after = '101.00' WHERE seq = ?", [seqs[0]]);
    const body = await reconcileDivergent(wallet.id, 'first-link');
    expect(body.firstBrokenSeq).toBe(seqs[0]);
    expect(body.difference).toEqual({ amount: '0.00', currency: 'BRL' });
  });

  test('balance_after do último alterado: quebra na cauda (firstBrokenSeq = último)', async () => {
    const { wallet, seqs } = await movedWallet();
    // 70→65 vira 72→67: o elo com o anterior (70) e a cauda (saldo 65) quebram; o primeiro quebrado é o último.
    await database.db.query("UPDATE wallet_ledger_entries SET balance_before = '72.00', balance_after = '67.00' WHERE seq = ?", [seqs[3]]);
    const body = await reconcileDivergent(wallet.id, 'tail');
    expect(body.firstBrokenSeq).toBe(seqs[3]);
    expect(body.chainConsistent).toBe(false);
    expect(body.difference).toEqual({ amount: '0.00', currency: 'BRL' });
  });

  test('dois desvios que se anulam na soma: difference 0.00, consistent false', async () => {
    const { wallet, seqs } = await movedWallet();
    // +5 no 2º lançamento e −5 no 3º: a soma com sinal e o saldo armazenado não mudam; a cadeia, sim.
    await database.db.query("UPDATE wallet_ledger_entries SET balance_before = '105.00', balance_after = '95.00' WHERE seq = ?", [seqs[1]]);
    await database.db.query("UPDATE wallet_ledger_entries SET balance_before = '85.00', balance_after = '65.00' WHERE seq = ?", [seqs[2]]);
    const body = await reconcileDivergent(wallet.id, 'cancel-out');
    expect(body.storedBalance).toEqual({ amount: '65.00', currency: 'BRL' });
    expect(body.calculatedBalance).toEqual({ amount: '65.00', currency: 'BRL' });
    expect(body.difference).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(body.consistent).toBe(false);
    expect(body.chainConsistent).toBe(false);
    expect(body.firstBrokenSeq).toBe(seqs[1]);
  });
});

describe('detecções repetidas', () => {
  test('duas reconciliações da mesma wallet divergente: duas linhas de log e +2 no contador', async () => {
    const { wallet } = await movedWallet();
    await database.db.query("UPDATE wallets SET balance = '66.00' WHERE id = ?", [wallet.id]);
    const before = app.metrics.counter('reconciliation_divergences_total');
    await reconcileDivergent(wallet.id, 'repeat-1');
    await reconcileDivergent(wallet.id, 'repeat-2');
    expect(app.metrics.counter('reconciliation_divergences_total')).toBe(before + 2);
  });

  test('uma wallet íntegra no mesmo banco continua consistente e não conta divergência', async () => {
    const { wallet } = await movedWallet();
    const before = app.metrics.counter('reconciliation_divergences_total');
    const response = await postJson<ReconciliationBody>(http, `/wallets/${wallet.id}/reconciliation`, '');
    expect(response.status).toBe(200);
    expect(response.body.consistent).toBe(true);
    expect(app.metrics.counter('reconciliation_divergences_total')).toBe(before);
    await assertWalletMatchesLedger(database.db, wallet.id);
  });
});
