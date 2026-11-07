// S-04, S-05, S-06, S-07, S-09 contra o PostgreSQL 17 do docker-compose do spike (porta 55432).
// Pré-requisito: `bun src/migrate.ts up`.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { IsolationLevel, LockMode, type MikroORM } from '@mikro-orm/postgresql';
import { Client } from 'pg';
import { DATABASE_URL, initOrm, WalletRecord } from '../src/orm.ts';

let orm: MikroORM;

beforeAll(async () => {
  orm = await initOrm({ poolMax: 10, acquireTimeoutMs: 8000 });
});
afterAll(async () => {
  await orm.close(true);
});

function describeError(e: unknown) {
  const err = e as Record<string, unknown> & { cause?: Record<string, unknown> };
  return {
    class: (e as Error)?.constructor?.name,
    message: String((e as Error)?.message).slice(0, 160),
    code: err.code,
    sqlState: err.sqlState,
    constraint: err.constraint,
    causeClass: (err.cause as unknown as Error)?.constructor?.name,
    causeCode: err.cause?.code,
    causeConstraint: err.cause?.constraint,
  };
}

async function newWallet(balance = '1000.00'): Promise<string> {
  const id = Bun.randomUUIDv7();
  const em = orm.em.fork();
  await em.insert(WalletRecord, { id, playerId: `p-${id}`, currency: 'BRL', balance, version: 1 });
  return id;
}

test('S-04: MikroORM 7 + EntitySchema + driver PostgreSQL; fork com identity map isolado', async () => {
  const id = Bun.randomUUIDv7();
  const em1 = orm.em.fork();
  const w = em1.create(WalletRecord, { id, playerId: `p-${id}`, currency: 'BRL', balance: '1000.00', version: 1 });
  await em1.persist(w).flush();

  const em2 = orm.em.fork();
  const loaded = await em2.findOneOrFail(WalletRecord, id);
  console.log('S-04 loaded =', JSON.stringify(loaded), '| instância diferente entre forks =', loaded !== w);
  expect(loaded).not.toBe(w);
  expect(loaded).toBeInstanceOf(WalletRecord);
  expect(loaded.balance).toBe('1000.00');
});

test('S-05: NUMERIC(18,2) e BIGINT chegam como string (raw, entidade e coluna identity)', async () => {
  const em = orm.em.fork();
  const [row] = await em.execute<{ n: unknown; m: unknown; b: unknown }[]>(
    `select 1000.00::numeric(18,2) as n, 9999999999999999.99::numeric(18,2) as m, 9223372036854775807::bigint as b`,
  );
  const id = await newWallet('9999999999999999.99');
  const wallet = await orm.em.fork().findOneOrFail(WalletRecord, id);
  const [ledger] = await em.execute<{ seq: unknown; amount: unknown }[]>(
    `insert into spike_ledger (id, wallet_id, amount) values (?, ?, ?) returning seq, amount`,
    [Bun.randomUUIDv7(), id, '0.10'],
  );
  const report = {
    raw: { n: row?.n, nType: typeof row?.n, m: row?.m, b: row?.b, bType: typeof row?.b },
    entity: { balance: wallet.balance, type: typeof wallet.balance },
    identity: { seq: ledger?.seq, seqType: typeof ledger?.seq, amount: ledger?.amount, amountType: typeof ledger?.amount },
  };
  console.log('S-05 =', JSON.stringify(report));
  expect(row?.n).toBe('1000.00');
  expect(row?.m).toBe('9999999999999999.99');
  expect(row?.b).toBe('9223372036854775807');
  expect(wallet.balance).toBe('9999999999999999.99');
  expect(typeof ledger?.seq).toBe('string');
  expect(ledger?.amount).toBe('0.10');
});

test('S-06: transactional + PESSIMISTIC_WRITE serializa a mesma wallet (FOR UPDATE real)', async () => {
  const id = await newWallet();
  const order: string[] = [];
  const external = new Client({ connectionString: DATABASE_URL });
  await external.connect();
  let nowaitError: unknown;

  const t1 = orm.em.fork().transactional(
    async (em) => {
      await em.execute(`set local lock_timeout = '5000ms'`);
      await em.findOneOrFail(WalletRecord, id, { lockMode: LockMode.PESSIMISTIC_WRITE });
      order.push('t1-locked');
      // enquanto t1 segura, uma conexão externa com NOWAIT precisa falhar: prova que é FOR UPDATE de verdade
      try {
        await external.query('select id from spike_wallets where id = $1 for update nowait', [id]);
      } catch (e) {
        nowaitError = e;
      }
      await Bun.sleep(300);
      const affected = await em.nativeUpdate(WalletRecord, { id, version: 1 }, { balance: '900.00', version: 2 });
      order.push(`t1-updated:${affected}`);
    },
    { isolationLevel: IsolationLevel.READ_COMMITTED },
  );
  await Bun.sleep(50);
  const t2 = orm.em.fork().transactional(
    async (em) => {
      await em.execute(`set local lock_timeout = '5000ms'`);
      const w = await em.findOneOrFail(WalletRecord, id, { lockMode: LockMode.PESSIMISTIC_WRITE });
      order.push(`t2-locked:balance=${w.balance}:version=${w.version}`);
      const stale = await em.nativeUpdate(WalletRecord, { id, version: 1 }, { balance: '1.00', version: 2 });
      order.push(`t2-stale-update:${stale}`);
    },
    { isolationLevel: IsolationLevel.READ_COMMITTED },
  );
  await Promise.all([t1, t2]);
  await external.end();

  console.log('S-06 ordem =', JSON.stringify(order), '| NOWAIT externo =', JSON.stringify(describeError(nowaitError)));
  expect(order).toEqual([
    't1-locked',
    't1-updated:1',
    't2-locked:balance=900.00:version=2', // READ COMMITTED: depois do lock enxerga o commit de t1
    't2-stale-update:0', // asserção de versão: WHERE version = esperada não afeta linha
  ]);
  expect((nowaitError as { code?: string }).code).toBe('55P03');
});

test('S-06: lock segurado por fora + lock_timeout=500ms → 55P03 acessível no erro', async () => {
  const id = await newWallet();
  const holder = new Client({ connectionString: DATABASE_URL });
  await holder.connect();
  await holder.query('begin');
  await holder.query('select id from spike_wallets where id = $1 for update', [id]);

  const t0 = performance.now();
  let error: unknown;
  try {
    await orm.em.fork().transactional(async (em) => {
      await em.execute(`set local lock_timeout = '500ms'`);
      await em.findOneOrFail(WalletRecord, id, { lockMode: LockMode.PESSIMISTIC_WRITE });
    });
  } catch (e) {
    error = e;
  }
  const ms = Math.round(performance.now() - t0);
  await holder.query('rollback');
  await holder.end();

  const info = describeError(error);
  console.log(`S-06 lock_timeout após ${ms}ms =`, JSON.stringify(info));
  expect(info.code === '55P03' || info.sqlState === '55P03' || info.causeCode === '55P03').toBe(true);
  expect(ms).toBeGreaterThanOrEqual(450);
  expect(ms).toBeLessThan(2000);
});

test('S-07: violação 23505 expõe o nome da constraint (unique, índice parcial, entidade)', async () => {
  const em = orm.em.fork();
  const key = `k-${Bun.randomUUIDv7()}`;
  await em.execute(`insert into spike_tx (id, idempotency_key, kind, status) values (?, ?, 'BET', 'PROCESSED')`, [
    Bun.randomUUIDv7(),
    key,
  ]);
  let dupKey: unknown;
  try {
    await em.execute(`insert into spike_tx (id, idempotency_key, kind, status) values (?, ?, 'BET', 'PROCESSED')`, [
      Bun.randomUUIDv7(),
      key,
    ]);
  } catch (e) {
    dupKey = e;
  }

  const ref = Bun.randomUUIDv7();
  await em.execute(
    `insert into spike_tx (id, idempotency_key, kind, status, reference_transaction_id) values (?, ?, 'REFUND', 'PROCESSED', ?)`,
    [Bun.randomUUIDv7(), `k-${Bun.randomUUIDv7()}`, ref],
  );
  let dupReversal: unknown;
  try {
    await em.execute(
      `insert into spike_tx (id, idempotency_key, kind, status, reference_transaction_id) values (?, ?, 'ROLLBACK', 'PROCESSED', ?)`,
      [Bun.randomUUIDv7(), `k-${Bun.randomUUIDv7()}`, ref],
    );
  } catch (e) {
    dupReversal = e;
  }

  const id = await newWallet();
  const existing = await orm.em.fork().findOneOrFail(WalletRecord, id);
  let dupWallet: unknown;
  try {
    await orm.em.fork().insert(WalletRecord, {
      id: Bun.randomUUIDv7(),
      playerId: existing.playerId,
      currency: 'BRL',
      balance: '0.00',
      version: 1,
    });
  } catch (e) {
    dupWallet = e;
  }

  const report = {
    idempotency: describeError(dupKey),
    partialIndex: describeError(dupReversal),
    entityInsert: describeError(dupWallet),
  };
  console.log('S-07 =', JSON.stringify(report, null, 1));
  const name = (i: ReturnType<typeof describeError>) => i.constraint ?? i.causeConstraint;
  expect(name(report.idempotency)).toBe('spike_tx_idempotency_key_uq');
  expect(name(report.partialIndex)).toBe('spike_tx_single_reversal_uq');
  expect(name(report.entityInsert)).toBe('spike_wallets_player_currency_uq');
});

test('S-08: trigger do ledger bloqueia UPDATE, DELETE e TRUNCATE (P0001)', async () => {
  const em = orm.em.fork();
  const errors: Record<string, unknown> = {};
  for (const sql of [
    `update spike_ledger set amount = amount + 1`,
    `delete from spike_ledger`,
    `truncate spike_ledger`,
  ]) {
    try {
      await em.execute(sql);
      errors[sql] = 'NO ERROR';
    } catch (e) {
      errors[sql] = describeError(e);
    }
  }
  console.log('S-08 guardas =', JSON.stringify(errors, null, 1));
  for (const v of Object.values(errors)) {
    const info = v as ReturnType<typeof describeError>;
    expect(info.code === 'P0001' || info.causeCode === 'P0001').toBe(true);
  }
});

test('S-09: pool max=2 e timeout de aquisição 1000ms → 3ª requisição falha com erro identificável', async () => {
  const small = await initOrm({ poolMax: 2, acquireTimeoutMs: 1000 });
  try {
    const holders = [1, 2].map(() =>
      small.em.fork().transactional(async (em) => {
        await em.execute('select pg_sleep(3)');
      }),
    );
    await Bun.sleep(200);
    const t0 = performance.now();
    let error: unknown;
    try {
      await small.em.fork().execute('select 1');
    } catch (e) {
      error = e;
    }
    const ms = Math.round(performance.now() - t0);
    await Promise.all(holders);
    const info = describeError(error);
    console.log(`S-09 3ª requisição falhou após ${ms}ms =`, JSON.stringify(info));
    expect(error).toBeDefined();
    expect(ms).toBeGreaterThanOrEqual(900);
    expect(ms).toBeLessThan(2500);
  } finally {
    await small.close(true);
  }
}, 20_000);
