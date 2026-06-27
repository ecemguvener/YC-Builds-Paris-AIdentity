import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { getAgentIdentityByToken, recordIdentityAudit, type AgentIdentity } from "./identity.js";

// ---------------------------------------------------------------------------
// Email Capability Add-on
//
// A plug-in communication layer that lets an existing agent identity send and
// receive *real* email as a personal assistant. The brain (the existing agent)
// calls these tools; this module owns the email identity, sending, inbound
// reply matching, summaries, and the activity log.
//
// It mirrors the payments capability: in-memory stores keyed by the agent
// identity id, Bearer identity-token auth, and audit entries written to the
// shared identity audit log via recordIdentityAudit().
//
// Provider: Resend when RESEND_API_KEY is configured, otherwise a mock sender
// (logs + synthetic message id) so the whole flow is demoable without a
// verified sending domain.
// ---------------------------------------------------------------------------

type Provider = "resend" | "mock";
type EmailIdentityStatus = "active" | "paused";
type Direction = "outbound" | "inbound";
type MessageStatus = "sent" | "failed" | "received";
type NotificationStatus = "unread" | "read";

interface EmailIdentity {
  id: string;
  accountId: string; // the agent identity id
  emailAddress: string;
  displayName: string;
  provider: Provider;
  status: EmailIdentityStatus;
  createdAt: Date;
}

interface EmailMessage {
  id: string;
  accountId: string;
  threadId: string;
  direction: Direction;
  fromEmail: string;
  toEmail: string;
  subject: string;
  body: string;
  providerMessageId: string | null;
  status: MessageStatus;
  parsedBy: "openai" | "heuristic" | null;
  createdAt: Date;
}

interface EmailReplyNotification {
  id: string;
  accountId: string;
  emailMessageId: string;
  threadId: string;
  fromEmail: string;
  subject: string;
  summary: string;
  suggestedReply: string;
  status: NotificationStatus;
  createdAt: Date;
}

// --- In-memory stores -------------------------------------------------------

const emailIdentityByAccount = new Map<string, EmailIdentity>();
const accountByAddress = new Map<string, string>(); // lowercased address -> accountId
const messagesByAccount = new Map<string, EmailMessage[]>();
const messageByProviderId = new Map<string, EmailMessage>();
const notificationsByAccount = new Map<string, EmailReplyNotification[]>();
const threadByCounterparty = new Map<string, string>(); // `${accountId}:${counterparty}` -> threadId

/** Error carrying an HTTP status so route handlers can translate cleanly. */
export class EmailError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "EmailError";
  }
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const sendSchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(10_000),
  approved: z.boolean().optional()
});

const requestSchema = z.object({
  request: z.string().min(1).max(2000),
  to: z.string().email().optional(),
  approved: z.boolean().optional()
});

const inboundSchema = z.object({
  from: z.string().min(3).max(320),
  to: z.string().min(3).max(320),
  subject: z.string().max(300).optional(),
  text: z.string().max(50_000).optional(),
  html: z.string().max(200_000).optional(),
  in_reply_to: z.string().max(998).optional(),
  message_id: z.string().max(998).optional()
});

// ---------------------------------------------------------------------------
// Provisioning + lookups
// ---------------------------------------------------------------------------

/**
 * Attach an email identity to an agent. Called lazily from identity init when
 * the agent's tools include "email" (the address is already minted there).
 */
export function provisionEmailIdentity(accountId: string, emailAddress: string, displayName: string, config: AppConfig): EmailIdentity {
  const existing = emailIdentityByAccount.get(accountId);
  if (existing) {
    return existing;
  }
  const identity: EmailIdentity = {
    id: `emailid_${randomId(8)}`,
    accountId,
    emailAddress,
    displayName,
    provider: config.RESEND_API_KEY ? "resend" : "mock",
    status: "active",
    createdAt: new Date()
  };
  emailIdentityByAccount.set(accountId, identity);
  accountByAddress.set(emailAddress.toLowerCase(), accountId);
  recordIdentityAudit(accountId, "email.provision", "allowed", `Email identity ${emailAddress} provisioned (${identity.provider}).`);
  return identity;
}

export function getEmailIdentity(accountId: string): EmailIdentity | null {
  return emailIdentityByAccount.get(accountId) ?? null;
}

export function setEmailIdentityStatus(accountId: string, status: EmailIdentityStatus): EmailIdentity {
  const identity = emailIdentityByAccount.get(accountId);
  if (!identity) {
    throw new EmailError(404, "no email identity for this agent");
  }
  identity.status = status;
  recordIdentityAudit(accountId, status === "paused" ? "email.pause" : "email.resume", "allowed", `Email identity ${status === "paused" ? "paused" : "resumed"}.`);
  return identity;
}

// ---------------------------------------------------------------------------
// Core operations (shared by bearer routes and the webhook)
// ---------------------------------------------------------------------------

export interface SendResult {
  message: EmailMessage;
  parsed?: GeneratedEmail;
}

/** Send an explicit email (recipient/subject/body already known). */
export async function sendEmail(
  identity: AgentIdentity,
  input: { to: string; subject: string; body: string; approved?: boolean },
  config: AppConfig,
  parsed?: GeneratedEmail
): Promise<EmailMessage> {
  const emailIdentity = requireSendableIdentity(identity, input.approved);
  const threadId = threadFor(identity.id, input.to);
  const from = formatFrom(emailIdentity);

  let providerMessageId: string | null = null;
  let status: MessageStatus = "sent";
  try {
    const result = await dispatchSend(config, { from, to: input.to, subject: input.subject, text: input.body });
    providerMessageId = result.providerMessageId;
  } catch (error) {
    status = "failed";
    recordIdentityAudit(identity.id, "email.send", "blocked", `Send to ${input.to} failed: ${(error as Error).message}`);
    storeMessage({
      accountId: identity.id,
      threadId,
      direction: "outbound",
      fromEmail: emailIdentity.emailAddress,
      toEmail: input.to,
      subject: input.subject,
      body: input.body,
      providerMessageId,
      status,
      parsedBy: parsed?.parsedBy ?? null
    });
    throw error instanceof EmailError ? error : new EmailError(502, `email provider error: ${(error as Error).message}`);
  }

  const message = storeMessage({
    accountId: identity.id,
    threadId,
    direction: "outbound",
    fromEmail: emailIdentity.emailAddress,
    toEmail: input.to,
    subject: input.subject,
    body: input.body,
    providerMessageId,
    status,
    parsedBy: parsed?.parsedBy ?? null
  });
  recordIdentityAudit(identity.id, "email.send", "allowed", `Email sent to ${input.to}: ${input.subject}`);
  return message;
}

/**
 * Turn a plain-English instruction ("Email Sarah and ask if she can send the
 * contract today") into a recipient/subject/body, then send it. Throws a 422
 * if no recipient email can be resolved so the brain can ask the user for one.
 */
export async function sendEmailFromRequest(
  identity: AgentIdentity,
  input: { request: string; to?: string; approved?: boolean },
  config: AppConfig
): Promise<SendResult> {
  // Gate first so we don't spend an LLM call on a blocked/paused identity.
  requireSendableIdentity(identity, input.approved);
  const generated = await generateEmailFromText(input.request, identity, config);
  const to = input.to ?? generated.to ?? undefined;
  if (!to) {
    throw new EmailError(
      422,
      `couldn't find a recipient email in: "${input.request}". Ask the user for the recipient's email address, then pass it as "to".`
    );
  }
  const message = await sendEmail(identity, { to, subject: generated.subject, body: generated.body, approved: input.approved }, config, generated);
  return { message, parsed: { ...generated, to } };
}

export function getEmailActivity(accountId: string) {
  const identity = emailIdentityByAccount.get(accountId);
  return {
    account_id: accountId,
    email_identity: identity
      ? {
          email_identity_id: identity.id,
          email_address: identity.emailAddress,
          display_name: identity.displayName,
          provider: identity.provider,
          status: identity.status,
          created_at: identity.createdAt.toISOString()
        }
      : null,
    messages: (messagesByAccount.get(accountId) ?? []).map(serializeMessage),
    reply_notifications: (notificationsByAccount.get(accountId) ?? []).map(serializeNotification)
  };
}

/**
 * Ingest an inbound reply from the provider webhook: match it to the right
 * agent + thread, store it, summarize it, and raise a reply notification the
 * hub can surface to the user.
 */
export async function ingestInboundReply(
  payload: z.infer<typeof inboundSchema>,
  config: AppConfig
): Promise<EmailReplyNotification | null> {
  const recipient = extractAddress(payload.to);
  const accountId = accountByAddress.get(recipient.toLowerCase());
  if (!accountId) {
    return null; // not addressed to any known agent identity
  }
  const sender = extractAddress(payload.from);
  const body = (payload.text ?? stripHtml(payload.html ?? "")).trim();
  const subject = payload.subject?.trim() || "(no subject)";

  // Thread: prefer the message the reply is in-reply-to, else the latest
  // conversation with this counterparty, else a fresh thread.
  const parent = payload.in_reply_to ? messageByProviderId.get(payload.in_reply_to) : undefined;
  const threadId = parent?.threadId ?? threadByCounterparty.get(`${accountId}:${sender.toLowerCase()}`) ?? newThread();
  threadByCounterparty.set(`${accountId}:${sender.toLowerCase()}`, threadId);

  const message = storeMessage({
    accountId,
    threadId,
    direction: "inbound",
    fromEmail: sender,
    toEmail: recipient,
    subject,
    body,
    providerMessageId: payload.message_id ?? null,
    status: "received",
    parsedBy: null
  });

  const { summary, suggestedReply } = await summarizeReply(subject, body, config);
  const notification: EmailReplyNotification = {
    id: `emailnotif_${randomId(8)}`,
    accountId,
    emailMessageId: message.id,
    threadId,
    fromEmail: sender,
    subject,
    summary,
    suggestedReply,
    status: "unread",
    createdAt: new Date()
  };
  const list = notificationsByAccount.get(accountId) ?? [];
  list.unshift(notification);
  notificationsByAccount.set(accountId, list.slice(0, 200));

  // Notify the hub: audit + a structured log line a hub listener can pick up.
  recordIdentityAudit(accountId, "email.reply", "allowed", `Reply from ${sender}: ${summary}`);
  // eslint-disable-next-line no-console
  console.info(`[email:reply] agent=${accountId} thread=${threadId} from=${sender} :: ${summary}`);
  return notification;
}

// ---------------------------------------------------------------------------
// Provider — Resend with a mock fallback
// ---------------------------------------------------------------------------

interface OutboundPayload {
  from: string;
  to: string;
  subject: string;
  text: string;
}

async function dispatchSend(config: AppConfig, payload: OutboundPayload): Promise<{ providerMessageId: string; provider: Provider }> {
  if (config.RESEND_API_KEY) {
    return sendViaResend(config.RESEND_API_KEY, payload);
  }
  return sendViaMock(payload);
}

async function sendViaResend(apiKey: string, payload: OutboundPayload): Promise<{ providerMessageId: string; provider: "resend" }> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ from: payload.from, to: payload.to, subject: payload.subject, text: payload.text })
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new EmailError(502, `Resend ${response.status}: ${responseText.slice(0, 300)}`);
  }
  let id: string | undefined;
  try {
    id = (JSON.parse(responseText) as { id?: string }).id;
  } catch {
    id = undefined;
  }
  return { providerMessageId: id ?? `resend_${randomId(8)}`, provider: "resend" };
}

function sendViaMock(payload: OutboundPayload): { providerMessageId: string; provider: "mock" } {
  // eslint-disable-next-line no-console
  console.info(`[email:mock] ${payload.from} -> ${payload.to} :: ${payload.subject}`);
  return { providerMessageId: `mock_${randomId(10)}`, provider: "mock" };
}

// ---------------------------------------------------------------------------
// Natural-language drafting + reply summaries: OpenAI Responses API → heuristic
// ---------------------------------------------------------------------------

export interface GeneratedEmail {
  to: string | null;
  recipientName: string | null;
  subject: string;
  body: string;
  parsedBy: "openai" | "heuristic";
}

const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    to: { type: "string" },
    recipient_name: { type: "string" },
    subject: { type: "string" },
    body: { type: "string" }
  },
  required: ["subject", "body"],
  additionalProperties: false
} as const;

export async function generateEmailFromText(prompt: string, identity: AgentIdentity, config: AppConfig): Promise<GeneratedEmail> {
  if (config.OPENAI_API_KEY) {
    try {
      return await generateWithOpenAI(prompt, identity, config);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn("[email] OpenAI draft failed, using heuristic:", (error as Error).message);
    }
  }
  return draftHeuristic(prompt, identity);
}

async function generateWithOpenAI(prompt: string, identity: AgentIdentity, config: AppConfig): Promise<GeneratedEmail> {
  const instructions =
    "You draft a short, professional email on behalf of an AI assistant. " +
    `The sender is "${identity.name}", an assistant. ` +
    "From the user's instruction, extract the recipient's email address into `to` if one is present (otherwise omit it), " +
    "extract the recipient's name into `recipient_name` if present, write a concise `subject` (max 8 words), " +
    "and write a polite plain-text `body` that opens with a greeting and ends with a sign-off as the assistant. " +
    "Do not invent an email address.";

  const model = process.env.OPENAI_EMAIL_MODEL || "gpt-4o-mini";
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model,
      instructions,
      input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
      max_output_tokens: 600,
      text: { format: { type: "json_schema", name: "email_draft", schema: DRAFT_SCHEMA, strict: false } }
    })
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI responses ${response.status}: ${responseText.slice(0, 300)}`);
  }
  const outputText = readOpenAIOutputText(responseText);
  if (!outputText) {
    throw new Error("OpenAI returned no output");
  }
  const raw = JSON.parse(outputText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")) as Record<string, unknown>;
  const to = typeof raw.to === "string" ? extractEmail(raw.to) : extractEmail(prompt);
  return {
    to,
    recipientName: typeof raw.recipient_name === "string" ? raw.recipient_name.trim() || null : null,
    subject: String(raw.subject ?? "").trim() || defaultSubject(prompt),
    body: String(raw.body ?? "").trim() || defaultBody(prompt, identity, null),
    parsedBy: "openai"
  };
}

function draftHeuristic(prompt: string, identity: AgentIdentity): GeneratedEmail {
  const to = extractEmail(prompt);
  const recipientName = extractRecipientName(prompt);
  return {
    to,
    recipientName,
    subject: defaultSubject(prompt),
    body: defaultBody(prompt, identity, recipientName),
    parsedBy: "heuristic"
  };
}

export interface ReplySummary {
  summary: string;
  suggestedReply: string;
}

const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    suggested_reply: { type: "string" }
  },
  required: ["summary", "suggested_reply"],
  additionalProperties: false
} as const;

export async function summarizeReply(subject: string, body: string, config: AppConfig): Promise<ReplySummary> {
  if (config.OPENAI_API_KEY && body) {
    try {
      const model = process.env.OPENAI_EMAIL_MODEL || "gpt-4o-mini";
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.OPENAI_API_KEY}` },
        body: JSON.stringify({
          model,
          instructions:
            "Summarize this inbound email reply in one sentence (`summary`) and draft a short, polite `suggested_reply` the assistant could send back.",
          input: [{ role: "user", content: [{ type: "input_text", text: `Subject: ${subject}\n\n${body}` }] }],
          max_output_tokens: 400,
          text: { format: { type: "json_schema", name: "reply_summary", schema: SUMMARY_SCHEMA, strict: false } }
        })
      });
      const responseText = await response.text();
      if (response.ok) {
        const outputText = readOpenAIOutputText(responseText);
        if (outputText) {
          const raw = JSON.parse(outputText.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")) as Record<string, unknown>;
          return {
            summary: String(raw.summary ?? "").trim() || summarizeHeuristic(body),
            suggestedReply: String(raw.suggested_reply ?? "").trim() || "Thanks for getting back to me — I'll follow up shortly."
          };
        }
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn("[email] OpenAI summary failed, using heuristic:", (error as Error).message);
    }
  }
  return { summary: summarizeHeuristic(body), suggestedReply: "Thanks for getting back to me — I'll follow up shortly." };
}

// ---------------------------------------------------------------------------
// Heuristic text helpers
// ---------------------------------------------------------------------------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

export function extractEmail(text: string): string | null {
  return text.match(EMAIL_RE)?.[0] ?? null;
}

function extractAddress(value: string): string {
  // Accepts "Name <a@b.com>" or "a@b.com".
  return extractEmail(value) ?? value.trim();
}

function extractRecipientName(prompt: string): string | null {
  const match = prompt.match(/\b(?:email|tell|ask|message|write to|reach out to|contact)\s+([A-Z][a-z]+)\b/);
  return match ? match[1]! : null;
}

function defaultSubject(prompt: string): string {
  const ask = prompt.match(/\b(?:ask|tell|let .* know|about|regarding|re:?)\s+(?:them\s+|him\s+|her\s+)?(?:if\s+|whether\s+|about\s+)?(.+)/i);
  const core = (ask?.[1] ?? prompt).replace(EMAIL_RE, "").replace(/[.?!]+$/, "").trim();
  const words = core.split(/\s+/).slice(0, 8).join(" ");
  const subject = words.charAt(0).toUpperCase() + words.slice(1);
  return subject.length > 4 ? subject : "Quick question";
}

function defaultBody(prompt: string, identity: AgentIdentity, recipientName: string | null): string {
  const ask = prompt
    .replace(EMAIL_RE, "")
    .replace(/\b(?:email|message|write to|reach out to|contact)\s+[A-Z][a-z]+\b/, "")
    .replace(/^\s*and\s+/i, "")
    .trim();
  const request = ask.charAt(0).toUpperCase() + ask.slice(1) || "I wanted to reach out.";
  const greeting = recipientName ? `Hi ${recipientName},` : "Hi,";
  return `${greeting}\n\n${request}\n\nBest,\n${identity.name}`;
}

function summarizeHeuristic(body: string): string {
  const firstLine = body.split(/\n+/).map((line) => line.trim()).find(Boolean) ?? "";
  const summary = firstLine.length > 160 ? `${firstLine.slice(0, 157)}...` : firstLine;
  return summary || "(empty reply)";
}

function stripHtml(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function readOpenAIOutputText(responseText: string): string {
  const response = JSON.parse(responseText) as { output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
  return (
    response.output
      ?.flatMap((item) => item.content ?? [])
      .filter((content): content is { type: string; text: string } => content.type === "output_text" && typeof content.text === "string")
      .map((content) => content.text)
      .join("") ?? ""
  );
}

// ---------------------------------------------------------------------------
// Routes — agent-facing (Bearer identity token)
// ---------------------------------------------------------------------------

export function registerEmailRoutes(app: FastifyInstance, config: AppConfig) {
  app.post("/api/tools/email/request", async (request, reply) => {
    const identity = readBearerIdentity(request);
    if (!identity) return reply.code(401).send({ error: "missing or invalid identity token" });
    const payload = requestSchema.parse(request.body ?? {});
    return runEmail(reply, async () => {
      const { message, parsed } = await sendEmailFromRequest(identity, payload, config);
      return reply.code(201).send({ ...serializeSend(message), parsed: parsed ? serializeParsed(parsed) : null });
    });
  });

  app.post("/api/tools/email/send", async (request, reply) => {
    const identity = readBearerIdentity(request);
    if (!identity) return reply.code(401).send({ error: "missing or invalid identity token" });
    const payload = sendSchema.parse(request.body ?? {});
    return runEmail(reply, async () => {
      const message = await sendEmail(identity, payload, config);
      return reply.code(201).send(serializeSend(message));
    });
  });

  app.post("/api/tools/email/pause", async (request, reply) => {
    const identity = readBearerIdentity(request);
    if (!identity) return reply.code(401).send({ error: "missing or invalid identity token" });
    return runEmail(reply, () => serializeIdentity(setEmailIdentityStatus(identity.id, "paused")));
  });

  app.post("/api/tools/email/resume", async (request, reply) => {
    const identity = readBearerIdentity(request);
    if (!identity) return reply.code(401).send({ error: "missing or invalid identity token" });
    return runEmail(reply, () => serializeIdentity(setEmailIdentityStatus(identity.id, "active")));
  });

  app.get("/api/identity/:agentId/email-activity", async (request, reply) => {
    const identity = readBearerIdentity(request);
    if (!identity) return reply.code(401).send({ error: "missing or invalid identity token" });
    const { agentId } = request.params as { agentId: string };
    if (identity.id !== agentId) return reply.code(403).send({ error: "identity token does not match requested agent" });
    return getEmailActivity(agentId);
  });

  // Inbound provider webhook (Resend). No Bearer token: verified by signature
  // when EMAIL_WEBHOOK_SECRET is configured. Always 200 so the provider does
  // not retry on unmatched recipients.
  app.post("/api/webhooks/email/inbound", async (request, reply) => {
    if (config.EMAIL_WEBHOOK_SECRET) {
      const provided = request.headers["x-webhook-secret"];
      if (provided !== config.EMAIL_WEBHOOK_SECRET) {
        return reply.code(401).send({ error: "invalid webhook signature" });
      }
    }
    const payload = inboundSchema.parse(unwrapInbound(request.body));
    const notification = await ingestInboundReply(payload, config);
    return reply.code(200).send({ ok: true, matched: Boolean(notification), notification: notification ? serializeNotification(notification) : null });
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runEmail(reply: FastifyReply, fn: () => unknown | Promise<unknown>) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof EmailError) {
      return reply.code(error.status).send({ error: error.message });
    }
    throw error;
  }
}

/** Mirrors identity.checkAction, plus the email-identity pause state. */
function requireSendableIdentity(identity: AgentIdentity, approved: boolean | undefined): EmailIdentity {
  if (identity.status !== "active") {
    throw new EmailError(403, "identity is revoked");
  }
  const emailIdentity = emailIdentityByAccount.get(identity.id);
  if (!emailIdentity) {
    throw new EmailError(409, "no email identity for this agent");
  }
  if (emailIdentity.status !== "active") {
    throw new EmailError(403, "email identity is paused");
  }
  if (!identity.permissions["email.send"]) {
    throw new EmailError(403, "permission denied: email.send");
  }
  if (identity.permissions.requiresHumanApproval && approved !== true) {
    throw new EmailError(403, "human approval is required for this action");
  }
  return emailIdentity;
}

function storeMessage(input: Omit<EmailMessage, "id" | "createdAt">): EmailMessage {
  const message: EmailMessage = { id: `emailmsg_${randomId(8)}`, createdAt: new Date(), ...input };
  const list = messagesByAccount.get(message.accountId) ?? [];
  list.unshift(message);
  messagesByAccount.set(message.accountId, list.slice(0, 200));
  if (message.providerMessageId) {
    messageByProviderId.set(message.providerMessageId, message);
  }
  return message;
}

function threadFor(accountId: string, counterparty: string): string {
  const key = `${accountId}:${counterparty.toLowerCase()}`;
  const existing = threadByCounterparty.get(key);
  if (existing) {
    return existing;
  }
  const threadId = newThread();
  threadByCounterparty.set(key, threadId);
  return threadId;
}

function newThread(): string {
  return `thread_${randomId(8)}`;
}

function formatFrom(identity: EmailIdentity): string {
  return `${identity.displayName} <${identity.emailAddress}>`;
}

/** Resend inbound webhooks wrap the email under { type, data: {...} }. */
function unwrapInbound(body: unknown): unknown {
  if (body && typeof body === "object" && "data" in body && (body as { data?: unknown }).data) {
    return (body as { data: unknown }).data;
  }
  return body;
}

function readBearerIdentity(request: FastifyRequest): AgentIdentity | null {
  const authorization = request.headers.authorization;
  if (!authorization) return null;
  const [scheme, token] = authorization.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  const identity = getAgentIdentityByToken(token.trim());
  if (!identity || identity.status !== "active") return null;
  return identity;
}

function serializeSend(message: EmailMessage) {
  return {
    ok: message.status === "sent",
    message_id: message.id,
    thread_id: message.threadId,
    provider_message_id: message.providerMessageId,
    from: message.fromEmail,
    to: message.toEmail,
    subject: message.subject,
    status: message.status
  };
}

function serializeParsed(parsed: GeneratedEmail) {
  return {
    to: parsed.to,
    recipient_name: parsed.recipientName,
    subject: parsed.subject,
    body: parsed.body,
    parsed_by: parsed.parsedBy
  };
}

function serializeMessage(message: EmailMessage) {
  return {
    id: message.id,
    thread_id: message.threadId,
    direction: message.direction,
    from_email: message.fromEmail,
    to_email: message.toEmail,
    subject: message.subject,
    body: message.body,
    provider_message_id: message.providerMessageId,
    status: message.status,
    parsed_by: message.parsedBy,
    created_at: message.createdAt.toISOString()
  };
}

function serializeNotification(notification: EmailReplyNotification) {
  return {
    id: notification.id,
    email_message_id: notification.emailMessageId,
    thread_id: notification.threadId,
    from_email: notification.fromEmail,
    subject: notification.subject,
    summary: notification.summary,
    suggested_reply: notification.suggestedReply,
    status: notification.status,
    created_at: notification.createdAt.toISOString()
  };
}

function serializeIdentity(identity: EmailIdentity) {
  return {
    email_identity_id: identity.id,
    email_address: identity.emailAddress,
    display_name: identity.displayName,
    provider: identity.provider,
    status: identity.status,
    created_at: identity.createdAt.toISOString()
  };
}

function randomId(byteLength: number): string {
  return crypto.randomBytes(byteLength).toString("base64url");
}
