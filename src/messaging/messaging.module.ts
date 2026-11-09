import { Module } from '@nestjs/common';
import type { MikroORM } from '@mikro-orm/postgresql';
import { MikroOrmInboxRepository } from '../inbox/infrastructure/mikro-orm-inbox.repository.ts';
import { APP_CONFIG, type AppConfig } from '../platform/config/app-config.ts';
import { FAILPOINTS, type Failpoints } from '../platform/failpoints/failpoints.ts';
import { LOGGER, type JsonLogger } from '../platform/logging/json-logger.ts';
import { ORM } from '../platform/persistence/orm.provider.ts';
import type { SubmitWagerTransactionUseCase } from '../wagering/application/submit-wager-transaction.use-case.ts';
import { SUBMIT_WAGER_TRANSACTION_USE_CASE } from '../wagering/interfaces/http/wagering.controller.ts';
import { WageringModule } from '../wagering/wagering.module.ts';
import { ConsumeWagerMessageUseCase } from './application/consume-wager-message.use-case.ts';
import { SQS_PORT, type SqsPort } from './application/sqs.port.ts';
import { AwsSqsAdapter } from './infrastructure/aws-sqs.adapter.ts';
import { createSqsClient, SQS_POLL_TIMEOUT_MS } from './infrastructure/sqs-client.factory.ts';
import { CONSUME_WAGER_MESSAGE_USE_CASE, WagerTransactionsConsumer } from './interfaces/wager-transactions.consumer.ts';

/**
 * Mensageria (feature 002): a porta SQS com o adapter do SDK (R-21) e o consumidor da fila de transações, que
 * reutiliza o use case de submissão do HTTP (FR-001, constitution IV). O publicador da outbox importa este módulo para
 * usar a porta (US3).
 */
@Module({
  imports: [WageringModule],
  providers: [
    {
      provide: SQS_PORT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new AwsSqsAdapter(createSqsClient(config.sqs), createSqsClient(config.sqs, SQS_POLL_TIMEOUT_MS)),
    },
    {
      provide: CONSUME_WAGER_MESSAGE_USE_CASE,
      inject: [APP_CONFIG, ORM, SUBMIT_WAGER_TRANSACTION_USE_CASE, SQS_PORT, FAILPOINTS, LOGGER],
      useFactory: (
        config: AppConfig,
        orm: MikroORM,
        submit: SubmitWagerTransactionUseCase,
        sqs: SqsPort,
        failpoints: Failpoints,
        logger: JsonLogger,
      ) =>
        new ConsumeWagerMessageUseCase({
          orm,
          submit,
          inbox: new MikroOrmInboxRepository(),
          sqs,
          queues: { transactions: config.sqs.transactionsQueue, dlq: config.sqs.transactionsDlq },
          consumer: config.consumer,
          failpoints,
          logger,
        }),
    },
    WagerTransactionsConsumer,
  ],
  exports: [SQS_PORT],
})
export class MessagingModule {}
