-- Payment Tool Module — database schema / migration.
-- Idempotent: safe to run on every boot.

-- ─────────────────────────────────────────────────────────────
-- Identity Hub (owned by the host platform — modelled here so the
-- payment module can validate that agent_id exists before acting).
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agents (
  agent_id        TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  owner_user_id   TEXT NOT NULL,
  email           TEXT,
  phone           TEXT,
  calendar        TEXT,
  created_at      TEXT NOT NULL
);

-- ─────────────────────────────────────────────────────────────
-- Payment module tables
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payment_identities (
  id               TEXT PRIMARY KEY,
  agent_id         TEXT NOT NULL,
  owner_user_id    TEXT NOT NULL,
  provider         TEXT NOT NULL CHECK (provider IN ('mock','stripe')),
  provider_card_id TEXT,
  card_last4       TEXT,
  status           TEXT NOT NULL CHECK (status IN ('active','paused','disabled')),
  created_at       TEXT NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_identity_agent ON payment_identities(agent_id);

CREATE TABLE IF NOT EXISTS payment_policies (
  id                       TEXT PRIMARY KEY,
  agent_id                 TEXT NOT NULL,
  max_transaction_amount   REAL NOT NULL,
  daily_limit              REAL NOT NULL,
  monthly_limit            REAL NOT NULL,
  approval_required_above  REAL NOT NULL,
  allowed_merchants        TEXT NOT NULL,   -- JSON array
  blocked_merchants        TEXT NOT NULL,   -- JSON array
  blocked_categories       TEXT NOT NULL,   -- JSON array
  allow_recurring          INTEGER NOT NULL DEFAULT 0,
  created_at               TEXT NOT NULL,
  updated_at               TEXT NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_policy_agent ON payment_policies(agent_id);

CREATE TABLE IF NOT EXISTS purchase_requests (
  id               TEXT PRIMARY KEY,
  agent_id         TEXT NOT NULL,
  owner_user_id    TEXT NOT NULL,
  merchant_name    TEXT NOT NULL,
  merchant_url     TEXT,
  amount           REAL NOT NULL,
  currency         TEXT NOT NULL,
  purpose          TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN
                     ('pending','approved','requires_approval','rejected','executed','failed')),
  decision_reason  TEXT,
  created_at       TEXT NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id)
);
CREATE INDEX IF NOT EXISTS idx_purchase_requests_agent ON purchase_requests(agent_id);

CREATE TABLE IF NOT EXISTS transactions (
  id                      TEXT PRIMARY KEY,
  agent_id                TEXT NOT NULL,
  purchase_request_id     TEXT NOT NULL,
  provider                TEXT NOT NULL CHECK (provider IN ('mock','stripe')),
  provider_transaction_id TEXT,
  merchant_name           TEXT NOT NULL,
  amount                  REAL NOT NULL,
  currency                TEXT NOT NULL,
  status                  TEXT NOT NULL CHECK (status IN ('successful','declined','failed')),
  decision_reason         TEXT NOT NULL,
  created_at              TEXT NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(agent_id),
  FOREIGN KEY (purchase_request_id) REFERENCES purchase_requests(id)
);
CREATE INDEX IF NOT EXISTS idx_transactions_agent ON transactions(agent_id);
-- One settled transaction per purchase request → idempotent execution.
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_request ON transactions(purchase_request_id);

CREATE TABLE IF NOT EXISTS approvals (
  id                  TEXT PRIMARY KEY,
  purchase_request_id TEXT NOT NULL,
  owner_user_id       TEXT NOT NULL,
  decision            TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  note                TEXT,
  created_at          TEXT NOT NULL,
  FOREIGN KEY (purchase_request_id) REFERENCES purchase_requests(id)
);
CREATE INDEX IF NOT EXISTS idx_approvals_request ON approvals(purchase_request_id);

-- Idempotency keys for execute (header-supplied or derived).
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key            TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

-- Append-only audit log of every decision the module makes.
CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT,
  event       TEXT NOT NULL,
  detail      TEXT NOT NULL,   -- JSON
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_log(agent_id);
