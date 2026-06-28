import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";
import {
  buildCorsOptionsForRequest,
  buildTrustedDashboardCorsHeaders,
  buildPublicCorsHeaders,
  isTrustedDashboardOrigin,
  isPublicCorsPath,
  getTrustedDashboardOrigins
} from "./cors.js";

const config = {
  PUBLIC_APP_URL: "http://localhost:4888",
  PUBLIC_API_URL: "http://localhost:4001"
} as AppConfig;

function fakeRequest(url: string, origin?: string): FastifyRequest {
  return {
    url,
    headers: origin !== undefined ? { origin } : {}
  } as unknown as FastifyRequest;
}

describe("isPublicCorsPath", () => {
  it("treats /widget.js as public", () => {
    expect(isPublicCorsPath("/widget.js")).toBe(true);
  });

  it("treats /api/widget/ paths as public", () => {
    expect(isPublicCorsPath("/api/widget/config?siteKey=abc")).toBe(true);
    expect(isPublicCorsPath("/api/widget/transcribe-realtime-token")).toBe(true);
  });

  it("treats non-widget paths as private", () => {
    expect(isPublicCorsPath("/api/auth/login")).toBe(false);
    expect(isPublicCorsPath("/api/sites")).toBe(false);
    expect(isPublicCorsPath("/")).toBe(false);
  });
});

describe("isTrustedDashboardOrigin", () => {
  it("trusts the configured app origin", () => {
    expect(isTrustedDashboardOrigin("http://localhost:4888", config)).toBe(true);
  });

  it("trusts the configured API origin", () => {
    expect(isTrustedDashboardOrigin("http://localhost:4001", config)).toBe(true);
  });

  it("rejects an unknown origin", () => {
    expect(isTrustedDashboardOrigin("http://evil.com", config)).toBe(false);
  });

  it("rejects an invalid URL", () => {
    expect(isTrustedDashboardOrigin("not-a-url", config)).toBe(false);
  });
});

describe("getTrustedDashboardOrigins", () => {
  it("returns a set of normalized origins", () => {
    const origins = getTrustedDashboardOrigins(config);
    expect(origins.has("http://localhost:4888")).toBe(true);
    expect(origins.has("http://localhost:4001")).toBe(true);
    expect(origins.size).toBe(2);
  });
});

describe("buildCorsOptionsForRequest", () => {
  it("returns open CORS for public widget paths", () => {
    const result = buildCorsOptionsForRequest(config, fakeRequest("/widget.js", "http://any.com"));
    expect(result.origin).toBe(true);
    expect(result.credentials).toBe(false);
  });

  it("returns trusted origin for dashboard paths with valid origin", () => {
    const result = buildCorsOptionsForRequest(config, fakeRequest("/api/auth/me", "http://localhost:4888"));
    expect(result.origin).toBe("http://localhost:4888");
    expect(result.credentials).toBe(true);
  });

  it("returns false origin for dashboard paths with untrusted origin", () => {
    const result = buildCorsOptionsForRequest(config, fakeRequest("/api/auth/me", "http://evil.com"));
    expect(result.origin).toBe(false);
    expect(result.credentials).toBe(true);
  });

  it("returns false origin when no origin header is present", () => {
    const result = buildCorsOptionsForRequest(config, fakeRequest("/api/sites"));
    expect(result.origin).toBe(false);
  });
});

describe("buildTrustedDashboardCorsHeaders", () => {
  it("returns CORS headers for a trusted origin", () => {
    const headers = buildTrustedDashboardCorsHeaders("http://localhost:4888", config);
    expect(headers["access-control-allow-origin"]).toBe("http://localhost:4888");
    expect(headers["access-control-allow-credentials"]).toBe("true");
    expect(headers.vary).toBe("Origin");
  });

  it("returns empty headers for an untrusted origin", () => {
    const headers = buildTrustedDashboardCorsHeaders("http://evil.com", config);
    expect(headers).toEqual({});
  });

  it("returns empty headers for non-string origin", () => {
    const headers = buildTrustedDashboardCorsHeaders(undefined, config);
    expect(headers).toEqual({});
  });
});

describe("buildPublicCorsHeaders", () => {
  it("echoes a string origin", () => {
    const headers = buildPublicCorsHeaders("http://example.com");
    expect(headers["access-control-allow-origin"]).toBe("http://example.com");
    expect(headers.vary).toBe("Origin");
  });

  it("falls back to * for non-string origin", () => {
    expect(buildPublicCorsHeaders(undefined)["access-control-allow-origin"]).toBe("*");
  });

  it("falls back to * for empty string origin", () => {
    expect(buildPublicCorsHeaders("  ")["access-control-allow-origin"]).toBe("*");
  });
});
