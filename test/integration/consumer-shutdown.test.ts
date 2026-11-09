// T077 — término gracioso do consumidor em processo (US5 cenários 1 a 3; FR-014, FR-015; I-31, I-34, I-65; SC-007), com
// app.close() (os mesmos onApplicationShutdown do handler de sinal), PostgreSQL e MiniStack reais. A mensagem "em
// andamento" fica presa no lock da wallet, segurado por fora com um FOR UPDATE real. Cada teste termina com
// assertWalletMatchesLedger.
import { afterAll, expect, test } from 'bun:test';
import { MikroOrmOutboxRepository } from '../../src/outbox/infrastructure/mikro-orm-outbox.repository.ts';
import { MikroOrmWagerTransactionRepository } from '../../src/wagering/infrastructure/mikro-orm-wager-transaction.repository.ts';
import { startApp, type Roles, type RunningApp } from '../support/app-harness.ts';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';
import { wagerRequest } from '../support/factories.ts';
import { fetcherFor, type WalletBody } from '../support/http.ts';
import { newMessageId, sendEnvelope, wagerEnvelope } from '../support/messages.ts';
import { counts, waitFor, waitForEmpty } from '../support/sqs-client.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { useTestQueues } from '../support/test-queues.ts';
import { openWallet, submitWager } from '../support/wagering.ts';

const database = useTestDatabase('consumer_shutdown');
const queues = useTestQueues('consumer-shutdown');
const opened: RunningApp[] = [];

afterAll(async () => {
  for (const app of opened) await app.close();
});

const BASE_ENV = {
  CONSUMER_WAIT_SECONDS: '1',
  CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '30',
  WALLET_LOCK_TIMEOUT_MS: '1500',
  DB_POOL_ACQUIRE_TIMEOUT_MS: '2000',
  HTTP_SERVER_TIMEOUT_MS: '10000',
};

async function start(env: Record<string, string> = {}, roles: Roles = { consumer: true }) {
  const app = await startApp({ databaseUrl: database.url, roles, queues: queues.env(), env: { ...BASE_ENV, ...env } });
  opened.push(app);
  return app;
}

/**
 * Fecha uma instância que pode estar num long polling e espera o ReceiveMessage dela expirar do lado do MiniStack. O
 * término aborta o long polling só do lado do cliente (plan, "Encerramento gracioso"); o receive pendente no servidor
 * dura até CONSUMER_WAIT_SECONDS e pegaria uma mensagem que ficasse visível nessa janela, escondendo-a por um prazo de
 * visibilidade (implementation-notes N-35). Sem esta espera, essa sobra contaminaria o cenário seguinte do arquivo.
 */
async function closeConsumer(app: RunningApp): Promise<void> {
  await app.close();
  await Bun.sleep(Number(BASE_ENV.CONSUMER_WAIT_SECONDS) * 1_000 + 500);
}

/** Segura o lock da wallet numa conexão própria até `release()`. */
async function holdWalletLock(walletId: string) {
  const holder = await database.db.connect();
  await holder.q.query('BEGIN');
  await holder.q.query('SELECT id FROM wallets WHERE id = ? FOR UPDATE', [walletId]);
  return {
    async release() {
      await holder.q.query('ROLLBACK').catch(() => {});
      holder.release();
    },
  };
}

const transactionsOf = (walletId: string) =>
  database.db.query<{ external_transaction_id: string }>("SELECT external_transaction_id FROM wager_transactions WHERE wallet_id = ? AND kind <> 'OPENING'", [walletId]);
const inboxOf = (messageId: string) => database.db.query('SELECT 1 FROM inbox_messages WHERE message_id = ?', [messageId]);
const logged = (app: RunningApp) => app.logs.map((l) => JSON.parse(l) as Record<string, unknown>);

async function newWallet(app: RunningApp): Promise<WalletBody> {
  return openWallet(fetcherFor(app.baseUrl), '100.00');
}

test('mensagem em andamento no término: termina, é confirmada depois do commit e app.close() espera por ela (cenário 1)', async () => {
  const app = await start();
  const wallet = await newWallet(app);
  const lock = await holdWalletLock(wallet.id);
  const envelope = wagerEnvelope(wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId }), { messageId: newMessageId('inflight') });
  await sendEnvelope(queues.urls.transactions, envelope);
  await waitFor(async () => (await counts(queues.urls.transactions)).notVisible === 1, 10_000, 50); // recebida e presa no lock

  const closing = app.close();
  await Bun.sleep(1_000);
  await lock.release();
  await closing;

  expect(await transactionsOf(wallet.id)).toHaveLength(1);
  expect(await inboxOf(envelope.messageId)).toHaveLength(1);
  const c = await counts(queues.urls.transactions);
  expect(c).toEqual({ visible: 0, notVisible: 0 }); // confirmada (apagada) antes de a app terminar
  const events = logged(app).map((l) => l.msg);
  expect(events.indexOf('consumer.message')).toBeLessThan(events.indexOf('shutdown.workers_drained'));
  await assertWalletMatchesLedger(database.db, wallet.id);
}, 30_000);

test('mensagens recebidas e ainda não iniciadas voltam visíveis na hora e outra instância as processa uma vez (cenário 2)', async () => {
  const setup = await start({}, {});
  const wallet = await newWallet(setup);
  const envelopes = [0, 1, 2].map((i) =>
    wagerEnvelope(wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId, money: { amount: '1.00', currency: 'BRL' } }), {
      messageId: newMessageId(`queued-${i}`),
    }),
  );
  for (const envelope of envelopes) await sendEnvelope(queues.urls.transactions, envelope); // mesmo grupo (a wallet)
  const lock = await holdWalletLock(wallet.id);

  const first = await start();
  // A 1ª mensagem do grupo fica presa no lock; as outras duas vieram no mesmo lote e esperam a vez.
  await waitFor(async () => (await counts(queues.urls.transactions)).notVisible === 3, 10_000, 50);
  const closing = first.close();
  // As não iniciadas voltam visíveis sem esperar os 30 s de visibilidade.
  await waitFor(async () => (await counts(queues.urls.transactions)).visible === 2, 5_000, 50);
  await Bun.sleep(500);
  await lock.release();
  await closing;
  expect(logged(first).filter((l) => l.msg === 'consumer.message_returned' && l.reason === 'not_started')).toHaveLength(2);

  const second = await start();
  await waitFor(async () => (await transactionsOf(wallet.id)).length === 3, 15_000, 100);
  await waitForEmpty(queues.urls.transactions, 10_000);
  for (const envelope of envelopes) expect(await inboxOf(envelope.messageId)).toHaveLength(1);
  expect(await transactionsOf(wallet.id)).toHaveLength(3);
  await closeConsumer(second);
  await assertWalletMatchesLedger(database.db, wallet.id);
}, 60_000);

test('CONSUMER_SHUTDOWN_TIMEOUT_MS curto: a mensagem que não termina no prazo volta visível e é processada uma vez (cenário 2)', async () => {
  const setup = await start({}, {});
  const wallet = await newWallet(setup);
  const envelope = wagerEnvelope(wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId }), { messageId: newMessageId('slow') });
  const lock = await holdWalletLock(wallet.id);
  await sendEnvelope(queues.urls.transactions, envelope);

  const first = await start({ CONSUMER_SHUTDOWN_TIMEOUT_MS: '500' });
  await waitFor(async () => (await counts(queues.urls.transactions)).notVisible === 1, 10_000, 50);
  const closing = first.close();
  // Prazo esgotado com a mensagem ainda presa: a visibilidade volta (0), sem esperar os 30 s.
  await waitFor(async () => (await counts(queues.urls.transactions)).visible === 1, 5_000, 50);
  expect(logged(first).some((l) => l.msg === 'consumer.message_returned' && l.reason === 'shutdown_timeout')).toBe(true);
  await Bun.sleep(3_500); // o lock segue preso além do lock_timeout da 1ª instância: ela desiste sem gravar nada
  await closing;
  expect(await transactionsOf(wallet.id)).toHaveLength(0);
  await lock.release();

  const second = await start();
  await waitFor(async () => (await transactionsOf(wallet.id)).length === 1, 15_000, 100);
  await waitForEmpty(queues.urls.transactions, 15_000);
  expect(await inboxOf(envelope.messageId)).toHaveLength(1);
  await Bun.sleep(1_500); // nenhuma reentrega tardia cria um segundo efeito
  expect(await transactionsOf(wallet.id)).toHaveLength(1);
  await closeConsumer(second);
  await assertWalletMatchesLedger(database.db, wallet.id);
}, 60_000);

test('eventos e pendentes reservados por uma instância encerrada são retomados por outra depois do lease (cenário 3)', async () => {
  const leaseMs = 2_000;
  const first = await start({}, {});
  const http = fetcherFor(first.baseUrl);
  const wallet = await openWallet(http, '100.00');
  const bet = wagerRequest('BET', { walletId: wallet.id, playerId: wallet.playerId });
  const refund = wagerRequest('REFUND', { walletId: wallet.id, playerId: wallet.playerId, referenceExternalTransactionId: bet.externalTransactionId });
  expect((await submitWager(http, refund)).status).toBe(202);
  expect((await submitWager(http, bet)).status).toBe(201);

  // A 1ª instância reserva tudo (o mesmo claim do publicador e do worker) e encerra sem concluir.
  const reservedAt = new Date(Date.now() + 10_000); // tudo já vencido
  const events = await first.orm.em.fork().transactional((em) => new MikroOrmOutboxRepository().claim(em, reservedAt, 100, leaseMs));
  const pendings = await first.orm.em.fork().transactional((em) =>
    new MikroOrmWagerTransactionRepository().claimDuePending(em, reservedAt, 100, leaseMs),
  );
  expect(events.length).toBeGreaterThan(0);
  expect(pendings.map((p) => p.id)).toHaveLength(1);
  await first.close();

  const startedAt = Date.now();
  const second = await start({ PUBLISHER_POLL_MS: '100', PENDING_WORKER_POLL_MS: '100' }, { publisher: true, pendingWorker: true });
  await waitFor(async () => {
    const unpublished = await database.db.query('SELECT 1 FROM outbox_messages WHERE published_at IS NULL');
    const pending = await database.db.query("SELECT 1 FROM wager_transactions WHERE status = 'PENDING_REFERENCE'");
    return unpublished.length === 0 && pending.length === 0;
  }, 20_000, 100);
  // Nada foi retomado antes de o lease da instância encerrada vencer.
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(leaseMs - 1_000);
  const resolved = await database.db.query<{ status: string }>('SELECT status FROM wager_transactions WHERE id = ?', [pendings[0]!.id]);
  expect(resolved[0]!.status).toBe('PROCESSED');
  await second.close();
  await assertWalletMatchesLedger(database.db, wallet.id);
}, 60_000);
