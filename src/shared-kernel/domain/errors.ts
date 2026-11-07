// Erros de domínio. O domínio não conhece HTTP: a tradução para status acontece na camada de interface.

export abstract class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Valor monetário fora do formato do I-01, acima do limite do I-03 ou moeda fora de ^[A-Z]{3}$ (I-05). */
export class InvalidMoneyError extends DomainError {}

/** Operação entre moedas diferentes (FR-004). */
export class CurrencyMismatchError extends DomainError {}

/** Tentativa de transição a partir de estado terminal ou fora do I-11: erro de programação, não de negócio. */
export class InvalidTransactionStateError extends DomainError {}

/** Débito que deixaria o saldo negativo (FR-039). */
export class InsufficientBalanceError extends DomainError {}

/** Crédito que deixaria o saldo acima de 9999999999999999.99 (I-54). */
export class BalanceLimitExceededError extends DomainError {}

/** Lançamento cuja aritmética ou cujos valores não fecham (FR-029). */
export class InvalidLedgerEntryError extends DomainError {}
