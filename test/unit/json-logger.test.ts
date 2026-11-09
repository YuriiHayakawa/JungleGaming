// T013 — logger JSON (FR-058, constitution VIII).
import { expect, test } from 'bun:test';
import { JsonLogger } from '../../src/platform/logging/json-logger.ts';
import { runWithRequestContext, setRequestContextValues } from '../../src/platform/correlation/request-context.ts';

function capture() {
  const lines: string[] = [];
  const logger = new JsonLogger((line) => lines.push(line));
  return { lines, logger, parsed: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

test('cada linha é JSON com level, msg e time', () => {
  const { logger, parsed } = capture();
  logger.info('hello');
  const [line] = parsed();
  expect(line?.level).toBe('info');
  expect(line?.msg).toBe('hello');
  expect(typeof line?.time).toBe('string');
  expect(Number.isNaN(Date.parse(String(line?.time)))).toBe(false);
});

test('inclui correlationId, transactionId, walletId e providerId do contexto quando presentes', () => {
  const { logger, parsed } = capture();
  runWithRequestContext({ correlationId: 'corr-1' }, () => {
    logger.info('antes');
    setRequestContextValues({ walletId: 'w-1', providerId: 'p-1' });
    logger.info('depois de validar');
    setRequestContextValues({ transactionId: 't-1' });
    logger.info('com transação');
  });
  const [a, b, c] = parsed();
  expect(a).toMatchObject({ correlationId: 'corr-1' });
  expect('walletId' in (a ?? {})).toBe(false);
  expect(b).toMatchObject({ correlationId: 'corr-1', walletId: 'w-1', providerId: 'p-1' });
  expect(c).toMatchObject({ correlationId: 'corr-1', walletId: 'w-1', providerId: 'p-1', transactionId: 't-1' });
});

test('fora de requisição não há campos de contexto', () => {
  const { logger, parsed } = capture();
  logger.info('boot');
  expect('correlationId' in (parsed()[0] ?? {})).toBe(false);
});

test('valores monetários em campos extras são removidos, em qualquer profundidade', () => {
  const { logger, lines } = capture();
  logger.info('submit', {
    amount: '25.00',
    money: { amount: '25.00', currency: 'BRL' },
    balance: '975.00',
    nested: { balanceBefore: '1.00', balanceAfter: '0.00', initialBalance: { amount: '9.99' }, kind: 'BET' },
    status: 201,
  });
  const raw = lines[0] ?? '';
  expect(raw).not.toContain('25.00');
  expect(raw).not.toContain('975.00');
  expect(raw).not.toContain('"amount"');
  expect(raw).not.toContain('"money"');
  expect(raw).not.toContain('balance');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  expect(parsed.status).toBe(201);
  expect(parsed.nested).toEqual({ kind: 'BET' });
});

test('níveis error, warn e debug e a interface LoggerService do Nest', () => {
  const { logger, parsed } = capture();
  logger.error('boom', { code: 'X' });
  logger.warn('cuidado');
  logger.log('via Nest', 'SomeContext');
  const [e, w, l] = parsed();
  expect(e).toMatchObject({ level: 'error', msg: 'boom', code: 'X' });
  expect(w).toMatchObject({ level: 'warn', msg: 'cuidado' });
  expect(l).toMatchObject({ level: 'info', msg: 'via Nest', context: 'SomeContext' });
});

// ---- feature 002 (T037; FR-037, I-69)

test('na fila, inclui messageId e causationId do contexto; correlationId = messageId', () => {
  const { logger, parsed } = capture();
  runWithRequestContext({ correlationId: 'msg-1', messageId: 'msg-1', causationId: 'msg-1' }, () => {
    setRequestContextValues({ walletId: 'w-1', providerId: 'p-1', transactionId: 't-1' });
    logger.info('consumer.message', { outcome: 'processed', money: { amount: '25.00', currency: 'BRL' } });
  });
  const [line] = parsed();
  expect(line).toMatchObject({
    correlationId: 'msg-1',
    messageId: 'msg-1',
    causationId: 'msg-1',
    walletId: 'w-1',
    providerId: 'p-1',
    transactionId: 't-1',
    outcome: 'processed',
  });
  expect(line).not.toHaveProperty('money');
  expect(JSON.stringify(line)).not.toContain('25.00');
});

test('no HTTP, sem messageId nem causationId', () => {
  const { logger, parsed } = capture();
  runWithRequestContext({ correlationId: 'corr-1' }, () => logger.info('http'));
  const [line] = parsed();
  expect(line).not.toHaveProperty('messageId');
  expect(line).not.toHaveProperty('causationId');
});
