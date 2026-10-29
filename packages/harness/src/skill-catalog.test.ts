import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderHarnessSkillCatalog } from "./skill-catalog.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("renderHarnessSkillCatalog", () => {
  it("preserves resolved order, parses YAML scalars, and omits skill bodies", async () => {
    const root = await temporaryDirectory();
    const first = await writeSkill(
      root,
      "shared",
      'name: shared\ndescription: "Workspace winner # still description"',
      "SECRET BODY",
    );
    const second = await writeSkill(
      root,
      "other",
      "name: other\ndescription: >-\n  Second skill with\n  folded lines",
      "OTHER BODY",
    );
    const catalog = await renderHarnessSkillCatalog({
      skills: [
        { name: "shared", path: first },
        { name: "other", path: second },
      ],
    });
    expect(catalog).toBe(
      `Available Agent Skills\nUse a skill when its description matches the task. Read its SKILL.md file before following it; do not read unrelated skill files.\n- shared: Workspace winner # still description\n  SKILL.md: ${join(first, "SKILL.md")}\n- other: Second skill with folded lines\n  SKILL.md: ${join(second, "SKILL.md")}`,
    );
    expect(catalog).not.toContain("SECRET BODY");
    expect(catalog).not.toContain("OTHER BODY");
  });

  it("supports literal block chomping and YAML comments", async () => {
    const root = await temporaryDirectory();
    const path = await writeSkill(
      root,
      "literal",
      "name: literal # selected name\ndescription: |-\n  First line\n  second line",
    );
    await expect(
      renderHarnessSkillCatalog({ skills: [{ name: "literal", path }] }),
    ).resolves.toContain("- literal: First line second line");
  });

  it("keeps mixed catalogs usable when selected skill metadata cannot be read", async () => {
    const root = await temporaryDirectory();
    const valid = await writeSkill(root, "valid", "name: valid\ndescription: Valid skill");
    const malformed = await writeSkill(root, "malformed", "name: malformed\ndescription: [");
    const huge = await writeSkill(
      root,
      "huge",
      "name: huge\ndescription: Fine",
      "x".repeat(65_536),
    );
    const missing = join(root, "missing");

    const catalog = await renderHarnessSkillCatalog({
      skills: [
        { name: "valid", path: valid },
        { name: "malformed", path: malformed },
        { name: "missing", path: missing },
        { name: "huge", path: huge },
      ],
    });

    expect(catalog).toContain("- valid: Valid skill");
    for (const name of ["malformed", "missing", "huge"]) {
      expect(catalog).toContain(
        `- ${name}: Metadata unavailable; inspect SKILL.md directly if this skill may apply.`,
      );
      expect(catalog).toContain(`SKILL.md: ${join(root, name, "SKILL.md")}`);
    }
  });

  it("bounds long descriptions with a visible ellipsis", async () => {
    const root = await temporaryDirectory();
    const path = await writeSkill(
      root,
      "verbose",
      `name: verbose\ndescription: ${"x".repeat(2_000)}`,
    );
    const catalog = await renderHarnessSkillCatalog({ skills: [{ name: "verbose", path }] });
    const rendered = catalog!.split("\n")[2]!.slice("- verbose: ".length);
    expect(Array.from(rendered)).toHaveLength(1_024);
    expect(rendered.endsWith("…")).toBe(true);
  });

  it("rejects relative paths and duplicate selected names as plan defects", async () => {
    await expect(
      renderHarnessSkillCatalog({ skills: [{ name: "relative", path: "skills/relative" }] }),
    ).rejects.toThrow(/absolute/u);
    await expect(
      renderHarnessSkillCatalog({
        skills: [
          { name: "same", path: "/first" },
          { name: "same", path: "/second" },
        ],
      }),
    ).rejects.toThrow(/Duplicate/u);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "opensteer-skill-catalog-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeSkill(
  root: string,
  name: string,
  metadata: string,
  body = "Body",
): Promise<string> {
  const directory = join(root, name);
  await mkdir(directory);
  await writeFile(join(directory, "SKILL.md"), `---\n${metadata}\n---\n${body}\n`);
  return directory;
}
