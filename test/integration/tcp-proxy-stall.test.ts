// T003 — autoteste do modo "pendurado" do proxy TCP de teste (test/support/tcp-proxy.ts; R-45), contra o PostgreSQL
// real: com `stall()`, uma consulta não termina (nem por conexão nova nem pela já aberta); com `restore()`, as conexões
// penduradas caem e uma conexão nova volta a funcionar.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Client } from 'pg';
import { startTcpProxy, type TcpProxy } from '../support/tcp-proxy.ts';
import { useTestDatabase } from '../support/test-database.ts';

const database = useTestDatabase('tcp_proxy_stall');
let proxy: TcpProxy;

beforeAll(async () => {
  proxy = await startTcpProxy(database.url);
});
afterAll(() => {
  proxy?.close();
});

const settleWithin = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([promise.then(() => 'settled' as const, () => 'settled' as const), Bun.sleep(ms).then(() => 'pending' as const)]);

test('stall pendura conexões novas e abertas; restore as derruba e o proxy volta a repassar', async () => {
  const open = new Client({ connectionString: proxy.url });
  await open.connect();
  open.on('error', () => {});
  expect((await open.query('SELECT 1 AS one')).rows).toEqual([{ one: 1 }]);

  proxy.stall();
  const fresh = new Client({ connectionString: proxy.url });
  fresh.on('error', () => {});
  const connecting = fresh.connect();
  const querying = open.query('SELECT 2 AS two');
  expect(await settleWithin(connecting, 700)).toBe('pending');
  expect(await settleWithin(querying, 100)).toBe('pending');
  expect(proxy.openConnections).toBe(2);

  proxy.restore();
  // As conexões penduradas caem (o cliente vê erro), nada fica preso.
  expect(await settleWithin(connecting, 2_000)).toBe('settled');
  expect(await settleWithin(querying, 2_000)).toBe('settled');
  await expect(querying).rejects.toThrow();
  await open.end().catch(() => {});
  await fresh.end().catch(() => {});

  const again = new Client({ connectionString: proxy.url });
  await again.connect();
  expect((await again.query('SELECT 3 AS three')).rows).toEqual([{ three: 3 }]);
  await again.end();
});
