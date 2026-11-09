// Console de demonstração (opcional): `bun run demo` → http://127.0.0.1:4000
//
// Serve demo/index.html e faz proxy de /api/1/*, /api/2/* e /api/3/* para as instâncias do cluster do Compose
// (3001, 3002 e 3003). Escuta só em localhost. Não muda nada na API: o navegador fala com este proxy para evitar CORS.

const INSTANCES: Record<string, string> = {
  '1': process.env.DEMO_INSTANCE_1 ?? 'http://localhost:3001',
  '2': process.env.DEMO_INSTANCE_2 ?? 'http://localhost:3002',
  '3': process.env.DEMO_INSTANCE_3 ?? 'http://localhost:3003',
};
const FORWARDED_REQUEST_HEADERS = ['content-type', 'idempotency-key', 'x-correlation-id'];
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'x-correlation-id', 'retry-after'];
const PORT = Number.parseInt(process.env.DEMO_PORT ?? '4000', 10);
const page = Bun.file(new URL('./index.html', import.meta.url));

async function proxy(request: Request, instance: string, path: string, search: string): Promise<Response> {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  try {
    const upstream = await fetch(`${instance}/${path}${search}`, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      signal: AbortSignal.timeout(25_000),
    });
    const out = new Headers({ 'cache-control': 'no-store' });
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) out.set(name, value);
    }
    return new Response(await upstream.arrayBuffer(), { status: upstream.status, headers: out });
  } catch {
    return Response.json({ error: 'instance_unreachable' }, { status: 502, headers: { 'cache-control': 'no-store' } });
  }
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }
    const match = /^\/api\/([123])\/(.*)$/.exec(url.pathname);
    if (match) {
      const instance = INSTANCES[match[1]!];
      if (instance !== undefined) return proxy(request, instance, match[2]!, url.search);
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  },
});

console.log(`console de demonstração em http://${server.hostname}:${server.port} (instâncias: ${Object.values(INSTANCES).join(', ')})`);
