/**
 * Taxonomia de códigos (docs/interpretacoes.md §7). `retryable` diz se reenviar pode dar resultado diferente;
 * `action` é o que o provedor deve fazer. Os códigos de transação persistíveis vão em `failure_code`; os demais
 * existem só na resposta HTTP (data-model §1).
 */
export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  BalanceLimitExceeded = 'BALANCE_LIMIT_EXCEEDED',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceRejected = 'REFERENCE_REJECTED',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  AlreadyReversed = 'ALREADY_REVERSED',
  AmountMismatch = 'AMOUNT_MISMATCH',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  /** Só para FAILED (erro permanente inesperado, gravado pela feature de mensageria, I-22). */
  InternalError = 'INTERNAL_ERROR',
}

/** Códigos que existem só na resposta HTTP, nunca em `failure_code` (I-55, I-59). */
export type ResponseOnlyCode =
  | 'VALIDATION_ERROR'
  | 'OPENING_NOT_ALLOWED'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'WALLET_NOT_FOUND'
  | 'WALLET_ALREADY_EXISTS'
  | 'TRANSACTION_NOT_FOUND'
  | 'ROUTE_NOT_FOUND'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export type TaxonomyCode = `${FailureCode}` | ResponseOnlyCode;
export type FailureAction = 'GIVE_UP' | 'FIX_PAYLOAD' | 'RESEND';

export const FAILURE_TAXONOMY: Readonly<Record<TaxonomyCode, { retryable: boolean; action: FailureAction }>> = Object.freeze({
  INSUFFICIENT_FUNDS: { retryable: false, action: 'GIVE_UP' },
  REVERSAL_WOULD_OVERDRAW: { retryable: false, action: 'GIVE_UP' },
  BALANCE_LIMIT_EXCEEDED: { retryable: false, action: 'GIVE_UP' },
  REFERENCE_NOT_FOUND: { retryable: false, action: 'FIX_PAYLOAD' },
  REFERENCE_REJECTED: { retryable: false, action: 'GIVE_UP' },
  REFERENCE_MISMATCH: { retryable: false, action: 'FIX_PAYLOAD' },
  INVALID_REFERENCE_KIND: { retryable: false, action: 'FIX_PAYLOAD' },
  ALREADY_REVERSED: { retryable: false, action: 'GIVE_UP' },
  AMOUNT_MISMATCH: { retryable: false, action: 'FIX_PAYLOAD' },
  CURRENCY_MISMATCH: { retryable: false, action: 'FIX_PAYLOAD' },
  WALLET_PLAYER_MISMATCH: { retryable: false, action: 'FIX_PAYLOAD' },
  VALIDATION_ERROR: { retryable: false, action: 'FIX_PAYLOAD' },
  OPENING_NOT_ALLOWED: { retryable: false, action: 'FIX_PAYLOAD' },
  IDEMPOTENCY_KEY_REQUIRED: { retryable: false, action: 'FIX_PAYLOAD' },
  IDEMPOTENCY_CONFLICT: { retryable: false, action: 'FIX_PAYLOAD' },
  WALLET_NOT_FOUND: { retryable: false, action: 'FIX_PAYLOAD' },
  WALLET_ALREADY_EXISTS: { retryable: false, action: 'FIX_PAYLOAD' },
  TRANSACTION_NOT_FOUND: { retryable: false, action: 'FIX_PAYLOAD' },
  ROUTE_NOT_FOUND: { retryable: false, action: 'FIX_PAYLOAD' },
  SERVICE_UNAVAILABLE: { retryable: true, action: 'RESEND' },
  INTERNAL_ERROR: { retryable: true, action: 'RESEND' },
});

/** Códigos de transação REJECTED (os 11 do CHECK `wager_tx_failure_code_value_ck`, sem INTERNAL_ERROR). */
export const REJECTION_FAILURE_CODES: ReadonlySet<FailureCode> = new Set(
  Object.values(FailureCode).filter((code) => code !== FailureCode.InternalError),
);

/** Tudo o que pode ir para `failure_code`: rejeições e INTERNAL_ERROR (FAILED). */
export const PERSISTABLE_FAILURE_CODES: ReadonlySet<FailureCode> = new Set(Object.values(FailureCode));

export const RESPONSE_ONLY_CODES: ReadonlySet<ResponseOnlyCode> = new Set<ResponseOnlyCode>([
  'VALIDATION_ERROR',
  'OPENING_NOT_ALLOWED',
  'IDEMPOTENCY_KEY_REQUIRED',
  'IDEMPOTENCY_CONFLICT',
  'WALLET_NOT_FOUND',
  'WALLET_ALREADY_EXISTS',
  'TRANSACTION_NOT_FOUND',
  'ROUTE_NOT_FOUND',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
]);

export function retryableOf(code: TaxonomyCode): boolean {
  return FAILURE_TAXONOMY[code].retryable;
}

export function actionOf(code: TaxonomyCode): FailureAction {
  return FAILURE_TAXONOMY[code].action;
}

export function isRejectionCode(code: string): code is FailureCode {
  return REJECTION_FAILURE_CODES.has(code as FailureCode);
}

export function isPersistableFailureCode(code: string): code is FailureCode {
  return PERSISTABLE_FAILURE_CODES.has(code as FailureCode);
}
