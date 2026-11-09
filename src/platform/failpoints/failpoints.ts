/** Failpoints de teste (I-40, research R-16). No-op quando NODE_ENV=production. */
export const FAILPOINTS = Symbol('FAILPOINTS');

/**
 * Pontos de falha:
 * - `after_ledger_insert_before_commit`: em toda submissão nova, depois das escritas e antes do commit;
 * - `after_reversal_insert_before_commit`: só quando uma reversão (REFUND/ROLLBACK) é aplicada, depois das escritas e
 *   antes do commit (T096);
 * - `after_commit_before_response`: depois do commit de um efeito novo, antes da resposta.
 * Feature 002 (R-29):
 * - `after_commit_before_ack`: consumidor, depois do commit e antes do DeleteMessage;
 * - `before_publish_mark`: publicador, depois do SendMessage aceito e antes da marca de publicado;
 * - `after_pending_resolution_before_commit`: worker de PENDING_REFERENCE, antes do commit da reavaliação.
 */
export type FailpointName =
  | 'after_ledger_insert_before_commit'
  | 'after_reversal_insert_before_commit'
  | 'after_commit_before_response'
  | 'after_commit_before_ack'
  | 'before_publish_mark'
  | 'after_pending_resolution_before_commit';

const NAMES: readonly FailpointName[] = [
  'after_ledger_insert_before_commit',
  'after_reversal_insert_before_commit',
  'after_commit_before_response',
  'after_commit_before_ack',
  'before_publish_mark',
  'after_pending_resolution_before_commit',
];

/** Failpoints cujo modo padrão encerra o processo (queda real, não exceção). */
const EXITING: ReadonlySet<FailpointName> = new Set<FailpointName>([
  'after_commit_before_response',
  'after_commit_before_ack',
  'before_publish_mark',
]);

/**
 * Modo do failpoint, escrito como `FAILPOINT=<nome>[:<modo>]`:
 * - padrão: `after_commit_before_response` encerra o processo; os demais lançam FailpointError;
 * - `serialization_failure_once`: na 1ª passagem lança um erro com SQLSTATE 40001 (falha de serialização, que a unit
 *   of work repete, R-12); nas seguintes não faz nada. Prova que a repetição recomeça do zero.
 * - `reversal_unique_violation_once`: na 1ª passagem lança um erro no formato da violação do índice
 *   `wager_tx_single_reversal_uq` (SQLSTATE 23505), que o use case repete uma vez (R-12, T096); depois não faz nada.
 * - `reversal_unique_violation_always`: o mesmo erro em toda passagem; prova que a 2ª violação vira 500.
 * - `invariant_violation` (002, R-29): em toda passagem lança um erro com SQLSTATE P0001, que o classificador trata
 *   como quebra de invariante; prova o FAILED do worker de PENDING_REFERENCE (FR-029) sem mock.
 */
type FailpointMode =
  | 'default'
  | 'serialization_failure_once'
  | 'reversal_unique_violation_once'
  | 'reversal_unique_violation_always'
  | 'invariant_violation';
const MODES: readonly FailpointMode[] = [
  'default',
  'serialization_failure_once',
  'reversal_unique_violation_once',
  'reversal_unique_violation_always',
  'invariant_violation',
];

export interface Failpoints {
  hit(name: FailpointName): void;
}

export class FailpointError extends Error {
  constructor(readonly failpoint: FailpointName) {
    super(`failpoint triggered: ${failpoint}`);
    this.name = 'FailpointError';
  }
}

/** Erro de teste no formato de um erro do driver com SQLSTATE 40001 (serialization_failure). */
export class SerializationFailureFailpointError extends Error {
  readonly code = '40001';
  constructor(readonly failpoint: FailpointName) {
    super(`failpoint triggered: ${failpoint} (serialization failure, SQLSTATE 40001)`);
    this.name = 'SerializationFailureFailpointError';
  }
}

/**
 * Erro de teste no formato de uma `UniqueConstraintViolationException` do índice de reversão única: SQLSTATE 23505 e
 * `constraint` = `wager_tx_single_reversal_uq`, os dois campos que o classificador lê (R-12).
 */
export class ReversalUniqueViolationFailpointError extends Error {
  readonly code = '23505';
  readonly constraint = 'wager_tx_single_reversal_uq';
  constructor(readonly failpoint: FailpointName) {
    super(`failpoint triggered: ${failpoint} (unique violation on wager_tx_single_reversal_uq, SQLSTATE 23505)`);
    this.name = 'ReversalUniqueViolationFailpointError';
  }
}

/** Erro de teste no formato de um erro do driver com SQLSTATE P0001 (guarda do banco): quebra de invariante. */
export class InvariantViolationFailpointError extends Error {
  readonly code = 'P0001';
  constructor(readonly failpoint: FailpointName) {
    super(`failpoint triggered: ${failpoint} (invariant violation, SQLSTATE P0001)`);
    this.name = 'InvariantViolationFailpointError';
  }
}

export class EnvFailpoints implements Failpoints {
  private readonly active: FailpointName | undefined;
  private readonly mode: FailpointMode;
  private readonly exit: (code: number) => void;
  private passCount = 0;
  private triggerCount = 0;

  constructor(options: { failpoint: string | undefined; nodeEnv: string; exit?: (code: number) => void }) {
    const [name, mode = 'default'] = (options.failpoint ?? '').split(':');
    if (name && !NAMES.includes(name as FailpointName)) throw new Error(`unknown failpoint: ${name}`);
    if (!MODES.includes(mode as FailpointMode)) throw new Error(`unknown failpoint mode: ${mode}`);
    this.active = options.nodeEnv === 'production' || !name ? undefined : (name as FailpointName);
    this.mode = mode as FailpointMode;
    this.exit = options.exit ?? ((code) => process.exit(code));
  }

  hit(name: FailpointName): void {
    if (this.active !== name) return;
    this.passCount += 1;
    if (this.mode === 'serialization_failure_once') {
      if (this.triggerCount > 0) return;
      this.triggerCount += 1;
      throw new SerializationFailureFailpointError(name);
    }
    if (this.mode === 'reversal_unique_violation_once' || this.mode === 'reversal_unique_violation_always') {
      if (this.mode === 'reversal_unique_violation_once' && this.triggerCount > 0) return;
      this.triggerCount += 1;
      throw new ReversalUniqueViolationFailpointError(name);
    }
    if (this.mode === 'invariant_violation') {
      this.triggerCount += 1;
      throw new InvariantViolationFailpointError(name);
    }
    this.triggerCount += 1;
    if (EXITING.has(name)) {
      this.exit(1);
      return;
    }
    throw new FailpointError(name);
  }

  /** Quantas vezes o failpoint ativo `name` foi atravessado (só para testes). */
  passes(name: FailpointName): number {
    return this.active === name ? this.passCount : 0;
  }

  /** Quantas vezes o failpoint ativo `name` efetivamente disparou (só para testes). */
  triggered(name: FailpointName): number {
    return this.active === name ? this.triggerCount : 0;
  }
}
