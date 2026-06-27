import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { migrate, seedDemoAgents } from './db/db.js';
import { agentsRouter } from './routes/agents.js';
import { toolsRouter } from './routes/tools.js';
import { ServiceError } from './services/paymentService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

migrate();
seedDemoAgents();

const app = express();
app.use(express.json());

// Static dashboard (Payment tab).
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (req, res) => res.json({ ok: true, provider: process.env.PAYMENT_PROVIDER || 'mock' }));

app.use(agentsRouter);
app.use(toolsRouter);

// Centralised error handling — maps ServiceError to HTTP, everything else to 500.
app.use((err, req, res, _next) => {
  if (err instanceof ServiceError) {
    return res.status(err.status).json({ error: err.code, message: err.message });
  }
  // eslint-disable-next-line no-console
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'internal_error', message: err.message });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Payment Tool API listening on http://localhost:${PORT}`);
  console.log(`Dashboard:    http://localhost:${PORT}/`);
  console.log(`Provider:     ${process.env.PAYMENT_PROVIDER || 'mock'}`);
});

export { app };
