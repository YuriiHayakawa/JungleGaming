import { Migration } from '@mikro-orm/migrations';

/**
 * inbox_messages (feature 002; data-model §2.1; enunciado §6.5; I-28, I-69). A linha é a prova de que a mensagem foi
 * tratada: gravada já processada, na mesma transação do efeito ou do replay, e imutável depois disso.
 */
export class Migration20261108000100 extends Migration {
  override up(): void {
    this.addSql(`CREATE TABLE inbox_messages (
  consumer_name   varchar(64)  NOT NULL,
  message_id      varchar(128) NOT NULL,
  payload_hash    char(64)     NOT NULL,
  transaction_id  uuid         NOT NULL REFERENCES wager_transactions (id),
  received_at     timestamptz  NOT NULL,
  processed_at    timestamptz  NOT NULL,
  CONSTRAINT inbox_messages_pk           PRIMARY KEY (consumer_name, message_id),
  CONSTRAINT inbox_consumer_name_ck      CHECK (length(consumer_name) BETWEEN 1 AND 64),
  CONSTRAINT inbox_message_id_ck         CHECK (message_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT inbox_payload_hash_ck       CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT inbox_processed_after_ck    CHECK (processed_at >= received_at)
)`);
    this.addSql('CREATE INDEX inbox_transaction_idx ON inbox_messages (transaction_id)');
    this.addSql(`CREATE TRIGGER inbox_no_update_delete_trg BEFORE UPDATE OR DELETE ON inbox_messages
  FOR EACH ROW EXECUTE FUNCTION jg_forbid_mutation()`);
    this.addSql(`CREATE TRIGGER inbox_no_truncate_trg BEFORE TRUNCATE ON inbox_messages
  FOR EACH STATEMENT EXECUTE FUNCTION jg_forbid_mutation()`);
  }

  override down(): void {
    this.addSql('DROP TRIGGER inbox_no_truncate_trg ON inbox_messages');
    this.addSql('DROP TRIGGER inbox_no_update_delete_trg ON inbox_messages');
    this.addSql('DROP TABLE inbox_messages');
  }
}
