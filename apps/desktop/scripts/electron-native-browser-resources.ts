import { setFileMode } from "@opensteer/shared/privateFiles";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { personalWebBuildId } from "@opensteer/protocol";
import { writeWebDistributionManifest } from "../../../scripts/write-web-distribution-manifest.mjs";
import { stageDataTree, stageNodeService } from "./build-personal-runtime.js";
import { personalRuntimeLayout } from "./personal-runtime-layout.js";
import {
  readPersonalRuntimeRelease,
  PersonalRuntimeReleaseManifestSchema,
} from "../src/releases/personal-runtime-release.js";

// Reuse validated native distributions, but never an older Host/Runner implementation.
const source = path.resolve(z.string().min(1).parse(process.argv[2]));
const destination = path.resolve(z.string().min(1).parse(process.argv[3]));
assert.notEqual(source, destination);
const repository = path.resolve(import.meta.dirname, "../../..");
await readPersonalRuntimeRelease(path.join(source, "personal-runtime"));
await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
await cp(source, destination, { recursive: true, force: false, errorOnExist: true });
const release = path.join(destination, "personal-runtime");
const manifestPath = path.join(release, "release.json");
const manifest = PersonalRuntimeReleaseManifestSchema.parse(
  JSON.parse(await readFile(manifestPath, "utf8")),
);
const version = z
  .object({ version: z.string().min(1) })
  .parse(JSON.parse(await readFile(path.join(repository, "package.json"), "utf8"))).version;
manifest.hostVersion = version;
manifest.runnerVersion = version;
manifest.assets.webDistribution.hostVersion = version;
const rebuilt: string[] = [];
const web = path.join(release, "web");
await rm(web, { recursive: true, force: true });
await promisify(execFile)(
  "pnpm",
  ["--filter", "@opensteer/web", "exec", "vite", "build", "--outDir", web],
  { cwd: repository, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
);
await writeWebDistributionManifest({
  directory: web,
  buildId: personalWebBuildId,
  hostVersion: manifest.hostVersion,
});
manifest.files = manifest.files.filter((file) => !file.path.startsWith("web/"));
for (const entry of await readdir(web, { recursive: true, withFileTypes: true })) {
  assert(!entry.isSymbolicLink(), "Bundled web content must not contain symlinks");
  if (!entry.isFile()) continue;
  const absolute = path.join(entry.parentPath, entry.name);
  const relative = path.relative(release, absolute).split(path.sep).join("/");
  manifest.files.push({
    mode: "data",
    path: relative,
    sha256: createHash("sha256")
      .update(await readFile(absolute))
      .digest("hex"),
  });
  await setFileMode(absolute, 0o444);
  rebuilt.push(relative);
}
for (const service of ["host", "runner", "channel-runtime", "browser-harness"] as const) {
  const script = `services/${service}.mjs`;
  const launcher =
    service === "browser-harness"
      ? manifest.entrypoints.browserHarness
      : service === "channel-runtime"
        ? manifest.entrypoints.channelRuntime
        : manifest.entrypoints[service];
  for (const name of [script, launcher]) await setFileMode(path.join(release, name), 0o700);
  const artifacts = await stageNodeService(
    release,
    service,
    path.join(
      repository,
      service === "browser-harness"
        ? "apps/runner/browser-harness/browser-harness.mjs"
        : `apps/${service}/src/main.ts`,
    ),
    { script, launcher },
  );
  for (const artifact of artifacts) {
    const file = manifest.files.find((entry) => entry.path === artifact.path);
    assert(file, `Missing manifest entry ${artifact.path}`);
    file.sha256 = createHash("sha256")
      .update(await readFile(path.join(release, file.path)))
      .digest("hex");
    await setFileMode(path.join(release, file.path), file.mode === "executable" ? 0o555 : 0o444);
    rebuilt.push(file.path);
  }
}
// Agents read the shipped skills from the release, so a seed's copy would test old guidance.
const skills = path.join(release, personalRuntimeLayout.agentSkills);
await rm(skills, { recursive: true, force: true });
manifest.files = manifest.files.filter(
  (file) => !file.path.startsWith(`${personalRuntimeLayout.agentSkills}/`),
);
for (const artifact of await stageDataTree(
  path.join(repository, "apps/runner/agent-skills"),
  release,
  personalRuntimeLayout.agentSkills,
)) {
  const absolute = path.join(release, artifact.path);
  manifest.files.push({
    mode: artifact.mode,
    path: artifact.path,
    sha256: createHash("sha256")
      .update(await readFile(absolute))
      .digest("hex"),
  });
  await setFileMode(absolute, 0o444);
  rebuilt.push(artifact.path);
}
await setFileMode(manifestPath, 0o600);
await writeFile(manifestPath, JSON.stringify(manifest));
await setFileMode(manifestPath, 0o444);
await readPersonalRuntimeRelease(release);
await writeFile(
  path.join(destination, "native-smoke-provenance.json"),
  JSON.stringify(
    {
      nativeDistributionSource: source,
      sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repository,
        encoding: "utf8",
      }).trim(),
      diffSha256: createHash("sha256")
        .update(execFileSync("git", ["diff", "HEAD"], { cwd: repository }))
        .digest("hex"),
      rebuilt,
      files: manifest.files.filter((file) => rebuilt.includes(file.path)),
    },
    null,
    2,
  ),
);
