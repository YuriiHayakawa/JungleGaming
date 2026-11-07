// S-01 (Nest sem emitDecoratorMetadata, @Inject(TOKEN)) e S-02 (platform-express sob Bun) + ALS e UUIDv7.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { bootstrap, EchoService, SpikeController } from '../src/http-app.ts';

const PORT = 3101;
const base = `http://127.0.0.1:${PORT}`;
let app: INestApplication;

beforeAll(async () => {
  app = await bootstrap({ port: PORT });
});
afterAll(async () => {
  await app.close();
});

test('S-01: sem metadata de tipos emitida; injeção só por @Inject(TOKEN)', () => {
  const designParamtypes = Reflect.getMetadata('design:paramtypes', EchoService);
  const controllerParamtypes = Reflect.getMetadata('design:paramtypes', SpikeController);
  console.log('S-01 design:paramtypes EchoService =', designParamtypes, '| SpikeController =', controllerParamtypes);
  expect(designParamtypes).toBeUndefined();
  expect(controllerParamtypes).toBeUndefined();
});

test('S-01: GET e POST com @Param, @Body e @Headers; provider resolvido por token', async () => {
  const ping = await fetch(`${base}/ping`);
  expect(ping.status).toBe(200);

  const res = await fetch(`${base}/echo/abc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test': 'hdr', 'x-correlation-id': 'corr-123' },
    body: JSON.stringify({ amount: '25.00' }),
  });
  const json = (await res.json()) as Record<string, unknown>;
  console.log('S-01 echo =', JSON.stringify(json));
  expect(res.status).toBe(201);
  expect(json.id).toBe('abc');
  expect(json.body).toEqual({ amount: '25.00' });
  expect(json.header).toBe('hdr');
  expect(json.greeting).toBe('hello abc');
  // extra: AsyncLocalStorage atravessa middleware → controller → service → await
  expect(json.correlationId).toBe('corr-123');
  // extra: Bun.randomUUIDv7 disponível (versão 7)
  expect(String(json.uuidv7)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('S-02: 1000 requisições sequenciais e 50 paralelas sem erro', async () => {
  let errors = 0;
  const t0 = performance.now();
  for (let i = 0; i < 1000; i++) {
    const r = await fetch(`${base}/ping`);
    if (r.status !== 200) errors++;
    await r.arrayBuffer();
  }
  const seqMs = performance.now() - t0;

  const t1 = performance.now();
  const parallel = await Promise.allSettled(
    Array.from({ length: 50 }, (_, i) =>
      fetch(`${base}/echo/p${i}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-correlation-id': `c${i}` },
        body: JSON.stringify({ i }),
      }).then(async (r) => ({ status: r.status, json: (await r.json()) as { correlationId: string } })),
    ),
  );
  const parMs = performance.now() - t1;
  const parallelErrors = parallel.filter((p) => p.status === 'rejected' || p.value.status !== 201).length;
  // cada requisição paralela precisa enxergar o próprio correlationId (sem vazamento entre contextos)
  const leaked = parallel.filter(
    (p, i) => p.status === 'fulfilled' && p.value.json.correlationId !== `c${i}`,
  ).length;
  console.log(
    `S-02 sequencial=1000 erros=${errors} em ${seqMs.toFixed(0)}ms | paralelo=50 erros=${parallelErrors} vazamentos ALS=${leaked} em ${parMs.toFixed(0)}ms`,
  );
  expect(errors).toBe(0);
  expect(parallelErrors).toBe(0);
  expect(leaked).toBe(0);
}, 60_000);
