// T007 — @Public() lido pelo guard global e log de requisição em debug nas rotas operacionais (R-41; FR-018, FR-019).
import { describe, expect, test } from 'bun:test';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY, Public, isPublicRoute } from '../../src/platform/auth/public.decorator.ts';
import { NoopAuthGuard } from '../../src/platform/auth/noop-auth.guard.ts';
import { JsonLogger, requestLoggingMiddleware } from '../../src/platform/logging/json-logger.ts';

@Public()
class PublicController {
  handler(): void {}
}

class MixedController {
  @Public()
  open(): void {}
  closed(): void {}
}

function contextFor(cls: object, handler: (...args: never[]) => unknown): ExecutionContext {
  return { getClass: () => cls, getHandler: () => handler } as unknown as ExecutionContext;
}

describe('@Public()', () => {
  const reflector = new Reflector();

  test('grava o metadado na classe e no método', () => {
    expect(reflector.get(IS_PUBLIC_KEY, PublicController)).toBe(true);
    expect(reflector.get(IS_PUBLIC_KEY, MixedController.prototype.open)).toBe(true);
    expect(reflector.get(IS_PUBLIC_KEY, MixedController.prototype.closed)).toBeUndefined();
  });

  test('isPublicRoute lê o metadado do método ou da classe', () => {
    expect(isPublicRoute(reflector, contextFor(PublicController, PublicController.prototype.handler))).toBe(true);
    expect(isPublicRoute(reflector, contextFor(MixedController, MixedController.prototype.open))).toBe(true);
    expect(isPublicRoute(reflector, contextFor(MixedController, MixedController.prototype.closed))).toBe(false);
  });

  test('o guard global libera rota com @Public() (e, por ser no-op, também as demais)', () => {
    const guard = new NoopAuthGuard(reflector);
    expect(guard.canActivate(contextFor(PublicController, PublicController.prototype.handler))).toBe(true);
    expect(guard.isPublic(contextFor(PublicController, PublicController.prototype.handler))).toBe(true);
    expect(guard.isPublic(contextFor(MixedController, MixedController.prototype.closed))).toBe(false);
    expect(guard.canActivate(contextFor(MixedController, MixedController.prototype.closed))).toBe(true);
  });
});

describe('log de requisição', () => {
  function logRequest(url: string, status = 200): Record<string, unknown> {
    const lines: string[] = [];
    const middleware = requestLoggingMiddleware(new JsonLogger((line) => lines.push(line)));
    let finish: () => void = () => {};
    middleware(
      { method: 'GET', url, originalUrl: url },
      { statusCode: status, on: (_event: 'finish', listener: () => void) => void (finish = listener) },
      () => {},
    );
    finish();
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0]!) as Record<string, unknown>;
  }

  test.each(['/health/live', '/health/ready', '/metrics', '/metrics?x=1', '/health/ready?probe=k8s'])('%s em nível debug', (url) => {
    const line = logRequest(url, url.includes('ready') ? 503 : 200);
    expect(line.level).toBe('debug');
    expect(line.msg).toBe('http.request');
  });

  test.each(['/wallets', '/wallets/abc/reconciliation', '/wagering/transactions', '/healthz', '/metricsx', '/health'])(
    '%s em nível info',
    (url) => {
      expect(logRequest(url).level).toBe('info');
    },
  );
});
