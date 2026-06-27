import { db } from '../db/db.js';
import { id } from '../util/ids.js';

const nowISO = () => new Date().toISOString();

// ── Identity Hub (read-only from the payment module's perspective) ──────────
export const agents = {
  get(agentId) {
    return db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(agentId) || null;
  },
  list() {
    return db.prepare('SELECT * FROM agents ORDER BY created_at').all();
  },
  /** Used in tests/demo to register an agent in the hub. */
  create({ agent_id, name, owner_user_id, email, phone, calendar }) {
    const row = {
      agent_id: agent_id || id('agent'),
      name,
      owner_user_id,
      email: email ?? null,
      phone: phone ?? null,
      calendar: calendar ?? null,
      created_at: nowISO(),
    };
    db.prepare(
      `INSERT INTO agents (agent_id, name, owner_user_id, email, phone, calendar, created_at)
       VALUES (@agent_id, @name, @owner_user_id, @email, @phone, @calendar, @created_at)`,
    ).run(row);
    return row;
  },
};

// ── Payment identities ──────────────────────────────────────────────────────
export const paymentIdentities = {
  getByAgent(agentId) {
    return db.prepare('SELECT * FROM payment_identities WHERE agent_id = ?').get(agentId) || null;
  },
  create({ agent_id, owner_user_id, provider, provider_card_id, card_last4, status = 'active' }) {
    const row = {
      id: id('payid'),
      agent_id,
      owner_user_id,
      provider,
      provider_card_id: provider_card_id ?? null,
      card_last4: card_last4 ?? null,
      status,
      created_at: nowISO(),
    };
    db.prepare(
      `INSERT INTO payment_identities
        (id, agent_id, owner_user_id, provider, provider_card_id, card_last4, status, created_at)
       VALUES
        (@id, @agent_id, @owner_user_id, @provider, @provider_card_id, @card_last4, @status, @created_at)`,
    ).run(row);
    return row;
  },
  setStatus(agentId, status) {
    db.prepare('UPDATE payment_identities SET status = ? WHERE agent_id = ?').run(status, agentId);
    return this.getByAgent(agentId);
  },
};

// ── Policies ──────────────────────────────────────────────────────────────
function deserializePolicy(row) {
  if (!row) return null;
  return {
    ...row,
    allowed_merchants: JSON.parse(row.allowed_merchants),
    blocked_merchants: JSON.parse(row.blocked_merchants),
    blocked_categories: JSON.parse(row.blocked_categories),
    allow_recurring: !!row.allow_recurring,
  };
}

export const policies = {
  getByAgent(agentId) {
    return deserializePolicy(
      db.prepare('SELECT * FROM payment_policies WHERE agent_id = ?').get(agentId),
    );
  },
  /** Upsert: create on first PATCH, merge on subsequent ones. */
  upsert(agentId, patch) {
    const existing = this.getByAgent(agentId);
    const merged = {
      max_transaction_amount: patch.max_transaction_amount ?? existing?.max_transaction_amount ?? 0,
      daily_limit: patch.daily_limit ?? existing?.daily_limit ?? 0,
      monthly_limit: patch.monthly_limit ?? existing?.monthly_limit ?? 0,
      approval_required_above:
        patch.approval_required_above ?? existing?.approval_required_above ?? 0,
      allowed_merchants: patch.allowed_merchants ?? existing?.allowed_merchants ?? [],
      blocked_merchants: patch.blocked_merchants ?? existing?.blocked_merchants ?? [],
      blocked_categories: patch.blocked_categories ?? existing?.blocked_categories ?? [],
      allow_recurring: patch.allow_recurring ?? existing?.allow_recurring ?? false,
    };
    const now = nowISO();
    if (existing) {
      db.prepare(
        `UPDATE payment_policies SET
           max_transaction_amount = @max_transaction_amount,
           daily_limit = @daily_limit,
           monthly_limit = @monthly_limit,
           approval_required_above = @approval_required_above,
           allowed_merchants = @allowed_merchants,
           blocked_merchants = @blocked_merchants,
           blocked_categories = @blocked_categories,
           allow_recurring = @allow_recurring,
           updated_at = @updated_at
         WHERE agent_id = @agent_id`,
      ).run({
        agent_id: agentId,
        ...merged,
        allowed_merchants: JSON.stringify(merged.allowed_merchants),
        blocked_merchants: JSON.stringify(merged.blocked_merchants),
        blocked_categories: JSON.stringify(merged.blocked_categories),
        allow_recurring: merged.allow_recurring ? 1 : 0,
        updated_at: now,
      });
    } else {
      db.prepare(
        `INSERT INTO payment_policies
          (id, agent_id, max_transaction_amount, daily_limit, monthly_limit,
           approval_required_above, allowed_merchants, blocked_merchants,
           blocked_categories, allow_recurring, created_at, updated_at)
         VALUES
          (@id, @agent_id, @max_transaction_amount, @daily_limit, @monthly_limit,
           @approval_required_above, @allowed_merchants, @blocked_merchants,
           @blocked_categories, @allow_recurring, @created_at, @updated_at)`,
      ).run({
        id: id('pol'),
        agent_id: agentId,
        ...merged,
        allowed_merchants: JSON.stringify(merged.allowed_merchants),
        blocked_merchants: JSON.stringify(merged.blocked_merchants),
        blocked_categories: JSON.stringify(merged.blocked_categories),
        allow_recurring: merged.allow_recurring ? 1 : 0,
        created_at: now,
        updated_at: now,
      });
    }
    return this.getByAgent(agentId);
  },
};

// ── Purchase requests ───────────────────────────────────────────────────────
export const purchaseRequests = {
  get(requestId) {
    return db.prepare('SELECT * FROM purchase_requests WHERE id = ?').get(requestId) || null;
  },
  listByAgent(agentId) {
    return db
      .prepare('SELECT * FROM purchase_requests WHERE agent_id = ? ORDER BY created_at DESC')
      .all(agentId);
  },
  create(data) {
    const row = {
      id: id('preq'),
      agent_id: data.agent_id,
      owner_user_id: data.owner_user_id,
      merchant_name: data.merchant_name,
      merchant_url: data.merchant_url ?? null,
      amount: data.amount,
      currency: data.currency,
      purpose: data.purpose,
      status: data.status,
      decision_reason: data.decision_reason ?? null,
      created_at: nowISO(),
    };
    db.prepare(
      `INSERT INTO purchase_requests
        (id, agent_id, owner_user_id, merchant_name, merchant_url, amount, currency,
         purpose, status, decision_reason, created_at)
       VALUES
        (@id, @agent_id, @owner_user_id, @merchant_name, @merchant_url, @amount, @currency,
         @purpose, @status, @decision_reason, @created_at)`,
    ).run(row);
    return row;
  },
  updateStatus(requestId, status, decisionReason) {
    db.prepare(
      'UPDATE purchase_requests SET status = ?, decision_reason = COALESCE(?, decision_reason) WHERE id = ?',
    ).run(status, decisionReason ?? null, requestId);
    return this.get(requestId);
  },
};

// ── Transactions ─────────────────────────────────────────────────────────────
export const transactions = {
  get(txnId) {
    return db.prepare('SELECT * FROM transactions WHERE id = ?').get(txnId) || null;
  },
  getByRequest(requestId) {
    return (
      db.prepare('SELECT * FROM transactions WHERE purchase_request_id = ?').get(requestId) || null
    );
  },
  listByAgent(agentId) {
    return db
      .prepare('SELECT * FROM transactions WHERE agent_id = ? ORDER BY created_at DESC')
      .all(agentId);
  },
  create(data) {
    const row = {
      id: id('txn'),
      agent_id: data.agent_id,
      purchase_request_id: data.purchase_request_id,
      provider: data.provider,
      provider_transaction_id: data.provider_transaction_id ?? null,
      merchant_name: data.merchant_name,
      amount: data.amount,
      currency: data.currency,
      status: data.status,
      decision_reason: data.decision_reason,
      created_at: nowISO(),
    };
    db.prepare(
      `INSERT INTO transactions
        (id, agent_id, purchase_request_id, provider, provider_transaction_id,
         merchant_name, amount, currency, status, decision_reason, created_at)
       VALUES
        (@id, @agent_id, @purchase_request_id, @provider, @provider_transaction_id,
         @merchant_name, @amount, @currency, @status, @decision_reason, @created_at)`,
    ).run(row);
    return row;
  },
  /** Sum of *successful* spend for an agent since the given ISO timestamp. */
  successfulSpendSince(agentId, sinceISO) {
    const r = db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
         WHERE agent_id = ? AND status = 'successful' AND created_at >= ?`,
      )
      .get(agentId, sinceISO);
    return r.total;
  },
};

// ── Approvals ────────────────────────────────────────────────────────────────
export const approvals = {
  listByRequest(requestId) {
    return db
      .prepare('SELECT * FROM approvals WHERE purchase_request_id = ? ORDER BY created_at')
      .all(requestId);
  },
  listByAgent(agentId) {
    return db
      .prepare(
        `SELECT a.* FROM approvals a
         JOIN purchase_requests p ON p.id = a.purchase_request_id
         WHERE p.agent_id = ? ORDER BY a.created_at DESC`,
      )
      .all(agentId);
  },
  create({ purchase_request_id, owner_user_id, decision, note }) {
    const row = {
      id: id('appr'),
      purchase_request_id,
      owner_user_id,
      decision,
      note: note ?? null,
      created_at: nowISO(),
    };
    db.prepare(
      `INSERT INTO approvals (id, purchase_request_id, owner_user_id, decision, note, created_at)
       VALUES (@id, @purchase_request_id, @owner_user_id, @decision, @note, @created_at)`,
    ).run(row);
    return row;
  },
};

// ── Idempotency keys ─────────────────────────────────────────────────────────
export const idempotency = {
  get(key) {
    return db.prepare('SELECT * FROM idempotency_keys WHERE key = ?').get(key) || null;
  },
  save(key, transactionId) {
    db.prepare(
      'INSERT OR IGNORE INTO idempotency_keys (key, transaction_id, created_at) VALUES (?, ?, ?)',
    ).run(key, transactionId, nowISO());
  },
};

export const auditLog = {
  listByAgent(agentId) {
    return db
      .prepare('SELECT * FROM audit_log WHERE agent_id = ? ORDER BY created_at DESC LIMIT 200')
      .all(agentId)
      .map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
  },
};
