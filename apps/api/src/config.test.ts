import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const originalEnvironment = { ...process.env };

describe("loadConfig", () => {
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, originalEnvironment);
  });

  it("uses the configured dated models for the widget and action defaults", () => {
    delete process.env.OPENAI_WIDGET_MODEL;
    delete process.env.OPENAI_ACTION_MODEL;
    delete process.env.OPENAI_ATLAS_MODEL;

    const config = loadConfig();

    expect(config.OPENAI_WIDGET_MODEL).toBe("gpt-5.4-2026-03-05");
    expect(config.OPENAI_ACTION_MODEL).toBe("gpt-5.4-2026-03-05");
    expect(config.OPENAI_ATLAS_MODEL).toBe("gpt-5.4-2026-03-05");
  });

  it("normalizes undated and stale mini model overrides", () => {
    const undatedMiniModel = ["gpt", "5.4", "mini"].join("-");
    const staleDatedMiniModel = `${undatedMiniModel}-${["2026", "03", "01"].join("-")}`;
    process.env.OPENAI_WIDGET_MODEL = staleDatedMiniModel;
    process.env.OPENAI_ACTION_MODEL = undatedMiniModel;
    process.env.OPENAI_ATLAS_MODEL = undatedMiniModel;

    const config = loadConfig();

    expect(config.OPENAI_WIDGET_MODEL).toBe("gpt-5.4-2026-03-05");
    expect(config.OPENAI_ACTION_MODEL).toBe("gpt-5.4-mini-2026-03-17");
    expect(config.OPENAI_ATLAS_MODEL).toBe("gpt-5.4-mini-2026-03-17");
  });

  it("keeps the configured MongoDB database name outside production", () => {
    process.env.NODE_ENV = "development";
    process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/barkan";

    expect(loadConfig().MONGODB_URI).toBe("mongodb://127.0.0.1:27017/barkan");
  });

  it("rewrites the legacy MongoDB database name", () => {
    process.env.NODE_ENV = "development";
    process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/barkan-web";

    expect(loadConfig().MONGODB_URI).toBe("mongodb://127.0.0.1:27017/barkan");
  });

  it("uses barkan when a MongoDB URI has no database name", () => {
    process.env.NODE_ENV = "development";
    process.env.MONGODB_URI = "mongodb://127.0.0.1:27017";

    expect(loadConfig().MONGODB_URI).toBe("mongodb://127.0.0.1:27017/barkan");
  });

  it("appends the production suffix to the MongoDB database name", () => {
    process.env.NODE_ENV = "production";
    process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/barkan";
    process.env.PUBLIC_API_URL = "http://localhost:4000";
    process.env.SESSION_SECRET = "production-test-secret-value-long-enough";

    expect(loadConfig().MONGODB_URI).toBe("mongodb://127.0.0.1:27017/barkan-prod");
  });

  it("does not duplicate the production suffix", () => {
    process.env.NODE_ENV = "production";
    process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/barkan-prod";
    process.env.PUBLIC_API_URL = "http://localhost:4000";
    process.env.SESSION_SECRET = "production-test-secret-value-long-enough";

    expect(loadConfig().MONGODB_URI).toBe("mongodb://127.0.0.1:27017/barkan-prod");
  });

  it("rewrites the legacy production MongoDB database name", () => {
    process.env.NODE_ENV = "production";
    process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/barkan-web-prod";
    process.env.PUBLIC_API_URL = "http://localhost:4000";
    process.env.SESSION_SECRET = "production-test-secret-value-long-enough";

    expect(loadConfig().MONGODB_URI).toBe("mongodb://127.0.0.1:27017/barkan-prod");
  });

  it("requires HTTPS for non-local production API URLs", () => {
    process.env.NODE_ENV = "production";
    process.env.PUBLIC_API_URL = "http://100.81.152.74:4001";
    process.env.SESSION_SECRET = "production-test-secret-value-long-enough";

    expect(() => loadConfig()).toThrow("PUBLIC_API_URL must use HTTPS");
  });

  it("keeps localhost HTTP API URLs available for local production-style runs", () => {
    process.env.NODE_ENV = "production";
    process.env.PUBLIC_API_URL = "http://localhost:4001/";
    process.env.SESSION_SECRET = "production-test-secret-value-long-enough";

    expect(loadConfig().PUBLIC_API_URL).toBe("http://localhost:4001");
  });

  it("treats empty vendor API keys as unset", () => {
    process.env.OPENAI_API_KEY = "   ";
    process.env.ELEVENLABS_API_KEY = "";
    process.env.STRIPE_SECRET_KEY = " ";

    const config = loadConfig();

    expect(config.OPENAI_API_KEY).toBeUndefined();
    expect(config.ELEVENLABS_API_KEY).toBeUndefined();
    expect(config.STRIPE_SECRET_KEY).toBeUndefined();
  });

  it("loads Stripe payment provider settings", () => {
    process.env.PAYMENT_PROVIDER = "stripe";
    process.env.STRIPE_SECRET_KEY = "sk_test_config";
    process.env.STRIPE_SUCCESS_URL = "https://example.com/success?request={REQUEST_ID}";
    process.env.STRIPE_CANCEL_URL = "https://example.com/cancel";

    const config = loadConfig();

    expect(config.PAYMENT_PROVIDER).toBe("stripe");
    expect(config.STRIPE_SECRET_KEY).toBe("sk_test_config");
    expect(config.STRIPE_SUCCESS_URL).toBe("https://example.com/success?request={REQUEST_ID}");
    expect(config.STRIPE_CANCEL_URL).toBe("https://example.com/cancel");
  });

});
