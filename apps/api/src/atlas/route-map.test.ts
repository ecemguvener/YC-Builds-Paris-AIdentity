import { describe, expect, it } from "vitest";
import { isAtlasRouteMapDocument } from "./route-map.js";

describe("isAtlasRouteMapDocument", () => {
  const validDoc = {
    version: 1,
    project_id: "proj_test123",
    generated_at: "2025-01-15T12:00:00.000Z",
    source_files: ["src/App.tsx"],
    routes: [
      { path: "/dashboard", summary: "Main dashboard page" },
      { path: "/settings", summary: "User settings" }
    ]
  };

  it("accepts a valid route map document", () => {
    expect(isAtlasRouteMapDocument(validDoc)).toBe(true);
  });

  it("rejects null", () => {
    expect(isAtlasRouteMapDocument(null)).toBe(false);
  });

  it("rejects undefined", () => {
    expect(isAtlasRouteMapDocument(undefined)).toBe(false);
  });

  it("rejects arrays", () => {
    expect(isAtlasRouteMapDocument([])).toBe(false);
  });

  it("rejects a wrong version", () => {
    expect(isAtlasRouteMapDocument({ ...validDoc, version: 2 })).toBe(false);
  });

  it("rejects an empty project_id", () => {
    expect(isAtlasRouteMapDocument({ ...validDoc, project_id: "  " })).toBe(false);
  });

  it("rejects a non-string project_id", () => {
    expect(isAtlasRouteMapDocument({ ...validDoc, project_id: 123 })).toBe(false);
  });

  it("rejects an invalid generated_at date", () => {
    expect(isAtlasRouteMapDocument({ ...validDoc, generated_at: "not-a-date" })).toBe(false);
  });

  it("rejects non-array source_files", () => {
    expect(isAtlasRouteMapDocument({ ...validDoc, source_files: "src/App.tsx" })).toBe(false);
  });

  it("rejects source_files containing non-strings", () => {
    expect(isAtlasRouteMapDocument({ ...validDoc, source_files: [42] })).toBe(false);
  });

  it("rejects non-array routes", () => {
    expect(isAtlasRouteMapDocument({ ...validDoc, routes: "bad" })).toBe(false);
  });

  it("rejects routes with empty path", () => {
    expect(isAtlasRouteMapDocument({
      ...validDoc,
      routes: [{ path: "  ", summary: "ok" }]
    })).toBe(false);
  });

  it("rejects routes with empty summary", () => {
    expect(isAtlasRouteMapDocument({
      ...validDoc,
      routes: [{ path: "/valid", summary: "" }]
    })).toBe(false);
  });

  it("rejects routes that are not objects", () => {
    expect(isAtlasRouteMapDocument({
      ...validDoc,
      routes: ["string-route"]
    })).toBe(false);
  });

  it("accepts a document with empty routes array", () => {
    expect(isAtlasRouteMapDocument({ ...validDoc, routes: [] })).toBe(true);
  });
});
