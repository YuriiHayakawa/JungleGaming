import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { OutboxMessage } from '../../outbox/domain/outbox-message.ts';
import type { MikroOrmOutboxWriter } from '../../outbox/infrastructure/mikro-orm-outbox.writer.ts';
import { currentRequestContext, setRequestContextValues } from '../../platform/correlation/request-context.ts';
import { classifyDbError } from '../../platform/persistence/pg-errors.ts';
import type { UnitOfWork } from '../../platform/persistence/unit-of-work.ts';
import { InternalError, WalletAlreadyExistsError } from '../../shared-kernel/application/errors.ts';
import type { Clock } from '../../shared-kernel/domain/clock.port.ts';
import type { IdGenerator } from '../../shared-kernel/domain/id-generator.port.ts';
import { Money, type MoneyProps } from '../../shared-kernel/domain/money.ts';
import { computePayloadHash } from '../../wagering/application/payload-hash.ts';
import { WagerTransaction, WagerTransactionKind } from '../../wagering/domain/wager-transaction.ts';
import type { MikroOrmWagerTransactionRepository } from '../../wagering/infrastructure/mikro-orm-wager-transaction.repository.ts';
import { WalletBalanceChanged } from '../domain/events/wallet-balance-changed.event.ts';
import { LedgerDirection } from '../domain/ledger-direction.ts';
import { Wallet } from '../domain/wallet.ts';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry.ts';
import type { MikroOrmLedgerRepository } from '../infrastructure/mikro-orm-ledger.repository.ts';
import type { MikroOrmWalletRepository } from '../infrastructure/mikro-orm-wallet.repository.ts';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export interface CreateWalletDeps {
  orm: Pick<MikroORM, 'em'>;
  unitOfWork: UnitOfWork<EntityManager>;
  wallets: MikroOrmWalletRepository;
  ledger: MikroOrmLedgerRepository;
  transactions: MikroOrmWagerTransactionRepository;
  outbox: MikroOrmOutboxWriter;
  clock: Clock;
  ids: IdGenerator;
}

/**
 * Cria a wallet (FR-005 a FR-008, I-06, I-07, I-09, I-10, I-52). Numa só transação SQL: a wallet (version 1) e,
 * com saldo inicial > 0, a OPENING PROCESSED, o lançamento CREDIT (antes 0.00) e o WalletBalanceChanged na outbox.
 * A duplicata (23505 em wallets_player_currency_uq) vira 409 com o id da wallet vencedora, lido depois do rollback.
 */
export class CreateWalletUseCase {
  constructor(private readonly deps: CreateWalletDeps) {}

  async execute(command: CreateWalletCommand): Promise<WalletView> {
    const { clock, ids } = this.deps;
    const correlationId = currentRequestContext()?.correlationId ?? ids.next();
    const now = clock.now();
    const initialBalance = Money.from(command.initialBalance);

    let wallet: Wallet;
    try {
      // Cada tentativa da unit of work (R-12) recomeça do zero: wallet, abertura, ids e evento novos.
      wallet = await this.deps.unitOfWork.run(async (em) => {
        const opened = Wallet.open({ id: ids.next(), playerId: command.playerId, initialBalance, at: now });
        await this.deps.wallets.insert(em, opened);
        if (initialBalance.isPositive()) await this.recordOpening(em, opened, correlationId, now);
        return opened;
      });
    } catch (error) {
      if (classifyDbError(error) === 'wallet-duplicate') {
        // A vencedora já está confirmada: o PostgreSQL só reporta o 23505 depois que a concorrente decide (I-52).
        const existingId = await this.deps.wallets.findIdByPlayerAndCurrency(
          this.deps.orm.em.fork(),
          command.playerId,
          initialBalance.currency,
        );
        if (!existingId) throw new InternalError({ cause: error });
        setRequestContextValues({ walletId: existingId });
        throw new WalletAlreadyExistsError(existingId);
      }
      throw error;
    }

    setRequestContextValues({ walletId: wallet.id });
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }

  /** OPENING PROCESSED + CREDIT com balanceBefore 0.00, sem incrementar a version (I-06), e o evento (I-09). */
  private async recordOpening(em: EntityManager, wallet: Wallet, correlationId: string, now: Date): Promise<void> {
    const { ids } = this.deps;
    const money = wallet.balance;
    const opening = WagerTransaction.createOpening({
      id: ids.next(),
      walletId: wallet.id,
      playerId: wallet.playerId,
      money,
      payloadHash: computePayloadHash({
        providerId: 'system',
        externalTransactionId: `opening:${wallet.id}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'opening',
        gameId: 'system',
        kind: WagerTransactionKind.Opening,
        money: money.toJSON(),
      }),
      correlationId,
      createdAt: now,
    });
    opening.markProcessed(undefined, money, now);

    const entry = WalletLedgerEntry.create({
      id: ids.next(),
      walletId: wallet.id,
      transactionId: opening.id,
      direction: LedgerDirection.Credit,
      money,
      balanceBefore: Money.zero(money.currency),
      balanceAfter: money,
      createdAt: now,
    });
    const event = WalletBalanceChanged.from(wallet, entry, { eventId: ids.next(), correlationId, occurredAt: now });

    await this.deps.transactions.insert(em, opening);
    await this.deps.ledger.insert(em, entry);
    await this.deps.outbox.append(em, [OutboxMessage.enqueue(event)]);
  }
}
