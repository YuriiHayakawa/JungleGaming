import { IsolationLevel } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { JsonLogger } from '../../platform/logging/json-logger.ts';
import type { MetricsPort } from '../../platform/metrics/metrics.port.ts';
import { classifyDbError } from '../../platform/persistence/pg-errors.ts';
import { ServiceUnavailableError, WalletNotFoundError } from '../../shared-kernel/application/errors.ts';
import type { MoneyProps } from '../../shared-kernel/domain/money.ts';
import { reconcile, type ReconciliationInput } from '../domain/reconciliation.ts';
import type { MikroOrmReconciliationReader } from '../infrastructure/mikro-orm-reconciliation.reader.ts';

/** Corpo da resposta 200 ([contracts/http.md](../../../specs/003-reconciliation-health-metrics/contracts/http.md)). */
export interface ReconciliationView {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  chainConsistent: boolean;
  firstBrokenSeq?: number;
  checkedEntries: number;
}

export interface ReconcileWalletDeps {
  orm: Pick<MikroORM, 'em'>;
  reader: MikroOrmReconciliationReader;
  logger: Pick<JsonLogger, 'error'>;
  metrics: Pick<MetricsPort, 'increment'>;
}

/** O modo da transação não é o pedido: erro de programação, nunca caminho de negócio (500). */
export class ReconciliationSnapshotError extends Error {
  constructor(mode: { isolation: string; readOnly: boolean }) {
    super(`reconciliation must run in a REPEATABLE READ, READ ONLY transaction (got ${mode.isolation}, readOnly=${mode.readOnly})`);
    this.name = 'ReconciliationSnapshotError';
  }
}

/**
 * Reconciliação de uma wallet (FR-001 a FR-012; I-37, I-74; R-36):
 *
 * 1. um fork do EM abre uma transação `REPEATABLE READ`; a primeira instrução é `SET TRANSACTION READ ONLY`, então o
 *    próprio banco recusa qualquer escrita por engano; o modo é conferido antes das leituras;
 * 2. saldo da wallet e agregado do ledger lidos no mesmo snapshot, sem lock: uma escrita concorrente aparece inteira ou
 *    não aparece, e nenhuma escrita espera pela reconciliação (FR-002, FR-010);
 * 3. depois da transação, `reconcile` (puro) decide; divergência → log `error` sem valores monetários, +1 em
 *    `reconciliation_divergences_total` e `consistent: false`. Nada é corrigido (enunciado §9, constitution II).
 *
 * Wallet inexistente → 404; falha transitória do banco → 503 (classificador da 001), sem log de divergência nem contador.
 */
export class ReconcileWalletUseCase {
  constructor(private readonly deps: ReconcileWalletDeps) {}

  async execute(walletId: string): Promise<ReconciliationView> {
    const input = await this.readSnapshot(walletId);
    if (!input) throw new WalletNotFoundError();

    const result = reconcile(input);
    if (!result.consistent) {
      // Sem valores monetários (FR-008): só ids, contagem e a posição da quebra. O correlationId vem do contexto.
      this.deps.logger.error('reconciliation.divergence', {
        event: 'reconciliation.divergence',
        walletId: result.walletId,
        checkedEntries: result.checkedEntries,
        ...(result.firstBrokenSeq !== undefined ? { firstBrokenSeq: result.firstBrokenSeq } : {}),
        consistent: false,
      });
      this.deps.metrics.increment('reconciliation_divergences_total');
    }

    return {
      walletId: result.walletId,
      storedBalance: result.storedBalance.toJSON(),
      calculatedBalance: result.calculatedBalance.toJSON(),
      difference: result.difference.toJSON(),
      consistent: result.consistent,
      chainConsistent: result.chainConsistent,
      ...(result.firstBrokenSeq !== undefined ? { firstBrokenSeq: result.firstBrokenSeq } : {}),
      checkedEntries: result.checkedEntries,
    };
  }

  private async readSnapshot(walletId: string): Promise<ReconciliationInput | undefined> {
    const { reader } = this.deps;
    try {
      return await this.deps.orm.em.fork().transactional(
        async (em: EntityManager) => {
          await em.execute('SET TRANSACTION READ ONLY');
          const mode = await reader.transactionMode(em);
          if (mode.isolation !== 'repeatable read' || !mode.readOnly) throw new ReconciliationSnapshotError(mode);
          const wallet = await reader.readWallet(em, walletId);
          if (!wallet) return undefined;
          const ledger = await reader.readLedgerAggregate(em, walletId);
          return reader.toInput(walletId, wallet, ledger);
        },
        { isolationLevel: IsolationLevel.REPEATABLE_READ },
      );
    } catch (error) {
      const kind = classifyDbError(error);
      if (kind === 'transient' || kind === 'retry') throw new ServiceUnavailableError({ cause: error });
      throw error;
    }
  }
}
