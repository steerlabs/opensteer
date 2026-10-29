import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverWorkspaceSkills } from "./workspace-skills.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("Workspace Agent Skills", () => {
  it("ignores directories that hold no SKILL.md", async () => {
    const workspace = await workspaceDirectory();
    await mkdir(join(workspace, "skills", "notes"), { recursive: true });
    await writeFile(join(workspace, "skills", "README.md"), "Not a skill\n");

    await expect(discoverWorkspaceSkills(workspace)).resolves.toMatchObject({
      skills: [],
      warnings: [],
    });
  });

  it("rejects a symlinked skill directory", async () => {
    const workspace = await workspaceDirectory();
    await writeSkill(workspace, "real", frontmatter("real"));
    await symlink(join(workspace, "skills", "real"), join(workspace, "skills", "linked"), "dir");

    const discovered = await discoverWorkspaceSkills(workspace);

    expect(discovered.skills.map(({ name }) => name)).toEqual(["real"]);
    expect(discovered.warnings).toEqual(["Workspace skill linked was skipped: it is a symlink"]);
  });

  it("rejects a symlinked SKILL.md", async () => {
    const workspace = await workspaceDirectory();
    await writeSkill(workspace, "real", frontmatter("real"));
    await mkdir(join(workspace, "skills", "linked"));
    await symlink(
      join(workspace, "skills", "real", "SKILL.md"),
      join(workspace, "skills", "linked", "SKILL.md"),
    );

    const discovered = await discoverWorkspaceSkills(workspace);

    expect(discovered.skills.map(({ name }) => name)).toEqual(["real"]);
    expect(discovered.warnings).toEqual([
      "Workspace skill linked was skipped: SKILL.md is not a regular file",
    ]);
  });

  it("rejects a frontmatter name that does not match its directory", async () => {
    const workspace = await workspaceDirectory();
    await writeSkill(workspace, "release-notes", frontmatter("something-else"));

    const discovered = await discoverWorkspaceSkills(workspace);

    expect(discovered.skills).toEqual([]);
    expect(discovered.warnings).toEqual([
      "Workspace skill release-notes was skipped: the SKILL.md frontmatter is invalid",
    ]);
  });

  it("rejects an unparseable or descriptionless frontmatter", async () => {
    const workspace = await workspaceDirectory();
    await writeSkill(workspace, "no-frontmatter", "# Just prose\n");
    await writeSkill(workspace, "no-description", "---\nname: no-description\n---\n");

    const discovered = await discoverWorkspaceSkills(workspace);

    expect(discovered.skills).toEqual([]);
    expect(discovered.warnings).toEqual([
      "Workspace skill no-description was skipped: the SKILL.md frontmatter is invalid",
      "Workspace skill no-frontmatter was skipped: the SKILL.md frontmatter is invalid",
    ]);
  });

  it("rejects malformed YAML that has a description-shaped line", async () => {
    const workspace = await workspaceDirectory();
    await writeSkill(workspace, "malformed", "---\nname: malformed\ndescription: [\n---\nBody.\n");

    const discovered = await discoverWorkspaceSkills(workspace);

    expect(discovered.skills).toEqual([]);
    expect(discovered.warnings).toEqual([
      "Workspace skill malformed was skipped: the SKILL.md frontmatter is invalid",
    ]);
  });

  it("discovers quoted YAML metadata with Windows line endings", async () => {
    const workspace = await workspaceDirectory();
    await writeSkill(
      workspace,
      "release-notes",
      '---\r\nname: "release-notes"\r\ndescription: >-\r\n  Write release notes.\r\n---\r\nBody.\r\n',
    );

    const discovered = await discoverWorkspaceSkills(workspace);

    expect(discovered.skills).toEqual([
      { name: "release-notes", path: join(workspace, "skills", "release-notes") },
    ]);
    expect(discovered.warnings).toEqual([]);
  });

  it("rejects a reserved Opensteer skill name and an invalid directory name", async () => {
    const workspace = await workspaceDirectory();
    await writeSkill(workspace, "opensteer-threads", frontmatter("opensteer-threads"));
    await writeSkill(workspace, "Release_Notes", frontmatter("Release_Notes"));

    const discovered = await discoverWorkspaceSkills(workspace);

    expect(discovered.skills).toEqual([]);
    expect(discovered.warnings).toEqual([
      "Workspace skill opensteer-threads was skipped: the opensteer- prefix is reserved for the skills Opensteer ships",
      "Workspace skill Release_Notes was skipped: the directory name is not a valid skill name",
    ]);
  });

  it("rejects an oversized SKILL.md", async () => {
    const workspace = await workspaceDirectory();
    await writeSkill(workspace, "huge", `${frontmatter("huge")}${"x".repeat(64 * 1_024)}`);

    const discovered = await discoverWorkspaceSkills(workspace);

    expect(discovered.skills).toEqual([]);
    expect(discovered.warnings).toEqual([
      "Workspace skill huge was skipped: SKILL.md is larger than 65536 bytes",
    ]);
  });

  it("loads at most 64 skills", async () => {
    const workspace = await workspaceDirectory();
    for (let index = 0; index < 65; index += 1) {
      const name = `skill-${String(index).padStart(2, "0")}`;
      await writeSkill(workspace, name, frontmatter(name));
    }

    const discovered = await discoverWorkspaceSkills(workspace);

    expect(discovered.skills).toHaveLength(64);
    expect(discovered.skills.at(-1)?.name).toBe("skill-63");
    expect(discovered.warnings).toEqual([
      "Workspace skill skill-64 was skipped: a Workspace may load at most 64 skills",
    ]);
  });
});

function frontmatter(name: string): string {
  return `---\nname: ${name}\ndescription: Test skill.\n---\n\nBody.\n`;
}

async function writeSkill(workspace: string, name: string, content: string): Promise<void> {
  const directory = join(workspace, "skills", name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), content);
}

async function workspaceDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "opensteer-workspace-skills-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
