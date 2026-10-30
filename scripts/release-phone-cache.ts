import { createHash, randomUUID } from "node:crypto";
import { closeSync, createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { isNodeError } from "@opensteer/shared/nodeError";
import { replacePrivateFileAtomically } from "@opensteer/shared/atomicPrivateFile";
import { acquireReleaseLock } from "./command-runner.js";
import { ensureStorageDirectory, holdStorageLock } from "./test-vm/retention.js";
import {
  agentPhoneReceiptName,
  agentPhoneBuildToolsVersion,
  androidBuildTools,
  verifyAgentPhoneRelease,
} from "./release-agent-phone.cjs";
import type { AgentPhoneReleaseContext, AgentPhoneSigningConfig } from "./release-agent-phone.js";

export const phoneCandidateCache = path.join(homedir(), ".cache/opensteer/release-candidates");
const stateRoot = path.join(homedir(), ".local/state/opensteer");
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const inputsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/u),
  version: z.string(),
  tree: z.string(),
  platform: z.string(),
  inputs: z.record(z.string(), z.string()),
});
const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  inputs: inputsSchema,
  receiptSha256: digest,
});
const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

const phoneFileDigests = new Map<string, string>();
async function phoneFileDigest(filename: string): Promise<string> {
  const before = await lstat(filename);
  if (!before.isFile()) throw new Error(`Phone input must be a regular file: ${filename}`);
  const identity = JSON.stringify([
    filename,
    before.dev,
    before.ino,
    before.size,
    before.mtimeMs,
    before.ctimeMs,
  ]);
  const cached = phoneFileDigests.get(identity);
  if (cached) return cached;
  const value = createHash("sha256");
  for await (const chunk of createReadStream(filename)) value.update(chunk);
  const after = await lstat(filename);
  if (
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs ||
    before.ino !== after.ino
  )
    throw new Error("Phone input changed while hashing");
  const result = value.digest("hex");
  phoneFileDigests.set(identity, result);
  return result;
}

/** Read before installing phone dependencies: a hit avoids that entire worktree build. */
export async function phoneCacheInputs(
  config: AgentPhoneSigningConfig,
  context: AgentPhoneReleaseContext,
) {
  const git = (args: readonly string[]) =>
    context.run("git", args, {
      cwd: context.sourceDirectory,
      signal: context.signal,
      timeoutMs: 60_000,
    });
  if (await git(["status", "--porcelain"])) throw new Error("Phone cache needs clean source");
  if ((await git(["rev-parse", "HEAD"])) !== context.identity.sourceRevision)
    throw new Error("Phone cache source SHA mismatch");
  const java = await context.run(
    "sh",
    ["-c", 'exec "${JAVA_HOME:+$JAVA_HOME/bin/}java" -XshowSettings:properties -version 2>&1'],
    { signal: context.signal, timeoutMs: 60_000 },
  );
  const javaHome = /(?:^|\n)\s*java.home\s*=\s*(.+)/u.exec(java)?.[1]?.trim();
  if (!javaHome || !path.isAbsolute(javaHome)) throw new Error("Cannot identify phone JDK");
  const inputs: Record<string, string> = {};
  // Full source tree binds Gradle recipes, dependency pins, signing policy and
  // TS generators. Selected external files bind the SDK/JDK bytes actually used.
  const files: Record<string, string> = {
    keystore: config.keystorePath,
    node: process.execPath,
    ...Object.fromEntries(
      ["bin/java", "bin/javac", "lib/modules", "release"].map((name) => [
        "jdk/" + name,
        path.join(javaHome, name),
      ]),
    ),
    ...Object.fromEntries(
      [
        "platforms/android-37.0/android.jar",
        ...["aapt2", "apksigner", "lib/apksigner.jar", "lib/d8.jar", "zipalign"].map(
          (name) => `build-tools/${agentPhoneBuildToolsVersion}/` + name,
        ),
      ].map((name) => ["sdk/" + name, path.join(config.sdkDirectory, name)]),
    ),
  };
  for (const [name, file] of Object.entries(files))
    inputs[name] = await phoneFileDigest(await realpath(file));
  // Studio/user overrides are outside Git. Unknown alternate toolchains cannot
  // provide a cache hit; the ordinary build path remains available.
  const localProperties = path.join(context.sourceDirectory, "apps/agent-phone/local.properties");
  try {
    const properties = await readFile(localProperties, "utf8");
    inputs.localProperties = hash(properties);
    if (/^\s*sdk.dir\s*=/mu.test(properties))
      throw new Error("Phone SDK override requires a private build");
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    inputs.localProperties = "absent";
  }
  const gradleHome = process.env.GRADLE_USER_HOME ?? path.join(homedir(), ".gradle");
  const optional = async (filename: string) => {
    try {
      if (/org\.gradle\.java\.(?:home|installations)/u.test(await readFile(filename, "utf8")))
        throw new Error("Alternate Gradle JDK requires a private build");
      if (path.basename(filename).startsWith("init.gradle"))
        throw new Error("Custom Gradle initialization requires a private build");
      inputs[filename] = await phoneFileDigest(await realpath(filename));
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      inputs[filename] = "absent";
    }
  };
  for (const name of ["gradle.properties", "init.gradle", "init.gradle.kts"])
    await optional(path.join(gradleHome, name));
  try {
    if ((await readdir(path.join(gradleHome, "init.d"))).length)
      throw new Error("Custom Gradle initialization requires a private build");
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
  const environment = Object.fromEntries(
    Object.entries(process.env)
      .filter(([name]) =>
        /^(?:ORG_GRADLE_PROJECT_|JAVA_TOOL_OPTIONS$|JDK_JAVA_OPTIONS$|_JAVA_OPTIONS$|GRADLE_OPTS$|SOURCE_DATE_EPOCH$|LANG$|LC_|TZ$)/u.test(
          name,
        ),
      )
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  if (
    Object.values(environment).some((value) =>
      /org\.gradle\.java\.(?:home|installations)/u.test(value ?? ""),
    )
  )
    throw new Error("Alternate Gradle JDK requires a private build");
  inputs.environment = hash(JSON.stringify(environment));
  inputs.signing = hash(
    JSON.stringify({ alias: config.keyAlias, service: config.keychainService }),
  );
  return inputsSchema.parse({
    schemaVersion: 1,
    ...context.identity,
    tree: await git(["rev-parse", "HEAD^{tree}"]),
    platform: `${process.platform}/${process.arch}/${process.version}`,
    inputs,
  });
}

const artifactFiles = ["opensteer-agent-phone.apk", "agent-phone.json", agentPhoneReceiptName];
async function privateShape(filename: string, directory: boolean) {
  const stats = await lstat(filename);
  if (!directory && stats.size > 24 * 1024 ** 2) throw new Error("Oversized phone cache file");
  if (
    (directory ? !stats.isDirectory() : !stats.isFile()) ||
    stats.uid !== process.getuid?.() ||
    (stats.mode & 0o022) !== 0 ||
    (await realpath(filename)) !== filename
  )
    throw new Error(`Untrusted phone cache path: ${filename}`);
}

export async function prepareCachedPhone(options: {
  config: AgentPhoneSigningConfig;
  context: AgentPhoneReleaseContext;
  build: () => Promise<string>;
  cache?: string;
  state?: string;
  log?: (line: string) => void;
  verify?: (directory: string, receipt: string) => Promise<void>;
}): Promise<string> {
  const { config, context } = options;
  const log = options.log ?? ((line) => process.stdout.write(line + "\n"));
  const started = performance.now();
  let inputs: z.infer<typeof inputsSchema>;
  try {
    inputs = await phoneCacheInputs(config, context);
  } catch (error) {
    log(`Phone cache unavailable; building privately: ${String(error)}`);
    return options.build();
  }
  const cache = options.cache ?? phoneCandidateCache;
  const state = options.state ?? stateRoot;
  const key = hash(JSON.stringify(inputs));
  const parent = path.join(cache, inputs.sourceRevision);
  const entry = path.join(parent, key);
  const ledger = path.join(state, "candidate-phone-ledger", inputs.sourceRevision, key + ".json");
  const verify =
    options.verify ??
    (async (directory, receiptSha256) => {
      verifyAgentPhoneRelease(directory, path.join(directory, agentPhoneReceiptName), {
        ...context.identity,
        receiptSha256,
        buildTools: androidBuildTools({ ANDROID_HOME: config.sdkDirectory }),
      });
    });
  let storage: number | undefined;
  let release: (() => Promise<void>) | undefined;
  try {
    try {
      ensureStorageDirectory(
        options.state ? path.dirname(state) : await realpath(homedir()),
        state,
      );
      ensureStorageDirectory(
        options.cache ? path.dirname(cache) : await realpath(homedir()),
        cache,
      );
      storage = await holdStorageLock(state, "shared", context.signal);
      release = await acquireReleaseLock(path.join(cache, inputs.sourceRevision + ".lock"));
      ensureStorageDirectory(cache, parent);
      await privateShape(cache, true);
    } catch (error) {
      log(`Phone cache unavailable; building privately: ${String(error)}`);
      return await options.build();
    }
    let poisoned = (await readdir(parent)).some((name) => name.startsWith(key + ".partial-"));
    try {
      if (poisoned) throw new Error("Incomplete phone cache publication");
      await lstat(entry);
      await privateShape(entry, true);
      await privateShape(ledger, false);
      const bytes = await readFile(ledger, "utf8");
      await privateShape(path.join(entry, "phone-manifest.json"), false);
      const manifestBytes = await readFile(path.join(entry, "phone-manifest.json"), "utf8");
      if (
        z.object({ manifestSha256: digest }).parse(JSON.parse(bytes)).manifestSha256 !==
        hash(manifestBytes)
      )
        throw new Error("Phone cache ledger mismatch");
      const manifest = manifestSchema.parse(JSON.parse(manifestBytes));
      if (JSON.stringify(manifest.inputs) !== JSON.stringify(inputs))
        throw new Error("Phone cache inputs mismatch");
      const artifact = path.join(entry, "agent-phone");
      await privateShape(artifact, true);
      if (
        JSON.stringify((await readdir(artifact)).sort()) !==
        JSON.stringify([...artifactFiles].sort())
      )
        throw new Error("Phone cache file set mismatch");
      for (const name of artifactFiles) await privateShape(path.join(artifact, name), false);
      await verify(artifact, manifest.receiptSha256);
      await mkdir(context.artifactDirectory, { recursive: true, mode: 0o700 });
      for (const name of artifactFiles)
        await copyFile(path.join(artifact, name), path.join(context.artifactDirectory, name));
      await verify(context.artifactDirectory, manifest.receiptSha256);
      if (JSON.stringify(await phoneCacheInputs(config, context)) !== JSON.stringify(inputs))
        throw new Error("Phone cache inputs changed during lookup");
      log(`Phone cache hit ${entry} (${Math.round(performance.now() - started)}ms; no build)`);
      return manifest.receiptSha256;
    } catch (error) {
      // Missing key is a normal miss. Every other shape/proof failure leaves
      // that slot intact: never replace poisoned signed artifacts automatically.
      try {
        await lstat(entry);
        poisoned = true;
      } catch (missing) {
        if (!isNodeError(missing) || missing.code !== "ENOENT") poisoned = true;
      }
      if (poisoned)
        log(
          `Poisoned phone cache key ${entry}; ignored and left for retention/manual clear: ${String(error)}`,
        );
    }
    const receiptSha256 = await options.build();
    await verify(context.artifactDirectory, receiptSha256);
    if (JSON.stringify(await phoneCacheInputs(config, context)) !== JSON.stringify(inputs))
      throw new Error("Phone cache inputs changed during build");
    let published = false;
    if (!poisoned) {
      const temporary = path.join(parent, `${key}.partial-${randomUUID()}`);
      await mkdir(path.join(temporary, "agent-phone"), { recursive: true, mode: 0o700 });
      try {
        for (const name of artifactFiles)
          await copyFile(
            path.join(context.artifactDirectory, name),
            path.join(temporary, "agent-phone", name),
          );
        await verify(path.join(temporary, "agent-phone"), receiptSha256);
        const manifestBytes =
          JSON.stringify({ schemaVersion: 1, inputs, receiptSha256 }, null, 2) + "\n";
        await writeFile(path.join(temporary, "phone-manifest.json"), manifestBytes, {
          mode: 0o600,
        });
        await rename(temporary, entry);
        ensureStorageDirectory(state, path.dirname(ledger));
        await replacePrivateFileAtomically(
          ledger,
          JSON.stringify({
            manifestSha256: hash(manifestBytes),
            manifest: JSON.parse(manifestBytes),
            receipt: JSON.parse(
              await readFile(path.join(context.artifactDirectory, agentPhoneReceiptName), "utf8"),
            ),
          }) + "\n",
        );
        published = true;
      } catch (error) {
        log(`Phone cache publication failed; private release artifact retained: ${String(error)}`);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
    log(
      `Phone cache ${poisoned ? "bypassed" : published ? "populated" : "not published"} ${entry}`,
    );
    return receiptSha256;
  } finally {
    await release?.();
    if (storage !== undefined) closeSync(storage);
  }
}
