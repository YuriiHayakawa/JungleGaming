import { SQSClient } from '@aws-sdk/client-sqs';
import type { SqsConfig } from '../../platform/config/app-config.ts';

/** Prazo de uma requisição HTTP ao SQS: maior que o long polling máximo (20 s), para nunca cortar um receive válido. */
const REQUEST_TIMEOUT_MS = 30_000;
const CONNECTION_TIMEOUT_MS = 3_000;

/** Cliente do SQS (emulador MiniStack no ambiente local, I-43) com credenciais fictícias da configuração. */
export function createSqsClient(config: Pick<SqsConfig, 'endpoint' | 'region' | 'accessKeyId' | 'secretAccessKey'>): SQSClient {
  return new SQSClient({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    maxAttempts: 2,
    requestHandler: { requestTimeout: REQUEST_TIMEOUT_MS, connectionTimeout: CONNECTION_TIMEOUT_MS },
  });
}
