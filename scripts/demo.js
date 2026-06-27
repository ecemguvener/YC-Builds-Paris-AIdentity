/**
 * End-to-end demo — boots the API in-process against a throwaway DB and walks
 * the three required scenarios entirely over HTTP, exactly as the Agent Hub
 * would. Run with: `npm run demo`.
 */
import fs from 'node:fs';

// Use a throwaway DB + dedicated port so the demo is repeatable and isolated.
const PORT = 4099;
const DB_PATH = './data/demo.db';
process.env.PORT = String(PORT);
process.env.DB_PATH = DB_PATH;
process.env.PAYMENT_PROVIDER = 'mock';
for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
  if (fs.existsSync(f)) fs.rmSync(f);
}

const BASE = `http://localhost:${PORT}`;
const AGENT = 'agent_123';
const OWNER = 'user_123';

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

async function api(method, path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function statusColor(s) {
  if (s === 'approved' || s === 'executed' || s === 'successful') return c.green;
  if (s === 'requires_approval') return c.yellow;
  return c.red;
}

function show(label, { status, json }) {
  const s = json.status || json.error || status;
  console.log(`   ${c.dim}${label}${c.reset} → ${statusColor(s)}${s}${c.reset}` +
    (json.decision_reason ? ` ${c.dim}(${json.decision_reason})${c.reset}` : '') +
    (json.message ? ` ${c.dim}(${json.message})${c.reset}` : ''));
  return json;
}

async function waitForHealth(tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not become healthy');
}

async function main() {
  await import('../src/index.js'); // boots the server
  await waitForHealth();

  console.log(`\n${c.bold}${c.cyan}=== Payment Tool — Demo (provider: mock) ===${c.reset}\n`);

  // ── Setup: attach identity + policy ────────────────────────────────────────
  console.log(`${c.bold}Setup${c.reset}`);
  show('attach payment identity', await api('POST', `/agents/${AGENT}/payment-identity`));
  const policy = {
    max_transaction_amount: 50,
    daily_limit: 100,
    monthly_limit: 500,
    approval_required_above: 25,
    allowed_merchants: ['OpenAI', 'Google Cloud', 'Amazon'],
    blocked_merchants: ['CryptoExchange'],
    blocked_categories: ['gambling', 'crypto'],
    allow_recurring: false,
  };
  await api('PATCH', `/agents/${AGENT}/payment-policy`, policy);
  console.log(`   ${c.dim}policy set: approval>£25, allowed=[OpenAI,Google Cloud,Amazon], blocked=[CryptoExchange]${c.reset}\n`);

  // ── Scenario A: auto-approved → executed ───────────────────────────────────
  console.log(`${c.bold}Scenario A — auto-approve & execute${c.reset}  (OpenAI, £15)`);
  const a = show(
    'requestPurchase',
    await api('POST', '/tools/payments/request-purchase', {
      agent_id: AGENT,
      merchant_name: 'OpenAI',
      merchant_url: 'https://openai.com',
      amount: 15,
      currency: 'GBP',
      purpose: 'Buy API credits',
    }),
  );
  if (a.status === 'approved') {
    show('executePurchase', await api('POST', `/tools/payments/${a.request_id}/execute`));
    // Idempotency proof: executing again must NOT double-charge.
    show('executePurchase (replay)', await api('POST', `/tools/payments/${a.request_id}/execute`));
  }
  console.log();

  // ── Scenario B: requires approval → human approves → execute ───────────────
  console.log(`${c.bold}Scenario B — requires approval${c.reset}  (Amazon, £40)`);
  const b = show(
    'requestPurchase',
    await api('POST', '/tools/payments/request-purchase', {
      agent_id: AGENT,
      merchant_name: 'Amazon',
      amount: 40,
      currency: 'GBP',
      purpose: 'Office supplies',
    }),
  );
  if (b.status === 'requires_approval') {
    // Wrong owner is rejected (security check).
    show(
      'approve (wrong owner)',
      await api('POST', `/tools/payments/${b.request_id}/approve`, {
        owner_user_id: 'user_999',
        note: 'should be forbidden',
      }),
    );
    // Correct owner approves, then executes.
    show(
      'approve (correct owner)',
      await api('POST', `/tools/payments/${b.request_id}/approve`, {
        owner_user_id: OWNER,
        note: 'Approved for office supplies',
      }),
    );
    show('executePurchase', await api('POST', `/tools/payments/${b.request_id}/execute`));
  }
  console.log();

  // ── Scenario C: rejected (blocked merchant) ────────────────────────────────
  console.log(`${c.bold}Scenario C — rejected (blocked merchant)${c.reset}  (CryptoExchange, £10)`);
  const cc = show(
    'requestPurchase',
    await api('POST', '/tools/payments/request-purchase', {
      agent_id: AGENT,
      merchant_name: 'CryptoExchange',
      amount: 10,
      currency: 'GBP',
      purpose: 'Buy crypto',
    }),
  );
  // Executing a non-approved request must fail.
  show('executePurchase (should fail)', await api('POST', `/tools/payments/${cc.request_id}/execute`));
  console.log();

  // ── Activity summary ───────────────────────────────────────────────────────
  const { json: activity } = await api('GET', `/agents/${AGENT}/payment-activity`);
  console.log(`${c.bold}Activity summary${c.reset}`);
  console.log(`   requests:     ${activity.purchase_requests.length}`);
  console.log(`   approvals:    ${activity.approvals.length}`);
  console.log(`   transactions: ${activity.transactions.length}`);
  console.log(`   audit events: ${activity.audit_log.length}`);
  console.log(`\n${c.green}${c.bold}✓ Demo complete.${c.reset} Open ${BASE}/ for the dashboard.\n`);

  process.exit(0);
}

main().catch((e) => {
  console.error(`${c.red}Demo failed:${c.reset}`, e);
  process.exit(1);
});
