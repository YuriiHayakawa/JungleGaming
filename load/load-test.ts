// Teste de carga (diferencial opcional do enunciado §14): `bun run test:load`.
//
// Cliente HTTP próprio (fetch + pool de concorrência, latência por performance.now), sem dependências, contra o cluster
// de 3 instâncias do Compose (`docker compose --profile cluster up -d --build`). Não toca no banco: tudo passa pela API
// pública, inclusive a verificação final (reconciliação de cada wallet tocada).
//
// Cenários, cada um com a mesma duração e a mesma concorrência:
//   A. wallets distribuídas: BET, WIN e LOSS espalhados entre N wallets e as 3 instâncias;
//   B. wallet quente: a mesma mistura numa única wallet (custo do lock por wallet);
//   C. duplicatas: como A, mas 20% das requisições reenviam uma já enviada, com a mesma chave e o mesmo corpo.
//
// Configuração por env (padrões entre parênteses): LOAD_URLS (http://localhost:3001,3002,3003), LOAD_WALLETS (200),
// LOAD_CONCURRENCY (32), LOAD_DURATION_S (30), LOAD_WARMUP_S (5), LOAD_DUPLICATE_RATIO (0.2), LOAD_SCENARIOS (A,B,C).
//
// Valores monetários só como string e centavos em BigInt; nada de number para dinheiro.

type Kind = 'BET' | 'WIN' | 'LOSS';
type ScenarioId = 'A' | 'B' | 'C';

interface Wallet {
  id: string;
  playerId: string;
}

interface Job {
  wallet: Wallet;
  kind: Kind;
  key: string;
  body: string;
}

interface Sample {
  latencyMs: number;
  status: string;
  replay: boolean;
  resend: boolean;
}

interface ScenarioResult {
  id: ScenarioId;
  name: string;
  durationS: number;
  requests: number;
  throughputRps: number;
  latencyMs: { p50: number; p95: number; p99: number; max: number; mean: number };
  statuses: Record<string, { count: number; pct: number }>;
  outcomes: Record<string, number>;
  /** Reenvios só de requisições já respondidas; cada reenvio deve voltar como replay (mesmo transactionId). */
  resends: { sent: number; recognizedAsReplay: number; replaysTotal: number };
  server: {
    lockConflicts: number;
    duplicatesIdempotency: number;
    transactionsByStatus: Record<string, number>;
    outboxPendingPeak: number;
    outboxOldestAgePeakS: number;
    /** Pendentes no instante em que a carga parou, tempo até zerar e vazão média de publicação nesse intervalo. */
    outboxPendingAtEnd: number;
    outboxDrainS: number | null;
    outboxDrainRatePerS: number | null;
  };
}

const env = process.env;
const config = {
  urls: (env.LOAD_URLS ?? 'http://localhost:3001,http://localhost:3002,http://localhost:3003').split(',').map((u) => u.trim()),
  wallets: positiveInt(env.LOAD_WALLETS, 200),
  concurrency: positiveInt(env.LOAD_CONCURRENCY, 32),
  durationS: positiveInt(env.LOAD_DURATION_S, 30),
  warmupS: positiveInt(env.LOAD_WARMUP_S, 5, true),
  duplicateRatio: ratio(env.LOAD_DUPLICATE_RATIO, 0.2),
  scenarios: (env.LOAD_SCENARIOS ?? 'A,B,C').split(',').map((s) => s.trim()) as ScenarioId[],
  initialBalance: '100000000.00',
  amount: '1.00',
};

const RUN = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomUUID().slice(0, 6)}`;
const PROVIDER = `load-${RUN}`;
const STARTED_AT = new Date().toISOString();
/** Espera máxima pela outbox vazia (antes de cada cenário e depois dele). */
const DRAIN_TIMEOUT_S = positiveInt(env.LOAD_DRAIN_TIMEOUT_S, 1200);
const CURRENCY = 'BRL';

function positiveInt(raw: string | undefined, fallback: number, allowZero = false): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new Error(`invalid integer: ${raw}`);
  return value;
}

function ratio(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseFloat(raw);
  if (!(value >= 0 && value < 1)) throw new Error(`invalid ratio: ${raw}`);
  return value;
}

// ---------- utilidades ----------

/** "123.45" → 12345n (centavos). Só para a conferência do saldo esperado; nunca passa por number. */
function cents(amount: string): bigint {
  const match = /^(-?)(\d+)\.(\d{2})$/.exec(amount);
  if (!match) throw new Error(`unexpected amount: ${amount}`);
  const value = BigInt(match[2]!) * 100n + BigInt(match[3]!);
  return match[1] === '-' ? -value : value;
}

function formatCents(value: bigint): string {
  const sign = value < 0n ? '-' : '';
  const abs = value < 0n ? -value : value;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

function percentile(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

function round(value: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

async function pool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

// ---------- métricas Prometheus ----------

type Series = Map<string, number>;

async function scrape(url: string): Promise<Series> {
  const text = await (await fetch(`${url}/metrics`)).text();
  const series: Series = new Map();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const space = line.lastIndexOf(' ');
    series.set(line.slice(0, space), Number.parseFloat(line.slice(space + 1)));
  }
  return series;
}

async function scrapeAll(): Promise<Series> {
  const total: Series = new Map();
  for (const series of await Promise.all(config.urls.map(scrape))) {
    for (const [key, value] of series) total.set(key, (total.get(key) ?? 0) + value);
  }
  return total;
}

function delta(before: Series, after: Series, key: string): number {
  return (after.get(key) ?? 0) - (before.get(key) ?? 0);
}

/** Os gauges da outbox são calculados no banco (iguais em toda instância): basta ler uma. */
async function outboxGauges(): Promise<{ pending: number; ageS: number } | undefined> {
  try {
    const s = await scrape(config.urls[0]!);
    const pending = s.get('outbox_pending_events');
    const ageS = s.get('outbox_oldest_pending_age_seconds');
    return pending === undefined || ageS === undefined ? undefined : { pending, ageS };
  } catch {
    return undefined;
  }
}

function sampleOutbox(peak: { pending: number; ageS: number }): () => Promise<void> {
  let running = true;
  const loop = (async () => {
    while (running) {
      const g = await outboxGauges();
      if (g) {
        peak.pending = Math.max(peak.pending, g.pending);
        peak.ageS = Math.max(peak.ageS, g.ageS);
      }
      await Bun.sleep(250);
    }
  })();
  return async () => {
    running = false;
    await loop;
  };
}

async function waitOutboxDrain(timeoutS: number): Promise<number | null> {
  const started = performance.now();
  while (performance.now() - started < timeoutS * 1000) {
    const g = await outboxGauges();
    if (g && g.pending === 0) return round((performance.now() - started) / 1000, 1);
    await Bun.sleep(250);
  }
  return null;
}

// ---------- consumidor de eventos (o "downstream") ----------

/**
 * Sem ninguém consumindo `wager-events.fifo`, a fila cresce sem limite e o MiniStack (Python, um núcleo) fica mais lento
 * a cada envio: medido, de ~370 para ~105 eventos/s com 80 mil mensagens paradas. Em produção há um consumidor; este
 * laço faz esse papel (ReceiveMessage + DeleteMessageBatch pelo protocolo JSON do SQS) para que o atraso medido seja o
 * do publicador, não o da fila acumulada. `LOAD_EVENT_SINK=0` desliga.
 */
function startEventSink(): { stop: () => Promise<number> } {
  const sqsEndpoint = env.LOAD_SQS_ENDPOINT ?? 'http://localhost:4566';
  const queueUrl = `${sqsEndpoint}/000000000000/${env.SQS_EVENTS_QUEUE ?? 'wager-events.fifo'}`;
  const call = async (target: string, body: unknown) => {
    const r = await fetch(`${sqsEndpoint}/`, {
      method: 'POST',
      headers: { 'X-Amz-Target': `AmazonSQS.${target}`, 'Content-Type': 'application/x-amz-json-1.0' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${target} → ${r.status}`);
    return (await r.json()) as { Messages?: { ReceiptHandle: string }[] };
  };
  let running = true;
  let consumed = 0;
  const loops = Array.from({ length: 2 }, async () => {
    while (running) {
      try {
        const { Messages = [] } = await call('ReceiveMessage', { QueueUrl: queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 });
        if (Messages.length === 0) continue;
        await call('DeleteMessageBatch', {
          QueueUrl: queueUrl,
          Entries: Messages.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle })),
        });
        consumed += Messages.length;
      } catch {
        await Bun.sleep(500);
      }
    }
  });
  return {
    stop: async () => {
      running = false;
      await Promise.all(loops);
      return consumed;
    },
  };
}

// ---------- preparação ----------

async function createWallet(index: number, label: string): Promise<Wallet> {
  const playerId = `${PROVIDER}-${label}-${index}`;
  const url = config.urls[index % config.urls.length]!;
  const response = await fetch(`${url}/wallets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount: config.initialBalance, currency: CURRENCY } }),
  });
  if (response.status !== 201) throw new Error(`POST /wallets → ${response.status}: ${await response.text()}`);
  const body = (await response.json()) as { id: string };
  return { id: body.id, playerId };
}

// ---------- carga ----------

let sequence = 0;

function newJob(wallet: Wallet): Job {
  const r = Math.random();
  const kind: Kind = r < 0.5 ? 'BET' : r < 0.8 ? 'WIN' : 'LOSS';
  const externalTransactionId = `tx-${RUN}-${++sequence}`;
  const key = `${PROVIDER}:${externalTransactionId}`;
  const body = JSON.stringify({
    providerId: PROVIDER,
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: `round-${sequence % 1000}`,
    gameId: 'load-game',
    kind,
    money: { amount: kind === 'LOSS' ? '0.00' : config.amount, currency: CURRENCY },
  });
  return { wallet, kind, key, body };
}

/** Efeito confirmado por wallet, a partir das respostas 201 (saldo esperado = inicial − BETs + WINs). */
const confirmedCents = new Map<string, bigint>();
/** Wallets com resposta de resultado incerto (erro de rede, 5xx): não entram na conferência do saldo esperado. */
const uncertainWallets = new Set<string>();
const touched = new Map<string, Wallet>();

async function send(job: Job, url: string, resend: boolean): Promise<Sample> {
  const started = performance.now();
  let status: string;
  let replay = false;
  let outcome: string | undefined;
  try {
    const response = await fetch(`${url}/wagering/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': job.key },
      body: job.body,
    });
    status = String(response.status);
    const body = (await response.json()) as { status?: string; idempotentReplay?: boolean };
    replay = body.idempotentReplay === true;
    outcome = body.status;
  } catch {
    status = 'network_error';
  }
  const latencyMs = performance.now() - started;
  touched.set(job.wallet.id, job.wallet);
  if (status === '201' && outcome === 'PROCESSED' && !replay && job.kind !== 'LOSS') {
    const sign = job.kind === 'BET' ? -1n : 1n;
    confirmedCents.set(job.wallet.id, (confirmedCents.get(job.wallet.id) ?? 0n) + sign * cents(config.amount));
  }
  if (status === 'network_error' || status.startsWith('5')) uncertainWallets.add(job.wallet.id);
  return { latencyMs, status: outcome && status !== 'network_error' ? `${status} ${outcome}` : status, replay, resend };
}

async function runLoad(
  durationS: number,
  pickWallet: () => Wallet,
  duplicateRatio: number,
): Promise<{ samples: Sample[]; elapsedS: number }> {
  const samples: Sample[] = [];
  const sent: Job[] = [];
  let rr = 0;
  const deadline = performance.now() + durationS * 1000;
  const started = performance.now();
  const worker = async () => {
    while (performance.now() < deadline) {
      const url = config.urls[rr++ % config.urls.length]!;
      const resend = duplicateRatio > 0 && sent.length > 0 && Math.random() < duplicateRatio;
      const job = resend ? sent[Math.floor(Math.random() * sent.length)]! : newJob(pickWallet());
      const sample = await send(job, url, resend);
      if (!resend) sent.push(job);
      samples.push(sample);
    }
  };
  await Promise.all(Array.from({ length: config.concurrency }, worker));
  return { samples, elapsedS: (performance.now() - started) / 1000 };
}

function summarize(id: ScenarioId, name: string, samples: Sample[], elapsedS: number): Omit<ScenarioResult, 'server'> {
  const latencies = Float64Array.from(samples.map((s) => s.latencyMs)).sort();
  const statuses: Record<string, { count: number; pct: number }> = {};
  const outcomes: Record<string, number> = {};
  for (const s of samples) {
    const http = s.status.split(' ')[0]!;
    statuses[http] = { count: (statuses[http]?.count ?? 0) + 1, pct: 0 };
    outcomes[s.status] = (outcomes[s.status] ?? 0) + 1;
  }
  for (const v of Object.values(statuses)) v.pct = round((100 * v.count) / samples.length, 2);
  const total = latencies.reduce((a, b) => a + b, 0);
  return {
    id,
    name,
    durationS: round(elapsedS, 1),
    requests: samples.length,
    throughputRps: round(samples.length / elapsedS, 1),
    latencyMs: {
      p50: round(percentile(latencies, 50)),
      p95: round(percentile(latencies, 95)),
      p99: round(percentile(latencies, 99)),
      max: round(latencies[latencies.length - 1] ?? 0),
      mean: round(total / Math.max(1, latencies.length)),
    },
    statuses,
    outcomes,
    resends: {
      sent: samples.filter((s) => s.resend).length,
      recognizedAsReplay: samples.filter((s) => s.resend && s.replay).length,
      replaysTotal: samples.filter((s) => s.replay).length,
    },
  };
}

async function scenario(id: ScenarioId, wallets: Wallet[], hot: Wallet): Promise<ScenarioResult> {
  const definitions: Record<ScenarioId, { name: string; pick: () => Wallet; dup: number }> = {
    A: { name: 'wallets distribuídas', pick: () => wallets[Math.floor(Math.random() * wallets.length)]!, dup: 0 },
    B: { name: 'wallet quente', pick: () => hot, dup: 0 },
    C: {
      name: `duplicatas (${Math.round(config.duplicateRatio * 100)}% reenviadas)`,
      pick: () => wallets[Math.floor(Math.random() * wallets.length)]!,
      dup: config.duplicateRatio,
    },
  };
  const def = definitions[id];
  // Cada cenário começa com a outbox vazia: sem isso, o backlog de um cenário contamina os gauges do seguinte.
  const settleS = await waitOutboxDrain(DRAIN_TIMEOUT_S);
  if (settleS === null) throw new Error(`outbox não drenou em ${DRAIN_TIMEOUT_S} s antes do cenário ${id}`);
  console.log(`\n▶ cenário ${id}: ${def.name} (${config.durationS} s, concorrência ${config.concurrency})`);
  const before = await scrapeAll();
  const peak = { pending: 0, ageS: 0 };
  const stopSampling = sampleOutbox(peak);
  const { samples, elapsedS } = await runLoad(config.durationS, def.pick, def.dup);
  const atEnd = (await outboxGauges())?.pending ?? 0;
  const drainS = await waitOutboxDrain(DRAIN_TIMEOUT_S);
  await stopSampling();
  const after = await scrapeAll();
  console.log(`  outbox: ${atEnd} pendentes ao fim da carga, drenados em ${drainS ?? 'n/d'} s`);
  const transactionsByStatus: Record<string, number> = {};
  for (const status of ['PROCESSED', 'REJECTED', 'PENDING_REFERENCE', 'FAILED']) {
    const d = delta(before, after, `transactions_total{status="${status}"}`);
    if (d !== 0) transactionsByStatus[status] = d;
  }
  return {
    ...summarize(id, def.name, samples, elapsedS),
    server: {
      lockConflicts: delta(before, after, 'lock_conflicts_total'),
      duplicatesIdempotency: delta(before, after, 'duplicates_total{source="idempotency"}'),
      transactionsByStatus,
      outboxPendingPeak: peak.pending,
      outboxOldestAgePeakS: round(peak.ageS, 3),
      outboxPendingAtEnd: atEnd,
      outboxDrainS: drainS,
      outboxDrainRatePerS: drainS && drainS > 0 ? round(atEnd / drainS, 1) : null,
    },
  };
}

// ---------- verificação final ----------

interface Verification {
  walletsChecked: number;
  consistent: number;
  inconsistent: string[];
  negativeBalances: string[];
  expectedBalanceChecked: number;
  expectedBalanceMismatches: { walletId: string; expected: string; stored: string }[];
  skippedUncertain: number;
}

async function verify(): Promise<Verification> {
  const result: Verification = {
    walletsChecked: 0,
    consistent: 0,
    inconsistent: [],
    negativeBalances: [],
    expectedBalanceChecked: 0,
    expectedBalanceMismatches: [],
    skippedUncertain: 0,
  };
  let i = 0;
  await pool([...touched.values()], 16, async (wallet) => {
    const url = config.urls[i++ % config.urls.length]!;
    const response = await fetch(`${url}/wallets/${wallet.id}/reconciliation`, { method: 'POST' });
    const body = (await response.json()) as { consistent: boolean; storedBalance: { amount: string } };
    result.walletsChecked++;
    if (response.status === 200 && body.consistent) result.consistent++;
    else result.inconsistent.push(wallet.id);
    const stored = body.storedBalance.amount;
    if (stored.startsWith('-')) result.negativeBalances.push(wallet.id);
    if (uncertainWallets.has(wallet.id)) {
      result.skippedUncertain++;
      return;
    }
    const expected = cents(config.initialBalance) + (confirmedCents.get(wallet.id) ?? 0n);
    result.expectedBalanceChecked++;
    if (expected !== cents(stored)) {
      result.expectedBalanceMismatches.push({ walletId: wallet.id, expected: formatCents(expected), stored });
    }
  });
  return result;
}

// ---------- saída ----------

function printTable(results: ScenarioResult[]): void {
  const rows = results.map((r) => ({
    cenário: `${r.id} ${r.name}`,
    req: r.requests,
    'req/s': r.throughputRps,
    'p50 ms': r.latencyMs.p50,
    'p95 ms': r.latencyMs.p95,
    'p99 ms': r.latencyMs.p99,
    'max ms': r.latencyMs.max,
    status: Object.entries(r.statuses)
      .map(([s, v]) => `${s}:${v.count}`)
      .join(' '),
    replays: r.resends.sent > 0 ? `${r.resends.recognizedAsReplay}/${r.resends.sent}` : '-',
    'lock 55P03': r.server.lockConflicts,
    'outbox pico': r.server.outboxPendingPeak,
    'idade máx s': r.server.outboxOldestAgePeakS,
    'drenagem s': r.server.outboxDrainS ?? 'n/d',
    'publ./s': r.server.outboxDrainRatePerS ?? 'n/d',
  }));
  console.log();
  console.table(rows);
}

async function main(): Promise<void> {
  console.log(`load test ${RUN}: ${config.urls.join(', ')}`);
  for (const url of config.urls) {
    const r = await fetch(`${url}/health/ready`).catch(() => undefined);
    if (r?.status !== 200) throw new Error(`${url} não está pronta (/health/ready); suba o cluster antes`);
  }

  const prepStarted = performance.now();
  const wallets: Wallet[] = [];
  await pool(
    Array.from({ length: config.wallets }, (_, i) => i),
    16,
    async (i) => {
      wallets.push(await createWallet(i, 'w'));
    },
  );
  const hot = await createWallet(0, 'hot');
  console.log(`preparação: ${wallets.length} wallets + 1 quente em ${round((performance.now() - prepStarted) / 1000)} s`);

  const sinkEnabled = env.LOAD_EVENT_SINK !== '0';
  const sink = sinkEnabled ? startEventSink() : undefined;
  console.log(`consumidor de wager-events (downstream simulado): ${sinkEnabled ? 'ligado' : 'desligado'}`);

  if (config.warmupS > 0) {
    console.log(`aquecimento: ${config.warmupS} s (não medido)`);
    await runLoad(config.warmupS, () => wallets[Math.floor(Math.random() * wallets.length)]!, 0);
  }

  const results: ScenarioResult[] = [];
  for (const id of config.scenarios) results.push(await scenario(id, wallets, hot));
  const eventsConsumed = sink ? await sink.stop() : null;

  printTable(results);
  console.log('\nverificação final (reconciliação de todas as wallets tocadas, pela API):');
  const verification = await verify();
  console.log(
    `  ${verification.consistent}/${verification.walletsChecked} consistentes; saldos negativos: ${verification.negativeBalances.length}; ` +
      `saldo esperado pelo cliente = saldo armazenado em ${verification.expectedBalanceChecked - verification.expectedBalanceMismatches.length}/${verification.expectedBalanceChecked}` +
      (verification.skippedUncertain > 0 ? ` (${verification.skippedUncertain} wallets com resposta incerta fora da conta)` : ''),
  );

  const report = {
    run: RUN,
    startedAt: STARTED_AT,
    finishedAt: new Date().toISOString(),
    client: { bun: Bun.version, platform: process.platform, arch: process.arch },
    config: { ...config, eventSink: sinkEnabled, drainTimeoutS: DRAIN_TIMEOUT_S },
    eventsConsumedBySink: eventsConsumed,
    results,
    verification,
  };
  const file = `${import.meta.dir}/results/load-${RUN}.json`;
  await Bun.write(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nresultado: ${file}`);

  const ok =
    verification.consistent === verification.walletsChecked &&
    verification.negativeBalances.length === 0 &&
    verification.expectedBalanceMismatches.length === 0;
  if (!ok) {
    console.error('INVARIANTE VIOLADA: ver o JSON');
    process.exit(1);
  }
}

await main();
