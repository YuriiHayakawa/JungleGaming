// S-01, S-02, S-03 + extras (AsyncLocalStorage, Bun.randomUUIDv7). Spike descartável.
import 'reflect-metadata';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Server } from 'node:http';
import { Body, Controller, Get, Headers, Inject, Injectable, Module, Param, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';

export const GREETER = Symbol('GREETER');
export const requestContext = new AsyncLocalStorage<{ correlationId: string }>();

export interface Greeter {
  greet(name: string): string;
}

class SimpleGreeter implements Greeter {
  greet(name: string): string {
    return `hello ${name}`;
  }
}

@Injectable()
export class EchoService {
  constructor(@Inject(GREETER) private readonly greeter: Greeter) {}

  async echo(id: string, body: unknown, header: string | undefined) {
    await Bun.sleep(1); // atravessa um await para provar a propagação do AsyncLocalStorage
    return {
      id,
      body,
      header: header ?? null,
      greeting: this.greeter.greet(id),
      correlationId: requestContext.getStore()?.correlationId ?? null,
      uuidv7: Bun.randomUUIDv7(),
    };
  }
}

@Controller()
export class SpikeController {
  constructor(@Inject(EchoService) private readonly service: EchoService) {}

  @Get('ping')
  ping() {
    return { ok: true, pid: process.pid };
  }

  @Post('echo/:id')
  echo(@Param('id') id: string, @Body() body: unknown, @Headers('x-test') header?: string) {
    return this.service.echo(id, body, header);
  }

  @Get('sleep/:ms')
  async sleep(@Param('ms') ms: string) {
    const started = Date.now();
    await Bun.sleep(Number(ms));
    return { slept: Date.now() - started };
  }
}

@Module({
  controllers: [SpikeController],
  providers: [EchoService, { provide: GREETER, useClass: SimpleGreeter }],
})
export class SpikeModule {}

export interface BootOptions {
  port: number;
  httpServerTimeoutMs?: number;
}

export async function bootstrap(options: BootOptions): Promise<INestApplication> {
  const app = await NestFactory.create(SpikeModule, { logger: ['error', 'warn'] });
  app.use((req: { headers: Record<string, string | string[] | undefined> }, _res: unknown, next: () => void) => {
    const header = req.headers['x-correlation-id'];
    requestContext.run({ correlationId: typeof header === 'string' ? header : 'generated' }, next);
  });
  if (options.httpServerTimeoutMs !== undefined) {
    const server = app.getHttpServer() as Server;
    const ms = options.httpServerTimeoutMs;
    server.setTimeout(ms);
    server.requestTimeout = ms;
    server.headersTimeout = ms;
    server.keepAliveTimeout = ms;
  }
  await app.listen(options.port);
  console.log(JSON.stringify({ event: 'http.listening', port: options.port, pid: process.pid }));
  return app;
}

if (import.meta.main) {
  const timeout = process.env.HTTP_SERVER_TIMEOUT_MS;
  const app = await bootstrap({
    port: Number(process.env.PORT ?? 3100),
    httpServerTimeoutMs: timeout ? Number(timeout) : undefined,
  });
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
