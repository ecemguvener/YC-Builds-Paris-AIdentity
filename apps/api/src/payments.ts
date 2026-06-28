import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { Collections } from "./db.js";
import { requireAuth } from "./auth.js";
import { recordIdentityAudit, type AgentIdentity } from "./identity.js";
import { randomId, escapeRegExp } from "./shared/crypto.js";
import { readOpenAIOutputText, cleanJsonFences } from "./shared/openai-output.js";
import { parseObjectId, HttpToolError, runWithHttpToolError } from "./shared/http.js";
import { readActiveBearerIdentity } from "./shared/bearer-auth.js";

// ---------------------------------------------------------------------------
// Payment tool module
//
// A real-world payment capability for an agent identity. The store is keyed by
// an opaque account id so the same engine can serve two front doors:
//   - agent-facing routes, authenticated with a Bearer identity token
//     (account = the in-memory agent identity id)
//   - dashboard routes, authenticated with the owner's session, scoped per
//     agent identity (account = the site id the dashboard manages)
//
// The agent never sees card details. Purchases go: request → policy decision →
// (human) approve/reject → execute → transaction, all audited. The chatbot can
// also create requests via createPurchaseFromPrompt().
// ---------------------------------------------------------------------------

type Provider = "mock" | "stripe";
type PaymentIdentityStatus = "active" | "paused" | "disabled";
type PurchaseStatus = "pending" | "approved" | "requires_approval" | "rejected" | "payment_link_created" | "executed" | "failed";
type TransactionStatus = "payment_link_created" | "successful" | "declined" | "failed";

interface PaymentIdentity {
  id: string;
  accountId: string;
  provider: Provider;
  providerCardId: string;
  cardLast4: string;
  status: PaymentIdentityStatus;
  createdAt: Date;
}

interface PaymentPolicy {
  accountId: string;
  maxTransactionAmount: number;
  dailyLimit: number;
  monthlyLimit: number;
  approvalRequiredAbove: number;
  allowedMerchants: string[];
  blockedMerchants: string[];
  blockedCategories: string[];
  allowRecurring: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface PurchaseRequest {
  id: string;
  accountId: string;
  merchantName: string;
  merchantUrl: string | null;
  amount: number;
  currency: string;
  purpose: string;
  item: string | null;
  status: PurchaseStatus;
  decisionReason: string;
  priceEstimated: boolean;
  parsedBy: string | null;
  createdAt: Date;
}

interface Transaction {
  id: string;
  accountId: string;
  purchaseRequestId: string;
  provider: Provider;
  providerTransactionId: string;
  merchantName: string;
  amount: number;
  currency: string;
  status: TransactionStatus;
  decisionReason: string;
  paymentUrl: string | null;
  createdAt: Date;
}

const paymentIdentityByAccount = new Map<string, PaymentIdentity>();
const policyByAccount = new Map<string, PaymentPolicy>();
const requestsByAccount = new Map<string, PurchaseRequest[]>();
const requestById = new Map<string, PurchaseRequest>();
const transactionsByAccount = new Map<string, Transaction[]>();
const transactionByRequestId = new Map<string, Transaction>();
const idempotencyKeys = new Map<string, string>();

const DEFAULT_POLICY = {
  maxTransactionAmount: 100,
  dailyLimit: 200,
  monthlyLimit: 1000,
  approvalRequiredAbove: 25,
  allowedMerchants: [] as string[],
  blockedMerchants: ["CryptoExchange"],
  blockedCategories: ["gambling", "crypto"],
  allowRecurring: false
};

/** Error carrying an HTTP status so route handlers can translate cleanly. */
export class PaymentError extends HttpToolError {}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const requestPurchaseSchema = z.object({
  merchant_name: z.string().min(1).max(120),
  merchant_url: z.string().url().max(2048).optional(),
  amount: z.number().positive().max(1_000_000),
  currency: z.string().min(3).max(3).default("GBP"),
  purpose: z.string().min(1).max(300)
});

const requestPurchaseFromTextSchema = z.object({ prompt: z.string().min(1).max(500) });
const decisionSchema = z.object({ note: z.string().max(300).optional() });
const policySchema = z.object({
  max_transaction_amount: z.number().nonnegative().optional(),
  daily_limit: z.number().nonnegative().optional(),
  monthly_limit: z.number().nonnegative().optional(),
  approval_required_above: z.number().nonnegative().optional(),
  allowed_merchants: z.array(z.string().min(1)).optional(),
  blocked_merchants: z.array(z.string().min(1)).optional(),
  blocked_categories: z.array(z.string().min(1)).optional(),
  allow_recurring: z.boolean().optional()
});

// ---------------------------------------------------------------------------
// Provisioning + lookups
// ---------------------------------------------------------------------------

export function provisionPaymentIdentity(accountId: string, config?: AppConfig): PaymentIdentity {
  const existing = paymentIdentityByAccount.get(accountId);
  if (existing) {
    return existing;
  }
  const provider = resolvePaymentProvider(config);
  const card = provider === "stripe" ? stripeCreatePaymentLinkProvider() : mockCreateCard(accountId);
  const identity: PaymentIdentity = {
    id: `payid_${randomId(8)}`,
    accountId,
    provider,
    providerCardId: card.providerCardId,
    cardLast4: card.cardLast4,
    status: "active",
    createdAt: new Date()
  };
  paymentIdentityByAccount.set(accountId, identity);

  const now = new Date();
  policyByAccount.set(accountId, { accountId, ...DEFAULT_POLICY, createdAt: now, updatedAt: now });

  recordIdentityAudit(accountId, "payment.provision", "allowed", `${provider === "stripe" ? "Stripe payment links" : `Virtual card •••• ${identity.cardLast4}`} provisioned.`);
  return identity;
}

export function getPaymentIdentity(accountId: string): PaymentIdentity | null {
  return paymentIdentityByAccount.get(accountId) ?? null;
}

// ---------------------------------------------------------------------------
// Core operations (shared by bearer routes, site routes, and the chatbot)
// ---------------------------------------------------------------------------

export interface CreatePurchaseInput {
  merchantName: string;
  merchantUrl?: string | null;
  amount: number;
  currency: string;
  purpose: string;
  item?: string | null;
  priceEstimated?: boolean;
  parsedBy?: string | null;
}

export function createPurchaseRequest(accountId: string, input: CreatePurchaseInput): PurchaseRequest {
  const policy = policyByAccount.get(accountId) ?? null;
  const spendingToday = successfulSpendSince(accountId, startOfTodayUtc());
  const spendingMonth = successfulSpendSince(accountId, startOfMonthUtc());
  const decision = evaluatePurchaseRequest(
    { merchantName: input.merchantName, amount: input.amount },
    policy,
    spendingToday,
    spendingMonth
  );

  const purchase: PurchaseRequest = {
    id: `preq_${randomId(8)}`,
    accountId,
    merchantName: input.merchantName,
    merchantUrl: input.merchantUrl ?? null,
    amount: input.amount,
    currency: input.currency.toUpperCase(),
    purpose: input.purpose,
    item: input.item ?? null,
    status: decision.status,
    decisionReason: decision.reason,
    priceEstimated: input.priceEstimated ?? false,
    parsedBy: input.parsedBy ?? null,
    createdAt: new Date()
  };

  const list = requestsByAccount.get(accountId) ?? [];
  list.unshift(purchase);
  requestsByAccount.set(accountId, list.slice(0, 200));
  requestById.set(purchase.id, purchase);

  recordIdentityAudit(
    accountId,
    "payment.request",
    decision.status === "rejected" ? "blocked" : "allowed",
    `${decision.status} • ${input.merchantName} • ${formatAmount(input.amount, purchase.currency)} • ${decision.reason}`
  );
  return purchase;
}

export async function createPurchaseFromPrompt(
  accountId: string,
  prompt: string,
  config: AppConfig
): Promise<{ purchase: PurchaseRequest; parsed: ParsedPurchase }> {
  const parsed = await parsePurchaseFromText(prompt, accountId, config);
  if (!parsed.merchantName || parsed.merchantName === "Unknown merchant") {
    throw new PaymentError(
      422,
      `couldn't identify a merchant to pay in: "${prompt}". Try naming where to buy it (e.g. "from Amazon").`
    );
  }
  const purchase = createPurchaseRequest(accountId, {
    merchantName: parsed.merchantName,
    merchantUrl: parsed.merchantUrl,
    amount: parsed.amount,
    currency: parsed.currency,
    purpose: parsed.purpose,
    item: parsed.item,
    priceEstimated: parsed.priceEstimated,
    parsedBy: parsed.parsedBy
  });
  return { purchase, parsed };
}

export function decidePurchase(
  accountId: string,
  requestId: string,
  decision: "approved" | "rejected",
  note?: string
): PurchaseRequest {
  const purchase = requestById.get(requestId);
  if (!purchase || purchase.accountId !== accountId) {
    throw new PaymentError(404, "purchase request not found");
  }
  if (!["pending", "requires_approval"].includes(purchase.status)) {
    throw new PaymentError(409, `request is '${purchase.status}' and can no longer be decided`);
  }
  purchase.status = decision === "approved" ? "approved" : "rejected";
  purchase.decisionReason = `${decision === "approved" ? "Approved" : "Rejected"} by owner${note ? `: ${note}` : ""}`;
  recordIdentityAudit(accountId, `payment.${decision}`, decision === "approved" ? "allowed" : "blocked", purchase.decisionReason);
  return purchase;
}

export async function executeApprovedPurchase(
  accountId: string,
  requestId: string,
  config?: AppConfig,
  idempotencyKey?: string
): Promise<Transaction> {
  const purchase = requestById.get(requestId);
  if (!purchase || purchase.accountId !== accountId) {
    throw new PaymentError(404, "purchase request not found");
  }

  const key = idempotencyKey || `exec:${requestId}`;
  const existingTxnId = idempotencyKeys.get(key) ?? transactionByRequestId.get(requestId)?.id;
  if (existingTxnId) {
    const existingTxn = transactionsByAccount.get(accountId)?.find((txn) => txn.id === existingTxnId);
    if (existingTxn) {
      recordIdentityAudit(accountId, "payment.execute", "allowed", `Idempotent replay for ${requestId}.`);
      return existingTxn;
    }
  }

  if (purchase.status !== "approved") {
    recordIdentityAudit(accountId, "payment.execute", "blocked", `Request ${requestId} is ${purchase.status}, not approved.`);
    throw new PaymentError(409, "purchase request is not approved");
  }

  const paymentIdentity = paymentIdentityByAccount.get(accountId);
  if (!paymentIdentity || paymentIdentity.status !== "active") {
    throw new PaymentError(409, "no active payment identity");
  }

  const result = await createPaymentLink(paymentIdentity, purchase, config, key);
  const txn: Transaction = {
    id: `txn_${randomId(8)}`,
    accountId,
    purchaseRequestId: purchase.id,
    provider: paymentIdentity.provider,
    providerTransactionId: result.providerTransactionId,
    merchantName: purchase.merchantName,
    amount: purchase.amount,
    currency: purchase.currency,
    status: result.status,
    decisionReason: result.reason,
    paymentUrl: result.paymentUrl,
    createdAt: new Date()
  };
  const list = transactionsByAccount.get(accountId) ?? [];
  list.unshift(txn);
  transactionsByAccount.set(accountId, list.slice(0, 200));
  transactionByRequestId.set(txn.purchaseRequestId, txn);
  idempotencyKeys.set(key, txn.id);

  purchase.status = result.status === "payment_link_created" ? "payment_link_created" : result.status === "successful" ? "executed" : "failed";
  purchase.decisionReason = result.reason;
  recordIdentityAudit(
    accountId,
    "payment.execute",
    result.status === "payment_link_created" || result.status === "successful" ? "allowed" : "blocked",
    `${result.status} • ${purchase.merchantName} • ${formatAmount(purchase.amount, purchase.currency)}`
  );
  return txn;
}

export function updatePaymentPolicy(accountId: string, patch: z.infer<typeof policySchema>): PaymentPolicy {
  const existing = policyByAccount.get(accountId);
  const now = new Date();
  const policy: PaymentPolicy = {
    accountId,
    maxTransactionAmount: patch.max_transaction_amount ?? existing?.maxTransactionAmount ?? DEFAULT_POLICY.maxTransactionAmount,
    dailyLimit: patch.daily_limit ?? existing?.dailyLimit ?? DEFAULT_POLICY.dailyLimit,
    monthlyLimit: patch.monthly_limit ?? existing?.monthlyLimit ?? DEFAULT_POLICY.monthlyLimit,
    approvalRequiredAbove: patch.approval_required_above ?? existing?.approvalRequiredAbove ?? DEFAULT_POLICY.approvalRequiredAbove,
    allowedMerchants: patch.allowed_merchants ?? existing?.allowedMerchants ?? DEFAULT_POLICY.allowedMerchants,
    blockedMerchants: patch.blocked_merchants ?? existing?.blockedMerchants ?? DEFAULT_POLICY.blockedMerchants,
    blockedCategories: patch.blocked_categories ?? existing?.blockedCategories ?? DEFAULT_POLICY.blockedCategories,
    allowRecurring: patch.allow_recurring ?? existing?.allowRecurring ?? DEFAULT_POLICY.allowRecurring,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
  policyByAccount.set(accountId, policy);
  return policy;
}

export function getPaymentActivity(accountId: string) {
  const identity = paymentIdentityByAccount.get(accountId);
  const policy = policyByAccount.get(accountId);
  return {
    account_id: accountId,
    payment_identity: identity
      ? {
          payment_identity_id: identity.id,
          provider: identity.provider,
          card_last4: identity.cardLast4,
          status: identity.status,
          created_at: identity.createdAt.toISOString()
        }
      : null,
    policy: policy ? serializePolicy(policy) : null,
    purchase_requests: (requestsByAccount.get(accountId) ?? []).map(serializeRequest),
    transactions: (transactionsByAccount.get(accountId) ?? []).map(serializeTransaction)
  };
}

// ---------------------------------------------------------------------------
// Policy engine (pure)
// ---------------------------------------------------------------------------

export function evaluatePurchaseRequest(
  request: { merchantName: string; amount: number; category?: string; recurring?: boolean },
  policy: { maxTransactionAmount: number; dailyLimit: number; monthlyLimit: number; approvalRequiredAbove: number; allowedMerchants: string[]; blockedMerchants: string[]; blockedCategories: string[]; allowRecurring: boolean } | null,
  spendingToday: number,
  spendingMonth: number
): { status: PurchaseStatus; reason: string } {
  if (!policy) {
    return { status: "requires_approval", reason: "No payment policy configured" };
  }
  if (typeof request.amount !== "number" || Number.isNaN(request.amount) || request.amount <= 0) {
    return { status: "rejected", reason: "Invalid amount" };
  }
  if (request.amount > policy.maxTransactionAmount) {
    return { status: "rejected", reason: "Above max transaction amount" };
  }
  if (spendingToday + request.amount > policy.dailyLimit) {
    return { status: "rejected", reason: "Above daily spending limit" };
  }
  if (spendingMonth + request.amount > policy.monthlyLimit) {
    return { status: "rejected", reason: "Above monthly spending limit" };
  }
  if (policy.blockedMerchants.includes(request.merchantName)) {
    return { status: "rejected", reason: "Merchant is blocked" };
  }
  if (request.category && policy.blockedCategories.includes(request.category)) {
    return { status: "rejected", reason: "Category is blocked" };
  }
  if (request.recurring && !policy.allowRecurring) {
    return { status: "rejected", reason: "Recurring payments are not allowed" };
  }
  if (policy.allowedMerchants.length > 0 && !policy.allowedMerchants.includes(request.merchantName)) {
    return { status: "requires_approval", reason: "Merchant not on allowed list" };
  }
  if (request.amount > policy.approvalRequiredAbove) {
    return { status: "requires_approval", reason: "Amount requires human approval" };
  }
  return { status: "approved", reason: "Auto-approved by policy" };
}

// ---------------------------------------------------------------------------
// Payment providers — the agent never sees card details.
// ---------------------------------------------------------------------------

function resolvePaymentProvider(config?: AppConfig): Provider {
  return config?.PAYMENT_PROVIDER ?? (process.env.PAYMENT_PROVIDER === "stripe" ? "stripe" : "mock");
}

function mockCreateCard(accountId: string): { providerCardId: string; cardLast4: string } {
  return { providerCardId: `mock_card_${accountId}`, cardLast4: "4242" };
}

function stripeCreatePaymentLinkProvider(): { providerCardId: string; cardLast4: string } {
  return { providerCardId: "stripe_checkout", cardLast4: "link" };
}

async function createPaymentLink(
  paymentIdentity: PaymentIdentity,
  purchase: PurchaseRequest,
  config: AppConfig | undefined,
  idempotencyKey: string
): Promise<{ providerTransactionId: string; status: TransactionStatus; reason: string; paymentUrl: string | null }> {
  if (paymentIdentity.provider === "stripe") {
    return stripeCreateCheckoutSession(purchase, config, idempotencyKey);
  }

  return mockCreatePaymentLink({ merchantName: purchase.merchantName, amount: purchase.amount, currency: purchase.currency });
}

function mockCreatePaymentLink(input: { merchantName: string; amount: number; currency: string }): {
  providerTransactionId: string;
  status: TransactionStatus;
  reason: string;
  paymentUrl: string | null;
} {
  const providerTransactionId = `mock_txn_${randomId(8)}`;
  if (/_DECLINE$/i.test(input.merchantName)) {
    return { providerTransactionId, status: "declined", reason: `Mock decline for ${input.merchantName}`, paymentUrl: null };
  }
  if (/_FAIL$/i.test(input.merchantName)) {
    return { providerTransactionId, status: "failed", reason: `Mock provider error for ${input.merchantName}`, paymentUrl: null };
  }
  const paymentUrl = `https://pay.stripe.com/test/mock_${providerTransactionId}`;
  return {
    providerTransactionId,
    status: "payment_link_created",
    reason: `Mock payment link created for ${input.merchantName} at ${formatAmount(input.amount, input.currency)}`,
    paymentUrl
  };
}

async function stripeCreateCheckoutSession(
  purchase: PurchaseRequest,
  config: AppConfig | undefined,
  idempotencyKey: string
): Promise<{ providerTransactionId: string; status: TransactionStatus; reason: string; paymentUrl: string | null }> {
  const secretKey = config?.STRIPE_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new PaymentError(503, "Stripe is not configured. Set STRIPE_SECRET_KEY or use PAYMENT_PROVIDER=mock.");
  }

  const body = new URLSearchParams({
    mode: "payment",
    success_url: resolveStripeReturnUrl(config, "success", purchase.id),
    cancel_url: resolveStripeReturnUrl(config, "cancel", purchase.id),
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": purchase.currency.toLowerCase(),
    "line_items[0][price_data][unit_amount]": String(toStripeMinorUnits(purchase.amount, purchase.currency)),
    "line_items[0][price_data][product_data][name]": paymentLinkProductName(purchase),
    "line_items[0][price_data][product_data][description]": purchase.purpose,
    "metadata[account_id]": purchase.accountId,
    "metadata[purchase_request_id]": purchase.id,
    "metadata[merchant_name]": purchase.merchantName
  });

  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${secretKey}:`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
      "idempotency-key": idempotencyKey
    },
    body
  });

  const responseBody = await response.json().catch(() => ({})) as StripeCheckoutSessionResponse;
  if (!response.ok) {
    const message = responseBody.error?.message ?? `Stripe Checkout Session failed with HTTP ${response.status}`;
    throw new PaymentError(502, message);
  }

  const providerTransactionId = responseBody.id ?? `stripe_checkout_${randomId(8)}`;
  if (!responseBody.url) {
    throw new PaymentError(502, "Stripe did not return a payment link.");
  }

  return {
    providerTransactionId,
    status: "payment_link_created",
    reason: `Stripe payment link created for ${purchase.merchantName} at ${formatAmount(purchase.amount, purchase.currency)}`,
    paymentUrl: responseBody.url
  };
}

interface StripeCheckoutSessionResponse {
  id?: string;
  url?: string;
  error?: {
    message?: string;
  };
}

const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"
]);

function toStripeMinorUnits(amount: number, currency: string): number {
  const normalizedCurrency = currency.toUpperCase();
  const multiplier = ZERO_DECIMAL_CURRENCIES.has(normalizedCurrency) ? 1 : 100;
  return Math.round(amount * multiplier);
}

function paymentLinkProductName(purchase: PurchaseRequest): string {
  return purchase.item ? `${purchase.item} from ${purchase.merchantName}` : purchase.merchantName;
}

function resolveStripeReturnUrl(config: AppConfig | undefined, outcome: "success" | "cancel", requestId: string): string {
  const configured = outcome === "success" ? config?.STRIPE_SUCCESS_URL : config?.STRIPE_CANCEL_URL;
  if (configured) {
    return configured.replace("{REQUEST_ID}", requestId);
  }

  const appUrl = (config?.PUBLIC_APP_URL ?? process.env.PUBLIC_APP_URL ?? "http://localhost:5173").replace(/\/$/, "");
  const separator = appUrl.includes("?") ? "&" : "?";
  return `${appUrl}${separator}payment=${outcome}&request_id=${encodeURIComponent(requestId)}&session_id={CHECKOUT_SESSION_ID}`;
}

// ---------------------------------------------------------------------------
// Natural-language parsing: OpenAI Responses API → heuristic fallback
// ---------------------------------------------------------------------------

export interface ParsedPurchase {
  merchantName: string;
  item: string | null;
  merchantUrl: string | null;
  amount: number;
  currency: string;
  purpose: string;
  priceEstimated: boolean;
  parsedBy: "openai" | "heuristic";
}

const CANONICAL_MERCHANTS = ["Amazon", "OpenAI", "Google Cloud", "Google", "Spotify", "GitHub", "Apple", "Microsoft", "Netflix"];
const MERCHANT_HOMEPAGES: Record<string, string> = {
  openai: "https://openai.com",
  "google cloud": "https://cloud.google.com",
  google: "https://www.google.com",
  spotify: "https://www.spotify.com",
  github: "https://github.com",
  apple: "https://www.apple.com",
  microsoft: "https://www.microsoft.com",
  netflix: "https://www.netflix.com"
};
const CURRENCY_SYMBOLS: Record<string, string> = { "£": "GBP", $: "USD", "€": "EUR", "¥": "JPY" };
const CURRENCY_WORDS: Record<string, string> = {
  pounds: "GBP", pound: "GBP", quid: "GBP", gbp: "GBP", sterling: "GBP",
  dollars: "USD", dollar: "USD", usd: "USD", bucks: "USD",
  euros: "EUR", euro: "EUR", eur: "EUR", yen: "JPY", jpy: "JPY"
};
const PRICE_HINTS: Array<[RegExp, number]> = [
  [/\b(still |sparkling )?water\b/i, 4.99],
  [/\bcoffee|latte|espresso\b/i, 3.5],
  [/\b(api )?credits?\b/i, 20],
  [/\bgift ?card\b/i, 25],
  [/\bbook|paperback|hardback\b/i, 12.99],
  [/\bcable|charger|adapter|mouse|keyboard\b/i, 14.99],
  [/\bpen|notebook|stationery\b/i, 4.5],
  [/\bsubscription|plan|membership\b/i, 9.99],
  [/\bcompute|server|instance|hosting\b/i, 30]
];
const DEFAULT_PRICE = 9.99;

const PARSE_SCHEMA = {
  type: "object",
  properties: {
    merchant_name: { type: "string" },
    item: { type: "string" },
    merchant_url: { type: "string" },
    amount: { type: "number" },
    price_estimated: { type: "boolean" },
    currency: { type: "string" },
    purpose: { type: "string" }
  },
  required: ["merchant_name", "amount", "currency", "purpose"],
  additionalProperties: false
} as const;

export async function parsePurchaseFromText(prompt: string, accountId: string, config: AppConfig): Promise<ParsedPurchase> {
  if (config.OPENAI_API_KEY) {
    try {
      return await parseWithOpenAI(prompt, accountId, config);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn("[payments] OpenAI parse failed, using heuristic:", error instanceof Error ? error.message : String(error));
    }
  }
  return parseHeuristic(prompt, accountId);
}

async function parseWithOpenAI(prompt: string, accountId: string, config: AppConfig): Promise<ParsedPurchase> {
  const merchants = knownMerchants(accountId);
  const instructions =
    "Convert the user's spending instruction into a structured purchase request as JSON. " +
    "Infer currency from any symbol ($,£,€) or words; default to GBP. " +
    'If the user names a product but no price (e.g. "buy me still water from amazon"), estimate a realistic current retail price and set price_estimated=true. ' +
    "Always provide a real merchant_url: for Amazon use https://www.amazon.co.uk/s?k=<url-encoded item>; for known brands use their homepage. " +
    (merchants.length ? `Known merchants for this agent (prefer an exact match): ${merchants.join(", ")}.` : "");

  const model = process.env.OPENAI_PAYMENTS_MODEL || "gpt-4o-mini";
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model,
      instructions,
      input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
      max_output_tokens: 400,
      text: { format: { type: "json_schema", name: "purchase_request", schema: PARSE_SCHEMA, strict: false } }
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
  const raw = JSON.parse(cleanJsonFences(outputText)) as Record<string, unknown>;
  return finalize(raw, "openai", prompt);
}

function parseHeuristic(prompt: string, accountId: string): ParsedPurchase {
  let currency = "GBP";
  let amount: number | undefined;

  const sym = prompt.match(/([£$€¥])\s*([0-9]+(?:\.[0-9]{1,2})?)/);
  if (sym) {
    currency = CURRENCY_SYMBOLS[sym[1]!]!;
    amount = parseFloat(sym[2]!);
  } else {
    const numWord = prompt.match(/([0-9]+(?:\.[0-9]{1,2})?)\s*([A-Za-z]+)/);
    const wordNum = prompt.match(/\b([A-Za-z]+)\s*([0-9]+(?:\.[0-9]{1,2})?)/);
    if (numWord && CURRENCY_WORDS[numWord[2]!.toLowerCase()]) {
      amount = parseFloat(numWord[1]!);
      currency = CURRENCY_WORDS[numWord[2]!.toLowerCase()]!;
    } else if (wordNum && CURRENCY_WORDS[wordNum[1]!.toLowerCase()]) {
      currency = CURRENCY_WORDS[wordNum[1]!.toLowerCase()]!;
      amount = parseFloat(wordNum[2]!);
    } else {
      const bare = prompt.match(/([0-9]+(?:\.[0-9]{1,2})?)/);
      if (bare) amount = parseFloat(bare[1]!);
    }
  }

  let merchantName = findKnownMerchant(prompt, accountId);
  if (!merchantName) {
    const prep = prompt.match(/\b(?:from|at|to|on|with|via|of|for)\s+([A-Za-z][\w&.\-]+)/i);
    if (prep) {
      const tok = prep[1]!;
      merchantName = CANONICAL_MERCHANTS.find((c) => c.toLowerCase() === tok.toLowerCase()) ?? tok.charAt(0).toUpperCase() + tok.slice(1);
    }
  }
  if (!merchantName) {
    const stop = /^(Buy|Pay|Top|Get|Purchase|Order|Spend|Grab|Pick|The|For|And|Some|Still|Sparkling)$/;
    for (const match of prompt.matchAll(/\b([A-Z][a-z]*[A-Z][A-Za-z]*|[A-Z][A-Za-z]{2,})\b/g)) {
      if (!stop.test(match[1]!)) {
        merchantName = match[1]!;
        break;
      }
    }
  }

  let item: string | undefined;
  const itemMatch = prompt.match(/\b(?:buy|get|order|purchase|grab|pick up)\s+(?:me\s+)?(?:some\s+|a\s+|an\s+|the\s+)?(.+?)(?:\s+(?:from|at|on|for|via)\b|[.,!?]|$)/i);
  if (itemMatch) {
    const cleaned = itemMatch[1]!.replace(/[£$€¥]\s*[0-9]+(?:\.[0-9]{1,2})?/g, "").trim();
    if (cleaned) item = cleaned;
  }

  return finalize(
    { merchant_name: merchantName ?? "Unknown merchant", item, amount, currency, purpose: item ? `Buy ${item}` : prompt.trim() },
    "heuristic",
    prompt
  );
}

function finalize(raw: Record<string, unknown>, parsedBy: "openai" | "heuristic", original: string): ParsedPurchase {
  const merchantName = String(raw.merchant_name ?? "").trim() || "Unknown merchant";
  const item = raw.item ? String(raw.item).trim() : null;
  let amount = typeof raw.amount === "number" ? raw.amount : Number(raw.amount);
  let priceEstimated = Boolean(raw.price_estimated);
  if (amount == null || Number.isNaN(amount) || amount <= 0) {
    amount = estimatePrice(item ?? original);
    priceEstimated = true;
  }
  return {
    merchantName,
    item,
    merchantUrl: buildMerchantUrl(merchantName, item, typeof raw.merchant_url === "string" ? raw.merchant_url : null),
    amount: Math.round(amount * 100) / 100,
    currency: String(raw.currency ?? "GBP").toUpperCase().trim(),
    purpose: String(raw.purpose ?? (item ? `Buy ${item}` : original) ?? "").trim(),
    priceEstimated,
    parsedBy
  };
}

function estimatePrice(text: string): number {
  for (const [re, price] of PRICE_HINTS) {
    if (re.test(text)) return price;
  }
  return DEFAULT_PRICE;
}

function buildMerchantUrl(merchantName: string, item: string | null, fallback: string | null): string | null {
  const key = merchantName.trim().toLowerCase();
  if (/amazon/.test(key)) {
    const query = encodeURIComponent((item ?? merchantName).trim() || "shopping");
    return `https://www.amazon.co.uk/s?k=${query}`;
  }
  if (MERCHANT_HOMEPAGES[key]) return MERCHANT_HOMEPAGES[key]!;
  for (const [name, url] of Object.entries(MERCHANT_HOMEPAGES)) {
    if (key.includes(name)) return url;
  }
  return fallback ?? null;
}

function findKnownMerchant(text: string, accountId: string): string | null {
  const candidates = [...new Set([...knownMerchants(accountId), ...CANONICAL_MERCHANTS])].sort((a, b) => b.length - a.length);
  for (const candidate of candidates) {
    if (new RegExp(`\\b${escapeRegExp(candidate)}\\b`, "i").test(text)) return candidate;
  }
  return null;
}

function knownMerchants(accountId: string): string[] {
  const policy = policyByAccount.get(accountId);
  if (!policy) return [];
  return [...new Set([...policy.allowedMerchants, ...policy.blockedMerchants])];
}

// ---------------------------------------------------------------------------
// Routes — agent-facing (Bearer identity token)
// ---------------------------------------------------------------------------

export function registerPaymentRoutes(app: FastifyInstance, config: AppConfig) {
  app.post("/api/tools/payments/request-purchase", async (request, reply) => {
    const identity = readActiveBearerIdentity(request);
    if (!identity) return reply.code(401).send({ error: "missing or invalid identity token" });
    const payload = requestPurchaseSchema.parse(request.body ?? {});
    const purchase = createPurchaseRequest(identity.id, fromPayload(payload));
    return reply.code(201).send(serializeDecision(purchase));
  });

  app.post("/api/tools/payments/request-purchase-from-text", async (request, reply) => {
    const identity = readActiveBearerIdentity(request);
    if (!identity) return reply.code(401).send({ error: "missing or invalid identity token" });
    const { prompt } = requestPurchaseFromTextSchema.parse(request.body ?? {});
    return runWithHttpToolError(reply, async () => {
      const { purchase, parsed } = await createPurchaseFromPrompt(identity.id, prompt, config);
      return reply.code(201).send({ ...serializeDecision(purchase), parsed: serializeParsed(parsed) });
    });
  });

  app.post("/api/tools/payments/:requestId/approve", (request, reply) =>
    bearerDecide(request, reply, "approved")
  );
  app.post("/api/tools/payments/:requestId/reject", (request, reply) => bearerDecide(request, reply, "rejected"));

  app.post("/api/tools/payments/:requestId/execute", async (request, reply) => {
    const identity = readActiveBearerIdentity(request);
    if (!identity) return reply.code(401).send({ error: "missing or invalid identity token" });
    const { requestId } = request.params as { requestId: string };
    return runWithHttpToolError(reply, async () => {
      const txn = await executeApprovedPurchase(identity.id, requestId, config, readIdempotencyKey(request));
      return serializeTransaction(txn);
    });
  });

  app.patch("/api/tools/payments/policy", async (request, reply) => {
    const identity = readActiveBearerIdentity(request);
    if (!identity) return reply.code(401).send({ error: "missing or invalid identity token" });
    const patch = policySchema.parse(request.body ?? {});
    return serializePolicy(updatePaymentPolicy(identity.id, patch));
  });

  app.get("/api/identity/:agentId/payment-activity", async (request, reply) => {
    const identity = readActiveBearerIdentity(request);
    if (!identity) return reply.code(401).send({ error: "missing or invalid identity token" });
    const { agentId } = request.params as { agentId: string };
    if (identity.id !== agentId) return reply.code(403).send({ error: "identity token does not match requested agent" });
    return getPaymentActivity(agentId);
  });
}

function bearerDecide(request: FastifyRequest, reply: FastifyReply, decision: "approved" | "rejected") {
  const identity = readActiveBearerIdentity(request);
  if (!identity) return reply.code(401).send({ error: "missing or invalid identity token" });
  const { requestId } = request.params as { requestId: string };
  const { note } = decisionSchema.parse(request.body ?? {});
  return runWithHttpToolError(reply, () => serializeDecision(decidePurchase(identity.id, requestId, decision, note)));
}

// ---------------------------------------------------------------------------
// Routes — dashboard, per agent identity (session + ownership), scoped by site
// ---------------------------------------------------------------------------

export function registerSitePaymentRoutes(app: FastifyInstance, collections: Collections, config: AppConfig) {
  const resolveSiteAccount = async (request: FastifyRequest, reply: FastifyReply): Promise<string | null> => {
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
    provisionPaymentIdentity(accountId, config); // lazy: card + default policy on first touch
    return accountId;
  };

  app.get("/api/sites/:siteId/payment-activity", async (request, reply) => {
    const accountId = await resolveSiteAccount(request, reply);
    if (!accountId) return;
    return getPaymentActivity(accountId);
  });

  app.post("/api/sites/:siteId/payments/request-purchase", async (request, reply) => {
    const accountId = await resolveSiteAccount(request, reply);
    if (!accountId) return;
    const payload = requestPurchaseSchema.parse(request.body ?? {});
    return reply.code(201).send(serializeDecision(createPurchaseRequest(accountId, fromPayload(payload))));
  });

  app.post("/api/sites/:siteId/payments/request-purchase-from-text", async (request, reply) => {
    const accountId = await resolveSiteAccount(request, reply);
    if (!accountId) return;
    const { prompt } = requestPurchaseFromTextSchema.parse(request.body ?? {});
    return runWithHttpToolError(reply, async () => {
      const { purchase, parsed } = await createPurchaseFromPrompt(accountId, prompt, config);
      return reply.code(201).send({ ...serializeDecision(purchase), parsed: serializeParsed(parsed) });
    });
  });

  app.post("/api/sites/:siteId/payments/:requestId/approve", async (request, reply) => {
    const accountId = await resolveSiteAccount(request, reply);
    if (!accountId) return;
    const { requestId } = request.params as { requestId: string };
    const { note } = decisionSchema.parse(request.body ?? {});
    return runWithHttpToolError(reply, () => serializeDecision(decidePurchase(accountId, requestId, "approved", note)));
  });

  app.post("/api/sites/:siteId/payments/:requestId/reject", async (request, reply) => {
    const accountId = await resolveSiteAccount(request, reply);
    if (!accountId) return;
    const { requestId } = request.params as { requestId: string };
    const { note } = decisionSchema.parse(request.body ?? {});
    return runWithHttpToolError(reply, () => serializeDecision(decidePurchase(accountId, requestId, "rejected", note)));
  });

  app.post("/api/sites/:siteId/payments/:requestId/execute", async (request, reply) => {
    const accountId = await resolveSiteAccount(request, reply);
    if (!accountId) return;
    const { requestId } = request.params as { requestId: string };
    return runWithHttpToolError(reply, async () =>
      serializeTransaction(await executeApprovedPurchase(accountId, requestId, config, readIdempotencyKey(request)))
    );
  });

  app.patch("/api/sites/:siteId/payments/policy", async (request, reply) => {
    const accountId = await resolveSiteAccount(request, reply);
    if (!accountId) return;
    const patch = policySchema.parse(request.body ?? {});
    return serializePolicy(updatePaymentPolicy(accountId, patch));
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fromPayload(payload: z.infer<typeof requestPurchaseSchema>): CreatePurchaseInput {
  return {
    merchantName: payload.merchant_name,
    merchantUrl: payload.merchant_url ?? null,
    amount: payload.amount,
    currency: payload.currency,
    purpose: payload.purpose
  };
}

function serializeDecision(purchase: PurchaseRequest) {
  return { request_id: purchase.id, status: purchase.status, decision_reason: purchase.decisionReason };
}

function serializeParsed(parsed: ParsedPurchase) {
  return {
    merchant_name: parsed.merchantName,
    item: parsed.item,
    merchant_url: parsed.merchantUrl,
    amount: parsed.amount,
    currency: parsed.currency,
    price_estimated: parsed.priceEstimated,
    purpose: parsed.purpose,
    parsed_by: parsed.parsedBy
  };
}

function serializeRequest(purchase: PurchaseRequest) {
  return {
    id: purchase.id,
    merchant_name: purchase.merchantName,
    merchant_url: purchase.merchantUrl,
    amount: purchase.amount,
    currency: purchase.currency,
    purpose: purchase.purpose,
    item: purchase.item,
    status: purchase.status,
    decision_reason: purchase.decisionReason,
    price_estimated: purchase.priceEstimated,
    parsed_by: purchase.parsedBy,
    created_at: purchase.createdAt.toISOString()
  };
}

function serializeTransaction(txn: Transaction) {
  return {
    transaction_id: txn.id,
    purchase_request_id: txn.purchaseRequestId,
    provider: txn.provider,
    provider_transaction_id: txn.providerTransactionId,
    payment_url: txn.paymentUrl,
    merchant_name: txn.merchantName,
    amount: txn.amount,
    currency: txn.currency,
    status: txn.status,
    decision_reason: txn.decisionReason,
    created_at: txn.createdAt.toISOString()
  };
}

function serializePolicy(policy: PaymentPolicy) {
  return {
    max_transaction_amount: policy.maxTransactionAmount,
    daily_limit: policy.dailyLimit,
    monthly_limit: policy.monthlyLimit,
    approval_required_above: policy.approvalRequiredAbove,
    allowed_merchants: policy.allowedMerchants,
    blocked_merchants: policy.blockedMerchants,
    blocked_categories: policy.blockedCategories,
    allow_recurring: policy.allowRecurring,
    created_at: policy.createdAt.toISOString(),
    updated_at: policy.updatedAt.toISOString()
  };
}

function readIdempotencyKey(request: FastifyRequest): string | undefined {
  const header = request.headers["idempotency-key"];
  return typeof header === "string" && header.trim() ? header.trim() : undefined;
}

function successfulSpendSince(accountId: string, since: Date): number {
  return (transactionsByAccount.get(accountId) ?? [])
    .filter((txn) => txn.status === "successful" && txn.createdAt >= since)
    .reduce((total, txn) => total + txn.amount, 0);
}

function startOfTodayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function startOfMonthUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function formatAmount(amount: number, currency: string): string {
  const symbol = currency === "GBP" ? "£" : currency === "USD" ? "$" : currency === "EUR" ? "€" : "";
  return symbol ? `${symbol}${amount.toFixed(2)}` : `${amount.toFixed(2)} ${currency}`;
}

export function formatPurchaseAmount(amount: number, currency: string): string {
  return formatAmount(amount, currency);
}
