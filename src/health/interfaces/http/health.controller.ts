import { Controller, Get, Inject, Res } from '@nestjs/common';
import { Public } from '../../../platform/auth/public.decorator.ts';
import { WORKER_REGISTRY, type WorkerRegistry } from '../../../platform/workers/worker-registry.ts';
import { HEALTH_CHECK_TIMEOUT_MS, readinessOf, withTimeout, type ReadinessBody } from '../../application/readiness.ts';
import type { PostgresHealthCheck } from '../../infrastructure/postgres.health-check.ts';
import type { SqsHealthCheck } from '../../infrastructure/sqs.health-check.ts';

export const POSTGRES_HEALTH_CHECK = Symbol('POSTGRES_HEALTH_CHECK');
export const SQS_HEALTH_CHECK = Symbol('SQS_HEALTH_CHECK');

interface StatusResponse {
  status(code: number): unknown;
}

/**
 * `GET /health/live` e `GET /health/ready` (FR-013 a FR-018; I-75; contracts/http.md). Sem autenticação, corpo próprio
 * (fora do envelope do I-38): o 503 é definido aqui, sem lançar exceção, para não passar pelo filtro global.
 */
@Public()
@Controller('health')
export class HealthController {
  constructor(
    @Inject(POSTGRES_HEALTH_CHECK) private readonly postgres: PostgresHealthCheck,
    @Inject(SQS_HEALTH_CHECK) private readonly sqs: SqsHealthCheck,
    @Inject(WORKER_REGISTRY) private readonly registry: WorkerRegistry,
  ) {}

  /** Processo vivo: não consulta nenhuma dependência. */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Pronta: PostgreSQL e SQS em paralelo, 2 s cada; 503 também desde o início do encerramento (`isDraining()`, que
   * liga no instante do sinal, E-1), com o estado real de cada dependência.
   */
  @Get('ready')
  async ready(@Res({ passthrough: true }) response: StatusResponse): Promise<ReadinessBody> {
    const [postgres, sqs] = await Promise.all([
      withTimeout(() => this.postgres.check(), HEALTH_CHECK_TIMEOUT_MS),
      withTimeout(() => this.sqs.check(), HEALTH_CHECK_TIMEOUT_MS),
    ]);
    const { httpStatus, body } = readinessOf({ postgres, sqs }, this.registry.isDraining());
    response.status(httpStatus);
    return body;
  }
}
