import crypto from "node:crypto";
import bcrypt from "bcryptjs";

export const SESSION_TTL_DAYS = 30;
export const SITE_PREVIEW_IMAGES = [
  "site-preview-blue-flow",
  "site-preview-coral-mint",
  "site-preview-cyan-mist",
  "site-preview-dashboard",
  "site-preview-lime-blue"
] as const;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(password, passwordHash);
}

export function createSessionToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(token).digest("base64url");
}

export function createSessionExpiry(): Date {
  return new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export function createPublicSiteKey(): string {
  return `site_${crypto.randomBytes(24).toString("base64url")}`;
}

export function createSitePreviewImage(): string {
  return SITE_PREVIEW_IMAGES[crypto.randomInt(SITE_PREVIEW_IMAGES.length)] ?? SITE_PREVIEW_IMAGES[0];
}

export function createAidentityApiKey(): string {
  return `ck_${crypto.randomBytes(32).toString("base64url")}`;
}

export function hashApiKey(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey).digest("base64url");
}

export function createAtlasProjectId(): string {
  return `proj_${crypto.randomBytes(18).toString("base64url")}`;
}

export function isAtlasProjectId(value: unknown): value is string {
  return typeof value === "string" && /^proj_[A-Za-z0-9_-]{8,}$/.test(value);
}

export function isPasswordUsable(password: string): boolean {
  return password.length >= 8 && password.length <= 128;
}

export function serializeSite(site: {
  _id: unknown;
  name: string;
  domain: string;
  publicSiteKey: string;
  previewImage?: string;
  chatTheme?: "system" | "light" | "dark";
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: String(site._id),
    name: site.name,
    domain: site.domain,
    publicSiteKey: site.publicSiteKey,
    previewImage: SITE_PREVIEW_IMAGES.includes(site.previewImage as (typeof SITE_PREVIEW_IMAGES)[number])
      ? site.previewImage
      : SITE_PREVIEW_IMAGES[0],
    chatTheme: site.chatTheme === "light" || site.chatTheme === "dark" ? site.chatTheme : "system",
    createdAt: site.createdAt.toISOString(),
    updatedAt: site.updatedAt.toISOString()
  };
}
