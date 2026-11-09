// Proxy TCP de teste entre a app e o PostgreSQL (research R-17, US9). Não é mock: o tráfego é o protocolo real do
// PostgreSQL, repassado byte a byte. `cut()` derruba as conexões abertas e passa a recusar as novas (aceita e fecha na
// hora); `stall()` deixa as conexões penduradas, sem resposta (003); `restore()` volta a repassar. A app não sabe do
// proxy: só recebe uma DATABASE_URL apontando para ele.
import type { Socket, TCPSocketListener } from 'bun';

interface Pipe {
  upstream?: Socket<Peer>;
  /** Bytes do cliente que chegaram antes de o upstream conectar. */
  early: Uint8Array[];
  /** Bytes que o destino ainda não aceitou (backpressure), por direção. */
  toUpstream: Uint8Array[];
  toClient: Uint8Array[];
  closed: boolean;
}

interface Peer {
  pipe: Pipe;
  side: 'client' | 'upstream';
}

export interface TcpProxy {
  /** URL igual à de origem, com host e porta trocados pelos do proxy. */
  readonly url: string;
  readonly port: number;
  /** Conexões repassadas abertas agora. */
  readonly openConnections: number;
  cut(): void;
  /**
   * Modo "pendurado" (feature 003, R-45): as conexões novas são aceitas e nenhuma conexão (nova ou já aberta) repassa
   * nem recebe mais nada; o cliente fica esperando uma resposta que não vem. Diferente do `cut()`, que derruba e recusa.
   * No `restore()` e no `close()`, todas as conexões que passaram pelo modo pendurado são fechadas (bytes foram
   * descartados, então elas não podem continuar) e o cliente reconecta.
   */
  stall(): void;
  restore(): void;
  close(): void;
}

/** Escreve o que couber e guarda o resto para o `drain`. */
function writeAll(socket: Socket<Peer>, queue: Uint8Array[], chunk?: Uint8Array): void {
  if (chunk) queue.push(chunk);
  while (queue.length > 0) {
    const head = queue[0]!;
    const written = socket.write(head);
    if (written < head.byteLength) {
      queue[0] = head.subarray(Math.max(written, 0));
      return;
    }
    queue.shift();
  }
}

export async function startTcpProxy(targetUrl: string): Promise<TcpProxy> {
  const target = new URL(targetUrl);
  const targetHost = target.hostname;
  const targetPort = Number.parseInt(target.port || '5432', 10);
  const pipes = new Set<Pipe>();
  const clients = new Map<Pipe, Socket<Peer>>();
  let isCut = false;
  let isStalled = false;

  const closePipe = (pipe: Pipe) => {
    if (pipe.closed) return;
    pipe.closed = true;
    pipes.delete(pipe);
    clients.get(pipe)?.terminate();
    clients.delete(pipe);
    pipe.upstream?.terminate();
  };

  const listener: TCPSocketListener<Peer> = Bun.listen<Peer>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(client) {
        const pipe: Pipe = { early: [], toUpstream: [], toClient: [], closed: false };
        client.data = { pipe, side: 'client' };
        if (isCut) {
          // recusa: aceita e derruba na hora, como um servidor que caiu
          client.terminate();
          return;
        }
        pipes.add(pipe);
        clients.set(pipe, client);
        if (isStalled) return; // pendurado: aceita e não conecta ao destino
        void Bun.connect<Peer>({
          hostname: targetHost,
          port: targetPort,
          socket: {
            open(upstream) {
              upstream.data = { pipe, side: 'upstream' };
              if (pipe.closed) {
                upstream.terminate();
                return;
              }
              pipe.upstream = upstream;
              for (const chunk of pipe.early.splice(0)) writeAll(upstream, pipe.toUpstream, chunk);
            },
            data(_upstream, chunk) {
              if (isStalled) return; // pendurado: a resposta nunca chega ao cliente
              const socket = clients.get(pipe);
              if (socket) writeAll(socket, pipe.toClient, new Uint8Array(chunk));
            },
            drain(upstream) {
              writeAll(upstream, pipe.toUpstream);
            },
            close() {
              closePipe(pipe);
            },
            error() {
              closePipe(pipe);
            },
            connectError() {
              closePipe(pipe);
            },
          },
        }).catch(() => closePipe(pipe));
      },
      data(client, chunk) {
        const { pipe } = client.data;
        if (isStalled) return; // pendurado: nada segue para o destino
        const bytes = new Uint8Array(chunk);
        if (pipe.upstream) writeAll(pipe.upstream, pipe.toUpstream, bytes);
        else pipe.early.push(bytes);
      },
      drain(client) {
        writeAll(client, client.data.pipe.toClient);
      },
      close(client) {
        closePipe(client.data.pipe);
      },
      error(client) {
        closePipe(client.data.pipe);
      },
    },
  });

  const url = new URL(targetUrl);
  url.hostname = '127.0.0.1';
  url.port = String(listener.port);

  return {
    url: url.toString(),
    port: listener.port,
    get openConnections() {
      return pipes.size;
    },
    cut() {
      isCut = true;
      for (const pipe of [...pipes]) closePipe(pipe);
    },
    stall() {
      isStalled = true;
    },
    restore() {
      isCut = false;
      if (isStalled) {
        isStalled = false;
        for (const pipe of [...pipes]) closePipe(pipe);
      }
    },
    close() {
      isCut = true;
      isStalled = false;
      for (const pipe of [...pipes]) closePipe(pipe);
      listener.stop(true);
    },
  };
}
