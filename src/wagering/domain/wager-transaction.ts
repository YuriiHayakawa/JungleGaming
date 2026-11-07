import { DomainError, InvalidTransactionStateError } from '../../shared-kernel/domain/errors.ts';
import type { Money } from '../../shared-kernel/domain/money.ts';
import { LedgerDirection } from '../../wallets/domain/ledger-direction.ts';
import { FailureCode, isRejectionCode } from './failure-code.ts';

export enum WagerTransactionKind {
  /** Interno: crédito de abertura da wallet (I-07). Nunca vem de provedor. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  /** Aceita, ainda não aplicada. */
  Pending = 'PENDING',
  /** Aguardando a transação referenciada. */
  PendingReference = 'PENDING_REFERENCE',
  /** Aplicada (terminal). */
  Processed = 'PROCESSED',
  /** Violação de regra de negócio (terminal). */
  Rejected = 'REJECTED',
  /** Erro permanente de infraestrutura (terminal, auditável). */
  Failed = 'FAILED',
}

/** Identidade reservada da abertura (I-07). */
export const SYSTEM_PROVIDER_ID = 'system';
const OPENING_ROUND_ID = 'opening';
const OPENING_GAME_ID = 'system';

/** Dados de criação que violam as regras estruturais do I-02, I-07, I-08 ou I-13. */
export class InvalidWagerTransactionError extends DomainError {}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** id no provedor, não o id interno. */
  referenceExternalTransactionId?: string;
  correlationId: string;
  createdAt: Date;
}

export interface CreateOpeningProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  payloadHash: string;
  correlationId: string;
  createdAt: Date;
}

export interface WagerTransactionState extends Omit<CreateWagerTransactionProps, 'referenceExternalTransactionId'> {
  referenceExternalTransactionId: string | undefined;
  referenceTransactionId: string | undefined;
  status: WagerTransactionStatus;
  failureCode: FailureCode | undefined;
  observedBalance: Money | undefined;
  referenceAttempts: number;
  nextReferenceAttemptAt: Date | undefined;
  processedAt: Date | undefined;
  updatedAt: Date;
}

const TERMINAL = new Set([WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected, WagerTransactionStatus.Failed]);

/**
 * Transação de aposta (enunciado §6.3). Transições (I-11, FR-028):
 *   PENDING → PROCESSED | REJECTED | PENDING_REFERENCE | FAILED
 *   PENDING_REFERENCE → PROCESSED | REJECTED | FAILED
 * PROCESSED, REJECTED e FAILED são terminais: qualquer transição a partir deles lança InvalidTransactionStateError
 * (erro de programação, não caminho de negócio). As novas tentativas de uma PENDING_REFERENCE (só attempts e
 * nextAttemptAt) são do worker da feature 2.
 */
export class WagerTransaction {
  private constructor(
    readonly id: string,
    readonly providerId: string,
    readonly externalTransactionId: string,
    readonly idempotencyKey: string,
    readonly payloadHash: string,
    readonly walletId: string,
    readonly playerId: string,
    readonly roundId: string,
    readonly gameId: string,
    readonly kind: WagerTransactionKind,
    readonly money: Money,
    readonly referenceExternalTransactionId: string | undefined,
    readonly correlationId: string,
    readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _observedBalance: Money | undefined,
    private _referenceAttempts: number,
    private _nextReferenceAttemptAt: Date | undefined,
    private _processedAt: Date | undefined,
    private _updatedAt: Date,
  ) {}

  /** Nasce em PENDING. Valida a referência por kind (I-13), o valor zero só em LOSS (I-02) e recusa OPENING (I-08). */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError('kind OPENING is internal and cannot be submitted');
    }
    if (props.providerId === SYSTEM_PROVIDER_ID) {
      throw new InvalidWagerTransactionError('providerId "system" is reserved');
    }
    const hasReference = props.referenceExternalTransactionId !== undefined;
    if (props.kind === WagerTransactionKind.Bet && hasReference) {
      throw new InvalidWagerTransactionError('BET does not accept a reference');
    }
    if ((props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback) && !hasReference) {
      throw new InvalidWagerTransactionError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (!props.money.isPositive() && !(props.kind === WagerTransactionKind.Loss && props.money.isZero())) {
      throw new InvalidWagerTransactionError('amount must be greater than zero (zero only for LOSS)');
    }
    return WagerTransaction.pending(props);
  }

  /** Abertura interna com a identidade reservada do I-07; só existe com saldo inicial > 0 (I-06). */
  static createOpening(props: CreateOpeningProps): WagerTransaction {
    if (!props.money.isPositive()) throw new InvalidWagerTransactionError('opening amount must be greater than zero');
    return WagerTransaction.pending({
      id: props.id,
      providerId: SYSTEM_PROVIDER_ID,
      externalTransactionId: `opening:${props.walletId}`,
      idempotencyKey: `${SYSTEM_PROVIDER_ID}:opening:${props.walletId}`,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: OPENING_ROUND_ID,
      gameId: OPENING_GAME_ID,
      kind: WagerTransactionKind.Opening,
      money: props.money,
      correlationId: props.correlationId,
      createdAt: props.createdAt,
    });
  }

  /** Reconstrução a partir da persistência; não revalida transições. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.correlationId,
      structuredClone(state.createdAt),
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.observedBalance,
      state.referenceAttempts,
      state.nextReferenceAttemptAt === undefined ? undefined : structuredClone(state.nextReferenceAttemptAt),
      state.processedAt === undefined ? undefined : structuredClone(state.processedAt),
      structuredClone(state.updatedAt),
    );
  }

  private static pending(props: CreateWagerTransactionProps): WagerTransaction {
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.correlationId,
      structuredClone(props.createdAt),
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
      undefined,
      structuredClone(props.createdAt),
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  // ---- transições

  /** PENDING ou PENDING_REFERENCE → PROCESSED, com a referência resolvida e o saldo observado (I-26). */
  markProcessed(referenceTransactionId: string | undefined, observedBalance: Money, at: Date): void {
    this.assertTransitionFrom([WagerTransactionStatus.Pending, WagerTransactionStatus.PendingReference], 'PROCESSED');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._observedBalance = observedBalance;
    this._processedAt = structuredClone(at);
    this._updatedAt = structuredClone(at);
  }

  /** PENDING → PENDING_REFERENCE; a primeira tentativa do worker fica agendada em `nextAttemptAt` (I-21). */
  markPendingReference(observedBalance: Money, nextAttemptAt: Date, at: Date): void {
    this.assertTransitionFrom([WagerTransactionStatus.Pending], 'PENDING_REFERENCE');
    this._status = WagerTransactionStatus.PendingReference;
    this._observedBalance = observedBalance;
    this._referenceAttempts = 0;
    this._nextReferenceAttemptAt = structuredClone(nextAttemptAt);
    this._updatedAt = structuredClone(at);
  }

  /** PENDING ou PENDING_REFERENCE → REJECTED, com um código de rejeição de negócio e o saldo observado. */
  reject(code: FailureCode, observedBalance: Money, at: Date): void {
    this.assertTransitionFrom([WagerTransactionStatus.Pending, WagerTransactionStatus.PendingReference], 'REJECTED');
    if (!isRejectionCode(code)) throw new InvalidTransactionStateError(`${code} is not a business rejection code`);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._observedBalance = observedBalance;
    this._updatedAt = structuredClone(at);
  }

  /** PENDING ou PENDING_REFERENCE → FAILED (erro permanente inesperado, I-22). */
  fail(code: FailureCode, at: Date): void {
    this.assertTransitionFrom([WagerTransactionStatus.Pending, WagerTransactionStatus.PendingReference], 'FAILED');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._updatedAt = structuredClone(at);
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  /** false para LOSS, que só registra o resultado (I-12). */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  /** true para REFUND e ROLLBACK (I-13). */
  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** BET → DEBIT; WIN, REFUND e OPENING → CREDIT; ROLLBACK → inverso da referência (BET → CREDIT; WIN, REFUND → DEBIT). */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) throw new InvalidTransactionStateError('ROLLBACK needs its reference to define the direction');
        const reversible = [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund];
        if (!reversible.includes(reference.kind)) {
          throw new InvalidTransactionStateError(`ROLLBACK cannot reverse ${reference.kind}`);
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError('LOSS does not move the balance');
    }
  }

  private assertTransitionFrom(allowed: WagerTransactionStatus[], target: string): void {
    if (!allowed.includes(this._status)) {
      throw new InvalidTransactionStateError(`invalid transition ${this._status} → ${target} for transaction ${this.id}`);
    }
  }
}
