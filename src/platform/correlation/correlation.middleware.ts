import type { IdGenerator } from '../../shared-kernel/domain/id-generator.port.ts';
import { resolveCorrelationId, runWithRequestContext } from './request-context.ts';

export const CORRELATION_HEADER = 'X-Correlation-Id';

interface MinimalRequest {
  headers: Record<string, string | string[] | undefined>;
}
interface MinimalResponse {
  setHeader(name: string, value: string): unknown;
}

/**
 * Middleware express aplicado antes de qualquer rota: resolve o correlationId, grava o header da resposta e abre
 * o contexto da requisição. Nunca rejeita (I-53, FR-060).
 */
export function correlationMiddleware(idGenerator: IdGenerator) {
  return (req: MinimalRequest, res: MinimalResponse, next: () => void): void => {
    const correlationId = resolveCorrelationId(req.headers['x-correlation-id'], idGenerator);
    res.setHeader(CORRELATION_HEADER, correlationId);
    runWithRequestContext({ correlationId }, next);
  };
}
