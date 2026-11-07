// S-08: migrations com SQL cru (triggers PL/pgSQL e índice único parcial), up e down. Spike descartável.
import { Migration } from '@mikro-orm/migrations';

export class Migration20261107000100 extends Migration {
  override up(): void {
    this.addSql(`create table spike_wallets (
      id uuid primary key,
      player_id varchar(255) not null,
      currency char(3) not null,
      balance numeric(18,2) not null,
      version integer not null,
      constraint spike_wallets_balance_ck check (balance >= 0),
      constraint spike_wallets_player_currency_uq unique (player_id, currency)
    )`);
    this.addSql(`create table spike_tx (
      id uuid primary key,
      idempotency_key varchar(255) not null,
      kind varchar(16) not null,
      status varchar(24) not null,
      reference_transaction_id uuid,
      constraint spike_tx_idempotency_key_uq unique (idempotency_key)
    )`);
    this.addSql(`create unique index spike_tx_single_reversal_uq on spike_tx (reference_transaction_id)
      where kind in ('REFUND','ROLLBACK') and status = 'PROCESSED'`);
    this.addSql(`create table spike_ledger (
      seq bigint generated always as identity,
      id uuid primary key,
      wallet_id uuid not null,
      amount numeric(18,2) not null,
      constraint spike_ledger_seq_uq unique (seq)
    )`);
  }

  override down(): void {
    this.addSql('drop table spike_ledger');
    this.addSql('drop table spike_tx');
    this.addSql('drop table spike_wallets');
  }
}

export class Migration20261107000200 extends Migration {
  override up(): void {
    this.addSql(`create function spike_forbid_mutation() returns trigger language plpgsql as $$
      begin
        raise exception '%_immutable: % is not allowed', tg_table_name, tg_op using errcode = 'P0001';
      end $$`);
    this.addSql(`create trigger spike_ledger_no_update_delete_trg before update or delete on spike_ledger
      for each row execute function spike_forbid_mutation()`);
    this.addSql(`create trigger spike_ledger_no_truncate_trg before truncate on spike_ledger
      for each statement execute function spike_forbid_mutation()`);
  }

  override down(): void {
    this.addSql('drop trigger spike_ledger_no_truncate_trg on spike_ledger');
    this.addSql('drop trigger spike_ledger_no_update_delete_trg on spike_ledger');
    this.addSql('drop function spike_forbid_mutation()');
  }
}

export const MIGRATIONS = [
  { name: 'Migration20261107000100', class: Migration20261107000100 },
  { name: 'Migration20261107000200', class: Migration20261107000200 },
];
