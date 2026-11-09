import { SQSClient } from '@aws-sdk/client-sqs';
import type { SqsConfig } from '../../platform/config/app-config.ts';

/**
 * Prazo de cada tentativa de uma chamada curta ao SQS (SendMessage, DeleteMessage, ChangeMessageVisibility,
 * GetQueueUrl, GetQueueAttributes): 5 s, com 1 nova tentativa do SDK (`maxAttempts` 2). Assim uma chamada leva no
 * máximo ~10 s, abaixo do lease padrão de 30 s do publicador (R-27; implementation-notes N-20, N-22).
 */
export const SQS_CALL_TIMEOUT_MS = 5_000;
/** Prazo de uma tentativa de ReceiveMessage: maior que o long polling máximo (20 s), para nunca cortar um receive válido. */
export const SQS_POLL_TIMEOUT_MS = 30_000;
const CONNECTION_TIMEOUT_MS = 3_000;
/** 1 tentativa + 1 nova tentativa. */
const MAX_ATTEMPTS = 2;

type ClientConfig = Pick<SqsConfig, 'endpoint' | 'region' | 'accessKeyId' | 'secretAccessKey'>;

/**
 * Cliente do SQS (emulador MiniStack no ambiente local, I-43) com credenciais fictícias da configuração.
 * `requestTimeoutMs` padrão: o das chamadas curtas; o long polling usa um cliente próprio com `SQS_POLL_TIMEOUT_MS`.
 */
export function createSqsClient(config: ClientConfig, requestTimeoutMs: number = SQS_CALL_TIMEOUT_MS): SQSClient {
  return new SQSClient({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    maxAttempts: MAX_ATTEMPTS,
    requestHandler: { requestTimeout: requestTimeoutMs, connectionTimeout: CONNECTION_TIMEOUT_MS },
  });
}
