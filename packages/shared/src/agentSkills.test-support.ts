import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
export async function collisionSkills(root: string) {
  const skills = await Promise.all(
    ["alpha", "beta", null].map(async (plugin) => {
      const localName = "review";
      const fullName = plugin ? `${plugin}:${localName}` : localName;
      const path = join(root, "collision-skills", plugin ?? "loose", localName);
      await mkdir(path, { recursive: true });
      await writeFile(
        join(path, "SKILL.md"),
        `---\nname: ${localName}\ndescription: ${fullName} workflow\n---\nPrivate ${fullName} body.\n`,
      );
      return { plugin, localName, fullName, path };
    }),
  );
  return { skills };
}
