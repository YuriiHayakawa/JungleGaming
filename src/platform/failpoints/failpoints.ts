/** Failpoints de teste (I-40, research R-16). No-op quando NODE_ENV=production. */
export const FAILPOINTS = Symbol('FAILPOINTS');

export type FailpointName = 'after_ledger_insert_before_commit' | 'after_commit_before_response';

const NAMES: readonly FailpointName[] = ['after_ledger_insert_before_commit', 'after_commit_before_response'];

/**
 * Modo do failpoint, escrito como `FAILPOINT=<nome>[:<modo>]`:
 * - padrão: `after_ledger_insert_before_commit` lança FailpointError; `after_commit_before_response` encerra o processo;
 * - `serialization_failure_once`: na 1ª passagem lança um erro com SQLSTATE 40001 (falha de serialização, que a unit
 *   of work repete, R-12); nas seguintes não faz nada. Prova que a repetição recomeça do zero.
 */
type FailpointMode = 'default' | 'serialization_failure_once';
const MODES: readonly FailpointMode[] = ['default', 'serialization_failure_once'];

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
    this.triggerCount += 1;
    if (name === 'after_commit_before_response') {
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
