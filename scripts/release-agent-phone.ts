import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  agentPhoneBuildToolsVersion,
  agentPhoneReceiptName,
  agentPhoneReleaseReceiptSchema,
  agentPhoneReleaseSignerSha256,
  androidBuildTools,
  inspectAgentPhoneApk,
  verifyAgentPhoneRelease,
} from "./release-agent-phone.cjs";
import { runBounded, type CommandOptions } from "./command-runner.js";

const absolutePath = z.string().refine(path.isAbsolute, "Use an absolute path");
export const agentPhoneSigningConfigSchema = z.strictObject({
  keystorePath: absolutePath,
  keyAlias: z.string().min(1).max(200),
  keychainService: z.string().min(1).max(200),
  sdkDirectory: absolutePath,
});
export type AgentPhoneSigningConfig = z.infer<typeof agentPhoneSigningConfigSchema>;
export interface AgentPhoneReleaseContext {
  readonly sourceDirectory: string;
  readonly artifactDirectory: string;
  readonly identity: { readonly sourceRevision: string; readonly version: string };
  readonly signal: AbortSignal;
  readonly run: (
    executable: string,
    args: readonly string[],
    options: CommandOptions,
  ) => Promise<string>;
}

async function signingEnvironment(
  input: AgentPhoneSigningConfig,
  signal: AbortSignal,
  run: AgentPhoneReleaseContext["run"] = runBounded,
) {
  const config = agentPhoneSigningConfigSchema.parse(input);
  const password = await run(
    "/usr/bin/security",
    ["find-generic-password", "-s", config.keychainService, "-w"],
    { signal },
  );
  if (!password)
    throw new Error("Agent Phone release Keychain service contains an empty password.");
  return {
    ANDROID_HOME: config.sdkDirectory,
    OPENSTEER_AGENT_PHONE_KEYSTORE: config.keystorePath,
    OPENSTEER_AGENT_PHONE_KEYSTORE_PASSWORD: password,
    OPENSTEER_AGENT_PHONE_KEY_ALIAS: config.keyAlias,
    OPENSTEER_AGENT_PHONE_KEY_PASSWORD: password,
  };
}

export async function preflightAgentPhone(
  input: AgentPhoneSigningConfig,
  context: AgentPhoneReleaseContext,
) {
  const config = agentPhoneSigningConfigSchema.parse(input);
  for (const directory of [context.sourceDirectory, context.artifactDirectory]) {
    const relative = path.relative(directory, config.keystorePath);
    if (!relative.startsWith(".." + path.sep) && !path.isAbsolute(relative))
      throw new Error("Agent Phone keystore must stay outside release source and artifacts.");
  }
  if (!(await lstat(config.keystorePath)).isFile())
    throw new Error("Agent Phone keystore must be a regular file.");
  const tools = androidBuildTools({ ANDROID_HOME: config.sdkDirectory });
  for (const name of ["aapt2", "apksigner"])
    if (!(await lstat(path.join(tools, name))).isFile())
      throw new Error(`Android ${agentPhoneBuildToolsVersion} ${name} is missing.`);
  await lstat(path.join(config.sdkDirectory, "platforms/android-36/android.jar"));
  const javaHome = process.env.JAVA_HOME;
  const java = await context.run(
    javaHome ? path.join(javaHome, "bin/java") : "java",
    ["--version"],
    {
      signal: context.signal,
    },
  );
  const compiler = await context.run(
    javaHome ? path.join(javaHome, "bin/javac") : "javac",
    ["--version"],
    { signal: context.signal },
  );
  const major = Number(/^javac (\d+)/u.exec(compiler)?.[1]);
  const runtimeMajor = Number(/^(?:openjdk|java) (\d+)/u.exec(java)?.[1]);
  if (
    major < 17 ||
    !Number.isInteger(major) ||
    runtimeMajor < 17 ||
    !Number.isInteger(runtimeMajor)
  )
    throw new Error("Agent Phone release needs JDK 17 or newer.");
  const env = await signingEnvironment(config, context.signal, context.run);
  const certificate = await context.run(
    "keytool",
    [
      "-exportcert",
      "-rfc",
      "-keystore",
      config.keystorePath,
      "-alias",
      config.keyAlias,
      "-storepass:env",
      "OPENSTEER_AGENT_PHONE_KEYSTORE_PASSWORD",
    ],
    { signal: context.signal, env },
  );
  const { X509Certificate } = await import("node:crypto");
  if (
    new X509Certificate(certificate).fingerprint256.replaceAll(":", "").toLowerCase() !==
    agentPhoneReleaseSignerSha256
  )
    throw new Error("Configured Agent Phone key does not have the permanent release certificate.");
  return {
    jdk: compiler,
    java,
    buildTools: agentPhoneBuildToolsVersion,
    signingCertSha256: agentPhoneReleaseSignerSha256,
  };
}

export async function buildAgentPhoneRelease(
  config: AgentPhoneSigningConfig,
  context: AgentPhoneReleaseContext,
): Promise<string> {
  const env = await signingEnvironment(config, context.signal, context.run);
  await context.run(
    "pnpm",
    [
      "exec",
      "tsx",
      "scripts/build-agent-phone.ts",
      "--release",
      "--output",
      context.artifactDirectory,
    ],
    {
      cwd: context.sourceDirectory,
      signal: context.signal,
      timeoutMs: 1_800_000,
      env,
    },
  );
  const manifestBytes = await readFile(path.join(context.artifactDirectory, "agent-phone.json"));
  const apk = inspectAgentPhoneApk(
    path.join(context.artifactDirectory, "opensteer-agent-phone.apk"),
    androidBuildTools(env),
    "release",
  );
  if (apk.versionName !== context.identity.version)
    throw new Error("Agent Phone APK version differs from frozen source.");
  const receipt = agentPhoneReleaseReceiptSchema.parse({
    schemaVersion: 1,
    ...context.identity,
    apkSha256: apk.apkSha256,
    apkSize: apk.apkSize,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    signingCertSha256: agentPhoneReleaseSignerSha256,
  });
  const bytes = Buffer.from(JSON.stringify(receipt, null, 2) + "\n");
  const receiptPath = path.join(context.artifactDirectory, agentPhoneReceiptName);
  await writeFile(`${receiptPath}.partial`, bytes, { mode: 0o600 });
  await rename(`${receiptPath}.partial`, receiptPath);
  const receiptSha256 = createHash("sha256").update(bytes).digest("hex");
  verifyAgentPhoneRelease(context.artifactDirectory, receiptPath, {
    ...context.identity,
    receiptSha256,
    buildTools: androidBuildTools(env),
  });
  return receiptSha256;
}

export async function stageAgentPhoneRelease(
  config: AgentPhoneSigningConfig,
  context: AgentPhoneReleaseContext,
  receiptSha256: string,
  destination: string,
) {
  const receiptPath = path.join(context.artifactDirectory, agentPhoneReceiptName);
  const options = {
    ...context.identity,
    receiptSha256,
    buildTools: androidBuildTools({ ANDROID_HOME: config.sdkDirectory }),
  };
  verifyAgentPhoneRelease(context.artifactDirectory, receiptPath, options);
  await mkdir(destination, { recursive: true });
  for (const file of ["opensteer-agent-phone.apk", "agent-phone.json", agentPhoneReceiptName]) {
    await copyFile(
      path.join(context.artifactDirectory, file),
      path.join(destination, `${file}.partial`),
    );
    await rename(path.join(destination, `${file}.partial`), path.join(destination, file));
  }
  verifyAgentPhoneRelease(destination, receiptPath, options);
}

export async function checkAgentPhone(
  sourceDirectory: string,
  sdkDirectory: string,
  signal: AbortSignal,
  run = runBounded,
) {
  const options = {
    cwd: sourceDirectory,
    signal,
    timeoutMs: 1_800_000,
    env: { ANDROID_HOME: sdkDirectory },
  };
  await run(
    "pnpm",
    ["exec", "vitest", "run", "packages/runner-auth/src/agent-phone-vectors.test.ts"],
    {
      ...options,
      env: { ...options.env, OPENSTEER_WRITE_AGENT_PHONE_VECTORS: "1" },
    },
  );
  await run(
    "./gradlew",
    [
      ":app:lint",
      ":app:testDebugUnitTest",
      ":app:assembleDebug",
      ":fixture:assembleDebug",
      "--no-daemon",
      "--rerun-tasks",
    ],
    {
      ...options,
      cwd: path.join(sourceDirectory, "apps/agent-phone"),
      env: { ...options.env, OPENSTEER_WRITE_WIRE_FIXTURE: "1" },
    },
  );
  await run(
    "git",
    [
      "diff",
      "--exit-code",
      "--",
      "packages/runner-auth/fixtures/agent-phone-vectors.json",
      "apps/agent-phone/app/src/test/resources/wire-fixture.json",
    ],
    options,
  );
  await run(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "packages/runner-auth/src/agent-phone-vectors.test.ts",
      "packages/runner-auth/src/agent-phone-wire.test.ts",
    ],
    options,
  );
}
