import assert from "node:assert/strict";
/** Build only: deliberately imports no install, stage or launch entry point. */
import { readFile, mkdir, writeFile, access, copyFile } from "node:fs/promises";
import { journeyWorkDirectory } from "./work-directory.js";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { createRequire } from "node:module";
import { journeySigning } from "./signing.js";
import { createHash } from "node:crypto";
import { commandEvidence, pruneCompletedBuild } from "./build-cleanup.js";
import { compareStableVersions } from "../engines.js";
import { numericVersion } from "./evidence.js";
import {
  buildAgentPhoneRelease,
  preflightAgentPhone,
  stageAgentPhoneRelease,
} from "../release-agent-phone.js";
import { localInstallConfigSchema } from "../install-beta-mac-local.js";
import { acquireReleaseLock, runBounded, timedCommands } from "../command-runner.js";

const { values } = parseArgs({
  options: {
    revision: { type: "string" },
    version: { type: "string" },
    "base-sha": { type: "string" },
    "base-version": { type: "string" },
    channel: { type: "string", default: "stable" },
    config: { type: "string" },
  },
});
const revision = z
  .string()
  .regex(/^[a-f0-9]{40}$/u)
  .parse(values.revision);
const channel = z.enum(["stable", "beta"]).parse(values.channel);
const baseSha = z
  .string()
  .regex(/^[a-f0-9]{40}$/u)
  .parse(values["base-sha"]);
const baseVersion = numericVersion.parse(values["base-version"]);
const feed = `https://github.com/steerlabs/opensteer#${channel === "stable" ? "latest" : "insider"}`;
process.env.OPENSTEER_DESKTOP_SIGNING_FILE ??= path.join(
  homedir(),
  ".config/opensteer/desktop-signing.json",
);
const signing = journeySigning();
const root = path.resolve(import.meta.dirname, "../..");
const directory = path.join(journeyWorkDirectory(), "builds", revision, channel);
await mkdir(directory, { recursive: true, mode: 0o700 });
const config = localInstallConfigSchema.parse(
  JSON.parse(
    await readFile(
      values.config ?? path.join(homedir(), ".config/opensteer/install-beta-mac-local.json"),
      "utf8",
    ),
  ),
);
const stop = new AbortController();
const interrupt = () => stop.abort(new Error("Build interrupted"));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const timed = timedCommands(path.join(directory, "commands.jsonl"), runBounded);
const source = path.join(directory, "source");
const phoneArtifacts = path.join(directory, "agent-phone");
const run = (
  exe: string,
  args: readonly string[],
  options: Parameters<typeof runBounded>[2] = {},
) =>
  timed(exe, args, {
    ...options,
    signal: stop.signal,
    env: {
      ...process.env,
      ...options.env,
      OPENSTEER_DESKTOP_SIGNING_FILE:
        process.env.OPENSTEER_DESKTOP_SIGNING_FILE ??
        path.join(homedir(), ".config/opensteer/desktop-signing.json"),
      OPENSTEER_PASSWORDS_PROVISIONING_PROFILE: config.mac.passwordsProvisioningProfile,
      OPENSTEER_DESKTOP_DEFER_NOTARIZATION: undefined,
    },
  });
const started = Date.now();
const unlock = await acquireReleaseLock(path.join(directory, "build.lock"));
try {
  if (await run("git", ["status", "--porcelain"], { cwd: root }))
    throw new Error("Checkout must be clean");
  const snapshotExists = await access(source).then(
    () => true,
    () => false,
  );
  if (!snapshotExists)
    await run("git", ["worktree", "add", "--detach", source, revision], { cwd: root });
  if ((await run("git", ["rev-parse", "HEAD"], { cwd: source })) !== revision)
    throw new Error("Frozen build source changed");
  assert.equal(
    await run("git", ["rev-parse", "HEAD^"], { cwd: source }),
    baseSha,
    "N+1 must be a direct scratch bump",
  );
  assert.equal(
    await run("git", ["diff", "--name-only", baseSha, revision], { cwd: source }),
    "package.json",
  );
  const parent = z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(await run("git", ["show", `${baseSha}:package.json`], { cwd: source })));
  const bumped = z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(await readFile(path.join(source, "package.json"), "utf8")));
  assert(
    compareStableVersions(numericVersion.parse(bumped.version), baseVersion) > 0,
    "Scratch version must advance the draft",
  );
  assert.deepEqual(
    { ...bumped, version: parent.version },
    parent,
    "Scratch commit may change only root version",
  );
  const helperPath = path.join(source, "scripts/release-version.cjs");
  const { deriveReleaseVersion, stampReleaseVersion } = createRequire(import.meta.url)(
    helperPath,
  ) as typeof import("../release-version.cjs");
  const version = numericVersion.parse(
    values.version ?? deriveReleaseVersion({ repositoryRoot: source, revision }),
  );
  assert(compareStableVersions(version, baseVersion) > 0);
  stampReleaseVersion(source, revision, version);
  await run("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], {
    cwd: source,
    timeoutMs: 300_000,
  });
  const phone = {
    sourceDirectory: source,
    artifactDirectory: phoneArtifacts,
    identity: { sourceRevision: revision, version },
    signal: stop.signal,
    run,
  };
  await preflightAgentPhone(config.agentPhone, phone);
  const phoneReceipt = await buildAgentPhoneRelease(config.agentPhone, phone);
  await stageAgentPhoneRelease(
    config.agentPhone,
    phone,
    phoneReceipt,
    path.join(source, "apps/desktop/generated-resources/agent-phone"),
  );
  const scratch = path.join(directory, "ci-build");
  await run("pnpm", ["desktop:build-release", "--out", scratch], {
    cwd: source,
    timeoutMs: 45 * 60_000,
    outputFile: path.join(directory, "ci-build.log"),
    env: {
      OPENSTEER_DESKTOP_RELEASE_CHANNEL: channel,
      OPENSTEER_RELEASE_VERSION: version,
      OPENSTEER_SOURCE_REVISION: revision,
    },
  });
  await copyFile(
    path.join(scratch, "build-inputs.json"),
    path.join(directory, "build-inputs.json"),
  );
  const app = path.join(
    source,
    channel === "beta"
      ? "apps/desktop/release/beta/mac-arm64/Opensteer Beta.app"
      : "apps/desktop/release/mac-arm64/Opensteer.app",
  );
  const plist = path.join(app, "Contents/Info.plist");
  if ((await run("/usr/libexec/PlistBuddy", ["-c", "Print :OpensteerUpdateFeed", plist])) !== feed)
    throw new Error("Build did not stamp test feed URL");
  const zip = path.join(
    directory,
    channel === "beta" ? "Opensteer-Beta-mac-arm64.zip" : "Opensteer-mac-arm64.zip",
  );
  const ownerWrite = await run("find", [app, "!", "-perm", "-u+w"]);
  if (ownerWrite) throw new Error(`Bundle entries lack owner-write: ${ownerWrite}`);
  const evidence: Record<string, string> = {};
  const record = (name: string, exe: string, args: readonly string[]) =>
    commandEvidence(run, path.join(directory, `${name}.log`), exe, args);
  evidence.stapler = await record("stapler-validate", "/usr/bin/xcrun", [
    "stapler",
    "validate",
    app,
  ]);
  evidence.codesign = await record("codesign-verify", "/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    app,
  ]);
  evidence.spctl = await record("spctl-assess", "/usr/sbin/spctl", [
    "--assess",
    "--type",
    "execute",
    "--verbose=4",
    app,
  ]);
  await run("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip], {
    timeoutMs: 300_000,
  });
  await writeFile(
    path.join(directory, "build.json"),
    JSON.stringify(
      {
        revision,
        signing: signing.metadata,
        channel,
        version,
        feed,
        seconds: (Date.now() - started) / 1000,
        zip,
        evidence,
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(directory, "archive-check.json"),
    JSON.stringify(
      {
        sha256: createHash("sha256")
          .update(await readFile(zip))
          .digest("hex"),
        ownerWriteCheck: { passed: true, stdout: ownerWrite },
      },
      null,
      2,
    ),
  );
  await pruneCompletedBuild(directory);
  console.log(directory);
} catch (error) {
  await writeFile(
    path.join(directory, "failure.json"),
    JSON.stringify(
      {
        revision,
        seconds: (Date.now() - started) / 1000,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await unlock();
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
