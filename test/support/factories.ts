// Builders de payload HTTP, com ids únicos por chamada e dinheiro sempre como string.
import type { MoneyProps } from '../../src/shared-kernel/domain/money.ts';

const unique = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

export interface WalletRequest {
  playerId: string;
  initialBalance: MoneyProps;
}

export function walletRequest(overrides: Partial<WalletRequest> = {}): WalletRequest {
  return {
    playerId: overrides.playerId ?? unique('player'),
    initialBalance: overrides.initialBalance ?? { amount: '100.00', currency: 'BRL' },
  };
}

export type WagerKind = 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';

export interface WagerRequest {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export function wagerRequest(
  kind: WagerKind,
  base: { walletId: string; playerId: string } & Partial<Omit<WagerRequest, 'kind'>>,
): WagerRequest {
  return {
    providerId: base.providerId ?? 'provider-a',
    externalTransactionId: base.externalTransactionId ?? unique(kind.toLowerCase()),
    playerId: base.playerId,
    walletId: base.walletId,
    roundId: base.roundId ?? 'round-1',
    gameId: base.gameId ?? 'game-1',
    kind,
    money: base.money ?? { amount: '10.00', currency: 'BRL' },
    ...(base.referenceExternalTransactionId !== undefined
      ? { referenceExternalTransactionId: base.referenceExternalTransactionId }
      : {}),
  };
}

/** Chave de idempotência padrão recomendada ao provedor (I-23). */
export function idempotencyKeyFor(request: Pick<WagerRequest, 'providerId' | 'externalTransactionId'>): string {
  return `${request.providerId}:${request.externalTransactionId}`;
}
