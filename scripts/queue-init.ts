// bun scripts/queue-init.ts — cria, de forma idempotente, as filas FIFO, a DLQ e o redrive (plan, "Deploy local";
// I-29, I-30). Lê SQS_ENDPOINT, as credenciais e os nomes das filas do ambiente. Sai com 0 em sucesso e ≠ 0 em erro.
import { createSqsClient } from '../src/messaging/infrastructure/sqs-client.factory.ts';
import { provisionQueues } from '../src/messaging/infrastructure/queue-provisioning.ts';

const env = process.env;
const names = {
  transactions: env.SQS_TRANSACTIONS_QUEUE ?? 'wager-transactions.fifo',
  dlq: env.SQS_TRANSACTIONS_DLQ ?? 'wager-transactions-dlq.fifo',
  events: env.SQS_EVENTS_QUEUE ?? 'wager-events.fifo',
};
const endpoint = env.SQS_ENDPOINT ?? 'http://localhost:4566';

try {
  const client = createSqsClient({
    endpoint,
    region: env.AWS_REGION ?? 'us-east-1',
    accessKeyId: env.AWS_ACCESS_KEY_ID ?? 'test',
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? 'test',
  });
  const queues = await provisionQueues(client, names);
  console.log(JSON.stringify({ level: 'info', msg: 'queue-init.done', endpoint, queues }));
  process.exit(0);
} catch (error) {
  console.error(
    JSON.stringify({
      level: 'error',
      msg: 'queue-init.failed',
      endpoint,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    }),
  );
  process.exit(1);
}
