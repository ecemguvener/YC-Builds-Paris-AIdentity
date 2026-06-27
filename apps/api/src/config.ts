import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv({ path: path.resolve(process.cwd(), ".env") });
loadDotenv({ path: path.resolve(process.cwd(), "../../.env") });

const optionalNonEmptyStringSchema = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }

  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}, z.string().min(1).optional());

const environmentSchema = z.object({
  NODE_ENV: z.string().default("development"),
  API_PORT: z.coerce.number().default(4000),
  PUBLIC_APP_URL: z.string().url().default("http://localhost:5173"),
  PUBLIC_API_URL: z.string().url().default("http://localhost:4000"),
  MONGODB_URI: z.string().min(1).default("mongodb://127.0.0.1:27017/barkan"),
  SESSION_COOKIE_NAME: z.string().min(1).default("barkan_session"),
  SESSION_SECRET: z.string().min(16).default("dev-barkan-session-secret-change-me"),
  ELEVENLABS_API_KEY: optionalNonEmptyStringSchema,
  ELEVENLABS_AGENT_ID: optionalNonEmptyStringSchema,
  ELEVENLABS_AGENT_PHONE_NUMBER_ID: optionalNonEmptyStringSchema,
  ELEVENLABS_VOICE_ID: z.string().min(1).default("kPzsL2i3teMYv0FxEYQ6"),
  OPENAI_API_KEY: optionalNonEmptyStringSchema,
  OPENAI_WIDGET_MODEL: z.string().min(1).default("gpt-5.4-2026-03-05").transform(normalizeConfiguredOpenAIWidgetModel),
  OPENAI_ACTION_MODEL: z.string().min(1).default("gpt-5.4-2026-03-05").transform(normalizeConfiguredOpenAIModel),
  OPENAI_ATLAS_MODEL: z.string().min(1).default("gpt-5.4-2026-03-05").transform(normalizeConfiguredOpenAIModel),
  OPENAI_DASHBOARD_CHAT_MODEL: z.string().min(1).default("gpt-5.4-2026-03-05").transform(normalizeConfiguredOpenAIModel),
  // Email capability add-on. When RESEND_API_KEY is unset the capability runs in
  // mock mode (it logs the message and returns a synthetic id) so the full flow
  // is demoable without a verified sending domain.
  RESEND_API_KEY: optionalNonEmptyStringSchema,
  EMAIL_FROM_DOMAIN: z.string().min(1).default("aidentity.space"),
  EMAIL_WEBHOOK_SECRET: optionalNonEmptyStringSchema,
  // Sandbox redirect: before a sending domain is verified, Resend only allows
  // sending from onboarding@resend.dev to the account owner. When this is set,
  // every outbound email is really delivered to this address (from Resend's
  // test sender), so the app sends real mail you can see. The activity log
  // still records the originally-intended recipient.
  EMAIL_SANDBOX_REDIRECT_TO: optionalNonEmptyStringSchema
}).transform((environment) => {
  return {
    ...environment,
    MONGODB_URI: normalizeMongoUriForEnvironment(
      normalizeLegacyMongoDatabaseName(environment.MONGODB_URI),
      environment.NODE_ENV
    ),
    PUBLIC_API_URL: normalizePublicApiUrlForEnvironment(environment.PUBLIC_API_URL, environment.NODE_ENV)
  };
});

export type AppConfig = z.infer<typeof environmentSchema>;

export function loadConfig(): AppConfig {
  return environmentSchema.parse(process.env);
}

function normalizeConfiguredOpenAIModel(model: string): string {
  const normalized = model.trim();
  if (/^gpt-5\.4-mini$/i.test(normalized)) {
    return "gpt-5.4-mini-2026-03-17";
  }

  if (/^gpt-5\.4-mini-\d{4}-\d{2}-\d{2}$/i.test(normalized) && normalized !== "gpt-5.4-mini-2026-03-17") {
    return "gpt-5.4-2026-03-05";
  }

  return normalized;
}

function normalizeConfiguredOpenAIWidgetModel(_model: string): string {
  return "gpt-5.4-2026-03-05";
}

function normalizePublicApiUrlForEnvironment(publicApiUrl: string, nodeEnv: string): string {
  const normalizedUrl = publicApiUrl.trim().replace(/\/$/, "");
  if (nodeEnv !== "production") {
    return normalizedUrl;
  }

  const parsedUrl = new URL(normalizedUrl);
  if (parsedUrl.protocol === "https:" || isLoopbackHostname(parsedUrl.hostname)) {
    return normalizedUrl;
  }

  throw new Error("PUBLIC_API_URL must use HTTPS in production unless it points to localhost.");
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function normalizeMongoUriForEnvironment(mongodbUri: string, nodeEnv: string): string {
  const mongodbUriWithDefaultDatabase = ensureMongoDatabaseName(mongodbUri, "barkan");
  if (nodeEnv !== "production") {
    return mongodbUriWithDefaultDatabase;
  }

  return ensureProductionMongoDatabaseName(mongodbUriWithDefaultDatabase);
}

function normalizeLegacyMongoDatabaseName(mongodbUri: string): string {
  return replaceMongoDatabaseName(mongodbUri, (databaseName) => {
    if (databaseName === "barkan-web") {
      return "barkan";
    }

    if (databaseName === "barkan-web-prod") {
      return "barkan-prod";
    }

    return databaseName;
  });
}

function ensureProductionMongoDatabaseName(mongodbUri: string): string {
  const defaultDatabaseName = "barkan-prod";

  try {
    const parsedUri = new URL(mongodbUri);
    const databaseName = parsedUri.pathname.replace(/^\/+/, "");
    if (!databaseName) {
      parsedUri.pathname = `/${defaultDatabaseName}`;
      return parsedUri.toString();
    }

    if (databaseName.endsWith("-prod")) {
      return mongodbUri;
    }

    parsedUri.pathname = `/${databaseName}-prod`;
    return parsedUri.toString();
  } catch {
    const queryIndex = mongodbUri.indexOf("?");
    const uriWithoutQuery = queryIndex === -1 ? mongodbUri : mongodbUri.slice(0, queryIndex);
    const query = queryIndex === -1 ? "" : mongodbUri.slice(queryIndex);
    const schemeEndIndex = uriWithoutQuery.indexOf("://");
    if (schemeEndIndex === -1) {
      return mongodbUri;
    }

    const pathStartIndex = uriWithoutQuery.indexOf("/", schemeEndIndex + 3);
    if (pathStartIndex === -1) {
      return `${uriWithoutQuery}/${defaultDatabaseName}${query}`;
    }

    const databaseName = uriWithoutQuery.slice(pathStartIndex + 1);
    if (!databaseName) {
      return `${uriWithoutQuery}${defaultDatabaseName}${query}`;
    }

    if (databaseName.endsWith("-prod")) {
      return mongodbUri;
    }

    return `${uriWithoutQuery.slice(0, pathStartIndex + 1)}${databaseName}-prod${query}`;
  }
}

function ensureMongoDatabaseName(mongodbUri: string, defaultDatabaseName: string): string {
  try {
    const parsedUri = new URL(mongodbUri);
    const databaseName = parsedUri.pathname.replace(/^\/+/, "");
    if (databaseName) {
      return mongodbUri;
    }

    parsedUri.pathname = `/${defaultDatabaseName}`;
    return parsedUri.toString();
  } catch {
    const queryIndex = mongodbUri.indexOf("?");
    const uriWithoutQuery = queryIndex === -1 ? mongodbUri : mongodbUri.slice(0, queryIndex);
    const query = queryIndex === -1 ? "" : mongodbUri.slice(queryIndex);
    const schemeEndIndex = uriWithoutQuery.indexOf("://");
    if (schemeEndIndex === -1) {
      return mongodbUri;
    }

    const pathStartIndex = uriWithoutQuery.indexOf("/", schemeEndIndex + 3);
    if (pathStartIndex === -1) {
      return `${uriWithoutQuery}/${defaultDatabaseName}${query}`;
    }

    const databaseName = uriWithoutQuery.slice(pathStartIndex + 1);
    if (databaseName) {
      return mongodbUri;
    }

    return `${uriWithoutQuery}${defaultDatabaseName}${query}`;
  }
}

function replaceMongoDatabaseName(
  mongodbUri: string,
  replaceDatabaseName: (databaseName: string) => string
): string {
  try {
    const parsedUri = new URL(mongodbUri);
    const databaseName = parsedUri.pathname.replace(/^\/+/, "");
    if (!databaseName) {
      return mongodbUri;
    }

    const replacementDatabaseName = replaceDatabaseName(databaseName);
    if (replacementDatabaseName === databaseName) {
      return mongodbUri;
    }

    parsedUri.pathname = `/${replacementDatabaseName}`;
    return parsedUri.toString();
  } catch {
    const queryIndex = mongodbUri.indexOf("?");
    const uriWithoutQuery = queryIndex === -1 ? mongodbUri : mongodbUri.slice(0, queryIndex);
    const query = queryIndex === -1 ? "" : mongodbUri.slice(queryIndex);
    const schemeEndIndex = uriWithoutQuery.indexOf("://");
    if (schemeEndIndex === -1) {
      return mongodbUri;
    }

    const pathStartIndex = uriWithoutQuery.indexOf("/", schemeEndIndex + 3);
    if (pathStartIndex === -1) {
      return mongodbUri;
    }

    const databaseName = uriWithoutQuery.slice(pathStartIndex + 1);
    if (!databaseName) {
      return mongodbUri;
    }

    const replacementDatabaseName = replaceDatabaseName(databaseName);
    if (replacementDatabaseName === databaseName) {
      return mongodbUri;
    }

    return `${uriWithoutQuery.slice(0, pathStartIndex + 1)}${replacementDatabaseName}${query}`;
  }
}
