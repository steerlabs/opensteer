import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { nativeMacInputs } from "../.github/scripts/ci-changes.mjs";
import { nativeInputs, nativeInputsPath, requiredFiles } from "../scripts/ci-native-inputs.js";

const root = path.resolve(import.meta.dirname, "..");
const config = z
  .object({
    tasks: z.array(z.object({ task: z.string(), tests: z.array(z.string()).optional() })),
  })
  .parse(JSON.parse(readFileSync(path.join(root, ".github/scripts/ci-native-mac.json"), "utf8")));
const under = (file: string, input: string) => file === input || file.startsWith(`${input}/`);

// The `changes` job selects native Mac tasks from this committed list, so a script
// that gains an import must also widen what selects its task.
it("lists exactly what each native Mac task's node scripts import", async () => {
  expect(
    JSON.parse(readFileSync(nativeInputsPath, "utf8")),
    "regenerate with: pnpm exec tsx scripts/ci-native-inputs.ts",
  ).toEqual(await nativeInputs());
});

// Swift tests compare themselves with TypeScript and fixtures across the language
// boundary, e.g. through #filePath-relative paths. Any tracked file a test's string
// literal can name must select that task, or a PR could break it unseen.
it("selects each Swift test task for every repository file its tests read", () => {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const uncovered: string[] = [];
  for (const task of config.tasks) {
    const inputs = nativeMacInputs(task.task);
    const sources = tracked.filter(
      (file) =>
        file.endsWith(".swift") &&
        (task.tests ?? []).some((dir) => file.startsWith(`${dir}/Tests/`)),
    );
    for (const source of sources)
      for (const [, tail] of readFileSync(path.join(root, source), "utf8").matchAll(
        /"(?:\.\.\/)*([^"\\\s]+\/[^"\\\s/]+\.[A-Za-z0-9]+)"/gu,
      )) {
        const candidates = tracked.filter((file) => file === tail || file.endsWith(`/${tail}`));
        if (
          candidates.length &&
          !candidates.some((file) => inputs.some((input) => under(file, input)))
        )
          uncovered.push(`${task.task}: ${source} reads ${tail}`);
      }
  }
  expect(uncovered, "add the files to the task's extra in ci-native-mac.json").toEqual([]);
});

// A bundler cannot see what code loads through createRequire, so the generator reads
// the string itself, in both forms the build scripts use.
it("follows createRequire loads, assigned or called inline", () => {
  const source = `
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { signingMode } = require("./macos-release-identity.cjs");
const { signingKeychainArguments } = createRequire(import.meta.url)(
  "./signing-input.cjs",
);
const { timePhase } = createRequire(import.meta.url)("../../../scripts/release-identity.cjs");
const ws = createRequire(import.meta.url)("ws");
`;
  expect(requiredFiles("apps/desktop/scripts/build.ts", source).sort()).toEqual([
    "apps/desktop/scripts/macos-release-identity.cjs",
    "apps/desktop/scripts/signing-input.cjs",
    "scripts/release-identity.cjs",
  ]);
  expect(requiredFiles("apps/desktop/scripts/plain.ts", 'require("./a.cjs")')).toEqual([]);
});
