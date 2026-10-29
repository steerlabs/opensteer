import { desktopUpdateFeed } from "../src/releases/desktop-update-policy.js";
import { readEmbeddedDesktopRelease } from "../src/config.js";
import { requiredEnvironmentValue } from "@opensteer/shared/envParsing";
import { cp } from "node:fs/promises";
import { readProvenPersonalRuntime } from "./personal-runtime-provenance.js";
import { withMacSigningTimings } from "./mac-signing-timing.js";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { arch as hostArchitecture } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv.includes("--unsigned")) {
  await import("./package-contributor-macos.js");
} else {
  const require = createRequire(import.meta.url);
  const { timePhase } = require("../../../scripts/release-phase-timing.cjs") as {
    timePhase: <T>(phase: string, work: () => Promise<T>) => Promise<T>;
  };
  const { readSigningMode } =
    require("./signing-input.cjs") as typeof import("./signing-input.cjs");
  const signingMode = readSigningMode({ ...process.env, OPENSTEER_DESKTOP_RELEASE: "1" });
  if (signingMode.mode !== "signed") throw Error("A signed release identity is required.");
  const opensteerAppleTeamId = signingMode.signing.teamId;
  const { desktopReleaseMetadata } = require("./desktop-release-metadata.cjs") as {
    readonly desktopReleaseMetadata: (
      repositoryRoot: string,
      environment?: NodeJS.ProcessEnv,
    ) => {
      readonly builderArguments: readonly string[];
      readonly identity: { readonly sourceRevision: string; readonly version: string };
    };
  };

  const packageManager = requiredEnvironmentValue(
    process.env,
    "npm_execpath",
    "pnpm did not provide npm_execpath to the Desktop release script.",
  );

  const desktopDirectory = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const repositoryRoot = path.resolve(desktopDirectory, "../..");
  const targetArchitecture = macosArchitecture(
    process.env.OPENSTEER_DESKTOP_TARGET_ARCH ?? hostArchitecture(),
  );
  const releaseChannel = desktopReleaseChannel(process.env.OPENSTEER_DESKTOP_RELEASE_CHANNEL);
  const builderConfig = desktopBuilderConfig(releaseChannel);
  const releaseMetadata = desktopReleaseMetadata(repositoryRoot, process.env);
  const deferNotarization = process.env.OPENSTEER_DESKTOP_DEFER_NOTARIZATION === "1";
  const releaseEnvironment = {
    ...process.env,
    OPENSTEER_APPLE_TEAM_ID: signingMode.signing.teamId,
    ...(signingMode.signing.keychain
      ? {
          CSC_KEYCHAIN: signingMode.signing.keychain,
          ...(signingMode.signing.notarizationProfile
            ? { APPLE_KEYCHAIN: signingMode.signing.keychain }
            : {}),
          CSC_LINK: undefined,
          CSC_INSTALLER_LINK: undefined,
        }
      : {}),
    CSC_NAME: signingMode.signing.identity.replace(/^Developer ID Application:\s*/u, ""),
    ...(signingMode.signing.notarizationProfile
      ? { APPLE_KEYCHAIN_PROFILE: signingMode.signing.notarizationProfile }
      : {}),
    OPENSTEER_DESKTOP_RELEASE: "1",
    OPENSTEER_DESKTOP_TARGET_ARCH: targetArchitecture.manifest,
    OPENSTEER_DESKTOP_TARGET_OS: "darwin",
  };
  requireSigningAuthority(releaseEnvironment);
  const { preparePasskeySigning } =
    require("./passkeys-signing.cjs") as typeof import("./passkeys-signing.cjs");
  const { desktopReleaseIdentity } = require("./macos-release-identity.cjs") as {
    desktopReleaseIdentity(channel: "stable" | "beta"): import("./passkeys-signing.cjs").PasskeySigningIdentity;
  };
  const passkeySigningArguments = preparePasskeySigning(
    desktopDirectory, releaseEnvironment, desktopReleaseIdentity(releaseChannel),
  );
  if (!deferNotarization) requireNotarizationAuthority(releaseEnvironment);

  // Every preparation, compilation, and packaging step receives the same release
  // identity. In particular, resource preparation cannot silently fall back to a
  // locally built process supervisor in a signed macOS artifact.
  await timePhase("package.resource-prep", () =>
    run(["prepare:release-resources"], releaseEnvironment),
  );
  const personal = await readProvenPersonalRuntime(
    requiredEnvironmentValue(
      process.env,
      "OPENSTEER_PERSONAL_RUNTIME_SOURCE",
      "Personal runtime source is required",
    ),
    {
      architecture: targetArchitecture.manifest,
      operatingSystem: "darwin",
      ...releaseMetadata.identity,
      runnerSourceRevision:
        process.env.OPENSTEER_RUNNER_SOURCE_REVISION ?? releaseMetadata.identity.sourceRevision,
    },
  );
  await timePhase("package.tsup", () =>
    run(["exec", "tsup", "--config", "tsup.config.ts"], releaseEnvironment),
  );
  await cp(personal.assets.webDistribution.directory, path.join(desktopDirectory, "dist/web"), {
    recursive: true,
  });
  await run(["exec", "node", "scripts/verify-runtime-imports.mjs"], releaseEnvironment);
  const updates = readEmbeddedDesktopRelease(
    path.join(desktopDirectory, "dist", "desktop-release.json"),
  ).updates;
  const updateFeed = updates ? desktopUpdateFeed(updates) : undefined;
  await timePhase("package.electron-builder", () =>
    withMacSigningTimings(releaseEnvironment, desktopDirectory, (signingEnvironment) =>
      run(
        [
          "exec",
          "electron-builder",
          "--mac",
          "--config",
          builderConfig,
          "-c.forceCodeSigning=true",
          ...releaseMetadata.builderArguments,
          ...passkeySigningArguments,
          `-c.mac.extendInfo.OpensteerSourceRevision=${releaseMetadata.identity.sourceRevision}`,
          ...(updateFeed ? [`-c.mac.extendInfo.OpensteerUpdateFeed=${updateFeed}`] : []),
          ...(deferNotarization ? ["--dir", "-c.mac.notarize=false"] : []),
          targetArchitecture.builderFlag,
        ],
        signingEnvironment,
      ),
    ),
  );
  await timePhase("package.final-verification", () =>
    verifyPackagedApplication(
      releaseChannel,
      targetArchitecture.manifest,
      releaseMetadata.identity.version,
    ),
  );

  function desktopReleaseChannel(channel: string | undefined): "beta" | "stable" {
    if (channel === "beta" || channel === "stable") return channel;
    throw new Error("OPENSTEER_DESKTOP_RELEASE_CHANNEL must be beta or stable.");
  }

  function desktopBuilderConfig(channel: "beta" | "stable"): string {
    return channel === "beta" ? "electron-builder.beta.yml" : "electron-builder.yml";
  }

  function macosArchitecture(value: string): {
    readonly builderFlag: "--arm64" | "--x64";
    readonly manifest: "amd64" | "arm64";
  } {
    switch (value.trim().toLowerCase()) {
      case "amd64":
      case "x64":
      case "x86_64":
        return { builderFlag: "--x64", manifest: "amd64" };
      case "aarch64":
      case "arm64":
        return { builderFlag: "--arm64", manifest: "arm64" };
      default:
        throw new Error(`Unsupported macOS Desktop release architecture: ${value}`);
    }
  }

  async function run(arguments_: readonly string[], environment: NodeJS.ProcessEnv): Promise<void> {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn(process.execPath, [packageManager, ...arguments_], {
        env: environment,
        shell: false,
        stdio: "inherit",
      });
      child.once("error", rejectPromise);
      child.once("exit", (code, signal) => {
        if (code === 0) resolvePromise();
        else rejectPromise(new Error(`pnpm failed (${signal ?? `exit ${code ?? "unknown"}`}).`));
      });
    });
  }

  function requireSigningAuthority(environment: NodeJS.ProcessEnv): void {
    const expectedTeamId = environment.OPENSTEER_APPLE_TEAM_ID?.trim();
    if (expectedTeamId !== opensteerAppleTeamId) {
      throw new Error(
        `OPENSTEER_APPLE_TEAM_ID must match the configured Team ID ${opensteerAppleTeamId}.`,
      );
    }
  }

  function requireNotarizationAuthority(environment: NodeJS.ProcessEnv): void {
    const expectedTeamId = environment.OPENSTEER_APPLE_TEAM_ID?.trim();
    const profile = environment.APPLE_KEYCHAIN_PROFILE?.trim();
    const keychain = environment.APPLE_KEYCHAIN?.trim();
    const apiKey = environment.APPLE_API_KEY?.trim();
    const apiKeyId = environment.APPLE_API_KEY_ID?.trim();
    const apiIssuer = environment.APPLE_API_ISSUER?.trim();
    const appleId = environment.APPLE_ID?.trim();
    const appleIdPassword = environment.APPLE_APP_SPECIFIC_PASSWORD?.trim();
    const appleTeamId = environment.APPLE_TEAM_ID?.trim();

    const usesProfile = Boolean(profile || keychain);
    const usesApiKey = Boolean(apiKey || apiKeyId || apiIssuer);
    const usesAppleId = Boolean(appleId || appleIdPassword || appleTeamId);
    const strategyCount = Number(usesProfile) + Number(usesApiKey) + Number(usesAppleId);
    if (strategyCount !== 1) {
      throw new Error(
        "Exactly one complete Apple notarization credential strategy must be configured.",
      );
    }
    if (usesProfile && !profile) {
      throw new Error("APPLE_KEYCHAIN_PROFILE is required when APPLE_KEYCHAIN is configured.");
    }
    if (usesApiKey && (!apiKey || !apiKeyId || !apiIssuer)) {
      throw new Error(
        "APPLE_API_KEY, APPLE_API_KEY_ID, and APPLE_API_ISSUER are all required for notarization.",
      );
    }
    if (usesAppleId && (!appleId || !appleIdPassword || !appleTeamId)) {
      throw new Error(
        "APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID are all required for notarization.",
      );
    }
    if (usesAppleId && appleTeamId !== expectedTeamId) {
      throw new Error("APPLE_TEAM_ID must match OPENSTEER_APPLE_TEAM_ID.");
    }
  }

  async function verifyPackagedApplication(
    channel: "beta" | "stable",
    architecture: "amd64" | "arm64",
    releaseVersion: string,
  ): Promise<void> {
    const outputDirectory = path.join(
      desktopDirectory,
      "release",
      channel === "beta" ? "beta" : "",
    );
    const applicationDirectory = path.join(
      outputDirectory,
      architecture === "arm64" ? "mac-arm64" : "mac",
      channel === "beta" ? "Opensteer Beta.app" : "Opensteer.app",
    );
    const infoPlist = path.join(applicationDirectory, "Contents", "Info.plist");
    for (const key of ["CFBundleShortVersionString", "CFBundleVersion"] as const) {
      const value = await captureExecutable("/usr/libexec/PlistBuddy", [
        "-c",
        `Print :${key}`,
        infoPlist,
      ]);
      if (value !== releaseVersion) {
        throw new Error(`${key} ${value} does not match canonical release ${releaseVersion}.`);
      }
    }
    await runExecutable("/usr/bin/codesign", [
      "--verify",
      "--deep",
      "--strict",
      "--verbose=2",
      applicationDirectory,
    ]);
    // A deferred release persists Apple's request before polling and performs
    // Gatekeeper and staple validation before allowing this bundle to be staged.
    if (deferNotarization) return;
    await runExecutable("/usr/sbin/spctl", [
      "--assess",
      "--type",
      "execute",
      "--verbose=4",
      applicationDirectory,
    ]);
    await runExecutable("/usr/bin/xcrun", ["stapler", "validate", applicationDirectory]);
  }

  async function captureExecutable(
    executable: string,
    arguments_: readonly string[],
  ): Promise<string> {
    return new Promise<string>((resolvePromise, rejectPromise) => {
      const chunks: Buffer[] = [];
      const child = spawn(executable, [...arguments_], {
        shell: false,
        stdio: ["ignore", "pipe", "inherit"],
      });
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.once("error", rejectPromise);
      child.once("exit", (code, signal) => {
        if (code === 0) resolvePromise(Buffer.concat(chunks).toString("utf8").trim());
        else
          rejectPromise(
            new Error(`${executable} failed (${signal ?? `exit ${code ?? "unknown"}`}).`),
          );
      });
    });
  }

  async function runExecutable(executable: string, arguments_: readonly string[]): Promise<void> {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn(executable, [...arguments_], {
        shell: false,
        stdio: "inherit",
      });
      child.once("error", rejectPromise);
      child.once("exit", (code, signal) => {
        if (code === 0) resolvePromise();
        else {
          rejectPromise(
            new Error(`${executable} failed (${signal ?? `exit ${code ?? "unknown"}`}).`),
          );
        }
      });
    });
  }
}
