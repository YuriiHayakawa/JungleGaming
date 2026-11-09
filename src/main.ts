import 'reflect-metadata';
import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.ts';
import { loadConfig, type AppConfig } from './platform/config/app-config.ts';
import { correlationMiddleware } from './platform/correlation/correlation.middleware.ts';
import { installShutdownSignals } from './platform/lifecycle/signal-handler.ts';
import { JsonLogger, requestLoggingMiddleware } from './platform/logging/json-logger.ts';
import { ID_GENERATOR, type IdGenerator } from './shared-kernel/domain/id-generator.port.ts';

export interface StartedApp {
  app: INestApplication;
  port: number;
  logger: JsonLogger;
}

export interface BootstrapOptions {
  /** Destino das linhas de log (padrão: stdout). Os testes em processo capturam as linhas por aqui. */
  logWriter?: (line: string) => void;
}

export async function bootstrap(config: AppConfig, options: BootstrapOptions = {}): Promise<StartedApp> {
  const logger = new JsonLogger(options.logWriter);
  const app = await NestFactory.create(AppModule.forRoot(config, { logger }), { logger, abortOnError: false });

  // Antes de qualquer rota: correlationId (I-53) e uma linha de log por requisição (constitution VIII).
  app.use(correlationMiddleware(app.get<IdGenerator>(ID_GENERATOR)));
  app.use(requestLoggingMiddleware(logger));
  // Sem app.enableShutdownHooks(): o processo instala o próprio handler de sinal (R-35, abaixo); os testes em processo
  // chamam app.close(), que dispara os mesmos onApplicationShutdown.

  // Hierarquia do I-51: o timeout HTTP é maior que espera de conexão + espera de lock (spike S-03).
  const server = app.getHttpServer() as Server;
  server.setTimeout(config.httpServerTimeoutMs);
  server.requestTimeout = config.httpServerTimeoutMs;
  server.headersTimeout = config.httpServerTimeoutMs;
  server.keepAliveTimeout = config.httpServerTimeoutMs;

  await app.listen(config.port);
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;
  logger.info('http.listening', { event: 'http.listening', port });
  return { app, port, logger };
}

if (import.meta.main) {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ level: 'error', msg: 'config.invalid', error: error instanceof Error ? error.message : String(error) })}\n`,
    );
    process.exit(1);
  }
  try {
    const { app, logger } = await bootstrap(config);
    // Handler próprio de SIGTERM/SIGINT (spike S-12.8, R-35): app.close() → exit(0), também como PID 1 do container.
    installShutdownSignals({
      target: process,
      close: () => app.close(),
      exit: (code) => process.exit(code),
      shutdownTimeoutMs: config.consumer.shutdownTimeoutMs,
      log: (message, fields) => logger.info(message, { event: message, ...fields }),
    });
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ level: 'error', msg: 'boot.failed', error: error instanceof Error ? error.message : String(error) })}\n`,
    );
    process.exit(1);
  }
}
