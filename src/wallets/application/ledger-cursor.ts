import { ValidationError } from '../../shared-kernel/application/errors.ts';

/** Paginação do ledger (I-36, I-47): limit padrão 50, máximo 200. */
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/** Maior `bigint` do PostgreSQL; o `seq` é identity bigint. */
const MAX_SEQ = 9223372036854775807n;
const SEQ_PATTERN = /^[1-9]\d{0,18}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const LIMIT_PATTERN = /^[1-9]\d{0,2}$/;

function invalid(path: 'cursor' | 'limit', message: string): ValidationError {
  // a mensagem nunca ecoa o valor recebido (FR-058)
  return new ValidationError('Request payload is invalid', { issues: [{ path, message }] });
}

function isValidSeq(seq: string): boolean {
  return SEQ_PATTERN.test(seq) && BigInt(seq) <= MAX_SEQ;
}

/**
 * Cursor opaco: base64url (sem padding) do `seq` em texto decimal. O `seq` trafega como string ou bigint, nunca como
 * number: o maior bigint não cabe num number sem perder precisão.
 */
export function encodeCursor(seq: string | bigint): string {
  const text = typeof seq === 'bigint' ? seq.toString() : seq;
  if (!isValidSeq(text)) throw new Error('ledger seq must be a positive bigint');
  return Buffer.from(text, 'utf8').toString('base64url');
}

/**
 * Devolve o `seq` do cursor, como string. Recusa com VALIDATION_ERROR o que não é base64url canônico, não é inteiro de
 * 1 a 19 dígitos sem zero à esquerda, ou passa do maior bigint (I-47). A recodificação precisa reproduzir o cursor:
 * assim uma variante adulterada que decodifica para o mesmo número (bits extras, padding) também é recusada.
 */
export function decodeCursor(cursor: string): string {
  if (!BASE64URL_PATTERN.test(cursor)) throw invalid('cursor', 'cursor is invalid');
  const seq = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!isValidSeq(seq) || Buffer.from(seq, 'utf8').toString('base64url') !== cursor) {
    throw invalid('cursor', 'cursor is invalid');
  }
  return seq;
}

/** `limit` da query string: ausente → 50; inteiro de 1 a 200 em decimal simples; o resto → VALIDATION_ERROR. */
export function parseLimit(raw: unknown): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  if (typeof raw !== 'string' || !LIMIT_PATTERN.test(raw)) {
    throw invalid('limit', `limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  const limit = Number.parseInt(raw, 10);
  if (limit > MAX_LIMIT) throw invalid('limit', `limit must be an integer from 1 to ${MAX_LIMIT}`);
  return limit;
}
