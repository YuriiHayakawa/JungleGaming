import { Controller, Get, Header, Inject } from '@nestjs/common';
import type { OutboxLagReader } from '../../../outbox/infrastructure/outbox-lag.reader.ts';
import { Public } from '../../../platform/auth/public.decorator.ts';
import type { InMemoryMetrics } from '../../../platform/metrics/in-memory-metrics.ts';
import { METRICS } from '../../../platform/metrics/metrics.port.ts';
import { PROMETHEUS_CONTENT_TYPE, renderPrometheus } from '../../../platform/metrics/prometheus-text.ts';

export const OUTBOX_LAG_READER = Symbol('OUTBOX_LAG_READER');

/**
 * `GET /metrics` (FR-019 a FR-024; I-76; contracts/metrics.md): texto Prometheus 0.0.4 escrito à mão, sem
 * autenticação. Métricas em memória da instância (`METRICS`, R-32) mais os gauges da outbox lidos do banco na hora;
 * banco fora → os gauges são omitidos e o resto é respondido normalmente (200).
 */
@Public()
@Controller('metrics')
export class MetricsController {
  constructor(
    @Inject(METRICS) private readonly metrics: Pick<InMemoryMetrics, 'snapshot'>,
    @Inject(OUTBOX_LAG_READER) private readonly outboxLag: Pick<OutboxLagReader, 'read'>,
  ) {}

  @Get()
  @Header('Content-Type', PROMETHEUS_CONTENT_TYPE)
  async scrape(): Promise<string> {
    const gauges = await this.outboxLag.read();
    return renderPrometheus(this.metrics.snapshot(), gauges);
  }
}
