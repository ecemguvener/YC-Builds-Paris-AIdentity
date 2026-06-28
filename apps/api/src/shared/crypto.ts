import crypto from "node:crypto";

export function randomId(byteLength: number): string {
  return crypto.randomBytes(byteLength).toString("base64url");
}

export function randomDigits(length: number): string {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += crypto.randomInt(10).toString();
  }
  return value;
}

export function slugify(value: string, fallback = "agent"): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || fallback;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
