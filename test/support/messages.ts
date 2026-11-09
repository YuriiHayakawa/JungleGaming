// Envelopes WagerTransactionRequested para os testes (contracts/wager-transaction-requested.schema.json), enviados ao
// MiniStack real com MessageGroupId = walletId e MessageDeduplicationId = messageId (I-29).
import { idempotencyKeyFor, type WagerRequest } from './factories.ts';
import { sendRaw } from './sqs-client.ts';

export interface WagerEnvelope {
  messageId: string;
  type: string;
  occurredAt: string;
  data: WagerRequest & { idempotencyKey: string };
}

export function newMessageId(prefix = 'msg'): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function wagerEnvelope(
  request: WagerRequest,
  options: { messageId?: string; idempotencyKey?: string; type?: string } = {},
): WagerEnvelope {
  return {
    messageId: options.messageId ?? newMessageId(),
    type: options.type ?? 'WagerTransactionRequested',
    occurredAt: '2026-11-08T12:00:00.000Z',
    data: { ...request, idempotencyKey: options.idempotencyKey ?? idempotencyKeyFor(request) },
  };
}

/**
 * Envia o envelope à fila de transações. `deduplicationId` padrão = messageId (I-29); um id diferente simula a
 * reentrega fora da janela de deduplicação do SQS.
 */
export async function sendEnvelope(
  queueUrl: string,
  envelope: WagerEnvelope,
  options: { deduplicationId?: string; groupId?: string } = {},
): Promise<string> {
  return sendRaw(queueUrl, JSON.stringify(envelope), {
    groupId: options.groupId ?? envelope.data.walletId,
    deduplicationId: options.deduplicationId ?? envelope.messageId,
  });
}
