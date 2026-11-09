import { Migration } from '@mikro-orm/migrations';

/** Índices parciais do worker de PENDING_REFERENCE (feature 002; data-model §2.2; FR-023, FR-026, I-63). */
export class Migration20261108000200 extends Migration {
  override up(): void {
    // Claim do worker: pendentes vencidas, em ordem de vencimento e criação.
    this.addSql(`CREATE INDEX wager_tx_pending_due_idx
  ON wager_transactions (next_reference_attempt_at, created_at)
  WHERE status = 'PENDING_REFERENCE'`);
    // Antecipação e irmãs mais antigas: pendentes que referenciam (provider, id externo).
    this.addSql(`CREATE INDEX wager_tx_pending_by_reference_idx
  ON wager_transactions (provider_id, reference_external_transaction_id, created_at)
  WHERE status = 'PENDING_REFERENCE'`);
  }

  override down(): void {
    this.addSql('DROP INDEX wager_tx_pending_by_reference_idx');
    this.addSql('DROP INDEX wager_tx_pending_due_idx');
  }
}
