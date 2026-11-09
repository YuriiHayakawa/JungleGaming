import type { SqsPort } from '../../messaging/application/sqs.port.ts';

/**
 * Checagem do SQS para o ready (R-39): `GetQueueAttributes` (`approximateCounts` da `SqsPort` da 002) das três filas da
 * configuração, em paralelo. Fila inexistente ou SQS fora → rejeita (`down`). Só leitura; o `@aws-sdk` continua só no
 * adapter de `messaging/infrastructure` (guardrail (g)).
 */
export class SqsHealthCheck {
  constructor(
    private readonly sqs: Pick<SqsPort, 'approximateCounts'>,
    private readonly queues: readonly string[],
  ) {}

  async check(): Promise<void> {
    await Promise.all(this.queues.map((queue) => this.sqs.approximateCounts(queue)));
  }
}
