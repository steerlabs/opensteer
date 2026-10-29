import { requiredEnvironmentValue } from "@opensteer/shared/envParsing";
import { assertRegularFile, setFileMode } from "@opensteer/shared/privateFiles";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readPersonalRuntimeRelease } from "../src/releases/personal-runtime-release.js";
import { readEmbeddedDesktopRelease } from "../src/config.js";
import { verifyAgentPhoneRelease } from "../../../scripts/release-agent-phone.cjs";
import {
  agentPhoneApkName,
  agentPhoneManifestName,
  agentPhoneResourceDirectory,
  readBundledAgentPhoneArtifact,
} from "../src/agent-phone/agent-phone-artifact.js";
import {
  computerUseHelperAppName,
  computerUseHelperBundleId,
} from "../src/computer-use/helper-paths.js";
import {
  passwordsBrokerAppName,
  passwordsBrokerExecutableName,
  passwordsReleaseBrokerBundleId,
} from "../src/passwords/paths.js";

const desktopDirectory = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = path.resolve(desktopDirectory, "../..");
const targetDirectory = path.join(desktopDirectory, "generated-resources");

async function main(): Promise<void> {
  const targetOs = targetOperatingSystem();
  const targetArch = targetArchitecture();
  const applicationChannel = releaseChannel(
    requiredEnvironmentValue(
      process.env,
      "OPENSTEER_DESKTOP_RELEASE_CHANNEL",
      "OPENSTEER_DESKTOP_RELEASE_CHANNEL is required for a Desktop release build.",
    ),
  );
  const releaseProfile = readEmbeddedDesktopRelease(
    path.join(
      desktopDirectory,
      "src",
      "releases",
      applicationChannel === "beta" ? "desktop-release.beta.json" : "desktop-release.source.json",
    ),
  );
  if (releaseProfile.application.channel !== applicationChannel) {
    throw new Error("Desktop release profile channel does not match the requested build channel.");
  }
  const personalSource = path.resolve(
    requiredEnvironmentValue(
      process.env,
      "OPENSTEER_PERSONAL_RUNTIME_SOURCE",
      "OPENSTEER_PERSONAL_RUNTIME_SOURCE is required for a Desktop release build.",
    ),
  );
  const personal = await readPersonalRuntimeRelease(personalSource, {
    architecture: targetArch,
    operatingSystem: targetOs,
  });
  const processSupervisorName =
    targetOs === "win32" ? "opensteer-process-supervisor.exe" : "opensteer-process-supervisor";
  const locallyBuiltProcessSupervisor = path.join(
    desktopDirectory,
    "generated-native",
    `${targetOs === "win32" ? "windows" : targetOs}-${targetArch}`,
    processSupervisorName,
  );
  const processSupervisorSource = path.resolve(
    process.env.OPENSTEER_PROCESS_SUPERVISOR_BINARY_SOURCE?.trim() || locallyBuiltProcessSupervisor,
  );
  if (
    process.env.OPENSTEER_DESKTOP_RELEASE === "1" &&
    !process.env.OPENSTEER_PROCESS_SUPERVISOR_BINARY_SOURCE?.trim()
  ) {
    throw new Error(
      "OPENSTEER_PROCESS_SUPERVISOR_BINARY_SOURCE is required for a signed Desktop release.",
    );
  }
  await assertRegularFile(processSupervisorSource, "process-supervisor binary source");
  const processSupervisorDigest = createHash("sha256")
    .update(await readFile(processSupervisorSource))
    .digest("hex");
  const expectedProcessSupervisorDigest =
    process.env.OPENSTEER_PROCESS_SUPERVISOR_BINARY_SHA256?.trim();
  if (process.env.OPENSTEER_DESKTOP_RELEASE === "1" && !expectedProcessSupervisorDigest) {
    throw new Error(
      "OPENSTEER_PROCESS_SUPERVISOR_BINARY_SHA256 is required for a signed Desktop release.",
    );
  }
  if (
    expectedProcessSupervisorDigest &&
    (!/^[a-f0-9]{64}$/u.test(expectedProcessSupervisorDigest) ||
      expectedProcessSupervisorDigest !== processSupervisorDigest)
  ) {
    throw new Error("Process-supervisor binary digest does not match the reviewed release input.");
  }

  const cloudflaredVersion = stableVersion(
    requiredEnvironmentValue(
      process.env,
      "OPENSTEER_CLOUDFLARED_RELEASE_VERSION",
      "OPENSTEER_CLOUDFLARED_RELEASE_VERSION is required for a Desktop release build.",
    ),
    "OPENSTEER_CLOUDFLARED_RELEASE_VERSION",
  );
  if (!supportsCloudflaredTokenFile(cloudflaredVersion)) {
    throw new Error("OPENSTEER_CLOUDFLARED_RELEASE_VERSION must be 2025.4.0 or newer.");
  }
  const expectedCloudflaredDigest = expectedDigest("OPENSTEER_CLOUDFLARED_BINARY_SHA256");
  const cloudflaredSource = path.resolve(
    requiredEnvironmentValue(
      process.env,
      "OPENSTEER_CLOUDFLARED_BINARY_SOURCE",
      "OPENSTEER_CLOUDFLARED_BINARY_SOURCE is required for a Desktop release build.",
    ),
  );
  await assertRegularFile(cloudflaredSource, "cloudflared binary source");
  const cloudflared = await readFile(cloudflaredSource);
  const actualCloudflaredDigest = createHash("sha256").update(cloudflared).digest("hex");
  if (actualCloudflaredDigest !== expectedCloudflaredDigest) {
    throw new Error(
      `cloudflared binary digest mismatch: expected ${expectedCloudflaredDigest}, got ${actualCloudflaredDigest}`,
    );
  }

  // `pnpm build:agent-phone` writes the app into the directory this script
  // replaces, so it is read before the swap and written back after it. The
  // after-pack gate refuses a release package without a release build; a
  // local package without the Android toolchain ships without it, and the
  // Computers page says so.
  const agentPhone = await readBundledAgentPhoneArtifact(
    path.join(targetDirectory, agentPhoneResourceDirectory),
  );
  if (process.env.OPENSTEER_DESKTOP_RELEASE === "1") {
    verifyAgentPhoneRelease(
      path.join(targetDirectory, agentPhoneResourceDirectory),
      requiredEnvironmentValue(
        process.env,
        "OPENSTEER_AGENT_PHONE_RELEASE_RECEIPT",
        "A Desktop release requires a trusted Agent Phone release receipt.",
      ),
      {
        receiptSha256: process.env.OPENSTEER_AGENT_PHONE_RELEASE_RECEIPT_SHA256,
        sourceRevision: process.env.OPENSTEER_SOURCE_REVISION,
        version: process.env.OPENSTEER_RELEASE_VERSION,
      },
    );
  }

  const includePortableFs = optionalBoolean("OPENSTEER_DESKTOP_PORTABLEFS_VARIANT", false);
  const portableFs = includePortableFs ? await portableFsRelease(targetOs) : undefined;

  const temporary = `${targetDirectory}.tmp-${process.pid}`;
  await rm(temporary, { force: true, recursive: true });
  try {
    await Promise.all(
      [
        // Always created, empty when this build carries no Agent Phone app.
        agentPhoneResourceDirectory,
        "cloudflared",
        // Always created, populated on macOS only: `extraResources` names the
        // directory unconditionally, and an empty one on Windows or Linux is
        // the truthful statement that those platforms ship no helper.
        "computer-use",
        "desktop",
        // Populated on macOS only, like computer-use.
        "passwords",
        "personal-runtime",
        "portablefs",
        "process-supervisor",
        "runner",
      ].map((name) => mkdir(path.join(temporary, name), { mode: 0o700, recursive: true })),
    );
    await writeJson(path.join(temporary, "desktop", "release.json"), {
      ...releaseProfile,
      capabilities: {
        ...releaseProfile.capabilities,
        localAgents: true,
        portableFs: includePortableFs,
      },
    });

    const cloudflaredName = targetOs === "win32" ? "cloudflared.exe" : "cloudflared";
    const cloudflaredTarget = path.join(temporary, "cloudflared", cloudflaredName);
    await copyFile(cloudflaredSource, cloudflaredTarget);
    await setArtifactMode(cloudflaredTarget, "executable", targetOs);
    await writeJson(path.join(temporary, "cloudflared", "release.json"), {
      architecture: targetArch,
      binarySha256: actualCloudflaredDigest,
      operatingSystem: targetOs,
      schemaVersion: 1,
      version: cloudflaredVersion,
    });

    await stagePersonalRuntime(personalSource, temporary, personal.manifest, targetOs);

    const processSupervisorTarget = path.join(
      temporary,
      "process-supervisor",
      processSupervisorName,
    );
    await copyFile(processSupervisorSource, processSupervisorTarget);
    await setArtifactMode(processSupervisorTarget, "executable", targetOs);
    await writeJson(path.join(temporary, "process-supervisor", "release.json"), {
      architecture: targetArch,
      binarySha256: processSupervisorDigest,
      operatingSystem: targetOs,
      schemaVersion: 1,
    });

    const helperName = targetOs === "win32" ? "opensteer-native-fs.exe" : "opensteer-native-fs";
    if (process.env.OPENSTEER_DESKTOP_RELEASE === "1" && targetOs === "win32") {
      await requireValidAuthenticode(
        personal.entrypoints.nativeFsHelper,
        "Native filesystem helper",
      );
    }
    const helperTarget = path.join(temporary, "runner", helperName);
    await copyFile(personal.entrypoints.nativeFsHelper, helperTarget);
    await setArtifactMode(helperTarget, "executable", targetOs);
    const helperDigest = createHash("sha256")
      .update(await readFile(helperTarget))
      .digest("hex");
    await writeJson(path.join(temporary, "runner", "release.json"), {
      architecture: targetArch,
      binarySha256: helperDigest,
      operatingSystem: targetOs,
      schemaVersion: 1,
    });

    if (targetOs === "darwin") {
      await stageComputerUseHelper(path.join(temporary, "computer-use"), targetArch);
      await stagePasswordsBroker(path.join(temporary, "passwords"), targetArch);
    }

    if (agentPhone) {
      const agentPhoneDirectory = path.join(temporary, agentPhoneResourceDirectory);
      await writeFile(path.join(agentPhoneDirectory, agentPhoneApkName), agentPhone.bytes, {
        mode: 0o444,
      });
      // The trusted receipt binds the original manifest bytes, including their
      // formatting; re-encoding the parsed object would invalidate that digest.
      await copyFile(
        path.join(targetDirectory, agentPhoneResourceDirectory, agentPhoneManifestName),
        path.join(agentPhoneDirectory, agentPhoneManifestName),
      );
      await setArtifactMode(
        path.join(agentPhoneDirectory, agentPhoneManifestName),
        "data",
        targetOs,
      );
    }

    if (portableFs) {
      const portableDirectory = path.join(temporary, "portablefs");
      const installerTarget = path.join(portableDirectory, "install.sh");
      await copyFile(portableFs.installerSource, installerTarget);
      await setArtifactMode(installerTarget, "executable", targetOs);
      await writeJson(path.join(portableDirectory, "release.json"), {
        installerSha256: portableFs.installerSha256,
        schemaVersion: 1,
        version: portableFs.version,
      });
    }

    await rm(targetDirectory, { force: true, recursive: true });
    await rename(temporary, targetDirectory);
  } catch (error) {
    await rm(temporary, { force: true, recursive: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Stages the signed `Opensteer Computer Use.app` and pins it.
 *
 * A bundle is a directory, so there is no one file to digest the way the other
 * native binaries are digested: what is pinned is its main Mach-O executable
 * and its `CFBundleVersion`, which is also the number the runtime install
 * decision reads. `build-computer-use-helper.ts` already signed the bundle —
 * electron-builder is told not to re-sign it for exactly that reason — so a
 * release build verifies that signature here rather than producing one.
 */
async function stageComputerUseHelper(
  directory: string,
  targetArch: "amd64" | "arm64",
): Promise<void> {
  const source = path.join(
    repositoryRoot,
    "apps/desktop/native/computer-use/dist",
    computerUseHelperAppName,
  );
  if (!existsSync(source)) {
    throw new Error(
      `${computerUseHelperAppName} is missing. Run pnpm --filter desktop build:computer-use-helper before preparing release resources.`,
    );
  }
  const target = path.join(directory, computerUseHelperAppName);
  // `ditto` is what preserves a bundle's symlinks, resource forks and the
  // signature that covers them; a file-by-file copy would invalidate it.
  await run("/usr/bin/ditto", [source, target], repositoryRoot);
  if (process.env.OPENSTEER_DESKTOP_RELEASE === "1") {
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", target], repositoryRoot);
    const detail = await captureCombined(
      "/usr/bin/codesign",
      ["-dv", "--verbose=4", target],
      repositoryRoot,
    );
    const expectedTeam = requiredEnvironmentValue(
      process.env,
      "OPENSTEER_APPLE_TEAM_ID",
      "OPENSTEER_APPLE_TEAM_ID is required for a signed Desktop release.",
    );
    if (
      !detail.split(/\r?\n/u).includes(`Identifier=${computerUseHelperBundleId}`) ||
      !detail.split(/\r?\n/u).includes(`TeamIdentifier=${expectedTeam}`) ||
      !/^Authority=Developer ID Application:/mu.test(detail) ||
      /^Signature=adhoc$/mu.test(detail)
    ) {
      throw new Error("Computer use helper does not carry the required release identity.");
    }
  }
  const plist = JSON.parse(
    await capture(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", path.join(target, "Contents", "Info.plist")],
      repositoryRoot,
    ),
  ) as Record<string, unknown>;
  const version = plist.CFBundleVersion;
  const executableName = plist.CFBundleExecutable;
  if (typeof version !== "string" || typeof executableName !== "string") {
    throw new Error(`${computerUseHelperAppName} has no CFBundleVersion or CFBundleExecutable.`);
  }
  const executable = path.join(target, "Contents", "MacOS", executableName);
  await assertRegularFile(executable, "Computer use helper executable");
  const architectures = (await capture("/usr/bin/lipo", ["-archs", executable], repositoryRoot))
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  const expectedArchitecture = targetArch === "amd64" ? "x86_64" : "arm64";
  if (!architectures.includes(expectedArchitecture)) {
    throw new Error(`Computer use helper does not contain ${expectedArchitecture}.`);
  }
  if (
    process.env.OPENSTEER_DESKTOP_RELEASE === "1" &&
    (architectures.length !== 2 ||
      !architectures.includes("arm64") ||
      !architectures.includes("x86_64"))
  ) {
    throw new Error("A release Computer use helper must contain arm64 and x86_64.");
  }
  await writeJson(path.join(directory, "release.json"), {
    architecture: targetArch,
    executableSha256: createHash("sha256")
      .update(await readFile(executable))
      .digest("hex"),
    operatingSystem: "darwin",
    schemaVersion: 1,
    version,
  });
}

/**
 * Stages the signed `Opensteer Passwords.app` and pins it, as the computer use
 * helper is pinned: its main executable, its sandboxed import worker and its
 * `CFBundleVersion`. `build-passwords-broker.ts` signed both executables and
 * embedded the provisioning profile; electron-builder is told not to re-sign
 * the bundle, so a release build verifies all three here.
 */
async function stagePasswordsBroker(
  directory: string,
  targetArch: "amd64" | "arm64",
): Promise<void> {
  const source = path.join(
    repositoryRoot,
    "apps/desktop/native/passwords/dist",
    passwordsBrokerAppName,
  );
  if (!existsSync(source)) {
    throw new Error(
      `${passwordsBrokerAppName} is missing. Run pnpm --filter desktop build:passwords-broker before preparing release resources.`,
    );
  }
  const target = path.join(directory, passwordsBrokerAppName);
  await run("/usr/bin/ditto", [source, target], repositoryRoot);
  const executable = path.join(target, "Contents", "MacOS", passwordsBrokerExecutableName);
  const worker = path.join(target, "Contents", "Helpers", "Opensteer Passwords Import");
  await assertRegularFile(executable, "Opensteer Passwords executable");
  await assertRegularFile(worker, "Opensteer Passwords import worker");
  if (process.env.OPENSTEER_DESKTOP_RELEASE === "1") {
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", target], repositoryRoot);
    const expectedTeam = requiredEnvironmentValue(
      process.env,
      "OPENSTEER_APPLE_TEAM_ID",
      "OPENSTEER_APPLE_TEAM_ID is required for a signed Desktop release.",
    );
    for (const [signed, identifier] of [
      [target, passwordsReleaseBrokerBundleId],
      [worker, `${passwordsReleaseBrokerBundleId}.import`],
    ] as const) {
      const detail = await captureCombined(
        "/usr/bin/codesign",
        ["-dv", "--verbose=4", signed],
        repositoryRoot,
      );
      const lines = detail.split(/\r?\n/u);
      if (
        !lines.includes(`Identifier=${identifier}`) ||
        !lines.includes(`TeamIdentifier=${expectedTeam}`) ||
        !/^Authority=Developer ID Application:/mu.test(detail) ||
        /^Signature=adhoc$/mu.test(detail)
      ) {
        throw new Error(`${path.basename(signed)} does not carry the required release identity.`);
      }
    }
    await assertRegularFile(
      path.join(target, "Contents", "embedded.provisionprofile"),
      "Opensteer Passwords provisioning profile",
    );
  }
  const plist = JSON.parse(
    await capture(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", path.join(target, "Contents", "Info.plist")],
      repositoryRoot,
    ),
  ) as Record<string, unknown>;
  const version = plist.CFBundleVersion;
  if (typeof version !== "string") {
    throw new Error(`${passwordsBrokerAppName} has no CFBundleVersion.`);
  }
  const expectedArchitecture = targetArch === "amd64" ? "x86_64" : "arm64";
  for (const program of [executable, worker]) {
    const architectures = (await capture("/usr/bin/lipo", ["-archs", program], repositoryRoot))
      .trim()
      .split(/\s+/u)
      .filter(Boolean);
    if (!architectures.includes(expectedArchitecture)) {
      throw new Error(`${path.basename(program)} does not contain ${expectedArchitecture}.`);
    }
    if (
      process.env.OPENSTEER_DESKTOP_RELEASE === "1" &&
      (architectures.length !== 2 ||
        !architectures.includes("arm64") ||
        !architectures.includes("x86_64"))
    ) {
      throw new Error(`A release ${path.basename(program)} must contain arm64 and x86_64.`);
    }
  }
  const digest = async (file: string) =>
    createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
  await writeJson(path.join(directory, "release.json"), {
    architecture: targetArch,
    executableSha256: await digest(executable),
    operatingSystem: "darwin",
    schemaVersion: 1,
    version,
    workerSha256: await digest(worker),
  });
}

async function requireValidAuthenticode(filePath: string, label: string): Promise<void> {
  const script = [
    "$signature = Get-AuthenticodeSignature -LiteralPath $args[0]",
    "if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) { exit 9 }",
  ].join("; ");
  try {
    await run(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script, filePath],
      repositoryRoot,
    );
  } catch (error) {
    throw new Error(`${label} must carry a valid Authenticode signature.`, { cause: error });
  }
}

async function stagePersonalRuntime(
  source: string,
  generatedRoot: string,
  manifest: Awaited<ReturnType<typeof readPersonalRuntimeRelease>>["manifest"],
  operatingSystem: "darwin" | "linux" | "win32",
): Promise<void> {
  const target = path.join(generatedRoot, "personal-runtime");
  await copyFile(path.join(source, "release.json"), path.join(target, "release.json"));
  await setArtifactMode(path.join(target, "release.json"), "data", operatingSystem);
  for (const artifact of manifest.files) {
    const destination = path.join(target, ...artifact.path.split("/"));
    await mkdir(path.dirname(destination), { mode: 0o700, recursive: true });
    await copyFile(path.join(source, ...artifact.path.split("/")), destination);
    await setArtifactMode(destination, artifact.mode, operatingSystem);
  }
}

async function portableFsRelease(operatingSystem: "darwin" | "linux" | "win32"): Promise<{
  readonly installerSha256: string;
  readonly installerSource: string;
  readonly version: string;
}> {
  if (operatingSystem === "win32") {
    throw new Error(
      "The PortableFS Desktop variant is not available for Windows until a signed Windows installer contract exists.",
    );
  }
  const version = stableVersion(
    requiredEnvironmentValue(
      process.env,
      "OPENSTEER_PORTABLEFS_RELEASE_VERSION",
      "OPENSTEER_PORTABLEFS_RELEASE_VERSION is required for a Desktop release build.",
    ),
    "OPENSTEER_PORTABLEFS_RELEASE_VERSION",
  );
  const expectedInstallerDigest = expectedDigest("OPENSTEER_PORTABLEFS_INSTALLER_SHA256");
  const installerSource = path.resolve(
    process.env.OPENSTEER_PORTABLEFS_INSTALLER_SOURCE?.trim() ||
      path.join(repositoryRoot, "../portablefs/scripts/install.sh"),
  );
  await assertRegularFile(installerSource, "PortableFS installer source");
  const installerSha256 = createHash("sha256")
    .update(await readFile(installerSource))
    .digest("hex");
  if (installerSha256 !== expectedInstallerDigest) {
    throw new Error(
      `PortableFS installer digest mismatch: expected ${expectedInstallerDigest}, got ${installerSha256}`,
    );
  }
  await run("/bin/sh", ["-n", installerSource], repositoryRoot);
  return { installerSha256, installerSource, version };
}

function releaseChannel(value: string): "beta" | "stable" {
  if (value !== "beta" && value !== "stable") {
    throw new Error("OPENSTEER_DESKTOP_RELEASE_CHANNEL must be beta or stable.");
  }
  return value;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o444 });
}

async function setArtifactMode(
  filePath: string,
  mode: "code" | "data" | "executable",
  operatingSystem: "darwin" | "linux" | "win32",
): Promise<void> {
  if (operatingSystem !== "win32") {
    await setFileMode(filePath, mode === "executable" ? 0o555 : 0o444);
  }
}

function expectedDigest(name: string): string {
  const value = requiredEnvironmentValue(
    process.env,
    name,
    `${name} is required for a Desktop release build.`,
  );
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function optionalBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false.`);
}

function stableVersion(value: string, name: string): string {
  const version = value.replace(/^v/u, "");
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(version)) {
    throw new Error(`${name} must be stable SemVer.`);
  }
  return version;
}

function supportsCloudflaredTokenFile(version: string): boolean {
  const [year = 0, month = 0] = version.split(".").map(Number);
  return year > 2025 || (year === 2025 && month >= 4);
}

function targetOperatingSystem(): "darwin" | "linux" | "win32" {
  const value = process.env.OPENSTEER_DESKTOP_TARGET_OS ?? platform();
  if (value === "darwin" || value === "linux" || value === "win32") return value;
  if (value === "windows") return "win32";
  throw new Error(`Unsupported Desktop release operating system: ${value}`);
}

function targetArchitecture(): "amd64" | "arm64" {
  const value = process.env.OPENSTEER_DESKTOP_TARGET_ARCH ?? arch();
  if (value === "arm64" || value === "aarch64") return "arm64";
  if (value === "x64" || value === "amd64" || value === "x86_64") return "amd64";
  throw new Error(`Unsupported Desktop release architecture: ${value}`);
}

async function run(executable: string, arguments_: readonly string[], cwd: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(executable, [...arguments_], {
      cwd,
      env: process.env,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${executable} failed (${signal ?? `exit ${code}`}).`));
    });
  });
}

/** One command's standard output, for reading a plist through `plutil`. */
async function capture(
  executable: string,
  arguments_: readonly string[],
  cwd: string,
): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(executable, [...arguments_], {
      cwd,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise(output);
      else rejectPromise(new Error(`${executable} failed (${signal ?? `exit ${code}`}).`));
    });
  });
}

/** `codesign -d` writes its successful description to stderr. */
async function captureCombined(
  executable: string,
  arguments_: readonly string[],
  cwd: string = repositoryRoot,
): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(executable, [...arguments_], {
      cwd,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise(output);
      else rejectPromise(new Error(`${executable} failed (${signal ?? `exit ${code}`}).`));
    });
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
