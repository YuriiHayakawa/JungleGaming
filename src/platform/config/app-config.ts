/** Configuração da app, lida de env e validada no boot; a app não sobe se for inválida (FR-059, I-51, R-11). */
export const APP_CONFIG = Symbol('APP_CONFIG');

export interface AppConfig {
  databaseUrl: string;
  port: number;
  walletLockTimeoutMs: number;
  dbPoolMax: number;
  dbPoolAcquireTimeoutMs: number;
  httpServerTimeoutMs: number;
  retryAfterSeconds: number;
  failpoint: string | undefined;
  nodeEnv: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const DEFAULTS = {
  PORT: '3001',
  WALLET_LOCK_TIMEOUT_MS: '5000',
  DB_POOL_MAX: '25',
  DB_POOL_ACQUIRE_TIMEOUT_MS: '8000',
  HTTP_SERVER_TIMEOUT_MS: '20000',
  RETRY_AFTER_SECONDS: '1',
  NODE_ENV: 'development',
} as const;

/** Margem do I-51: HTTP > aquisição de conexão + lock + margem. */
const HTTP_TIMEOUT_MARGIN_MS = 2000;

type Env = Record<string, string | undefined>;

function integer(env: Env, name: keyof typeof DEFAULTS, options: { min: number }): number {
  const raw = env[name] ?? DEFAULTS[name];
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(`${name} must be an integer, got "${raw}"`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < options.min) {
    throw new ConfigError(`${name} must be an integer >= ${options.min}, got "${raw}"`);
  }
  return value;
}

export function loadConfig(env: Env = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new ConfigError('DATABASE_URL is required');

  const walletLockTimeoutMs = integer(env, 'WALLET_LOCK_TIMEOUT_MS', { min: 1 });
  const dbPoolAcquireTimeoutMs = integer(env, 'DB_POOL_ACQUIRE_TIMEOUT_MS', { min: 1 });
  const httpServerTimeoutMs = integer(env, 'HTTP_SERVER_TIMEOUT_MS', { min: 1 });

  if (dbPoolAcquireTimeoutMs <= walletLockTimeoutMs) {
    throw new ConfigError(
      `DB_POOL_ACQUIRE_TIMEOUT_MS (${dbPoolAcquireTimeoutMs}) must be greater than WALLET_LOCK_TIMEOUT_MS (${walletLockTimeoutMs})`,
    );
  }
  const minimumHttp = dbPoolAcquireTimeoutMs + walletLockTimeoutMs + HTTP_TIMEOUT_MARGIN_MS;
  if (httpServerTimeoutMs <= minimumHttp) {
    throw new ConfigError(
      `HTTP_SERVER_TIMEOUT_MS (${httpServerTimeoutMs}) must be greater than DB_POOL_ACQUIRE_TIMEOUT_MS + WALLET_LOCK_TIMEOUT_MS + ${HTTP_TIMEOUT_MARGIN_MS} (${minimumHttp})`,
    );
  }

  const failpoint = env.FAILPOINT?.trim();
  return {
    databaseUrl,
    port: integer(env, 'PORT', { min: 0 }),
    walletLockTimeoutMs,
    dbPoolMax: integer(env, 'DB_POOL_MAX', { min: 1 }),
    dbPoolAcquireTimeoutMs,
    httpServerTimeoutMs,
    retryAfterSeconds: integer(env, 'RETRY_AFTER_SECONDS', { min: 1 }),
    failpoint: failpoint ? failpoint : undefined,
    nodeEnv: env.NODE_ENV ?? DEFAULTS.NODE_ENV,
  };
}
