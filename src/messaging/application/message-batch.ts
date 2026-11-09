import type { RequestContext } from '../../platform/correlation/request-context.ts';
import type { ReceiveOptions, SqsMessage, SqsPort } from './sqs.port.ts';

/** Classe do erro que levou a mensagem à DLQ (I-70, I-71). */
export type DlqErrorClass = 'permanent' | 'unexpected';

/**
 * O que fazer com a mensagem depois de processada (R-22, R-23):
 * - `ack`: DeleteMessage (sempre depois do commit, FR-005); `committed` diz se esta entrega gravou algo;
 * - `retry`: sem delete; a mensagem volta depois de `visibilitySeconds` (backoff, FR-009);
 * - `dlq`: SendMessage à DLQ com os atributos e, só depois, DeleteMessage (FR-040).
 */
export type MessageAction =
  | {
      type: 'ack';
      outcome: 'processed' | 'replay' | 'duplicate';
      committed: boolean;
      status?: string;
      context?: RequestContext;
    }
  | { type: 'retry'; visibilitySeconds: number; error: unknown; errorClass: 'transient' | 'unexpected'; context?: RequestContext }
  | { type: 'dlq'; errorCode: string; errorClass: DlqErrorClass; deduplicationId: string; error?: unknown; context?: RequestContext };

export interface MessageHandler {
  /** Processa a mensagem e decide a ação; nunca apaga nada. */
  process(message: SqsMessage): Promise<MessageAction>;
  /** Executa a ação na fila (ack, visibilidade, DLQ). */
  apply(message: SqsMessage, action: MessageAction): Promise<void>;
}

/** Agrupa por MessageGroupId preservando a ordem de chegada dentro de cada grupo. */
function byGroup(messages: SqsMessage[]): SqsMessage[][] {
  const groups = new Map<string, SqsMessage[]>();
  for (const message of messages) {
    const key = message.groupId ?? `__no-group__${message.sqsMessageId}`;
    const list = groups.get(key) ?? [];
    list.push(message);
    groups.set(key, list);
  }
  return [...groups.values()];
}

/**
 * Recebe um lote (long polling cancelável) e processa (research R-22): mensagens do mesmo grupo em sequência e na
 * ordem; grupos diferentes em paralelo. A ação de cada mensagem só é aplicada depois que o processamento dela resolve.
 * Um erro numa mensagem não apaga a mensagem nem interrompe as outras: vai para `onError`. Devolve quantas mensagens
 * o lote trouxe.
 */
export async function consumeBatch(
  sqs: SqsPort,
  queue: string,
  options: ReceiveOptions,
  handler: MessageHandler,
  onError?: (error: unknown, message: SqsMessage) => void,
): Promise<number> {
  const messages = await sqs.receive(queue, options);
  await Promise.all(
    byGroup(messages).map(async (group) => {
      for (const message of group) {
        try {
          const action = await handler.process(message);
          await handler.apply(message, action);
        } catch (error) {
          onError?.(error, message);
        }
      }
    }),
  );
  return messages.length;
}
