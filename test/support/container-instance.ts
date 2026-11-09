// Instância da app num container Linux (research R-30): sinal real (SIGTERM) com a app como PID 1 (`app-test`) ou atrás
// do init do Docker (`app-test-init`). No Windows o SIGTERM do Bun.spawn vira término forçado (001, S-10), então o
// término gracioso só é verificável assim. Sobe na rede do Compose: PostgreSQL em postgres:5432 e MiniStack em sqs:4566.
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const READY_TIMEOUT_MS = 60_000;

export type ContainerService = 'app-test' | 'app-test-init';

export interface ContainerInstance {
  readonly id: string;
  kill(signal: 'SIGTERM' | 'SIGINT' | 'SIGKILL'): Promise<void>;
  /** Espera o container sair e devolve o código de saída. */
  wait(timeoutMs?: number): Promise<number>;
  logs(): Promise<string>;
  remove(): Promise<void>;
}

async function run(args: string[], options: { allowFailure?: boolean } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(args, { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: process.env });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0 && !options.allowFailure) {
    throw new Error(`${args.join(' ')} exited with ${code}: ${stderr.slice(0, 2000)}`);
  }
  return { code, stdout, stderr };
}

let built: Promise<void> | undefined;

/** Constrói a imagem do profile `test` uma vez por execução (as duas variantes usam o mesmo build). */
export function buildTestImage(): Promise<void> {
  built ??= run(['docker', 'compose', '--profile', 'test', 'build', 'app-test', 'app-test-init']).then(() => undefined);
  return built;
}

/** URL do banco do arquivo de teste, vista de dentro da rede do Compose. */
export function containerDatabaseUrl(hostUrl: string): string {
  const url = new URL(hostUrl);
  url.hostname = 'postgres';
  url.port = '5432';
  return url.toString();
}

export async function startContainerInstance(options: {
  service: ContainerService;
  env: Record<string, string>;
}): Promise<ContainerInstance> {
  await buildTestImage();
  const envArgs = Object.entries(options.env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  const started = await run(['docker', 'compose', '--profile', 'test', 'run', '-d', '--no-deps', ...envArgs, options.service]);
  const id = started.stdout.trim().split(/\s+/).pop() ?? '';
  if (!id) throw new Error(`docker compose run returned no container id: ${started.stdout} ${started.stderr}`);

  const instance: ContainerInstance = {
    id,
    async kill(signal) {
      await run(['docker', 'kill', '--signal', signal, id]);
    },
    async wait(timeoutMs = 60_000) {
      const waiting = run(['docker', 'wait', id]).then((r) => Number.parseInt(r.stdout.trim(), 10));
      const timeout = Bun.sleep(timeoutMs).then(() => {
        throw new Error(`container ${id} did not exit in ${timeoutMs} ms`);
      });
      return Promise.race([waiting, timeout]);
    },
    async logs() {
      const out = await run(['docker', 'logs', id], { allowFailure: true });
      return `${out.stdout}${out.stderr}`;
    },
    async remove() {
      await run(['docker', 'rm', '-f', id], { allowFailure: true });
    },
  };

  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const logs = await instance.logs();
    if (logs.includes('"event":"http.listening"')) return instance;
    const state = await run(['docker', 'inspect', '-f', '{{.State.Running}}', id], { allowFailure: true });
    if (state.stdout.trim() === 'false' || Date.now() > deadline) {
      await instance.remove();
      throw new Error(`container ${options.service} not ready: ${logs.slice(-2000)}`);
    }
    await Bun.sleep(250);
  }
}
