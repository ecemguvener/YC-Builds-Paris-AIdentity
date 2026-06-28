import crypto from "node:crypto";
import { ObjectId } from "mongodb";
import { loadConfig } from "./config.js";
import { connectDatabase } from "./db.js";
import type { ApiKeyDocument, AtlasProjectDocument, InteractionLogDocument, SiteDocument, UserDocument } from "./db.js";
import { hashApiKey, hashPassword } from "./security.js";

const demoEmail = normalizeDemoEmail(process.env.DEMO_EMAIL ?? "demo@aidentity.test");
const demoPassword = process.env.DEMO_PASSWORD ?? "demo-password";
const demoDisplayName = process.env.DEMO_NAME ?? "Maya Chen";
const demoHash = crypto.createHash("sha256").update(demoEmail).digest("hex").slice(0, 8);

const demoIdentities = [
  {
    slug: "ava-concierge",
    name: "Ava Concierge",
    domain: "ava-concierge.managed-openclaw.aidentity.dev",
    previewImage: "site-preview-dashboard",
    chatTheme: "light" as const,
    createdDaysAgo: 14,
    keyNames: ["Production OpenClaw link", "Demo operator token"],
    origins: ["dashboard.chat", "phone.booking", "email.assistant", "payments.policy"]
  },
  {
    slug: "nova-ops",
    name: "Nova Ops Runner",
    domain: "nova-ops.openclaw-demo.internal",
    previewImage: "site-preview-blue-flow",
    chatTheme: "dark" as const,
    createdDaysAgo: 8,
    keyNames: ["Managed OpenClaw link"],
    origins: ["dashboard.chat", "calendar.booking", "email.followup"]
  },
  {
    slug: "penny-finance",
    name: "Penny Finance Scout",
    domain: "penny-finance.managed-openclaw.aidentity.dev",
    previewImage: "site-preview-lime-blue",
    chatTheme: "system" as const,
    createdDaysAgo: 3,
    keyNames: ["Finance sandbox token"],
    origins: ["dashboard.chat", "payments.purchase", "payments.approval"]
  }
];

const config = loadConfig();
const database = await connectDatabase(config);

try {
  const user = await upsertDemoUser();
  await resetDemoData(user._id);
  const sites = await seedDemoIdentities(user._id);
  await seedInteractionLogs(sites);
  await seedLiveToolActivity(sites);

  console.log("Demo account ready.");
  console.log(`Email: ${demoEmail}`);
  console.log(`Password: ${demoPassword}`);
  console.log(`Agent identities: ${sites.map((site) => site.name).join(", ")}`);
  console.log(`Dashboard: ${config.PUBLIC_APP_URL}`);
} finally {
  await database.client.close();
}

async function upsertDemoUser(): Promise<UserDocument> {
  const existingUser = await database.collections.users.findOne({ email: demoEmail });
  const now = new Date();
  const passwordHash = await hashPassword(demoPassword);
  const profile = {
    displayName: demoDisplayName,
    avatarUrl: null,
    notificationPreferences: {
      productEmails: true,
      identityEmails: true,
      securityEmails: true
    },
    passwordHash,
    updatedAt: now
  };

  if (existingUser) {
    await database.collections.users.updateOne({ _id: existingUser._id }, { $set: profile });
    return { ...existingUser, ...profile };
  }

  const user: UserDocument = {
    _id: new ObjectId(),
    email: demoEmail,
    ...profile,
    createdAt: daysAgo(21)
  } as UserDocument;
  await database.collections.users.insertOne(user);
  return user;
}

async function resetDemoData(ownerUserId: ObjectId) {
  const existingSites = await database.collections.sites
    .find({ ownerUserId }, { projection: { _id: 1 } })
    .toArray();
  const siteIds = existingSites.map((site) => site._id);

  await Promise.all([
    database.collections.apiKeys.deleteMany({ userId: ownerUserId }),
    database.collections.atlasProjects.deleteMany({ ownerUserId }),
    siteIds.length > 0
      ? database.collections.interactionLogs.deleteMany({ siteId: { $in: siteIds } })
      : Promise.resolve(),
    database.collections.sites.deleteMany({ ownerUserId })
  ]);
}

async function seedDemoIdentities(ownerUserId: ObjectId): Promise<SiteDocument[]> {
  const sites: SiteDocument[] = [];

  for (const identity of demoIdentities) {
    const siteId = new ObjectId();
    const projectId = `proj_demo_${demoHash}_${identity.slug.replace(/-/g, "_")}`;
    const createdAt = daysAgo(identity.createdDaysAgo);
    const updatedAt = hoursAgo(identity.createdDaysAgo * 5);
    const site: SiteDocument = {
      _id: siteId,
      ownerUserId,
      name: identity.name,
      domain: identity.domain,
      publicSiteKey: `site_demo_${demoHash}_${identity.slug.replace(/-/g, "_")}`,
      previewImage: identity.previewImage,
      chatTheme: identity.chatTheme,
      interactionEngine: "openclaw",
      createdAt,
      updatedAt
    } as SiteDocument;
    const project: AtlasProjectDocument = {
      _id: new ObjectId(),
      ownerUserId,
      siteId,
      projectId,
      name: identity.name,
      pendingSiteDomain: identity.domain,
      createdAt,
      updatedAt
    } as AtlasProjectDocument;
    const apiKeys = identity.keyNames.map((keyName, index) => {
      const secret = `ck_demo_${demoHash}_${identity.slug}_${index + 1}_local_only`;
      return {
        _id: new ObjectId(),
        userId: ownerUserId,
        siteId,
        projectId,
        keyHash: hashApiKey(secret),
        prefix: secret.slice(0, 10),
        name: keyName,
        createdAt: hoursAgo(60 - index * 9),
        lastUsedAt: index === 0 ? hoursAgo(2 + index) : undefined
      } as ApiKeyDocument;
    });

    await database.collections.sites.insertOne(site);
    await database.collections.atlasProjects.insertOne(project);
    await database.collections.apiKeys.insertMany(apiKeys);
    sites.push(site);
  }

  return sites;
}

async function seedInteractionLogs(sites: SiteDocument[]) {
  const logs: InteractionLogDocument[] = sites.flatMap((site, siteIndex) => {
    const identity = demoIdentities[siteIndex];
    return Array.from({ length: siteIndex === 0 ? 12 : 8 }, (_, index) => {
      const isError = index === 5 && siteIndex === 1;
      return {
        _id: new ObjectId(),
        siteId: site._id,
        origin: identity.origins[index % identity.origins.length] ?? "dashboard.chat",
        status: isError ? "error" : "ok",
        durationMs: isError ? 1830 : 220 + ((siteIndex + 1) * 90) + index * 31,
        error: isError ? "Calendar provider returned a temporary conflict; retried successfully." : undefined,
        createdAt: hoursAgo(siteIndex * 9 + index + 1)
      } as InteractionLogDocument;
    });
  });

  if (logs.length > 0) {
    await database.collections.interactionLogs.insertMany(logs);
  }
}

async function seedLiveToolActivity(sites: SiteDocument[]) {
  const apiBaseUrl = config.PUBLIC_API_URL.replace(/\/$/, "");
  const healthResponse = await fetchJson(`${apiBaseUrl}/api/health`, { method: "GET" }).catch(() => null);
  if (!healthResponse?.ok) {
    console.log(`Live email/payment activity skipped because ${apiBaseUrl} is not running.`);
    return;
  }

  const loginResponse = await fetch(`${apiBaseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: demoEmail, password: demoPassword }),
    signal: AbortSignal.timeout(1500)
  });
  if (!loginResponse.ok) {
    console.log("Live email/payment activity skipped because demo login failed.");
    return;
  }

  const cookie = readSessionCookie(loginResponse);
  if (!cookie) {
    console.log("Live email/payment activity skipped because no session cookie was returned.");
    return;
  }

  const primarySite = sites[0];
  const financeSite = sites[2];
  if (primarySite) {
    await seedSiteEmailActivity(apiBaseUrl, cookie, primarySite);
    await seedSitePaymentActivity(apiBaseUrl, cookie, primarySite, [
      {
        merchant_name: "Uber",
        merchant_url: "https://www.uber.com",
        amount: 18.5,
        currency: "GBP",
        purpose: "Client transfer after appointment confirmation"
      },
      {
        merchant_name: "The Breakfast Club",
        merchant_url: "https://thebreakfastclubcafes.com",
        amount: 42,
        currency: "GBP",
        purpose: "Team brunch reservation deposit"
      }
    ]);
  }

  if (financeSite) {
    await seedSitePaymentActivity(apiBaseUrl, cookie, financeSite, [
      {
        merchant_name: "Notion",
        merchant_url: "https://www.notion.so",
        amount: 96,
        currency: "GBP",
        purpose: "Quarterly workspace seats for the ops team"
      },
      {
        merchant_name: "CryptoExchange",
        merchant_url: "https://example.com/crypto",
        amount: 50,
        currency: "GBP",
        purpose: "Blocked crypto purchase demo"
      }
    ]);
  }
}

async function seedSiteEmailActivity(apiBaseUrl: string, cookie: string, site: SiteDocument) {
  const activity = await fetchJson(`${apiBaseUrl}/api/sites/${String(site._id)}/email-activity`, {
    method: "GET",
    headers: { cookie }
  }).catch(() => null);
  if (Array.isArray(activity?.messages) && activity.messages.length > 0) {
    return;
  }

  await fetchJson(`${apiBaseUrl}/api/sites/${String(site._id)}/email/send`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie
    },
    body: JSON.stringify({
      to: "camille@atelierdemo.test",
      subject: "Appointment confirmed for tomorrow",
      body:
        "Hi Camille,\n\nAva confirmed the 11:30 appointment for tomorrow and noted the client's preference for a quiet chair near the window.\n\nBest,\nAva",
      approved: true
    })
  }).catch(() => null);
}

async function seedSitePaymentActivity(
  apiBaseUrl: string,
  cookie: string,
  site: SiteDocument,
  purchases: Array<{ merchant_name: string; merchant_url: string; amount: number; currency: string; purpose: string }>
) {
  const activity = await fetchJson(`${apiBaseUrl}/api/sites/${String(site._id)}/payment-activity`, {
    method: "GET",
    headers: { cookie }
  }).catch(() => null);
  if (Array.isArray(activity?.purchase_requests) && activity.purchase_requests.length > 0) {
    return;
  }

  for (const purchase of purchases) {
    const created = await fetchJson(`${apiBaseUrl}/api/sites/${String(site._id)}/payments/request-purchase`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie
      },
      body: JSON.stringify(purchase)
    }).catch(() => null);

    if (created?.status === "approved" && typeof created.request_id === "string") {
      await fetchJson(`${apiBaseUrl}/api/sites/${String(site._id)}/payments/${created.request_id}/execute`, {
        method: "POST",
        headers: {
          "idempotency-key": `demo-${demoHash}-${created.request_id}`,
          cookie
        }
      }).catch(() => null);
    }
  }
}

async function fetchJson(url: string, init: RequestInit): Promise<Record<string, unknown> | null> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(1500)
  });
  if (!response.ok) {
    return null;
  }

  return await response.json() as Record<string, unknown>;
}

function readSessionCookie(response: Response): string | null {
  const setCookie = response.headers.get("set-cookie");
  const sessionCookie = setCookie?.split(",", 1)[0]?.split(";", 1)[0]?.trim();
  return sessionCookie || null;
}

function normalizeDemoEmail(email: string): string {
  return email.trim().toLowerCase();
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}
