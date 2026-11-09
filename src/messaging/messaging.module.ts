import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../platform/config/app-config.ts';
import { SQS_PORT } from './application/sqs.port.ts';
import { AwsSqsAdapter } from './infrastructure/aws-sqs.adapter.ts';
import { createSqsClient } from './infrastructure/sqs-client.factory.ts';

/**
 * Mensageria (feature 002): a porta SQS com o adapter do SDK (R-21). O consumidor da fila de transações é registrado
 * aqui (US1); o publicador da outbox importa este módulo para usar a porta (US3).
 */
@Module({
  providers: [
    {
      provide: SQS_PORT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new AwsSqsAdapter(createSqsClient(config.sqs)),
    },
  ],
  exports: [SQS_PORT],
})
export class MessagingModule {}
