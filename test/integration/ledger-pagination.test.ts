// T113 — ledger paginado com cursor opaco e estável (US8 cenários 1, 2 e 4; FR-050, FR-051, SC-010, I-36, I-47).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { startApp, type RunningApp } from '../support/app-harness.ts';
import { wagerRequest } from '../support/factories.ts';
import { fetcherFor, type ErrorBody, type Fetcher, type WalletBody } from '../support/http.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('ledger_pagination');
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

interface LedgerEntryBody {
  id: string;
  transactionId: string;
  direction: 'DEBIT' | 'CREDIT';
  money: { amount: string; currency: string };
  balanceBefore: { amount: string; currency: string };
  balanceAfter: { amount: string; currency: string };
  createdAt: string;
}
interface LedgerPageBody {
  items: LedgerEntryBody[];
  nextCursor: string | null;
}

async function page(walletId: string, query = ''): Promise<{ status: number; body: LedgerPageBody & ErrorBody }> {
  const response = await http(`/wallets/${walletId}/ledger${query}`);
  return { status: response.status, body: (await response.json()) as LedgerPageBody & ErrorBody };
}

/** Percorre o ledger inteiro seguindo nextCursor; devolve as páginas na ordem. */
async function walk(walletId: string, limit: number, between?: () => Promise<void>): Promise<LedgerEntryBody[][]> {
  const pages: LedgerEntryBody[][] = [];
  let cursor: string | null = null;
  do {
    const query: string = `?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const response = await page(walletId, query);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    pages.push(response.body.items);
    cursor = response.body.nextCursor;
    if (between) await between();
  } while (cursor !== null);
  return pages;
}

/** Ids dos lançamentos da wallet em ordem de seq, direto no banco. */
const ledgerIdsInOrder = async (walletId: string) =>
  (await database.db.query<{ id: string }>('SELECT id FROM wallet_ledger_entries WHERE wallet_id = ? ORDER BY seq', [walletId])).map((r) => r.id);

async function bets(wallet: WalletBody, count: number, parallel: number): Promise<void> {
  for (let start = 0; start < count; start += parallel) {
    const batch = Array.from({ length: Math.min(parallel, count - start) }, () =>
      submitWager(http, wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '1.00', currency: 'BRL' } })),
    );
    for (const response of await Promise.all(batch)) expect(response.status).toBe(201);
  }
}

describe('120 lançamentos com limit 50 (cenário 1)', () => {
  test('páginas de 50, 50 e 20, em ordem crescente, cada lançamento uma vez, nextCursor null no fim', async () => {
    const wallet = await openWallet(http, '1000.00'); // abertura = 1 lançamento
    await bets(wallet, 119, 10);

    const pages = await walk(wallet.id, 50);
    expect(pages.map((p) => p.length)).toEqual([50, 50, 20]);
    const items = pages.flat();
    expect(new Set(items.map((i) => i.id)).size).toBe(120);
    expect(items.map((i) => i.id)).toEqual(await ledgerIdsInOrder(wallet.id));

    // ordem crescente de registro: a cadeia de saldos encadeia página a página
    expect(items[0]).toMatchObject({ direction: 'CREDIT', balanceBefore: { amount: '0.00' }, balanceAfter: { amount: '1000.00' } });
    for (let i = 1; i < items.length; i++) expect(items[i]!.balanceBefore).toEqual(items[i - 1]!.balanceAfter);
    expect(items.at(-1)!.balanceAfter).toEqual({ amount: '881.00', currency: 'BRL' });

    // formato do LedgerEntry (contrato): dinheiro sempre string com 2 casas
    expect(items[1]).toEqual({
      id: expect.any(String),
      transactionId: expect.any(String),
      direction: 'DEBIT',
      money: { amount: '1.00', currency: 'BRL' },
      balanceBefore: { amount: '1000.00', currency: 'BRL' },
      balanceAfter: { amount: '999.00', currency: 'BRL' },
      createdAt: expect.stringMatching(ISO_8601),
    });
    await assertWalletMatchesLedger(database.db, wallet.id);
  }, 60_000);

  test('sem limit → 50 por página (padrão); o cursor é opaco (não é o seq em texto)', async () => {
    const wallet = await openWallet(http, '100.00');
    await bets(wallet, 59, 10);
    const first = await page(wallet.id);
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(50);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    expect(first.body.nextCursor).not.toMatch(/^\d+$/);
    const second = await page(wallet.id, `?cursor=${encodeURIComponent(first.body.nextCursor!)}`);
    expect(second.body.items).toHaveLength(10);
    expect(second.body.nextCursor).toBeNull();
    await assertWalletMatchesLedger(database.db, wallet.id);
  }, 60_000);

  test('wallet sem lançamentos (saldo 0.00) → página vazia e nextCursor null', async () => {
    const wallet = await openWallet(http, '0.00');
    const response = await page(wallet.id);
    expect(response.status).toBe(200);
    expect(response.body.items).toEqual([]);
    expect(response.body.nextCursor).toBeNull();
  });
});

describe('paginação com escrita concorrente (cenário 2, SC-010)', () => {
  test('nenhum lançamento já visto se repete nem é pulado enquanto BETs são criadas em paralelo', async () => {
    const wallet = await openWallet(http, '1000.00');
    await bets(wallet, 20, 10);
    const countAtStart = (await ledgerIdsInOrder(wallet.id)).length;

    // escritas em paralelo durante a paginação, com páginas pequenas e uma pausa entre elas
    let writing = true;
    const writer = bets(wallet, 60, 3).finally(() => {
      writing = false;
    });
    const pages = await walk(wallet.id, 4, () => (writing ? Bun.sleep(15) : Promise.resolve()));
    await writer;

    const seen = pages.flat().map((i) => i.id);
    const final = await ledgerIdsInOrder(wallet.id);
    expect(final).toHaveLength(countAtStart + 60);
    // sem repetição, sem buraco: o que foi visto é exatamente um prefixo da ordem final
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(final.slice(0, seen.length));
    // a paginação de fato atravessou escritas: viu lançamentos criados depois que começou
    expect(seen.length).toBeGreaterThan(countAtStart);
    console.log(`ledger-pagination: ${seen.length} vistos durante a escrita (início ${countAtStart}, final ${final.length})`);

    // depois das escritas, uma paginação nova devolve tudo, em ordem, uma vez
    const full = (await walk(wallet.id, 50)).flat().map((i) => i.id);
    expect(full).toEqual(final);
    await assertWalletMatchesLedger(database.db, wallet.id);
  }, 60_000);
});

describe('parâmetros inválidos (cenário 4, I-47) e wallet inexistente', () => {
  test('cursor adulterado, limit 0, 201 ou "abc" → 400 VALIDATION_ERROR', async () => {
    const wallet = await openWallet(http, '10.00');
    const first = await page(wallet.id, '?limit=1');
    const valid = first.body.nextCursor ?? 'MQ';
    const tampered = [`${valid}x`, 'MTI=', Buffer.from('abc').toString('base64url'), Buffer.from('99999999999999999999').toString('base64url'), '%20'];
    for (const cursor of tampered) {
      const response = await page(wallet.id, `?cursor=${encodeURIComponent(cursor)}`);
      expect(response.status, cursor).toBe(400);
      expect(response.body.error).toMatchObject({ code: 'VALIDATION_ERROR', retryable: false });
    }
    for (const limit of ['0', '201', 'abc', '-1', '1.5']) {
      const response = await page(wallet.id, `?limit=${limit}`);
      expect(response.status, limit).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
    const repeated = await page(wallet.id, '?limit=10&limit=20');
    expect(repeated.status).toBe(400);
    await assertWalletMatchesLedger(database.db, wallet.id);
  });

  test('wallet inexistente → 404 WALLET_NOT_FOUND; walletId malformado → 400', async () => {
    const missing = await page('0192f291-27dd-7d3f-8071-000000000404');
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatchObject({ code: 'WALLET_NOT_FOUND', retryable: false });
    const malformed = await page('nope');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('VALIDATION_ERROR');
  });
});
