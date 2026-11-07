// Invariante final de todo teste que toca wallet (SC-006, FR-042, constitution VII).
// Lê por SQL cru e compara com Money: nenhum valor monetário vira number.
import { expect } from 'bun:test';
import { Money } from '../../src/shared-kernel/domain/money.ts';
import type { Queryable } from './db.ts';

interface WalletRow extends Record<string, unknown> {
  id: string;
  currency: string;
  balance: string;
}
interface LedgerRow extends Record<string, unknown> {
  seq: string;
  direction: 'DEBIT' | 'CREDIT';
  amount: string;
  balance_before: string;
  balance_after: string;
  status: string | null;
}

export async function assertWalletMatchesLedger(db: Queryable, walletId: string): Promise<void> {
  const [wallet] = await db.query<WalletRow>('SELECT id, currency, balance FROM wallets WHERE id = ?', [walletId]);
  expect(wallet, `wallet ${walletId} must exist`).toBeDefined();
  if (!wallet) return;
  expect(typeof wallet.balance).toBe('string');

  const entries = await db.query<LedgerRow>(
    `SELECT l.seq, l.direction, l.amount, l.balance_before, l.balance_after, t.status
       FROM wallet_ledger_entries l
       LEFT JOIN wager_transactions t ON t.id = l.transaction_id
      WHERE l.wallet_id = ?
      ORDER BY l.seq`,
    [walletId],
  );

  const money = (amount: string) => Money.from({ amount, currency: wallet.currency });
  const stored = money(wallet.balance);
  let reconstructed = Money.zero(wallet.currency);
  let previousAfter = Money.zero(wallet.currency);

  for (const entry of entries) {
    for (const value of [entry.amount, entry.balance_before, entry.balance_after]) expect(typeof value).toBe('string');
    expect(entry.status, `ledger entry ${entry.seq} must belong to a PROCESSED transaction`).toBe('PROCESSED');
    expect(money(entry.balance_before).equals(previousAfter), `ledger chain broken at seq ${entry.seq}`).toBe(true);
    const amount = money(entry.amount);
    reconstructed = entry.direction === 'CREDIT' ? reconstructed.add(amount) : reconstructed.subtract(amount);
    expect(money(entry.balance_after).equals(reconstructed), `balance_after mismatch at seq ${entry.seq}`).toBe(true);
    previousAfter = money(entry.balance_after);
  }

  expect(stored.equals(reconstructed), `wallet ${walletId}: stored ${stored} != ledger ${reconstructed}`).toBe(true);
  if (entries.length > 0) expect(stored.equals(previousAfter)).toBe(true);
  expect(stored.isNegative()).toBe(false);
}

export async function assertAllWalletsMatchLedger(db: Queryable): Promise<number> {
  const wallets = await db.query<{ id: string }>('SELECT id FROM wallets ORDER BY id');
  for (const { id } of wallets) await assertWalletMatchesLedger(db, id);
  return wallets.length;
}
