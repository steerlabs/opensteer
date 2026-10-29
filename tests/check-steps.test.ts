import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { checkPhases, checkRecipe } from "../scripts/check.js";
import { runCheckSteps } from "../scripts/check.js";

/*
 * Ways `pnpm check`'s steps can go wrong once the static ones overlap, driven
 * through real pnpm scripts:
 * - typecheck and build, or lint and format:check, still run one after another;
 * - prettier or oxlint walks the tree while the build stages files in it;
 * - tests start before the build they may read has finished;
 * - a failed static step lets the five-minute test step run, or is hidden;
 * - a failed step leaves its sibling running to the end, or past the run;
 * - steps' output interleaves, so a failure cannot be read;
 * - the recipe changes, invalidating every existing receipt, or drops a step.
 */

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A fixture whose `failing` step fails, and whose `slow` step runs 20 s unless stopped. */
async function project(failing?: string, slow?: string) {
  const root = await mkdtemp(path.join(tmpdir(), "opensteer-check-steps-"));
  roots.push(root);
  const events = path.join(root, "events");
  await writeFile(events, "");
  // Each step records its start and end, and ends only once its siblings have started.
  await writeFile(
    path.join(root, "step.cjs"),
    `const fs = require("node:fs");
const [name, ...siblings] = process.argv.slice(2);
const events = ${JSON.stringify(events)};
fs.appendFileSync(events, "start " + name + "\\n");
console.log(name + " line one");
console.error(name + " line two");
const deadline = Date.now() + 20000;
const wait = () => {
  const recorded = fs.readFileSync(events, "utf8").split("\\n");
  if (siblings.some((sibling) => !recorded.includes("start " + sibling))) {
    if (Date.now() > deadline) { console.error(name + " ran alone"); process.exit(3); }
    return setTimeout(wait, 20);
  }
  console.log(name + " line three");
  setTimeout(() => {
    fs.appendFileSync(events, "end " + name + "\\n");
    process.exit(name === ${JSON.stringify(failing ?? "")} ? 1 : 0);
  }, name === ${JSON.stringify(slow ?? "")} ? 20000 : 0);
};
wait();
`,
  );
  const step = (name: string, siblings: readonly string[]) =>
    ["node", "step.cjs", name, ...siblings].join(" ");
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "check-steps-fixture",
      private: true,
      scripts: {
        typecheck: step("typecheck", ["build"]),
        build: step("build", ["typecheck"]),
        lint: step("lint", ["format:check"]),
        "format:check": step("format:check", ["lint"]),
        test: step("test", []),
      },
    }),
  );
  let printed = "";
  const run = () =>
    runCheckSteps({
      root,
      signal: new AbortController().signal,
      write: (text) => {
        printed += text;
      },
    });
  const recorded = async () => (await readFile(events, "utf8")).split("\n").filter(Boolean);
  return { run, recorded, printed: () => printed };
}

it("keeps the recipe, its order and every step", () => {
  expect(checkRecipe).toEqual(["typecheck", "build", "lint", "format:check", "test"]);
  expect(checkPhases.flat()).toEqual(checkRecipe);
});

it(
  "overlaps typecheck with the build, then the tree walkers, then tests",
  { timeout: 60_000 },
  async () => {
    const p = await project();
    await p.run();
    const events = await p.recorded();
    const statics = ["typecheck", "build", "lint", "format:check"];
    const at = (event: string) => events.indexOf(event);
    expect(events.slice(0, 2).sort()).toEqual(["start build", "start typecheck"]);
    for (const walker of ["lint", "format:check"])
      expect(at(`start ${walker}`)).toBeGreaterThan(Math.max(at("end build"), at("end typecheck")));
    expect(at("start test")).toBeGreaterThan(Math.max(...statics.map((name) => at(`end ${name}`))));
    // Each step's output prints whole, under its name, never interleaved with a sibling's.
    const blocks = new Map(
      [
        ...p
          .printed()
          .matchAll(
            /^pnpm (\S+) (?:passed|failed) after \d+ s:\n([\s\S]*?)(?=^pnpm \S+ (?:passed|failed) after |^pnpm test$|(?![\s\S]))/gmu,
          ),
      ].map((match): [string, string] => [match[1] ?? "", match[2] ?? ""]),
    );
    expect([...blocks.keys()].sort()).toEqual([...statics].sort());
    for (const name of statics) {
      expect(blocks.get(name)).toContain(
        `${name} line one\n${name} line two\n${name} line three\n`,
      );
      for (const other of statics.filter((candidate) => candidate !== name))
        expect(blocks.get(name)).not.toMatch(new RegExp(`^${other} line`, "mu"));
    }
  },
);

it(
  "reports a failed static step with its output and never starts the tests",
  { timeout: 60_000 },
  async () => {
    const p = await project("lint", "format:check");
    const started = Date.now();
    await expect(p.run()).rejects.toThrow(/^pnpm lint failed; output above$/u);
    // The failure stops the slow sibling instead of waiting out its 20 s.
    expect(Date.now() - started).toBeLessThan(15_000);
    const events = await p.recorded();
    expect(events).not.toContain("start test");
    expect(events).not.toContain("end format:check");
    for (const name of ["typecheck", "build"]) expect(events).toContain(`end ${name}`);
    expect(p.printed()).toMatch(/lint line one\nlint line two\nlint line three/u);
    expect(p.printed()).toMatch(/^pnpm format:check stopped after \d+ s \(pnpm lint failed\):$/mu);
  },
);
