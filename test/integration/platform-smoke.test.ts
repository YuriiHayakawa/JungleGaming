// T047 — a app sobe contra o banco do arquivo, propaga o correlationId e recusa boot com hierarquia inválida
// (FR-059, FR-060, I-51, I-53).
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/platform/persistence/unit-of-work.ts';
import { startApp, type RunningApp } from '../support/app-harness.ts';
import { useTestDatabase } from '../support/test-database.ts';

const database = useTestDatabase('platform_smoke');
const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let running: RunningApp;

beforeAll(async () => {
  running = await startApp({ databaseUrl: database.url });
});
afterAll(async () => {
  await running?.close();
});

test('sobe e escreve a linha de log http.listening', () => {
  const listening = running.logs.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.event === 'http.listening');
  expect(listening).toBeDefined();
  expect(typeof listening?.port).toBe('number');
});

test('X-Correlation-Id válido volta igual; ausente ou inválido vira UUIDv7, nunca 400 por causa dele (I-53)', async () => {
  const echoed = await fetch(`${running.baseUrl}/__nonexistent`, { headers: { 'X-Correlation-Id': 'abc-123' } });
  expect(echoed.headers.get('x-correlation-id')).toBe('abc-123');
  const body = (await echoed.json()) as { error: { correlationId: string } };
  expect(body.error.correlationId).toBe('abc-123');

  const generated = await fetch(`${running.baseUrl}/__nonexistent`);
  expect(generated.headers.get('x-correlation-id')).toMatch(UUIDV7);

  const invalid = await fetch(`${running.baseUrl}/__nonexistent`, { headers: { 'X-Correlation-Id': 'x'.repeat(129) } });
  expect(invalid.headers.get('x-correlation-id')).toMatch(UUIDV7);
});

test('erro no envelope único (I-38), com uma linha de log por requisição', async () => {
  const before = running.logs.length;
  const response = await fetch(`${running.baseUrl}/__nonexistent`, { headers: { 'X-Correlation-Id': 'log-check' } });
  const body = (await response.json()) as { error: Record<string, unknown> };
  expect(body.error).toMatchObject({ retryable: false, correlationId: 'log-check' });
  expect(typeof body.error.code).toBe('string');
  expect(typeof body.error.message).toBe('string');
  await Bun.sleep(20);
  const requestLines = running.logs
    .slice(before)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((l) => l.msg === 'http.request');
  expect(requestLines).toHaveLength(1);
  expect(requestLines[0]).toMatchObject({ correlationId: 'log-check', method: 'GET', status: response.status });
});

test('a unit of work da app roda numa transação real READ COMMITTED com o lock_timeout do config (I-51, R-19)', async () => {
  const uow = running.app.get<UnitOfWork<{ execute(sql: string): Promise<unknown> }>>(UNIT_OF_WORK);
  const settings = await uow.run(async (em) => {
    const rows = (await em.execute(
      "SELECT current_setting('lock_timeout') AS lock_timeout, current_setting('transaction_isolation') AS isolation",
    )) as { lock_timeout: string; isolation: string }[];
    return rows[0];
  });
  expect(settings).toEqual({ lock_timeout: '5s', isolation: 'read committed' });
});

test('com HTTP_SERVER_TIMEOUT_MS abaixo da hierarquia, o processo encerra com código ≠ 0 antes de escutar', async () => {
  const proc = Bun.spawn(['bun', join(import.meta.dir, '..', '..', 'src', 'main.ts')], {
    env: { ...process.env, DATABASE_URL: database.url, PORT: '0', HTTP_SERVER_TIMEOUT_MS: '1000' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect(code).not.toBe(0);
  expect(stdout).not.toContain('http.listening');
  expect(stderr).toContain('config.invalid');
  expect(stderr).toContain('HTTP_SERVER_TIMEOUT_MS');
}, 30_000);
