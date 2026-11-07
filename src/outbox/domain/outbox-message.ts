import type { IntegrationEvent } from '../../shared-kernel/domain/integration-event.ts';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  eventVersion: number;
  payload: Readonly<Record<string, unknown>>;
  correlationId: string;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt?: Date;
}

const RETRY_BASE_MS = 1_000;
const RETRY_CAP_MS = 60_000;

/** Mensagem da outbox transacional (enunciado §6.5). Nesta feature só é gravada; o publisher é da feature 2. */
export class OutboxMessage {
  private constructor(
    readonly id: string,
    readonly aggregateId: string,
    readonly eventType: string,
    readonly eventVersion: number,
    readonly payload: Readonly<Record<string, unknown>>,
    readonly correlationId: string,
    readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.version,
      event.toJSON() as unknown as Readonly<Record<string, unknown>>,
      event.correlationId,
      event.occurredAt,
      0,
      event.occurredAt,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.eventVersion,
      state.payload,
      state.correlationId,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && this._nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    if (!this.isPending()) throw new Error(`outbox message ${this.id} is already published`);
    this._publishedAt = at;
  }

  /** Incrementa attempts e agenda a próxima tentativa com backoff exponencial (base 1 s, teto 60 s). */
  scheduleRetry(now: Date): void {
    this._attempts += 1;
    const delay = Math.min(RETRY_BASE_MS * 2 ** (this._attempts - 1), RETRY_CAP_MS);
    // Deriva do `now` recebido (porta Clock); o domínio nunca lê o relógio (constitution VI).
    const next = structuredClone(now);
    next.setTime(now.getTime() + delay);
    this._nextAttemptAt = next;
  }
}
