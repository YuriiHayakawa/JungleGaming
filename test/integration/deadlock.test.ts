// T125 — deadlock real no PostgreSQL, sem mock (research R-12, gate de Tasks).
// Duas transações travam duas linhas em ordem oposta. Quem começa a esperar primeiro estoura o deadlock_timeout
// primeiro, detecta o ciclo e é a vítima: a ordem das esperas define de que lado vem o 40P01.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmOptions } from '../../src/platform/persistence/mikro-orm.config.ts';
import { classifyDbError } from '../../src/platform/persistence/pg-errors.ts';
import { useTestDatabase } from '../support/test-database.ts';

const database = useTestDatabase('deadlock');
const uuid = () => Bun.randomUUIDv7();
let walletA: string;
let walletB: string;

beforeAll(async () => {
  walletA = uuid();
  walletB = uuid();
  for (const id of [walletA, walletB]) {
    await database.db.query(
      'INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
      [id, `player-${id}`, 'BRL', '0.00', new Date(), new Date()],
    );
  }
});

const LOCK = 'SELECT id FROM wallets WHERE id = ? FOR UPDATE';

describe('entre duas conexões pg', () => {
  test('exatamente uma recebe 40P01, classificado como retry', async () => {
    const first = await database.db.connect();
    const second = await database.db.connect();
    try {
      await first.q.query('BEGIN');
      await second.q.query('BEGIN');
      await first.q.query(LOCK, [walletA]);
      await second.q.query(LOCK, [walletB]);

      // a 1ª passa a esperar antes: será a vítima
      const firstWait = first.q.query(LOCK, [walletB]);
      await Bun.sleep(200);
      const secondWait = second.q.query(LOCK, [walletA]);

      const results = await Promise.allSettled([firstWait, secondWait]);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect((rejected[0]?.reason as { code?: string }).code).toBe('40P01');
      expect(classifyDbError(rejected[0]?.reason)).toBe('retry');
    } finally {
      await first.q.query('ROLLBACK').catch(() => {});
      await second.q.query('ROLLBACK').catch(() => {});
      first.release();
      second.release();
    }
  }, 30_000);
});

describe('pelo EntityManager do MikroORM', () => {
  let orm: MikroORM;
  beforeAll(async () => {
    orm = await MikroORM.init(buildOrmOptions({ databaseUrl: database.url, dbPoolMax: 2, dbPoolAcquireTimeoutMs: 5000 }));
  });
  afterAll(async () => {
    await orm?.close(true);
  });

  test('o 40P01 chega pelo em.execute dentro de transactional e é classificado como retry', async () => {
    const other = await database.db.connect();
    try {
      await other.q.query('BEGIN');
      await other.q.query(LOCK, [walletA]);

      let ormLockedB: () => void = () => {};
      const lockedB = new Promise<void>((resolve) => (ormLockedB = resolve));
      const ormTransaction = orm.em.fork().transactional(async (em) => {
        await em.execute(LOCK, [walletB]);
        ormLockedB();
        // o lado do ORM passa a esperar primeiro: será a vítima
        await em.execute(LOCK, [walletA]);
      });
      const ormSettled = ormTransaction.then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );

      await lockedB;
      await Bun.sleep(200);
      const otherWait = other.q.query(LOCK, [walletB]);

      const ormResult = await ormSettled;
      expect(ormResult.ok).toBe(false);
      if (!ormResult.ok) {
        expect((ormResult.error as { code?: string }).code).toBe('40P01');
        expect(classifyDbError(ormResult.error)).toBe('retry');
      }
      // com o rollback do lado do ORM, a outra conexão obtém o lock
      await otherWait;
    } finally {
      await other.q.query('ROLLBACK').catch(() => {});
      other.release();
    }
  }, 30_000);
});
