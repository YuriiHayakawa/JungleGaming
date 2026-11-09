// T016 — filtro global de exceções (I-38, I-39, FR-055, FR-056, FR-058).
import { describe, expect, test } from 'bun:test';
import {
  BadRequestException,
  MethodNotAllowedException,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
  type ArgumentsHost,
} from '@nestjs/common';
import { DriverException } from '@mikro-orm/core';
import { GlobalExceptionFilter, toHttpError } from '../../src/platform/http/global-exception.filter.ts';
import { FailedTransactionReplayError } from '../../src/shared-kernel/application/errors.ts';
import { httpStatusFor } from '../../src/wagering/application/transaction-result.ts';
import { WagerTransactionStatus } from '../../src/wagering/domain/wager-transaction.ts';
import { FailureCode } from '../../src/wagering/domain/failure-code.ts';
import {
  IdempotencyConflictError,
  IdempotencyKeyRequiredError,
  InternalError,
  OpeningNotAllowedError,
  ServiceUnavailableError,
  TransactionNotFoundError,
  ValidationError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../src/shared-kernel/application/errors.ts';
import { JsonLogger } from '../../src/platform/logging/json-logger.ts';
import { runWithRequestContext } from '../../src/platform/correlation/request-context.ts';

const ctx = { correlationId: 'corr-1', retryAfterSeconds: 3 };

describe('toHttpError: status, código e retryable (I-39, taxonomia §7)', () => {
  test.each([
    [new ValidationError('bad', { issues: [] }), 400, 'VALIDATION_ERROR', false],
    [new OpeningNotAllowedError(), 400, 'OPENING_NOT_ALLOWED', false],
    [new IdempotencyKeyRequiredError(), 400, 'IDEMPOTENCY_KEY_REQUIRED', false],
    [new WalletNotFoundError(), 404, 'WALLET_NOT_FOUND', false],
    [new TransactionNotFoundError(), 404, 'TRANSACTION_NOT_FOUND', false],
    [new IdempotencyConflictError(), 409, 'IDEMPOTENCY_CONFLICT', false],
    [new WalletAlreadyExistsError('0192f291-27dd-7d3f-8071-5f8685deef37'), 409, 'WALLET_ALREADY_EXISTS', false],
    [new ServiceUnavailableError(), 503, 'SERVICE_UNAVAILABLE', true],
    [new InternalError(), 500, 'INTERNAL_ERROR', true],
  ] as const)('%p → %d %s', (error, status, code, retryable) => {
    const out = toHttpError(error, ctx);
    expect(out.status).toBe(status);
    expect(out.body).toEqual({
      error: expect.objectContaining({ code, retryable, correlationId: 'corr-1', message: expect.any(String) }),
    });
  });

  test('WALLET_ALREADY_EXISTS traz só details.walletId (I-52)', () => {
    const out = toHttpError(new WalletAlreadyExistsError('0192f291-27dd-7d3f-8071-5f8685deef37'), ctx);
    expect(out.body.error.details).toEqual({ walletId: '0192f291-27dd-7d3f-8071-5f8685deef37' });
  });

  test('503 leva o header Retry-After = RETRY_AFTER_SECONDS; os outros não', () => {
    expect(toHttpError(new ServiceUnavailableError(), ctx).headers).toEqual({ 'Retry-After': '3' });
    expect(toHttpError(new ValidationError('x'), ctx).headers).toEqual({});
  });

  test('erro de banco transitório vira 503; quebra de invariante vira 500', () => {
    const transient = new DriverException(Object.assign(new Error('lock'), { code: '55P03' }));
    const invariant = new DriverException(Object.assign(new Error('check'), { code: '23514' }));
    expect(toHttpError(transient, ctx).status).toBe(503);
    expect(toHttpError(transient, ctx).body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(toHttpError(invariant, ctx).status).toBe(500);
    expect(toHttpError(invariant, ctx).body.error.code).toBe('INTERNAL_ERROR');
  });

  test('erro desconhecido → 500 INTERNAL_ERROR com retryable true', () => {
    const out = toHttpError(new TypeError('boom'), ctx);
    expect(out.status).toBe(500);
    expect(out.body.error).toMatchObject({ code: 'INTERNAL_ERROR', retryable: true });
  });

  test('BadRequestException do Nest (ex.: corpo malformado) → 400 VALIDATION_ERROR', () => {
    const out = toHttpError(new BadRequestException('Unexpected token'), ctx);
    expect(out.status).toBe(400);
    expect(out.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('a mensagem nunca contém o payload', () => {
    const payloadError = new ValidationError('amount must be a decimal string', {
      issues: [{ path: 'money.amount', message: 'invalid' }],
    });
    const out = toHttpError(payloadError, ctx);
    expect(JSON.stringify(out.body)).not.toContain('25.001');
    const internal = toHttpError(new Error('failed for amount 25.00 and balance 975.00'), ctx);
    expect(internal.body.error.message).not.toContain('25.00');
  });

  test('rota ou método inexistente do Nest → 404 ROUTE_NOT_FOUND, retryable false, no envelope (I-59)', () => {
    for (const exception of [new NotFoundException('Cannot GET /x'), new MethodNotAllowedException()]) {
      const out = toHttpError(exception, { ...ctx });
      expect(out.status).toBe(404);
      expect(out.headers).toEqual({});
      expect(out.unexpected).toBe(false);
      expect(out.body).toEqual({
        error: { code: 'ROUTE_NOT_FOUND', message: expect.any(String), retryable: false, correlationId: 'corr-1' },
      });
      // a mensagem não ecoa o caminho pedido
      expect(out.body.error.message).not.toContain('/x');
    }
  });

  test('Content-Type não suportado e corpo acima do limite → 400 VALIDATION_ERROR, sem ecoar o corpo (I-59)', () => {
    for (const exception of [
      new UnsupportedMediaTypeException('text/plain'),
      new PayloadTooLargeException('request entity too large: {"amount":"25.00"}'),
    ]) {
      const out = toHttpError(exception, ctx);
      expect(out.status).toBe(400);
      expect(out.body.error).toMatchObject({ code: 'VALIDATION_ERROR', retryable: false });
      expect(out.body.error.message).not.toContain('25.00');
      expect(out.body.error.message).not.toContain('text/plain');
    }
  });

  test('erro do body-parser (JSON malformado, 413, 415) chega como objeto com status e vira 400 (I-59)', () => {
    for (const status of [400, 413, 415]) {
      const parserError = Object.assign(new SyntaxError('Unexpected token } in JSON'), { status, type: 'entity.parse.failed' });
      const out = toHttpError(parserError, ctx);
      expect(out.status).toBe(400);
      expect(out.body.error.code).toBe('VALIDATION_ERROR');
      expect(out.body.error.message).not.toContain('Unexpected token');
    }
  });
});

describe('GlobalExceptionFilter: escreve status, headers e corpo na resposta', () => {
  test('usa o correlationId do contexto da requisição', () => {
    const written: { status?: number; headers: Record<string, string>; body?: unknown } = { headers: {} };
    const response = {
      status(code: number) {
        written.status = code;
        return this;
      },
      setHeader(name: string, value: string) {
        written.headers[name] = value;
      },
      json(body: unknown) {
        written.body = body;
      },
    };
    const host = {
      switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({}) }),
    } as unknown as ArgumentsHost;
    const filter = new GlobalExceptionFilter({ retryAfterSeconds: 2 }, new JsonLogger(() => {}));
    runWithRequestContext({ correlationId: 'from-context' }, () => filter.catch(new ServiceUnavailableError(), host));
    expect(written.status).toBe(503);
    expect(written.headers['Retry-After']).toBe('2');
    expect(written.body).toMatchObject({ error: { code: 'SERVICE_UNAVAILABLE', correlationId: 'from-context' } });
  });
});

// ---- feature 002 (T056; FR-030; I-62)

describe('replay de transação FAILED', () => {
  const failedCtx = { correlationId: 'corr-failed', retryAfterSeconds: 1 };

  test('FailedTransactionReplayError → 500 INTERNAL_ERROR com retryable false, no envelope do I-38', () => {
    const out = toHttpError(new FailedTransactionReplayError(), failedCtx);
    expect(out.status).toBe(500);
    expect(out.headers).toEqual({});
    expect(out.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Unexpected error', retryable: false, correlationId: 'corr-failed' },
    });
  });

  test('o 500 de erro inesperado continua retryable true (I-49)', () => {
    expect(toHttpError(new InternalError(), failedCtx).body.error.retryable).toBe(true);
  });

  test('httpStatusFor de um resultado FAILED lança FailedTransactionReplayError', () => {
    expect(() =>
      httpStatusFor({
        transactionId: 't',
        status: WagerTransactionStatus.Failed,
        idempotentReplay: true,
        failureCode: FailureCode.InternalError,
        retryable: false,
      }),
    ).toThrow(FailedTransactionReplayError);
  });
});
