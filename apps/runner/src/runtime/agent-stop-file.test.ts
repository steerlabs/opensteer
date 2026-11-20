import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { agentStopFile } from "./agent-stop-file.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-stop-file-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("follows the saved Stop at each read, and holds it when the file cannot be understood", async () => {
  const path = join(root, "local-stop.json");
  const stopped = agentStopFile(path);
  expect(stopped()).toBe(false);
  await writeFile(path, JSON.stringify({ stopped: true, at: new Date().toISOString() }));
  expect(stopped()).toBe(true);
  await writeFile(path, JSON.stringify({ stopped: false, at: null }));
  expect(stopped()).toBe(false);
  await writeFile(path, "{not json");
  expect(stopped()).toBe(true);
  await writeFile(path, JSON.stringify({ paused: true }));
  expect(stopped()).toBe(true);
});

it("treats a Stop file it cannot open as stopped", async () => {
  const path = join(root, "local-stop.json");
  await mkdir(path);
  expect(agentStopFile(path)()).toBe(true);
});
