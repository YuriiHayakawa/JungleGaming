import { LedgerDirection } from '../../wallets/domain/ledger-direction.ts';
import type { Wallet } from '../../wallets/domain/wallet.ts';
import { FailureCode } from './failure-code.ts';
import { WagerTransactionKind, type WagerTransaction } from './wager-transaction.ts';

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

/**
 * Regras de negócio da submissão, puras e sem I/O (research R-10). Avalia o passo 5 do I-44 / FR-015 nesta ordem,
 * e a primeira regra violada define o resultado:
 *   5.1 WALLET_PLAYER_MISMATCH, CURRENCY_MISMATCH
 *   5.2 referência existente (qualquer estado): REFERENCE_MISMATCH, INVALID_REFERENCE_KIND, AMOUNT_MISMATCH
 *   5.3 estado da referência: REJECTED/FAILED → REFERENCE_REJECTED; ausente/PENDING/PENDING_REFERENCE → pendente
 *   5.4 ALREADY_REVERSED
 *   5.5 saldo: INSUFFICIENT_FUNDS (BET) ou REVERSAL_WOULD_OVERDRAW (reversão que debita); BALANCE_LIMIT_EXCEEDED (crédito)
 * Ativos nesta entrega (US2): 5.1 e 5.5. Os passos 5.2 a 5.4 entram em `referenceRules` nas US4 (T089),
 * US5 (T094) e US6 (T100); até lá, a referência não é avaliada aqui.
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

  /** Passos 5.2 a 5.4 do I-44, ativados nas US4, US5 e US6 (T089, T094, T100). */
  private referenceRules(_input: DecideInput): WagerDecision | undefined {
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
