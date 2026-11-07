// S-10: harness que sobe processos da app com Bun.spawn e espera a linha de log de prontidão.
import { join } from 'node:path';

export interface Instance {
  port: number;
  pid: number;
  stop(): Promise<number | null>;
  exited: Promise<number>;
}

const ENTRY = join(import.meta.dir, '..', '..', 'src', 'http-app.ts');

export async function startInstance(options: {
  port: number;
  env?: Record<string, string>;
  entry?: string;
  readyTimeoutMs?: number;
}): Promise<Instance> {
  const proc = Bun.spawn(['bun', options.entry ?? ENTRY], {
    env: { ...process.env, PORT: String(options.port), ...options.env },
    stdout: 'pipe',
    stderr: 'inherit',
  });

  const ready = (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      if (buffer.includes('"event":"http.listening"')) return;
    }
    throw new Error(`instance on port ${options.port} exited before becoming ready`);
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`instance on port ${options.port} not ready in time`)),
      options.readyTimeoutMs ?? 15_000,
    );
  });

  try {
    await Promise.race([ready, timeout]);
  } catch (e) {
    proc.kill();
    await proc.exited;
    throw e;
  } finally {
    clearTimeout(timer);
  }

  return {
    port: options.port,
    pid: proc.pid,
    exited: proc.exited,
    async stop() {
      if (proc.exitCode !== null || proc.signalCode !== null) return proc.exitCode;
      proc.kill('SIGTERM');
      const result = await Promise.race([proc.exited, Bun.sleep(5_000).then(() => 'timeout' as const)]);
      if (result === 'timeout') {
        proc.kill('SIGKILL');
        return proc.exited;
      }
      return result;
    },
  };
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
