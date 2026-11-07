// Atalhos de teste para abrir wallets e submeter transações pela API real (sem mocks).
import { idempotencyKeyFor, walletRequest, type WagerRequest } from './factories.ts';
import { postJson, type Fetcher, type JsonResponse, type TransactionResultBody, type WalletBody } from './http.ts';

export async function openWallet(http: Fetcher, amount: string, currency = 'BRL', playerId?: string): Promise<WalletBody> {
  const response = await postJson<WalletBody>(
    http,
    '/wallets',
    walletRequest({ initialBalance: { amount, currency }, ...(playerId ? { playerId } : {}) }),
  );
  if (response.status !== 201) throw new Error(`could not open wallet: ${response.status} ${JSON.stringify(response.body)}`);
  return response.body;
}

export function submitWager<B = TransactionResultBody>(
  http: Fetcher,
  request: WagerRequest,
  headers: Record<string, string> = {},
): Promise<JsonResponse<B>> {
  return postJson<B>(http, '/wagering/transactions', request, { 'Idempotency-Key': idempotencyKeyFor(request), ...headers });
}
