import type { EntityManager } from '@mikro-orm/postgresql';
import type { InboxMessage } from '../domain/inbox-message.ts';
import { InboxMessageMapper } from './inbox-message.mapper.ts';
import { InboxMessageRecord } from './inbox-message.schema.ts';

/**
 * Repositório da inbox (I-28). EM por chamada (001, R-19): dentro de uma transação, sempre o EM da transação, para que
 * a linha entre no mesmo commit do efeito ou do replay. A unicidade é do banco (`inbox_messages_pk`): a violação 23505
 * é tratada por quem chama, pelo nome da constraint (`inbox-race`, R-22).
 */
export class MikroOrmInboxRepository {
  async insert(em: EntityManager, message: InboxMessage): Promise<void> {
    await em.insert(InboxMessageRecord, InboxMessageMapper.toRecord(message));
  }

  async findByConsumerAndMessageId(em: EntityManager, consumerName: string, messageId: string): Promise<InboxMessage | null> {
    const record = await em.findOne(InboxMessageRecord, { consumerName, messageId });
    return record ? InboxMessageMapper.toDomain(record) : null;
  }
}
