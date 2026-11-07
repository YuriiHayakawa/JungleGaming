import { z } from 'zod';
import { identifierSchema, moneySchema } from '../../../platform/http/money.schema.ts';

/**
 * Corpo de POST /wallets (contrato CreateWalletRequest): `playerId` 1–255 (case-sensitive, I-58) e
 * `initialBalance` no formato do I-01, até 9999999999999999.99, aceitando "0.00" (I-02, I-03, I-05).
 * Campos desconhecidos são descartados (I-57).
 */
export const createWalletSchema = z.object({
  playerId: identifierSchema,
  initialBalance: moneySchema,
});

export type CreateWalletRequest = z.output<typeof createWalletSchema>;
