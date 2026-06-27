import { Router } from 'express';
import {
  attachPaymentIdentity,
  setPolicy,
  getActivity,
} from '../services/paymentService.js';
import { agents } from '../store/repositories.js';

export const agentsRouter = Router();

// Identity Hub helper: list agents (handy for the dashboard selector).
agentsRouter.get('/agents', (req, res) => {
  res.json({ agents: agents.list() });
});

// 1. Attach payment identity to an agent.
agentsRouter.post('/agents/:agentId/payment-identity', async (req, res, next) => {
  try {
    const result = await attachPaymentIdentity(req.params.agentId, {
      provider: req.body?.provider,
    });
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// 2. Set / update payment policy.
agentsRouter.patch('/agents/:agentId/payment-policy', (req, res, next) => {
  try {
    const policy = setPolicy(req.params.agentId, req.body || {});
    res.json(policy);
  } catch (err) {
    next(err);
  }
});

// 7. Activity log: requests + approvals + transactions.
agentsRouter.get('/agents/:agentId/payment-activity', (req, res, next) => {
  try {
    res.json(getActivity(req.params.agentId));
  } catch (err) {
    next(err);
  }
});
