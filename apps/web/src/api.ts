export interface User {
  id: string;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
  notificationPreferences: UserNotificationPreferences;
  createdAt: string;
}

export interface UserNotificationPreferences {
  productEmails: boolean;
  identityEmails: boolean;
  securityEmails: boolean;
}

export interface Site {
  id: string;
  name: string;
  domain: string;
  publicSiteKey: string;
  previewImage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SiteApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface SiteDetailResponse {
  site: Site;
  apiKeys: SiteApiKey[];
}

export interface SiteSetup {
  projectId: string;
  name: string;
  domain: string;
  createdAt: string;
  updatedAt: string;
}

export interface SiteSetupResponse {
  setup: SiteSetup;
  apiKey: SiteApiKey;
  secret: string;
}

export interface SiteSetupState {
  setup: SiteSetup;
  apiKeys: SiteApiKey[];
}

export interface DashboardChatMessageInput {
  role: "user" | "assistant";
  content: string;
}

export type DashboardChatStreamEvent =
  | { type: "ready"; model?: string }
  | { type: "delta"; text: string }
  | { type: "call_started"; call: DashboardChatCallEmbed }
  | { type: "call_completed"; call: DashboardChatCallEmbed }
  | { type: "done" }
  | { type: "error"; error: string };

export interface DashboardChatCallTranscriptTurn {
  role: string;
  message: string;
  timeInCallSecs: number | null;
}

export interface DashboardChatCallEmbed {
  callId: string;
  toNumber: string;
  recipientName: string;
  agentIdentityName: string;
  task: string;
  status: string;
  simulated: boolean;
  durationSecs?: number | null;
  transcript?: DashboardChatCallTranscriptTurn[];
}

const configuredApiBaseUrl = import.meta.env.VITE_API_URL || "";
const configuredApiPort = import.meta.env.VITE_API_PORT || "";
const fallbackApiPort = "4001";
const localHostnames = new Set(["localhost", "127.0.0.1", "::1"]);

function resolveApiBaseUrl(configuredUrl: string): string {
  if (typeof window === "undefined") {
    return stripTrailingSlash(configuredUrl);
  }

  if (!configuredUrl) {
    return localHostnames.has(window.location.hostname)
      ? ""
      : `${window.location.protocol}//${window.location.hostname}:${configuredApiPort || fallbackApiPort}`;
  }

  try {
    const apiUrl = new URL(configuredUrl);
    if (localHostnames.has(apiUrl.hostname)) {
      if (!localHostnames.has(window.location.hostname)) {
        apiUrl.hostname = window.location.hostname;
      }
      if (configuredApiPort) {
        apiUrl.port = configuredApiPort;
      }
      return apiUrl.toString().replace(/\/$/, "");
    }
  } catch {
    return stripTrailingSlash(configuredUrl);
  }

  return stripTrailingSlash(configuredUrl);
}

const apiBaseUrl = resolveApiBaseUrl(configuredApiBaseUrl);
const forcedLogoutStorageKey = "aidentity:forced-logout";

type ApiRequestOptions = RequestInit & {
  apiBaseUrlOverride?: string;
};

export class ApiHttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ApiHttpError";
  }
}

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const { apiBaseUrlOverride, ...requestOptions } = options;
  const requestBaseUrl = apiBaseUrlOverride ?? apiBaseUrl;
  const headers = new Headers(requestOptions.headers);

  if (requestOptions.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(`${requestBaseUrl}${path}`, {
    credentials: "include",
    headers,
    ...requestOptions
  });

  if (!response.ok) {
    const text = await response.text();
    throw new ApiHttpError(parseApiError(text, getHttpErrorFallback(response)), response.status);
  }

  return (await response.json()) as T;
}

async function apiRequestWithBaseUrlFallback<T>(
  path: string,
  options: ApiRequestOptions,
  candidateBaseUrls: string[]
): Promise<T> {
  let lastError: unknown = null;

  for (const candidateBaseUrl of candidateBaseUrls) {
    try {
      return await apiRequest<T>(path, {
        ...options,
        apiBaseUrlOverride: candidateBaseUrl
      });
    } catch (error) {
      if (error instanceof ApiHttpError) {
        throw error;
      }

      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("request failed");
}

export const api = {
  hasForcedLogout: () => localStorage.getItem(forcedLogoutStorageKey) === "true",
  markForcedLogout: () => localStorage.setItem(forcedLogoutStorageKey, "true"),
  clearForcedLogout: () => localStorage.removeItem(forcedLogoutStorageKey),
  me: () => apiRequest<{ user: User }>("/api/auth/me"),
  updateProfile: (updates: { displayName?: string; email?: string; avatarUrl?: string | null }) =>
    apiRequest<{ user: User }>("/api/auth/me", {
      method: "PATCH",
      body: JSON.stringify(updates)
    }),
  updateNotificationPreferences: (preferences: UserNotificationPreferences) =>
    apiRequest<{ user: User }>("/api/auth/me/notifications", {
      method: "PATCH",
      body: JSON.stringify(preferences)
    }),
  updatePassword: (currentPassword: string, newPassword: string) =>
    apiRequest<{ ok: boolean }>("/api/auth/me/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword })
    }),
  checkEmail: (email: string) =>
    apiRequestWithBaseUrlFallback<{ exists: boolean }>(
      "/api/auth/check-email",
      {
        method: "POST",
        body: JSON.stringify({ email })
      },
      getEmailLookupBaseUrlCandidates()
    ),
  signup: (email: string, password: string) =>
    apiRequest<{ user: User }>("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email, password })
    }),
  login: (email: string, password: string) =>
    apiRequest<{ user: User }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password })
    }),
  logout: async () => {
    const candidateBaseUrls = getLogoutBaseUrlCandidates();
    let lastError: unknown = null;
    let didLogout = false;

    for (const candidateBaseUrl of candidateBaseUrls) {
      try {
        await apiRequest<{ ok: boolean }>("/api/auth/logout", {
          method: "POST",
          apiBaseUrlOverride: candidateBaseUrl
        });
        didLogout = true;
      } catch (error) {
        lastError = error;
      }
    }

    if (didLogout) {
      return { ok: true };
    }

    throw lastError instanceof Error ? lastError : new Error("logout failed");
  },
  listSites: () => apiRequest<{ sites: Site[] }>("/api/sites"),
  createSiteSetup: (name: string, domain: string) =>
    apiRequest<SiteSetupResponse>("/api/site-setups", {
      method: "POST",
      body: JSON.stringify({ name, domain })
    }),
  getSiteSetup: (projectId: string) => apiRequest<SiteSetupState>(`/api/site-setups/${projectId}`),
  completeSiteSetup: (projectId: string) =>
    apiRequest<SiteDetailResponse>(`/api/site-setups/${projectId}/complete`, {
      method: "POST"
  }),
  getSite: (siteId: string) => apiRequest<SiteDetailResponse>(`/api/sites/${siteId}`),
  updateSite: (siteId: string, updates: { name?: string; domain?: string }) =>
    apiRequest<{ site: Site }>(`/api/sites/${siteId}`, {
      method: "PATCH",
      body: JSON.stringify(updates)
    }),
  deleteSite: (siteId: string) =>
    apiRequest<{ ok: boolean }>(`/api/sites/${siteId}`, {
      method: "DELETE"
    }),
  createSiteApiKey: (siteId: string) =>
    apiRequest<{ apiKey: SiteApiKey; secret: string }>(`/api/sites/${siteId}/api-keys`, {
      method: "POST",
      body: JSON.stringify({ name: "CLI key" })
    }),
  deleteSiteApiKey: (siteId: string, apiKeyId: string) =>
    apiRequest<{ ok: boolean }>(`/api/sites/${siteId}/api-keys/${apiKeyId}`, {
      method: "DELETE"
    }),
  sendDashboardChatMessage: (messages: DashboardChatMessageInput[], onEvent: (event: DashboardChatStreamEvent) => void) =>
    streamDashboardChatMessage(messages, onEvent),

  // --- Payment tool (per agent identity / site, authenticated by the session) ---
  getSitePaymentActivity: (siteId: string) =>
    apiRequest<PaymentActivity>(`/api/sites/${siteId}/payment-activity`),
  siteRequestPurchaseFromText: (siteId: string, prompt: string) =>
    apiRequest<PurchaseDecision & { parsed: ParsedPurchase }>(`/api/sites/${siteId}/payments/request-purchase-from-text`, {
      method: "POST",
      body: JSON.stringify({ prompt })
    }),
  siteRequestPurchase: (siteId: string, input: PurchaseInput) =>
    apiRequest<PurchaseDecision>(`/api/sites/${siteId}/payments/request-purchase`, {
      method: "POST",
      body: JSON.stringify(input)
    }),
  siteApprovePurchase: (siteId: string, requestId: string, note?: string) =>
    apiRequest<PurchaseDecision>(`/api/sites/${siteId}/payments/${requestId}/approve`, {
      method: "POST",
      body: JSON.stringify(note ? { note } : {})
    }),
  siteRejectPurchase: (siteId: string, requestId: string, note?: string) =>
    apiRequest<PurchaseDecision>(`/api/sites/${siteId}/payments/${requestId}/reject`, {
      method: "POST",
      body: JSON.stringify(note ? { note } : {})
    }),
  siteExecutePurchase: (siteId: string, requestId: string) =>
    apiRequest<PaymentTransaction>(`/api/sites/${siteId}/payments/${requestId}/execute`, {
      method: "POST",
      headers: { "idempotency-key": `ui:${requestId}` }
    }),

  // --- Email tool (per agent identity / site, authenticated by the session) ---
  getSiteEmailActivity: (siteId: string) =>
    apiRequest<EmailActivity>(`/api/sites/${siteId}/email-activity`),
  siteRequestEmailFromText: (siteId: string, request: string, to?: string) =>
    apiRequest<EmailSendResult & { parsed: ParsedEmail | null }>(`/api/sites/${siteId}/email/request`, {
      method: "POST",
      body: JSON.stringify(to ? { request, to } : { request })
    }),
  siteSendEmail: (siteId: string, input: EmailSendInput) =>
    apiRequest<EmailSendResult>(`/api/sites/${siteId}/email/send`, {
      method: "POST",
      body: JSON.stringify(input)
    }),
  sitePauseEmail: (siteId: string) =>
    apiRequest<EmailIdentityView>(`/api/sites/${siteId}/email/pause`, { method: "POST" }),
  siteResumeEmail: (siteId: string) =>
    apiRequest<EmailIdentityView>(`/api/sites/${siteId}/email/resume`, { method: "POST" })
};

export type PurchaseStatus = "pending" | "approved" | "requires_approval" | "rejected" | "executed" | "failed";

export interface PurchaseDecision {
  request_id: string;
  status: PurchaseStatus;
  decision_reason: string;
}

export interface ParsedPurchase {
  merchant_name: string;
  item: string | null;
  merchant_url: string | null;
  amount: number;
  currency: string;
  price_estimated: boolean;
  purpose: string;
  parsed_by: "openai" | "heuristic";
}

export interface PurchaseInput {
  merchant_name: string;
  merchant_url?: string;
  amount: number;
  currency: string;
  purpose: string;
}

export interface PaymentPolicyView {
  max_transaction_amount: number;
  daily_limit: number;
  monthly_limit: number;
  approval_required_above: number;
  allowed_merchants: string[];
  blocked_merchants: string[];
  blocked_categories: string[];
  allow_recurring: boolean;
}

export interface PaymentRequestView {
  id: string;
  merchant_name: string;
  merchant_url: string | null;
  amount: number;
  currency: string;
  purpose: string;
  item: string | null;
  status: PurchaseStatus;
  decision_reason: string;
  price_estimated: boolean;
  parsed_by: string | null;
  created_at: string;
}

export interface PaymentTransaction {
  transaction_id: string;
  purchase_request_id: string;
  provider: string;
  provider_transaction_id: string;
  merchant_name: string;
  amount: number;
  currency: string;
  status: "successful" | "declined" | "failed";
  decision_reason: string;
  created_at: string;
}

export interface PaymentActivity {
  account_id: string;
  payment_identity: { payment_identity_id: string; provider: string; card_last4: string; status: string; created_at: string } | null;
  policy: PaymentPolicyView | null;
  purchase_requests: PaymentRequestView[];
  transactions: PaymentTransaction[];
}

export interface EmailIdentityView {
  email_identity_id: string;
  email_address: string;
  display_name: string;
  provider: string;
  status: "active" | "paused";
  created_at: string;
}

export interface ParsedEmail {
  to: string | null;
  recipient_name: string | null;
  subject: string;
  body: string;
  parsed_by: "openai" | "heuristic";
}

export interface EmailSendInput {
  to: string;
  subject: string;
  body: string;
}

export interface EmailSendResult {
  ok: boolean;
  message_id: string;
  thread_id: string;
  provider_message_id: string | null;
  from: string;
  to: string;
  subject: string;
  status: "sent" | "failed" | "received";
}

export interface EmailMessageView {
  id: string;
  thread_id: string;
  direction: "outbound" | "inbound";
  from_email: string;
  to_email: string;
  subject: string;
  body: string;
  provider_message_id: string | null;
  status: "sent" | "failed" | "received";
  parsed_by: string | null;
  created_at: string;
}

export interface EmailReplyNotificationView {
  id: string;
  email_message_id: string;
  thread_id: string;
  from_email: string;
  subject: string;
  summary: string;
  suggested_reply: string;
  status: "unread" | "read";
  created_at: string;
}

export interface EmailActivity {
  account_id: string;
  email_identity: EmailIdentityView | null;
  messages: EmailMessageView[];
  reply_notifications: EmailReplyNotificationView[];
}

async function streamDashboardChatMessage(
  messages: DashboardChatMessageInput[],
  onEvent: (event: DashboardChatStreamEvent) => void
): Promise<void> {
  const response = await fetch(`${apiBaseUrl}/api/dashboard/chat`, {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ messages })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(parseApiError(text, getHttpErrorFallback(response)));
  }

  if (!response.body) {
    throw new Error("Chat stream is unavailable");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const eventBlocks = buffer.split(/\n\n/);
    buffer = eventBlocks.pop() ?? "";

    for (const eventBlock of eventBlocks) {
      const event = parseDashboardChatStreamEvent(eventBlock);
      if (!event) {
        continue;
      }

      onEvent(event);
      if (event.type === "error") {
        throw new Error(event.error);
      }
    }

    if (done) {
      break;
    }
  }

  const finalEvent = parseDashboardChatStreamEvent(`${buffer}\n\n`);
  if (finalEvent) {
    onEvent(finalEvent);
    if (finalEvent.type === "error") {
      throw new Error(finalEvent.error);
    }
  }
}

function parseDashboardChatStreamEvent(block: string): DashboardChatStreamEvent | null {
  const dataLine = block
    .split(/\n/)
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);

  if (!dataLine) {
    return null;
  }

  const data = JSON.parse(dataLine) as Record<string, unknown>;
  if (data.type === "ready") {
    return { type: "ready", ...(typeof data.model === "string" ? { model: data.model } : {}) };
  }
  if (data.type === "delta" && typeof data.text === "string") {
    return { type: "delta", text: data.text };
  }
  if (data.type === "call_started" && isDashboardChatCallEmbed(data.call)) {
    return { type: "call_started", call: data.call };
  }
  if (data.type === "call_completed" && isDashboardChatCallEmbed(data.call)) {
    return { type: "call_completed", call: data.call };
  }
  if (data.type === "done") {
    return { type: "done" };
  }
  if (data.type === "error") {
    return { type: "error", error: typeof data.error === "string" ? data.error : "Chat response failed" };
  }

  return null;
}

function isDashboardChatCallEmbed(value: unknown): value is DashboardChatCallEmbed {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const call = value as DashboardChatCallEmbed;
  const transcript = call.transcript;
  return (
    typeof call.callId === "string" &&
    typeof call.toNumber === "string" &&
    typeof call.recipientName === "string" &&
    typeof call.agentIdentityName === "string" &&
    typeof call.task === "string" &&
    typeof call.status === "string" &&
    typeof call.simulated === "boolean" &&
    (transcript === undefined || transcript.every(isDashboardChatCallTranscriptTurn))
  );
}

function isDashboardChatCallTranscriptTurn(value: unknown): value is DashboardChatCallTranscriptTurn {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const turn = value as DashboardChatCallTranscriptTurn;
  return (
    typeof turn.role === "string" &&
    typeof turn.message === "string" &&
    (typeof turn.timeInCallSecs === "number" || turn.timeInCallSecs === null)
  );
}

function parseApiError(text: string, fallback = "request failed"): string {
  try {
    const parsed = JSON.parse(text) as {
      error?: string;
      message?: string;
      details?: {
        fieldErrors?: Record<string, string[] | undefined>;
        formErrors?: string[];
      };
    };
    const fieldError = Object.values(parsed.details?.fieldErrors ?? {})
      .flatMap((messages) => messages ?? [])
      .find((message) => message.trim());
    const formError = parsed.details?.formErrors?.find((message) => message.trim());

    return fieldError || formError || parsed.message || parsed.error || fallback;
  } catch {
    return fallback;
  }
}

function getHttpErrorFallback(response: Response): string {
  const statusText = response.statusText.trim();
  return statusText ? `${response.status} ${statusText}` : "request failed";
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/$/, "");
}

function getLogoutBaseUrlCandidates(): string[] {
  const candidates = [apiBaseUrl, ""];

  if (typeof window !== "undefined" && !localHostnames.has(window.location.hostname)) {
    const currentApiPort = new URL(apiBaseUrl).port || configuredApiPort || fallbackApiPort;
    candidates.push(`${window.location.protocol}//${window.location.hostname}:${currentApiPort}`);
    candidates.push(`${window.location.protocol}//${window.location.hostname}:${fallbackApiPort}`);
  }

  return [...new Set(candidates.map(stripTrailingSlash))];
}

function getEmailLookupBaseUrlCandidates(): string[] {
  const candidates = [apiBaseUrl, ""];

  if (typeof window !== "undefined" && !localHostnames.has(window.location.hostname)) {
    candidates.push(`${window.location.protocol}//${window.location.hostname}:${fallbackApiPort}`);
  }

  return [...new Set(candidates.map(stripTrailingSlash))];
}
