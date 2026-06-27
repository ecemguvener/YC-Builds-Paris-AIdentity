import { db } from '../db/db.js';
import { id } from './ids.js';

/**
 * Append-only audit logger. Every policy/approval/execution decision is
 * recorded here so the whole flow is traceable. Also echoed to stdout.
 */
export function audit(event, detail = {}) {
  const row = {
    id: id('audit'),
    agent_id: detail.agent_id ?? null,
    event,
    detail: JSON.stringify(detail),
    created_at: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO audit_log (id, agent_id, event, detail, created_at)
     VALUES (@id, @agent_id, @event, @detail, @created_at)`,
  ).run(row);
  // eslint-disable-next-line no-console
  console.log(`[audit] ${event}`, detail);
  return row;
}
