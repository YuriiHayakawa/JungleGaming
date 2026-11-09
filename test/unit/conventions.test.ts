// T118 — guardrails de código: varredura estática que aponta arquivo e linha de cada violação (constitution II, V, VI
// e VII; falhas eliminatórias 1 e 8; plan, "Isolamento de testes" e "Guardrails de código").
// Cada regra é uma função pura (arquivo, código) → violações, exercitada contra o repositório real e contra trechos de
// exemplo embutidos aqui (autoteste: um que passa e um que falha). Este arquivo fica fora da varredura, porque os
// exemplos contêm de propósito os padrões proibidos.
import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';
import { posix } from 'node:path';

const ROOT = posix.join(import.meta.dir.replaceAll('\\', '/'), '..', '..');
const SELF = 'test/unit/conventions.test.ts';

interface Violation {
  file: string;
  line: number;
  rule: string;
  text: string;
}
type Rule = (file: string, source: string) => Violation[];

// ---------------------------------------------------------------------------------------------------------------
// Utilitários: comentários viram espaços (mantendo as linhas), strings e templates ficam intactos.

/**
 * Troca comentários por espaços sem mexer em strings, templates (inclusive `${...}` aninhado) nem regex literais, para
 * que um comentário que cita um padrão proibido não conte como violação e uma URL dentro de string não vire comentário.
 */
export function stripComments(source: string): string {
  const out = source.split('');
  type Frame = { kind: 'code'; depth: number } | { kind: 'template' };
  const stack: Frame[] = [{ kind: 'code', depth: 0 }];
  let lastSignificant = '';
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };
  while (i < source.length) {
    const frame = stack[stack.length - 1]!;
    const ch = source[i]!;
    const next = source[i + 1];
    if (frame.kind === 'template') {
      if (ch === '\\') i += 2;
      else if (ch === '`') {
        stack.pop();
        lastSignificant = '`';
        i += 1;
      } else if (ch === '$' && next === '{') {
        stack.push({ kind: 'code', depth: 0 });
        i += 2;
      } else i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"') {
      i += 1;
      while (i < source.length && source[i] !== ch && source[i] !== '\n') i += source[i] === '\\' ? 2 : 1;
      i += 1;
      lastSignificant = ch;
      continue;
    }
    if (ch === '`') {
      stack.push({ kind: 'template' });
      i += 1;
      continue;
    }
    if (ch === '/' && (lastSignificant === '' || '(,=:[!&|?{};+-*%<>~^'.includes(lastSignificant))) {
      // regex literal
      i += 1;
      let inClass = false;
      while (i < source.length && source[i] !== '\n') {
        const c = source[i]!;
        if (c === '\\') i += 2;
        else {
          if (c === '[') inClass = true;
          else if (c === ']') inClass = false;
          else if (c === '/' && !inClass) break;
          i += 1;
        }
      }
      i += 1;
      lastSignificant = '/';
      continue;
    }
    if (ch === '{') frame.depth += 1;
    if (ch === '}') {
      if (frame.depth === 0 && stack.length > 1) {
        stack.pop();
        i += 1;
        continue;
      }
      frame.depth -= 1;
    }
    if (!/\s/.test(ch)) lastSignificant = ch;
    i += 1;
  }
  return out.join('');
}

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let k = 0; k < index; k++) if (source[k] === '\n') line += 1;
  return line;
}

function lineText(source: string, index: number): string {
  const start = source.lastIndexOf('\n', index - 1) + 1;
  const end = source.indexOf('\n', index);
  return source.slice(start, end === -1 ? undefined : end).trim().slice(0, 160);
}

function matchAll(file: string, source: string, rule: string, pattern: RegExp, original = source): Violation[] {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return [...source.matchAll(new RegExp(pattern.source, flags))].map((m) => ({
    file,
    line: lineAt(source, m.index),
    rule,
    text: lineText(original, m.index),
  }));
}

// ---------------------------------------------------------------------------------------------------------------
// Regras

const DELETE_PATTERN = /\bDELETE\s+FROM\b/i;
const TRUNCATE_PATTERN = /\bTRUNCATE\s+(TABLE\s+)?(ONLY\s+)?"?[a-z_][a-z0-9_]*"?\s*($|[;'"\x60,)]|\s+(CASCADE|RESTRICT|RESTART|CONTINUE)\b)/im;
const CLEANUP_ALLOWLIST = new Set(['test/integration/schema-guards.test.ts', 'test/integration/migrations.test.ts']);

/**
 * (a) TRUNCATE e DELETE como limpeza de dados em test/**: proibidos fora da lista de permitidos; nela, cada ocorrência
 * precisa estar inline num `expect(` aberto antes e com `.rejects` depois, sem `;` entre os três.
 */
export const cleanupRule: Rule = (file, source) => {
  if (!file.startsWith('test/')) return [];
  const code = stripComments(source);
  const found = [...matchAll(file, code, 'cleanup', DELETE_PATTERN, source), ...matchAll(file, code, 'cleanup', TRUNCATE_PATTERN, source)];
  if (!CLEANUP_ALLOWLIST.has(file)) return found.map((v) => ({ ...v, rule: 'cleanup: TRUNCATE/DELETE fora da lista de permitidos' }));
  const indices = [
    ...code.matchAll(new RegExp(DELETE_PATTERN.source, 'gi')),
    ...code.matchAll(new RegExp(TRUNCATE_PATTERN.source, 'gim')),
  ].map((m) => m.index);
  return indices
    .filter((index) => {
      const opened = code.lastIndexOf('expect(', index);
      const rejects = code.indexOf('.rejects', index);
      return opened === -1 || rejects === -1 || code.slice(opened, index).includes(';') || code.slice(index, rejects).includes(';');
    })
    .map((index) => ({
      file,
      line: lineAt(code, index),
      rule: 'cleanup: TRUNCATE/DELETE fora de expect(...).rejects',
      text: lineText(source, index),
    }));
};

/** (a) Desligar guardas em test/**: nenhum session_replication_role nem DISABLE TRIGGER, sem lista de permitidos. */
export const disableGuardsRule: Rule = (file, source) =>
  file.startsWith('test/') ? matchAll(file, stripComments(source), 'guards: desligar triggers', /session_replication_role|DISABLE\s+TRIGGER/i, source) : [];

const MOCK_PATTERNS: Array<[string, RegExp]> = [
  ['mock(', /\bmock\s*\(/],
  ['mock.module(', /\bmock\.module\s*\(/],
  ['import de mock do bun:test', /import\s*\{[^}]*\bmock\b[^}]*\}\s*from\s*['"]bun:test['"]/],
  ['jest.', /\bjest\./],
  ['spyOn em repositório, ORM, EM, pool ou banco', /spyOn\(\s*[\w.]*(repo|repository|orm|entityManager|\bem\b|pool|db|client)/i],
  ['banco em memória', /pg-mem|better-sqlite3|bun:sqlite|:memory:|\bInMemory\w*Repository\b/],
];

/** (b) Sem mocks em test/integration/** e test/concurrency/** (constitution VII, falha eliminatória 8). */
export const noMocksRule: Rule = (file, source) => {
  if (!file.startsWith('test/integration/') && !file.startsWith('test/concurrency/')) return [];
  const code = stripComments(source);
  return MOCK_PATTERNS.flatMap(([label, pattern]) => matchAll(file, code, `mocks: ${label}`, pattern, source));
};

const ROUTE_DECORATOR = /@(Controller|Get|Post|Put|Patch|Delete|All|Options|Head)\(\s*['"`]([^'"`]*)['"`]/g;

/** (c) src/**: nenhum `$1` em SQL, nenhum `parseFloat(`, nenhum `Number(` em amount ou balance e nenhuma rota de teste. */
export const sourceRule: Rule = (file, source) => {
  if (!file.startsWith('src/')) return [];
  const code = stripComments(source);
  const routes = [...code.matchAll(ROUTE_DECORATOR)]
    .filter((m) => /test|debug|__/i.test(m[2] ?? ''))
    .map((m) => ({ file, line: lineAt(code, m.index), rule: 'src: rota de teste', text: lineText(source, m.index) }));
  return [
    ...matchAll(file, code, 'src: placeholder $n em SQL', /\$[1-9]\d*/, source),
    ...matchAll(file, code, 'src: parseFloat', /\bparseFloat\s*\(/, source),
    ...matchAll(file, code, 'src: Number() em dinheiro', /\bNumber\s*\(\s*[^)]*\b(amount|balance)/i, source),
    ...routes,
  ];
};

const DOMAIN_FILE = /^src\/[^/]+\/domain\//;
const ALLOWED_DOMAIN_PACKAGES = new Set(['decimal.js']);
const IMPORT_SPECS = [
  /(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/**
 * (d) src/**\/domain/**: imports só de src/**\/domain/** (qualquer módulo), src/shared-kernel/domain/** e do pacote
 * decimal.js; nunca application, infrastructure, interfaces, platform, @nestjs, @mikro-orm ou outro pacote.
 */
export const domainImportsRule: Rule = (file, source) => {
  if (!DOMAIN_FILE.test(file)) return [];
  const code = stripComments(source);
  const violations: Violation[] = [];
  for (const pattern of IMPORT_SPECS) {
    for (const m of code.matchAll(pattern)) {
      const spec = m[1]!;
      const allowed = spec.startsWith('.')
        ? DOMAIN_FILE.test(posix.normalize(posix.join(posix.dirname(file), spec)))
        : ALLOWED_DOMAIN_PACKAGES.has(spec);
      if (!allowed) violations.push({ file, line: lineAt(code, m.index), rule: `domain: import proibido (${spec})`, text: lineText(source, m.index) });
    }
  }
  return violations;
};

/**
 * (e) src/**\/domain/** e src/**\/application/**: nenhum `new Date()` sem argumento, `Date.now(`, `randomUUID(` ou
 * `randomUUIDv7(`; tempo pela porta Clock e ids pela porta IdGenerator. `new Date(x)` com argumento é permitido.
 */
export const clockAndIdsRule: Rule = (file, source) => {
  if (!/^src\/[^/]+\/(domain|application)\//.test(file)) return [];
  const code = stripComments(source);
  return [
    ...matchAll(file, code, 'clock: new Date() sem argumento', /\bnew\s+Date\s*\(\s*\)/, source),
    ...matchAll(file, code, 'clock: Date.now()', /\bDate\.now\s*\(/, source),
    ...matchAll(file, code, 'ids: randomUUID', /\brandomUUID(v7)?\s*\(/, source),
  ];
};

// ---- feature 002 (T084; R-33; constitution VII)

const SQS_FAKE_PATTERNS: Array<[string, RegExp]> = [
  ['import do fake-sqs', /(?:from|import)\s*\(?\s*['"][^'"]*\bfake-sqs(\.ts)?['"]/],
  ['classe InMemory*Sqs* ou Fake*Sqs*', /\b(InMemory|Fake)\w*Sqs\w*\b/],
  ['spyOn em objeto sqs', /spyOn\(\s*[\w.]*sqs\w*\s*,/i],
  ['mock.module de @aws-sdk', /mock\.module\(\s*['"]@aws-sdk\//],
];

/**
 * (f) test/integration/** e test/concurrency/**: nenhum SQS falso. O fake de `SqsPort` (`test/support/fake-sqs.ts`)
 * só vale em test/unit; integração e concorrência usam o MiniStack real (R-31, R-33).
 */
export const noSqsFakesRule: Rule = (file, source) => {
  if (!file.startsWith('test/integration/') && !file.startsWith('test/concurrency/')) return [];
  const code = stripComments(source);
  return SQS_FAKE_PATTERNS.flatMap(([label, pattern]) => matchAll(file, code, `sqs: ${label}`, pattern, source));
};

/** (g) src/**: `@aws-sdk/` só é importado em src/messaging/infrastructure/** (porta SqsPort; R-21, R-33). */
export const awsSdkImportsRule: Rule = (file, source) => {
  if (!file.startsWith('src/') || file.startsWith('src/messaging/infrastructure/')) return [];
  const code = stripComments(source);
  const violations: Violation[] = [];
  for (const pattern of IMPORT_SPECS) {
    for (const m of code.matchAll(pattern)) {
      const spec = m[1]!;
      if (spec.startsWith('@aws-sdk/')) {
        violations.push({ file, line: lineAt(code, m.index), rule: `aws-sdk: import fora de messaging/infrastructure (${spec})`, text: lineText(source, m.index) });
      }
    }
  }
  return violations;
};

/** (h) src/**\/domain/** e src/**\/application/**: nenhum `Math.random(`; jitter pela porta RandomSource (R-25). */
export const randomRule: Rule = (file, source) => {
  if (!/^src\/[^/]+\/(domain|application)\//.test(file)) return [];
  return matchAll(file, stripComments(source), 'random: Math.random()', /\bMath\.random\s*\(/, source);
};

/** (i) test/**: nenhum PurgeQueue (limpeza de fila); cada arquivo usa filas próprias, apagadas no fim (R-31). */
export const purgeQueueRule: Rule = (file, source) =>
  file.startsWith('test/') ? matchAll(file, stripComments(source), 'filas: PurgeQueue', /\bPurgeQueue(Command)?\b|\bpurgeQueue\s*\(/, source) : [];

const RULES: Array<[string, Rule]> = [
  ['(a) limpeza de dados em test/**', cleanupRule],
  ['(a) desligar guardas em test/**', disableGuardsRule],
  ['(b) sem mocks em integração e concorrência', noMocksRule],
  ['(c) src/**: $n, parseFloat, Number() em dinheiro, rotas de teste', sourceRule],
  ['(d) imports do domínio', domainImportsRule],
  ['(e) relógio e ids em domain e application', clockAndIdsRule],
  ['(f) sem SQS falso em integração e concorrência', noSqsFakesRule],
  ['(g) @aws-sdk só em src/messaging/infrastructure', awsSdkImportsRule],
  ['(h) sem Math.random em domain e application', randomRule],
  ['(i) sem PurgeQueue em test/**', purgeQueueRule],
];

// ---------------------------------------------------------------------------------------------------------------
// Varredura do repositório

async function repositoryFiles(): Promise<Array<{ file: string; source: string }>> {
  const files: Array<{ file: string; source: string }> = [];
  for (const dir of ['src', 'test']) {
    for await (const relative of new Glob('**/*.ts').scan({ cwd: posix.join(ROOT, dir) })) {
      const file = `${dir}/${relative.replaceAll('\\', '/')}`;
      if (file === SELF) continue;
      files.push({ file, source: await Bun.file(posix.join(ROOT, file)).text() });
    }
  }
  return files;
}

const format = (violations: Violation[]) => violations.map((v) => `${v.file}:${v.line} [${v.rule}] ${v.text}`).join('\n');

describe('varredura do repositório', () => {
  test('a varredura alcança src e test (sanidade)', async () => {
    const files = await repositoryFiles();
    expect(files.some((f) => f.file === 'src/shared-kernel/domain/money.ts')).toBe(true);
    expect(files.some((f) => f.file === 'test/integration/schema-guards.test.ts')).toBe(true);
    expect(files.some((f) => f.file === SELF)).toBe(false);
  });

  for (const [name, rule] of RULES) {
    test(`${name}: nenhuma violação`, async () => {
      const violations = (await repositoryFiles()).flatMap(({ file, source }) => rule(file, source));
      expect(violations, `violações:\n${format(violations)}`).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Autoteste: cada regra contra exemplos que passam e que falham

const passes = (rule: Rule, file: string, source: string) => expect(rule(file, source), format(rule(file, source))).toEqual([]);
const fails = (rule: Rule, file: string, source: string) => expect(rule(file, source).length).toBeGreaterThan(0);

describe('autoteste: stripComments', () => {
  test('remove comentários de linha e de bloco, preserva strings, templates e linhas', () => {
    const source = "const a = 'http://x'; // DELETE FROM t\n/* new Date() */ const b = `${c} // não é comentário`;";
    const stripped = stripComments(source);
    expect(stripped).toContain("'http://x'");
    expect(stripped).not.toContain('DELETE FROM');
    expect(stripped).not.toContain('new Date()');
    expect(stripped).toContain('// não é comentário');
    expect(stripped.split('\n')).toHaveLength(2);
  });

  test('regex literal com barras não vira comentário', () => {
    expect(stripComments("const r = /^a\\/\\/b$/; const s = 'ok';")).toContain("'ok'");
  });
});

describe('autoteste: (a) limpeza de dados', () => {
  const allowed = 'test/integration/schema-guards.test.ts';
  test('na lista de permitidos, inline em expect(...).rejects, passa', () => {
    passes(cleanupRule, allowed, "await expect(db.query('DELETE FROM wallet_ledger_entries')).rejects.toThrow();");
    passes(cleanupRule, allowed, "await expect(db.query('TRUNCATE wager_transactions CASCADE')).rejects.toThrow();");
    passes(cleanupRule, allowed, "await expect(\n  db.query('DELETE FROM wallets WHERE id = ?', [id]),\n).rejects.toEqual(guard());");
  });
  test('na lista de permitidos, fora de expect, falha', () => {
    fails(cleanupRule, allowed, "await db.query('DELETE FROM wallet_ledger_entries');");
    fails(cleanupRule, allowed, "await db.query('TRUNCATE wallet_ledger_entries');");
  });
  test('SQL guardado em variável e executado em expect(...).rejects falha', () => {
    fails(cleanupRule, allowed, "const sql = 'DELETE FROM wallet_ledger_entries';\nawait expect(db.query(sql)).rejects.toThrow();");
  });
  test('expect sem .rejects falha', () => {
    fails(cleanupRule, allowed, "await expect(db.query('DELETE FROM wallets')).resolves.toBeDefined();");
  });
  test('fora da lista de permitidos, qualquer ocorrência falha, mesmo inline em expect(...).rejects', () => {
    fails(cleanupRule, 'test/integration/other.test.ts', "await expect(db.query('DELETE FROM wallets')).rejects.toThrow();");
    fails(cleanupRule, 'test/support/cleanup.ts', 'await db.query(`TRUNCATE TABLE ONLY "wallets" RESTART IDENTITY`);');
  });
  test('mensagens e comentários não contam; src fica fora da regra', () => {
    passes(cleanupRule, 'test/integration/other.test.ts', "// sem TRUNCATE/DELETE para limpar\ntest('DELETE e TRUNCATE são recusados', () => {});");
    passes(cleanupRule, 'test/integration/other.test.ts', "expect(error.message).toContain('TRUNCATE is not allowed');");
    passes(cleanupRule, 'src/x.ts', "const sql = 'DELETE FROM x';");
  });
});

describe('autoteste: (a) desligar guardas', () => {
  test('session_replication_role e DISABLE TRIGGER falham em qualquer arquivo de teste', () => {
    fails(disableGuardsRule, 'test/integration/schema-guards.test.ts', "await db.query('SET session_replication_role = replica');");
    fails(disableGuardsRule, 'test/support/db.ts', "await db.query('ALTER TABLE wallets DISABLE TRIGGER ALL');");
  });
  test('ENABLE TRIGGER e comentários passam', () => {
    passes(disableGuardsRule, 'test/support/db.ts', "// nunca session_replication_role\nawait db.query('ALTER TABLE w ENABLE TRIGGER t');");
  });
});

describe('autoteste: (b) sem mocks em integração e concorrência', () => {
  const file = 'test/integration/x.test.ts';
  test('cada padrão proibido falha', () => {
    for (const source of [
      'const fn = mock(() => 1);',
      "mock.module('pg', () => ({}));",
      "import { expect, mock, test } from 'bun:test';",
      'const f = jest.fn();',
      "spyOn(repository, 'insert');",
      "spyOn(walletRepo, 'lockById');",
      "spyOn(em, 'execute');",
      "spyOn(running.orm, 'close');",
      "spyOn(pool, 'connect');",
      "spyOn(database.db, 'query');",
      "import { newDb } from 'pg-mem';",
      "new Database(':memory:');",
      "import { Database } from 'bun:sqlite';",
      'class InMemoryWalletRepository {}',
    ]) {
      fails(noMocksRule, file, source);
    }
  });
  test('os doubles permitidos e spyOn fora de banco passam; a regra não vale para test/unit', () => {
    passes(noMocksRule, file, "import { FixedClock, SequentialIdGenerator } from '../support/fakes.ts';\nspyOn(console, 'log');");
    passes(noMocksRule, file, "// sem mock de banco\nimport { expect, test } from 'bun:test';");
    passes(noMocksRule, 'test/unit/failpoints.test.ts', 'const exit = mock(() => {});');
  });
});

describe('autoteste: (c) src', () => {
  test('$1, parseFloat, Number() em amount/balance e rotas de teste falham', () => {
    fails(sourceRule, 'src/x.ts', "await em.execute('select * from wallets where id = $1', [id]);");
    fails(sourceRule, 'src/x.ts', 'const v = parseFloat(input);');
    fails(sourceRule, 'src/x.ts', 'const v = Number(body.money.amount);');
    fails(sourceRule, 'src/x.ts', 'const v = Number(wallet.balance);');
    fails(sourceRule, 'src/x.ts', "@Controller('test')\nexport class T {}");
    fails(sourceRule, 'src/x.ts', "@Get('debug/state')\nget() {}");
    fails(sourceRule, 'src/x.ts', "@Post('__reset')\nreset() {}");
  });
  test('placeholders ?, templates, Number em valor que não é dinheiro e rotas normais passam', () => {
    passes(sourceRule, 'src/x.ts', "await em.execute('select * from wallets where id = ?', [id]);");
    passes(sourceRule, 'src/x.ts', 'const s = `set local lock_timeout = \'${ms}ms\'`;');
    passes(sourceRule, 'src/x.ts', 'const port = Number(raw);');
    passes(sourceRule, 'src/x.ts', "@Controller('wallets')\nexport class W {}\n@Get(':walletId/ledger')\nledger() {}");
    passes(sourceRule, 'src/x.ts', '// parseFloat( é proibido\nconst ok = 1;');
  });
});

describe('autoteste: (d) imports do domínio', () => {
  test('passam: domínio de outro módulo, shared-kernel/domain e decimal.js', () => {
    passes(domainImportsRule, 'src/wagering/domain/x.ts', "import { Wallet } from '../../wallets/domain/wallet.ts';");
    passes(domainImportsRule, 'src/wagering/domain/x.ts', "import { Money } from '../../shared-kernel/domain/money.ts';");
    passes(domainImportsRule, 'src/wagering/domain/events/x.ts', "import type { WagerTransaction } from '../wager-transaction.ts';");
    passes(domainImportsRule, 'src/shared-kernel/domain/x.ts', "import Decimal from 'decimal.js';");
  });
  test('falham: application, platform, infrastructure, @nestjs, @mikro-orm e outros pacotes', () => {
    fails(domainImportsRule, 'src/wagering/domain/x.ts', "import { x } from '../application/payload-hash.ts';");
    fails(domainImportsRule, 'src/wagering/domain/x.ts', "import { y } from '../../platform/persistence/pg-errors.ts';");
    fails(domainImportsRule, 'src/wagering/domain/x.ts', "import { z } from '../infrastructure/wager-transaction.schema.ts';");
    fails(domainImportsRule, 'src/wagering/domain/x.ts', "import { Inject } from '@nestjs/common';");
    fails(domainImportsRule, 'src/wagering/domain/x.ts', "import { LockMode } from '@mikro-orm/core';");
    fails(domainImportsRule, 'src/shared-kernel/domain/x.ts', "import { z } from 'zod';");
    fails(domainImportsRule, 'src/shared-kernel/domain/x.ts', "import Big from 'big.js';");
    fails(domainImportsRule, 'src/wallets/domain/x.ts', "export { a } from '../interfaces/http/wallet.dto.ts';");
    fails(domainImportsRule, 'src/wallets/domain/x.ts', "const m = await import('../../platform/config/app-config.ts');");
  });
  test('arquivos fora de domain não são avaliados', () => {
    passes(domainImportsRule, 'src/wagering/application/x.ts', "import { Inject } from '@nestjs/common';");
  });
});

describe('autoteste: (e) relógio e ids', () => {
  const file = 'src/wagering/application/x.ts';
  test('passam: new Date com argumento', () => {
    passes(clockAndIdsRule, file, 'const next = new Date(now.getTime() + 5000);');
    passes(clockAndIdsRule, file, 'const created = new Date(state.createdAt);');
    passes(clockAndIdsRule, file, "const fixed = new Date('2026-11-07T00:00:00Z');");
    passes(clockAndIdsRule, file, '/** nunca new Date() nem Date.now() */\nconst ok = clock.now();');
  });
  test('falham: new Date(), new Date( ), new Date (), Date.now() e geração direta de ids', () => {
    fails(clockAndIdsRule, file, 'const t = new Date();');
    fails(clockAndIdsRule, file, 'const t = new Date( );');
    fails(clockAndIdsRule, file, 'const t = new Date ();');
    fails(clockAndIdsRule, file, 'const t = Date.now();');
    fails(clockAndIdsRule, 'src/wallets/domain/x.ts', 'const id = crypto.randomUUID();');
    fails(clockAndIdsRule, 'src/wallets/domain/x.ts', 'const id = Bun.randomUUIDv7();');
  });
  test('platform e infrastructure ficam fora da regra', () => {
    passes(clockAndIdsRule, 'src/platform/logging/json-logger.ts', 'const time = new Date().toISOString();');
    passes(clockAndIdsRule, 'src/shared-kernel/infrastructure/uuidv7-id-generator.ts', 'return Bun.randomUUIDv7();');
  });
});

describe('autoteste: (f) sem SQS falso em integração e concorrência', () => {
  const file = 'test/integration/x.test.ts';
  test('cada padrão proibido falha', () => {
    for (const source of [
      "import { FakeSqs } from '../support/fake-sqs.ts';",
      "const { FakeSqs } = await import('../support/fake-sqs');",
      'class InMemorySqsPort {}',
      'const sqs = new FakeSqsAdapter();',
      "spyOn(app.sqs, 'send');",
      "spyOn(sqsClient, 'send');",
      "mock.module('@aws-sdk/client-sqs', () => ({}));",
    ]) {
      fails(noSqsFakesRule, file, source);
    }
  });
  test('MiniStack real pelos helpers de suporte passa; test/unit pode usar o fake', () => {
    passes(noSqsFakesRule, file, "import { sendRaw, receive } from '../support/sqs-client.ts';\nawait app.sqs.send(queue, options);");
    passes(noSqsFakesRule, file, '// nunca o fake-sqs aqui\nconst ok = 1;');
    passes(noSqsFakesRule, 'test/unit/consumer-batching.test.ts', "import { FakeSqs } from '../support/fake-sqs.ts';");
  });
});

describe('autoteste: (g) @aws-sdk só em src/messaging/infrastructure', () => {
  test('falha fora de messaging/infrastructure, inclusive em import dinâmico e re-export', () => {
    fails(awsSdkImportsRule, 'src/messaging/application/x.ts', "import { SQSClient } from '@aws-sdk/client-sqs';");
    fails(awsSdkImportsRule, 'src/outbox/application/x.ts', "const sdk = await import('@aws-sdk/client-sqs');");
    fails(awsSdkImportsRule, 'src/platform/x.ts', "export { SQSClient } from '@aws-sdk/client-sqs';");
  });
  test('passa em messaging/infrastructure, em comentários e fora de src', () => {
    passes(awsSdkImportsRule, 'src/messaging/infrastructure/aws-sqs.adapter.ts', "import { SQSClient } from '@aws-sdk/client-sqs';");
    passes(awsSdkImportsRule, 'src/messaging/application/sqs.port.ts', '// o adapter usa @aws-sdk/client-sqs\nexport const SQS_PORT = 1;');
    passes(awsSdkImportsRule, 'test/support/sqs-client.ts', "import { SQSClient } from '@aws-sdk/client-sqs';");
  });
});

describe('autoteste: (h) sem Math.random em domain e application', () => {
  test('falha em domain e application', () => {
    fails(randomRule, 'src/wagering/domain/x.ts', 'const r = Math.random();');
    fails(randomRule, 'src/wagering/application/x.ts', 'const jitter = 1 + Math.random() * ratio;');
  });
  test('passa pela porta RandomSource, em comentários e em platform', () => {
    passes(randomRule, 'src/wagering/application/x.ts', 'const r = this.deps.random.next(); // nunca Math.random()');
    passes(randomRule, 'src/platform/random/crypto-random-source.ts', 'return Math.random();');
  });
});

describe('autoteste: (i) sem PurgeQueue em test/**', () => {
  test('falha com o comando do SDK ou um helper de purge', () => {
    fails(purgeQueueRule, 'test/support/test-queues.ts', 'await client.send(new PurgeQueueCommand({ QueueUrl: url }));');
    fails(purgeQueueRule, 'test/integration/x.test.ts', 'await purgeQueue(queues.urls.transactions);');
  });
  test('passa com filas próprias apagadas no fim e em comentários', () => {
    passes(purgeQueueRule, 'test/support/test-queues.ts', '// nenhum PurgeQueue como limpeza\nawait client.send(new DeleteQueueCommand({ QueueUrl: url }));');
    passes(purgeQueueRule, 'src/x.ts', 'const s = "PurgeQueue";');
  });
});
