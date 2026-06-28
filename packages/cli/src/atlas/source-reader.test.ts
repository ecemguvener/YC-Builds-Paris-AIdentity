import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readSelectedSourceFiles } from "./source-reader.js";

describe("readSelectedSourceFiles", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `source-reader-test-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("reads allowed files and returns chunks", async () => {
    await writeFile(path.join(tempDir, "hello.ts"), "console.log('hello');");

    const result = await readSelectedSourceFiles({
      root: tempDir,
      selectedFilePaths: ["hello.ts"],
      allowedFilePaths: ["hello.ts"]
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.path).toBe("hello.ts");
    expect(result.totalChunks).toBe(1);
    expect(result.chunks[0]!.content).toBe("console.log('hello');");
  });

  it("skips files not in allowedFilePaths", async () => {
    await writeFile(path.join(tempDir, "allowed.ts"), "ok");
    await writeFile(path.join(tempDir, "forbidden.ts"), "secret");

    const result = await readSelectedSourceFiles({
      root: tempDir,
      selectedFilePaths: ["allowed.ts", "forbidden.ts"],
      allowedFilePaths: ["allowed.ts"]
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.path).toBe("allowed.ts");
  });

  it("skips sensitive files even if allowed", async () => {
    await writeFile(path.join(tempDir, ".env"), "SECRET=value");

    const result = await readSelectedSourceFiles({
      root: tempDir,
      selectedFilePaths: [".env"],
      allowedFilePaths: [".env"]
    });

    expect(result.files).toHaveLength(0);
  });

  it("calls onFileRead callback for each read file", async () => {
    await writeFile(path.join(tempDir, "a.ts"), "a");
    await writeFile(path.join(tempDir, "b.ts"), "b");

    const readFiles: string[] = [];
    await readSelectedSourceFiles({
      root: tempDir,
      selectedFilePaths: ["a.ts", "b.ts"],
      allowedFilePaths: ["a.ts", "b.ts"],
      onFileRead: (filePath) => readFiles.push(filePath)
    });

    expect(readFiles).toEqual(["a.ts", "b.ts"]);
  });

  it("computes totalBytes from file sizes", async () => {
    const content = "x".repeat(100);
    await writeFile(path.join(tempDir, "file.ts"), content);

    const result = await readSelectedSourceFiles({
      root: tempDir,
      selectedFilePaths: ["file.ts"],
      allowedFilePaths: ["file.ts"]
    });

    expect(result.totalBytes).toBe(100);
  });

  it("returns empty results when no files are selected", async () => {
    const result = await readSelectedSourceFiles({
      root: tempDir,
      selectedFilePaths: [],
      allowedFilePaths: []
    });

    expect(result.files).toEqual([]);
    expect(result.chunks).toEqual([]);
    expect(result.totalBytes).toBe(0);
    expect(result.totalChunks).toBe(0);
  });

  it("prevents path traversal outside root", async () => {
    await writeFile(path.join(tempDir, "safe.ts"), "safe");

    const result = await readSelectedSourceFiles({
      root: tempDir,
      selectedFilePaths: ["../../../etc/passwd"],
      allowedFilePaths: ["../../../etc/passwd"]
    });

    expect(result.files).toHaveLength(0);
  });

  it("handles files in subdirectories", async () => {
    await mkdir(path.join(tempDir, "src"), { recursive: true });
    await writeFile(path.join(tempDir, "src", "app.ts"), "export default {};");

    const result = await readSelectedSourceFiles({
      root: tempDir,
      selectedFilePaths: ["src/app.ts"],
      allowedFilePaths: ["src/app.ts"]
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.path).toBe("src/app.ts");
    expect(result.chunks[0]!.content).toBe("export default {};");
  });
});
