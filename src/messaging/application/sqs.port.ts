/**
 * Porta SQS (research R-21). Os trabalhadores falam só com ela; o @aws-sdk/client-sqs fica no adapter de
 * `messaging/infrastructure` (R-33). As filas são identificadas pelo nome lógico da configuração (`.fifo`).
 */
export const SQS_PORT = Symbol('SQS_PORT');

export interface SqsMessage {
  /** Id atribuído pelo SQS (não é o `messageId` do envelope). */
  sqsMessageId: string;
  receiptHandle: string;
  body: string;
  /** `ApproximateReceiveCount` no momento do recebimento (1 na primeira entrega). */
  receiveCount: number;
  groupId: string | undefined;
  /** Atributos de mensagem do tipo String. */
  attributes: Record<string, string>;
}

export interface ReceiveOptions {
  max: number;
  waitSeconds: number;
  /** Visibilidade aplicada a este recebimento; sem ela vale a da fila. */
  visibilitySeconds?: number;
  /** Cancela o long polling (término gracioso, spike S-12.7). */
  signal?: AbortSignal;
}

export interface SendOptions {
  body: string;
  groupId: string;
  deduplicationId: string;
  attributes?: Record<string, string>;
}

export interface QueueCounts {
  visible: number;
  notVisible: number;
}

export interface SqsPort {
  receive(queue: string, options: ReceiveOptions): Promise<SqsMessage[]>;
  /** Ack: apaga a mensagem da fila. */
  delete(queue: string, receiptHandle: string): Promise<void>;
  changeVisibility(queue: string, receiptHandle: string, seconds: number): Promise<void>;
  /** Resolve só quando o SQS aceitou a mensagem; qualquer falha rejeita. */
  send(queue: string, options: SendOptions): Promise<void>;
  approximateCounts(queue: string): Promise<QueueCounts>;
}
