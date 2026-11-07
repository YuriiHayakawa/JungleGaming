// T126 — mesma Idempotency-Key em paralelo com payloads diferentes (FR-034, FR-035, I-24, I-27, I-56, R-08 passo 3;
// edge case "mesma chave, payload diferente, em paralelo"). Cada cenário repetido 10 vezes, com chave nova a cada vez.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { idempotencyKeyFor, wagerRequest, type WagerRequest } from '../support/factories.ts';
import { fetcherFor, type ErrorBody, type JsonResponse, type TransactionResultBody } from '../support/http.ts';
import { startCluster, type Cluster } from '../support/instance-cluster.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('idempotency_race');
const REPETITIONS = 10;
let cluster: Cluster;

beforeAll(async () => {
  cluster = await startCluster({ size: 3, databaseUrl: database.url });
});
afterAll(async () => {
  await cluster?.stop();
});

type Response = JsonResponse<TransactionResultBody & ErrorBody>;

/** Contagem, nos logs das 3 instâncias, de onde cada duplicata foi reconhecida (linhas `wager.idempotency`). */
function idempotencyLogSources(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const instance of cluster.instances) {
    for (const line of instance.logs) {
      if (!line.includes('"wager.idempotency"')) continue;
      const entry = JSON.parse(line) as { source: string; amount?: unknown; money?: unknown };
      expect(entry.amount).toBeUndefined();
      expect(entry.money).toBeUndefined();
      counts[entry.source] = (counts[entry.source] ?? 0) + 1;
    }
  }
  return counts;
}

/**
 * Dispara as requisições em paralelo (distribuídas nas 3 instâncias) e confere: exatamente 1 efeito; quem tem o hash
 * da vencedora recebe replay (ou é a própria vencedora, 201); todos os outros recebem 409; nenhum 500 ou 503.
 */
async function race(requests: { group: 'A' | 'B'; request: WagerRequest }[], key: string) {
  const responses: Response[] = await Promise.all(
    requests.map(({ request }, i) =>
      submitWager<TransactionResultBody & ErrorBody>(fetcherFor(cluster.instances[i % 3]!.baseUrl), request, { 'Idempotency-Key': key }),
    ),
  );
  const statuses = responses.map((r) => r.status);
  expect(statuses.every((s) => [200, 201, 409].includes(s)), `statuses: ${statuses.join(',')}`).toBe(true);

  const winners = responses.filter((r) => r.status === 201);
  expect(winners).toHaveLength(1);
  const winnerIndex = responses.indexOf(winners[0]!);
  const winnerGroup = requests[winnerIndex]!.group;
  const transactionId = winners[0]!.body.transactionId;

  responses.forEach((response, i) => {
    if (i === winnerIndex) return;
    if (requests[i]!.group === winnerGroup) {
      expect(response.status, `replay esperado para a requisição ${i}`).toBe(200);
      expect(response.body).toMatchObject({ transactionId, idempotentReplay: true });
    } else {
      expect(response.status, `409 esperado para a requisição ${i}`).toBe(409);
      expect(response.body.error).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', retryable: false });
    }
  });

  // exatamente 1 transação para a chave e no máximo 1 lançamento dela
  const providerId = requests[0]!.request.providerId;
  const txs = await database.db.query<{ id: string }>('SELECT id FROM wager_transactions WHERE provider_id = ? AND idempotency_key = ?', [
    providerId,
    key,
  ]);
  expect(txs).toEqual([{ id: transactionId }]);
  const entries = await database.db.query('SELECT id FROM wallet_ledger_entries WHERE transaction_id = ?', [transactionId]);
  expect(entries.length).toBeLessThanOrEqual(1);
  return { winnerGroup };
}

describe('mesma chave em paralelo', () => {
  test(`(a) payloads diferentes na mesma wallet (5 × 10.00 e 5 × 20.00), ${REPETITIONS} vezes`, async () => {
    for (let round = 0; round < REPETITIONS; round++) {
      const wallet = await openWallet(cluster.fetch, '1000.00');
      const base = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId });
      const key = idempotencyKeyFor(base);
      const requests = Array.from({ length: 10 }, (_, i) => {
        const group = i % 2 === 0 ? ('A' as const) : ('B' as const);
        return { group, request: { ...base, money: { amount: group === 'A' ? '10.00' : '20.00', currency: 'BRL' } } };
      });
      await race(requests, key);
      await assertWalletMatchesLedger(database.db, wallet.id);
    }
  }, 120_000);

  test(`(b) walletId diferentes (X e Y), mesma chave e mesmo externalTransactionId, ${REPETITIONS} vezes`, async () => {
    const winners = { A: 0, B: 0 };
    for (let round = 0; round < REPETITIONS; round++) {
      const [x, y] = await Promise.all([openWallet(cluster.fetch, '1000.00'), openWallet(cluster.fetch, '1000.00')]);
      const onX = wagerRequest('BET', { walletId: x.id, playerId: x.playerId, money: { amount: '10.00', currency: 'BRL' } });
      const onY: WagerRequest = { ...onX, walletId: y.id, playerId: y.playerId };
      const key = idempotencyKeyFor(onX);
      const requests = Array.from({ length: 10 }, (_, i) =>
        i % 2 === 0 ? { group: 'A' as const, request: onX } : { group: 'B' as const, request: onY },
      );
      const { winnerGroup } = await race(requests, key);
      winners[winnerGroup] += 1;
      await assertWalletMatchesLedger(database.db, x.id);
      await assertWalletMatchesLedger(database.db, y.id);
    }
    expect(winners.A + winners.B).toBe(REPETITIONS);

    // o cenário existe para exercitar o R-08 passo 3: ao menos uma rodada foi resolvida pela releitura depois do 23505
    const sources = idempotencyLogSources();
    console.log(`T126(b) caminhos das duplicatas: ${JSON.stringify(sources)}`);
    expect(sources['after-unique-violation'] ?? 0, JSON.stringify(sources)).toBeGreaterThanOrEqual(1);
  }, 120_000);
});
