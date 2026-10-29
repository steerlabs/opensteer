import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { nativeInputs, nativeInputsPath } from "../scripts/ci-native-inputs.js";

const root = path.resolve(import.meta.dirname, "..");
const config = z
  .object({
    ciInputs: z.array(z.string()),
    nodeInputs: z.array(z.string()),
    tasks: z.array(
      z.object({
        task: z.string(),
        swift: z.array(z.string()),
        tests: z.array(z.string()).optional(),
        scripts: z.array(z.string()).optional(),
        extra: z.array(z.string()).optional(),
      }),
    ),
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
  const imports = JSON.parse(readFileSync(nativeInputsPath, "utf8")) as Record<string, string[]>;
  const uncovered: string[] = [];
  for (const task of config.tasks) {
    const inputs = [
      ...config.ciInputs,
      ...task.swift,
      ...(task.extra ?? []),
      ...(task.scripts?.length ? [...config.nodeInputs, ...(imports[task.task] ?? [])] : []),
    ];
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
