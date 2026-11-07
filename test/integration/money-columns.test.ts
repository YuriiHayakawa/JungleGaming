// T069 — NUMERIC(18,2) como string em todas as colunas de dinheiro, pelos use cases reais (FR-003, I-03, I-04,
// constitution II; linha `money-columns` da matriz do plan). Sem desligar triggers.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Money } from '../../src/shared-kernel/domain/money.ts';
import { WagerTransactionRecord } from '../../src/wagering/infrastructure/wager-transaction.schema.ts';
import { LedgerEntryRecord } from '../../src/wallets/infrastructure/ledger-entry.schema.ts';
import { WalletRecord } from '../../src/wallets/infrastructure/wallet.schema.ts';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { startApp, type RunningApp } from '../support/app-harness.ts';
import { wagerRequest } from '../support/factories.ts';
import { fetcherFor, type Fetcher, type WalletBody } from '../support/http.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('money_columns');
const MAX = '9999999999999999.99';
const TEN_CENTS = '0.10';
let running: RunningApp;
let http: Fetcher;

beforeAll(async () => {
  running = await startApp({ databaseUrl: database.url });
  http = fetcherFor(running.baseUrl);
});
afterAll(async () => {
  await running?.close();
});

/** Confere o valor lido pela entidade mapeada: string, texto idêntico e reidratação exata por Money.from. */
function expectMoneyColumn(label: string, value: unknown, expected: string): void {
  expect(typeof value, `${label}: typeof`).toBe('string');
  expect(value, label).toBe(expected);
  expect(Money.from({ amount: value as string, currency: 'BRL' }).amount, `${label}: Money.from`).toBe(expected);
}

/** Confere por SQL cru com `?` que o banco guardou exatamente o valor (comparação numérica e texto). */
async function expectStored(table: string, column: string, id: string, expected: string): Promise<void> {
  const rows = await database.db.query<{ value: string }>(
    `SELECT ${column}::text AS value FROM ${table} WHERE id = ? AND ${column} = ?::numeric`,
    [id, expected],
  );
  expect(rows, `${table}.${column} = ${expected}`).toEqual([{ value: expected }]);
}

const fork = () => running.orm.em.fork();

interface Opened {
  wallet: WalletBody;
  openingId: string;
  openingEntryId: string;
  betId: string;
  betEntryId: string;
}

async function openAndBet(initial: string): Promise<Opened> {
  const wallet = await openWallet(http, initial);
  // saldo logo depois da abertura, antes da BET
  expectMoneyColumn(`wallets.balance (${initial})`, (await fork().findOneOrFail(WalletRecord, { id: wallet.id })).balance, initial);
  await expectStored('wallets', 'balance', wallet.id, initial);

  const bet = await submitWager(http, wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: TEN_CENTS, currency: 'BRL' } }));
  expect(bet.status).toBe(201);
  const [opening] = await database.db.query<{ id: string }>("SELECT id FROM wager_transactions WHERE wallet_id = ? AND kind = 'OPENING'", [wallet.id]);
  const entries = await database.db.query<{ id: string; transaction_id: string }>(
    'SELECT id, transaction_id FROM wallet_ledger_entries WHERE wallet_id = ? ORDER BY seq',
    [wallet.id],
  );
  return {
    wallet,
    openingId: opening!.id,
    openingEntryId: entries.find((e) => e.transaction_id === opening!.id)!.id,
    betId: bet.body.transactionId,
    betEntryId: entries.find((e) => e.transaction_id === bet.body.transactionId)!.id,
  };
}

describe('Wallet A: aberta com 9999999999999999.99 e depois BET 0.10', () => {
  test('cada coluna monetária recebe o máximo e 0.10 como string exata', async () => {
    const a = await openAndBet(MAX);

    const opening = await fork().findOneOrFail(WagerTransactionRecord, { id: a.openingId });
    expectMoneyColumn('wager_transactions.amount (abertura)', opening.amount, MAX);
    expectMoneyColumn('wager_transactions.observed_balance (abertura)', opening.observedBalance, MAX);
    await expectStored('wager_transactions', 'amount', a.openingId, MAX);
    await expectStored('wager_transactions', 'observed_balance', a.openingId, MAX);

    const bet = await fork().findOneOrFail(WagerTransactionRecord, { id: a.betId });
    expectMoneyColumn('wager_transactions.amount (BET)', bet.amount, TEN_CENTS);
    await expectStored('wager_transactions', 'amount', a.betId, TEN_CENTS);

    const openingEntry = await fork().findOneOrFail(LedgerEntryRecord, { id: a.openingEntryId });
    expectMoneyColumn('wallet_ledger_entries.amount (abertura)', openingEntry.amount, MAX);
    expectMoneyColumn('wallet_ledger_entries.balance_after (abertura)', openingEntry.balanceAfter, MAX);
    await expectStored('wallet_ledger_entries', 'amount', a.openingEntryId, MAX);
    await expectStored('wallet_ledger_entries', 'balance_after', a.openingEntryId, MAX);

    const betEntry = await fork().findOneOrFail(LedgerEntryRecord, { id: a.betEntryId });
    expectMoneyColumn('wallet_ledger_entries.balance_before (BET)', betEntry.balanceBefore, MAX);
    expectMoneyColumn('wallet_ledger_entries.amount (BET)', betEntry.amount, TEN_CENTS);
    expectMoneyColumn('wallet_ledger_entries.balance_after (BET)', betEntry.balanceAfter, '9999999999999999.89');
    await expectStored('wallet_ledger_entries', 'balance_before', a.betEntryId, MAX);
    await expectStored('wallet_ledger_entries', 'amount', a.betEntryId, TEN_CENTS);
    expect(typeof betEntry.seq).toBe('string');

    expectMoneyColumn('wallets.balance (A depois da BET)', (await fork().findOneOrFail(WalletRecord, { id: a.wallet.id })).balance, '9999999999999999.89');
    await assertWalletMatchesLedger(database.db, a.wallet.id);
  });
});

describe('Wallet B: aberta com 0.10 e depois BET 0.10', () => {
  test('cada coluna monetária recebe 0.10 como string exata', async () => {
    const b = await openAndBet(TEN_CENTS);

    const opening = await fork().findOneOrFail(WagerTransactionRecord, { id: b.openingId });
    expectMoneyColumn('wager_transactions.amount (abertura)', opening.amount, TEN_CENTS);
    expectMoneyColumn('wager_transactions.observed_balance (abertura)', opening.observedBalance, TEN_CENTS);
    await expectStored('wager_transactions', 'observed_balance', b.openingId, TEN_CENTS);

    const openingEntry = await fork().findOneOrFail(LedgerEntryRecord, { id: b.openingEntryId });
    expectMoneyColumn('wallet_ledger_entries.amount (abertura)', openingEntry.amount, TEN_CENTS);
    expectMoneyColumn('wallet_ledger_entries.balance_after (abertura)', openingEntry.balanceAfter, TEN_CENTS);
    await expectStored('wallet_ledger_entries', 'balance_after', b.openingEntryId, TEN_CENTS);

    const betEntry = await fork().findOneOrFail(LedgerEntryRecord, { id: b.betEntryId });
    expectMoneyColumn('wallet_ledger_entries.balance_before (BET)', betEntry.balanceBefore, TEN_CENTS);
    expectMoneyColumn('wallet_ledger_entries.amount (BET)', betEntry.amount, TEN_CENTS);
    expectMoneyColumn('wallet_ledger_entries.balance_after (BET)', betEntry.balanceAfter, '0.00');
    await expectStored('wallet_ledger_entries', 'balance_before', b.betEntryId, TEN_CENTS);

    const bet = await fork().findOneOrFail(WagerTransactionRecord, { id: b.betId });
    expectMoneyColumn('wager_transactions.observed_balance (BET)', bet.observedBalance, '0.00');
    expectMoneyColumn('wallets.balance (B depois da BET)', (await fork().findOneOrFail(WalletRecord, { id: b.wallet.id })).balance, '0.00');
    await assertWalletMatchesLedger(database.db, b.wallet.id);
  });
});
