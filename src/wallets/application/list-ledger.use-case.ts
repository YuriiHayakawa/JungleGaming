import type { MikroORM } from '@mikro-orm/postgresql';
import { WalletNotFoundError } from '../../shared-kernel/application/errors.ts';
import type { MoneyProps } from '../../shared-kernel/domain/money.ts';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry.ts';
import type { MikroOrmLedgerRepository } from '../infrastructure/mikro-orm-ledger.repository.ts';
import type { MikroOrmWalletRepository } from '../infrastructure/mikro-orm-wallet.repository.ts';
import { decodeCursor, encodeCursor } from './ledger-cursor.ts';

/** LedgerEntry do contrato: dinheiro como MoneyProps (string com 2 casas), data em ISO-8601. */
export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPageView {
  items: LedgerEntryView[];
  /** null quando não há próxima página. */
  nextCursor: string | null;
}

export interface ListLedgerQuery {
  walletId: string;
  /** Cursor opaco recebido (ainda não decodificado), ou ausente na primeira página. */
  cursor: string | undefined;
  /** Já validado: inteiro de 1 a 200 (I-47). */
  limit: number;
}

function toView(entry: WalletLedgerEntry): LedgerEntryView {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    createdAt: entry.createdAt.toISOString(),
  };
}

/**
 * GET /wallets/:walletId/ledger (FR-050, FR-051, I-36, I-47). Ordem crescente de `seq`; busca `limit + 1` e o item
 * extra define o `nextCursor` (o cursor do último item devolvido). Leituras num fork próprio, sem transação de escrita.
 * Cursor inválido → 400 antes de qualquer leitura; wallet inexistente → 404.
 */
export class ListLedgerUseCase {
  constructor(
    private readonly deps: { orm: Pick<MikroORM, 'em'>; wallets: MikroOrmWalletRepository; ledger: MikroOrmLedgerRepository },
  ) {}

  async execute(query: ListLedgerQuery): Promise<LedgerPageView> {
    const afterSeq = query.cursor === undefined ? '0' : decodeCursor(query.cursor);
    const em = this.deps.orm.em.fork();
    const wallet = await this.deps.wallets.findById(em, query.walletId);
    if (!wallet) throw new WalletNotFoundError();

    const rows = await this.deps.ledger.listPage(em, query.walletId, afterSeq, query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => toView(row.entry)),
      nextCursor: rows.length > query.limit && last ? encodeCursor(last.seq) : null,
    };
  }
}
