import { DomainError, InvalidTransactionStateError } from '../../shared-kernel/domain/errors.ts';

/** Dados de recebimento fora dos formatos da data-model §1 (I-28, I-69). */
export class InvalidInboxMessageError extends DomainError {}

/**
 * Mesmo (consumerName, messageId) já registrado com outro payloadHash: mensagem venenosa, erro permanente, DLQ com
 * `INBOX_PAYLOAD_MISMATCH` (I-28, I-70). Nunca é replay.
 */
export class InboxPayloadMismatchError extends DomainError {
  constructor(readonly messageId: string) {
    super(`message ${messageId} was already handled with a different payload`);
  }
}

/** `messageId`: 1 a 128 caracteres em [A-Za-z0-9._:-], o mesmo conjunto do X-Correlation-Id (I-53, I-69). */
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const PAYLOAD_HASH_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CONSUMER_NAME_LENGTH = 64;

export interface ReceiveInboxMessageProps {
  messageId: string;
  consumerName: string;
  /** SHA-256 hex do JSON canônico de `data` (o mesmo payloadHash do I-25). */
  payloadHash: string;
  /** Transação resultante: a criada pela mensagem ou a existente, em replay. */
  transactionId: string;
  receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxMessageProps {
  processedAt: Date | undefined;
}

/**
 * Registro de mensagem tratada por um consumidor (enunciado §6.5). Única por (consumerName, messageId) no banco
 * (`inbox_messages_pk`). Na persistência a linha é sempre gravada já processada: `receive` + `markProcessed` na mesma
 * transação do efeito ou do replay (data-model §1).
 */
export class InboxMessage {
  private constructor(
    readonly messageId: string,
    readonly consumerName: string,
    readonly payloadHash: string,
    readonly transactionId: string,
    readonly receivedAt: Date,
    private _processedAt: Date | undefined,
  ) {}

  static receive(props: ReceiveInboxMessageProps): InboxMessage {
    if (!MESSAGE_ID_PATTERN.test(props.messageId)) {
      throw new InvalidInboxMessageError('messageId must have 1 to 128 characters in [A-Za-z0-9._:-]');
    }
    if (props.consumerName.length < 1 || props.consumerName.length > MAX_CONSUMER_NAME_LENGTH) {
      throw new InvalidInboxMessageError(`consumerName must have 1 to ${MAX_CONSUMER_NAME_LENGTH} characters`);
    }
    if (!PAYLOAD_HASH_PATTERN.test(props.payloadHash)) {
      throw new InvalidInboxMessageError('payloadHash must be a lowercase SHA-256 hex digest');
    }
    if (!UUID_PATTERN.test(props.transactionId)) {
      throw new InvalidInboxMessageError('transactionId must be a UUID');
    }
    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      props.transactionId,
      structuredClone(props.receivedAt),
      undefined,
    );
  }

  /** Reconstrução a partir da persistência; não revalida formatos. */
  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      state.transactionId,
      structuredClone(state.receivedAt),
      state.processedAt === undefined ? undefined : structuredClone(state.processedAt),
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** Uma vez só; a segunda chamada é erro de programação. Nunca antes do recebimento (`inbox_processed_after_ck`). */
  markProcessed(at: Date): void {
    if (this._processedAt !== undefined) {
      throw new InvalidTransactionStateError(`inbox message ${this.consumerName}/${this.messageId} is already processed`);
    }
    if (at.getTime() < this.receivedAt.getTime()) {
      throw new InvalidInboxMessageError('processedAt must not be before receivedAt');
    }
    this._processedAt = structuredClone(at);
  }
}
