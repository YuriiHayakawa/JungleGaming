// T124 — unit of work: retry de 40P01/40001 e conversão para 503 (research R-12, R-19, FR-043).
// O EntityManager aqui é um objeto de teste opaco; nenhum teste de integração substitui o PostgreSQL.
import { describe, expect, test } from 'bun:test';
import { DriverException, UniqueConstraintViolationException } from '@mikro-orm/core';
import { UnitOfWork, type TransactionalRoot } from '../../src/platform/persistence/unit-of-work.ts';
import { ServiceUnavailableError } from '../../src/shared-kernel/application/errors.ts';

interface FakeTx {
  id: number;
  executed: string[];
  execute(sql: string): Promise<unknown>;
}

function fakeRoot() {
  const txs: FakeTx[] = [];
  const isolationLevels: unknown[] = [];
  const root: TransactionalRoot<FakeTx> = {
    fork() {
      return {
        async transactional<T>(cb: (em: FakeTx) => Promise<T>, options?: { isolationLevel?: unknown }) {
          isolationLevels.push(options?.isolationLevel);
          const tx: FakeTx = {
            id: txs.length + 1,
            executed: [],
            async execute(sql: string) {
              this.executed.push(sql);
              return [];
            },
          };
          txs.push(tx);
          return cb(tx);
        },
      };
    },
  };
  return { root, txs, isolationLevels };
}

const dbError = (code: string) => new DriverException(Object.assign(new Error(`err ${code}`), { code }));

describe.each(['40P01', '40001'])('SQLSTATE %s', (code) => {
  test('executa 3 vezes (1 + 2 repetições) e termina em ServiceUnavailableError', async () => {
    const { root, txs } = fakeRoot();
    const uow = new UnitOfWork(root, 5000);
    let calls = 0;
    const result = uow.run(async () => {
      calls++;
      throw dbError(code);
    });
    await expect(result).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(calls).toBe(3);
    expect(txs).toHaveLength(3);
  });

  test('sucesso na repetição devolve o resultado, com 2 execuções', async () => {
    const { root } = fakeRoot();
    const uow = new UnitOfWork(root, 5000);
    let calls = 0;
    const result = await uow.run(async () => {
      calls++;
      if (calls === 1) throw dbError(code);
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });
});

describe('sem repetição', () => {
  test('transient (55P03): 1 execução e ServiceUnavailableError', async () => {
    const { root } = fakeRoot();
    let calls = 0;
    const result = new UnitOfWork(root, 5000).run(async () => {
      calls++;
      throw dbError('55P03');
    });
    await expect(result).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(calls).toBe(1);
  });

  test('23505: 1 execução e o erro original propagado para o use case decidir', async () => {
    const { root } = fakeRoot();
    let calls = 0;
    const unique = new UniqueConstraintViolationException(
      Object.assign(new Error('dup'), { code: '23505', constraint: 'wager_tx_provider_idempotency_uq' }),
    );
    const result = new UnitOfWork(root, 5000).run(async () => {
      calls++;
      throw unique;
    });
    await expect(result).rejects.toBe(unique);
    expect(calls).toBe(1);
  });

  test('invariant (23514): 1 execução e erro original propagado', async () => {
    const { root } = fakeRoot();
    let calls = 0;
    const error = dbError('23514');
    const result = new UnitOfWork(root, 5000).run(async () => {
      calls++;
      throw error;
    });
    await expect(result).rejects.toBe(error);
    expect(calls).toBe(1);
  });
});

describe('transação', () => {
  test('passa o EntityManager da transação ao trabalho, em READ COMMITTED, com SET LOCAL lock_timeout primeiro', async () => {
    const { root, txs, isolationLevels } = fakeRoot();
    let received: FakeTx | undefined;
    await new UnitOfWork(root, 1234).run(async (tx) => {
      received = tx;
      await tx.execute('select 1');
    });
    expect(received).toBe(txs[0]);
    expect(txs[0]?.executed).toEqual(["set local lock_timeout = '1234ms'", 'select 1']);
    expect(String(isolationLevels[0]).toLowerCase()).toBe('read committed');
  });

  test('recusa lock timeout que não seja inteiro positivo', () => {
    const { root } = fakeRoot();
    expect(() => new UnitOfWork(root, 0)).toThrow();
    expect(() => new UnitOfWork(root, 1.5)).toThrow();
  });
});

describe('cada tentativa é independente (R-12, R-19)', () => {
  test('cada tentativa abre um fork novo e recebe um EntityManager transacional diferente', async () => {
    let forks = 0;
    const seen: object[] = [];
    const root: TransactionalRoot<FakeTx> = {
      fork() {
        forks++;
        return {
          async transactional<T>(cb: (em: FakeTx) => Promise<T>) {
            const tx: FakeTx = { id: forks, executed: [], async execute() { return []; } };
            return cb(tx);
          },
        };
      },
    };
    let calls = 0;
    const result = await new UnitOfWork(root, 5000).run(async (tx) => {
      calls++;
      seen.push(tx);
      if (calls < 3) throw dbError('40001');
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(forks).toBe(3);
    expect(new Set(seen).size).toBe(3);
  });
});
