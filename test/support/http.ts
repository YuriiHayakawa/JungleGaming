// Cliente HTTP mínimo dos testes: JSON de ida e volta, sem nenhum mock.

export interface JsonResponse<B = Record<string, unknown>> {
  status: number;
  headers: Headers;
  body: B;
  /** Tempo de ida e volta, em ms. */
  elapsedMs: number;
}

export type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;

export function fetcherFor(baseUrl: string): Fetcher {
  return (path, init) => fetch(`${baseUrl}${path}`, init);
}

export async function postJson<B = Record<string, unknown>>(
  fetcher: Fetcher,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<JsonResponse<B>> {
  const started = performance.now();
  const response = await fetcher(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  const elapsedMs = performance.now() - started;
  return { status: response.status, headers: response.headers, body: (text ? JSON.parse(text) : {}) as B, elapsedMs };
}

export interface WalletBody {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}

export interface TransactionResultBody {
  transactionId: string;
  status: string;
  balance: { amount: string; currency: string };
  idempotentReplay: boolean;
  failureCode?: string;
  retryable?: boolean;
}

export interface ErrorBody {
  error: { code: string; message: string; retryable: boolean; correlationId: string; details?: Record<string, unknown> };
}
