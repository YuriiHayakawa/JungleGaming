import { HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { ApplicationError, type ErrorCode } from '../../shared-kernel/application/errors.ts';
import { DomainError } from '../../shared-kernel/domain/errors.ts';
import { currentRequestContext } from '../correlation/request-context.ts';
import type { JsonLogger } from '../logging/json-logger.ts';
import { classifyDbError } from '../persistence/pg-errors.ts';

/**
 * Códigos que o filtro pode responder: os erros de aplicação mais ROUTE_NOT_FOUND, que é só de resposta HTTP e
 * nasce aqui, a partir do 404/405 do próprio Nest (I-59). Nunca é failureCode persistido.
 */
export type HttpErrorCode = ErrorCode | 'ROUTE_NOT_FOUND';

const STATUS_BY_CODE: Record<HttpErrorCode, number> = {
  VALIDATION_ERROR: 400,
  OPENING_NOT_ALLOWED: 400,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  WALLET_NOT_FOUND: 404,
  TRANSACTION_NOT_FOUND: 404,
  ROUTE_NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  WALLET_ALREADY_EXISTS: 409,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

/** Retryable por código, igual à taxonomia de docs/interpretacoes.md §7. */
const RETRYABLE_BY_CODE: Record<HttpErrorCode, boolean> = {
  VALIDATION_ERROR: false,
  OPENING_NOT_ALLOWED: false,
  IDEMPOTENCY_KEY_REQUIRED: false,
  WALLET_NOT_FOUND: false,
  TRANSACTION_NOT_FOUND: false,
  ROUTE_NOT_FOUND: false,
  IDEMPOTENCY_CONFLICT: false,
  WALLET_ALREADY_EXISTS: false,
  SERVICE_UNAVAILABLE: true,
  INTERNAL_ERROR: true,
};

/** Mensagens fixas por código: nunca ecoam o payload nem detalhes internos (FR-058). */
const SAFE_MESSAGE: Partial<Record<HttpErrorCode, string>> = {
  VALIDATION_ERROR: 'Request payload is invalid',
  ROUTE_NOT_FOUND: 'Route or HTTP method not found',
  SERVICE_UNAVAILABLE: 'Service temporarily unavailable, retry later',
  INTERNAL_ERROR: 'Unexpected error',
};

/** Status do Nest/body-parser que significam requisição malformada: JSON inválido, corpo grande demais, Content-Type (I-59). */
const MALFORMED_REQUEST_STATUSES = new Set([400, 413, 415]);
/** Rota inexistente (404) ou método inexistente (405) (I-59). */
const ROUTE_NOT_FOUND_STATUSES = new Set([404, 405]);

/** Erros do body-parser chegam como Error comum com `status`/`statusCode` e `type` (ex.: entity.parse.failed). */
function bodyParserStatus(exception: unknown): number | undefined {
  if (!(exception instanceof Error)) return undefined;
  const { status, statusCode, type } = exception as Error & { status?: unknown; statusCode?: unknown; type?: unknown };
  const fromBodyParser =
    typeof type === 'string' &&
    (type.startsWith('entity.') || type === 'charset.unsupported' || type === 'encoding.unsupported');
  if (!fromBodyParser) return undefined;
  if (typeof status === 'number') return status;
  return typeof statusCode === 'number' ? statusCode : undefined;
}

export interface ErrorEnvelope {
  error: {
    code: HttpErrorCode;
    message: string;
    retryable: boolean;
    correlationId: string;
    details?: Record<string, unknown>;
  };
}

export interface HttpErrorResult {
  status: number;
  headers: Record<string, string>;
  body: ErrorEnvelope;
  /** true quando o erro indica quebra de invariante ou falha inesperada (vai para o log como error). */
  unexpected: boolean;
}

function codeFor(exception: unknown): { code: HttpErrorCode; details?: Record<string, unknown>; unexpected: boolean } {
  if (exception instanceof ApplicationError) {
    return { code: exception.code, details: exception.details, unexpected: exception.code === 'INTERNAL_ERROR' };
  }
  if (exception instanceof HttpException) {
    // Erros do próprio Nest: rota ou método inexistente → 404 ROUTE_NOT_FOUND; corpo malformado, grande demais ou
    // Content-Type não suportado → 400 VALIDATION_ERROR (I-59).
    const status = exception.getStatus();
    if (ROUTE_NOT_FOUND_STATUSES.has(status)) return { code: 'ROUTE_NOT_FOUND', unexpected: false };
    if (MALFORMED_REQUEST_STATUSES.has(status)) return { code: 'VALIDATION_ERROR', unexpected: false };
    return { code: 'INTERNAL_ERROR', unexpected: true };
  }
  const parserStatus = bodyParserStatus(exception);
  if (parserStatus !== undefined && MALFORMED_REQUEST_STATUSES.has(parserStatus)) {
    return { code: 'VALIDATION_ERROR', unexpected: false };
  }
  if (exception instanceof DomainError) {
    // Um erro de domínio que chegou até aqui escapou da tradução do use case: falha de programação.
    return { code: 'INTERNAL_ERROR', unexpected: true };
  }
  const kind = classifyDbError(exception);
  if (kind === 'transient' || kind === 'retry') return { code: 'SERVICE_UNAVAILABLE', unexpected: false };
  return { code: 'INTERNAL_ERROR', unexpected: true };
}

/** Converte qualquer exceção no envelope único (I-38), com o status do FR-055 e Retry-After nos 503 (I-34). */
export function toHttpError(
  exception: unknown,
  context: { correlationId: string; retryAfterSeconds: number },
): HttpErrorResult {
  const { code, details, unexpected } = codeFor(exception);
  const status = STATUS_BY_CODE[code];
  const message =
    exception instanceof ApplicationError && code !== 'INTERNAL_ERROR' && code !== 'SERVICE_UNAVAILABLE'
      ? exception.message
      : (SAFE_MESSAGE[code] ?? 'Request failed');
  const body: ErrorEnvelope = {
    error: {
      code,
      message,
      retryable: RETRYABLE_BY_CODE[code],
      correlationId: context.correlationId,
      ...(details ? { details } : {}),
    },
  };
  const headers: Record<string, string> = status === 503 ? { 'Retry-After': String(context.retryAfterSeconds) } : {};
  return { status, headers, body, unexpected };
}

interface MinimalResponse {
  status(code: number): MinimalResponse;
  setHeader(name: string, value: string): unknown;
  json(body: unknown): unknown;
}

export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly config: { retryAfterSeconds: number },
    private readonly logger: JsonLogger,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<MinimalResponse>();
    const correlationId = currentRequestContext()?.correlationId ?? 'unknown';
    const result = toHttpError(exception, { correlationId, retryAfterSeconds: this.config.retryAfterSeconds });
    if (result.unexpected) {
      this.logger.error('http.unexpected_error', {
        code: result.body.error.code,
        errorName: exception instanceof Error ? exception.name : typeof exception,
        sqlState: (exception as { code?: unknown } | null)?.code,
      });
    }
    for (const [name, value] of Object.entries(result.headers)) response.setHeader(name, value);
    response.status(result.status).json(result.body);
  }
}
