import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createId } from "@opensteer/core";
import { AgentHomeManager } from "./agent-home.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-home-")));
  temporary.push(root);
  const path = join(root, "Opensteer");
  await mkdir(path);
  const computerId = createId("runner");
  return { root, agentHome: { computerId, path }, manager: new AgentHomeManager(computerId) };
}
const signal = () => new AbortController().signal;

describe("Agent home", () => {
  it("works in Agent home and loads its instructions only with personal context", async () => {
    const f = await fixture();
    await writeFile(join(f.agentHome.path, "AGENTS.md"), "PERSONAL_MEMORY_SENTINEL");
    const personal = await f.manager.prepare({ agentHome: f.agentHome, signal: signal() });
    expect(personal.path).toBe(f.agentHome.path);
    expect(personal.instructions).toContain("PERSONAL_MEMORY_SENTINEL");
    const shared = await f.manager.prepare({
      agentHome: f.agentHome,
      personalContext: false,
      signal: signal(),
    });
    expect(shared.instructions).toBeUndefined();
  });

  it("refuses an Agent home that now resolves elsewhere instead of following it", async () => {
    const f = await fixture();
    const elsewhere = join(f.root, "elsewhere");
    await mkdir(elsewhere);
    await rename(f.agentHome.path, join(f.root, "moved"));
    await symlink(elsewhere, f.agentHome.path);
    await expect(f.manager.prepare({ agentHome: f.agentHome, signal: signal() })).rejects.toThrow(
      /now resolves to/,
    );
  });

  it("resolves app folders only inside Agent home, refusing a symlink that leads out", async () => {
    const f = await fixture();
    const app = join(f.agentHome.path, "dashboard");
    await mkdir(app);
    expect(await f.manager.folder({ ...f.agentHome, path: app }, f.agentHome)).toBe(app);
    const outside = join(f.root, "outside");
    await mkdir(outside);
    const escape = join(f.agentHome.path, "escape");
    await symlink(outside, escape);
    await expect(f.manager.folder({ ...f.agentHome, path: escape }, f.agentHome)).rejects.toThrow(
      /outside Agent home/,
    );
  });

  it("refuses other computers, a missing folder, and oversized or invalid instructions", async () => {
    const f = await fixture();
    await expect(
      f.manager.prepare({
        agentHome: { ...f.agentHome, computerId: createId("runner") },
        signal: signal(),
      }),
    ).rejects.toThrow(/hosting computer/);
    await expect(
      f.manager.prepare({
        agentHome: { ...f.agentHome, path: join(f.root, "missing") },
        signal: signal(),
      }),
    ).rejects.toThrow(/missing/);
    await writeFile(join(f.agentHome.path, "AGENTS.md"), Buffer.from([0xff]));
    await expect(f.manager.prepare({ agentHome: f.agentHome, signal: signal() })).rejects.toThrow(
      /UTF-8/,
    );
    await writeFile(join(f.agentHome.path, "AGENTS.md"), "x".repeat(100 * 1024 + 1));
    await expect(f.manager.prepare({ agentHome: f.agentHome, signal: signal() })).rejects.toThrow(
      /large/,
    );
  });
});
