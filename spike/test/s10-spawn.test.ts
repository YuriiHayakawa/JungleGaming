// S-10: bun test sobe 3 processos da app com Bun.spawn, espera prontidão e encerra sem órfãos.
import { expect, test } from 'bun:test';
import { isAlive, startInstance, type Instance } from './support/instances.ts';

test('S-10: 3 instâncias em portas distintas, round-robin e encerramento sem órfãos', async () => {
  const t0 = performance.now();
  const cluster: Instance[] = await Promise.all([3201, 3202, 3203].map((port) => startInstance({ port })));
  const bootMs = Math.round(performance.now() - t0);
  try {
    const pids = new Set<number>();
    for (let i = 0; i < 30; i++) {
      const inst = cluster[i % 3]!;
      const r = await fetch(`http://127.0.0.1:${inst.port}/ping`);
      const json = (await r.json()) as { pid: number };
      pids.add(json.pid);
    }
    console.log(`S-10 boot das 3 instâncias em ${bootMs}ms; pids distintos atendendo = ${pids.size}`);
    expect(pids.size).toBe(3);
  } finally {
    const codes = await Promise.all(cluster.map((i) => i.stop()));
    const alive = cluster.filter((i) => isAlive(i.pid)).length;
    console.log(`S-10 exit codes = ${JSON.stringify(codes)}; processos vivos após stop = ${alive}`);
    expect(alive).toBe(0);
  }
}, 60_000);

test('S-10: instância que falha antes de ficar pronta é limpa e o erro propaga', async () => {
  let error: unknown;
  try {
    await startInstance({ port: 3204, entry: 'does-not-exist.ts', readyTimeoutMs: 5_000 });
  } catch (e) {
    error = e;
  }
  console.log('S-10 falha de boot =', String(error));
  expect(error).toBeInstanceOf(Error);
}, 20_000);
