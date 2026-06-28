import { describe, expect, it } from "vitest";
import {
  isAtlasBackendInventoryDocument,
  createEmptyAtlasBackendInventory
} from "./backend-inventory.js";

describe("isAtlasBackendInventoryDocument", () => {
  const validEndpoint = {
    method: "GET",
    path: "/api/users",
    summary: "List users",
    auth: "bearer",
    request: {},
    response: { success: "200 OK", errors: ["401"] }
  };

  const validDoc = {
    version: 1,
    project_id: "proj_test123",
    generated_at: "2025-01-15T12:00:00.000Z",
    source_files: ["src/routes.ts"],
    endpoints: [validEndpoint]
  };

  it("accepts a valid backend inventory document", () => {
    expect(isAtlasBackendInventoryDocument(validDoc)).toBe(true);
  });

  it("rejects null", () => {
    expect(isAtlasBackendInventoryDocument(null)).toBe(false);
  });

  it("rejects undefined", () => {
    expect(isAtlasBackendInventoryDocument(undefined)).toBe(false);
  });

  it("rejects arrays", () => {
    expect(isAtlasBackendInventoryDocument([])).toBe(false);
  });

  it("rejects a wrong version", () => {
    expect(isAtlasBackendInventoryDocument({ ...validDoc, version: 2 })).toBe(false);
  });

  it("rejects an empty project_id", () => {
    expect(isAtlasBackendInventoryDocument({ ...validDoc, project_id: " " })).toBe(false);
  });

  it("rejects a non-string project_id", () => {
    expect(isAtlasBackendInventoryDocument({ ...validDoc, project_id: 42 })).toBe(false);
  });

  it("rejects an invalid generated_at date", () => {
    expect(isAtlasBackendInventoryDocument({ ...validDoc, generated_at: "nope" })).toBe(false);
  });

  it("rejects non-array source_files", () => {
    expect(isAtlasBackendInventoryDocument({ ...validDoc, source_files: 123 })).toBe(false);
  });

  it("rejects non-array endpoints", () => {
    expect(isAtlasBackendInventoryDocument({ ...validDoc, endpoints: "bad" })).toBe(false);
  });

  it("rejects an endpoint with empty method", () => {
    expect(isAtlasBackendInventoryDocument({
      ...validDoc,
      endpoints: [{ ...validEndpoint, method: "  " }]
    })).toBe(false);
  });

  it("rejects an endpoint with empty path", () => {
    expect(isAtlasBackendInventoryDocument({
      ...validDoc,
      endpoints: [{ ...validEndpoint, path: "" }]
    })).toBe(false);
  });

  it("rejects an endpoint with empty summary", () => {
    expect(isAtlasBackendInventoryDocument({
      ...validDoc,
      endpoints: [{ ...validEndpoint, summary: " " }]
    })).toBe(false);
  });

  it("rejects an endpoint with empty auth", () => {
    expect(isAtlasBackendInventoryDocument({
      ...validDoc,
      endpoints: [{ ...validEndpoint, auth: "" }]
    })).toBe(false);
  });

  it("rejects an endpoint with missing response", () => {
    const { response: _response, ...noResponse } = validEndpoint;
    expect(isAtlasBackendInventoryDocument({
      ...validDoc,
      endpoints: [noResponse]
    })).toBe(false);
  });

  it("rejects an endpoint with invalid response success type", () => {
    expect(isAtlasBackendInventoryDocument({
      ...validDoc,
      endpoints: [{ ...validEndpoint, response: { success: "", errors: [] } }]
    })).toBe(false);
  });

  it("accepts an endpoint with query, body, and params in request", () => {
    expect(isAtlasBackendInventoryDocument({
      ...validDoc,
      endpoints: [{
        ...validEndpoint,
        request: {
          params: { id: { type: "string", required: true } },
          query: { limit: { type: "number", required: false } },
          body: { name: { type: "string", required: true, enum: ["a", "b"] } }
        }
      }]
    })).toBe(true);
  });

  it("rejects a field with invalid type", () => {
    expect(isAtlasBackendInventoryDocument({
      ...validDoc,
      endpoints: [{
        ...validEndpoint,
        request: {
          body: { name: { type: "", required: true } }
        }
      }]
    })).toBe(false);
  });

  it("rejects a field with non-boolean required", () => {
    expect(isAtlasBackendInventoryDocument({
      ...validDoc,
      endpoints: [{
        ...validEndpoint,
        request: {
          body: { name: { type: "string", required: "yes" } }
        }
      }]
    })).toBe(false);
  });

  it("rejects a field with non-string-array enum", () => {
    expect(isAtlasBackendInventoryDocument({
      ...validDoc,
      endpoints: [{
        ...validEndpoint,
        request: {
          body: { name: { type: "string", required: true, enum: [1, 2] } }
        }
      }]
    })).toBe(false);
  });

  it("accepts an empty endpoints array", () => {
    expect(isAtlasBackendInventoryDocument({ ...validDoc, endpoints: [] })).toBe(true);
  });
});

describe("createEmptyAtlasBackendInventory", () => {
  it("creates an empty inventory with the given project id", () => {
    const inventory = createEmptyAtlasBackendInventory("proj_abc");
    expect(inventory.version).toBe(1);
    expect(inventory.project_id).toBe("proj_abc");
    expect(inventory.source_files).toEqual([]);
    expect(inventory.endpoints).toEqual([]);
    expect(typeof inventory.generated_at).toBe("string");
    expect(Number.isNaN(Date.parse(inventory.generated_at))).toBe(false);
  });

  it("validates as a proper inventory document", () => {
    const inventory = createEmptyAtlasBackendInventory("proj_test");
    expect(isAtlasBackendInventoryDocument(inventory)).toBe(true);
  });
});
