import { z } from 'zod';
import { identifierSchema, moneySchema, serviceUuidSchema } from '../../../platform/http/money.schema.ts';
import { ZodValidationPipe } from '../../../platform/http/zod-validation.pipe.ts';
import {
  IdempotencyKeyRequiredError,
  OpeningNotAllowedError,
  ValidationError,
} from '../../../shared-kernel/application/errors.ts';

const SUBMITTABLE_KINDS = ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/**
 * Corpo de POST /wagering/transactions (contrato SubmitWagerTransactionRequest; R-13):
 * - campos desconhecidos são descartados (strip padrão do z.object), e os conhecidos continuam estritos (I-57);
 * - `walletId` é normalizado para minúsculas; os demais ids são preservados como enviados (I-58);
 * - `amount` normalizado para 2 casas; zero só em LOSS (I-01, I-02, I-03);
 * - providerId "system" recusado (I-07); referência por kind conforme o I-13; autorreferência recusada (I-60).
 * A fila (feature de mensageria) reusa este schema para o `data` da mensagem.
 * kind OPENING é tratado antes do schema, com o código próprio OPENING_NOT_ALLOWED (I-08).
 */
export const submitWagerTransactionSchema = z
  .object({
    providerId: identifierSchema.refine((value) => value !== 'system', 'providerId "system" is reserved'),
    externalTransactionId: identifierSchema,
    playerId: identifierSchema,
    walletId: serviceUuidSchema,
    roundId: identifierSchema,
    gameId: identifierSchema,
    kind: z.enum(SUBMITTABLE_KINDS),
    money: moneySchema,
    referenceExternalTransactionId: identifierSchema.optional(),
  })
  .superRefine((body, ctx) => {
    const hasReference = body.referenceExternalTransactionId !== undefined;
    if (body.kind === 'BET' && hasReference) {
      ctx.addIssue({ code: 'custom', path: ['referenceExternalTransactionId'], message: 'BET does not accept a reference' });
    }
    if ((body.kind === 'REFUND' || body.kind === 'ROLLBACK') && !hasReference) {
      ctx.addIssue({ code: 'custom', path: ['referenceExternalTransactionId'], message: `${body.kind} requires a reference` });
    }
    // I-60: autorreferência é payload inválido. Comparação exata, com caixa (I-58).
    if (hasReference && body.referenceExternalTransactionId === body.externalTransactionId) {
      ctx.addIssue({
        code: 'custom',
        path: ['referenceExternalTransactionId'],
        message: 'a transaction cannot reference itself',
      });
    }
    if (body.kind !== 'LOSS' && body.money.amount === '0.00') {
      ctx.addIssue({ code: 'custom', path: ['money', 'amount'], message: 'amount must be greater than zero (zero only for LOSS)' });
    }
  });

export type SubmitWagerTransactionRequest = z.output<typeof submitWagerTransactionSchema>;

/** Rota GET /wagering/transactions/:transactionId: UUID gerado pelo serviço, em minúsculas (I-50, I-58). */
export const transactionIdParamSchema = z.object({ transactionId: serviceUuidSchema });

/**
 * Rota GET /providers/:providerId/wagering/transactions/:externalTransactionId: ids textuais de 1 a 255, case-sensitive
 * (I-50, I-58); providerId "system" recusado (I-07), então a abertura nunca é alcançável por esta rota.
 */
export const providerTransactionParamsSchema = z.object({
  providerId: identifierSchema.refine((value) => value !== 'system', 'providerId "system" is reserved'),
  externalTransactionId: identifierSchema,
});

const bodyPipe = new ZodValidationPipe(submitWagerTransactionSchema);

/** I-44 passo 1 (I-23, I-48): ausente ou vazio → IDEMPOTENCY_KEY_REQUIRED; mais de 255 ou repetido → VALIDATION_ERROR. */
export function parseIdempotencyKey(header: unknown): string {
  if (header === undefined || header === '') throw new IdempotencyKeyRequiredError();
  if (typeof header !== 'string') {
    throw new ValidationError('Request payload is invalid', {
      issues: [{ path: 'Idempotency-Key', message: 'must be a single header value' }],
    });
  }
  if (header.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new ValidationError('Request payload is invalid', {
      issues: [{ path: 'Idempotency-Key', message: `must have at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters` }],
    });
  }
  return header;
}

/** I-44 passo 2: OPENING → OPENING_NOT_ALLOWED (I-08); o resto pelo schema → VALIDATION_ERROR com `details.issues`. */
export function parseSubmitWagerTransactionBody(body: unknown): SubmitWagerTransactionRequest {
  if (body !== null && typeof body === 'object' && (body as { kind?: unknown }).kind === 'OPENING') {
    throw new OpeningNotAllowedError();
  }
  return bodyPipe.transform(body);
}
