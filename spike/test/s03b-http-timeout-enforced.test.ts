// S-03 (complemento): o timeout configurado é de fato aplicado? Requisição de 25 s com limite de 20 s.
import { afterAll, test } from 'bun:test';
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

test('S-03b: requisição de 25 s com timeout padrão e com HTTP_SERVER_TIMEOUT_MS=20000', async () => {
  const defaults = await startInstance({ port: 3113 });
  const configured = await startInstance({ port: 3114, env: { HTTP_SERVER_TIMEOUT_MS: '20000' } });
  instances.push(defaults, configured);
  const [d, c] = await Promise.all([
    timedGet('http://127.0.0.1:3113/sleep/25000'),
    timedGet('http://127.0.0.1:3114/sleep/25000'),
  ]);
  console.log('S-03b padrão      =', JSON.stringify(d));
  console.log('S-03b configurado =', JSON.stringify(c));
}, 60_000);
