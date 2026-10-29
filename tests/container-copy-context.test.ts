import { excludedFromContext, contextPattern } from "./container-context.js";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

const generatedInputs = {
  // The public APK builder stages this verified artifact before container builds.
  "apps/web/public/agent-phone": "scripts/release-agent-phone.ts: stageAgentPhoneRelease",
};
const read = (file: string) => readFileSync(file, "utf8");

it.each([
  ["missing tracked source", "COPY missing ./", "", "", {}, /Missing.*missing/u],
  ["gcloud exclusion", "COPY tracked ./", "tracked", "", {}, /Excluded.*tracked/u],
  ["generated exclusion", "COPY phone ./", "phone", "", { phone: "producer" }, /Excluded.*phone/u],
  ["stale generated entry", "COPY tracked ./", "", "", { phone: "producer" }, /Stale.*phone/u],
  ["Docker exclusion", "COPY tracked ./", "", "tracked", {}, /Excluded.*tracked/u],
] as const)("rejects %s", (_name, recipe, upload, docker, generated, error) => {
  expect(() => check(recipe, ["tracked"], upload, docker, generated)).toThrow(error);
});
it.each(["!tracked", "**/a/**/b", "a?", "[ab]", "a/../b", "#!include:.gitignore"])(
  "rejects unsupported ignore syntax %s",
  (pattern) =>
    expect(() => check("COPY tracked ./", ["tracked"], pattern, "", {})).toThrow(/Unsupported/u),
);
it.each([
  'COPY ["tracked", "."]',
  "COPY $SOURCE ./",
  "COPY --exclude=x tracked ./",
  "COPY tracked \\\n ./",
])("rejects unsupported COPY syntax %s", (recipe) => {
  expect(() => check(recipe, ["tracked"], "", "", {})).toThrow(/Unsupported/u);
});
it("distinguishes root Docker rules from unanchored gcloud rules and matches ancestor/glob exclusions", () => {
  const files = ["nested/a.go"],
    generated = { phone: "producer" };
  const recipe = "copy --chmod=0555 nested/a.go ./\nCOPY phone ./";
  expect(() => check(recipe, files, "", "nested.go", generated)).not.toThrow();
  for (const rule of ["a.go", "**/*.go", "nested", "nested/*"]) {
    expect(() => check("COPY nested/a.go ./", ["nested/a.go"], rule, "", {})).toThrow(/Excluded/u);
  }
  expect(() => check("COPY nested/a.go ./", ["nested/a.go"], "", "a.go", {})).not.toThrow();
  expect(() => check("COPY nested/*.go ./", files, "", "**/*.go", {})).toThrow(/Excluded/u);
});
it("allows only the public env template exception in upload rules, with ordered and independent layer exclusions", () => {
  const recipe = "COPY nested/.env.example ./";
  const tracked = ["nested/.env.example"];
  const upload = ".env.*\n!**/.env.example";
  expect(() => check(recipe, tracked, upload, "", {})).not.toThrow();
  for (const [u, d] of [
    [upload + "\n.env.*", ""],
    [upload, "nested/.env.example"],
    ["nested\n" + upload, ""],
  ] as const)
    expect(() => check(recipe, tracked, u, d, {})).toThrow(/Excluded/u);
  expect(() => check(recipe, tracked, "", "!**/.env.example", {})).toThrow(/Unsupported/u);
});
it("keeps every Bake COPY source in the effective release context", () => {
  const bake = read("deploy/container/docker-bake.hcl");
  expect(bake).not.toMatch(/\/\*/u);
  const recipes = new Set(["deploy/container/Containerfile"]);
  for (const [line] of bake.matchAll(/^.*\b(?:context|dockerfile)\s*=.*$/gmu)) {
    const match = /^\s*(context|dockerfile)\s*=\s*"([\w./-]+)"\s*$/u.exec(line);
    expect(match, `Unsupported Bake context declaration: ${line}`).not.toBeNull();
    if (match![1] === "context") expect(match![2]).toBe(".");
    else recipes.add(match![2]!);
  }
  const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0");
  const upload = "";
  const sources = new Set<string>();
  for (const recipe of recipes) {
    const specific = recipe + ".dockerignore";
    const docker = read(existsSync(specific) ? specific : ".dockerignore");
    const copies = check(read(recipe), tracked, upload, docker, generatedInputs, false);
    copies.forEach((source) => sources.add(source));
  }
  for (const source of Object.keys(generatedInputs))
    expect(sources.has(source), `Stale generated input: ${source}`).toBe(true);
});

function check(
  recipe: string,
  tracked: string[],
  upload: string,
  docker: string,
  generated: Readonly<Record<string, string>>,
  checkStale = true,
): Set<string> {
  const excluded = excludedFromContext(upload, docker);
  const sources = new Set<string>();
  for (const line of recipe.split("\n").filter((line) => /^\s*COPY\b/iu.test(line))) {
    const copy =
      /^\s*COPY\s+((?:--(?:from=[\w.-]+|chmod=[0-7]{3,4}|chown=[\w:-]+)\s+)*)(.+)$/iu.exec(line);
    if (!copy || line.includes("\\")) throw new Error(`Unsupported COPY: ${line}`);
    if (copy[1]!.includes("--from=")) continue; // Stage/image sources are not context inputs.
    const tokens = copy[2]!.trim().split(/\s+/u);
    if (tokens.length < 2) throw new Error(`Unsupported COPY: ${line}`);
    for (const source of tokens.slice(0, -1)) {
      const match = contextPattern(source);
      sources.add(source);
      if (excluded(source)) throw new Error(`Excluded COPY source: ${source}`);
      if (Object.hasOwn(generated, source)) continue;
      const files = tracked.filter((name) => match.test(name));
      if (!files.length) throw new Error(`Missing tracked COPY source: ${source}`);
      if (!files.some((name) => !excluded(name)))
        throw new Error(`Excluded COPY source: ${source}`);
    }
  }
  if (checkStale)
    for (const source of Object.keys(generated)) {
      if (!sources.has(source)) throw new Error(`Stale generated input: ${source}`);
    }
  return sources;
}
