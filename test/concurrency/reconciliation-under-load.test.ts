// T014 — reconciliação durante escritas concorrentes: nunca falso positivo (US1 cenário 5; FR-002, FR-010; SC-003;
// constitution III). 3 instâncias (processos reais) no mesmo banco; 50 BETs concorrentes numa wallet, distribuídas
// pelas 3; ao mesmo tempo, cada instância reconcilia a mesma wallet em laço até as BETs terminarem, de modo que toda
// leitura disputa com escritas da própria instância e das outras. Saldo 300.00 e BETs de 10.00: 30 aceitas e 20
// rejeitadas por saldo, para misturar os dois caminhos.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { wagerRequest } from '../support/factories.ts';
import { fetcherFor, postJson, type TransactionResultBody } from '../support/http.ts';
import { startCluster, type Cluster } from '../support/instance-cluster.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('reconciliation_load');
const BETS = 50;
let cluster: Cluster;

beforeAll(async () => {
  cluster = await startCluster({ size: 3, databaseUrl: database.url });
});
afterAll(async () => {
  await cluster?.stop();
});

interface ReconciliationBody {
  storedBalance: { amount: string; currency: string };
  calculatedBalance: { amount: string; currency: string };
  difference: { amount: string; currency: string };
  consistent: boolean;
  chainConsistent: boolean;
  checkedEntries: number;
  firstBrokenSeq?: number;
}

test(`${BETS} BETs concorrentes em 3 instâncias com reconciliação em laço: toda leitura consistente`, async () => {
  const instances = cluster.instances;
  expect(instances).toHaveLength(3);
  const wallet = await openWallet(fetcherFor(instances[0]!.baseUrl), '300.00');

  let writing = true;
  const loops = instances.map(async (instance) => {
    const reads: ReconciliationBody[] = [];
    const http = fetcherFor(instance.baseUrl);
    while (writing) {
      const response = await postJson<ReconciliationBody>(http, `/wallets/${wallet.id}/reconciliation`, '');
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      reads.push(response.body);
    }
    return reads;
  });

  const bets = Array.from({ length: BETS }, () =>
    wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '10.00', currency: 'BRL' } }),
  );
  let responses: Array<{ status: number; body: TransactionResultBody }>;
  try {
    // Deixa os laços começarem antes da rajada.
    await Bun.sleep(50);
    responses = await Promise.all(bets.map((bet, i) => submitWager<TransactionResultBody>(fetcherFor(instances[i % 3]!.baseUrl), bet)));
  } finally {
    writing = false;
  }
  const readsPerInstance = await Promise.all(loops);

  const accepted = responses.filter((r) => r.status === 201 && r.body.status === 'PROCESSED');
  const rejected = responses.filter((r) => r.status === 422 && r.body.failureCode === 'INSUFFICIENT_FUNDS');
  expect(accepted).toHaveLength(30);
  expect(rejected).toHaveLength(20);

  const allReads = readsPerInstance.flat();
  // Leituras de fato concorrentes com as escritas: houve leituras que viram estados intermediários.
  expect(allReads.length).toBeGreaterThan(3);
  expect(new Set(allReads.map((r) => r.checkedEntries)).size).toBeGreaterThan(1);
  for (const read of allReads) {
    expect(read.consistent, JSON.stringify(read)).toBe(true);
    expect(read.chainConsistent).toBe(true);
    expect(read.difference).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(read.storedBalance).toEqual(read.calculatedBalance);
    expect('firstBrokenSeq' in read).toBe(false);
  }
  // Em cada laço (leituras sequenciais), o número de lançamentos vistos nunca diminui.
  for (const reads of readsPerInstance) {
    for (let i = 1; i < reads.length; i++) expect(reads[i]!.checkedEntries).toBeGreaterThanOrEqual(reads[i - 1]!.checkedEntries);
  }
  console.log(`reconciliation-under-load: ${readsPerInstance.map((r) => r.length).join('+')} leituras, todas consistentes`);

  const final = await postJson<ReconciliationBody>(fetcherFor(instances[1]!.baseUrl), `/wallets/${wallet.id}/reconciliation`, '');
  expect(final.status).toBe(200);
  expect(final.body).toMatchObject({
    storedBalance: { amount: '0.00', currency: 'BRL' },
    consistent: true,
    chainConsistent: true,
    checkedEntries: 1 + accepted.length,
  });
  await assertWalletMatchesLedger(database.db, wallet.id);
}, 120_000);
