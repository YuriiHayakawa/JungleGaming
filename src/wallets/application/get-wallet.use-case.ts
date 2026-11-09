import type { MikroORM } from '@mikro-orm/postgresql';
import { WalletNotFoundError } from '../../shared-kernel/application/errors.ts';
import type { Wallet } from '../domain/wallet.ts';
import type { MikroOrmWalletRepository } from '../infrastructure/mikro-orm-wallet.repository.ts';
import type { WalletView } from './create-wallet.use-case.ts';

export function toWalletView(wallet: Wallet): WalletView {
  return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
}

/** GET /wallets/:walletId (FR-049). Leitura num fork próprio, sem transação de escrita (R-05, R-19). */
export class GetWalletUseCase {
  constructor(private readonly deps: { orm: Pick<MikroORM, 'em'>; wallets: MikroOrmWalletRepository }) {}

  async execute(walletId: string): Promise<WalletView> {
    const wallet = await this.deps.wallets.findById(this.deps.orm.em.fork(), walletId);
    if (!wallet) throw new WalletNotFoundError();
    return toWalletView(wallet);
  }
}
