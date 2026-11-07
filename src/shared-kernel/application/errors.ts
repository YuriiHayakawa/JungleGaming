// Erros de aplicação, com código da taxonomia de docs/interpretacoes.md §7. O filtro global os traduz em HTTP.

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'OPENING_NOT_ALLOWED'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'WALLET_NOT_FOUND'
  | 'WALLET_ALREADY_EXISTS'
  | 'TRANSACTION_NOT_FOUND'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export abstract class ApplicationError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly retryable: boolean;

  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ValidationError extends ApplicationError {
  readonly code = 'VALIDATION_ERROR' as const;
  readonly retryable = false;
}

export class OpeningNotAllowedError extends ApplicationError {
  readonly code = 'OPENING_NOT_ALLOWED' as const;
  readonly retryable = false;
  constructor() {
    super('kind OPENING is internal and cannot be submitted');
  }
}

export class IdempotencyKeyRequiredError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_KEY_REQUIRED' as const;
  readonly retryable = false;
  constructor() {
    super('Idempotency-Key header is required');
  }
}

export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_CONFLICT' as const;
  readonly retryable = false;
  constructor() {
    super('Idempotency key or external transaction id already used with a different payload');
  }
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND' as const;
  readonly retryable = false;
  constructor() {
    super('Wallet not found');
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS' as const;
  readonly retryable = false;
  /** I-52: o 409 traz só o id da wallet existente. */
  constructor(readonly walletId: string) {
    super('A wallet already exists for this player and currency', { walletId });
  }
}

export class TransactionNotFoundError extends ApplicationError {
  readonly code = 'TRANSACTION_NOT_FOUND' as const;
  readonly retryable = false;
  constructor() {
    super('Transaction not found');
  }
}

export class ServiceUnavailableError extends ApplicationError {
  readonly code = 'SERVICE_UNAVAILABLE' as const;
  readonly retryable = true;
  constructor(options?: { cause?: unknown }) {
    super('Service temporarily unavailable, retry later', undefined, options);
  }
}

export class InternalError extends ApplicationError {
  readonly code = 'INTERNAL_ERROR' as const;
  readonly retryable = true;
  constructor(options?: { cause?: unknown }) {
    super('Unexpected error', undefined, options);
  }
}
