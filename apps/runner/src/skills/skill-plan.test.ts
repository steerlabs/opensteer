import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveSkillPlan } from "./skill-plan.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
it("loads bundled, plugin, home and folder skills, with folder-name precedence and canonical-source dedupe", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "skill-plan-")));
  roots.push(root);
  const paths = ["bundled", "plugin", "home", "folder", "alias"].map((p) => join(root, p));
  await Promise.all(paths.slice(0, 4).map((p) => mkdir(p)));
  await symlink(paths[0]!, paths[4]!);
  const skill = (path: string, fullName: string, plugin: string | null = null) => ({
    path,
    fullName,
    plugin,
    localName: fullName.split(":").at(-1)!,
  });
  const plan = await resolveSkillPlan({
    bundled: [skill(paths[0]!, "opensteer:memory", "opensteer")],
    integration: [skill(paths[1]!, "plugin:research", "plugin")],
    home: [skill(paths[2]!, "research"), skill(paths[4]!, "memory-copy")],
    folder: [skill(paths[3]!, "research")],
  });
  expect(plan?.skills.map((s) => s.path)).toEqual([paths[0], paths[1], paths[3]]);
  expect(plan?.skills.map((s) => s.fullName)).toEqual([
    "opensteer:memory",
    "plugin:research",
    "research",
  ]);
});
