import { Migration } from '@mikro-orm/migrations';

/** wallet_ledger_entries (data-model §2.3; I-36). */
export class Migration20261107000200 extends Migration {
  override up(): void {
    this.addSql(`CREATE TABLE wallet_ledger_entries (
  seq             bigint        GENERATED ALWAYS AS IDENTITY,
  id              uuid          PRIMARY KEY,
  wallet_id       uuid          NOT NULL,
  transaction_id  uuid          NOT NULL,
  direction       varchar(6)    NOT NULL,
  amount          numeric(18,2) NOT NULL,
  currency        char(3)       NOT NULL,
  balance_before  numeric(18,2) NOT NULL,
  balance_after   numeric(18,2) NOT NULL,
  created_at      timestamptz   NOT NULL,

  CONSTRAINT ledger_seq_uq            UNIQUE (seq),
  CONSTRAINT ledger_wallet_tx_uq      UNIQUE (wallet_id, transaction_id),
  CONSTRAINT ledger_direction_ck      CHECK (direction IN ('DEBIT','CREDIT')),
  CONSTRAINT ledger_amount_ck         CHECK (amount > 0),
  CONSTRAINT ledger_balance_after_ck  CHECK (balance_after >= 0),
  CONSTRAINT ledger_balance_before_ck CHECK (balance_before >= 0),
  CONSTRAINT ledger_arithmetic_ck     CHECK (
       (direction = 'CREDIT' AND balance_after = balance_before + amount)
    OR (direction = 'DEBIT'  AND balance_after = balance_before - amount)),
  CONSTRAINT ledger_wallet_fk FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency),
  CONSTRAINT ledger_transaction_fk FOREIGN KEY (transaction_id, wallet_id, currency, amount)
    REFERENCES wager_transactions (id, wallet_id, currency, amount)
)`);

    this.addSql('CREATE INDEX ledger_wallet_seq_idx ON wallet_ledger_entries (wallet_id, seq)');
  }

  override down(): void {
    this.addSql('DROP TABLE wallet_ledger_entries');
  }
}
