import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "./config.js";

type ToolName = "email" | "phone" | "calendar" | "payment";
type PermissionName = "email.send" | "phone.call" | "calendar.create" | "payment.purchase";

export interface AgentIdentity {
  id: string;
  name: string;
  runtime: string;
  useCase: string;
  token: string;
  status: "active" | "revoked";
  tools: ToolName[];
  permissions: Record<PermissionName, boolean> & {
    requiresHumanApproval: boolean;
  };
  email: string | null;
  phone: string | null;
  calendarUrl: string | null;
  createdAt: Date;
}

interface AuditLogEntry {
  id: string;
  agentId: string;
  action: string;
  status: "allowed" | "blocked" | "revoked";
  detail: string;
  createdAt: Date;
}

const identitiesByToken = new Map<string, AgentIdentity>();
const identitiesById = new Map<string, AgentIdentity>();
const auditLogsByAgentId = new Map<string, AuditLogEntry[]>();

const initRateLimitWindowMs = 60_000;
const initRateLimitMaxPerWindow = 10;
const initRateLimitBuckets = new Map<string, { windowStartedAt: number; count: number }>();

const initIdentitySchema = z.object({
  agent_name: z.string().min(1).max(80),
  agent_runtime: z.string().min(1).max(80).default("openclaw"),
  use_case: z.string().min(1).max(120).default("automation"),
  tools: z
    .array(z.enum(["email", "phone", "calendar", "payment"]))
    .min(1)
    .default(["email", "phone", "calendar", "payment"]),
  permissions: z
    .object({
      "email.send": z.boolean().optional(),
      "phone.call": z.boolean().optional(),
      "calendar.create": z.boolean().optional(),
      "payment.purchase": z.boolean().optional(),
      requires_human_approval: z.boolean().optional()
    })
    .optional()
});

const phoneCallSchema = z.object({
  to: z.string().min(3).max(40),
  script: z.string().min(1).max(5000),
  approved: z.boolean().optional()
});

const calendarBookSchema = z.object({
  title: z.string().min(1).max(200),
  attendee_email: z.string().email(),
  start_time: z.string().min(1),
  approved: z.boolean().optional()
});

export function registerIdentityRoutes(app: FastifyInstance, config: AppConfig) {
  app.post("/api/identity/init", async (request, reply) => {
    const clientIp = request.ip ?? "unknown";
    const now = Date.now();
    const bucket = initRateLimitBuckets.get(clientIp);
    if (!bucket || now - bucket.windowStartedAt >= initRateLimitWindowMs) {
      initRateLimitBuckets.set(clientIp, { windowStartedAt: now, count: 1 });
    } else {
      bucket.count += 1;
      if (bucket.count > initRateLimitMaxPerWindow) {
        return reply.code(429).header("retry-after", "60").send({ error: "too many identity creation requests" });
      }
    }

    const payload = initIdentitySchema.parse(request.body ?? {});
    const id = `agent_${slugify(payload.agent_name)}_${randomId(8)}`;
    const token = `identity_live_${randomId(32)}`;
    const tools = [...new Set(payload.tools)] as ToolName[];
    const permissions = {
      "email.send": payload.permissions?.["email.send"] ?? tools.includes("email"),
      "phone.call": payload.permissions?.["phone.call"] ?? tools.includes("phone"),
      "calendar.create": payload.permissions?.["calendar.create"] ?? tools.includes("calendar"),
      "payment.purchase": payload.permissions?.["payment.purchase"] ?? tools.includes("payment"),
      requiresHumanApproval: payload.permissions?.requires_human_approval ?? true
    };
    const slug = slugify(payload.agent_name);
    const identity: AgentIdentity = {
      id,
      name: payload.agent_name.trim(),
      runtime: payload.agent_runtime.trim(),
      useCase: payload.use_case.trim(),
      token,
      status: "active",
      tools,
      permissions,
      email: tools.includes("email") ? `${slug}-${randomId(4)}@${config.EMAIL_FROM_DOMAIN}` : null,
      phone: tools.includes("phone") ? `+1 415 555 ${randomDigits(4)}` : null,
      calendarUrl: tools.includes("calendar") ? `${config.PUBLIC_API_URL}/calendar/${id}` : null,
      createdAt: new Date()
    };

    identitiesByToken.set(token, identity);
    identitiesById.set(id, identity);
    pushAudit(identity, "identity.init", "allowed", `${identity.name} initialized for ${identity.runtime}.`);

    if (tools.includes("email") && identity.email) {
      const { provisionEmailIdentity } = await import("./email.js");
      provisionEmailIdentity(identity.id, identity.email, identity.name, config);
    }

    let payment: {
      payment_identity_id: string;
      provider: string;
      card_last4: string;
      status: string;
    } | null = null;
    if (tools.includes("payment")) {
      const { provisionPaymentIdentity } = await import("./payments.js");
      const card = provisionPaymentIdentity(identity.id);
      payment = {
        payment_identity_id: card.id,
        provider: card.provider,
        card_last4: card.cardLast4,
        status: card.status
      };
    }

    return reply.code(201).send({
      agent_id: identity.id,
      identity_token: identity.token,
      status: identity.status,
      runtime: identity.runtime,
      use_case: identity.useCase,
      email: identity.email,
      phone: identity.phone,
      calendar_url: identity.calendarUrl,
      payment,
      tools: identity.tools,
      permissions: serializePermissions(identity),
      openclaw_env: {
        IDENTITY_LAYER_API_URL: config.PUBLIC_API_URL,
        AGENT_IDENTITY_TOKEN: identity.token
      },
      tool_endpoints: {
        email_request: `${config.PUBLIC_API_URL}/api/tools/email/request`,
        email_send: `${config.PUBLIC_API_URL}/api/tools/email/send`,
        email_pause: `${config.PUBLIC_API_URL}/api/tools/email/pause`,
        email_resume: `${config.PUBLIC_API_URL}/api/tools/email/resume`,
        email_activity: `${config.PUBLIC_API_URL}/api/identity/${identity.id}/email-activity`,
        phone_call: `${config.PUBLIC_API_URL}/api/tools/phone/call`,
        calendar_book: `${config.PUBLIC_API_URL}/api/tools/calendar/book`,
        payment_request_purchase: `${config.PUBLIC_API_URL}/api/tools/payments/request-purchase`,
        payment_request_purchase_from_text: `${config.PUBLIC_API_URL}/api/tools/payments/request-purchase-from-text`,
        payment_activity: `${config.PUBLIC_API_URL}/api/identity/${identity.id}/payment-activity`,
        audit_log: `${config.PUBLIC_API_URL}/api/identity/${identity.id}/audit-log`
      }
    });
  });

  app.post("/api/tools/phone/call", async (request, reply) => {
    const identity = readBearerIdentity(request.headers.authorization);
    if (!identity) {
      return reply.code(401).send({ error: "missing or invalid identity token" });
    }

    const payload = phoneCallSchema.parse(request.body ?? {});
    const block = checkAction(identity, "phone.call", payload.approved);
    if (block) {
      pushAudit(identity, "phone.call", "blocked", block);
      return reply.code(403).send({ error: block });
    }

    const transcript = [
      `${identity.name}: Hi, I am calling on behalf of the team to ask two quick validation questions.`,
      "Prospect: Sure, I can spare a minute.",
      `${identity.name}: What is painful about the current workflow?`,
      "Prospect: The manual follow-up is the part we never keep up with."
    ];
    pushAudit(identity, "phone.call", "allowed", `Simulated call placed to ${payload.to}.`);
    return {
      ok: true,
      provider: "demo-twilio",
      call_id: `call_${randomId(12)}`,
      from: identity.phone,
      to: payload.to,
      transcript
    };
  });

  app.post("/api/tools/calendar/book", async (request, reply) => {
    const identity = readBearerIdentity(request.headers.authorization);
    if (!identity) {
      return reply.code(401).send({ error: "missing or invalid identity token" });
    }

    const payload = calendarBookSchema.parse(request.body ?? {});
    const block = checkAction(identity, "calendar.create", payload.approved);
    if (block) {
      pushAudit(identity, "calendar.create", "blocked", block);
      return reply.code(403).send({ error: block });
    }

    pushAudit(identity, "calendar.create", "allowed", `Meeting booked with ${payload.attendee_email}: ${payload.title}`);
    return {
      ok: true,
      provider: "demo-calendar",
      event_id: `evt_${randomId(12)}`,
      calendar_url: identity.calendarUrl,
      title: payload.title,
      attendee_email: payload.attendee_email,
      start_time: payload.start_time
    };
  });

  app.get("/api/identity/:agentId/audit-log", async (request, reply) => {
    const identity = readBearerIdentity(request.headers.authorization);
    if (!identity) {
      return reply.code(401).send({ error: "missing or invalid identity token" });
    }

    const { agentId } = request.params as { agentId: string };
    if (identity.id !== agentId) {
      return reply.code(403).send({ error: "identity token does not match requested agent" });
    }

    return {
      agent_id: identity.id,
      status: identity.status,
      audit_log: serializeAuditLog(identity.id)
    };
  });

  app.post("/api/identity/revoke", async (request, reply) => {
    const identity = readBearerIdentity(request.headers.authorization);
    if (!identity) {
      return reply.code(401).send({ error: "missing or invalid identity token" });
    }

    identity.status = "revoked";
    pushAudit(identity, "identity.revoke", "revoked", `${identity.name} identity token revoked.`);
    return {
      ok: true,
      agent_id: identity.id,
      status: identity.status
    };
  });
}

function checkAction(identity: AgentIdentity, permission: PermissionName, approved: boolean | undefined): string | null {
  if (identity.status !== "active") {
    return "identity is revoked";
  }

  if (!identity.permissions[permission]) {
    return `permission denied: ${permission}`;
  }

  if (identity.permissions.requiresHumanApproval && approved !== true) {
    return "human approval is required for this action";
  }

  return null;
}

function readBearerIdentity(authorization: string | undefined): AgentIdentity | null {
  if (!authorization) {
    return null;
  }

  const [scheme, token] = authorization.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }

  return identitiesByToken.get(token.trim()) ?? null;
}

function pushAudit(identity: AgentIdentity, action: string, status: AuditLogEntry["status"], detail: string) {
  const entries = auditLogsByAgentId.get(identity.id) ?? [];
  entries.unshift({
    id: `log_${randomId(12)}`,
    agentId: identity.id,
    action,
    status,
    detail,
    createdAt: new Date()
  });
  auditLogsByAgentId.set(identity.id, entries.slice(0, 100));
}

function serializeAuditLog(agentId: string) {
  return (auditLogsByAgentId.get(agentId) ?? []).map((entry) => ({
    id: entry.id,
    agent_id: entry.agentId,
    action: entry.action,
    status: entry.status,
    detail: entry.detail,
    created_at: entry.createdAt.toISOString()
  }));
}

function serializePermissions(identity: AgentIdentity) {
  return {
    "email.send": identity.permissions["email.send"],
    "phone.call": identity.permissions["phone.call"],
    "calendar.create": identity.permissions["calendar.create"],
    "payment.purchase": identity.permissions["payment.purchase"],
    requires_human_approval: identity.permissions.requiresHumanApproval
  };
}

// Accessors shared with other tool modules (e.g. payments.ts) so they can
// authenticate against the same in-memory identity store and write to the
// same audit log.
export function getAgentIdentityByToken(token: string): AgentIdentity | null {
  return identitiesByToken.get(token) ?? null;
}

export function getAgentIdentityById(agentId: string): AgentIdentity | null {
  return identitiesById.get(agentId) ?? null;
}

export function recordIdentityAudit(
  agentId: string,
  action: string,
  status: AuditLogEntry["status"],
  detail: string
): void {
  const identity = identitiesById.get(agentId);
  if (!identity) {
    return;
  }
  pushAudit(identity, action, status, detail);
}

function randomId(byteLength: number): string {
  return crypto.randomBytes(byteLength).toString("base64url");
}

function randomDigits(length: number): string {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += crypto.randomInt(10).toString();
  }
  return value;
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "agent";
}
