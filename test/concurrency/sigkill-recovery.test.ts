// T061 — SIGKILL no meio da carga (SC-006, SC-008; FR-007, FR-013, FR-016): 3 instâncias com papéis diferentes
// (consumidor; consumidor + publicador; publicador), carga mista pela fila e por HTTP em 20 wallets (BET, WIN, LOSS,
// REFUND de BET existente e de referência inexistente). Durante a carga, SIGKILL de uma instância aleatória três vezes,
// com substituição por outra de mesmo papel. Ao final, depois da recuperação: wallet == ledger em todas; todo evento
// confirmado tem published_at e aparece em wager-events; toda mensagem enviada foi processada uma vez (uma linha de
// inbox) ou está na DLQ; nenhuma PENDING_REFERENCE sem next_reference_attempt_at. A US4 estende este teste com o worker.
import { afterAll, expect, test } from 'bun:test';
import { assertAllWalletsMatchLedger } from '../support/assert-wallet-matches-ledger.ts';
import { idempotencyKeyFor, wagerRequest, walletRequest, type WagerRequest } from '../support/factories.ts';
import type { Roles } from '../support/roles.ts';
import { startInstance, type Instance } from '../support/instance-cluster.ts';
import { newMessageId, sendEnvelope, wagerEnvelope } from '../support/messages.ts';
import { collectUntil, counts, drainQueue, waitFor } from '../support/sqs-client.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { useTestQueues } from '../support/test-queues.ts';

const database = useTestDatabase('sigkill_recovery');
const queues = useTestQueues('sigkill-recovery');
const WALLETS = 20;
const KILLS = 3;

// Visibilidade e leases curtos para a recuperação depois de cada queda (R-27: 6 s > 2 s + 1 s + 2 s).
const SHORT = {
  WALLET_LOCK_TIMEOUT_MS: '1000',
  DB_POOL_ACQUIRE_TIMEOUT_MS: '2000',
  CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '6',
  CONSUMER_RETRY_BASE_SECONDS: '1',
  CONSUMER_WAIT_SECONDS: '1',
  PUBLISHER_LEASE_MS: '6000',
  PENDING_WORKER_LEASE_MS: '6000',
  PUBLISHER_POLL_MS: '200',
};

interface Slot {
  roles: Roles;
  instance: Instance;
}

const everyInstance: Instance[] = [];
const slots: Slot[] = [];

afterAll(async () => {
  for (const instance of everyInstance) await instance.stop();
});

async function launch(roles: Roles): Promise<Instance> {
  const instance = await startInstance({ databaseUrl: database.url, roles, queues: queues.env(), env: SHORT });
  everyInstance.push(instance);
  return instance;
}

/** POST com nova tentativa em outra instância quando a escolhida caiu ou respondeu 503 (a chave é a mesma: replay seguro). */
async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const slot = slots[attempt % slots.length]!;
    try {
      const response = await fetch(`${slot.instance.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      if (response.status === 503) {
        await Bun.sleep(200);
        continue;
      }
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    } catch {
      await Bun.sleep(100); // instância morta: tenta outra
    }
  }
  throw new Error(`POST ${path} failed on every instance`);
}

const submit = (request: WagerRequest) => post('/wagering/transactions', request, { 'Idempotency-Key': idempotencyKeyFor(request) });

test('SIGKILL aleatório três vezes no meio da carga: invariantes preservadas depois da recuperação', async () => {
  for (const roles of [{ consumer: true }, { consumer: true, publisher: true }, { publisher: true }] satisfies Roles[]) {
    slots.push({ roles, instance: await launch(roles) });
  }

  const wallets: Array<{ id: string; playerId: string }> = [];
  for (let i = 0; i < WALLETS; i++) {
    const created = await post('/wallets', walletRequest({ initialBalance: { amount: '1000.00', currency: 'BRL' } }));
    expect(created.status).toBe(201);
    wallets.push({ id: String(created.body.id), playerId: String(created.body.playerId) });
  }

  const sentMessages: Array<{ messageId: string; externalId: string }> = [];
  const httpRequests: WagerRequest[] = [];

  async function load(wallet: { id: string; playerId: string }) {
    const base = { walletId: wallet.id, playerId: wallet.playerId };
    const bet = wagerRequest('BET', { ...base, money: { amount: '10.00', currency: 'BRL' } });
    const queued = [
      bet,
      wagerRequest('WIN', { ...base, money: { amount: '3.00', currency: 'BRL' }, referenceExternalTransactionId: bet.externalTransactionId }),
      wagerRequest('REFUND', { ...base, money: { amount: '10.00', currency: 'BRL' }, referenceExternalTransactionId: bet.externalTransactionId }),
    ];
    for (const request of queued) {
      const envelope = wagerEnvelope(request, { messageId: newMessageId('load') });
      await sendEnvelope(queues.urls.transactions, envelope);
      sentMessages.push({ messageId: envelope.messageId, externalId: request.externalTransactionId });
    }
    const viaHttp = [
      wagerRequest('BET', { ...base, money: { amount: '5.00', currency: 'BRL' } }),
      wagerRequest('LOSS', { ...base, money: { amount: '0.00', currency: 'BRL' } }),
      wagerRequest('REFUND', { ...base, money: { amount: '7.00', currency: 'BRL' }, referenceExternalTransactionId: `never-${crypto.randomUUID()}` }),
    ];
    for (const request of viaHttp) {
      const response = await submit(request);
      expect([200, 201, 202, 422]).toContain(response.status);
      httpRequests.push(request);
    }
  }

  async function chaos() {
    for (let k = 0; k < KILLS; k++) {
      await Bun.sleep(700 + Math.floor(Math.random() * 800));
      const index = Math.floor(Math.random() * slots.length);
      const slot = slots[index]!;
      await slot.instance.kill();
      slot.instance = await launch(slot.roles); // substituta com o mesmo papel
    }
  }

  await Promise.all([Promise.all(wallets.map((wallet) => load(wallet))), chaos()]);
  expect(everyInstance.length).toBe(3 + KILLS);

  // Recuperação: fila principal vazia e nenhum evento pendente.
  await waitFor(async () => {
    const c = await counts(queues.urls.transactions);
    const pending = await database.db.query('SELECT 1 FROM outbox_messages WHERE published_at IS NULL');
    return c.visible === 0 && c.notVisible === 0 && pending.length === 0;
  }, 120_000, 500);

  // wallet == ledger em todas as wallets.
  expect(await assertAllWalletsMatchLedger(database.db)).toBe(WALLETS);

  // Toda mensagem enviada: processada uma vez (uma linha de inbox e uma transação) ou na DLQ.
  const dlq = await drainQueue(queues.urls.dlq, { quietMs: 1_000, timeoutMs: 5_000 });
  const inDlq = new Set(dlq.map((m) => (JSON.parse(m.body) as { messageId: string }).messageId));
  for (const { messageId, externalId } of sentMessages) {
    const inbox = await database.db.query('SELECT 1 FROM inbox_messages WHERE message_id = ?', [messageId]);
    if (inbox.length === 0) {
      expect(inDlq.has(messageId)).toBe(true);
      continue;
    }
    expect(inbox).toHaveLength(1);
    expect(await database.db.query('SELECT 1 FROM wager_transactions WHERE external_transaction_id = ?', [externalId])).toHaveLength(1);
  }
  for (const request of httpRequests) {
    expect(
      await database.db.query('SELECT 1 FROM wager_transactions WHERE external_transaction_id = ?', [request.externalTransactionId]),
    ).toHaveLength(1);
  }

  // Todo evento confirmado tem published_at e aparece em wager-events.
  const events = await database.db.query<{ id: string; published_at: Date | null }>('SELECT id, published_at FROM outbox_messages');
  expect(events.every((e) => e.published_at !== null)).toBe(true);
  const ids = events.map((e) => e.id);
  await collectUntil(queues.urls.events, (got) => ids.every((id) => got.some((m) => m.deduplicationId === id)), 60_000);

  // Nenhuma pendência esquecida: toda PENDING_REFERENCE tem a próxima tentativa agendada.
  const forgotten = await database.db.query(
    "SELECT 1 FROM wager_transactions WHERE status = 'PENDING_REFERENCE' AND next_reference_attempt_at IS NULL",
  );
  expect(forgotten).toHaveLength(0);
}, 300_000);
