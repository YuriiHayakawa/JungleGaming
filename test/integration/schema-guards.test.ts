// T046 — cada guarda da data-model §2, exercitada por SQL direto no PostgreSQL real
// (SC-008, FR-008, FR-025, FR-029, FR-039, FR-041, FR-042, I-16, I-24, I-36, I-56).
// Lista de permitidos do T118: TRUNCATE e DELETE só aparecem inline em expect(...).rejects, para provar a recusa.
import { describe, expect, test } from 'bun:test';
import type { Queryable } from '../support/db.ts';
import { useTestDatabase } from '../support/test-database.ts';
import { assertWalletMatchesLedger } from '../support/assert-wallet-matches-ledger.ts';

const database = useTestDatabase('schema_guards');
const HASH = 'a'.repeat(64);
const uuid = () => Bun.randomUUIDv7();

interface TxColumns {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;
  kind: string;
  amount: string;
  currency: string;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  status: string;
  failure_code: string | null;
  observed_balance: string | null;
  observed_balance_currency: string | null;
  correlation_id: string;
  reference_attempts: number;
  next_reference_attempt_at: Date | null;
  created_at: Date;
  processed_at: Date | null;
  updated_at: Date;
}

function txColumns(walletId: string, playerId: string, overrides: Partial<TxColumns> = {}): TxColumns {
  const now = new Date();
  const status = overrides.status ?? 'PROCESSED';
  return {
    id: uuid(),
    provider_id: 'provider-a',
    external_transaction_id: uuid(),
    idempotency_key: uuid(),
    payload_hash: HASH,
    wallet_id: walletId,
    player_id: playerId,
    round_id: 'round-1',
    game_id: 'game-1',
    kind: 'LOSS',
    amount: '0.00',
    currency: 'BRL',
    reference_external_transaction_id: null,
    reference_transaction_id: null,
    status,
    failure_code: null,
    observed_balance: '0.00',
    observed_balance_currency: 'BRL',
    correlation_id: 'corr-1',
    reference_attempts: 0,
    next_reference_attempt_at: null,
    created_at: now,
    processed_at: status === 'PROCESSED' ? now : null,
    updated_at: now,
    ...overrides,
  };
}

async function insertTx(q: Queryable, columns: TxColumns): Promise<string> {
  const keys = Object.keys(columns);
  await q.query(
    `INSERT INTO wager_transactions (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    Object.values(columns),
  );
  return columns.id;
}

async function insertWallet(q: Queryable, w: { id: string; playerId: string; balance: string; currency?: string }) {
  await q.query(
    'INSERT INTO wallets (id, player_id, currency, balance, version, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
    [w.id, w.playerId, w.currency ?? 'BRL', w.balance, new Date(), new Date()],
  );
}

async function insertLedger(
  q: Queryable,
  e: {
    walletId: string;
    transactionId: string;
    direction: 'DEBIT' | 'CREDIT';
    amount: string;
    before: string;
    after: string;
    currency?: string;
  },
) {
  await q.query(
    `INSERT INTO wallet_ledger_entries
       (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuid(), e.walletId, e.transactionId, e.direction, e.amount, e.currency ?? 'BRL', e.before, e.after, new Date()],
  );
}

/** Wallet aberta com OPENING PROCESSED e lançamento CREDIT, como o use case fará (I-06, I-07). */
async function openWallet(balance = '100.00') {
  const walletId = uuid();
  const playerId = `player-${uuid()}`;
  await database.db.transaction(async (q) => {
    await insertWallet(q, { id: walletId, playerId, balance });
    const openingId = await insertTx(
      q,
      txColumns(walletId, playerId, {
        provider_id: 'system',
        external_transaction_id: `opening:${walletId}`,
        idempotency_key: `system:opening:${walletId}`,
        round_id: 'opening',
        game_id: 'system',
        kind: 'OPENING',
        amount: balance,
        observed_balance: balance,
      }),
    );
    await insertLedger(q, { walletId, transactionId: openingId, direction: 'CREDIT', amount: balance, before: '0.00', after: balance });
  });
  return { walletId, playerId };
}

/** BET PROCESSED de 10.00 sobre uma wallet de 100.00: saldo 90.00, version 2, lançamento DEBIT. */
async function processedBet(walletId: string, playerId: string) {
  return database.db.transaction(async (q) => {
    const betId = await insertTx(
      q,
      txColumns(walletId, playerId, { kind: 'BET', amount: '10.00', observed_balance: '90.00' }),
    );
    await q.query('UPDATE wallets SET balance = ?, version = version + 1, updated_at = ? WHERE id = ?', [
      '90.00',
      new Date(),
      walletId,
    ]);
    await insertLedger(q, { walletId, transactionId: betId, direction: 'DEBIT', amount: '10.00', before: '100.00', after: '90.00' });
    return betId;
  });
}

const constraint = (name: string) => expect.objectContaining({ constraint: name });
const guard = (messagePart: string) =>
  expect.objectContaining({ code: 'P0001', message: expect.stringContaining(messagePart) });

describe('unicidades', () => {
  test('wallets_player_currency_uq: uma wallet por jogador e moeda (FR-008)', async () => {
    const playerId = `player-${uuid()}`;
    await insertWallet(database.db, { id: uuid(), playerId, balance: '0.00' });
    await expect(insertWallet(database.db, { id: uuid(), playerId, balance: '0.00' })).rejects.toEqual(
      constraint('wallets_player_currency_uq'),
    );
    await insertWallet(database.db, { id: uuid(), playerId, balance: '0.00', currency: 'USD' });
  });

  test('wager_tx_provider_idempotency_uq: mesma chave no mesmo provedor recusada; em outro provedor, aceita (I-56)', async () => {
    const { walletId, playerId } = await openWallet();
    const key = `key-${uuid()}`;
    await insertTx(database.db, txColumns(walletId, playerId, { idempotency_key: key }));
    await expect(insertTx(database.db, txColumns(walletId, playerId, { idempotency_key: key }))).rejects.toEqual(
      constraint('wager_tx_provider_idempotency_uq'),
    );
    await insertTx(database.db, txColumns(walletId, playerId, { idempotency_key: key, provider_id: 'provider-b' }));
    await assertWalletMatchesLedger(database.db, walletId);
  });

  test('wager_tx_provider_external_uq: mesmo (provedor, id externo) recusado (I-24)', async () => {
    const { walletId, playerId } = await openWallet();
    const external = `ext-${uuid()}`;
    await insertTx(database.db, txColumns(walletId, playerId, { external_transaction_id: external }));
    await expect(
      insertTx(database.db, txColumns(walletId, playerId, { external_transaction_id: external })),
    ).rejects.toEqual(constraint('wager_tx_provider_external_uq'));
  });

  test('wager_tx_single_reversal_uq: REFUND e depois ROLLBACK PROCESSED da mesma referência recusado (I-16)', async () => {
    const { walletId, playerId } = await openWallet();
    const betExternal = `bet-${uuid()}`;
    const betId = await insertTx(
      database.db,
      txColumns(walletId, playerId, { kind: 'BET', amount: '10.00', external_transaction_id: betExternal }),
    );
    const reversal = (kind: 'REFUND' | 'ROLLBACK', status = 'PROCESSED') =>
      txColumns(walletId, playerId, {
        kind,
        amount: '10.00',
        status,
        reference_external_transaction_id: betExternal,
        reference_transaction_id: betId,
        failure_code: status === 'REJECTED' ? 'ALREADY_REVERSED' : null,
      });
    await insertTx(database.db, reversal('REFUND'));
    await expect(insertTx(database.db, reversal('ROLLBACK'))).rejects.toEqual(constraint('wager_tx_single_reversal_uq'));
    // a tentativa rejeitada continua auditável: o índice só cobre PROCESSED
    await insertTx(database.db, reversal('ROLLBACK', 'REJECTED'));
  });

  test('ledger_wallet_tx_uq: no máximo um lançamento por (wallet, transação) (I-36)', async () => {
    const { walletId, playerId } = await openWallet();
    const betId = await processedBet(walletId, playerId);
    await expect(
      database.db.transaction(async (q) => {
        await q.query('UPDATE wallets SET balance = ?, version = version + 1 WHERE id = ?', ['80.00', walletId]);
        await insertLedger(q, { walletId, transactionId: betId, direction: 'DEBIT', amount: '10.00', before: '90.00', after: '80.00' });
      }),
    ).rejects.toEqual(constraint('ledger_wallet_tx_uq'));
    await assertWalletMatchesLedger(database.db, walletId);
  });
});

describe('CHECKs de wager_transactions', () => {
  test('wager_tx_amount_ck: zero só em LOSS (I-02)', async () => {
    const { walletId, playerId } = await openWallet();
    await expect(insertTx(database.db, txColumns(walletId, playerId, { kind: 'BET', amount: '0.00' }))).rejects.toEqual(
      constraint('wager_tx_amount_ck'),
    );
    await insertTx(database.db, txColumns(walletId, playerId, { kind: 'LOSS', amount: '0.00' }));
  });

  test('wager_tx_reference_by_kind_ck: BET sem referência, REFUND/ROLLBACK com referência (I-13)', async () => {
    const { walletId, playerId } = await openWallet();
    await expect(
      insertTx(database.db, txColumns(walletId, playerId, { kind: 'BET', amount: '1.00', reference_external_transaction_id: 'x' })),
    ).rejects.toEqual(constraint('wager_tx_reference_by_kind_ck'));
    await expect(
      insertTx(database.db, txColumns(walletId, playerId, { kind: 'REFUND', amount: '1.00', status: 'PENDING_REFERENCE', processed_at: null })),
    ).rejects.toEqual(constraint('wager_tx_reference_by_kind_ck'));
    await insertTx(database.db, txColumns(walletId, playerId, { kind: 'WIN', amount: '1.00', reference_external_transaction_id: 'x' }));
  });

  test('wager_tx_failure_code_ck e wager_tx_failure_code_value_ck', async () => {
    const { walletId, playerId } = await openWallet();
    await expect(
      insertTx(database.db, txColumns(walletId, playerId, { kind: 'BET', amount: '1.00', status: 'REJECTED', processed_at: null })),
    ).rejects.toEqual(constraint('wager_tx_failure_code_ck'));
    await expect(
      insertTx(database.db, txColumns(walletId, playerId, { kind: 'BET', amount: '1.00', failure_code: 'INSUFFICIENT_FUNDS' })),
    ).rejects.toEqual(constraint('wager_tx_failure_code_ck'));
    await expect(
      insertTx(
        database.db,
        txColumns(walletId, playerId, { kind: 'BET', amount: '1.00', status: 'REJECTED', processed_at: null, failure_code: 'FOO' }),
      ),
    ).rejects.toEqual(constraint('wager_tx_failure_code_value_ck'));
    await insertTx(
      database.db,
      txColumns(walletId, playerId, {
        kind: 'WIN',
        amount: '1.00',
        status: 'REJECTED',
        processed_at: null,
        failure_code: 'BALANCE_LIMIT_EXCEEDED',
      }),
    );
  });

  test('wager_tx_opening_identity_ck: OPENING se e só se provider "system" (I-07)', async () => {
    const { walletId, playerId } = await openWallet();
    await expect(
      insertTx(database.db, txColumns(walletId, playerId, { kind: 'OPENING', amount: '1.00' })),
    ).rejects.toEqual(constraint('wager_tx_opening_identity_ck'));
    await expect(
      insertTx(database.db, txColumns(walletId, playerId, { kind: 'BET', amount: '1.00', provider_id: 'system' })),
    ).rejects.toEqual(constraint('wager_tx_opening_identity_ck'));
  });

  test('wager_tx_processed_reversal_ck: reversão PROCESSED exige referência resolvida', async () => {
    const { walletId, playerId } = await openWallet();
    await expect(
      insertTx(
        database.db,
        txColumns(walletId, playerId, { kind: 'REFUND', amount: '1.00', reference_external_transaction_id: 'bet-x' }),
      ),
    ).rejects.toEqual(constraint('wager_tx_processed_reversal_ck'));
  });
});

describe('CHECKs de wallet e ledger', () => {
  test('wallets_balance_non_neg_ck: saldo nunca negativo (FR-039)', async () => {
    await expect(insertWallet(database.db, { id: uuid(), playerId: `p-${uuid()}`, balance: '-1.00' })).rejects.toEqual(
      constraint('wallets_balance_non_neg_ck'),
    );
  });

  test('ledger_arithmetic_ck: saldo antes ± valor = saldo depois (FR-029)', async () => {
    const { walletId, playerId } = await openWallet();
    await expect(
      database.db.transaction(async (q) => {
        const betId = await insertTx(q, txColumns(walletId, playerId, { kind: 'BET', amount: '20.00', observed_balance: '90.00' }));
        await q.query('UPDATE wallets SET balance = ?, version = version + 1 WHERE id = ?', ['90.00', walletId]);
        await insertLedger(q, { walletId, transactionId: betId, direction: 'DEBIT', amount: '20.00', before: '100.00', after: '90.00' });
      }),
    ).rejects.toEqual(constraint('ledger_arithmetic_ck'));
    await assertWalletMatchesLedger(database.db, walletId);
  });
});

describe('FKs compostas do ledger', () => {
  test('ledger_wallet_fk: moeda do lançamento diferente da moeda da wallet', async () => {
    const { walletId, playerId } = await openWallet();
    await expect(
      database.db.transaction(async (q) => {
        const betId = await insertTx(
          q,
          txColumns(walletId, playerId, { kind: 'BET', amount: '10.00', currency: 'USD', observed_balance: '90.00' }),
        );
        await q.query('UPDATE wallets SET balance = ?, version = version + 1 WHERE id = ?', ['90.00', walletId]);
        await insertLedger(q, {
          walletId,
          transactionId: betId,
          direction: 'DEBIT',
          amount: '10.00',
          before: '100.00',
          after: '90.00',
          currency: 'USD',
        });
      }),
    ).rejects.toEqual(constraint('ledger_wallet_fk'));
  });

  test('ledger_transaction_fk: valor do lançamento diferente do valor da transação', async () => {
    const { walletId, playerId } = await openWallet();
    await expect(
      database.db.transaction(async (q) => {
        const betId = await insertTx(q, txColumns(walletId, playerId, { kind: 'BET', amount: '20.00', observed_balance: '90.00' }));
        await q.query('UPDATE wallets SET balance = ?, version = version + 1 WHERE id = ?', ['90.00', walletId]);
        await insertLedger(q, { walletId, transactionId: betId, direction: 'DEBIT', amount: '10.00', before: '100.00', after: '90.00' });
      }),
    ).rejects.toEqual(constraint('ledger_transaction_fk'));
    await assertWalletMatchesLedger(database.db, walletId);
  });
});

describe('triggers do ledger', () => {
  test('UPDATE, DELETE e TRUNCATE no ledger são recusados com P0001 (FR-041, SC-008)', async () => {
    const { walletId } = await openWallet();
    await expect(
      database.db.query('UPDATE wallet_ledger_entries SET created_at = created_at WHERE wallet_id = ?', [walletId]),
    ).rejects.toEqual(guard('wallet_ledger_entries_immutable'));
    await expect(database.db.query('DELETE FROM wallet_ledger_entries WHERE wallet_id = ?', [walletId])).rejects.toEqual(guard('wallet_ledger_entries_immutable'));
    await expect(database.db.query('TRUNCATE wallet_ledger_entries')).rejects.toEqual(guard('wallet_ledger_entries_immutable'));
    await assertWalletMatchesLedger(database.db, walletId);
  });

  test('lançamento para transação que não está PROCESSED é recusado', async () => {
    const { walletId, playerId } = await openWallet();
    await expect(
      database.db.transaction(async (q) => {
        const betId = await insertTx(
          q,
          txColumns(walletId, playerId, {
            kind: 'BET',
            amount: '10.00',
            status: 'REJECTED',
            processed_at: null,
            failure_code: 'INSUFFICIENT_FUNDS',
            observed_balance: '100.00',
          }),
        );
        await q.query('UPDATE wallets SET balance = ?, version = version + 1 WHERE id = ?', ['90.00', walletId]);
        await insertLedger(q, { walletId, transactionId: betId, direction: 'DEBIT', amount: '10.00', before: '100.00', after: '90.00' });
      }),
    ).rejects.toEqual(guard('ledger_requires_processed_movement'));
  });

  test('direção incoerente com o kind é recusada (BET com CREDIT)', async () => {
    const { walletId, playerId } = await openWallet();
    await expect(
      database.db.transaction(async (q) => {
        const betId = await insertTx(q, txColumns(walletId, playerId, { kind: 'BET', amount: '10.00', observed_balance: '110.00' }));
        await q.query('UPDATE wallets SET balance = ?, version = version + 1 WHERE id = ?', ['110.00', walletId]);
        await insertLedger(q, { walletId, transactionId: betId, direction: 'CREDIT', amount: '10.00', before: '100.00', after: '110.00' });
      }),
    ).rejects.toEqual(guard('ledger_direction_mismatch'));
  });

  test('cadeia quebrada é recusada (balance_before diferente do último balance_after)', async () => {
    const { walletId, playerId } = await openWallet();
    await expect(
      database.db.transaction(async (q) => {
        const betId = await insertTx(q, txColumns(walletId, playerId, { kind: 'BET', amount: '10.00', observed_balance: '40.00' }));
        await q.query('UPDATE wallets SET balance = ?, version = version + 1 WHERE id = ?', ['40.00', walletId]);
        await insertLedger(q, { walletId, transactionId: betId, direction: 'DEBIT', amount: '10.00', before: '50.00', after: '40.00' });
      }),
    ).rejects.toEqual(guard('ledger_chain_broken'));
  });

  test('saldo da wallet diferente da cauda do ledger é recusado no COMMIT (FR-042)', async () => {
    const { walletId } = await openWallet();
    await expect(
      database.db.transaction(async (q) => {
        await q.query('UPDATE wallets SET balance = ?, version = version + 1 WHERE id = ?', ['99.00', walletId]);
      }),
    ).rejects.toEqual(guard('wallet_ledger_tail_mismatch'));
    await assertWalletMatchesLedger(database.db, walletId);
  });
});

describe('triggers de wallets', () => {
  test('version muda exatamente quando o saldo muda (FR-009); identidade imutável; sem DELETE', async () => {
    const { walletId } = await openWallet();
    await expect(database.db.query('UPDATE wallets SET version = version + 1 WHERE id = ?', [walletId])).rejects.toEqual(
      guard('wallets_version_without_balance_change'),
    );
    await expect(database.db.query('UPDATE wallets SET balance = ? WHERE id = ?', ['50.00', walletId])).rejects.toEqual(
      guard('wallets_version_must_increment'),
    );
    await expect(database.db.query('UPDATE wallets SET player_id = ? WHERE id = ?', ['other', walletId])).rejects.toEqual(
      guard('wallets_identity_changed'),
    );
    await expect(database.db.query('DELETE FROM wallets WHERE id = ?', [walletId])).rejects.toEqual(guard('wallets_immutable'));
    await assertWalletMatchesLedger(database.db, walletId);
  });
});

describe('triggers de wager_transactions', () => {
  test('estado terminal não muda (FR-028, I-11)', async () => {
    const { walletId, playerId } = await openWallet();
    const id = await insertTx(database.db, txColumns(walletId, playerId));
    await expect(
      database.db.query("UPDATE wager_transactions SET status = 'REJECTED', failure_code = 'INSUFFICIENT_FUNDS' WHERE id = ?", [id]),
    ).rejects.toEqual(guard('wager_tx_terminal_state'));
  });

  test('só as transições do I-11; nova tentativa de PENDING_REFERENCE é permitida; identidade imutável', async () => {
    const { walletId, playerId } = await openWallet();
    const id = await insertTx(
      database.db,
      txColumns(walletId, playerId, {
        kind: 'REFUND',
        amount: '10.00',
        status: 'PENDING_REFERENCE',
        processed_at: null,
        reference_external_transaction_id: `missing-${uuid()}`,
        observed_balance: '100.00',
      }),
    );
    await database.db.query(
      'UPDATE wager_transactions SET reference_attempts = reference_attempts + 1, next_reference_attempt_at = ? WHERE id = ?',
      [new Date(), id],
    );
    await expect(database.db.query("UPDATE wager_transactions SET status = 'PENDING' WHERE id = ?", [id])).rejects.toEqual(
      guard('wager_tx_invalid_transition'),
    );
    await expect(database.db.query("UPDATE wager_transactions SET amount = '11.00' WHERE id = ?", [id])).rejects.toEqual(
      guard('wager_tx_identity_changed'),
    );
  });

  test('DELETE e TRUNCATE em wager_transactions são recusados', async () => {
    const { walletId, playerId } = await openWallet();
    const id = await insertTx(database.db, txColumns(walletId, playerId));
    await expect(database.db.query('DELETE FROM wager_transactions WHERE id = ?', [id])).rejects.toEqual(guard('wager_transactions_immutable'));
    await expect(database.db.query('TRUNCATE wager_transactions CASCADE')).rejects.toEqual(guard('_immutable'));
    await assertWalletMatchesLedger(database.db, walletId);
  });
});

// ---- feature 002 (T016; data-model §2.1; I-28, I-69)

interface InboxColumns {
  consumer_name: string;
  message_id: string;
  payload_hash: string;
  transaction_id: string;
  received_at: Date;
  processed_at: Date;
}

async function insertInbox(q: Queryable, transactionId: string, overrides: Partial<InboxColumns> = {}) {
  const now = new Date();
  const columns: InboxColumns = {
    consumer_name: 'wager-transactions-consumer',
    message_id: `msg-${uuid()}`,
    payload_hash: HASH,
    transaction_id: transactionId,
    received_at: now,
    processed_at: now,
    ...overrides,
  };
  const keys = Object.keys(columns);
  await q.query(
    `INSERT INTO inbox_messages (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`,
    Object.values(columns),
  );
  return columns;
}

describe('inbox_messages (002)', () => {
  test('inbox_messages_pk barra o mesmo (consumer_name, message_id); outro consumidor é aceito', async () => {
    const { walletId, playerId } = await openWallet();
    const txId = await insertTx(database.db, txColumns(walletId, playerId));
    const row = await insertInbox(database.db, txId);
    await expect(insertInbox(database.db, txId, { message_id: row.message_id })).rejects.toEqual(constraint('inbox_messages_pk'));
    await expect(insertInbox(database.db, txId, { message_id: row.message_id, consumer_name: 'other-consumer' })).resolves.toBeDefined();
    await assertWalletMatchesLedger(database.db, walletId);
  });

  test('inbox_message_id_ck recusa message_id fora de ^[A-Za-z0-9._:-]{1,128}$', async () => {
    const { walletId, playerId } = await openWallet();
    const txId = await insertTx(database.db, txColumns(walletId, playerId));
    for (const messageId of ['', 'msg 1', 'msg/1', 'mensagém', 'x'.repeat(129)]) {
      await expect(insertInbox(database.db, txId, { message_id: messageId })).rejects.toEqual(
        expect.objectContaining({ code: expect.stringMatching(/^(23514|22001)$/) }),
      );
    }
    await expect(insertInbox(database.db, txId, { message_id: 'msg 1' })).rejects.toEqual(constraint('inbox_message_id_ck'));
    await expect(insertInbox(database.db, txId, { message_id: 'A.b_c:d-e' })).resolves.toBeDefined();
    await assertWalletMatchesLedger(database.db, walletId);
  });

  test('inbox_payload_hash_ck, inbox_consumer_name_ck e inbox_processed_after_ck recusam valores inválidos', async () => {
    const { walletId, playerId } = await openWallet();
    const txId = await insertTx(database.db, txColumns(walletId, playerId));
    await expect(insertInbox(database.db, txId, { payload_hash: 'A'.repeat(64) })).rejects.toEqual(constraint('inbox_payload_hash_ck'));
    await expect(insertInbox(database.db, txId, { payload_hash: 'g'.repeat(64) })).rejects.toEqual(constraint('inbox_payload_hash_ck'));
    await expect(insertInbox(database.db, txId, { consumer_name: '' })).rejects.toEqual(constraint('inbox_consumer_name_ck'));
    const received = new Date();
    await expect(
      insertInbox(database.db, txId, { received_at: received, processed_at: new Date(received.getTime() - 1000) }),
    ).rejects.toEqual(constraint('inbox_processed_after_ck'));
    await assertWalletMatchesLedger(database.db, walletId);
  });

  test('a FK recusa transaction_id inexistente', async () => {
    await expect(insertInbox(database.db, uuid())).rejects.toEqual(expect.objectContaining({ code: '23503' }));
  });

  test('UPDATE, DELETE e TRUNCATE em inbox_messages são recusados com P0001', async () => {
    const { walletId, playerId } = await openWallet();
    const txId = await insertTx(database.db, txColumns(walletId, playerId));
    const row = await insertInbox(database.db, txId);
    await expect(
      database.db.query('UPDATE inbox_messages SET processed_at = processed_at WHERE message_id = ?', [row.message_id]),
    ).rejects.toEqual(guard('inbox_messages_immutable'));
    await expect(database.db.query('DELETE FROM inbox_messages WHERE message_id = ?', [row.message_id])).rejects.toEqual(guard('inbox_messages_immutable'));
    await expect(database.db.query('TRUNCATE inbox_messages')).rejects.toEqual(guard('inbox_messages_immutable'));
    const rows = await database.db.query('SELECT 1 FROM inbox_messages WHERE message_id = ?', [row.message_id]);
    expect(rows).toHaveLength(1);
    await assertWalletMatchesLedger(database.db, walletId);
  });
});
