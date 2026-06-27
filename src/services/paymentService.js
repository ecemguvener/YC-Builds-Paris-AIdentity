import {
  agents,
  paymentIdentities,
  policies,
  purchaseRequests,
  transactions,
  approvals,
  idempotency,
  auditLog,
} from '../store/repositories.js';
import { evaluatePurchaseRequest } from '../engine/policyEngine.js';
import { getProvider } from '../providers/index.js';
import { parsePurchaseFromText } from '../agent/parsePurchase.js';
import { audit } from '../util/logger.js';

/** Error carrying an HTTP status so routes can translate cleanly. */
export class ServiceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function requireAgent(agentId) {
  const agent = agents.get(agentId);
  if (!agent) {
    throw new ServiceError(404, 'agent_not_found', `Agent ${agentId} not found in Identity Hub`);
  }
  return agent;
}

function startOfTodayISO() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}
function startOfMonthISO() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

// ── 1. Attach payment identity ───────────────────────────────────────────────
export async function attachPaymentIdentity(agentId, { provider } = {}) {
  const agent = requireAgent(agentId);
  if (paymentIdentities.getByAgent(agentId)) {
    throw new ServiceError(409, 'identity_exists', 'Agent already has a payment identity');
  }
  const prov = getProvider(provider);
  const card = await prov.createCard(agentId);
  const identity = paymentIdentities.create({
    agent_id: agentId,
    owner_user_id: agent.owner_user_id,
    provider: prov.name,
    provider_card_id: card.provider_card_id,
    card_last4: card.card_last4,
    status: 'active',
  });
  audit('payment_identity.created', {
    agent_id: agentId,
    payment_identity_id: identity.id,
    provider: prov.name,
  });
  return {
    agent_id: agentId,
    payment_identity_id: identity.id,
    provider: identity.provider,
    card_last4: identity.card_last4,
    status: identity.status,
  };
}

// ── 2. Set / update policy ────────────────────────────────────────────────────
export function setPolicy(agentId, patch) {
  requireAgent(agentId);
  const policy = policies.upsert(agentId, patch);
  audit('payment_policy.updated', { agent_id: agentId, policy });
  return policy;
}

// ── 3. requestPurchase (the ONLY entry point an agent may call) ───────────────
export function requestPurchase(input) {
  const { agent_id, merchant_name, merchant_url, amount, currency, purpose, category, recurring } =
    input;

  const agent = requireAgent(agent_id);

  if (!merchant_name || !currency || !purpose) {
    throw new ServiceError(400, 'invalid_request', 'merchant_name, currency and purpose are required');
  }

  const policy = policies.getByAgent(agent_id);
  const spendingToday = transactions.successfulSpendSince(agent_id, startOfTodayISO());
  const spendingMonth = transactions.successfulSpendSince(agent_id, startOfMonthISO());

  const decision = evaluatePurchaseRequest(
    { merchant_name, amount, category, recurring },
    policy,
    spendingToday,
    spendingMonth,
  );

  const request = purchaseRequests.create({
    agent_id,
    owner_user_id: agent.owner_user_id,
    merchant_name,
    merchant_url,
    amount,
    currency,
    purpose,
    status: decision.status,
    decision_reason: decision.reason,
  });

  audit('purchase_request.evaluated', {
    agent_id,
    request_id: request.id,
    status: decision.status,
    reason: decision.reason,
    amount,
    merchant_name,
    spendingToday,
    spendingMonth,
  });

  return {
    request_id: request.id,
    status: request.status,
    decision_reason: request.decision_reason,
  };
}

// ── 3b. requestPurchase from a natural-language prompt ────────────────────────
// Parses "Buy £15 of OpenAI credits" into structured fields, then runs the
// exact same requestPurchase() path. The LLM only fills in the form — the
// policy engine still makes the decision.
export async function requestPurchaseFromText({ agent_id, prompt }) {
  requireAgent(agent_id);
  if (!prompt || !prompt.trim()) {
    throw new ServiceError(400, 'invalid_request', 'prompt is required');
  }

  const parsed = await parsePurchaseFromText({ text: prompt, agentId: agent_id });
  audit('purchase_request.parsed_from_text', {
    agent_id,
    prompt,
    parsed,
  });

  if (!parsed.merchant_name || parsed.merchant_name === 'Unknown merchant') {
    throw new ServiceError(
      422,
      'unparseable',
      `Couldn't identify a merchant to pay in: "${prompt}". Try naming where to buy it (e.g. "from Amazon").`,
    );
  }

  const result = requestPurchase({
    agent_id,
    merchant_name: parsed.merchant_name,
    merchant_url: parsed.merchant_url,
    amount: parsed.amount,
    currency: parsed.currency,
    purpose: parsed.purpose || prompt.trim(),
  });

  return { ...result, parsed };
}

// ── 4 & 5. Human approval / rejection ─────────────────────────────────────────
function decide(requestId, ownerUserId, decision, note) {
  const request = purchaseRequests.get(requestId);
  if (!request) throw new ServiceError(404, 'request_not_found', 'Purchase request not found');

  // Validate the approver actually owns this agent.
  if (!ownerUserId) {
    throw new ServiceError(400, 'invalid_request', 'owner_user_id is required');
  }
  if (ownerUserId !== request.owner_user_id) {
    audit('approval.denied_wrong_owner', {
      agent_id: request.agent_id,
      request_id: requestId,
      attempted_by: ownerUserId,
    });
    throw new ServiceError(403, 'forbidden', 'owner_user_id does not own this request');
  }

  if (!['pending', 'requires_approval'].includes(request.status)) {
    throw new ServiceError(
      409,
      'invalid_state',
      `Request is '${request.status}' and can no longer be decided`,
    );
  }

  approvals.create({
    purchase_request_id: requestId,
    owner_user_id: ownerUserId,
    decision,
    note,
  });

  const newStatus = decision === 'approved' ? 'approved' : 'rejected';
  const reason =
    decision === 'approved'
      ? `Approved by ${ownerUserId}${note ? `: ${note}` : ''}`
      : `Rejected by ${ownerUserId}${note ? `: ${note}` : ''}`;
  const updated = purchaseRequests.updateStatus(requestId, newStatus, reason);

  audit(`approval.${decision}`, {
    agent_id: request.agent_id,
    request_id: requestId,
    owner_user_id: ownerUserId,
    note,
  });
  return updated;
}

export const approveRequest = (requestId, ownerUserId, note) =>
  decide(requestId, ownerUserId, 'approved', note);
export const rejectRequest = (requestId, ownerUserId, note) =>
  decide(requestId, ownerUserId, 'rejected', note);

// ── 6. Execute purchase ───────────────────────────────────────────────────────
export async function executePurchase(requestId, idempotencyKey) {
  const request = purchaseRequests.get(requestId);
  if (!request) throw new ServiceError(404, 'request_not_found', 'Purchase request not found');

  // Idempotency: an explicit key OR a prior settled transaction returns the
  // same result instead of charging twice.
  const key = idempotencyKey || `exec:${requestId}`;
  const seen = idempotency.get(key);
  if (seen) {
    const txn = transactions.get(seen.transaction_id);
    if (txn) {
      audit('purchase.execute_idempotent_replay', {
        agent_id: request.agent_id,
        request_id: requestId,
        transaction_id: txn.id,
      });
      return txn;
    }
  }
  const existingTxn = transactions.getByRequest(requestId);
  if (existingTxn) {
    audit('purchase.execute_duplicate_blocked', {
      agent_id: request.agent_id,
      request_id: requestId,
      transaction_id: existingTxn.id,
    });
    return existingTxn;
  }

  if (request.status !== 'approved') {
    throw new ServiceError(409, 'not_approved', 'Purchase request is not approved');
  }

  const paymentIdentity = paymentIdentities.getByAgent(request.agent_id);
  if (!paymentIdentity || paymentIdentity.status !== 'active') {
    throw new ServiceError(409, 'no_active_identity', 'No active payment identity');
  }

  const provider = getProvider(paymentIdentity.provider);
  const result = await provider.charge({
    paymentIdentityId: paymentIdentity.id,
    merchantName: request.merchant_name,
    amount: request.amount,
    currency: request.currency,
  });

  const txn = transactions.create({
    agent_id: request.agent_id,
    purchase_request_id: request.id,
    provider: paymentIdentity.provider,
    provider_transaction_id: result.provider_transaction_id,
    merchant_name: request.merchant_name,
    amount: request.amount,
    currency: request.currency,
    status: result.status,
    decision_reason: result.reason,
  });

  idempotency.save(key, txn.id);

  // Reflect the provider outcome on the request.
  const requestStatus = result.status === 'successful' ? 'executed' : 'failed';
  purchaseRequests.updateStatus(request.id, requestStatus, result.reason);

  audit('purchase.executed', {
    agent_id: request.agent_id,
    request_id: requestId,
    transaction_id: txn.id,
    status: txn.status,
    amount: txn.amount,
    currency: txn.currency,
  });

  return txn;
}

// ── 7. Activity log ─────────────────────────────────────────────────────────
export function getActivity(agentId) {
  requireAgent(agentId);
  const identity = paymentIdentities.getByAgent(agentId);
  return {
    agent: agents.get(agentId),
    payment_identity: identity
      ? {
          payment_identity_id: identity.id,
          provider: identity.provider,
          card_last4: identity.card_last4,
          status: identity.status,
          created_at: identity.created_at,
          // NOTE: provider_card_id is deliberately NOT returned to clients.
        }
      : null,
    policy: policies.getByAgent(agentId),
    purchase_requests: purchaseRequests.listByAgent(agentId),
    approvals: approvals.listByAgent(agentId),
    transactions: transactions.listByAgent(agentId),
    audit_log: auditLog.listByAgent(agentId),
  };
}
