import { z } from 'zod';
import { identifierSchema, moneySchema, serviceUuidSchema } from '../../../platform/http/money.schema.ts';

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

/** Parâmetro de rota `walletId`: UUID gerado pelo serviço, normalizado para minúsculas (I-50, I-58). */
export const walletIdParamSchema = z.object({ walletId: serviceUuidSchema });

/**
 * Query do ledger (I-47): `cursor` opaco de 1 a 64 caracteres (decodificado e validado pelo use case) e `limit`, que
 * fica como texto para o `parseLimit` recusar não inteiro, < 1 ou > 200 sem truncar. Valor repetido (array) é recusado
 * pelo tipo string. Outros parâmetros são descartados (I-57).
 */
export const ledgerQuerySchema = z.object({
  cursor: z.string().min(1, 'cursor is invalid').max(64, 'cursor is invalid').optional(),
  limit: z.string().optional(),
});
