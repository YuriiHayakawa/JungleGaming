import { z } from 'zod';
import type { SubmitWagerTransactionInput } from '../../wagering/application/submit-wager-transaction.use-case.ts';
import { submitWagerTransactionSchema } from '../../wagering/interfaces/http/wager-transaction.dto.ts';

/** Tipo único aceito na fila de transações (I-66). */
export const WAGER_TRANSACTION_REQUESTED = 'WagerTransactionRequested';

/** Códigos de DLQ do envelope (I-70; contracts/queues.md). */
export type DlqErrorCode = 'MALFORMED_MESSAGE' | 'UNSUPPORTED_MESSAGE_TYPE' | 'VALIDATION_ERROR' | 'OPENING_NOT_ALLOWED';

/** Mensagem que não pode ser processada: erro permanente, DLQ direta (I-30, I-66, I-69). */
export class InvalidWagerMessageError extends Error {
  constructor(
    readonly errorCode: DlqErrorCode,
    /** O `messageId` do envelope, quando ele existe e é válido. */
    readonly messageId: string | undefined,
    readonly issues: Array<{ path: string; message: string }> = [],
  ) {
    super(`invalid wager message: ${errorCode}`);
    this.name = 'InvalidWagerMessageError';
  }
}

export interface WagerMessage {
  messageId: string;
  type: typeof WAGER_TRANSACTION_REQUESTED;
  occurredAt: string;
  /** Faz o papel do header Idempotency-Key (I-23, I-48); não entra no payloadHash (I-25). */
  idempotencyKey: string;
  /** Payload de negócio validado e normalizado pelas mesmas regras da submissão HTTP (I-57, I-58, I-60). */
  input: SubmitWagerTransactionInput;
}

/** 1 a 128 caracteres em [A-Za-z0-9._:-], o mesmo conjunto do X-Correlation-Id (I-53, I-69). */
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** Envelope (contracts/wager-transaction-requested.schema.json); campos desconhecidos descartados (I-57). */
const envelopeSchema = z.object({
  messageId: z.string().regex(MESSAGE_ID_PATTERN),
  type: z.string(),
  occurredAt: z.iso.datetime({ offset: true }),
  data: z.record(z.string(), z.unknown()),
});

/** `data` = schema de submissão da 001 + `idempotencyKey` de 1 a 255 caracteres. */
const idempotencyKeySchema = z.object({ idempotencyKey: z.string().min(1).max(255) });

function issuesOf(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message }));
}

/**
 * Valida o corpo de uma mensagem da fila de transações (FR-002), na ordem:
 * 1. corpo que não é um objeto JSON, envelope sem campo obrigatório, `messageId` fora do formato, `occurredAt` não
 *    ISO-8601 ou `data` que não é objeto → MALFORMED_MESSAGE;
 * 2. `type` diferente de WagerTransactionRequested → UNSUPPORTED_MESSAGE_TYPE (I-66);
 * 3. `kind` OPENING → OPENING_NOT_ALLOWED (I-08);
 * 4. `data` fora das regras da submissão HTTP da 001 (dinheiro como número, referência por kind, autorreferência,
 *    "system", zero fora de LOSS) ou sem `idempotencyKey` → VALIDATION_ERROR.
 * Todos são erros permanentes (DLQ direta, I-30).
 */
export function parseWagerMessage(body: string): WagerMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new InvalidWagerMessageError('MALFORMED_MESSAGE', undefined, [{ path: '', message: 'body is not JSON' }]);
  }
  const candidateId =
    parsed !== null && typeof parsed === 'object' && typeof (parsed as { messageId?: unknown }).messageId === 'string'
      ? (parsed as { messageId: string }).messageId
      : undefined;
  const knownId = candidateId !== undefined && MESSAGE_ID_PATTERN.test(candidateId) ? candidateId : undefined;

  const envelope = envelopeSchema.safeParse(parsed);
  if (!envelope.success) throw new InvalidWagerMessageError('MALFORMED_MESSAGE', knownId, issuesOf(envelope.error));
  const { messageId, type, occurredAt, data } = envelope.data;

  if (type !== WAGER_TRANSACTION_REQUESTED) {
    throw new InvalidWagerMessageError('UNSUPPORTED_MESSAGE_TYPE', messageId, [{ path: 'type', message: `unsupported type ${type}` }]);
  }
  if (data.kind === 'OPENING') {
    throw new InvalidWagerMessageError('OPENING_NOT_ALLOWED', messageId, [{ path: 'data.kind', message: 'kind OPENING is internal' }]);
  }
  const key = idempotencyKeySchema.safeParse(data);
  const input = submitWagerTransactionSchema.safeParse(data);
  if (!key.success || !input.success) {
    const issues = [...(key.success ? [] : issuesOf(key.error)), ...(input.success ? [] : issuesOf(input.error))];
    throw new InvalidWagerMessageError('VALIDATION_ERROR', messageId, issues);
  }
  return {
    messageId,
    type: WAGER_TRANSACTION_REQUESTED,
    occurredAt,
    idempotencyKey: key.data.idempotencyKey,
    input: input.data,
  };
}
