import { LedgerDirection } from '../../wallets/domain/ledger-direction.ts';
import type { Wallet } from '../../wallets/domain/wallet.ts';
import { FailureCode } from './failure-code.ts';
import { WagerTransactionKind, WagerTransactionStatus, type WagerTransaction } from './wager-transaction.ts';

/** Resultado da avaliação: aplicar (com direção, ou sem lançamento), rejeitar com código, ou aguardar a referência. */
export type WagerDecision =
  | { readonly type: 'APPLY'; readonly direction?: LedgerDirection }
  | { readonly type: 'REJECT'; readonly code: FailureCode }
  | { readonly type: 'PENDING_REFERENCE' };

export interface DecideInput {
  /** A wallet já travada pelo use case (FOR UPDATE). */
  wallet: Wallet;
  /** A transação nova, ainda PENDING. */
  transaction: WagerTransaction;
  /** A referência resolvida por (providerId, referenceExternalTransactionId), em qualquer estado, ou ausente. */
  reference: WagerTransaction | undefined;
  /** Se já existe reversão PROCESSED da referência (só consultado para REFUND/ROLLBACK de referência PROCESSED). */
  referenceAlreadyReversed: boolean;
}

const reject = (code: FailureCode): WagerDecision => ({ type: 'REJECT', code });

/** Tipos que cada kind pode referenciar (I-13, I-14, I-46). */
const ALLOWED_REFERENCE_KINDS: Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
};

/**
 * A referência pertence ao mesmo provider, jogador, wallet, moeda e rodada (I-14). O provider já é igual por
 * construção (a busca é por providerId), mas é conferido de novo para a regra não depender de quem a chama.
 */
function sameScope(transaction: WagerTransaction, reference: WagerTransaction): boolean {
  return (
    reference.providerId === transaction.providerId &&
    reference.playerId === transaction.playerId &&
    reference.walletId === transaction.walletId &&
    reference.money.currency === transaction.money.currency &&
    reference.roundId === transaction.roundId
  );
}

/**
 * Regras de negócio da submissão, puras e sem I/O (research R-10). Avalia o passo 5 do I-44 / FR-015 nesta ordem,
 * e a primeira regra violada define o resultado:
 *   5.1 WALLET_PLAYER_MISMATCH, CURRENCY_MISMATCH
 *   5.2 referência existente (qualquer estado): REFERENCE_MISMATCH, INVALID_REFERENCE_KIND, AMOUNT_MISMATCH
 *   5.3 estado da referência: REJECTED/FAILED → REFERENCE_REJECTED; ausente/PENDING/PENDING_REFERENCE → pendente
 *   5.4 ALREADY_REVERSED
 *   5.5 saldo: INSUFFICIENT_FUNDS (BET) ou REVERSAL_WOULD_OVERDRAW (reversão que debita); BALANCE_LIMIT_EXCEEDED (crédito)
 * Ativos: 5.1 e 5.5 (US2), 5.2 (US4 e US5), 5.3 para REJECTED/FAILED e 5.4 (US5). A referência ausente ou pendente
 * (passo 5.3 → PENDING_REFERENCE) entra na US6 (T100).
 */
export class WagerRulesService {
  decide(input: DecideInput): WagerDecision {
    const { wallet, transaction } = input;

    // 5.1 dono e moeda da wallet (I-19)
    if (transaction.playerId !== wallet.playerId) return reject(FailureCode.WalletPlayerMismatch);
    if (transaction.money.currency !== wallet.currency) return reject(FailureCode.CurrencyMismatch);

    // 5.2 a 5.4: regras da referência
    const byReference = this.referenceRules(input);
    if (byReference) return byReference;

    // 5.5 saldo (I-18, I-54). Sem efeito no saldo (LOSS) → aplica sem lançamento.
    return this.balanceRules(input);
  }

  /**
   * Passos 5.2 a 5.4 do I-44. Ativos: 5.2 (US4, T089; reversões em T094), 5.3 para REJECTED/FAILED e 5.4 (US5,
   * T094). A referência ausente ou pendente entra em T100 (US6).
   */
  private referenceRules({ transaction, reference, referenceAlreadyReversed }: DecideInput): WagerDecision | undefined {
    if (transaction.referenceExternalTransactionId === undefined || !reference) return undefined;

    // 5.2 consistência da referência existente, em qualquer estado (I-14, I-17, I-46)
    if (!sameScope(transaction, reference)) return reject(FailureCode.ReferenceMismatch);
    const allowed = ALLOWED_REFERENCE_KINDS[transaction.kind];
    if (allowed && !allowed.includes(reference.kind)) return reject(FailureCode.InvalidReferenceKind);
    if (transaction.requiresReference() && !reference.money.equals(transaction.money)) {
      return reject(FailureCode.AmountMismatch);
    }

    // 5.3 estado da referência (I-15): rejeitada ou falha → REFERENCE_REJECTED
    if (reference.status === WagerTransactionStatus.Rejected || reference.status === WagerTransactionStatus.Failed) {
      return reject(FailureCode.ReferenceRejected);
    }

    // 5.4 uma reversão por transação, REFUND e ROLLBACK juntos (I-16); WIN e LOSS não têm unicidade (I-46)
    if (transaction.requiresReference() && referenceAlreadyReversed) return reject(FailureCode.AlreadyReversed);
    return undefined;
  }

  private balanceRules({ wallet, transaction, reference }: DecideInput): WagerDecision {
    if (!transaction.affectsBalance()) return { type: 'APPLY' };
    const direction = transaction.ledgerDirectionFor(reference);
    if (direction === LedgerDirection.Debit) {
      if (wallet.balance.subtract(transaction.money).isNegative()) {
        return reject(
          transaction.kind === WagerTransactionKind.Bet
            ? FailureCode.InsufficientFunds
            : FailureCode.ReversalWouldOverdraw,
        );
      }
    } else if (wallet.balance.add(transaction.money).exceedsMaximum()) {
      return reject(FailureCode.BalanceLimitExceeded);
    }
    return { type: 'APPLY', direction };
  }
}
