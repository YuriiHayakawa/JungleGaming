import type { EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../../shared-kernel/domain/money.ts';
import type { ReconciliationInput } from '../domain/reconciliation.ts';

interface WalletRow {
  balance: string;
  currency: string;
}

interface LedgerAggregateRow {
  checked_entries: string;
  calculated: string;
  first_broken_link_seq: string | null;
  last_seq: string | null;
  last_balance_after: string | null;
}

interface TransactionModeRow {
  isolation: string;
  read_only: string;
}

/** Saldo do agregado: `numeric::text` com sinal ("-50.00") vira Money sem passar por number (constitution II). */
export function signedMoney(amount: string, currency: string): Money {
  const negative = amount.startsWith('-');
  const money = Money.from({ amount: negative ? amount.slice(1) : amount, currency });
  return negative ? money.negate() : money;
}

/** `bigint` chega do driver como string; só vira number depois de conferido como inteiro seguro (R-37). */
function safeInteger(raw: string, what: string): number {
  if (!/^\d+$/.test(raw)) throw new Error(`reconciliation: ${what} is not a non-negative integer: ${raw}`);
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value)) throw new Error(`reconciliation: ${what} exceeds the safe integer range: ${raw}`);
  return value;
}

/**
 * As duas leituras da reconciliação (R-36; data-model §2.1), feitas com o EM da transação `REPEATABLE READ`
 * `READ ONLY` aberta pelo use case, no mesmo snapshot. Nenhuma escrita e nenhum lock (`FOR UPDATE`/`FOR SHARE`): a
 * reconciliação não espera nem bloqueia escritas (FR-010). Soma e cadeia são calculadas pelo banco, com
 * `lag(balance_after)`; a aplicação recebe uma linha só, qualquer que seja o tamanho do ledger (FR-009).
 */
export class MikroOrmReconciliationReader {
  /** Modo da transação corrente, para o use case conferir que o snapshot é de fato `REPEATABLE READ` e `READ ONLY`. */
  async transactionMode(em: EntityManager): Promise<{ isolation: string; readOnly: boolean }> {
    const [row] = await em.execute<TransactionModeRow[]>(
      "SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only",
    );
    if (!row) throw new Error('reconciliation: could not read the transaction mode');
    return { isolation: row.isolation, readOnly: row.read_only === 'on' };
  }

  /** Saldo e moeda da wallet, sem `FOR UPDATE`; `undefined` se não existe. */
  async readWallet(em: EntityManager, walletId: string): Promise<{ balance: string; currency: string } | undefined> {
    const [row] = await em.execute<WalletRow[]>('SELECT balance::text AS balance, currency FROM wallets WHERE id = ?', [walletId]);
    return row ? { balance: row.balance, currency: row.currency } : undefined;
  }

  /** Agregado do ledger da wallet: quantidade, soma com sinal, primeiro elo quebrado e o último lançamento. */
  async readLedgerAggregate(em: EntityManager, walletId: string): Promise<LedgerAggregateRow> {
    const [row] = await em.execute<LedgerAggregateRow[]>(
      `WITH chain AS (
         SELECT seq, direction, amount, balance_before, balance_after,
                lag(balance_after) OVER (ORDER BY seq) AS previous_after,
                row_number()       OVER (ORDER BY seq DESC) AS from_end
           FROM wallet_ledger_entries
          WHERE wallet_id = ?
       )
       SELECT count(*)::text AS checked_entries,
              coalesce(sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::text AS calculated,
              (min(seq) FILTER (WHERE (previous_after IS NULL AND balance_before <> 0)
                                   OR (previous_after IS NOT NULL AND balance_before <> previous_after)))::text AS first_broken_link_seq,
              max(seq)::text AS last_seq,
              max(balance_after::text) FILTER (WHERE from_end = 1) AS last_balance_after
         FROM chain`,
      [walletId],
    );
    if (!row) throw new Error('reconciliation: ledger aggregate returned no row');
    return row;
  }

  /** Converte as duas leituras na entrada da função pura `reconcile` (valores como Money, seq como inteiro seguro). */
  toInput(walletId: string, wallet: { balance: string; currency: string }, ledger: LedgerAggregateRow): ReconciliationInput {
    const { currency } = wallet;
    const checkedEntries = safeInteger(ledger.checked_entries, 'checked_entries');
    return {
      walletId,
      storedBalance: signedMoney(wallet.balance, currency),
      calculatedBalance: signedMoney(ledger.calculated, currency),
      checkedEntries,
      ...(ledger.first_broken_link_seq !== null ? { firstBrokenLinkSeq: safeInteger(ledger.first_broken_link_seq, 'seq') } : {}),
      ...(ledger.last_seq !== null ? { lastSeq: safeInteger(ledger.last_seq, 'seq') } : {}),
      ...(ledger.last_balance_after !== null ? { lastBalanceAfter: signedMoney(ledger.last_balance_after, currency) } : {}),
    };
  }
}
