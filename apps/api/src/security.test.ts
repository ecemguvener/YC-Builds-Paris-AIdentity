import { describe, expect, it } from "vitest";
import {
  normalizeEmail,
  hashPassword,
  verifyPassword,
  createSessionToken,
  hashSessionToken,
  createSessionExpiry,
  createPublicSiteKey,
  createSitePreviewImage,
  createBarkanApiKey,
  hashApiKey,
  createAtlasProjectId,
  isAtlasProjectId,
  isPasswordUsable,
  serializeSite,
  SESSION_TTL_DAYS,
  SITE_PREVIEW_IMAGES
} from "./security.js";

describe("normalizeEmail", () => {
  it("lowercases and trims an email", () => {
    expect(normalizeEmail("  Alice@Example.COM  ")).toBe("alice@example.com");
  });

  it("returns an already-normalized email unchanged", () => {
    expect(normalizeEmail("user@test.com")).toBe("user@test.com");
  });
});

describe("hashPassword and verifyPassword", () => {
  it("hashes a password and verifies it correctly", async () => {
    const hash = await hashPassword("my-secret-password");
    expect(hash).not.toBe("my-secret-password");
    expect(await verifyPassword("my-secret-password", hash)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("correct-password");
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
  });
});

describe("createSessionToken", () => {
  it("returns a base64url string of reasonable length", () => {
    const token = createSessionToken();
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(20);
    expect(/^[A-Za-z0-9_-]+$/.test(token)).toBe(true);
  });

  it("generates unique tokens", () => {
    const tokens = new Set(Array.from({ length: 10 }, () => createSessionToken()));
    expect(tokens.size).toBe(10);
  });
});

describe("hashSessionToken", () => {
  it("produces a deterministic hash for the same token and secret", () => {
    const hash1 = hashSessionToken("token-abc", "secret-xyz");
    const hash2 = hashSessionToken("token-abc", "secret-xyz");
    expect(hash1).toBe(hash2);
  });

  it("produces different hashes for different secrets", () => {
    const hash1 = hashSessionToken("token-abc", "secret-1");
    const hash2 = hashSessionToken("token-abc", "secret-2");
    expect(hash1).not.toBe(hash2);
  });

  it("produces different hashes for different tokens", () => {
    const hash1 = hashSessionToken("token-1", "secret");
    const hash2 = hashSessionToken("token-2", "secret");
    expect(hash1).not.toBe(hash2);
  });
});

describe("createSessionExpiry", () => {
  it("returns a date in the future by SESSION_TTL_DAYS", () => {
    const before = Date.now();
    const expiry = createSessionExpiry();
    const after = Date.now();
    const expectedMs = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
    expect(expiry.getTime()).toBeGreaterThanOrEqual(before + expectedMs);
    expect(expiry.getTime()).toBeLessThanOrEqual(after + expectedMs);
  });
});

describe("createPublicSiteKey", () => {
  it("starts with site_ prefix", () => {
    expect(createPublicSiteKey()).toMatch(/^site_[A-Za-z0-9_-]+$/);
  });
});

describe("createSitePreviewImage", () => {
  it("returns one of the known preview images", () => {
    const image = createSitePreviewImage();
    expect((SITE_PREVIEW_IMAGES as readonly string[]).includes(image)).toBe(true);
  });
});

describe("createBarkanApiKey", () => {
  it("starts with ck_ prefix", () => {
    expect(createBarkanApiKey()).toMatch(/^ck_[A-Za-z0-9_-]+$/);
  });
});

describe("hashApiKey", () => {
  it("produces a deterministic hash", () => {
    const key = "ck_test-key";
    expect(hashApiKey(key)).toBe(hashApiKey(key));
  });

  it("produces different hashes for different keys", () => {
    expect(hashApiKey("ck_a")).not.toBe(hashApiKey("ck_b"));
  });
});

describe("createAtlasProjectId", () => {
  it("starts with proj_ prefix", () => {
    expect(createAtlasProjectId()).toMatch(/^proj_[A-Za-z0-9_-]+$/);
  });
});

describe("isAtlasProjectId", () => {
  it("accepts a valid project id", () => {
    expect(isAtlasProjectId("proj_abcdef12345678")).toBe(true);
  });

  it("rejects a string without the proj_ prefix", () => {
    expect(isAtlasProjectId("abcdef12345678")).toBe(false);
  });

  it("rejects a short project id", () => {
    expect(isAtlasProjectId("proj_abc")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isAtlasProjectId(123)).toBe(false);
    expect(isAtlasProjectId(null)).toBe(false);
    expect(isAtlasProjectId(undefined)).toBe(false);
  });
});

describe("isPasswordUsable", () => {
  it("accepts passwords between 8 and 128 characters", () => {
    expect(isPasswordUsable("12345678")).toBe(true);
    expect(isPasswordUsable("a".repeat(128))).toBe(true);
  });

  it("rejects passwords shorter than 8 characters", () => {
    expect(isPasswordUsable("1234567")).toBe(false);
    expect(isPasswordUsable("")).toBe(false);
  });

  it("rejects passwords longer than 128 characters", () => {
    expect(isPasswordUsable("a".repeat(129))).toBe(false);
  });
});

describe("serializeSite", () => {
  const now = new Date("2025-01-15T12:00:00Z");

  it("serializes a site with valid preview image and chat theme", () => {
    const result = serializeSite({
      _id: "abc123",
      name: "My Site",
      domain: "example.com",
      publicSiteKey: "site_key",
      previewImage: "site-preview-dashboard",
      chatTheme: "dark",
      createdAt: now,
      updatedAt: now
    });

    expect(result).toEqual({
      id: "abc123",
      name: "My Site",
      domain: "example.com",
      publicSiteKey: "site_key",
      previewImage: "site-preview-dashboard",
      chatTheme: "dark",
      createdAt: "2025-01-15T12:00:00.000Z",
      updatedAt: "2025-01-15T12:00:00.000Z"
    });
  });

  it("defaults to first preview image for unknown previewImage", () => {
    const result = serializeSite({
      _id: "x",
      name: "S",
      domain: "d.com",
      publicSiteKey: "sk",
      previewImage: "unknown-image",
      chatTheme: "light",
      createdAt: now,
      updatedAt: now
    });
    expect(result.previewImage).toBe(SITE_PREVIEW_IMAGES[0]);
  });

  it("defaults chatTheme to system for unknown values", () => {
    const result = serializeSite({
      _id: "x",
      name: "S",
      domain: "d.com",
      publicSiteKey: "sk",
      chatTheme: "auto" as "system",
      createdAt: now,
      updatedAt: now
    });
    expect(result.chatTheme).toBe("system");
  });

  it("defaults chatTheme to system when undefined", () => {
    const result = serializeSite({
      _id: "x",
      name: "S",
      domain: "d.com",
      publicSiteKey: "sk",
      createdAt: now,
      updatedAt: now
    });
    expect(result.chatTheme).toBe("system");
  });
});
