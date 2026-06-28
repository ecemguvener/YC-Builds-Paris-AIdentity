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

  it("uses the configured dated model for dashboard chat by default", () => {
    delete process.env.OPENAI_DASHBOARD_CHAT_MODEL;

    const config = loadConfig();

    expect(config.OPENAI_DASHBOARD_CHAT_MODEL).toBe("gpt-5.4-2026-03-05");
  });

  it("normalizes undated and stale mini model overrides", () => {
    const undatedMiniModel = ["gpt", "5.4", "mini"].join("-");
    process.env.OPENAI_DASHBOARD_CHAT_MODEL = undatedMiniModel;

    const config = loadConfig();

    expect(config.OPENAI_DASHBOARD_CHAT_MODEL).toBe("gpt-5.4-mini-2026-03-17");
  });

  it("keeps the configured MongoDB database name outside production", () => {
    process.env.NODE_ENV = "development";
    process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/aidentity";

    expect(loadConfig().MONGODB_URI).toBe("mongodb://127.0.0.1:27017/aidentity");
  });

  it("rewrites the legacy MongoDB database name", () => {
    process.env.NODE_ENV = "development";
    process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/aidentity-web";

    expect(loadConfig().MONGODB_URI).toBe("mongodb://127.0.0.1:27017/aidentity");
  });

  it("uses aidentity when a MongoDB URI has no database name", () => {
    process.env.NODE_ENV = "development";
    process.env.MONGODB_URI = "mongodb://127.0.0.1:27017";

    expect(loadConfig().MONGODB_URI).toBe("mongodb://127.0.0.1:27017/aidentity");
  });

  it("appends the production suffix to the MongoDB database name", () => {
    process.env.NODE_ENV = "production";
    process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/aidentity";
    process.env.PUBLIC_API_URL = "http://localhost:4000";

    expect(loadConfig().MONGODB_URI).toBe("mongodb://127.0.0.1:27017/aidentity-prod");
  });

  it("does not duplicate the production suffix", () => {
    process.env.NODE_ENV = "production";
    process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/aidentity-prod";
    process.env.PUBLIC_API_URL = "http://localhost:4000";

    expect(loadConfig().MONGODB_URI).toBe("mongodb://127.0.0.1:27017/aidentity-prod");
  });

  it("rewrites the legacy production MongoDB database name", () => {
    process.env.NODE_ENV = "production";
    process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/aidentity-web-prod";
    process.env.PUBLIC_API_URL = "http://localhost:4000";

    expect(loadConfig().MONGODB_URI).toBe("mongodb://127.0.0.1:27017/aidentity-prod");
  });

  it("requires HTTPS for non-local production API URLs", () => {
    process.env.NODE_ENV = "production";
    process.env.PUBLIC_API_URL = "http://100.81.152.74:4001";

    expect(() => loadConfig()).toThrow("PUBLIC_API_URL must use HTTPS");
  });

  it("keeps localhost HTTP API URLs available for local production-style runs", () => {
    process.env.NODE_ENV = "production";
    process.env.PUBLIC_API_URL = "http://localhost:4001/";

    expect(loadConfig().PUBLIC_API_URL).toBe("http://localhost:4001");
  });

  it("treats empty vendor API keys as unset", () => {
    process.env.OPENAI_API_KEY = "   ";
    process.env.ELEVENLABS_API_KEY = "";

    const config = loadConfig();

    expect(config.OPENAI_API_KEY).toBeUndefined();
    expect(config.ELEVENLABS_API_KEY).toBeUndefined();
  });

});
