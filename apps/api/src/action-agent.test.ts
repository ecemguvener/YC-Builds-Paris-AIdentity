import { describe, expect, it } from "vitest";
import { compactBackendInventory } from "./action-agent.js";
import type { AtlasBackendInventoryDocument } from "./atlas/backend-inventory.js";

describe("compactBackendInventory", () => {
  it("extracts method, path, and summary from endpoints", () => {
    const inventory: AtlasBackendInventoryDocument = {
      version: 1,
      project_id: "proj_test",
      generated_at: new Date().toISOString(),
      source_files: ["src/app.ts"],
      endpoints: [
        {
          method: "get",
          path: "/api/users",
          summary: "List all users",
          auth: "bearer",
          request: {},
          response: { success: "200 OK", errors: ["401"] }
        },
        {
          method: "post",
          path: "/api/users",
          summary: "Create a user",
          auth: "bearer",
          request: {
            body: {
              name: { type: "string", required: true }
            }
          },
          response: { success: "201 Created", errors: ["400", "401"] }
        }
      ]
    };

    const result = compactBackendInventory(inventory);

    expect(result).toEqual([
      { method: "GET", path: "/api/users", summary: "List all users" },
      { method: "POST", path: "/api/users", summary: "Create a user" }
    ]);
  });

  it("uppercases the method", () => {
    const inventory: AtlasBackendInventoryDocument = {
      version: 1,
      project_id: "proj_test",
      generated_at: new Date().toISOString(),
      source_files: [],
      endpoints: [
        {
          method: "patch",
          path: "/api/items/:id",
          summary: "Update item",
          auth: "bearer",
          request: {},
          response: { success: "200 OK", errors: [] }
        }
      ]
    };

    expect(compactBackendInventory(inventory)[0]!.method).toBe("PATCH");
  });

  it("returns an empty array for an inventory with no endpoints", () => {
    const inventory: AtlasBackendInventoryDocument = {
      version: 1,
      project_id: "proj_test",
      generated_at: new Date().toISOString(),
      source_files: [],
      endpoints: []
    };

    expect(compactBackendInventory(inventory)).toEqual([]);
  });
});
