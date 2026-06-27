import { Router } from 'express';
import {
  requestPurchase,
  requestPurchaseFromText,
  approveRequest,
  rejectRequest,
  executePurchase,
} from '../services/paymentService.js';
import { toolManifest } from '../toolManifest.js';

export const toolsRouter = Router();

// Tool manifest for the Agent Hub.
toolsRouter.get('/tools/manifest', (req, res) => {
  res.json({ tools: toolManifest });
});

// 3. Agent tool call: request a purchase.
toolsRouter.post('/tools/payments/request-purchase', (req, res, next) => {
  try {
    const result = requestPurchase(req.body || {});
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// 3b. Natural-language tool call: "Buy £15 of OpenAI credits".
toolsRouter.post('/tools/payments/request-purchase-from-text', async (req, res, next) => {
  try {
    const { agent_id, prompt } = req.body || {};
    const result = await requestPurchaseFromText({ agent_id, prompt });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// 4. Human approval.
toolsRouter.post('/tools/payments/:requestId/approve', (req, res, next) => {
  try {
    const { owner_user_id, note } = req.body || {};
    const updated = approveRequest(req.params.requestId, owner_user_id, note);
    res.json({
      request_id: updated.id,
      status: updated.status,
      decision_reason: updated.decision_reason,
    });
  } catch (err) {
    next(err);
  }
});

// 5. Human rejection.
toolsRouter.post('/tools/payments/:requestId/reject', (req, res, next) => {
  try {
    const { owner_user_id, note } = req.body || {};
    const updated = rejectRequest(req.params.requestId, owner_user_id, note);
    res.json({
      request_id: updated.id,
      status: updated.status,
      decision_reason: updated.decision_reason,
    });
  } catch (err) {
    next(err);
  }
});

// 6. Execute purchase (only if approved). Honours an Idempotency-Key header.
toolsRouter.post('/tools/payments/:requestId/execute', async (req, res, next) => {
  try {
    const idempotencyKey =
      req.get('Idempotency-Key') || req.body?.idempotency_key || undefined;
    const txn = await executePurchase(req.params.requestId, idempotencyKey);
    res.json({
      transaction_id: txn.id,
      status: txn.status,
      merchant_name: txn.merchant_name,
      amount: txn.amount,
      currency: txn.currency,
    });
  } catch (err) {
    next(err);
  }
});
