/** Direção de um lançamento do ledger (enunciado §6.4). */
export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export function isLedgerDirection(value: unknown): value is LedgerDirection {
  return value === LedgerDirection.Debit || value === LedgerDirection.Credit;
}
