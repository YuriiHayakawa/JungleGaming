import { ConnectionException } from '@mikro-orm/core';
import type { DatabaseError } from 'pg';

/** Classificação dos erros do banco (research R-12). */
export type DbErrorKind =
  | 'transient'
  | 'retry'
  | 'idempotency-race'
  | 'wallet-duplicate'
  | 'reversal-race'
  | 'inbox-race'
  | 'invariant'
  | 'unknown';

const RETRY_CODES = new Set(['40P01', '40001']);
const TRANSIENT_CODES = new Set(['55P03', '57014', '53300', '57P01', '57P02', '57P03']);
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENOTFOUND']);
const INVARIANT_CODES = new Set(['23514', '22003', 'P0001', '23503', '23502']);
const UNIQUE_KINDS: Record<string, DbErrorKind> = {
  wager_tx_provider_idempotency_uq: 'idempotency-race',
  wager_tx_provider_external_uq: 'idempotency-race',
  wallets_player_currency_uq: 'wallet-duplicate',
  wager_tx_single_reversal_uq: 'reversal-race',
  // feature 002 (R-22): a mesma mensagem gravada por outra instância; quem chama relê a inbox e compara o hash.
  inbox_messages_pk: 'inbox-race',
};
/** Único caso identificado por mensagem: o timeout de aquisição do pg.Pool não tem SQLSTATE (spike S-09). */
const ACQUIRE_TIMEOUT_MESSAGE = 'timeout exceeded when trying to connect';
const CONNECTION_LOST_MESSAGES = ['Connection terminated', 'Client has encountered a connection error'];

type DriverFields = Partial<Pick<DatabaseError, 'code' | 'constraint'>> & { message?: string; cause?: unknown };

/** As exceções do MikroORM copiam os campos do erro do driver; quando não copiam, eles estão em `cause`. */
function fields(err: unknown): { code?: string; constraint?: string; message: string } {
  const own = (err ?? {}) as DriverFields;
  const cause = (own.cause ?? {}) as DriverFields;
  return {
    code: own.code ?? cause.code,
    constraint: own.constraint ?? cause.constraint,
    message: `${own.message ?? ''} ${cause.message ?? ''}`,
  };
}

/** SQLSTATE do erro do driver (no próprio erro ou em `cause`), se houver. */
export function sqlStateOf(err: unknown): string | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  return fields(err).code;
}

export function classifyDbError(err: unknown): DbErrorKind {
  if (err === null || typeof err !== 'object') return 'unknown';
  const { code, constraint, message } = fields(err);

  if (code === '23505') return (constraint && UNIQUE_KINDS[constraint]) || 'invariant';
  if (code && RETRY_CODES.has(code)) return 'retry';
  if (code && (TRANSIENT_CODES.has(code) || code.startsWith('08') || NETWORK_CODES.has(code))) return 'transient';
  if (code && INVARIANT_CODES.has(code)) return 'invariant';
  if (message.includes(ACQUIRE_TIMEOUT_MESSAGE)) return 'transient';
  if (err instanceof ConnectionException) return 'transient';
  if (CONNECTION_LOST_MESSAGES.some((m) => message.includes(m))) return 'transient';
  return 'unknown';
}
