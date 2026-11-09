import { IsolationLevel } from '@mikro-orm/core';
import { ServiceUnavailableError } from '../../shared-kernel/application/errors.ts';
import type { MetricsPort } from '../metrics/metrics.port.ts';
import { classifyDbError, sqlStateOf } from './pg-errors.ts';

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');

/** O mínimo do EntityManager que a unit of work usa: fork() e transactional(). */
export interface TransactionalRoot<Tx extends { execute(sql: string): Promise<unknown> }> {
  fork(): {
    transactional<T>(cb: (em: Tx) => Promise<T>, options?: { isolationLevel?: IsolationLevel }): Promise<T>;
  };
}

const MAX_RETRIES = 2;

/**
 * Transação de escrita (research R-07, R-12, R-19):
 * - abre um fork (identity map novo) e uma transação READ COMMITTED;
 * - executa `SET LOCAL lock_timeout` como primeiro comando (I-51);
 * - passa ao trabalho o EntityManager DA TRANSAÇÃO: toda query do trabalho deve usá-lo;
 * - repete o trabalho inteiro até 2 vezes em deadlock (40P01) ou falha de serialização (40001);
 * - converte falha transitória em ServiceUnavailableError, sempre depois do rollback;
 * - qualquer outro erro (23505, invariante, negócio) é propagado sem repetição para o use case decidir;
 * - espera pelo lock esgotada (55P03) conta em `lock_conflicts_total` (FR-036), quando há porta de métricas.
 */
export class UnitOfWork<Tx extends { execute(sql: string): Promise<unknown> }> {
  constructor(
    private readonly root: TransactionalRoot<Tx>,
    private readonly lockTimeoutMs: number,
    private readonly metrics?: Pick<MetricsPort, 'increment'>,
  ) {
    if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1) {
      throw new Error(`lock timeout must be a positive integer, got ${lockTimeoutMs}`);
    }
  }

  async run<T>(work: (em: Tx) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.root.fork().transactional(
          async (tx) => {
            // SET não aceita parâmetro; lockTimeoutMs é um inteiro validado no construtor e no boot.
            await tx.execute(`set local lock_timeout = '${this.lockTimeoutMs}ms'`);
            return work(tx);
          },
          { isolationLevel: IsolationLevel.READ_COMMITTED },
        );
      } catch (error) {
        const kind = classifyDbError(error);
        if (sqlStateOf(error) === '55P03') this.metrics?.increment('lock_conflicts_total');
        if (kind === 'retry' && attempt < MAX_RETRIES) continue;
        if (kind === 'retry' || kind === 'transient') throw new ServiceUnavailableError({ cause: error });
        throw error;
      }
    }
  }
}
