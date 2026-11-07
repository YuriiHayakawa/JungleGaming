import type { EntityManager } from '@mikro-orm/postgresql';
import type { OutboxMessage } from '../domain/outbox-message.ts';
import { OutboxMessageMapper } from './outbox-message.mapper.ts';
import { OutboxMessageRecord } from './outbox-message.schema.ts';

/**
 * Grava eventos na outbox pelo EntityManager recebido, que é o da transação do efeito (R-15, R-19): a outbox entra
 * no mesmo commit. Insere um a um, na ordem recebida (ex.: WalletBalanceChanged antes do evento de status).
 * Nada é publicado aqui (FR-048).
 */
export class MikroOrmOutboxWriter {
  async append(em: EntityManager, messages: readonly OutboxMessage[]): Promise<void> {
    for (const message of messages) {
      await em.insert(OutboxMessageRecord, OutboxMessageMapper.toRecord(message));
    }
  }
}
