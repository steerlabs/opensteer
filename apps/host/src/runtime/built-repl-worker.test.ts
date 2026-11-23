import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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

  function writeBundle(dir: string, inputs: readonly string[]) {
    const dist = join(dir, "dist");
    mkdirSync(dist, { recursive: true });
    const built = join(dist, "computer-repl-worker.js");
    writeFileSync(built, "// built\n");
    writeFileSync(`${built}.inputs.json`, JSON.stringify({ inputs }));
    return { built, dist };
  }

  it("returns undefined when the built file or its bundler input manifest is missing", () => {
    const dir = tempDir();
    const built = join(dir, "computer-repl-worker.js");
    expect(builtReplWorkerEntry(built)).toBeUndefined();
    writeFileSync(built, "// built without manifest\n");
    expect(builtReplWorkerEntry(built)).toBeUndefined();
  });

  it("returns the built URL when every bundler-recorded input is no newer than the built file", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "src/browser-use"), { recursive: true });
    mkdirSync(join(dir, "packages/protocol"), { recursive: true });
    const workerSrc = join(dir, "src/computer-repl-worker.ts");
    const browserGuest = join(dir, "src/browser-use/browser-guest-library.ts");
    const protocolSrc = join(dir, "packages/protocol/index.ts");
    writeFileSync(workerSrc, "// worker\n");
    writeFileSync(browserGuest, "// guest\n");
    writeFileSync(protocolSrc, "// protocol\n");
    const { built } = writeBundle(dir, [
      "../src/computer-repl-worker.ts",
      "../src/browser-use/browser-guest-library.ts",
      "../packages/protocol/index.ts",
    ]);
    for (const file of [workerSrc, browserGuest, protocolSrc]) utimesSync(file, 1_000, 1_000);
    utimesSync(built, 2_000, 2_000);
    expect(builtReplWorkerEntry(built)?.href).toBe(pathToFileURL(built).href);
  });

  it("falls back to undefined when a bundler-recorded import outside computer-repl is newer or missing", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "src/browser-use"), { recursive: true });
    mkdirSync(join(dir, "packages/protocol"), { recursive: true });
    const workerSrc = join(dir, "src/computer-repl-worker.ts");
    const browserGuest = join(dir, "src/browser-use/browser-guest-library.ts");
    const protocolSrc = join(dir, "packages/protocol/index.ts");
    writeFileSync(workerSrc, "// worker\n");
    writeFileSync(browserGuest, "// guest\n");
    writeFileSync(protocolSrc, "// protocol\n");
    const { built } = writeBundle(dir, [
      "../src/computer-repl-worker.ts",
      "../src/browser-use/browser-guest-library.ts",
      "../packages/protocol/index.ts",
    ]);
    utimesSync(workerSrc, 1_000, 1_000);
    utimesSync(browserGuest, 1_000, 1_000);
    utimesSync(protocolSrc, 3_000, 3_000);
    utimesSync(built, 2_000, 2_000);
    expect(builtReplWorkerEntry(built)).toBeUndefined();

    utimesSync(protocolSrc, 1_000, 1_000);
    utimesSync(browserGuest, 3_000, 3_000);
    expect(builtReplWorkerEntry(built)).toBeUndefined();

    rmSync(browserGuest);
    expect(builtReplWorkerEntry(built)).toBeUndefined();
  });
});
