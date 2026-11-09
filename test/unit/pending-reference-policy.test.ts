// T007 — PendingReferencePolicy (I-21, I-64, I-72, R-25).
import { describe, expect, test } from 'bun:test';
import { PendingReferencePolicy } from '../../src/wagering/domain/pending-reference-policy.ts';

const DEFAULTS = { maxAttempts: 10, ttlMs: 600_000, baseMs: 5_000, maxMs: 60_000, jitterRatio: 0.2 };
const policy = new PendingReferencePolicy(DEFAULTS);
const createdAt = new Date('2026-11-08T12:00:00.000Z');

describe('delayBefore (backoff exponencial com teto e jitter)', () => {
  test('sem efeito de jitter (random 0,5), as esperas antes das tentativas 2 a 10 são 10, 20, 40, 60 … 60 s', () => {
    const delays = Array.from({ length: 9 }, (_, i) => policy.delayBefore(i + 2, 0.5));
    expect(delays).toEqual([10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000]);
  });

  test('a 10ª tentativa acontece 435 s depois da criação (5 s da 001 + a soma)', () => {
    const firstAttempt = 5_000; // agendada pela 001 em created_at + 5 s
    const total = Array.from({ length: 9 }, (_, i) => policy.delayBefore(i + 2, 0.5)).reduce((a, b) => a + b, firstAttempt);
    expect(total).toBe(435_000);
  });

  test.each([0, 0.999])('com random %p o jitter fica em [1 − r, 1 + r]', (random) => {
    for (let attempt = 2; attempt <= 10; attempt++) {
      const nominal = Math.min(5_000 * 2 ** (attempt - 1), 60_000);
      const delay = policy.delayBefore(attempt, random);
      expect(delay).toBeGreaterThanOrEqual(Math.floor(nominal * 0.8));
      expect(delay).toBeLessThanOrEqual(Math.ceil(nominal * 1.2));
    }
    if (random === 0) expect(policy.delayBefore(2, random)).toBe(8_000);
    else expect(policy.delayBefore(2, random)).toBeGreaterThan(11_900);
  });

  test('jitter 0 dá a espera nominal para qualquer random', () => {
    const noJitter = new PendingReferencePolicy({ ...DEFAULTS, jitterRatio: 0 });
    expect(noJitter.delayBefore(3, 0)).toBe(20_000);
    expect(noJitter.delayBefore(3, 0.999)).toBe(20_000);
  });

  test('tentativa menor que 2 ou random fora de [0, 1) é erro de programação', () => {
    expect(() => policy.delayBefore(1, 0.5)).toThrow();
    expect(() => policy.delayBefore(2, 1)).toThrow();
    expect(() => policy.delayBefore(2, -0.1)).toThrow();
  });

  test('os limites vêm da configuração (FR-032)', () => {
    const short = new PendingReferencePolicy({ maxAttempts: 3, ttlMs: 1_000, baseMs: 100, maxMs: 400, jitterRatio: 0 });
    expect([2, 3, 4, 5].map((n) => short.delayBefore(n, 0.5))).toEqual([200, 400, 400, 400]);
  });
});

describe('isExhausted (I-64)', () => {
  const at = (ms: number) => new Date(createdAt.getTime() + ms);

  test('verdadeiro com 10 tentativas depois desta avaliação; falso antes', () => {
    expect(policy.isExhausted(9, createdAt, at(400_000))).toBe(false);
    expect(policy.isExhausted(10, createdAt, at(435_000))).toBe(true);
    expect(policy.isExhausted(11, createdAt, at(435_000))).toBe(true);
  });

  test('verdadeiro com now − createdAt ≥ 10 min (teto de segurança), mesmo com poucas tentativas', () => {
    expect(policy.isExhausted(3, createdAt, at(599_999))).toBe(false);
    expect(policy.isExhausted(3, createdAt, at(600_000))).toBe(true);
    expect(policy.isExhausted(1, createdAt, at(700_000))).toBe(true);
  });

  test('os limites vêm da configuração', () => {
    const short = new PendingReferencePolicy({ maxAttempts: 3, ttlMs: 1_000, baseMs: 100, maxMs: 400, jitterRatio: 0 });
    expect(short.isExhausted(2, createdAt, at(500))).toBe(false);
    expect(short.isExhausted(3, createdAt, at(500))).toBe(true);
    expect(short.isExhausted(1, createdAt, at(1_000))).toBe(true);
  });

  test('configuração inválida é recusada', () => {
    expect(() => new PendingReferencePolicy({ ...DEFAULTS, maxAttempts: 0 })).toThrow();
    expect(() => new PendingReferencePolicy({ ...DEFAULTS, baseMs: 70_000 })).toThrow();
    expect(() => new PendingReferencePolicy({ ...DEFAULTS, jitterRatio: 0.6 })).toThrow();
  });
});
