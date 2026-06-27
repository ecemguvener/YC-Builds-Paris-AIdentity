/**
 * Example: "Top up my OpenAI API credits."
 *
 * Policy intent: the agent can spend freely UP TO £25 — a human is only asked
 * to approve when a single top-up is MORE than £25. There is no allowed-list
 * gating here, so the £25 threshold is the *only* thing that triggers human
 * approval (blocked merchants are still hard-rejected).
 *
 * Run with: `npm run example:topup`
 */
import fs from 'node:fs';

const PORT = 4098;
const DB_PATH = './data/topup-example.db';
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
  reset: '\x1b[0m', bold: '\x1b[1m', green: '\x1b[32m', yellow: '\x1b[33m',
  red: '\x1b[31m', cyan: '\x1b[36m', dim: '\x1b[2m', mag: '\x1b[35m',
};

async function api(method, path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const color = (s) =>
  s === 'approved' || s === 'executed' || s === 'successful'
    ? c.green
    : s === 'requires_approval'
      ? c.yellow
      : c.red;

const agentSays = (msg) => console.log(`   ${c.cyan}🤖 agent:${c.reset} ${msg}`);
const userSays = (msg) => console.log(`${c.bold}${c.mag}🧑 user:${c.reset}${c.bold} ${msg}${c.reset}`);

async function waitForHealth(tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

/** The agent's tool-use flow for a single top-up instruction. */
async function topUp(amount, { simulateOwnerApproval } = {}) {
  // Step 1 — the ONLY thing the agent may do: requestPurchase()
  const { json: req } = await api('POST', '/tools/payments/request-purchase', {
    agent_id: AGENT,
    merchant_name: 'OpenAI',
    merchant_url: 'https://openai.com',
    amount,
    currency: 'GBP',
    purpose: 'Top up OpenAI API credits',
  });
  console.log(
    `   ${c.dim}→ requestPurchase(£${amount}) →${c.reset} ${color(req.status)}${req.status}${c.reset} ${c.dim}(${req.decision_reason})${c.reset}`,
  );

  // Step 2 — branch on the module's decision.
  if (req.status === 'approved') {
    const { json: txn } = await api('POST', `/tools/payments/${req.request_id}/execute`, null, {
      'Idempotency-Key': `topup:${req.request_id}`,
    });
    agentSays(
      `Done — topped up £${txn.amount} of OpenAI credits. (txn ${txn.transaction_id}, ${txn.status})`,
    );
    return;
  }

  if (req.status === 'requires_approval') {
    agentSays(
      `That's £${amount}, which is over your £25 limit, so I need your approval before paying.`,
    );
    if (!simulateOwnerApproval) return;

    // Human approves out-of-band (here we simulate the owner clicking "Approve").
    console.log(`   ${c.dim}…owner reviews in dashboard and approves…${c.reset}`);
    const { json: appr } = await api('POST', `/tools/payments/${req.request_id}/approve`, {
      owner_user_id: OWNER,
      note: 'Yes, top up the credits',
    });
    console.log(`   ${c.dim}→ approve →${c.reset} ${color(appr.status)}${appr.status}${c.reset}`);

    const { json: txn } = await api('POST', `/tools/payments/${req.request_id}/execute`, null, {
      'Idempotency-Key': `topup:${req.request_id}`,
    });
    agentSays(`Approved and paid — £${txn.amount} of OpenAI credits added. (txn ${txn.transaction_id})`);
    return;
  }

  agentSays(`I can't make that purchase: ${req.decision_reason}.`);
}

async function main() {
  await import('../src/index.js');
  await waitForHealth();

  console.log(`\n${c.bold}${c.cyan}=== Example: top up OpenAI API credits ===${c.reset}\n`);

  // Setup: attach identity + a policy whose ONLY approval gate is "> £25".
  await api('POST', `/agents/${AGENT}/payment-identity`);
  await api('PATCH', `/agents/${AGENT}/payment-policy`, {
    max_transaction_amount: 100,   // hard ceiling per transaction
    daily_limit: 200,
    monthly_limit: 1000,
    approval_required_above: 25,    // ← the human is only asked above £25
    allowed_merchants: [],          // ← empty: merchant identity does NOT force approval
    blocked_merchants: ['CryptoExchange'],
    blocked_categories: ['gambling', 'crypto'],
    allow_recurring: false,
  });
  console.log(`${c.dim}Policy: auto-approve ≤ £25, human approval required above £25.${c.reset}\n`);

  // ── Case 1: under the limit → no human needed ──────────────────────────────
  userSays('Top up £20 of OpenAI API credits.');
  await topUp(20);
  console.log();

  // ── Case 2: over the limit → human approval needed ─────────────────────────
  userSays('Actually, top up £40 of OpenAI API credits.');
  await topUp(40, { simulateOwnerApproval: true });
  console.log();

  console.log(`${c.green}${c.bold}✓ Example complete.${c.reset}\n`);
  process.exit(0);
}

main().catch((e) => {
  console.error(`${c.red}Example failed:${c.reset}`, e);
  process.exit(1);
});
