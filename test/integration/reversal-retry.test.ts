// T096 — 23505 do índice de reversão única (R-12, FR-025, I-16).
// (1) O use case repete uma vez, do zero: o 23505 vem do failpoint
//     `after_reversal_insert_before_commit:reversal_unique_violation_once`, lançado só quando uma reversão é aplicada,
//     depois das escritas e antes do commit. Sob o lock da wallet a corrida real não acontece (a 2ª reversão vê a 1ª
//     e responde ALREADY_REVERSED), então o failpoint é o jeito determinístico de exercitar o caminho.
// (2) Uma 2ª violação seguida vira 500 INTERNAL_ERROR, sem efeito (modo `reversal_unique_violation_always`).
// (3) O 23505 real do índice, provocado por SQL no banco do arquivo, chega com `constraint` preenchido, por `pg` e pelo
//     MikroORM, e é classificado como `reversal-race`, o mesmo formato que o failpoint imita.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { EnvFailpoints, FAILPOINTS } from '../../src/platform/failpoints/failpoints.ts';
import { classifyDbError } from '../../src/platform/persistence/pg-errors.ts';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { startApp, type RunningApp } from '../support/app-harness.ts';
import { wagerRequest, type WagerRequest } from '../support/factories.ts';
import { fetcherFor, type ErrorBody, type Fetcher, type TransactionResultBody, type WalletBody } from '../support/http.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('reversal_retry');
let once: RunningApp;
let always: RunningApp;

beforeAll(async () => {
  once = await startApp({ databaseUrl: database.url, env: { FAILPOINT: 'after_reversal_insert_before_commit:reversal_unique_violation_once' } });
  always = await startApp({
    databaseUrl: database.url,
    env: { FAILPOINT: 'after_reversal_insert_before_commit:reversal_unique_violation_always' },
  });
});
afterAll(async () => {
  await once?.close();
  await always?.close();
});

async function walletWithBet(http: Fetcher): Promise<{ wallet: WalletBody; bet: WagerRequest; betId: string }> {
  const wallet = await openWallet(http, '100.00');
  const bet = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '25.00', currency: 'BRL' } });
  const response = await submitWager<TransactionResultBody>(http, bet);
  expect(response.status).toBe(201);
  return { wallet, bet, betId: response.body.transactionId };
}

const refundOf = (wallet: WalletBody, bet: WagerRequest) =>
  wagerRequest('REFUND', {
    walletId: wallet.id,
    playerId: wallet.playerId,
    money: { amount: '25.00', currency: 'BRL' },
    referenceExternalTransactionId: bet.externalTransactionId,
  });

describe('repetição do use case', () => {
  test('23505 só na 1ª passagem → 201, 1 reversão, 1 lançamento, eventos uma vez', async () => {
    const http = fetcherFor(once.baseUrl);
    const failpoints = once.app.get<EnvFailpoints>(FAILPOINTS);
    const { wallet, bet, betId } = await walletWithBet(http);
    // a BET não é reversão: não atravessa o failpoint
    expect(failpoints.passes('after_reversal_insert_before_commit')).toBe(0);

    const refund = refundOf(wallet, bet);
    const response = await submitWager<TransactionResultBody>(http, refund, { 'X-Correlation-Id': 'corr-reversal-retry' });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body).toMatchObject({ status: 'PROCESSED', idempotentReplay: false, balance: { amount: '100.00', currency: 'BRL' } });

    // a repetição aconteceu: disparou uma vez e foi atravessado duas
    expect(failpoints.triggered('after_reversal_insert_before_commit')).toBe(1);
    expect(failpoints.passes('after_reversal_insert_before_commit')).toBe(2);

    const reversals = await database.db.query<{ id: string; status: string; reference_transaction_id: string }>(
      "SELECT id, status, reference_transaction_id FROM wager_transactions WHERE wallet_id = ? AND kind IN ('REFUND','ROLLBACK')",
      [wallet.id],
    );
    expect(reversals).toEqual([{ id: response.body.transactionId, status: 'PROCESSED', reference_transaction_id: betId }]);
    const entries = await database.db.query<{ direction: string; amount: string }>(
      'SELECT direction, amount FROM wallet_ledger_entries WHERE transaction_id = ?',
      [response.body.transactionId],
    );
    expect(entries).toEqual([{ direction: 'CREDIT', amount: '25.00' }]);
    const events = await database.db.query<{ event_type: string }>(
      "SELECT event_type FROM outbox_messages WHERE correlation_id = 'corr-reversal-retry' ORDER BY id",
    );
    expect(events.map((e) => e.event_type)).toEqual(['WalletBalanceChanged', 'WagerTransactionProcessed']);
    const [row] = await database.db.query<{ balance: string; version: number }>('SELECT balance, version FROM wallets WHERE id = ?', [wallet.id]);
    expect(row).toEqual({ balance: '100.00', version: 3 });
    await assertWalletMatchesLedger(database.db, wallet.id);
  });

  test('23505 de novo na repetição → 500 INTERNAL_ERROR (retryable), sem nenhum efeito', async () => {
    const http = fetcherFor(always.baseUrl);
    const failpoints = always.app.get<EnvFailpoints>(FAILPOINTS);
    const { wallet, bet } = await walletWithBet(http);
    const before = (await database.db.query('SELECT balance, version FROM wallets WHERE id = ?', [wallet.id]))[0];

    const refund = refundOf(wallet, bet);
    const response = await submitWager<ErrorBody>(http, refund, { 'X-Correlation-Id': 'corr-reversal-exhausted' });
    expect(response.status).toBe(500);
    expect(response.body.error).toMatchObject({ code: 'INTERNAL_ERROR', retryable: true });
    expect(failpoints.triggered('after_reversal_insert_before_commit')).toBe(2);

    expect(
      await database.db.query('SELECT id FROM wager_transactions WHERE external_transaction_id = ?', [refund.externalTransactionId]),
    ).toEqual([]);
    expect(await database.db.query("SELECT id FROM outbox_messages WHERE correlation_id = 'corr-reversal-exhausted'")).toEqual([]);
    expect((await database.db.query('SELECT balance, version FROM wallets WHERE id = ?', [wallet.id]))[0]).toEqual(before);
    await assertWalletMatchesLedger(database.db, wallet.id);
  });
});

describe('23505 real do índice wager_tx_single_reversal_uq', () => {
  /** Uma 2ª reversão PROCESSED da mesma BET, montada por SQL respeitando as demais constraints. */
  const SECOND_REVERSAL = `
    INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
      player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id,
      status, observed_balance, observed_balance_currency, correlation_id, created_at, processed_at, updated_at)
    VALUES (?, 'provider-a', ?, ?, ?, ?, ?, 'round-1', 'game-1', 'ROLLBACK', '25.00', 'BRL', ?, ?, 'PROCESSED', '100.00',
      'BRL', 'corr-sql', now(), now(), now())`;

  async function refundedBet() {
    const http = fetcherFor(once.baseUrl);
    const { wallet, bet, betId } = await walletWithBet(http);
    // `once` já consumiu o disparo no teste anterior; aqui o REFUND passa direto
    const response = await submitWager<TransactionResultBody>(http, refundOf(wallet, bet));
    expect(response.status).toBe(201);
    const ext = `rollback-sql-${crypto.randomUUID()}`;
    const params = [Bun.randomUUIDv7(), ext, `provider-a:${ext}`, 'b'.repeat(64), wallet.id, wallet.playerId, bet.externalTransactionId, betId];
    return { wallet, params };
  }

  test('por pg: SQLSTATE 23505 com constraint preenchida → reversal-race', async () => {
    const { wallet, params } = await refundedBet();
    let thrown: unknown;
    await expect(
      database.db.query(SECOND_REVERSAL, params).catch((error: unknown) => {
        thrown = error;
        throw error;
      }),
    ).rejects.toThrow();
    expect(thrown).toMatchObject({ code: '23505', constraint: 'wager_tx_single_reversal_uq' });
    expect(classifyDbError(thrown)).toBe('reversal-race');
    await assertWalletMatchesLedger(database.db, wallet.id);
  });

  test('pelo MikroORM (em.execute): a exceção carrega code e constraint → reversal-race', async () => {
    const { wallet, params } = await refundedBet();
    let thrown: unknown;
    try {
      await once.orm.em.fork().execute(SECOND_REVERSAL, params);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    expect(classifyDbError(thrown)).toBe('reversal-race');
    await assertWalletMatchesLedger(database.db, wallet.id);
  });
});
