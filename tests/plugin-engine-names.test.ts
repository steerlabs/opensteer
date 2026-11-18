import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expect, test } from "vitest";
import { checkNames, nameViolations } from "../scripts/plugin-engine/names.mjs";
import names from "../packages/plugin-engine/upstream-names.json" with { type: "json" };

const root = resolve(import.meta.dirname, "..");
// Every form comes from the data file; this file names none itself.
const [domain] = names.identity.everywhere as [string];
const [bare] = names.identity.pluginCode as [string];
const header = names.rules.find((rule) => rule.scope === "header")!.from;

test("the repository names upstream only in its rules data and notices", () => {
  expect(() => checkNames(root)).not.toThrow();
});

test("fails wherever an old string is added, and only there", async (context) => {
  const repository = await mkdtemp(join(tmpdir(), "opensteer-names-"));
  context.onTestFinished(() => rm(repository, { recursive: true, force: true }));
  const write = async (path: string, content: string) => {
    await mkdir(dirname(join(repository, path)), { recursive: true });
    await writeFile(join(repository, path), content);
  };
  await cp(
    join(root, "packages/plugin-engine/upstream-names.json"),
    join(repository, "packages/plugin-engine/upstream-names.json"),
  );
  await write("THIRD_PARTY_NOTICES.md", `Derived from https://${domain}/.\n`);
  await write("README.md", `ok\nSee https://${domain}/docs.\n`);
  await write("apps/runner/src/headers.ts", `const name = "${header}";\n`);
  // The bare word is ordinary English outside plugin code, and a longer word is not a form.
  await write("apps/runner/src/queue.ts", `const ${bare} = pool; ${bare}.shutdown();\n`);
  await write("packages/plugin-engine/sdk/src/run.ts", `// ${bare} runs it\n`);
  await write("apps/host/src/plugins/name.ts", `export const name = "${bare.toUpperCase()}";\n`);
  await write("tests/plugin-flow.test.ts", `test("${bare}", () => {});\n`);
  await write(`scripts/plugin-engine/${bare}.ts`, "export {};\n");
  await write(`docs/${domain}.md`, "A page.\n");
  execFileSync("git", ["init", "-q"], { cwd: repository });
  // Tracked and unignored untracked files are both read.
  execFileSync("git", ["add", "README.md", "apps"], { cwd: repository });

  expect(nameViolations(repository).sort()).toEqual(
    [
      "README.md:2",
      "apps/host/src/plugins/name.ts:1",
      "apps/runner/src/headers.ts:1",
      `docs/${domain}.md`,
      "packages/plugin-engine/sdk/src/run.ts:1",
      `scripts/plugin-engine/${bare}.ts`,
      "tests/plugin-flow.test.ts:1",
    ].sort(),
  );
  expect(() => checkNames(repository)).toThrow(/forbidden/u);
});
