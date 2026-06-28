import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  readExistingBarkanConfig,
  writeBarkanConfig,
  removeBarkanProjectFiles,
  barkanConfigFileName,
  barkanDirectoryName,
  defaultAtlasIgnore
} from "./config.js";

describe("barkan config", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `config-test-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("readExistingBarkanConfig", () => {
    it("returns null when no config file exists", async () => {
      expect(await readExistingBarkanConfig(tempDir)).toBeNull();
    });

    it("reads a valid config file", async () => {
      const config = {
        project_id: "proj_test123",
        atlas: {
          mode: "frontend",
          root: ".",
          ignore: ["node_modules", ".git"]
        }
      };
      await writeFile(path.join(tempDir, barkanConfigFileName), JSON.stringify(config));

      const result = await readExistingBarkanConfig(tempDir);
      expect(result).not.toBeNull();
      expect(result!.project_id).toBe("proj_test123");
      expect(result!.atlas.ignore).toEqual(["node_modules", ".git"]);
    });

    it("uses default ignore list when atlas.ignore is missing", async () => {
      const config = { project_id: "proj_abc" };
      await writeFile(path.join(tempDir, barkanConfigFileName), JSON.stringify(config));

      const result = await readExistingBarkanConfig(tempDir);
      expect(result!.atlas.ignore).toEqual(defaultAtlasIgnore);
    });

    it("returns null for a config with empty project_id", async () => {
      const config = { project_id: "  " };
      await writeFile(path.join(tempDir, barkanConfigFileName), JSON.stringify(config));

      expect(await readExistingBarkanConfig(tempDir)).toBeNull();
    });

    it("returns null for a config with non-string project_id", async () => {
      const config = { project_id: 123 };
      await writeFile(path.join(tempDir, barkanConfigFileName), JSON.stringify(config));

      expect(await readExistingBarkanConfig(tempDir)).toBeNull();
    });
  });

  describe("writeBarkanConfig", () => {
    it("writes a config file and creates the .barkan directory", async () => {
      const config = await writeBarkanConfig(tempDir, "proj_new");
      expect(config.project_id).toBe("proj_new");
      expect(config.atlas.mode).toBe("frontend");
      expect(config.atlas.ignore).toEqual(defaultAtlasIgnore);

      const fileContent = await readFile(path.join(tempDir, barkanConfigFileName), "utf8");
      const parsed = JSON.parse(fileContent);
      expect(parsed.project_id).toBe("proj_new");
    });
  });

  describe("removeBarkanProjectFiles", () => {
    it("removes config file and .barkan directory", async () => {
      await writeFile(path.join(tempDir, barkanConfigFileName), "{}");
      await mkdir(path.join(tempDir, barkanDirectoryName), { recursive: true });

      const removed = await removeBarkanProjectFiles(tempDir);
      expect(removed).toBe(true);
    });

    it("returns false when nothing to remove", async () => {
      const removed = await removeBarkanProjectFiles(tempDir);
      expect(removed).toBe(false);
    });
  });
});
