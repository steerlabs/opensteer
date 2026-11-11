import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createId } from "@opensteer/core";
import { TaskFolderManager } from "./task-folder.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "task-folder-")));
  temporary.push(root);
  const home = join(root, "agent");
  const cwd = join(root, "repo");
  await Promise.all([mkdir(home), mkdir(cwd)]);
  const computerId = createId("runner");
  return {
    root,
    home,
    cwd,
    location: { folder: { computerId, path: cwd }, agentHome: { computerId, path: home } },
    manager: new TaskFolderManager(computerId),
  };
}
describe("task folder execution", () => {
  it("uses the chosen cwd and grants agent-home memory access without granting the OS home", async () => {
    const f = await fixture();
    const run = await f.manager.prepare({
      location: f.location,
      signal: new AbortController().signal,
    });
    expect(run.path).toBe(f.cwd);
    expect(f.manager.writableRoots(run)).toEqual([f.cwd, f.home]);
  });
  it("loads home before folder instructions, deduplicating canonical files", async () => {
    const f = await fixture();
    await writeFile(
      join(f.home, "AGENTS.md"),
      "Standing instructions\n## Memory\nREMEMBERED_SENTINEL",
    );
    await writeFile(join(f.cwd, "AGENTS.md"), "Folder conventions");
    const prepare = () =>
      f.manager.prepare({ location: f.location, signal: new AbortController().signal });
    expect((await prepare()).instructions).toMatch(/REMEMBERED_SENTINEL[\s\S]*Folder conventions/);
    await rm(join(f.cwd, "AGENTS.md"));
    await symlink(join(f.home, "AGENTS.md"), join(f.cwd, "AGENTS.md"));
    expect((await prepare()).instructions?.match(/REMEMBERED_SENTINEL/g)).toHaveLength(1);
    const same = await f.manager.prepare({
      location: { ...f.location, folder: f.location.agentHome },
      signal: new AbortController().signal,
    });
    expect(same.instructions?.match(/REMEMBERED_SENTINEL/g)).toHaveLength(1);
  });
  it("refuses other computers, missing folders, oversized and invalid UTF-8 instructions", async () => {
    const f = await fixture();
    const signal = new AbortController().signal;
    await expect(
      f.manager.prepare({
        location: { ...f.location, folder: { computerId: createId("runner"), path: f.cwd } },
        signal,
      }),
    ).rejects.toThrow(/computer/);
    await expect(
      f.manager.prepare({
        location: {
          ...f.location,
          folder: { ...f.location.folder, path: join(f.root, "missing") },
        },
        signal,
      }),
    ).rejects.toThrow();
    await writeFile(join(f.home, "AGENTS.md"), Buffer.from([0xff]));
    await expect(f.manager.prepare({ location: f.location, signal })).rejects.toThrow(/UTF-8/);
    await writeFile(join(f.home, "AGENTS.md"), "x".repeat(100 * 1024 + 1));
    await expect(f.manager.prepare({ location: f.location, signal })).rejects.toThrow(/large/);
  });
});
