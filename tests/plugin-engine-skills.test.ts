import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { agentTools } from "../packages/agent-tools/src/tools/index.js";
import { pluginEngineSkillDigests } from "../packages/plugin-engine/app-templates/src/implementation/pluginEngine-skill-digests.gen.ts";

const root = "packages/plugin-engine/app-templates/pluginEngine/skills";
const files = (readdirSync(root, { recursive: true }) as string[])
  .filter((path) => path.endsWith(".md"))
  .map((path) => ({ path, text: readFileSync(join(root, path), "utf8") }));

test("the engine's skills send agents only to what Opensteer offers", () => {
  const tools = new Set(agentTools.map((tool) => tool.name));
  for (const { path, text } of files) {
    // No command-line tool or npm package ships with the engine; deploying from a shell goes
    // through Opensteer's own install tool.
    expect(text, path).not.toMatch(/`pluginEngine apps`|`pluginEngine` CLI|npm `|@beta`/u);
    expect(text, path).not.toMatch(/node_modules\/apps\//u);
    for (const [name] of text.matchAll(/\bopensteer_[a-z_]+/gu))
      expect(tools.has(name as never), `${path} names ${name}`).toBe(true);
  }
});

test("the published skill digests match the skill files", () => {
  expect(
    Object.fromEntries(
      files.map(({ path, text }) => [path, createHash("sha256").update(text).digest("hex")]),
    ),
  ).toEqual(pluginEngineSkillDigests);
});
