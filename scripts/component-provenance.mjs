import { execFileSync } from "node:child_process";
import { globSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { parse as parseYaml } from "yaml";

export const componentNames = [
  "browser-egress",
  "browser-profile-gateway",
  "browser-runtime",
  "channel-runtime",
  "control-plane",
  "gateway",
  "host",
  "runner",
];
const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const provenanceIdentity = z.strictObject({
  sourceRevision: sha,
  version: z
    .string()
    .max(79)
    .regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u)
    .refine((value) => value !== "0.0.0"),
});
export const builderSchema = z.strictObject({
  kind: z.literal("google-cloud-build"),
  project: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u),
  buildId: z.uuid(),
  sourceRevision: sha,
  configPath: z.string().min(1),
});
export const componentRecordSchema = z.strictObject({
  identity: provenanceIdentity,
  builder: builderSchema,
  inputSetHash: hash,
  recipeHash: hash,
  compatibilityHash: hash,
  platform: z.literal("linux/amd64"),
  inputManifest: z.strictObject({
    schemaVersion: z.literal(1),
    platform: z.literal("linux/amd64"),
    compilationEnvironment: z.record(z.string(), z.string()),
    inputs: z
      .array(
        z.tuple([
          z
            .string()
            .refine(
              (value) =>
                !value.startsWith("/") &&
                !value.split("/").some((part) => [".", "..", ""].includes(part)),
            ),
          z.enum(["100644", "100755", "120000"]),
          z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
        ]),
      )
      .refine((entries) => new Set(entries.map((entry) => entry[0])).size === entries.length),
  }),
  phone: z
    .strictObject({ receiptSha256: hash, receipt: z.record(z.string(), z.unknown()) })
    .nullable(),
  runnerSmoke: z.boolean(),
});
export const provenanceSchema = z.strictObject({
  record: componentRecordSchema,
  recordHash: hash,
  retainedFrom: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/u)
    .nullable(),
});
export function recordHash(record) {
  return createHash("sha256")
    .update(JSON.stringify(sort(record)))
    .digest("hex");
}
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sort(value[key])]),
  );
}
function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

// Every package and build script is a conservative shared input. App boundaries
// are explicit because runtime copies and dynamic imports escape TS import graphs.
export function componentInputs(root, revision, runnerSourceRevision = revision) {
  sha.parse(runnerSourceRevision);
  sha.parse(revision);
  const entries = git(root, ["ls-tree", "-r", "-z", revision])
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+) (blob|commit) ([a-f0-9]{40})\t(.+)$/su.exec(line);
      if (!match || match[2] !== "blob") throw new Error("Unsupported release input tree entry");
      const [, mode, , blob, name] = match;
      if (name === "package.json") {
        const manifest = JSON.parse(git(root, ["show", `${revision}:package.json`]));
        delete manifest.version;
        return [name, mode, recordHash(manifest)];
      }
      return [name, mode, blob];
    })
    .sort((a, b) => a[0].localeCompare(b[0], "en"));
  const recipeHash = recordHash(
    entries.filter(
      ([name]) =>
        name.startsWith("deploy/container/") ||
        name.startsWith("scripts/") ||
        /^(?:pnpm|package\.json|\.npmrc|tsconfig|patches\/)/u.test(name),
    ),
  );
  const compatibilityHash = recordHash(
    entries.filter(([name]) =>
      /^packages\/(?:protocol|core|database|control-plane-protocol|channel-protocol|runner-auth)\//u.test(
        name,
      ),
    ),
  );
  const result = {};
  for (const component of componentNames) {
    const apps =
      component === "host"
        ? ["host", "web", "browser-extension", "agent-phone", "runner", "channel-runtime"]
        : component === "gateway"
          ? ["web", "browser-extension", "agent-phone", "runner"]
          : component === "browser-egress"
            ? ["browser-runtime"]
            : component === "browser-profile-gateway"
              ? []
              : [component];
    const inputs = entries.filter(([name]) => {
      if (
        /^(?:docs\/|tests\/|\.github\/)/u.test(name) ||
        name === "AGENTS.md" ||
        /(?:^|\/)\.env(?:\.|$)/u.test(name)
      )
        return false;
      if (!name.startsWith("apps/")) return true;
      if (
        !/^(?:apps\/(?:host|web|agent-phone|runner|browser-runtime|channel-runtime|control-plane|desktop|mobile|browser-extension)\/)/u.test(
          name,
        )
      )
        return true;
      return apps.some((app) => name.startsWith(`apps/${app}/`));
    });
    const inputManifest = {
      schemaVersion: 1,
      platform: "linux/amd64",
      inputs,
      compilationEnvironment: ["host", "gateway"].includes(component)
        ? { OPENSTEER_RUNNER_SOURCE_REVISION: runnerSourceRevision }
        : {},
    };
    result[component] = {
      inputManifest,
      inputSetHash: recordHash(inputManifest),
      recipeHash,
      compatibilityHash,
    };
  }
  return result;
}

export function planComponents(selectedInputs, baseline, baselineDigest) {
  const inputs = structuredClone(selectedInputs);
  const priorRunner = provenanceSchema.safeParse(baseline?.provenance?.runner);
  const retainRunner =
    baseline?.schemaVersion === 3 &&
    baselineDigest &&
    priorRunner.success &&
    priorRunner.data.recordHash === recordHash(priorRunner.data.record) &&
    ["inputSetHash", "recipeHash", "compatibilityHash"].every(
      (key) => priorRunner.data.record[key] === inputs.runner[key],
    );
  const runnerSourceRevision = retainRunner
    ? priorRunner.data.record.identity.sourceRevision
    : inputs.host.inputManifest.compilationEnvironment.OPENSTEER_RUNNER_SOURCE_REVISION;
  for (const name of ["host", "gateway"]) {
    inputs[name].inputManifest.compilationEnvironment = {
      OPENSTEER_RUNNER_SOURCE_REVISION: runnerSourceRevision,
    };
    inputs[name].inputSetHash = recordHash(inputs[name].inputManifest);
  }
  const retained = {};
  const build = [];
  for (const name of componentNames) {
    const parsed = provenanceSchema.safeParse(baseline?.provenance?.[name]);
    if (
      baseline?.schemaVersion === 3 &&
      parsed.success &&
      baselineDigest &&
      parsed.data.recordHash === recordHash(parsed.data.record) &&
      ["inputSetHash", "recipeHash", "compatibilityHash"].every(
        (key) => parsed.data.record[key] === inputs[name][key],
      )
    ) {
      retained[name] = { ...parsed.data, retainedFrom: baselineDigest };
    } else build.push(name);
  }
  return {
    schemaVersion: 1,
    inputs,
    build,
    retained,
    runnerSourceRevision,
    baselineDigest: baselineDigest ?? null,
  };
}

const inputProofSchema = componentRecordSchema.pick({
  inputSetHash: true,
  recipeHash: true,
  compatibilityHash: true,
  inputManifest: true,
});
export const buildPlanSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    runnerSourceRevision: sha,
    inputs: z.record(z.enum(componentNames), inputProofSchema),
    build: z.array(z.enum(componentNames)),
    retained: z.partialRecord(z.enum(componentNames), provenanceSchema),
    baselineDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/u)
      .nullable(),
    baseline: z.unknown().optional(),
  })
  .superRefine((value, context) => {
    const selected = [...value.build, ...Object.keys(value.retained)].sort();
    if (JSON.stringify(selected) !== JSON.stringify([...componentNames].sort()))
      context.addIssue({
        code: "custom",
        message: "Plan must partition every component exactly once",
      });
    for (const name of ["host", "gateway"])
      if (
        value.inputs[name].inputManifest.compilationEnvironment.OPENSTEER_RUNNER_SOURCE_REVISION !==
        value.runnerSourceRevision
      )
        context.addIssue({ code: "custom", message: "Plan Runner reference input mismatch" });
    for (const name of componentNames) {
      if (recordHash(value.inputs[name].inputManifest) !== value.inputs[name].inputSetHash)
        context.addIssue({ code: "custom", message: "Plan input manifest hash mismatch" });
      const prior = value.retained[name];
      if (
        prior &&
        (prior.recordHash !== recordHash(prior.record) ||
          prior.retainedFrom !== value.baselineDigest ||
          ["inputSetHash", "recipeHash", "compatibilityHash"].some(
            (key) => prior.record[key] !== value.inputs[name][key],
          ))
      )
        context.addIssue({ code: "custom", message: "Retained plan proof mismatch" });
    }
  });

export function verifyInputManifests(root, inputs) {
  const seen = new Map();
  for (const proof of Object.values(inputs))
    for (const [name, mode, expected] of proof.inputManifest.inputs) {
      if (seen.has(name)) {
        if (seen.get(name) !== mode + ":" + expected)
          throw new Error("Conflicting input manifest entries");
        continue;
      }
      const file = path.join(root, name);
      const metadata = lstatSync(file);
      const bytes = metadata.isSymbolicLink()
        ? Buffer.from(readlinkSync(file))
        : readFileSync(file);
      const actualMode = metadata.isSymbolicLink()
        ? "120000"
        : metadata.mode & 0o111
          ? "100755"
          : "100644";
      let actual;
      if (name === "package.json") {
        const manifest = JSON.parse(bytes);
        delete manifest.version;
        actual = recordHash(manifest);
      } else
        actual = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
      if (actual !== expected || actualMode !== mode)
        throw new Error("Source bytes differ from selected input manifest: " + name);
      seen.set(name, mode + ":" + expected);
    }
}

function containerStages(recipe) {
  const stages = new Map();
  let current;
  for (const line of recipe.split("\n")) {
    if (/^FROM\b/iu.test(line.trim())) {
      const match =
        /^FROM[ \t]+(?:--platform=\S+[ \t]+)?\S+[ \t]+AS[ \t]+([a-z0-9][a-z0-9_.-]*)$/iu.exec(
          line.trim(),
        );
      if (!match) throw new Error(`Unsupported Containerfile FROM line: ${line}`);
      current = match[1].toLowerCase();
      if (stages.has(current)) throw new Error(`Containerfile repeats duplicate stage ${current}`);
      stages.set(current, "");
    } else if (current) {
      stages.set(current, stages.get(current) + line + "\n");
    }
  }
  return stages;
}

export function verifyDependencyManifestCopies(
  root,
  recipe = readFileSync(path.join(root, "deploy/container/Containerfile"), "utf8"),
) {
  const { packages } = z
    .object({ packages: z.array(z.string().min(1)).nonempty() })
    .parse(parseYaml(readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8")));
  const actual = [
    ...globSync(
      packages
        .filter((pattern) => !pattern.startsWith("!"))
        .map((pattern) => `${pattern}/package.json`),
      {
        cwd: root,
        exclude: packages
          .filter((pattern) => pattern.startsWith("!"))
          .map((pattern) => `${pattern.slice(1)}/package.json`),
      },
    ),
  ].sort();
  const manifestCopies = (source) =>
    [...source.matchAll(/^COPY (\S+\/package\.json) \.\/\1$/gmu)].map((match) => match[1]);
  const stages = containerStages(recipe);
  for (const stage of ["dependencies", "web-assets"]) {
    const declared = manifestCopies(stages.get(stage) ?? "");
    const missing = actual.filter(
      (name) => declared.filter((value) => value === name).length !== 1,
    );
    const unexpected = declared.filter((name) => !actual.includes(name));
    if (!stages.has(stage) || missing.length || unexpected.length)
      throw new Error(
        `Container dependency manifest copies differ from workspace manifests in ${stage}: ${[...missing, ...unexpected].join(", ")}`,
      );
  }
  const declared = manifestCopies(recipe);
  const extra = declared.filter(
    (name) => !actual.includes(name) || declared.filter((value) => value === name).length !== 2,
  );
  if (extra.length)
    throw new Error(
      `Container dependency manifest copies differ from workspace manifests outside install stages: ${[...new Set(extra)].join(", ")}`,
    );
  return actual;
}
