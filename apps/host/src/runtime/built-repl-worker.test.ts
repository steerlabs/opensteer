import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { builtReplWorkerEntry } from "./machine-access-protocol.test-support.js";

describe("builtReplWorkerEntry", () => {
  const dirs: string[] = [];
  const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "opensteer-repl-entry-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("returns undefined when the built file is missing", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "computer-repl-worker.ts"), "// source\n");
    expect(builtReplWorkerEntry(join(dir, "computer-repl-worker.js"), dir)).toBeUndefined();
  });

  it("returns the built URL when it is at least as new as every non-test source file", () => {
    const dir = tempDir();
    const source = join(dir, "computer-repl-worker.ts");
    const testFile = join(dir, "computer-repl.test.ts");
    const built = join(dir, "computer-repl-worker.js");
    writeFileSync(source, "// source\n");
    writeFileSync(built, "// built\n");
    writeFileSync(testFile, "// test\n");
    utimesSync(source, 1_000, 1_000);
    utimesSync(built, 2_000, 2_000);
    utimesSync(testFile, 3_000, 3_000);
    expect(builtReplWorkerEntry(built, dir)?.href).toBe(pathToFileURL(built).href);
  });

  it("falls back to undefined when any worker source file is newer than the built file", () => {
    const dir = tempDir();
    const source = join(dir, "guest-library.ts");
    const built = join(dir, "computer-repl-worker.js");
    writeFileSync(built, "// stale build\n");
    writeFileSync(source, "// edited source\n");
    utimesSync(built, 1_000, 1_000);
    utimesSync(source, 2_000, 2_000);
    expect(builtReplWorkerEntry(built, dir)).toBeUndefined();
  });
});
