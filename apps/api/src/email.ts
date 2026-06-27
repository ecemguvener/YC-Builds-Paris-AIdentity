import crypto from "node:crypto";
import { ObjectId } from "mongodb";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { Collections } from "./db.js";
import { requireAuth } from "./auth.js";
import { getAgentIdentityByToken, recordIdentityAudit, type AgentIdentity } from "./identity.js";

// ---------------------------------------------------------------------------
// Email Capability Add-on
//
// A plug-in communication layer that lets an existing agent identity send and
// receive *real* email as a personal assistant. The existing agent is the
// brain; this exposes tools it calls.
//
// Like payments, the store is keyed by an opaque account id so one engine
// serves two front doors:
//   - agent-facing routes, authenticated with a Bearer identity token
//     (account = the in-memory agent identity id)
//   - dashboard routes, authenticated with the owner's session, scoped per
//     agent identity (account = the site id the dashboard manages)
//
// Provider: Resend when RESEND_API_KEY is set, otherwise a mock sender (logs +
// synthetic id) so the whole request -> send -> reply flow is demoable without
// a verified sending domain.
// ---------------------------------------------------------------------------

type Provider = "resend" | "mock";
type EmailIdentityStatus = "active" | "paused";
type Direction = "outbound" | "inbound";
type MessageStatus = "sent" | "failed" | "received";
type NotificationStatus = "unread" | "read";

interface EmailIdentity {
  id: string;
  accountId: string;
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

// ---------------------------------------------------------------------------
// Provisioning + lookups
// ---------------------------------------------------------------------------

/**
 * Attach an email identity to an account. The identity layer passes the address
 * it already minted; the dashboard path mints one via ensureSiteEmailIdentity.
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

/** Lazy provisioning for dashboard-scoped accounts (mints an address). */
export function ensureSiteEmailIdentity(accountId: string, displayName: string, config: AppConfig): EmailIdentity {
  const existing = emailIdentityByAccount.get(accountId);
  if (existing) {
    return existing;
  }
  const address = `${slugify(displayName)}-${randomId(4)}@${config.EMAIL_FROM_DOMAIN}`;
  return provisionEmailIdentity(accountId, address, displayName, config);
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
// Core send (shared by every front door) — no permission gating here; callers
// gate as appropriate (bearer routes via requireSendableIdentity, dashboard
// routes implicitly via the owner's session).
// ---------------------------------------------------------------------------

export interface SendResult {
  message: EmailMessage;
  parsed?: GeneratedEmail;
}

async function performSend(
  emailIdentity: EmailIdentity,
  input: { to: string; subject: string; body: string },
  config: AppConfig,
  parsed?: GeneratedEmail
): Promise<EmailMessage> {
  const accountId = emailIdentity.accountId;
  const threadId = threadFor(accountId, input.to);
  const from = formatFrom(emailIdentity);

  try {
    const result = await dispatchSend(config, { from, to: input.to, subject: input.subject, text: input.body });
    const message = storeMessage({
      accountId,
      threadId,
      direction: "outbound",
      fromEmail: emailIdentity.emailAddress,
      toEmail: input.to,
      subject: input.subject,
      body: input.body,
      providerMessageId: result.providerMessageId,
      status: "sent",
      parsedBy: parsed?.parsedBy ?? null
    });
    recordIdentityAudit(accountId, "email.send", "allowed", `Email sent to ${input.to}: ${input.subject}`);
    return message;
  } catch (error) {
    storeMessage({
      accountId,
      threadId,
      direction: "outbound",
      fromEmail: emailIdentity.emailAddress,
      toEmail: input.to,
      subject: input.subject,
      body: input.body,
      providerMessageId: null,
      status: "failed",
      parsedBy: parsed?.parsedBy ?? null
    });
    recordIdentityAudit(accountId, "email.send", "blocked", `Send to ${input.to} failed: ${(error as Error).message}`);
    throw error instanceof EmailError ? error : new EmailError(502, `email provider error: ${(error as Error).message}`);
  }
}

// --- Agent-facing (Bearer identity token) ----------------------------------

export async function sendEmail(
  identity: AgentIdentity,
  input: { to: string; subject: string; body: string; approved?: boolean },
  config: AppConfig
): Promise<EmailMessage> {
  const emailIdentity = requireSendableIdentity(identity, input.approved);
  return performSend(emailIdentity, input, config);
}

export async function sendEmailFromRequest(
  identity: AgentIdentity,
  input: { request: string; to?: string; approved?: boolean },
  config: AppConfig
): Promise<SendResult> {
  const emailIdentity = requireSendableIdentity(identity, input.approved);
  const generated = await draftEmail(input.request, emailIdentity.displayName, config);
  const to = input.to ?? generated.to ?? undefined;
  if (!to) {
    throw new EmailError(
      422,
      `couldn't find a recipient email in: "${input.request}". Ask the user for the recipient's email address, then pass it as "to".`
    );
  }
  const message = await performSend(emailIdentity, { to, subject: generated.subject, body: generated.body }, config, generated);
  return { message, parsed: { ...generated, to } };
}

// --- Dashboard-facing (session, owner is the human approver) ----------------

export async function sendSiteEmailFromText(accountId: string, displayName: string, prompt: string, config: AppConfig, to?: string): Promise<SendResult> {
  const emailIdentity = ensureSiteEmailIdentity(accountId, displayName, config);
  if (emailIdentity.status !== "active") {
    throw new EmailError(403, "email identity is paused");
  }
  const generated = await draftEmail(prompt, emailIdentity.displayName, config);
  const recipient = to ?? generated.to ?? undefined;
  if (!recipient) {
    throw new EmailError(422, `couldn't find a recipient email in: "${prompt}". Add the recipient's email address.`);
  }
  const message = await performSend(emailIdentity, { to: recipient, subject: generated.subject, body: generated.body }, config, generated);
  return { message, parsed: { ...generated, to: recipient } };
}

export async function sendSiteEmail(accountId: string, displayName: string, input: { to: string; subject: string; body: string }, config: AppConfig): Promise<EmailMessage> {
  const emailIdentity = ensureSiteEmailIdentity(accountId, displayName, config);
  if (emailIdentity.status !== "active") {
    throw new EmailError(403, "email identity is paused");
  }
  return performSend(emailIdentity, input, config);
}

export function getEmailActivity(accountId: string) {
  const identity = emailIdentityByAccount.get(accountId);
  return {
    account_id: accountId,
    email_identity: identity ? serializeIdentity(identity) : null,
    messages: (messagesByAccount.get(accountId) ?? []).map(serializeMessage),
    reply_notifications: (notificationsByAccount.get(accountId) ?? []).map(serializeNotification)
  };
}

/**
 * Ingest an inbound reply: match it to the right agent + thread, store it,
 * summarize it, and raise a reply notification the hub can surface.
 */
export async function ingestInboundReply(normalized: NormalizedInbound, config: AppConfig): Promise<EmailReplyNotification | null> {
  const accountId = normalized.toCandidates.map((address) => accountByAddress.get(address.toLowerCase())).find(Boolean);
  if (!accountId) {
    return null; // not addressed to any known agent identity
  }
  const sender = normalized.from;
  const subject = normalized.subject || "(no subject)";
  const body = normalized.text.trim();

  const parent = normalized.inReplyTo ? messageByProviderId.get(normalized.inReplyTo) : undefined;
  const threadId = parent?.threadId ?? threadByCounterparty.get(`${accountId}:${sender.toLowerCase()}`) ?? newThread();
  threadByCounterparty.set(`${accountId}:${sender.toLowerCase()}`, threadId);

  const recipient = normalized.toCandidates.find((address) => accountByAddress.get(address.toLowerCase()) === accountId) ?? normalized.toCandidates[0]!;
  const message = storeMessage({
    accountId,
    threadId,
    direction: "inbound",
    fromEmail: sender,
    toEmail: recipient,
    subject,
    body,
    providerMessageId: normalized.messageId,
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

export async function draftEmail(prompt: string, senderName: string, config: AppConfig): Promise<GeneratedEmail> {
  if (config.OPENAI_API_KEY) {
    try {
      return await draftWithOpenAI(prompt, senderName, config);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn("[email] OpenAI draft failed, using heuristic:", (error as Error).message);
    }
  }
  return draftHeuristic(prompt, senderName);
}

async function draftWithOpenAI(prompt: string, senderName: string, config: AppConfig): Promise<GeneratedEmail> {
  const instructions =
    "You draft a short, professional email on behalf of an AI assistant. " +
    `The sender is "${senderName}", an assistant. ` +
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
    body: String(raw.body ?? "").trim() || defaultBody(prompt, senderName, null),
    parsedBy: "openai"
  };
}

function draftHeuristic(prompt: string, senderName: string): GeneratedEmail {
  const to = extractEmail(prompt);
  const recipientName = extractRecipientName(prompt);
  return {
    to,
    recipientName,
    subject: defaultSubject(prompt),
    body: defaultBody(prompt, senderName, recipientName),
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

function defaultBody(prompt: string, senderName: string, recipientName: string | null): string {
  const ask = prompt
    .replace(EMAIL_RE, "")
    .replace(/\b(?:email|message|write to|reach out to|contact)\s+[A-Z][a-z]+\b/, "")
    .replace(/^\s*and\s+/i, "")
    .trim();
  const request = ask.charAt(0).toUpperCase() + ask.slice(1) || "I wanted to reach out.";
  const greeting = recipientName ? `Hi ${recipientName},` : "Hi,";
  return `${greeting}\n\n${request}\n\nBest,\n${senderName}`;
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
// Inbound payload normalization — tolerant of Resend/SES inbound shapes.
// ---------------------------------------------------------------------------

export interface NormalizedInbound {
  from: string;
  toCandidates: string[];
  subject: string;
  text: string;
  inReplyTo: string | null;
  messageId: string | null;
}

export function normalizeInbound(body: unknown): NormalizedInbound {
  const data = unwrapData(body);
  const headers = readHeaders(data.headers);
  const from = firstAddress(data.from) ?? "";
  const toCandidates = collectAddresses(data.to);
  const text = typeof data.text === "string" && data.text ? data.text : stripHtml(typeof data.html === "string" ? data.html : "");
  return {
    from,
    toCandidates,
    subject: typeof data.subject === "string" ? data.subject.trim() : "",
    text,
    inReplyTo: asString(data.in_reply_to) ?? headers["in-reply-to"] ?? null,
    messageId: asString(data.message_id) ?? headers["message-id"] ?? null
  };
}

function unwrapData(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (record.data && typeof record.data === "object") {
      return record.data as Record<string, unknown>;
    }
    return record;
  }
  return {};
}

function readHeaders(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (entry && typeof entry === "object") {
        const name = asString((entry as Record<string, unknown>).name);
        const headerValue = asString((entry as Record<string, unknown>).value);
        if (name && headerValue) out[name.toLowerCase()] = headerValue;
      }
    }
  } else if (value && typeof value === "object") {
    for (const [name, headerValue] of Object.entries(value as Record<string, unknown>)) {
      const stringValue = asString(headerValue);
      if (stringValue) out[name.toLowerCase()] = stringValue;
    }
  }
  return out;
}

function collectAddresses(value: unknown): string[] {
  const items = Array.isArray(value) ? value : [value];
  return items.map(firstAddress).filter((address): address is string => Boolean(address));
}

function firstAddress(value: unknown): string | null {
  if (typeof value === "string") {
    return extractEmail(value) ?? (value.includes("@") ? value.trim() : null);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const candidate = asString(record.address) ?? asString(record.email);
    if (candidate) return extractEmail(candidate) ?? candidate;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// ---------------------------------------------------------------------------
// Resend webhook signature verification (Svix). The signing secret looks like
// `whsec_<base64>`. When EMAIL_WEBHOOK_SECRET is a plain string instead, a
// simple X-Webhook-Secret header check is used (handy for local testing).
// ---------------------------------------------------------------------------

export function verifyResendSignature(secret: string, headers: Record<string, unknown>, rawBody: string): boolean {
  const id = asString(headers["svix-id"]);
  const timestamp = asString(headers["svix-timestamp"]);
  const signatureHeader = asString(headers["svix-signature"]);
  if (!id || !timestamp || !signatureHeader) {
    return false;
  }
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds) || Math.abs(Date.now() / 1000 - timestampSeconds) > 300) {
    return false; // reject stale/replayed deliveries (5 minute tolerance)
  }
  const key = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  let secretBytes: Buffer;
  try {
    secretBytes = Buffer.from(key, "base64");
  } catch {
    return false;
  }
  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const expected = crypto.createHmac("sha256", secretBytes).update(signedContent).digest("base64");
  return signatureHeader.split(" ").some((part) => {
    const commaIndex = part.indexOf(",");
    const value = commaIndex === -1 ? part : part.slice(commaIndex + 1);
    return timingSafeEqualStrings(value, expected);
  });
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const aBytes = Buffer.from(a);
  const bBytes = Buffer.from(b);
  if (aBytes.length !== bBytes.length) {
    return false;
  }
  return crypto.timingSafeEqual(aBytes, bBytes);
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
    return runEmail(reply, async () => reply.code(201).send(serializeSend(await sendEmail(identity, payload, config))));
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

  // Inbound provider webhook (Resend). No Bearer token — verified by the Svix
  // signature when EMAIL_WEBHOOK_SECRET is configured. Always 200 so the
  // provider does not retry on unmatched recipients.
  app.post("/api/webhooks/email/inbound", async (request, reply) => {
    const secret = config.EMAIL_WEBHOOK_SECRET;
    if (secret) {
      const rawBody = (request as { rawBody?: string }).rawBody ?? JSON.stringify(request.body ?? {});
      const ok = secret.startsWith("whsec_")
        ? verifyResendSignature(secret, request.headers as Record<string, unknown>, rawBody)
        : request.headers["x-webhook-secret"] === secret;
      if (!ok) {
        return reply.code(401).send({ error: "invalid webhook signature" });
      }
    }
    const notification = await ingestInboundReply(normalizeInbound(request.body), config);
    return reply.code(200).send({ ok: true, matched: Boolean(notification), notification: notification ? serializeNotification(notification) : null });
  });
}

// ---------------------------------------------------------------------------
// Routes — dashboard, per agent identity (session + ownership), scoped by site
// ---------------------------------------------------------------------------

export function registerSiteEmailRoutes(app: FastifyInstance, collections: Collections, config: AppConfig) {
  const resolveSite = async (request: FastifyRequest, reply: FastifyReply): Promise<{ accountId: string; name: string } | null> => {
    const authContext = await requireAuth(request, reply, collections, config);
    if (!authContext) return null;
    const siteId = parseObjectId((request.params as { siteId: string }).siteId);
    if (!siteId) {
      reply.code(404).send({ error: "agent identity not found" });
      return null;
    }
    const site = await collections.sites.findOne({ _id: siteId, ownerUserId: authContext.user._id });
    if (!site) {
      reply.code(404).send({ error: "agent identity not found" });
      return null;
    }
    const accountId = site._id.toHexString();
    ensureSiteEmailIdentity(accountId, site.name || "Assistant", config); // lazy provision on first touch
    return { accountId, name: site.name || "Assistant" };
  };

  app.get("/api/sites/:siteId/email-activity", async (request, reply) => {
    const site = await resolveSite(request, reply);
    if (!site) return;
    return getEmailActivity(site.accountId);
  });

  app.post("/api/sites/:siteId/email/request", async (request, reply) => {
    const site = await resolveSite(request, reply);
    if (!site) return;
    const payload = requestSchema.parse(request.body ?? {});
    return runEmail(reply, async () => {
      const { message, parsed } = await sendSiteEmailFromText(site.accountId, site.name, payload.request, config, payload.to);
      return reply.code(201).send({ ...serializeSend(message), parsed: parsed ? serializeParsed(parsed) : null });
    });
  });

  app.post("/api/sites/:siteId/email/send", async (request, reply) => {
    const site = await resolveSite(request, reply);
    if (!site) return;
    const payload = sendSchema.parse(request.body ?? {});
    return runEmail(reply, async () => reply.code(201).send(serializeSend(await sendSiteEmail(site.accountId, site.name, payload, config))));
  });

  app.post("/api/sites/:siteId/email/pause", async (request, reply) => {
    const site = await resolveSite(request, reply);
    if (!site) return;
    return runEmail(reply, () => serializeIdentity(setEmailIdentityStatus(site.accountId, "paused")));
  });

  app.post("/api/sites/:siteId/email/resume", async (request, reply) => {
    const site = await resolveSite(request, reply);
    if (!site) return;
    return runEmail(reply, () => serializeIdentity(setEmailIdentityStatus(site.accountId, "active")));
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

function parseObjectId(value: string): ObjectId | null {
  return ObjectId.isValid(value) ? new ObjectId(value) : null;
}

function slugify(value: string): string {
  const slug = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "assistant";
}

function randomId(byteLength: number): string {
  return crypto.randomBytes(byteLength).toString("base64url");
}
