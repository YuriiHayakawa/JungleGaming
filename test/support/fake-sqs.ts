// SqsPort em memória — SÓ PARA TESTES UNITÁRIOS (test/unit/**).
// É PROIBIDO importá-lo em test/integration/** e test/concurrency/**: lá a fila é sempre o MiniStack real
// (constitution VII, falha eliminatória 8; tasks, "Convenções"; verificado pelo guardrail do T084).
import type {
  QueueCounts,
  ReceiveOptions,
  SendOptions,
  SqsMessage,
  SqsPort,
} from '../../src/messaging/application/sqs.port.ts';

interface StoredMessage {
  sqsMessageId: string;
  body: string;
  groupId: string;
  attributes: Record<string, string>;
  receiveCount: number;
  invisibleUntil: number;
  receiptHandle: string | undefined;
}

export type FakeSqsOperation = 'receive' | 'delete' | 'changeVisibility' | 'send';

export interface FakeSqsCall {
  op: FakeSqsOperation;
  queue: string;
  receiptHandle?: string;
  seconds?: number;
  options?: SendOptions;
}

/**
 * Fila FIFO em memória com visibilidade, `receiveCount`, grupo bloqueado enquanto uma mensagem dele está em voo e
 * registro de todas as chamadas (para conferir a ordem: DLQ antes do delete, ack depois do processamento).
 */
export class FakeSqs implements SqsPort {
  readonly calls: FakeSqsCall[] = [];
  private readonly queues = new Map<string, StoredMessage[]>();
  private readonly failures = new Map<FakeSqsOperation, unknown[]>();
  private sequence = 0;

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** Coloca uma mensagem na fila (como o provedor faria). */
  enqueue(queue: string, message: { body: string; groupId: string; attributes?: Record<string, string> }): string {
    this.sequence += 1;
    const id = `fake-${this.sequence}`;
    this.list(queue).push({
      sqsMessageId: id,
      body: message.body,
      groupId: message.groupId,
      attributes: { ...(message.attributes ?? {}) },
      receiveCount: 0,
      invisibleUntil: 0,
      receiptHandle: undefined,
    });
    return id;
  }

  /** A próxima chamada de `op` rejeita com `error` (uma vez por erro enfileirado). */
  failNext(op: FakeSqsOperation, error: unknown = new Error(`fake ${op} failure`)): void {
    const list = this.failures.get(op) ?? [];
    list.push(error);
    this.failures.set(op, list);
  }

  /** Mensagens ainda na fila (visíveis ou em voo). */
  messages(queue: string): Array<{ body: string; groupId: string; receiveCount: number; attributes: Record<string, string> }> {
    return this.list(queue).map((m) => ({ body: m.body, groupId: m.groupId, receiveCount: m.receiveCount, attributes: m.attributes }));
  }

  async receive(queue: string, options: ReceiveOptions): Promise<SqsMessage[]> {
    this.calls.push({ op: 'receive', queue });
    this.maybeFail('receive');
    const now = this.now();
    const blockedGroups = new Set(this.list(queue).filter((m) => m.invisibleUntil > now).map((m) => m.groupId));
    const out: SqsMessage[] = [];
    for (const message of this.list(queue)) {
      if (out.length >= options.max) break;
      if (message.invisibleUntil > now || blockedGroups.has(message.groupId)) continue;
      // FIFO: um grupo com mensagem em voo antes deste recebimento fica bloqueado; as do mesmo grupo saem em ordem.
      message.receiveCount += 1;
      this.sequence += 1;
      message.receiptHandle = `rh-${this.sequence}`;
      message.invisibleUntil = now + (options.visibilitySeconds ?? 30) * 1000;
      out.push({
        sqsMessageId: message.sqsMessageId,
        receiptHandle: message.receiptHandle,
        body: message.body,
        receiveCount: message.receiveCount,
        groupId: message.groupId,
        attributes: { ...message.attributes },
      });
    }
    return out;
  }

  async delete(queue: string, receiptHandle: string): Promise<void> {
    this.calls.push({ op: 'delete', queue, receiptHandle });
    this.maybeFail('delete');
    const list = this.list(queue);
    const index = list.findIndex((m) => m.receiptHandle === receiptHandle);
    if (index >= 0) list.splice(index, 1);
  }

  async changeVisibility(queue: string, receiptHandle: string, seconds: number): Promise<void> {
    this.calls.push({ op: 'changeVisibility', queue, receiptHandle, seconds });
    this.maybeFail('changeVisibility');
    const message = this.list(queue).find((m) => m.receiptHandle === receiptHandle);
    if (message) message.invisibleUntil = this.now() + seconds * 1000;
  }

  async send(queue: string, options: SendOptions): Promise<void> {
    this.calls.push({ op: 'send', queue, options });
    this.maybeFail('send');
    this.enqueue(queue, { body: options.body, groupId: options.groupId, attributes: options.attributes ?? {} });
  }

  async approximateCounts(queue: string): Promise<QueueCounts> {
    const now = this.now();
    const list = this.list(queue);
    return {
      visible: list.filter((m) => m.invisibleUntil <= now).length,
      notVisible: list.filter((m) => m.invisibleUntil > now).length,
    };
  }

  private list(queue: string): StoredMessage[] {
    let list = this.queues.get(queue);
    if (!list) {
      list = [];
      this.queues.set(queue, list);
    }
    return list;
  }

  private maybeFail(op: FakeSqsOperation): void {
    const pending = this.failures.get(op);
    if (pending && pending.length > 0) throw pending.shift();
  }
}
