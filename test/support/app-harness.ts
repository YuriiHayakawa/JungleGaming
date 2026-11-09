// App em processo (NestFactory + porta efêmera) contra o banco do arquivo de teste (research R-17).
// Feature 002 (T033): papéis por env, desligados por padrão (R-27), e o env das filas de useTestQueues (R-31).
import type { INestApplication } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import { bootstrap } from '../../src/main.ts';
import { loadConfig } from '../../src/platform/config/app-config.ts';
import { ORM } from '../../src/platform/persistence/orm.provider.ts';
import { METRICS } from '../../src/platform/metrics/metrics.port.ts';
import type { InMemoryMetrics } from '../../src/platform/metrics/in-memory-metrics.ts';
import { SQS_PORT, type SqsPort } from '../../src/messaging/application/sqs.port.ts';
import { roleEnv, type Roles } from './roles.ts';

export type { Roles } from './roles.ts';

export interface RunningApp {
  baseUrl: string;
  app: INestApplication;
  orm: MikroORM;
  /** Métricas em memória da instância (R-32). */
  metrics: InMemoryMetrics;
  /** A porta SQS da instância (adapter real contra o MiniStack). */
  sqs: SqsPort;
  /** Linhas JSON de log emitidas pela app. */
  logs: string[];
  close(): Promise<void>;
}

export async function startApp(options: {
  databaseUrl: string;
  env?: Record<string, string>;
  roles?: Roles;
  /** Env das filas do arquivo (useTestQueues().env()). */
  queues?: Record<string, string>;
}): Promise<RunningApp> {
  const logs: string[] = [];
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    FAILPOINT: '',
    ...roleEnv(options.roles),
    ...options.queues,
    ...options.env,
    DATABASE_URL: options.databaseUrl,
    PORT: '0',
  });
  const started = await bootstrap(config, { logWriter: (line) => logs.push(line) });
  let closed = false;
  return {
    baseUrl: `http://127.0.0.1:${started.port}`,
    app: started.app,
    orm: started.app.get<MikroORM>(ORM),
    metrics: started.app.get<InMemoryMetrics>(METRICS),
    sqs: started.app.get<SqsPort>(SQS_PORT),
    logs,
    async close() {
      if (closed) return;
      closed = true;
      await started.app.close();
    },
  };
}
