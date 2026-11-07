// App em processo (NestFactory + porta efêmera) contra o banco do arquivo de teste (research R-17).
import type { INestApplication } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import { bootstrap } from '../../src/main.ts';
import { loadConfig } from '../../src/platform/config/app-config.ts';
import { ORM } from '../../src/platform/persistence/orm.provider.ts';

export interface RunningApp {
  baseUrl: string;
  app: INestApplication;
  orm: MikroORM;
  /** Linhas JSON de log emitidas pela app. */
  logs: string[];
  close(): Promise<void>;
}

export async function startApp(options: { databaseUrl: string; env?: Record<string, string> }): Promise<RunningApp> {
  const logs: string[] = [];
  const config = loadConfig({
    ...process.env,
    NODE_ENV: 'test',
    FAILPOINT: '',
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
    logs,
    async close() {
      if (closed) return;
      closed = true;
      await started.app.close();
    },
  };
}
