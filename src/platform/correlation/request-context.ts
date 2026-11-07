import { AsyncLocalStorage } from 'node:async_hooks';
import type { IdGenerator } from '../../shared-kernel/domain/id-generator.port.ts';

/** Contexto da requisição: lido pelo logger, pelo filtro e pelos use cases (I-53, constitution VIII). */
export interface RequestContext {
  correlationId: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** Header válido (1 a 128 caracteres em [A-Za-z0-9._:-]) é usado; ausente ou inválido gera UUIDv7. Nunca lança. */
export function resolveCorrelationId(header: unknown, idGenerator: IdGenerator): string {
  if (typeof header === 'string' && CORRELATION_ID_PATTERN.test(header)) return header;
  return idGenerator.next();
}

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run({ ...context }, fn);
}

export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Acrescenta ids ao contexto assim que conhecidos (walletId, providerId, transactionId). Fora de requisição, não faz nada. */
export function setRequestContextValues(values: Partial<Omit<RequestContext, 'correlationId'>>): void {
  const store = storage.getStore();
  if (!store) return;
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) (store as unknown as Record<string, unknown>)[key] = value;
  }
}
