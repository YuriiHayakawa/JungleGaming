import type { Money } from '../../shared-kernel/domain/money.ts';

/**
 * Entrada da comparação (R-37; data-model §1): o que as duas leituras do snapshot devolvem (R-36). Todos os valores
 * monetários na moeda da wallet; `lastSeq` e `lastBalanceAfter` existem se e somente se há lançamentos.
 */
export interface ReconciliationInput {
  walletId: string;
  /** `wallets.balance` lido no snapshot. */
  storedBalance: Money;
  /** Σ CREDIT − Σ DEBIT do ledger da wallet (0.00 sem lançamentos); pode ser negativo num ledger adulterado. */
  calculatedBalance: Money;
  /** Lançamentos lidos. */
  checkedEntries: number;
  /** Menor `seq` com elo quebrado: primeiro `before` ≠ 0, ou `before[n]` ≠ `after[n−1]`. */
  firstBrokenLinkSeq?: number;
  /** `seq` do último lançamento. */
  lastSeq?: number;
  /** `balance_after` do último lançamento. */
  lastBalanceAfter?: Money;
}

/** Valor calculado sob demanda, nunca persistido (data-model §1). */
export interface ReconciliationResult {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  /** `storedBalance − calculatedBalance`, com sinal (FR-005). */
  difference: Money;
  checkedEntries: number;
  /** Cadeia íntegra (FR-006). */
  chainConsistent: boolean;
  /** Só com `chainConsistent` false: o menor `seq` com elo quebrado ou, sem elo quebrado, o último (cauda). */
  firstBrokenSeq?: number;
  /** `difference` zero **e** `chainConsistent` (FR-007). */
  consistent: boolean;
}

function assertWellFormed(input: ReconciliationInput): void {
  const { checkedEntries, lastSeq, lastBalanceAfter, firstBrokenLinkSeq } = input;
  if (!Number.isSafeInteger(checkedEntries) || checkedEntries < 0) {
    throw new Error(`reconcile: checkedEntries must be a non-negative integer, got ${checkedEntries}`);
  }
  const hasEntries = checkedEntries > 0;
  if (hasEntries !== (lastSeq !== undefined) || hasEntries !== (lastBalanceAfter !== undefined)) {
    throw new Error('reconcile: lastSeq and lastBalanceAfter must be present if and only if there are entries');
  }
  if (!hasEntries && firstBrokenLinkSeq !== undefined) {
    throw new Error('reconcile: a broken link requires ledger entries');
  }
  for (const seq of [lastSeq, firstBrokenLinkSeq]) {
    if (seq !== undefined && (!Number.isSafeInteger(seq) || seq < 1)) throw new Error(`reconcile: invalid seq ${seq}`);
  }
}

/**
 * Compara o saldo armazenado com o ledger e decide a consistência (R-37). Função pura, sem I/O: o banco só agrega
 * (R-36). Regras da cadeia, em ordem de `seq` (I-37, I-74):
 *
 *   elo quebrado em n  ⇔  (n é o primeiro e before[n] ≠ 0.00)  ou  (n não é o primeiro e before[n] ≠ after[n−1])
 *   cauda quebrada     ⇔  existe lançamento  e  after[último] ≠ storedBalance
 *   chainConsistent    ⇔  nenhum elo quebrado  e  cauda íntegra
 *
 * Sem lançamentos, a cadeia é íntegra por vacuidade; a divergência, se houver, aparece em `difference`. Moedas
 * diferentes entre os campos são erro de programação: `Money` recusa a operação (CurrencyMismatchError).
 */
export function reconcile(input: ReconciliationInput): ReconciliationResult {
  assertWellFormed(input);
  const difference = input.storedBalance.subtract(input.calculatedBalance);

  // `subtract` confere a moeda (CurrencyMismatchError); `equals` só devolveria false.
  const tailBroken = input.lastBalanceAfter !== undefined && !input.lastBalanceAfter.subtract(input.storedBalance).isZero();
  const firstBrokenSeq = input.firstBrokenLinkSeq ?? (tailBroken ? input.lastSeq : undefined);
  const chainConsistent = firstBrokenSeq === undefined;

  return {
    walletId: input.walletId,
    storedBalance: input.storedBalance,
    calculatedBalance: input.calculatedBalance,
    difference,
    checkedEntries: input.checkedEntries,
    chainConsistent,
    ...(firstBrokenSeq !== undefined ? { firstBrokenSeq } : {}),
    consistent: difference.isZero() && chainConsistent,
  };
}
