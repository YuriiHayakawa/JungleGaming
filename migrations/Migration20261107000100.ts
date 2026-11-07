import { Migration } from '@mikro-orm/migrations';

/** wallets e wager_transactions (data-model §2.1 e §2.2; I-16, I-24, I-56). */
export class Migration20261107000100 extends Migration {
  override up(): void {
    this.addSql(`CREATE TABLE wallets (
  id          uuid          PRIMARY KEY,
  player_id   varchar(255)  NOT NULL,
  currency    char(3)       NOT NULL,
  balance     numeric(18,2) NOT NULL,
  version     integer       NOT NULL,
  created_at  timestamptz   NOT NULL,
  updated_at  timestamptz   NOT NULL,
  CONSTRAINT wallets_player_id_len_ck     CHECK (length(player_id) BETWEEN 1 AND 255),
  CONSTRAINT wallets_currency_ck          CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT wallets_balance_non_neg_ck   CHECK (balance >= 0),
  CONSTRAINT wallets_version_ck           CHECK (version >= 1),
  CONSTRAINT wallets_player_currency_uq   UNIQUE (player_id, currency),
  CONSTRAINT wallets_id_currency_uq       UNIQUE (id, currency)
)`);

    this.addSql(`CREATE TABLE wager_transactions (
  id                                 uuid          PRIMARY KEY,
  provider_id                        varchar(255)  NOT NULL,
  external_transaction_id            varchar(255)  NOT NULL,
  idempotency_key                    varchar(255)  NOT NULL,
  payload_hash                       char(64)      NOT NULL,
  wallet_id                          uuid          NOT NULL REFERENCES wallets (id),
  player_id                          varchar(255)  NOT NULL,
  round_id                           varchar(255)  NOT NULL,
  game_id                            varchar(255)  NOT NULL,
  kind                               varchar(16)   NOT NULL,
  amount                             numeric(18,2) NOT NULL,
  currency                           char(3)       NOT NULL,
  reference_external_transaction_id  varchar(255),
  reference_transaction_id           uuid          REFERENCES wager_transactions (id),
  status                             varchar(24)   NOT NULL,
  failure_code                       varchar(48),
  observed_balance                   numeric(18,2),
  observed_balance_currency          char(3),
  correlation_id                     varchar(128)  NOT NULL,
  reference_attempts                 integer       NOT NULL DEFAULT 0,
  next_reference_attempt_at          timestamptz,
  created_at                         timestamptz   NOT NULL,
  processed_at                       timestamptz,
  updated_at                         timestamptz   NOT NULL,

  CONSTRAINT wager_tx_provider_idempotency_uq UNIQUE (provider_id, idempotency_key),
  CONSTRAINT wager_tx_provider_external_uq UNIQUE (provider_id, external_transaction_id),
  CONSTRAINT wager_tx_ledger_key_uq        UNIQUE (id, wallet_id, currency, amount),

  CONSTRAINT wager_tx_kind_ck     CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
  CONSTRAINT wager_tx_status_ck   CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
  CONSTRAINT wager_tx_currency_ck CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT wager_tx_hash_ck     CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT wager_tx_amount_ck   CHECK (amount > 0 OR (kind = 'LOSS' AND amount = 0)),
  CONSTRAINT wager_tx_opening_identity_ck CHECK ((kind = 'OPENING') = (provider_id = 'system')),
  CONSTRAINT wager_tx_reference_by_kind_ck CHECK (
       (kind IN ('REFUND','ROLLBACK') AND reference_external_transaction_id IS NOT NULL)
    OR (kind IN ('BET','OPENING')     AND reference_external_transaction_id IS NULL)
    OR  kind IN ('WIN','LOSS')),
  CONSTRAINT wager_tx_resolved_reference_ck CHECK (
    reference_transaction_id IS NULL OR reference_external_transaction_id IS NOT NULL),
  CONSTRAINT wager_tx_processed_reversal_ck CHECK (
    NOT (kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED') OR reference_transaction_id IS NOT NULL),
  CONSTRAINT wager_tx_failure_code_ck CHECK (
       (status IN ('REJECTED','FAILED') AND failure_code IS NOT NULL)
    OR (status IN ('PENDING','PENDING_REFERENCE','PROCESSED') AND failure_code IS NULL)),
  CONSTRAINT wager_tx_failure_code_value_ck CHECK (failure_code IS NULL OR failure_code IN (
    'INSUFFICIENT_FUNDS','REVERSAL_WOULD_OVERDRAW','BALANCE_LIMIT_EXCEEDED','REFERENCE_NOT_FOUND','REFERENCE_REJECTED',
    'REFERENCE_MISMATCH','INVALID_REFERENCE_KIND','ALREADY_REVERSED','AMOUNT_MISMATCH',
    'CURRENCY_MISMATCH','WALLET_PLAYER_MISMATCH','INTERNAL_ERROR')),
  CONSTRAINT wager_tx_processed_at_ck CHECK (status <> 'PROCESSED' OR processed_at IS NOT NULL),
  CONSTRAINT wager_tx_observed_balance_ck CHECK (
       status IN ('PENDING','FAILED')
    OR (observed_balance IS NOT NULL AND observed_balance >= 0 AND observed_balance_currency IS NOT NULL)),
  CONSTRAINT wager_tx_attempts_ck CHECK (reference_attempts >= 0)
)`);

    this.addSql(`CREATE UNIQUE INDEX wager_tx_single_reversal_uq
  ON wager_transactions (reference_transaction_id)
  WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'`);
  }

  override down(): void {
    this.addSql('DROP TABLE wager_transactions');
    this.addSql('DROP TABLE wallets');
  }
}
