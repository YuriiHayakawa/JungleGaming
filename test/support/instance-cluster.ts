// N processos da app via Bun.spawn, todos no mesmo banco, com cliente round-robin (spike S-10, research R-17).
// No Windows o SIGTERM vira término forçado (saída 143); nenhum teste depende de encerramento gracioso.
// Feature 002 (T033): papéis por env, desligados por padrão (R-27), env das filas do arquivo (R-31) e kill(SIGKILL).
import { join } from 'node:path';
import { roleEnv, type Roles } from './roles.ts';

const ENTRY = join(import.meta.dir, '..', '..', 'src', 'main.ts');
const READY_TIMEOUT_MS = 15_000;
const STOP_GRACE_MS = 5_000;

export interface Instance {
  port: number;
  pid: number;
  baseUrl: string;
  /** Linhas de stdout (logs JSON) da instância. */
  logs: string[];
  exited: Promise<number>;
  stop(): Promise<number | null>;
  /** Queda abrupta (SIGKILL): nenhum hook roda (SC-006). */
  kill(): Promise<number>;
}

export interface Cluster {
  instances: Instance[];
  /** Próxima instância em round-robin. */
  next(): Instance;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  stop(): Promise<void>;
}

export async function startInstance(options: {
  databaseUrl: string;
  env?: Record<string, string>;
  entry?: string;
  roles?: Roles;
  /** Env das filas do arquivo (useTestQueues().env()). */
  queues?: Record<string, string>;
}): Promise<Instance> {
  const proc = Bun.spawn(['bun', options.entry ?? ENTRY], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      FAILPOINT: '',
      ...roleEnv(options.roles),
      ...options.queues,
      ...options.env,
      DATABASE_URL: options.databaseUrl,
      PORT: '0',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const logs: string[] = [];
  let resolveReady: (port: number) => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const ready = new Promise<number>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  // Drena o stdout continuamente (para não bloquear o pipe) e detecta a linha de prontidão.
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        logs.push(line);
        if (line.includes('"event":"http.listening"')) {
          const port = (JSON.parse(line) as { port: number }).port;
          resolveReady(port);
        }
        newline = buffer.indexOf('\n');
      }
    }
    rejectReady(new Error('instance exited before becoming ready'));
  })();
  const stderr = new Response(proc.stderr).text();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('instance not ready in time')), READY_TIMEOUT_MS);
  });

  let port: number;
  try {
    port = await Promise.race([ready, timeout]);
  } catch (error) {
    proc.kill('SIGKILL');
    await proc.exited;
    throw new Error(`${(error as Error).message}; stderr: ${(await stderr).slice(0, 2000)}`);
  } finally {
    clearTimeout(timer);
  }

  return {
    port,
    pid: proc.pid,
    baseUrl: `http://127.0.0.1:${port}`,
    logs,
    exited: proc.exited,
    async kill() {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
      return proc.exited;
    },
    async stop() {
      if (proc.exitCode !== null || proc.signalCode !== null) return proc.exitCode;
      proc.kill('SIGTERM');
      const result = await Promise.race([proc.exited, Bun.sleep(STOP_GRACE_MS).then(() => 'timeout' as const)]);
      if (result === 'timeout') {
        proc.kill('SIGKILL');
        return proc.exited;
      }
      return result;
    },
  };
}

export async function startCluster(options: {
  size?: number;
  databaseUrl: string;
  env?: Record<string, string>;
  roles?: Roles;
  queues?: Record<string, string>;
}): Promise<Cluster> {
  const size = options.size ?? 3;
  const started = await Promise.allSettled(
    Array.from({ length: size }, () =>
      startInstance({ databaseUrl: options.databaseUrl, env: options.env, roles: options.roles, queues: options.queues }),
    ),
  );
  const instances = started.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  const failure = started.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failure) {
    await Promise.all(instances.map((i) => i.stop()));
    throw failure.reason;
  }

  let cursor = 0;
  const next = () => {
    const instance = instances[cursor % instances.length];
    cursor += 1;
    if (!instance) throw new Error('cluster has no instances');
    return instance;
  };
  return {
    instances,
    next,
    fetch: (path, init) => fetch(`${next().baseUrl}${path}`, init),
    async stop() {
      await Promise.all(instances.map((i) => i.stop()));
    },
  };
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
