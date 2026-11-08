// T014 — failpoints (I-40, research R-16).
import { expect, test } from 'bun:test';
import { EnvFailpoints, FailpointError } from '../../src/platform/failpoints/failpoints.ts';

function exitSpy() {
  const calls: number[] = [];
  return { calls, exit: (code: number) => void calls.push(code) };
}

test('after_ledger_insert_before_commit lança FailpointError quando ativo', () => {
  const { exit, calls } = exitSpy();
  const fp = new EnvFailpoints({ failpoint: 'after_ledger_insert_before_commit', nodeEnv: 'development', exit });
  expect(() => fp.hit('after_ledger_insert_before_commit')).toThrow(FailpointError);
  expect(calls).toEqual([]);
});

test('after_commit_before_response chama o exit injetado quando ativo', () => {
  const { exit, calls } = exitSpy();
  const fp = new EnvFailpoints({ failpoint: 'after_commit_before_response', nodeEnv: 'test', exit });
  fp.hit('after_commit_before_response');
  expect(calls).toEqual([1]);
});

test('outros nomes não fazem nada', () => {
  const { exit, calls } = exitSpy();
  const fp = new EnvFailpoints({ failpoint: 'after_ledger_insert_before_commit', nodeEnv: 'development', exit });
  expect(() => fp.hit('after_commit_before_response')).not.toThrow();
  expect(calls).toEqual([]);
});

test('sem FAILPOINT nada dispara', () => {
  const { exit, calls } = exitSpy();
  const fp = new EnvFailpoints({ failpoint: undefined, nodeEnv: 'development', exit });
  expect(() => fp.hit('after_ledger_insert_before_commit')).not.toThrow();
  fp.hit('after_commit_before_response');
  expect(calls).toEqual([]);
});

test('com NODE_ENV=production nenhum failpoint dispara', () => {
  const { exit, calls } = exitSpy();
  for (const name of ['after_ledger_insert_before_commit', 'after_commit_before_response'] as const) {
    const fp = new EnvFailpoints({ failpoint: name, nodeEnv: 'production', exit });
    expect(() => fp.hit(name)).not.toThrow();
  }
  expect(calls).toEqual([]);
});

test('modo serialization_failure_once: na 1ª passagem lança erro com SQLSTATE 40001 (classificado como retry); depois não faz nada', async () => {
  const { classifyDbError } = await import('../../src/platform/persistence/pg-errors.ts');
  const { exit, calls } = exitSpy();
  const fp = new EnvFailpoints({
    failpoint: 'after_ledger_insert_before_commit:serialization_failure_once',
    nodeEnv: 'test',
    exit,
  });
  let thrown: unknown;
  try {
    fp.hit('after_ledger_insert_before_commit');
  } catch (error) {
    thrown = error;
  }
  expect((thrown as { code?: string }).code).toBe('40001');
  expect(classifyDbError(thrown)).toBe('retry');
  expect(() => fp.hit('after_ledger_insert_before_commit')).not.toThrow();
  expect(() => fp.hit('after_ledger_insert_before_commit')).not.toThrow();
  expect(fp.triggered('after_ledger_insert_before_commit')).toBe(1);
  expect(fp.passes('after_ledger_insert_before_commit')).toBe(3);
  expect(calls).toEqual([]);
});

test('modo desconhecido ou nome desconhecido no FAILPOINT é recusado no boot', () => {
  expect(() => new EnvFailpoints({ failpoint: 'after_ledger_insert_before_commit:explode', nodeEnv: 'test' })).toThrow();
  expect(() => new EnvFailpoints({ failpoint: 'nao_existe', nodeEnv: 'test' })).toThrow();
});

test('NODE_ENV=production também desliga o modo serialization_failure_once', () => {
  const fp = new EnvFailpoints({ failpoint: 'after_ledger_insert_before_commit:serialization_failure_once', nodeEnv: 'production' });
  expect(() => fp.hit('after_ledger_insert_before_commit')).not.toThrow();
  expect(fp.triggered('after_ledger_insert_before_commit')).toBe(0);
});

test('modo reversal_unique_violation_once: na 1ª passagem lança 23505 de wager_tx_single_reversal_uq (reversal-race); depois nada', async () => {
  const { classifyDbError } = await import('../../src/platform/persistence/pg-errors.ts');
  const fp = new EnvFailpoints({ failpoint: 'after_reversal_insert_before_commit:reversal_unique_violation_once', nodeEnv: 'test' });
  let thrown: unknown;
  try {
    fp.hit('after_reversal_insert_before_commit');
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toMatchObject({ code: '23505', constraint: 'wager_tx_single_reversal_uq' });
  expect(classifyDbError(thrown)).toBe('reversal-race');
  expect(() => fp.hit('after_reversal_insert_before_commit')).not.toThrow();
  expect(() => fp.hit('after_ledger_insert_before_commit')).not.toThrow();
  expect(fp.triggered('after_reversal_insert_before_commit')).toBe(1);
  expect(fp.passes('after_reversal_insert_before_commit')).toBe(2);
});

test('modo reversal_unique_violation_always: lança em toda passagem', () => {
  const fp = new EnvFailpoints({ failpoint: 'after_reversal_insert_before_commit:reversal_unique_violation_always', nodeEnv: 'test' });
  for (let i = 0; i < 3; i++) expect(() => fp.hit('after_reversal_insert_before_commit')).toThrow(/23505/);
  expect(fp.triggered('after_reversal_insert_before_commit')).toBe(3);
});

test('after_reversal_insert_before_commit no modo padrão lança FailpointError; NODE_ENV=production desliga', () => {
  expect(() => new EnvFailpoints({ failpoint: 'after_reversal_insert_before_commit', nodeEnv: 'test' }).hit('after_reversal_insert_before_commit')).toThrow(
    FailpointError,
  );
  const off = new EnvFailpoints({ failpoint: 'after_reversal_insert_before_commit:reversal_unique_violation_always', nodeEnv: 'production' });
  expect(() => off.hit('after_reversal_insert_before_commit')).not.toThrow();
});
