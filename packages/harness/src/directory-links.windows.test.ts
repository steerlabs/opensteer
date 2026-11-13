import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { linkDirectory, linkNames, materializeResource } from "./directory-links.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opensteer links ☃ "));
  roots.push(root);
  return root;
}

describe("directory links on Windows", () => {
  it("links a directory with a junction a standard user can create and remove", async () => {
    const root = await directory();
    const target = join(root, "skills", "review");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "SKILL.md"), "review\n");
    const overlay = join(root, "overlay");
    await mkdir(overlay);
    const link = join(overlay, "review");

    await linkDirectory(target, link);

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(join(link, "SKILL.md"), "utf8")).toBe("review\n");
    expect(await linkNames(link, target)).toBe(true);
    // Windows paths name one place whatever their case or namespace form.
    expect(await linkNames(link, target.toUpperCase())).toBe(true);
    expect(await linkNames(link, `\\\\?\\${target}`)).toBe(true);
    expect(await linkNames(link, join(root, "skills"))).toBe(false);

    // Removing the overlay removes the junction and leaves its target whole.
    await rm(overlay, { force: true, recursive: true });
    expect(await readFile(join(target, "SKILL.md"), "utf8")).toBe("review\n");
  });

  it("refuses to replace an entry another setup created first", async () => {
    const root = await directory();
    const target = join(root, "target");
    await mkdir(target);
    const link = join(root, "link");
    const results = await Promise.allSettled([0, 1, 2].map(() => linkDirectory(target, link)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected")
        expect((result.reason as NodeJS.ErrnoException).code).toBe("EEXIST");
    }
    expect(await linkNames(link, target)).toBe(true);
  });

  it("copies a file resource and links a directory resource", async () => {
    const root = await directory();
    const skill = join(root, "skill");
    await mkdir(join(skill, "scripts"), { recursive: true });
    await writeFile(join(skill, "notes.md"), "notes\n");
    await writeFile(join(skill, "scripts", "run.ps1"), "Write-Output hi\n");
    const materialized = join(root, "materialized");
    await mkdir(materialized);

    await materializeResource(join(skill, "notes.md"), join(materialized, "notes.md"));
    await materializeResource(join(skill, "scripts"), join(materialized, "scripts"));

    const file = await lstat(join(materialized, "notes.md"));
    expect(file.isFile() && !file.isSymbolicLink()).toBe(true);
    expect(await readFile(join(materialized, "notes.md"), "utf8")).toBe("notes\n");
    expect((await lstat(join(materialized, "scripts"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(materialized, "scripts"))).toMatch(/scripts\\?$/u);
    expect(await readFile(join(materialized, "scripts", "run.ps1"), "utf8")).toBe(
      "Write-Output hi\n",
    );

    await rm(materialized, { force: true, recursive: true });
    expect(await readFile(join(skill, "scripts", "run.ps1"), "utf8")).toBe("Write-Output hi\n");
    expect(await readFile(join(skill, "notes.md"), "utf8")).toBe("notes\n");
  });
});
