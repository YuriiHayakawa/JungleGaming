import { createHash } from 'node:crypto';
import { Money, type MoneyProps } from '../../shared-kernel/domain/money.ts';
import { canonicalJson } from './canonical-json.ts';

/** Campos de negócio que entram no hash (I-25). Qualquer outro campo do objeto recebido é ignorado (I-57). */
export interface PayloadHashSource {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

/**
 * payloadHash = SHA-256 hex do JSON canônico (I-25, R-09) de
 * {providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money{amount, currency},
 *  referenceExternalTransactionId?}.
 * - `amount` entra normalizado com 2 casas ("25" e "25.00" → mesmo hash);
 * - `walletId` entra em minúsculas (I-58); os demais ids entram como enviados (case-sensitive);
 * - header, idempotencyKey, messageId, occurredAt e campos desconhecidos ficam fora (I-25, I-57).
 * O cálculo é o mesmo no HTTP e na fila.
 */
export function computePayloadHash(source: PayloadHashSource): string {
  const money = Money.from({ amount: source.money.amount, currency: source.money.currency });
  const subset = {
    providerId: source.providerId,
    externalTransactionId: source.externalTransactionId,
    playerId: source.playerId,
    walletId: source.walletId.toLowerCase(),
    roundId: source.roundId,
    gameId: source.gameId,
    kind: source.kind,
    money: { amount: money.amount, currency: money.currency },
    referenceExternalTransactionId: source.referenceExternalTransactionId,
  };
  return createHash('sha256').update(canonicalJson(subset), 'utf8').digest('hex');
}
