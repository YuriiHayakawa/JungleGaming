import { z } from 'zod';
import { Money } from '../../shared-kernel/domain/money.ts';

const AMOUNT_PATTERN = /^(0|[1-9]\d*)(\.\d{1,2})?$/; // I-01
const CURRENCY_PATTERN = /^[A-Z]{3}$/; // I-05

/**
 * Schema Zod de MoneyProps na entrada (I-01, I-03, I-05): `amount` só como string (número JSON → erro de tipo),
 * no formato do I-01, até 9999999999999999.99, normalizado para 2 casas. Nunca passa por number.
 */
export const moneySchema = z
  .object({
    amount: z
      .string({ error: 'amount must be a decimal string' })
      .regex(AMOUNT_PATTERN, 'amount must be a decimal string with at most 2 decimal places')
      .refine(isWithinMaximum, { message: `amount must not exceed ${Money.MAXIMUM_AMOUNT}` }),
    currency: z.string({ error: 'currency must be a string' }).regex(CURRENCY_PATTERN, 'currency must match ^[A-Z]{3}$'),
  })
  .transform(({ amount, currency }) => Money.from({ amount, currency }).toJSON());

/** O formato já foi validado pelo regex; aqui só o limite do I-03, comparado por Money (sem number). */
function isWithinMaximum(amount: string): boolean {
  try {
    Money.from({ amount, currency: 'XXX' });
    return true;
  } catch {
    return false;
  }
}

/** String de identificador textual com 1 a 255 caracteres, sem normalização (I-50, I-58). */
export const identifierSchema = z.string().min(1, 'must have 1 to 255 characters').max(255, 'must have 1 to 255 characters');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** UUID gerado pelo serviço, normalizado para minúsculas antes da validação (I-50, I-58). */
export const serviceUuidSchema = z
  .string()
  .transform((value) => value.toLowerCase())
  .pipe(z.string().regex(UUID_PATTERN, 'must be a UUID'));
