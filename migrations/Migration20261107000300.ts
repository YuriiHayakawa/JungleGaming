import { Migration } from '@mikro-orm/migrations';

/** outbox_messages (data-model §2.4; enunciado §6.5). */
export class Migration20261107000300 extends Migration {
  override up(): void {
    this.addSql(`CREATE TABLE outbox_messages (
  id               uuid          PRIMARY KEY,
  aggregate_id     uuid          NOT NULL,
  event_type       varchar(64)   NOT NULL,
  event_version    integer       NOT NULL,
  payload          jsonb         NOT NULL,
  correlation_id   varchar(128)  NOT NULL,
  occurred_at      timestamptz   NOT NULL,
  attempts         integer       NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz   NOT NULL,
  published_at     timestamptz,
  CONSTRAINT outbox_event_type_ck CHECK (event_type IN (
    'WagerTransactionProcessed','WagerTransactionRejected','WalletBalanceChanged',
    'WagerTransactionPendingReference')),
  CONSTRAINT outbox_event_version_ck CHECK (event_version >= 1),
  CONSTRAINT outbox_attempts_ck      CHECK (attempts >= 0)
)`);

    this.addSql('CREATE INDEX outbox_pending_idx ON outbox_messages (next_attempt_at) WHERE published_at IS NULL');
  }

  override down(): void {
    this.addSql('DROP TABLE outbox_messages');
  }
}
