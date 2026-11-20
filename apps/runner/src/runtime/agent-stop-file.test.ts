import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { agentStopFile, manualAgentWork, watchAgentStopFile } from "./agent-stop-file.js";

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

it("hears the saved Stop change, with the time the person stopped agents", async () => {
  const path = join(root, "local-stop.json");
  const watched = watchAgentStopFile(path, { checkMs: 20 });
  const changed = vi.fn();
  watched.subscribe(changed);
  try {
    expect(watched.stopped()).toBe(false);
    expect(watched.stoppedAt()).toBeNull();
    await writeFile(path, JSON.stringify({ stopped: true, at: "2026-11-20T10:42:00.000Z" }));
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(watched.stopped()).toBe(true);
    expect(watched.stoppedAt()?.toISOString()).toBe("2026-11-20T10:42:00.000Z");
    await writeFile(path, JSON.stringify({ stopped: false, at: null }));
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
    expect(watched.stoppedAt()).toBeNull();
  } finally {
    watched.close();
  }
});

it("takes a Stop set by the app that supervises this Runner, announcing only changes", () => {
  const work = manualAgentWork();
  const changed = vi.fn();
  work.subscribe(changed);
  work.set(true, new Date("2026-11-20T10:42:00.000Z"));
  work.set(true);
  expect(changed).toHaveBeenCalledOnce();
  expect(work.stoppedAt()?.toISOString()).toBe("2026-11-20T10:42:00.000Z");
  work.set(false);
  expect(work.stopped()).toBe(false);
  expect(changed).toHaveBeenCalledTimes(2);
});
