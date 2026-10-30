import { createRequire } from "node:module";
import {
  copyMacApp,
  readMacAppManifest,
  verifyMacAppTree,
  writeMacAppManifest,
} from "./mac-app-delivery.js";
import { MacPreparationPool, runMacPreparations } from "./mac-preparation.js";
import { selectDictationSDK, signedMacHelpers } from "./signed-mac-helpers.js";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { replacePrivateFileAtomically } from "@opensteer/shared/atomicPrivateFile";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { personalRuntimeLayout } from "../apps/desktop/scripts/personal-runtime-layout.js";
import { readProvenPersonalRuntime } from "../apps/desktop/scripts/personal-runtime-provenance.js";
import { postgresReleaseVersion } from "../apps/desktop/scripts/postgres-release-version.js";
import { readPersonalRuntimeRelease } from "../apps/desktop/src/releases/personal-runtime-release.js";
import { CommandTimeoutError, ReleasePendingError } from "./command-runner.js";
import { stageAgentPhoneRelease, type AgentPhoneSigningConfig } from "./release-agent-phone.js";

const absolutePath = z
  .string()
  .refine(
    (value) =>
      path.isAbsolute(value) &&
      path.resolve(value) === value &&
      value !== "/" &&
      !/[\r\n\0]/u.test(value),
    "An absolute, non-root path is required",
  );
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const binary = z
  .object({ path: absolutePath, sha256: digest, version: z.string().min(1) })
  .strict();
const targetSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/u),
    sshHost: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9@._-]*$/u)
      .optional(),
    stagingDirectory: absolutePath,
    applicationPath: absolutePath.refine((value) => path.basename(value) === "Opensteer Beta.app"),
    runtimeStatusUrl: z
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          url.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
          url.pathname === "/healthz" &&
          !url.username &&
          !url.password
        );
      })
      .nullable(),
  })
  .strict();
const macConfigFields = z
  .object({
    architecture: z.enum(["arm64", "amd64"]),
    signingIdentity: z.string().min(1),
    keychainProfile: z.string().min(1).optional(),
    /** The Developer ID profile that grants Opensteer Passwords its keychain group. */
    passwordsProvisioningProfile: absolutePath,
    keychain: absolutePath.optional(),
    personalRuntimeSource: absolutePath.optional(),
    supervisor: binary,
    cloudflared: binary,
    /** This Mac, and optionally a second one reached over SSH. */
    targets: z.union([z.tuple([targetSchema]), z.tuple([targetSchema, targetSchema])]),
  })
  .strict();
function validateTargets(
  value: { targets: readonly [z.infer<typeof targetSchema>, ...z.infer<typeof targetSchema>[]] },
  context: z.RefinementCtx,
) {
  const [local, remote] = value.targets;
  if (local.sshHost || (remote && (!remote.sshHost || remote.id === local.id)))
    context.addIssue({
      code: "custom",
      message: "Targets must be this Mac, then optionally a distinct SSH Mac",
    });
  if (value.targets[0].runtimeStatusUrl === null)
    context.addIssue({
      code: "custom",
      message: "The local Mac must have an initialized Personal Host health URL",
      path: ["targets", 0, "runtimeStatusUrl"],
    });
  for (const target of value.targets)
    if (
      target.stagingDirectory === target.applicationPath ||
      target.stagingDirectory.startsWith(target.applicationPath + "/") ||
      target.applicationPath.startsWith(target.stagingDirectory + "/")
    )
      context.addIssue({
        code: "custom",
        message: "Staging and installed application paths must not overlap",
      });
}
export const macConfigSchema = macConfigFields.superRefine((value, context) => {
  validateTargets(value, context);
  if (value.targets.some((target) => target.sshHost) && !value.keychainProfile)
    context.addIssue({
      code: "custom",
      message: "Remote Mac distribution requires keychainProfile",
    });
});
export const localMacDestinations = (config: {
  targets: readonly { sshHost?: string | undefined }[];
}) => config.targets.every((target) => !target.sshHost);
export type MacConfig = z.infer<typeof macConfigSchema>;
export const localMacConfigSchema = macConfigFields
  .extend({
    keychainProfile: z.never().optional(),
    personalRuntimeSource: z.never().optional(),
    targets: z.tuple([targetSchema.extend({ sshHost: z.never().optional() })]),
  })
  .superRefine(validateTargets);
export type LocalMacConfig = z.infer<typeof localMacConfigSchema>;
type BuildConfig = MacConfig | LocalMacConfig;

export interface MacContext {
  readonly preparationPool?: MacPreparationPool;
  /** Local installer owns this lease for the entire transaction; never serialized. */
  readonly heldApplicationLock?: string;
  readonly prepareAgentPhone?: (signal: AbortSignal) => Promise<string>;
  readonly runnerSourceRevision?: string | undefined;
  readonly runtimeInputs?: { readonly postgres: string; readonly node: string };
  readonly now?: () => number;
  readonly resumeCommand?: string;
  readonly sourceDirectory: string;
  readonly stateDirectory: string;
  readonly identity: { readonly sourceRevision: string; readonly version: string };
  readonly signal?: AbortSignal;
  readonly agentPhoneArtifactDirectory?: string;
  readonly agentPhoneReceiptSha256?: string | undefined;
  readonly agentPhoneSigning?: AgentPhoneSigningConfig;
  readonly run: (
    executable: string,
    args: readonly string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal },
  ) => Promise<string>;
}
type Target = z.infer<typeof targetSchema>;
const receiptSchema = z
  .object({
    signedBuild: z
      .object({
        runtimeManifestSha256: digest,
        phoneReceiptSha256: digest,
        phoneApkSha256: digest,
        phoneManifestSha256: digest,
        passwordsProvisioningProfileSha256: digest,
        signingIdentity: z.string(),
        elapsedMs: z.number().nonnegative(),
      })
      .strict()
      .optional(),
    runnerSourceRevision: z
      .string()
      .regex(/^[a-f0-9]{40}$/u)
      .optional(),
    sourceRevision: z.string(),
    version: z.string(),
    configDigest: digest,
    submissionIntent: z.boolean().default(false),
    submissionIntentAt: z.iso.datetime().optional(),
    submittedAt: z.iso.datetime().optional(),
    acceptedAt: z.iso.datetime().optional(),
    submissionZipSha256: digest.optional(),
    requestId: z.uuid().optional(),
    accepted: z.boolean().default(false),
    zipSha256: digest.optional(),
    appTreeSha256: digest.optional(),
    staged: z.array(z.string()).default([]),
    installed: z.array(z.string()).default([]),
    verified: z.array(z.string()).default([]),
    rollback: z
      .record(
        z.string(),
        z
          .object({
            path: absolutePath,
            version: z.string().nullable(),
            sourceRevision: z.string().nullable(),
          })
          .strict(),
      )
      .default({}),
  })
  .strict();
type Receipt = z.infer<typeof receiptSchema>;
const require = createRequire(import.meta.url);
const { readSigningMode } = require("../apps/desktop/scripts/signing-input.cjs") as {
  readSigningMode: (environment?: NodeJS.ProcessEnv) =>
    | { mode: "development" }
    | {
        mode: "signed";
        signing: {
          teamId: string;
          identity: string;
          notarizationProfile?: string;
          keychain?: string;
        };
      };
};
function signingInput(config: BuildConfig) {
  const mode = readSigningMode({ ...process.env, OPENSTEER_DESKTOP_RELEASE: "1" });
  if (
    mode.mode !== "signed" ||
    mode.signing.identity !== config.signingIdentity ||
    (mode.signing.notarizationProfile !== undefined &&
      mode.signing.notarizationProfile !== config.keychainProfile)
  ) {
    throw Error("Release configuration must match OPENSTEER_DESKTOP_SIGNING_FILE.");
  }
  if (
    mode.signing.keychain !== undefined &&
    config.keychain !== undefined &&
    mode.signing.keychain !== config.keychain
  )
    throw Error(
      "Conflicting keychain inputs: coordinator keychain must match the signing JSON keychain.",
    );
  return { ...mode.signing, keychain: mode.signing.keychain ?? config.keychain };
}

function execute(
  context: MacContext,
  executable: string,
  args: readonly string[],
  timeoutMs = 60_000,
  env?: NodeJS.ProcessEnv,
) {
  return context.run(executable, args, {
    cwd: context.sourceDirectory,
    timeoutMs,
    ...(context.signal ? { signal: context.signal } : {}),
    ...(env ? { env } : {}),
  });
}
function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function onTarget(
  context: MacContext,
  target: Target,
  executable: string,
  args: readonly string[],
  timeoutMs = 60_000,
) {
  return target.sshHost
    ? execute(
        context,
        "/usr/bin/ssh",
        [
          "-oBatchMode=yes",
          "-oConnectTimeout=10",
          "-oStrictHostKeyChecking=yes",
          target.sshHost,
          [executable, ...args].map(quote).join(" "),
        ],
        timeoutMs,
      )
    : execute(context, executable, args, timeoutMs);
}
function artifactPath(context: MacContext) {
  return path.join(context.stateDirectory, "Opensteer Beta.zip");
}
function artifactAppPath(context: MacContext) {
  return path.join(context.stateDirectory, "signed-app", "Opensteer Beta.app");
}
function appManifestPath(context: MacContext) {
  return path.join(context.stateDirectory, "app-tree.json");
}
function submissionArchive(context: MacContext) {
  return path.join(context.stateDirectory, "Opensteer Beta.submit.zip");
}
function appPath(config: BuildConfig, context: MacContext) {
  return path.join(
    context.sourceDirectory,
    "apps/desktop/release/beta",
    config.architecture === "arm64" ? "mac-arm64" : "mac",
    "Opensteer Beta.app",
  );
}
function configDigest(config: BuildConfig) {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}
async function hashFile(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function receipt(config: BuildConfig, context: MacContext, local = false): Promise<Receipt> {
  await mkdir(context.stateDirectory, { recursive: true, mode: 0o700 });
  let value: Receipt;
  try {
    value = receiptSchema.parse(
      JSON.parse(
        await readFile(
          path.join(context.stateDirectory, local ? "mac-local.json" : "mac.json"),
          "utf8",
        ),
      ),
    );
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    return receiptSchema.parse({
      ...context.identity,
      ...(context.runnerSourceRevision
        ? { runnerSourceRevision: context.runnerSourceRevision }
        : {}),
      configDigest: configDigest(config),
    });
  }
  if (
    value.sourceRevision !== context.identity.sourceRevision ||
    value.version !== context.identity.version ||
    value.configDigest !== configDigest(config)
  )
    throw new Error("Mac receipt belongs to a different release or configuration");
  if (
    (value.runnerSourceRevision ?? value.sourceRevision) !==
    (context.runnerSourceRevision ?? context.identity.sourceRevision)
  )
    throw new Error("Mac receipt belongs to a different Runner selection");
  return value;
}
async function save(context: MacContext, value: Receipt, local = false) {
  const file = path.join(context.stateDirectory, local ? "mac-local.json" : "mac.json");
  await replacePrivateFileAtomically(file, `${JSON.stringify(value, null, 2)}\n`);
}
function credentials(config: MacConfig) {
  if (!config.keychainProfile) throw new Error("Notarization requires keychainProfile");
  const signing = signingInput(config);
  return [
    "--keychain-profile",
    config.keychainProfile,
    ...(signing.keychain ? ["--keychain", signing.keychain] : []),
  ];
}

export function submitMacArchiveForNotarization(
  config: MacConfig,
  context: MacContext,
  archive: string,
) {
  return execute(
    context,
    "/usr/bin/xcrun",
    ["notarytool", "submit", archive, ...credentials(config), "--wait", "--output-format", "json"],
    900_000,
  );
}

export async function preflightMac(input: MacConfig, context: MacContext) {
  const config = macConfigSchema.parse(input);
  const result = await preflightBuild(config, context);
  if (localMacDestinations(config)) return result;
  await execute(context, "/usr/bin/xcrun", [
    "notarytool",
    "history",
    ...credentials(config),
    "--output-format",
    "json",
  ]);
  return result;
}

export async function preflightLocalMac(input: LocalMacConfig, context: MacContext) {
  const script = await readFile(
    path.join(context.sourceDirectory, "apps/desktop/scripts/package-macos.ts"),
    "utf8",
  );
  if (!script.includes("if (!deferNotarization) requireNotarizationAuthority"))
    throw new Error(
      "Selected source predates local signed packaging; select a SHA with local packaging support",
    );
  return preflightBuild(localMacConfigSchema.parse(input), context);
}

async function preflightBuild(config: BuildConfig, context: MacContext) {
  await requireCoordinatorPackaging(context);
  const head = (await execute(context, "git", ["rev-parse", "HEAD"])).trim();
  if (head !== context.identity.sourceRevision)
    throw new Error("Desktop source HEAD differs from release SHA");
  const architecture = config.architecture === "amd64" ? "x86_64" : "arm64";
  if (
    (await execute(context, "/usr/bin/uname", ["-s"])).trim() !== "Darwin" ||
    (await execute(context, "/usr/bin/uname", ["-m"])).trim() !== architecture
  )
    throw new Error("Packaging Mac platform/architecture mismatch");
  const identities = await execute(context, "/usr/bin/security", [
    "find-identity",
    "-v",
    "-p",
    "codesigning",
    ...(signingInput(config).keychain ? [signingInput(config).keychain!] : []),
  ]);
  if (
    !identities.includes(config.signingIdentity) ||
    !config.signingIdentity.includes(`(${signingInput(config).teamId})`)
  )
    throw new Error("Configured Opensteer signing identity is unavailable");
  await execute(context, "/bin/test", ["-f", config.passwordsProvisioningProfile]);
  let postgresVersion: string | undefined;
  if (config.personalRuntimeSource)
    await verifyPersonalRuntime(config.personalRuntimeSource, config, context);
  else {
    for (const name of [
      "OPENSTEER_PERSONAL_RUNTIME_POSTGRES_SOURCE",
      "OPENSTEER_PERSONAL_RUNTIME_NODE_SOURCE",
    ]) {
      const source = absolutePath.parse(
        context.runtimeInputs?.[name.endsWith("POSTGRES_SOURCE") ? "postgres" : "node"] ??
          process.env[name],
      );
      if (name.endsWith("POSTGRES_SOURCE"))
        postgresVersion = await postgresReleaseVersion(
          source,
          "darwin",
          (executable, args, timeoutMs) => execute(context, executable, args, timeoutMs),
        );
      else await execute(context, "/bin/test", ["-e", source]);
    }
  }
  for (const file of [config.supervisor, config.cloudflared]) {
    if ((await hashFile(file.path)) !== file.sha256)
      throw new Error(`Reviewed binary digest mismatch: ${file.path}`);
    await execute(context, "/usr/bin/codesign", [
      "--verify",
      "--strict",
      `-R=anchor apple generic and certificate leaf[subject.OU] = "${signingInput(config).teamId}"`,
      file.path,
    ]);
    if ((await execute(context, "/usr/bin/lipo", ["-archs", file.path])).trim() !== architecture)
      throw new Error(`Standalone binary architecture mismatch: ${file.path}`);
  }
  for (const target of config.targets) {
    if (
      (await onTarget(context, target, "/usr/bin/uname", ["-s"])).trim() !== "Darwin" ||
      (await onTarget(context, target, "/usr/bin/uname", ["-m"])).trim() !== architecture
    )
      throw new Error(`Mac platform/architecture mismatch: ${target.id}`);
    await onTarget(context, target, "/bin/test", ["-w", path.dirname(target.applicationPath)]);
    await onTarget(context, target, "/bin/test", ["-w", path.dirname(target.stagingDirectory)]);
  }
  return {
    architecture,
    targets: config.targets.map((target) => target.id),
    sourceRevision: head,
    postgresVersion,
  };
}

export async function buildSignedMac(
  config: BuildConfig,
  context: MacContext,
  channel: "beta" | "stable" = "beta",
) {
  const started = Date.now();
  await requireCoordinatorPackaging(context);
  if (
    !context.agentPhoneArtifactDirectory ||
    (!context.agentPhoneReceiptSha256 && !context.prepareAgentPhone) ||
    !context.agentPhoneSigning ||
    !context.signal
  )
    throw new Error(
      "Mac release packaging requires the coordinator's verified Agent Phone artifact and receipt.",
    );
  const personalRuntimeSource =
    config.personalRuntimeSource ?? path.join(context.stateDirectory, "personal-runtime");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENSTEER_DESKTOP_RELEASE: "1",
    OPENSTEER_DESKTOP_RELEASE_CHANNEL: channel,
    OPENSTEER_DESKTOP_TARGET_ARCH: config.architecture,
    OPENSTEER_DESKTOP_DEFER_NOTARIZATION: "1",
    OPENSTEER_RELEASE_VERSION: context.identity.version,
    OPENSTEER_SOURCE_REVISION: context.identity.sourceRevision,
    OPENSTEER_RUNNER_SOURCE_REVISION:
      context.runnerSourceRevision ?? context.identity.sourceRevision,
    ANDROID_HOME: context.agentPhoneSigning.sdkDirectory,
    OPENSTEER_AGENT_PHONE_RELEASE_RECEIPT: path.join(
      context.agentPhoneArtifactDirectory,
      "agent-phone-release.json",
    ),
    OPENSTEER_AGENT_PHONE_RELEASE_RECEIPT_SHA256: context.agentPhoneReceiptSha256,
    OPENSTEER_APPLE_TEAM_ID: signingInput(config).teamId,
    APPLE_KEYCHAIN_PROFILE: config.keychainProfile,
    APPLE_KEYCHAIN: signingInput(config).keychain,
    CSC_KEYCHAIN: signingInput(config).keychain,
    // electron-builder selects the certificate type itself and rejects this prefix.
    CSC_NAME: config.signingIdentity.replace(/^Developer ID Application:\s*/u, ""),
    OPENSTEER_PERSONAL_RUNTIME_SOURCE: personalRuntimeSource,
    OPENSTEER_PERSONAL_RUNTIME_OUTPUT: personalRuntimeSource,
    OPENSTEER_PERSONAL_RUNTIME_SIGNING_IDENTITY: config.signingIdentity,
    OPENSTEER_DESKTOP_TARGET_OS: "darwin",
    OPENSTEER_PROCESS_SUPERVISOR_BINARY_SOURCE: config.supervisor.path,
    OPENSTEER_PROCESS_SUPERVISOR_BINARY_SHA256: config.supervisor.sha256,
    OPENSTEER_CLOUDFLARED_BINARY_SOURCE: config.cloudflared.path,
    OPENSTEER_CLOUDFLARED_BINARY_SHA256: config.cloudflared.sha256,
    OPENSTEER_CLOUDFLARED_RELEASE_VERSION: config.cloudflared.version,
  };
  for (const name of [
    "APPLE_API_KEY",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER",
    "APPLE_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "APPLE_TEAM_ID",
  ])
    env[name] = undefined;
  Object.assign(
    env,
    await selectDictationSDK(
      (sdkEnv) =>
        execute(
          context,
          "/usr/bin/xcrun",
          ["--sdk", "macosx", "--show-sdk-version"],
          60_000,
          sdkEnv,
        ),
      env,
      context.signal,
    ),
  );
  let phoneReceiptSha256 = context.agentPhoneReceiptSha256;
  const branches = [
    async (signal: AbortSignal) => {
      if (!config.personalRuntimeSource)
        await execute(
          { ...context, signal },
          "pnpm",
          ["--filter", "@opensteer/desktop", "exec", "tsx", "scripts/build-personal-runtime.ts"],
          45 * 60_000,
          env,
        );
      await verifyPersonalRuntime(personalRuntimeSource, config, { ...context, signal });
      if (config.personalRuntimeSource)
        await execute(
          { ...context, signal },
          "pnpm",
          [
            "--filter",
            "@opensteer/desktop",
            "exec",
            "tsx",
            "scripts/build-computer-use-helper.ts",
            "--sign",
            config.signingIdentity,
          ],
          20 * 60_000,
          env,
        );
    },
    async (signal: AbortSignal) => {
      for (const helper of signedMacHelpers) {
        await execute(
          { ...context, signal },
          "pnpm",
          [
            "--filter",
            "@opensteer/desktop",
            "exec",
            "tsx",
            `scripts/${helper.script}`,
            "--sign",
            config.signingIdentity,
          ],
          20 * 60_000,
          { ...env, OPENSTEER_PASSWORDS_PROVISIONING_PROFILE: config.passwordsProvisioningProfile },
        );
      }
    },
  ];
  const preparePhone = async (signal: AbortSignal) => {
    if (context.prepareAgentPhone) phoneReceiptSha256 = await context.prepareAgentPhone(signal);
  };
  if (context.preparationPool) {
    // The coordinator's phone promise already owns its compiler slot. Joining
    // it must not consume another slot while the actual phone job waits.
    const outcomes = await Promise.allSettled([
      preparePhone(context.signal),
      runMacPreparations(branches, context.signal, context.preparationPool),
    ]);
    for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
  } else await runMacPreparations([...branches, preparePhone], context.signal);
  env.OPENSTEER_AGENT_PHONE_RELEASE_RECEIPT_SHA256 = phoneReceiptSha256;
  if (!phoneReceiptSha256) throw new Error("Agent Phone preparation returned no receipt");
  await stageAgentPhoneRelease(
    context.agentPhoneSigning,
    {
      sourceDirectory: context.sourceDirectory,
      artifactDirectory: context.agentPhoneArtifactDirectory,
      identity: context.identity,
      signal: context.signal,
      run: context.run,
    },
    phoneReceiptSha256,
    path.join(context.sourceDirectory, "apps/desktop/generated-resources/agent-phone"),
  );
  await execute(
    context,
    "pnpm",
    ["--filter", "@opensteer/desktop", "package:mac"],
    45 * 60_000,
    env,
  );
  const builtApp =
    channel === "beta"
      ? appPath(config, context)
      : path.join(context.sourceDirectory, "apps/desktop/release/mac-arm64/Opensteer.app");
  const packagedRuntime = await readPersonalRuntimeRelease(
    path.join(builtApp, "Contents/Resources/personal-runtime"),
    { architecture: config.architecture, operatingSystem: "darwin" },
  );
  if (
    packagedRuntime.identity.manifestSha256 !==
    (await hashFile(path.join(personalRuntimeSource, "release.json")))
  )
    throw new Error("Packaged Personal runtime differs from the built runtime");
  await verifySignedBundle(config.targets[0], builtApp, config, context, channel);
  const phone = z
    .object({ apkSha256: digest, manifestSha256: digest })
    .parse(
      JSON.parse(
        await readFile(
          path.join(context.agentPhoneArtifactDirectory, "agent-phone-release.json"),
          "utf8",
        ),
      ),
    );
  return {
    phoneApkSha256: phone.apkSha256,
    phoneManifestSha256: phone.manifestSha256,
    passwordsProvisioningProfileSha256: await hashFile(config.passwordsProvisioningProfile),
    runtimeManifestSha256: await hashFile(path.join(personalRuntimeSource, "release.json")),
    phoneReceiptSha256,
    signingIdentity: config.signingIdentity,
    elapsedMs: Date.now() - started,
  };
}

export async function prepareMac(input: MacConfig, context: MacContext) {
  const config = macConfigSchema.parse(input);
  if (localMacDestinations(config)) return prepareSignedLocalMac(config, context, false);
  const state = await receipt(config, context);
  if (!state.submissionIntent) {
    state.signedBuild = await buildSignedMac(config, context);
    await execute(
      context,
      "/usr/bin/ditto",
      [
        "-c",
        "-k",
        "--sequesterRsrc",
        "--keepParent",
        appPath(config, context),
        submissionArchive(context),
      ],
      300_000,
    );
    state.submissionIntent = true;
    state.submissionIntentAt = new Date().toISOString();
    state.submissionZipSha256 = await hashFile(submissionArchive(context));
    await save(context, state);
    const submitted = z
      .object({ id: z.uuid() })
      .parse(
        JSON.parse(
          await execute(
            context,
            "/usr/bin/xcrun",
            [
              "notarytool",
              "submit",
              submissionArchive(context),
              ...credentials(config),
              "--output-format",
              "json",
            ],
            300_000,
          ),
        ),
      );
    state.requestId = submitted.id;
    state.submittedAt = new Date().toISOString();
    await save(context, state);
  }
  if (!state.requestId)
    throw new Error(
      "Notarization submission outcome is unknown. Reconcile Apple history and persist the matching requestId in mac.json; submission will not be repeated.",
    );
  if (
    !state.zipSha256 &&
    (await hashFile(submissionArchive(context))) !== state.submissionZipSha256
  )
    throw new Error("Submitted archive changed before notarization completed");
  if (!state.accepted) {
    const now = context.now ?? Date.now;
    const deadline = now() + 300_000;
    for (;;) {
      context.signal?.throwIfAborted();
      const remaining = deadline - now();
      if (remaining <= 0) break;
      let observation: string;
      try {
        observation = await execute(
          context,
          "/usr/bin/xcrun",
          [
            "notarytool",
            "info",
            state.requestId,
            ...credentials(config),
            "--output-format",
            "json",
          ],
          Math.min(60_000, remaining),
        );
      } catch (error) {
        context.signal?.throwIfAborted();
        // Only the overall observation deadline is a resumable pending result.
        if (!(error instanceof CommandTimeoutError) || remaining > 60_000) throw error;
        break;
      }
      context.signal?.throwIfAborted();
      const status = z.object({ id: z.uuid(), status: z.string() }).parse(JSON.parse(observation));
      if (status.id !== state.requestId)
        throw new Error("Apple returned a different notarization request");
      if (status.status === "Accepted") {
        state.accepted = true;
        state.acceptedAt = new Date().toISOString();
        await save(context, state);
        break;
      }
      if (status.status !== "In Progress")
        throw new Error(`Notarization ${state.requestId}: ${status.status}`);
      if (now() >= deadline) break;
      await delay(Math.min(10_000, Math.max(1, deadline - now())), undefined, {
        signal: context.signal,
      });
    }
    if (!state.accepted)
      throw new ReleasePendingError(
        `Notarization ${state.requestId} is pending after the five-minute observation budget; retained receipt: ${path.join(context.stateDirectory, "mac.json")}. Resume without resubmitting: ${context.resumeCommand ?? "pnpm desktop:install-local"}`,
      );
  }
  if (!state.zipSha256) {
    await execute(
      context,
      "/usr/bin/xcrun",
      ["stapler", "staple", appPath(config, context)],
      120_000,
    );
    await verifyBundle(config.targets[0], appPath(config, context), config, context);
    await execute(
      context,
      "/usr/bin/ditto",
      [
        "-c",
        "-k",
        "--sequesterRsrc",
        "--keepParent",
        appPath(config, context),
        artifactPath(context),
      ],
      300_000,
    );
    state.zipSha256 = await hashFile(artifactPath(context));
    await save(context, state);
  }
  if ((await hashFile(artifactPath(context))) !== state.zipSha256)
    throw new Error("Notarized artifact digest changed");
  return state;
}

async function verifyPersonalRuntime(source: string, config: BuildConfig, context: MacContext) {
  await readProvenPersonalRuntime(source, {
    architecture: config.architecture,
    operatingSystem: "darwin",
    ...context.identity,
    runnerSourceRevision: context.runnerSourceRevision ?? context.identity.sourceRevision,
  });
}

async function requireCoordinatorPackaging(context: MacContext) {
  const script = await readFile(
    path.join(context.sourceDirectory, "apps/desktop/scripts/package-macos.ts"),
    "utf8",
  );
  if (
    !script.includes("OPENSTEER_DESKTOP_DEFER_NOTARIZATION") ||
    !script.includes("OpensteerSourceRevision")
  )
    throw new Error(
      "Frozen source predates resumable Mac packaging; select a release SHA containing coordinator support",
    );
}

async function verifySignedBundle(
  target: Target,
  app: string,
  config: BuildConfig,
  context: MacContext,
  channel: "beta" | "stable" = "beta",
) {
  for (const [key, expected] of [
    [
      "CFBundleIdentifier",
      channel === "beta" ? "com.steerlabs.opensteer.beta" : "com.opensteer.opensteer",
    ],
    ["CFBundleShortVersionString", context.identity.version],
    ["CFBundleVersion", context.identity.version],
    ["OpensteerSourceRevision", context.identity.sourceRevision],
  ]) {
    if (
      (
        await onTarget(context, target, "/usr/libexec/PlistBuddy", [
          "-c",
          `Print :${key}`,
          path.join(app, "Contents/Info.plist"),
        ])
      ).trim() !== expected
    )
      throw new Error(`Installed/staged bundle ${key} differs on ${target.id}`);
  }
  await onTarget(context, target, "/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    `-R=anchor apple generic and certificate leaf[subject.OU] = "${signingInput(config).teamId}"`,
    app,
  ]);
  await onTarget(context, target, "/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    `-R=anchor apple generic and identifier "com.opensteer.computer-use" and certificate leaf[subject.OU] = "${signingInput(config).teamId}"`,
    path.join(app, "Contents/Resources/computer-use/Opensteer Computer Use.app"),
  ]);
  for (const [relative, expected] of [
    ["process-supervisor/opensteer-process-supervisor", config.supervisor.sha256],
    ["cloudflared/cloudflared", config.cloudflared.sha256],
  ] as const) {
    const file = path.join(app, "Contents/Resources", relative);
    const actual = (await onTarget(context, target, "/usr/bin/shasum", ["-a", "256", file]))
      .trim()
      .split(/\s/u)[0];
    if (actual !== expected) throw new Error(`Standalone helper digest differs on ${target.id}`);
  }
}

async function verifyLocalBundle(
  target: Target,
  app: string,
  config: BuildConfig,
  context: MacContext,
) {
  const state = await receipt(config, context, true);
  if (!state.signedBuild) throw new Error("Local signed-build receipt is missing");
  if (state.appTreeSha256) {
    const manifest = await readMacAppManifest(
      appManifestPath(context),
      state.appTreeSha256,
      context,
    );
    await verifyMacAppTree(app, manifest, context);
  }
  await verifySignedBundle(target, app, config, context);
  for (const [relative, expected] of [
    ["personal-runtime/release.json", state.signedBuild.runtimeManifestSha256],
    ["agent-phone/opensteer-agent-phone.apk", state.signedBuild.phoneApkSha256],
    ["agent-phone/agent-phone.json", state.signedBuild.phoneManifestSha256],
  ] as const) {
    const actual = (
      await onTarget(context, target, "/usr/bin/shasum", [
        "-a",
        "256",
        path.join(app, "Contents/Resources", relative),
      ])
    )
      .trim()
      .split(/\s/u)[0];
    if (actual !== expected)
      throw new Error(`Signed local runtime/phone digest differs on ${target.id}: ${relative}`);
  }
}

async function verifyBundle(target: Target, app: string, config: BuildConfig, context: MacContext) {
  await verifySignedBundle(target, app, config, context);
  await onTarget(context, target, "/usr/bin/xcrun", ["stapler", "validate", app]);
  await onTarget(context, target, "/usr/sbin/spctl", ["--assess", "--type", "execute", app]);
}

export async function prepareLocalMac(input: LocalMacConfig, context: MacContext) {
  const config = localMacConfigSchema.parse(input);
  return prepareSignedLocalMac(config, context, true);
}

async function prepareSignedLocalMac(config: BuildConfig, context: MacContext, stage: boolean) {
  const state = await receipt(config, context, true);
  if (!state.zipSha256 && !state.appTreeSha256) {
    state.signedBuild = await buildSignedMac(config, context);
    state.appTreeSha256 = await writeMacAppManifest(
      appPath(config, context),
      appManifestPath(context),
      context,
    );
    await mkdir(path.dirname(artifactAppPath(context)), { recursive: true, mode: 0o700 });
    await copyMacApp(appPath(config, context), artifactAppPath(context), context);
  }
  if (state.appTreeSha256) {
    const manifest = await readMacAppManifest(
      appManifestPath(context),
      state.appTreeSha256,
      context,
    );
    await verifyMacAppTree(artifactAppPath(context), manifest, context);
  } else if ((await hashFile(artifactPath(context))) !== state.zipSha256)
    throw new Error("Signed local artifact digest changed");
  await save(context, state, true);
  if (stage) await stageArtifact(config, context, state, true);
  return state;
}

export async function stageMac(input: MacConfig, context: MacContext) {
  const config = macConfigSchema.parse(input);
  const local = localMacDestinations(config);
  const state = await receipt(config, context, local);
  if (local && state.appTreeSha256) {
    const manifest = await readMacAppManifest(
      appManifestPath(context),
      state.appTreeSha256,
      context,
    );
    await verifyMacAppTree(artifactAppPath(context), manifest, context);
  } else if (
    (!local && !state.accepted) ||
    !state.zipSha256 ||
    (await hashFile(artifactPath(context))) !== state.zipSha256
  )
    throw new Error("A verified notarized artifact is required before staging");
  await stageArtifact(config, context, state, local);
  return state;
}

async function stageArtifact(
  config: BuildConfig,
  context: MacContext,
  state: Receipt,
  local: boolean,
) {
  const verify = local ? verifyLocalBundle : verifyBundle;
  for (const target of config.targets) {
    const directory = path.join(target.stagingDirectory, context.identity.sourceRevision);
    if (local && state.appTreeSha256) {
      await onTarget(context, target, "/bin/mkdir", ["-p", directory]);
      const staged = path.join(directory, "Opensteer Beta.app");
      await copyMacApp(artifactAppPath(context), staged, context);
      await verify(target, staged, config, context);
      if (!state.staged.includes(target.id)) state.staged.push(target.id);
      await save(context, state, local);
      continue;
    }
    const zip = path.join(directory, "Opensteer Beta.zip");
    if (state.staged.includes(target.id)) {
      const stagedDigest = (await onTarget(context, target, "/usr/bin/shasum", ["-a", "256", zip]))
        .trim()
        .split(/\s/u)[0];
      if (stagedDigest !== state.zipSha256)
        throw new Error(
          `Previously staged archive digest differs on ${target.id}; retained for investigation`,
        );
      await verify(target, path.join(directory, "Opensteer Beta.app"), config, context);
      continue;
    }
    await onTarget(context, target, "/bin/mkdir", ["-p", directory]);
    if (target.sshHost)
      await execute(
        context,
        "/usr/bin/scp",
        [
          "-oBatchMode=yes",
          "-oConnectTimeout=10",
          "-oStrictHostKeyChecking=yes",
          artifactPath(context),
          `${target.sshHost}:${zip}`,
        ],
        300_000,
      );
    else await execute(context, "/bin/cp", [artifactPath(context), zip]);
    if (
      (await onTarget(context, target, "/usr/bin/shasum", ["-a", "256", zip]))
        .trim()
        .split(/\s/u)[0] !== state.zipSha256
    )
      throw new Error(`Transferred archive digest differs on ${target.id}`);
    await onTarget(context, target, "/usr/bin/ditto", ["-x", "-k", zip, directory], 300_000);
    await verify(target, path.join(directory, "Opensteer Beta.app"), config, context);
    if (!state.staged.includes(target.id)) state.staged.push(target.id);
    await save(context, state, local);
  }
  return state;
}

export async function installMac(input: MacConfig, context: MacContext) {
  const config = macConfigSchema.parse(input);
  return installTargets(config, context, localMacDestinations(config));
}

export async function installLocalMac(input: LocalMacConfig, context: MacContext) {
  return installTargets(localMacConfigSchema.parse(input), context, true);
}

function rollbackPath(target: Target, context: MacContext) {
  return `${target.applicationPath}.${context.identity.sourceRevision}.previous`;
}

async function recordRollback(target: Target, context: MacContext, state: Receipt) {
  const backup = rollbackPath(target, context);
  const output = await onTarget(context, target, "/bin/sh", [
    "-c",
    'set -eu; bundle=$1; if [ -d "$bundle" ] && [ ! -L "$bundle" ]; then printf "present\\n"; for key in CFBundleShortVersionString OpensteerSourceRevision; do value=; if [ -f "$bundle/Contents/Info.plist" ]; then value=$(/usr/libexec/PlistBuddy -c "Print :$key" "$bundle/Contents/Info.plist" 2>/dev/null) || value=; fi; printf "%s\\n" "$value"; done; fi',
    "release-beta-rollback-identity",
    backup,
  ]);
  const [present, version, sourceRevision] = output.trimEnd().split("\n");
  if (present === "present") {
    state.rollback[target.id] = {
      path: backup,
      version: version || null,
      sourceRevision: sourceRevision || null,
    };
  } else if (output.trim()) {
    throw new Error(`Invalid rollback identity on ${target.id}`);
  } else {
    delete state.rollback[target.id];
  }
}

export async function cleanupMacApp(target: Target, context: MacContext) {
  try {
    const script = await readFile(
      fileURLToPath(new URL("./mac-app-cleanup.py", import.meta.url)),
      "utf8",
    );
    const output = await onTarget(
      context,
      target,
      "python3",
      [
        "-c",
        script,
        "release-beta-cleanup",
        target.applicationPath,
        context.identity.sourceRevision,
        !target.sshHost && context.heldApplicationLock === `${target.applicationPath}.install.lock`
          ? "held"
          : "acquire",
      ],
      300_000,
    );
    const result = z
      .strictObject({
        removed: z.array(z.string()),
        unowned: z.array(z.strictObject({ path: z.string(), bytes: z.number().nonnegative() })),
        warnings: z.array(z.string()),
      })
      .parse(JSON.parse(output));
    for (const removed of result.removed)
      process.stdout.write(`Removed installer leftover: ${removed}\n`);
    for (const entry of result.unowned)
      process.stdout.write(`Kept unowned install sibling: ${entry.path} (${entry.bytes} bytes)\n`);
    for (const warning of result.warnings)
      process.stderr.write(`Install cleanup warning on ${target.id}: ${warning}\n`);
  } catch (error) {
    process.stderr.write(
      `Install cleanup warning on ${target.id}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

async function installTargets(config: BuildConfig, context: MacContext, local: boolean) {
  const verify = local ? verifyLocalBundle : verifyBundle;
  const state = await receipt(config, context, local);
  if (!config.targets.every((target) => state.staged.includes(target.id)))
    throw new Error("Every Mac must be staged before any installation");
  for (const target of config.targets) {
    if (state.installed.includes(target.id)) {
      await verify(target, target.applicationPath, config, context);
      continue;
    }
    let installedRevision: string | undefined;
    try {
      installedRevision = (
        await onTarget(context, target, "/usr/libexec/PlistBuddy", [
          "-c",
          "Print :OpensteerSourceRevision",
          path.join(target.applicationPath, "Contents/Info.plist"),
        ])
      ).trim();
    } catch {
      context.signal?.throwIfAborted();
    }
    if (installedRevision === context.identity.sourceRevision) {
      await verify(target, target.applicationPath, config, context);
      await recordRollback(target, context, state);
      state.installed.push(target.id);
      await save(context, state, local);
      continue;
    }
    const staged = path.join(
      target.stagingDirectory,
      context.identity.sourceRevision,
      "Opensteer Beta.app",
    );
    await verify(target, staged, config, context);
    const prepared = `${target.applicationPath}.${context.identity.sourceRevision}.next`;
    const backup = rollbackPath(target, context);
    if (local && state.appTreeSha256) await copyMacApp(staged, prepared, context);
    else {
      await onTarget(
        context,
        target,
        "/bin/sh",
        [
          "-c",
          'set -eu; staged=$1; next=$2; if [ -L "$next" ]; then echo "Prepared application cannot be a symlink" >&2; exit 1; fi; if [ ! -e "$next" ]; then /usr/bin/ditto "$staged" "$next"; fi; test -d "$next"',
          "release-beta-prepare",
          staged,
          prepared,
        ],
        300_000,
      );
    }
    // A previous interrupted copy is untrusted until its actual install bytes
    // pass the entry point's identity, signature and resource checks.
    await verify(target, prepared, config, context);
    const now = context.now ?? Date.now;
    const deadline = now() + 120_000;
    const runningProcesses = async () =>
      (
        await onTarget(
          context,
          target,
          "/bin/ps",
          ["-axo", "pid=,command="],
          Math.max(1, Math.min(10_000, deadline - now())),
        )
      )
        .split("\n")
        .filter(
          (line) =>
            /^\s*\d+\s/u.test(line) &&
            line
              .trim()
              .replace(/^\d+\s+/u, "")
              .startsWith(`${target.applicationPath}/Contents/MacOS/`),
        );
    let running = await runningProcesses();
    const quitFailure = async (cause?: unknown): Promise<never> => {
      const diagnostic = path.join(context.stateDirectory, `quit-${target.id}.json`);
      const failure =
        cause instanceof Error ? cause.message : cause === undefined ? undefined : String(cause);
      await replacePrivateFileAtomically(
        diagnostic,
        JSON.stringify(
          { target: target.id, running, prepared, original: target.applicationPath, failure },
          null,
          2,
        ) + "\n",
      );
      const reason = failure
        ? `Graceful quit failed: ${failure}`
        : "Opensteer Beta did not quit within two minutes";
      throw new Error(
        `${reason} on ${target.id}; live PID(s): ${running.map((line) => line.trim().split(/\s/u)[0]).join(", ")}. The original app and prepared copy are retained. Diagnostics: ${diagnostic}`,
        { cause },
      );
    };
    if (running.length) {
      try {
        await onTarget(
          context,
          target,
          "/usr/bin/osascript",
          [
            "-e",
            "on run argv\n tell application (item 1 of argv) to quit\nend run",
            target.applicationPath,
          ],
          Math.max(1, Math.min(30_000, deadline - now())),
        );
      } catch (error) {
        context.signal?.throwIfAborted();
        await quitFailure(error);
      }
      let announced = false;
      while (running.length) {
        if (now() >= deadline) await quitFailure();
        if (!announced) {
          process.stdout.write(
            `Waiting for Opensteer Beta to finish quitting on ${target.id}. The original installation is retained; waiting is bounded to two minutes.\n`,
          );
          announced = true;
        }
        try {
          running = await runningProcesses();
        } catch (error) {
          context.signal?.throwIfAborted();
          await quitFailure(error);
        }
        if (!running.length) break;
        if (now() >= deadline) await quitFailure();
        await delay(Math.min(1_000, Math.max(1, deadline - now())), undefined, {
          signal: context.signal,
        });
      }
    }
    await verify(target, prepared, config, context);
    // Both renames stay in the install filesystem. A crash leaves either the
    // original bundle or its retained backup; resume finishes the second rename.
    await onTarget(
      context,
      target,
      "/bin/sh",
      [
        "-c",
        'set -eu; app=$1; next=$2; backup=$3; test -d "$next"; test ! -L "$next"; test ! -L "$app"; test ! -L "$backup"; if /bin/ps -axo command= | /usr/bin/grep -F "$app/Contents/MacOS/" | /usr/bin/grep -v grep >/dev/null; then echo "Quit Opensteer Beta before installation" >&2; exit 1; fi; if [ -e "$app" ]; then if [ -e "$backup" ]; then echo "Retained backup and installed bundle both exist; reconcile installation before resume" >&2; exit 1; fi; /bin/mv "$app" "$backup"; fi; /bin/mv "$next" "$app"',
        "release-beta-install",
        target.applicationPath,
        prepared,
        backup,
      ],
      300_000,
    );
    await recordRollback(target, context, state);
    await save(context, state, local);
    try {
      await verify(target, target.applicationPath, config, context);
    } catch (error) {
      // No launch has happened: restore the original before exposing bad bytes.
      // Ignore cancellation only for this bounded safety operation.
      await onTarget(
        { ...context, signal: new AbortController().signal },
        target,
        "/bin/sh",
        [
          "-c",
          'set -eu; app=$1; next=$2; backup=$3; test ! -L "$app"; test ! -L "$next"; test ! -L "$backup"; if /bin/ps -axo command= | /usr/bin/grep -F "$app/Contents/MacOS/" | /usr/bin/grep -v grep >/dev/null; then echo "Application started; backup retained at $backup" >&2; exit 1; fi; if [ -d "$backup" ]; then test ! -e "$next"; /bin/mv "$app" "$next"; /bin/mv "$backup" "$app"; fi',
          "release-beta-restore",
          target.applicationPath,
          prepared,
          backup,
        ],
        30_000,
      ).catch((restoreError: unknown) => {
        throw new Error(
          `Post-swap verification failed; restore incomplete. In-flight backup: ${backup}`,
          { cause: new AggregateError([error, restoreError]) },
        );
      });
      await recordRollback(target, context, state);
      await save(context, state, local);
      throw new Error(
        `Post-swap verification failed; original app restored when present. Rejected copy: ${prepared}`,
        { cause: error },
      );
    }
    state.installed.push(target.id);
    await save(context, state, local);
  }
  return state;
}

export async function verifyMac(input: MacConfig, context: MacContext) {
  const config = macConfigSchema.parse(input);
  return verifyTargets(config, context, localMacDestinations(config));
}

export async function verifyLocalMac(input: LocalMacConfig, context: MacContext) {
  const config = localMacConfigSchema.parse(input);
  try {
    return await verifyTargets(config, context, true);
  } catch (error) {
    context.signal?.throwIfAborted();
    let policyLog: string;
    try {
      policyLog = await execute(
        context,
        "/usr/bin/log",
        [
          "show",
          "--last",
          "2m",
          "--style",
          "compact",
          "--predicate",
          '(process == "syspolicyd" OR process == "amfid") AND eventMessage CONTAINS[c] "Opensteer"',
        ],
        15_000,
      );
    } catch (diagnosticError) {
      policyLog = `Policy log unavailable: ${diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)}`;
    }
    const diagnostic = path.join(context.stateDirectory, "local-launch-diagnostics.json");
    const detail = error instanceof Error ? error.message : String(error);
    await replacePrivateFileAtomically(
      diagnostic,
      JSON.stringify(
        {
          application: config.targets[0].applicationPath,
          error: detail,
          policyLog: policyLog.slice(-16_000),
        },
        null,
        2,
      ) + "\n",
    );
    throw new Error(
      `Local launch/health verification failed: ${detail}. macOS policy diagnostics: ${diagnostic}`,
      { cause: error },
    );
  }
}

async function verifyTargets(config: BuildConfig, context: MacContext, local: boolean) {
  const verify = local ? verifyLocalBundle : verifyBundle;
  const state = await receipt(config, context, local);
  for (const target of config.targets) {
    if (!state.installed.includes(target.id))
      throw new Error(`Installation incomplete on ${target.id}`);
    await verify(target, target.applicationPath, config, context);
    try {
      await onTarget(context, target, "/usr/bin/open", [target.applicationPath]);
      let healthy = false;
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          const processes = await onTarget(context, target, "/bin/ps", ["-axo", "command="]);
          const appExecutable = `${target.applicationPath}/Contents/MacOS/Opensteer Beta`;
          const helperExecutable = `${target.applicationPath}/Contents/Resources/process-supervisor/opensteer-process-supervisor`;
          if (
            !processes
              .split("\n")
              .some(
                (line) =>
                  line.trim() === appExecutable || line.trim().startsWith(`${appExecutable} `),
              )
          )
            throw new Error("Installed application is not running");
          if (target.runtimeStatusUrl !== null && !processes.includes(helperExecutable))
            throw new Error("Installed application supervisor is not running");
          if (local) {
            const runtime = path.join(
              target.applicationPath,
              "Contents/Resources/personal-runtime",
            );
            for (const script of [
              personalRuntimeLayout.hostScript,
              personalRuntimeLayout.runnerScript,
            ])
              if (
                !processes
                  .split("\n")
                  .some(
                    (line) =>
                      line
                        .trim()
                        .startsWith(path.join(runtime, personalRuntimeLayout.interpreter) + " ") &&
                      line.includes(path.join(runtime, script)),
                  )
              )
                throw new Error(`Installed Personal service is not running: ${script}`);
          }
          if (target.runtimeStatusUrl !== null)
            z.object({ ok: z.literal(true) }).parse(
              JSON.parse(
                await onTarget(
                  context,
                  target,
                  "/usr/bin/curl",
                  [
                    "--fail",
                    "--silent",
                    "--show-error",
                    "--max-time",
                    "10",
                    target.runtimeStatusUrl,
                  ],
                  15_000,
                ),
              ),
            );
          healthy = true;
          break;
        } catch (error) {
          if (attempt === 5) throw error;
          await delay(5_000, undefined, { signal: context.signal });
        }
      }
      if (!healthy) throw new Error(`Runtime smoke failed on ${target.id}`);
    } catch (error) {
      throw new Error(
        `Launch/health verification failed on ${target.id}. In-flight backup (if a prior app existed): ${rollbackPath(target, context)}. No automatic app or Personal database restore was attempted. ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    await cleanupMacApp(target, context);
    await recordRollback(target, context, state);
    if (!state.verified.includes(target.id)) state.verified.push(target.id);
    await save(context, state, local);
  }
  return {
    ...state,
    smoke:
      "Signed source identity, installed app processes, and bundled supervisor bytes on every configured Mac; running supervisor and loopback Host /healthz were checked where initialized. Authenticated UI and computer permissions were not exercised.",
  };
}
