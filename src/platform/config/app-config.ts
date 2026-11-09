/** Configuração da app, lida de env e validada no boot; a app não sobe se for inválida (FR-059, I-51, R-11, R-27). */
export const APP_CONFIG = Symbol('APP_CONFIG');

export interface SqsConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  transactionsQueue: string;
  transactionsDlq: string;
  eventsQueue: string;
}

/** Papéis por instância (R-27): todos desligados por padrão; o Compose e os testes ligam o que precisam. */
export interface RolesConfig {
  consumer: boolean;
  publisher: boolean;
  pendingWorker: boolean;
}

export interface ConsumerConfig {
  name: string;
  waitSeconds: number;
  visibilityTimeoutSeconds: number;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
  shutdownTimeoutMs: number;
}

export interface PublisherConfig {
  batchSize: number;
  leaseMs: number;
  pollMs: number;
  backoffMinMs: number;
  backoffMaxMs: number;
}

export interface PendingWorkerConfig {
  batchSize: number;
  leaseMs: number;
  pollMs: number;
  maxAttempts: number;
  ttlMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  jitterRatio: number;
}

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
  sqs: SqsConfig;
  roles: RolesConfig;
  consumer: ConsumerConfig;
  publisher: PublisherConfig;
  pendingWorker: PendingWorkerConfig;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Padrões iguais aos do .env.example (R-11, R-27). */
const DEFAULTS = {
  PORT: '3001',
  WALLET_LOCK_TIMEOUT_MS: '5000',
  DB_POOL_MAX: '25',
  DB_POOL_ACQUIRE_TIMEOUT_MS: '8000',
  HTTP_SERVER_TIMEOUT_MS: '20000',
  RETRY_AFTER_SECONDS: '1',
  NODE_ENV: 'development',
  SQS_ENDPOINT: 'http://localhost:4566',
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  SQS_TRANSACTIONS_QUEUE: 'wager-transactions.fifo',
  SQS_TRANSACTIONS_DLQ: 'wager-transactions-dlq.fifo',
  SQS_EVENTS_QUEUE: 'wager-events.fifo',
  CONSUMER_ENABLED: 'false',
  PUBLISHER_ENABLED: 'false',
  PENDING_WORKER_ENABLED: 'false',
  CONSUMER_NAME: 'wager-transactions-consumer',
  CONSUMER_WAIT_SECONDS: '20',
  CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '30',
  CONSUMER_RETRY_BASE_SECONDS: '5',
  CONSUMER_RETRY_MAX_SECONDS: '60',
  CONSUMER_SHUTDOWN_TIMEOUT_MS: '10000',
  PUBLISHER_BATCH_SIZE: '10',
  PUBLISHER_LEASE_MS: '30000',
  PUBLISHER_POLL_MS: '1000',
  PUBLISHER_BACKOFF_MIN_MS: '1000',
  PUBLISHER_BACKOFF_MAX_MS: '60000',
  PENDING_WORKER_BATCH_SIZE: '10',
  PENDING_WORKER_LEASE_MS: '30000',
  PENDING_WORKER_POLL_MS: '1000',
  PENDING_MAX_ATTEMPTS: '10',
  PENDING_TTL_MS: '600000',
  PENDING_BACKOFF_BASE_MS: '5000',
  PENDING_BACKOFF_MAX_MS: '60000',
  PENDING_JITTER_RATIO: '0.2',
} as const;

type Name = keyof typeof DEFAULTS;

/** Margem do I-51: HTTP, visibilidade e leases > aquisição de conexão + lock + margem. */
const TIMEOUT_MARGIN_MS = 2000;
/** O prazo do término gracioso + a margem do handler de sinal (5 s) cabem nos 30 s do stop_grace_period (R-27, R-35). */
const MAX_SHUTDOWN_TIMEOUT_MS = 25_000;
const MAX_BATCH_SIZE = 10;
const MAX_JITTER_RATIO = 0.5;

type Env = Record<string, string | undefined>;

function raw(env: Env, name: Name): string {
  return env[name] ?? DEFAULTS[name];
}

function integer(env: Env, name: Name, options: { min: number; max?: number }): number {
  const value = raw(env, name);
  if (!/^\d+$/.test(value)) {
    throw new ConfigError(`${name} must be an integer, got "${value}"`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < options.min || (options.max !== undefined && parsed > options.max)) {
    const range = options.max !== undefined ? `between ${options.min} and ${options.max}` : `>= ${options.min}`;
    throw new ConfigError(`${name} must be an integer ${range}, got "${value}"`);
  }
  return parsed;
}

function boolean(env: Env, name: Name): boolean {
  const value = raw(env, name);
  if (value !== 'true' && value !== 'false') throw new ConfigError(`${name} must be "true" or "false", got "${value}"`);
  return value === 'true';
}

function text(env: Env, name: Name, options: { min?: number; max?: number } = {}): string {
  const value = raw(env, name);
  if (value.length < (options.min ?? 1) || value.length > (options.max ?? Number.MAX_SAFE_INTEGER)) {
    throw new ConfigError(`${name} has an invalid length, got "${value}"`);
  }
  return value;
}

function fifoQueue(env: Env, name: Name): string {
  const value = text(env, name);
  if (!value.endsWith('.fifo') || value === '.fifo') throw new ConfigError(`${name} must end with ".fifo", got "${value}"`);
  return value;
}

/** Razão decimal simples (não é dinheiro): "0", "0.2", "0.5". */
function ratio(env: Env, name: Name, max: number): number {
  const value = raw(env, name);
  if (!/^\d+(\.\d+)?$/.test(value)) throw new ConfigError(`${name} must be a decimal number, got "${value}"`);
  const parsed = Number(value);
  if (!(parsed >= 0 && parsed <= max)) throw new ConfigError(`${name} must be between 0 and ${max}, got "${value}"`);
  return parsed;
}

function requireAbove(name: string, value: number, minimumExclusive: number, explanation: string): void {
  if (value <= minimumExclusive) {
    throw new ConfigError(`${name} (${value}) must be greater than ${explanation} (${minimumExclusive})`);
  }
}

function requireOrdered(lowName: string, low: number, highName: string, high: number): void {
  if (low > high) throw new ConfigError(`${lowName} (${low}) must not be greater than ${highName} (${high})`);
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
  // Pior caso de uma unidade de trabalho: espera de conexão + espera de lock + margem (I-51, R-27).
  const unitOfWorkWorstCaseMs = dbPoolAcquireTimeoutMs + walletLockTimeoutMs + TIMEOUT_MARGIN_MS;
  const unitOfWorkExplanation = `DB_POOL_ACQUIRE_TIMEOUT_MS + WALLET_LOCK_TIMEOUT_MS + ${TIMEOUT_MARGIN_MS}`;
  requireAbove('HTTP_SERVER_TIMEOUT_MS', httpServerTimeoutMs, unitOfWorkWorstCaseMs, unitOfWorkExplanation);

  const consumer: ConsumerConfig = {
    name: text(env, 'CONSUMER_NAME', { min: 1, max: 64 }),
    waitSeconds: integer(env, 'CONSUMER_WAIT_SECONDS', { min: 1, max: 20 }),
    visibilityTimeoutSeconds: integer(env, 'CONSUMER_VISIBILITY_TIMEOUT_SECONDS', { min: 1, max: 43_200 }),
    retryBaseSeconds: integer(env, 'CONSUMER_RETRY_BASE_SECONDS', { min: 1 }),
    retryMaxSeconds: integer(env, 'CONSUMER_RETRY_MAX_SECONDS', { min: 1, max: 43_200 }),
    shutdownTimeoutMs: integer(env, 'CONSUMER_SHUTDOWN_TIMEOUT_MS', { min: 1, max: MAX_SHUTDOWN_TIMEOUT_MS }),
  };
  requireAbove(
    'CONSUMER_VISIBILITY_TIMEOUT_SECONDS × 1000',
    consumer.visibilityTimeoutSeconds * 1000,
    unitOfWorkWorstCaseMs,
    unitOfWorkExplanation,
  );
  requireOrdered('CONSUMER_RETRY_BASE_SECONDS', consumer.retryBaseSeconds, 'CONSUMER_RETRY_MAX_SECONDS', consumer.retryMaxSeconds);

  const publisher: PublisherConfig = {
    batchSize: integer(env, 'PUBLISHER_BATCH_SIZE', { min: 1, max: MAX_BATCH_SIZE }),
    leaseMs: integer(env, 'PUBLISHER_LEASE_MS', { min: 1 }),
    pollMs: integer(env, 'PUBLISHER_POLL_MS', { min: 1 }),
    backoffMinMs: integer(env, 'PUBLISHER_BACKOFF_MIN_MS', { min: 1 }),
    backoffMaxMs: integer(env, 'PUBLISHER_BACKOFF_MAX_MS', { min: 1 }),
  };
  requireAbove('PUBLISHER_LEASE_MS', publisher.leaseMs, unitOfWorkWorstCaseMs, unitOfWorkExplanation);
  requireOrdered('PUBLISHER_BACKOFF_MIN_MS', publisher.backoffMinMs, 'PUBLISHER_BACKOFF_MAX_MS', publisher.backoffMaxMs);

  const pendingWorker: PendingWorkerConfig = {
    batchSize: integer(env, 'PENDING_WORKER_BATCH_SIZE', { min: 1, max: MAX_BATCH_SIZE }),
    leaseMs: integer(env, 'PENDING_WORKER_LEASE_MS', { min: 1 }),
    pollMs: integer(env, 'PENDING_WORKER_POLL_MS', { min: 1 }),
    maxAttempts: integer(env, 'PENDING_MAX_ATTEMPTS', { min: 1 }),
    ttlMs: integer(env, 'PENDING_TTL_MS', { min: 1 }),
    backoffBaseMs: integer(env, 'PENDING_BACKOFF_BASE_MS', { min: 1 }),
    backoffMaxMs: integer(env, 'PENDING_BACKOFF_MAX_MS', { min: 1 }),
    jitterRatio: ratio(env, 'PENDING_JITTER_RATIO', MAX_JITTER_RATIO),
  };
  requireAbove('PENDING_WORKER_LEASE_MS', pendingWorker.leaseMs, unitOfWorkWorstCaseMs, unitOfWorkExplanation);
  requireOrdered('PENDING_BACKOFF_BASE_MS', pendingWorker.backoffBaseMs, 'PENDING_BACKOFF_MAX_MS', pendingWorker.backoffMaxMs);

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
    sqs: {
      endpoint: text(env, 'SQS_ENDPOINT'),
      region: text(env, 'AWS_REGION'),
      accessKeyId: text(env, 'AWS_ACCESS_KEY_ID'),
      secretAccessKey: text(env, 'AWS_SECRET_ACCESS_KEY'),
      transactionsQueue: fifoQueue(env, 'SQS_TRANSACTIONS_QUEUE'),
      transactionsDlq: fifoQueue(env, 'SQS_TRANSACTIONS_DLQ'),
      eventsQueue: fifoQueue(env, 'SQS_EVENTS_QUEUE'),
    },
    roles: {
      consumer: boolean(env, 'CONSUMER_ENABLED'),
      publisher: boolean(env, 'PUBLISHER_ENABLED'),
      pendingWorker: boolean(env, 'PENDING_WORKER_ENABLED'),
    },
    consumer,
    publisher,
    pendingWorker,
  };
}
