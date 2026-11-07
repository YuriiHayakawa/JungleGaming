import { Migration } from '@mikro-orm/migrations';

/** Funções e triggers de guarda (data-model §2.5; FR-009, FR-028, FR-041, FR-042, SC-008). */
export class Migration20261107000400 extends Migration {
  override up(): void {
    this.addSql(`CREATE FUNCTION jg_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%_immutable: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'P0001';
END $$`);

    this.addSql(`CREATE TRIGGER ledger_no_update_delete_trg BEFORE UPDATE OR DELETE ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION jg_forbid_mutation()`);
    this.addSql(`CREATE TRIGGER ledger_no_truncate_trg BEFORE TRUNCATE ON wallet_ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION jg_forbid_mutation()`);

    this.addSql(`CREATE FUNCTION jg_ledger_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  tx             record;
  ref_direction  varchar(6);
  last_after     numeric(18,2);
  wallet_balance numeric(18,2);
BEGIN
  SELECT status, kind, reference_transaction_id INTO tx
    FROM wager_transactions WHERE id = NEW.transaction_id;
  IF tx.status <> 'PROCESSED' OR tx.kind = 'LOSS' THEN
    RAISE EXCEPTION 'ledger_requires_processed_movement' USING ERRCODE = 'P0001';
  END IF;
  IF (tx.kind = 'BET' AND NEW.direction <> 'DEBIT')
     OR (tx.kind IN ('WIN','REFUND','OPENING') AND NEW.direction <> 'CREDIT') THEN
    RAISE EXCEPTION 'ledger_direction_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF tx.kind = 'ROLLBACK' THEN
    -- wallet_id + transaction_id usa o índice de ledger_wallet_tx_uq; uma reversão válida é sempre da mesma
    -- wallet (REFERENCE_MISMATCH barra o resto), então a direção da referência está nessa wallet.
    SELECT direction INTO ref_direction
      FROM wallet_ledger_entries
     WHERE wallet_id = NEW.wallet_id AND transaction_id = tx.reference_transaction_id;
    IF ref_direction IS NULL OR NEW.direction = ref_direction THEN
      RAISE EXCEPTION 'ledger_rollback_direction_mismatch' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  SELECT balance_after INTO last_after
    FROM wallet_ledger_entries WHERE wallet_id = NEW.wallet_id ORDER BY seq DESC LIMIT 1;
  IF NEW.balance_before <> COALESCE(last_after, 0) THEN
    RAISE EXCEPTION 'ledger_chain_broken' USING ERRCODE = 'P0001';
  END IF;
  SELECT balance INTO wallet_balance FROM wallets WHERE id = NEW.wallet_id;
  IF NEW.balance_after <> wallet_balance THEN
    RAISE EXCEPTION 'ledger_wallet_balance_mismatch' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$`);
    this.addSql(`CREATE TRIGGER ledger_before_insert_trg BEFORE INSERT ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION jg_ledger_before_insert()`);

    this.addSql(`CREATE FUNCTION jg_wallet_matches_ledger_tail() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_balance numeric(18,2);
  last_after      numeric(18,2);
BEGIN
  SELECT balance INTO current_balance FROM wallets WHERE id = NEW.id;
  SELECT balance_after INTO last_after
    FROM wallet_ledger_entries WHERE wallet_id = NEW.id ORDER BY seq DESC LIMIT 1;
  IF current_balance <> COALESCE(last_after, 0) THEN
    RAISE EXCEPTION 'wallet_ledger_tail_mismatch' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$`);
    this.addSql(`CREATE CONSTRAINT TRIGGER wallets_match_ledger_tail_trg
  AFTER INSERT OR UPDATE OF balance ON wallets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION jg_wallet_matches_ledger_tail()`);

    this.addSql(`CREATE FUNCTION jg_wallets_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'wallets_immutable: DELETE is not allowed' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.id, NEW.player_id, NEW.currency, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.player_id, OLD.currency, OLD.created_at) THEN
    RAISE EXCEPTION 'wallets_identity_changed' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.balance <> OLD.balance AND NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'wallets_version_must_increment' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.balance = OLD.balance AND NEW.version <> OLD.version THEN
    RAISE EXCEPTION 'wallets_version_without_balance_change' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$`);
    this.addSql(`CREATE TRIGGER wallets_guard_trg BEFORE UPDATE OR DELETE ON wallets
  FOR EACH ROW EXECUTE FUNCTION jg_wallets_guard()`);

    this.addSql(`CREATE FUNCTION jg_wager_tx_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'wager_transactions_immutable: DELETE is not allowed' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
    RAISE EXCEPTION 'wager_tx_terminal_state' USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
      NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
      NEW.reference_external_transaction_id, NEW.correlation_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash,
      OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency,
      OLD.reference_external_transaction_id, OLD.correlation_id, OLD.created_at) THEN
    RAISE EXCEPTION 'wager_tx_identity_changed' USING ERRCODE = 'P0001';
  END IF;
  IF NOT (
       (OLD.status = 'PENDING' AND NEW.status IN ('PROCESSED','REJECTED','PENDING_REFERENCE','FAILED'))
    OR (OLD.status = 'PENDING_REFERENCE'
        AND NEW.status IN ('PENDING_REFERENCE','PROCESSED','REJECTED','FAILED'))) THEN
    RAISE EXCEPTION 'wager_tx_invalid_transition' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$`);
    this.addSql(`CREATE TRIGGER wager_tx_guard_trg BEFORE UPDATE OR DELETE ON wager_transactions
  FOR EACH ROW EXECUTE FUNCTION jg_wager_tx_guard()`);
    this.addSql(`CREATE TRIGGER wager_tx_no_truncate_trg BEFORE TRUNCATE ON wager_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION jg_forbid_mutation()`);
  }

  override down(): void {
    this.addSql('DROP TRIGGER wager_tx_no_truncate_trg ON wager_transactions');
    this.addSql('DROP TRIGGER wager_tx_guard_trg ON wager_transactions');
    this.addSql('DROP FUNCTION jg_wager_tx_guard()');
    this.addSql('DROP TRIGGER wallets_guard_trg ON wallets');
    this.addSql('DROP FUNCTION jg_wallets_guard()');
    this.addSql('DROP TRIGGER wallets_match_ledger_tail_trg ON wallets');
    this.addSql('DROP FUNCTION jg_wallet_matches_ledger_tail()');
    this.addSql('DROP TRIGGER ledger_before_insert_trg ON wallet_ledger_entries');
    this.addSql('DROP FUNCTION jg_ledger_before_insert()');
    this.addSql('DROP TRIGGER ledger_no_truncate_trg ON wallet_ledger_entries');
    this.addSql('DROP TRIGGER ledger_no_update_delete_trg ON wallet_ledger_entries');
    this.addSql('DROP FUNCTION jg_forbid_mutation()');
  }
}
