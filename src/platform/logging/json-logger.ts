import type { LoggerService } from '@nestjs/common';
import { currentRequestContext } from '../correlation/request-context.ts';

export const LOGGER = Symbol('LOGGER');

type Level = 'debug' | 'info' | 'warn' | 'error';
type Fields = Record<string, unknown>;

/** Chaves com valor monetário: nunca vão para o log (FR-058, constitution VIII). */
const MONEY_KEYS = new Set([
  'amount',
  'money',
  'balance',
  'balanceBefore',
  'balanceAfter',
  'initialBalance',
  'observedBalance',
]);

function redactMoney(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactMoney);
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const out: Fields = {};
    for (const [key, inner] of Object.entries(value)) {
      if (MONEY_KEYS.has(key)) continue;
      out[key] = redactMoney(inner);
    }
    return out;
  }
  return value;
}

/** Uma linha JSON por evento, com os ids do contexto da requisição quando presentes. */
export class JsonLogger implements LoggerService {
  constructor(private readonly write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)) {}

  debug(message: unknown, ...rest: unknown[]): void {
    this.emit('debug', message, rest);
  }

  info(message: unknown, fields?: Fields): void {
    this.emit('info', message, fields ? [fields] : []);
  }

  /** LoggerService do Nest: log(message, ...optionalParams), com o contexto como último parâmetro string. */
  log(message: unknown, ...rest: unknown[]): void {
    this.emit('info', message, rest);
  }

  warn(message: unknown, ...rest: unknown[]): void {
    this.emit('warn', message, rest);
  }

  error(message: unknown, ...rest: unknown[]): void {
    this.emit('error', message, rest);
  }

  verbose(message: unknown, ...rest: unknown[]): void {
    this.emit('debug', message, rest);
  }

  private emit(level: Level, message: unknown, rest: unknown[]): void {
    const entry: Fields = { level, time: new Date().toISOString(), msg: stringify(message) };
    const context = currentRequestContext();
    if (context) {
      for (const key of ['correlationId', 'messageId', 'causationId', 'walletId', 'providerId', 'transactionId'] as const) {
        if (context[key] !== undefined) entry[key] = context[key];
      }
    }
    for (const extra of rest) {
      if (typeof extra === 'string') entry.context = extra;
      else if (extra instanceof Error) entry.err = { name: extra.name, message: extra.message };
      else if (extra !== null && typeof extra === 'object') Object.assign(entry, redactMoney(extra));
    }
    this.write(JSON.stringify(entry));
  }
}

function stringify(message: unknown): string {
  if (typeof message === 'string') return message;
  if (message instanceof Error) return message.message;
  return JSON.stringify(redactMoney(message));
}

interface LoggedRequest {
  method: string;
  originalUrl?: string;
  url: string;
}
interface LoggedResponse {
  statusCode: number;
  on(event: 'finish', listener: () => void): unknown;
}

/** Middleware express: uma linha por requisição com método, rota, status e duração, sem valores monetários. */
export function requestLoggingMiddleware(logger: JsonLogger) {
  return (req: LoggedRequest, res: LoggedResponse, next: () => void): void => {
    const started = performance.now();
    res.on('finish', () => {
      const path = (req.originalUrl ?? req.url).split('?')[0];
      logger.info('http.request', {
        method: req.method,
        route: path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - started),
      });
    });
    next();
  };
}
