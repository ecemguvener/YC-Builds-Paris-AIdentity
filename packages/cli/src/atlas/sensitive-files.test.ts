import { describe, expect, it } from "vitest";
import { isSensitiveSourcePath } from "./sensitive-files.js";

describe("isSensitiveSourcePath", () => {
  it("flags .env files", () => {
    expect(isSensitiveSourcePath(".env")).toBe(true);
    expect(isSensitiveSourcePath("config/.env")).toBe(true);
  });

  it("flags .env.* variants", () => {
    expect(isSensitiveSourcePath(".env.local")).toBe(true);
    expect(isSensitiveSourcePath(".env.production")).toBe(true);
    expect(isSensitiveSourcePath("root/.env.development")).toBe(true);
  });

  it("flags common credential files", () => {
    expect(isSensitiveSourcePath(".npmrc")).toBe(true);
    expect(isSensitiveSourcePath(".pypirc")).toBe(true);
    expect(isSensitiveSourcePath(".netrc")).toBe(true);
    expect(isSensitiveSourcePath("credentials")).toBe(true);
    expect(isSensitiveSourcePath("credentials.json")).toBe(true);
  });

  it("flags SSH key files", () => {
    expect(isSensitiveSourcePath("id_rsa")).toBe(true);
    expect(isSensitiveSourcePath("id_ed25519")).toBe(true);
    expect(isSensitiveSourcePath("id_ecdsa")).toBe(true);
    expect(isSensitiveSourcePath("id_dsa")).toBe(true);
  });

  it("flags private key extensions", () => {
    expect(isSensitiveSourcePath("server.key")).toBe(true);
    expect(isSensitiveSourcePath("cert.pem")).toBe(true);
    expect(isSensitiveSourcePath("keystore.p12")).toBe(true);
    expect(isSensitiveSourcePath("bundle.pfx")).toBe(true);
  });

  it("flags .aws/credentials path", () => {
    expect(isSensitiveSourcePath(".aws/credentials")).toBe(true);
  });

  it("flags .ssh/ sensitive files", () => {
    expect(isSensitiveSourcePath(".ssh/id_rsa")).toBe(true);
    expect(isSensitiveSourcePath(".ssh/id_ed25519")).toBe(true);
  });

  it("does not flag normal source files", () => {
    expect(isSensitiveSourcePath("src/app.ts")).toBe(false);
    expect(isSensitiveSourcePath("package.json")).toBe(false);
    expect(isSensitiveSourcePath("README.md")).toBe(false);
    expect(isSensitiveSourcePath("index.html")).toBe(false);
  });

  it("does not flag .env-like names that are not .env", () => {
    expect(isSensitiveSourcePath("environment.ts")).toBe(false);
    expect(isSensitiveSourcePath("config/env.ts")).toBe(false);
  });

  it("returns false for empty strings", () => {
    expect(isSensitiveSourcePath("")).toBe(false);
  });

  it("handles case-insensitive extension matching", () => {
    expect(isSensitiveSourcePath("cert.PEM")).toBe(true);
    expect(isSensitiveSourcePath("cert.Key")).toBe(true);
  });

  it("does not flag .aws without credentials", () => {
    expect(isSensitiveSourcePath(".aws/config")).toBe(false);
  });

  it("flags .yarnrc and .yarnrc.yml", () => {
    expect(isSensitiveSourcePath(".yarnrc")).toBe(true);
    expect(isSensitiveSourcePath(".yarnrc.yml")).toBe(true);
  });
});
