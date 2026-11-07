// S-03: timeout do servidor HTTP sob Bun. Requisição de 14 s com e sem HTTP_SERVER_TIMEOUT_MS=20000.
import { afterAll, expect, test } from 'bun:test';
import { startInstance, type Instance } from './support/instances.ts';

const instances: Instance[] = [];
afterAll(async () => {
  await Promise.all(instances.map((i) => i.stop()));
});

async function timedGet(url: string) {
  const t0 = performance.now();
  try {
    const r = await fetch(url);
    const body = await r.text();
    return { ok: true, status: r.status, body, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { ok: false, error: String(e), ms: Math.round(performance.now() - t0) };
  }
}

test('S-03: requisição de 14 s com timeout padrão e com HTTP_SERVER_TIMEOUT_MS=20000', async () => {
  const defaults = await startInstance({ port: 3111 });
  const configured = await startInstance({ port: 3112, env: { HTTP_SERVER_TIMEOUT_MS: '20000' } });
  instances.push(defaults, configured);

  const [d, c] = await Promise.all([
    timedGet('http://127.0.0.1:3111/sleep/14000'),
    timedGet('http://127.0.0.1:3112/sleep/14000'),
  ]);
  console.log('S-03 padrão      =', JSON.stringify(d));
  console.log('S-03 configurado =', JSON.stringify(c));
  expect(c.ok).toBe(true);
  expect(c.status).toBe(200);
}, 45_000);
