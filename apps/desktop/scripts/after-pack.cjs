const { createHash } = require("node:crypto");
const {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve, sep } = require("node:path");
const {
  desktopReleaseMetadata,
  verifyPackagedDesktopRelease,
} = require("./desktop-release-metadata.cjs");
const { shippedHarnessArtifactModes } = require("./harness-artifact-modes.cjs");
const {
  agentPhoneReleaseSignerSha256,
  verifyAgentPhoneRelease,
} = require("../../../scripts/release-agent-phone.cjs");

const { startPhase, timePhase } = require("../../../scripts/release-phase-timing.cjs");
async function verifyPackagedDesktop(context) {
  globalThis.opensteerCollectTiming?.();
  await timePhase("package.after-pack", () => verifyPackagedDesktopContents(context));
  globalThis.opensteerSignTiming = startPhase("package.sign");
}
async function verifyPackagedDesktopContents(context) {
  const resources = resourcesDirectory(context);
  const archivePath = join(resources, "app.asar");
  if (isDesktopRelease()) {
    const repositoryRoot = resolve(__dirname, "../../..");
    const { identity } = desktopReleaseMetadata(repositoryRoot, process.env);
    const asar = require("@electron/asar");
    const packagedManifest = JSON.parse(
      asar.extractFile(archivePath, "package.json").toString("utf8"),
    );
    verifyPackagedDesktopRelease(packagedManifest, context.packager.appInfo, identity);
  }
  const desktop = readPackagedDesktopPolicy(archivePath);
  verifyAppUpdateConfig(resources, desktop);
  await timePhase("package.after-pack.extract-import-check", async () =>
    verifyPackagedRuntimeImports(archivePath),
  );
  verifyDesktopApplicationIdentity(
    desktop,
    context.packager.appInfo,
    context.packager.config.protocols,
  );

  verifyDigestRelease(
    resources,
    context.electronPlatformName,
    "cloudflared",
    cloudflaredName(context),
  );
  verifyDigestRelease(resources, context.electronPlatformName, "runner", helperName(context));
  if (context.electronPlatformName === "win32" && isDesktopRelease()) {
    requireValidAuthenticode(join(resources, "runner", helperName(context)));
  }
  verifyDigestRelease(
    resources,
    context.electronPlatformName,
    "process-supervisor",
    processSupervisorName(context),
  );
  verifyPersonalRuntime(resources, context.electronPlatformName);
  verifyPortableFs(resources, desktop.capabilities.portableFs);
  verifyAgentPhone(resources, isDesktopRelease());
  if (context.electronPlatformName === "darwin") {
    verifyHelperBundleRelease(resources, "computer-use", "Opensteer Computer Use.app", {
      executableSha256: join("Contents", "MacOS", "Opensteer Computer Use"),
    });
    verifyHelperBundleRelease(resources, "dictation", "Opensteer Dictation.app", {
      executableSha256: join("Contents", "MacOS", "Opensteer Dictation"),
    });
    verifyHelperBundleRelease(resources, "passwords", "Opensteer Passwords.app", {
      executableSha256: join("Contents", "MacOS", "Opensteer Passwords"),
      workerSha256: join("Contents", "Helpers", "Opensteer Passwords Import"),
    });
    allowOwnerWrites(join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`));
  }
}

/**
 * A separately signed helper app staged by `prepare-release-resources.ts`:
 * every program its `release.json` pins still has the digest it was staged
 * with, and the bundle's `CFBundleVersion` is the version pinned beside it,
 * so nothing between staging and packaging swapped a helper's code.
 */
function verifyHelperBundleRelease(resources, directoryName, appName, programs) {
  const directory = join(resources, directoryName);
  const bundle = join(directory, appName);
  const manifest = exactObject(regularFile(join(directory, "release.json")), [
    "architecture",
    "operatingSystem",
    "schemaVersion",
    "version",
    ...Object.keys(programs),
  ]);
  const version = require("node:child_process")
    .execFileSync(
      "/usr/bin/plutil",
      ["-extract", "CFBundleVersion", "raw", "-o", "-", join(bundle, "Contents", "Info.plist")],
      { encoding: "utf8" },
    )
    .trim();
  if (
    manifest.schemaVersion !== 1 ||
    manifest.operatingSystem !== "darwin" ||
    !["amd64", "arm64"].includes(manifest.architecture) ||
    manifest.version !== version
  ) {
    throw new Error(`Packaged ${directoryName} release identity is invalid.`);
  }
  for (const [key, relative] of Object.entries(programs)) {
    const program = regularFile(join(bundle, relative), true);
    if (manifest[key] !== createHash("sha256").update(program.content).digest("hex")) {
      throw new Error(
        `Packaged ${directoryName} ${relative} does not match its release.json digest.`,
      );
    }
  }
}

function verifyDesktopApplicationIdentity(desktop, appInfo, protocols) {
  if (desktop.application.name !== appInfo.productName) {
    throw new Error("Packaged Desktop application name does not match its release manifest.");
  }
  if (desktop.application.id !== appInfo.id) {
    throw new Error("Packaged Desktop application ID does not match its release manifest.");
  }
  const accountScheme = new URL(desktop.oauth.accountCallback).protocol.slice(0, -1);
  const hostScheme = new URL(desktop.oauth.hostCallback).protocol.slice(0, -1);
  const registeredSchemes = (Array.isArray(protocols) ? protocols : []).flatMap((protocol) =>
    Array.isArray(protocol.schemes) ? protocol.schemes : [],
  );
  if (
    accountScheme !== hostScheme ||
    registeredSchemes.length !== 1 ||
    registeredSchemes[0] !== accountScheme
  ) {
    throw new Error("Packaged Desktop OAuth scheme does not match its release manifest.");
  }
}

module.exports = verifyPackagedDesktop;
module.exports.verifyAppUpdateConfig = verifyAppUpdateConfig;
module.exports.allowOwnerWrites = allowOwnerWrites;
module.exports.readPackagedDesktopPolicy = readPackagedDesktopPolicy;
module.exports.verifyDesktopApplicationIdentity = verifyDesktopApplicationIdentity;
module.exports.verifyPackagedRuntimeImports = verifyPackagedRuntimeImports;
module.exports.verifyAgentPhone = verifyAgentPhone;
module.exports.verifyHelperBundleRelease = verifyHelperBundleRelease;

/**
 * Electron Builder owns the production dependency copy, while tsup leaves a
 * deliberately small set of packages external. Resolve the executable graph
 * from the finished archive so a missing transitive package fails the build,
 * rather than the customer's main process at launch.
 */
function verifyPackagedRuntimeImports(archivePath) {
  const asar = require("@electron/asar");
  const esbuild = require("esbuild");
  const extracted = mkdtempSync(join(tmpdir(), "opensteer-packaged-imports-"));
  try {
    asar.extractAll(archivePath, extracted);
    esbuild.buildSync({
      absWorkingDir: extracted,
      bundle: true,
      entryPoints: ["dist/main.js", "dist/preload.cjs", "dist/runner-worker.js"],
      external: ["electron"],
      format: "esm",
      logLevel: "silent",
      outdir: ".opensteer-import-verification",
      platform: "node",
      target: "node24",
      treeShaking: false,
      write: false,
    });
  } catch (error) {
    const details = Array.isArray(error?.errors)
      ? error.errors.map((failure) => failure.text).join(", ")
      : error instanceof Error
        ? error.message
        : "unknown module resolution failure";
    throw new Error(`Packaged Desktop runtime import graph is incomplete: ${details}`, {
      cause: error,
    });
  } finally {
    rmSync(extracted, { force: true, recursive: true });
  }
}

function readPackagedDesktopPolicy(archivePath) {
  const desktopManifest = asarFile(archivePath, "dist/desktop-release.json");
  const desktop = exactObject(
    desktopManifest,
    ["application", "capabilities", "oauth", "schemaVersion"],
    // Service origins are present only when the build offers those services;
    // only Mac arm64 release builds carry updates.
    ["accountUrl", "portalUrl", "updates"],
  );
  if (
    desktop.schemaVersion !== 6 ||
    !bareHttpsOriginOrAbsent(desktop.accountUrl) ||
    (desktop.capabilities?.connect === true
      ? typeof desktop.accountUrl !== "string"
      : desktop.accountUrl !== undefined) ||
    !exactApplication(desktop.application) ||
    !exactCapabilities(desktop.capabilities) ||
    !exactOAuthIdentity(desktop.oauth) ||
    !bareHttpsOriginOrAbsent(desktop.portalUrl) ||
    !updateFeedOrAbsent(desktop.updates) ||
    (desktop.updates &&
      desktop.updates.channel !== (desktop.application.channel === "stable" ? "latest" : "insider"))
  ) {
    throw new Error("Packaged Desktop manifest is invalid.");
  }
  return desktop;
}

function bareHttpsOriginOrAbsent(value) {
  if (value === undefined) return true;
  if (typeof value !== "string") return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    url.pathname === "/" &&
    !url.search &&
    !url.hash
  );
}

function updateFeedOrAbsent(value) {
  if (value === undefined) return true;
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => ["owner", "repo", "channel", "host"].includes(key)) &&
    value.owner === "steerlabs" &&
    value.repo === "opensteer" &&
    ["latest", "insider"].includes(value.channel) &&
    (value.host === undefined ||
      (typeof value.host === "string" && /^[a-zA-Z0-9.-]+(?::[0-9]+)?$/u.test(value.host)))
  );
}

function verifyAppUpdateConfig(resources, desktop) {
  const file = join(resources, "app-update.yml");
  if (!desktop.updates) {
    if (existsSync(file)) throw new Error("Unexpected Desktop update configuration.");
    return;
  }
  const updates = desktop.updates;
  if (updates.channel !== (desktop.application.channel === "stable" ? "latest" : "insider"))
    throw new Error("Desktop update configuration channel mismatch.");
  const expected = {
    provider: "github",
    owner: updates.owner,
    repo: updates.repo,
    ...(updates.host ? { host: updates.host } : {}),
    updaterCacheDirName:
      updates.channel === "latest" ? "opensteer-updater" : "opensteer-beta-updater",
  };
  const actual = require("yaml").parse(readFileSync(file, "utf8"));
  if (
    !actual ||
    Object.keys(actual).length !== Object.keys(expected).length ||
    Object.entries(expected).some(([key, value]) => actual[key] !== value)
  )
    throw new Error("Packaged Desktop update configuration does not match the policy.");
}

function exactApplication(value) {
  const keys = ["channel", "id", "name"];
  if (value?.stage !== undefined) keys.push("stage");
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys.sort()) &&
    (value.stage === undefined || value.stage === "alpha") &&
    ["beta", "stable"].includes(value.channel) &&
    /^[a-z][a-z0-9]*(?:\.[a-z0-9][a-z0-9-]*)+$/u.test(value.id) &&
    typeof value.name === "string" &&
    value.name.trim() === value.name &&
    value.name.length > 0 &&
    value.name.length <= 80
  );
}

function exactOAuthIdentity(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify(["accountCallback", "clientId", "hostCallback"]) &&
    /^[A-Za-z0-9._~-]{1,255}$/u.test(value.clientId) &&
    validNativeCallback(value.accountCallback) &&
    validNativeCallback(value.hostCallback) &&
    new URL(value.accountCallback).protocol === new URL(value.hostCallback).protocol &&
    value.accountCallback !== value.hostCallback
  );
}

function validNativeCallback(value) {
  if (typeof value !== "string") return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const canonical = `${url.protocol}${url.host ? `//${url.host}` : ""}${url.pathname}`;
  return (
    url.protocol !== "http:" &&
    url.protocol !== "https:" &&
    !url.username &&
    !url.password &&
    !url.port &&
    !url.search &&
    !url.hash &&
    canonical === value
  );
}

/**
 * Release inputs are staged read-only. Squirrel.Mac clears the quarantine
 * attribute from every file of a downloaded update and later replaces the
 * installed bundle, and both fail on entries their owner cannot write. Code
 * signatures seal contents, not permission bits, so this runs before signing
 * without touching any verified digest.
 */
function allowOwnerWrites(path) {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) return;
  if ((metadata.mode & 0o200) === 0) chmodSync(path, (metadata.mode & 0o7777) | 0o200);
  if (metadata.isDirectory()) {
    for (const name of readdirSync(path)) allowOwnerWrites(join(path, name));
  }
}

function resourcesDirectory(context) {
  if (context.electronPlatformName === "darwin") {
    return join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      "Contents",
      "Resources",
    );
  }
  return join(context.appOutDir, "resources");
}

function requireValidAuthenticode(filePath) {
  const script = [
    "$signature = Get-AuthenticodeSignature -LiteralPath $args[0]",
    "if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) { exit 9 }",
  ].join("; ");
  const result = require("node:child_process").spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script, filePath],
    { encoding: "utf8", stdio: "pipe", windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Packaged Native filesystem helper Authenticode verification failed: ${filePath}`,
    );
  }
}

function cloudflaredName(context) {
  return context.electronPlatformName === "win32" ? "cloudflared.exe" : "cloudflared";
}

function helperName(context) {
  return context.electronPlatformName === "win32"
    ? "opensteer-native-fs.exe"
    : "opensteer-native-fs";
}

function processSupervisorName(context) {
  return context.electronPlatformName === "win32"
    ? "opensteer-process-supervisor.exe"
    : "opensteer-process-supervisor";
}

function verifyDigestRelease(resources, operatingSystem, directoryName, binaryName) {
  const binary = regularFile(
    join(resources, directoryName, binaryName),
    operatingSystem !== "win32",
  );
  const manifest = exactObject(regularFile(join(resources, directoryName, "release.json")), [
    "architecture",
    "binarySha256",
    "operatingSystem",
    "schemaVersion",
    ...(directoryName === "cloudflared" ? ["version"] : []),
  ]);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.operatingSystem !== operatingSystem ||
    manifest.binarySha256 !== createHash("sha256").update(binary.content).digest("hex") ||
    !["amd64", "arm64"].includes(manifest.architecture)
  ) {
    throw new Error(`Packaged ${directoryName} release identity is invalid.`);
  }
  if (
    (operatingSystem === "linux" || operatingSystem === "win32") &&
    manifest.architecture !== binaryArchitecture(binary.content, operatingSystem)
  ) {
    throw new Error(`Packaged ${directoryName} architecture does not match its manifest.`);
  }
  if (
    directoryName === "cloudflared" &&
    (typeof manifest.version !== "string" ||
      !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(manifest.version) ||
      !supportsCloudflaredTokenFile(manifest.version))
  ) {
    throw new Error("Packaged cloudflared release version is invalid.");
  }
}

function verifyPersonalRuntime(resources, operatingSystem) {
  const directory = join(resources, "personal-runtime");
  const releaseFile = regularFile(join(directory, "release.json"));
  const manifest = JSON.parse(releaseFile.content.toString("utf8"));
  const keys = [
    "architecture",
    "assets",
    "entrypoints",
    "files",
    "harnesses",
    "hostVersion",
    "operatingSystem",
    "postgresMajor",
    "postgresVersion",
    "runnerVersion",
    "schemaVersion",
  ];
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(keys.sort()) ||
    manifest.schemaVersion !== 7 ||
    manifest.operatingSystem !== operatingSystem ||
    !Array.isArray(manifest.files) ||
    manifest.files.length < 6 ||
    manifest.files.length > 2_048
  ) {
    throw new Error("Packaged Personal runtime manifest is invalid.");
  }
  const seen = new Set();
  const fileModes = new Map();
  for (const artifact of manifest.files) {
    if (
      !artifact ||
      typeof artifact.path !== "string" ||
      !/^[a-f0-9]{64}$/u.test(artifact.sha256) ||
      !["code", "data", "executable"].includes(artifact.mode) ||
      seen.has(artifact.path)
    ) {
      throw new Error("Packaged Personal runtime file entry is invalid.");
    }
    seen.add(artifact.path);
    fileModes.set(artifact.path, artifact.mode);
    const file = regularFile(
      containedArtifact(directory, artifact.path),
      artifact.mode === "executable" && operatingSystem !== "win32",
    );
    if (createHash("sha256").update(file.content).digest("hex") !== artifact.sha256) {
      throw new Error(`Packaged Personal runtime artifact ${artifact.path} failed verification.`);
    }
  }
  const sharpPrefix = "services/node_modules/@img/sharp-";
  const sharpAddon = manifest.files.filter(
    ({ path }) => path.startsWith(sharpPrefix) && path.endsWith(".node"),
  );
  if (
    sharpAddon.length !== 1 ||
    !sharpAddon[0].path.includes(
      `sharp-${operatingSystem === "darwin" ? "darwin" : operatingSystem === "win32" ? "win32" : "linux"}-`,
    ) ||
    fileModes.get(sharpAddon[0].path) !== "code" ||
    fileModes.get("services/node_modules/sharp/package.json") !== "data" ||
    (operatingSystem !== "win32" &&
      !manifest.files.some(
        ({ path }) =>
          path.startsWith("services/node_modules/@img/sharp-libvips-") &&
          (path.includes("libvips-cpp") || path.includes("libvips.so")),
      ))
  ) {
    throw new Error("Packaged Personal runtime Sharp native image decoder is incomplete.");
  }
  const entrypointKeys = [
    "browserHarness",
    "channelRuntime",
    "host",
    "initdb",
    "nativeFsHelper",
    "node",
    "pgIsReady",
    "postgres",
    "runner",
  ];
  if (
    !manifest.assets ||
    JSON.stringify(Object.keys(manifest.assets).sort()) !==
      JSON.stringify(["agentSkills", "webDistribution"]) ||
    typeof manifest.assets.agentSkills !== "string" ||
    fileModes.get(`${manifest.assets.agentSkills}/plugin.json`) !== "data" ||
    ![...fileModes].some(
      ([artifactPath, mode]) =>
        mode === "data" &&
        artifactPath.startsWith(`${manifest.assets.agentSkills}/skills/`) &&
        artifactPath.endsWith("/SKILL.md"),
    )
  ) {
    throw new Error("Packaged Personal runtime assets are invalid.");
  }
  const webDistribution = manifest.assets.webDistribution;
  if (
    !webDistribution ||
    JSON.stringify(Object.keys(webDistribution).sort()) !==
      JSON.stringify(["directory", "hostVersion", "manifest"]) ||
    typeof webDistribution.directory !== "string" ||
    typeof webDistribution.manifest !== "string" ||
    !webDistribution.manifest.startsWith(`${webDistribution.directory}/`) ||
    fileModes.get(webDistribution.manifest) !== "data" ||
    fileModes.get(`${webDistribution.directory}/index.html`) !== "data" ||
    webDistribution.hostVersion !== manifest.hostVersion
  ) {
    throw new Error("Packaged Personal runtime Web distribution is invalid.");
  }
  if (
    !manifest.entrypoints ||
    JSON.stringify(Object.keys(manifest.entrypoints).sort()) !==
      JSON.stringify(entrypointKeys.sort()) ||
    Object.values(manifest.entrypoints).some(
      (entrypoint) => fileModes.get(entrypoint) !== "executable",
    )
  ) {
    throw new Error("Packaged Personal runtime entrypoints are invalid.");
  }
  // The harness runtimes are spawned by the Runner rather than started by
  // Desktop, but they ship in the same signed bundle and are held to the same
  // executable and architecture rules as its entrypoints.
  const harnessModes = shippedHarnessArtifactModes();
  if (
    !manifest.harnesses ||
    JSON.stringify(Object.keys(manifest.harnesses).sort()) !==
      JSON.stringify(Object.keys(harnessModes).sort()) ||
    Object.entries(manifest.harnesses).some(
      ([kind, harness]) => fileModes.get(harness) !== harnessModes[kind],
    )
  ) {
    throw new Error("Packaged Personal runtime harnesses are invalid.");
  }
  if (operatingSystem === "linux" || operatingSystem === "win32") {
    for (const program of [
      ...Object.values(manifest.entrypoints),
      ...manifest.files
        .filter(
          ({ path }) =>
            path.startsWith(sharpPrefix) && /\.(?:node|dll|so(?:\.[0-9.]+)?)$/u.test(path),
        )
        .map(({ path }) => path),
      // Only a platform executable has an architecture to check.
      ...Object.entries(manifest.harnesses)
        .filter(([kind]) => harnessModes[kind] === "executable")
        .map(([, harness]) => harness),
    ]) {
      const executable = regularFile(containedArtifact(directory, program));
      if (binaryArchitecture(executable.content, operatingSystem) !== manifest.architecture) {
        throw new Error(`Packaged Personal runtime program ${program} has the wrong architecture.`);
      }
    }
  }
}

function verifyPortableFs(resources, required) {
  const directory = join(resources, "portablefs");
  const installerPath = join(directory, "install.sh");
  const manifestPath = join(directory, "release.json");
  const hasInstaller = existsSync(installerPath);
  const hasManifest = existsSync(manifestPath);
  if (!required && !hasInstaller && !hasManifest) return;
  if (!required || !hasInstaller || !hasManifest) {
    throw new Error("Packaged PortableFS capability and artifacts do not match.");
  }
  const installer = regularFile(installerPath, true);
  const manifest = exactObject(regularFile(manifestPath), [
    "installerSha256",
    "schemaVersion",
    "version",
  ]);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.installerSha256 !== createHash("sha256").update(installer.content).digest("hex") ||
    typeof manifest.version !== "string" ||
    !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(manifest.version)
  ) {
    throw new Error("Packaged PortableFS release identity is invalid.");
  }
}

/**
 * The Agent Phone app the Computers page installs over USB. Setup checks the
 * APK against this manifest before it reaches a phone; this gate makes sure a
 * package never ships a pair that would fail that check. A release must carry
 * it; a local package built without the Android toolchain carries neither file.
 */
function verifyAgentPhone(resources, required) {
  const directory = join(resources, "agent-phone");
  const apkPath = join(directory, "opensteer-agent-phone.apk");
  const manifestPath = join(directory, "agent-phone.json");
  const hasApk = existsSync(apkPath);
  const hasManifest = existsSync(manifestPath);
  if (!required && !hasApk && !hasManifest) return;
  if (!hasApk || !hasManifest) {
    throw new Error("Packaged Agent Phone app is missing its APK or its manifest.");
  }
  const apk = regularFile(apkPath);
  const manifest = exactObject(regularFile(manifestPath), [
    "apkSha256",
    "apkSize",
    "buildType",
    "minSdk",
    "packageName",
    "signingCertSha256",
    "versionCode",
    "versionName",
  ]);
  if (
    (manifest.buildType !== "debug" && manifest.buildType !== "release") ||
    manifest.packageName !== "com.opensteer.agentphone" ||
    manifest.apkSize !== apk.content.length ||
    // `agentPhoneApkMaxBytes` in @opensteer/protocol, which this CommonJS hook cannot import.
    manifest.apkSize > 24 * 1024 * 1024 ||
    manifest.apkSha256 !== createHash("sha256").update(apk.content).digest("hex") ||
    !/^[a-f0-9]{64}$/u.test(manifest.signingCertSha256) ||
    !Number.isSafeInteger(manifest.versionCode) ||
    !Number.isSafeInteger(manifest.minSdk) ||
    manifest.minSdk < 30 ||
    typeof manifest.versionName !== "string"
  ) {
    throw new Error("Packaged Agent Phone APK does not match its manifest.");
  }
  if (required && manifest.buildType !== "release") {
    throw new Error("Packaged Agent Phone must be built with pnpm build:agent-phone --release.");
  }
  if (required) {
    if (manifest.signingCertSha256 !== agentPhoneReleaseSignerSha256)
      throw new Error("Packaged Agent Phone does not have the permanent release signer.");
    if (!process.env.OPENSTEER_AGENT_PHONE_RELEASE_RECEIPT)
      throw new Error("Packaged Agent Phone requires a trusted release receipt.");
    verifyAgentPhoneRelease(directory, process.env.OPENSTEER_AGENT_PHONE_RELEASE_RECEIPT, {
      receiptSha256: process.env.OPENSTEER_AGENT_PHONE_RELEASE_RECEIPT_SHA256,
      sourceRevision: process.env.OPENSTEER_SOURCE_REVISION,
      version: process.env.OPENSTEER_RELEASE_VERSION,
    });
  }
}

function isDesktopRelease() {
  return process.env.OPENSTEER_DESKTOP_RELEASE === "1";
}

function exactCapabilities(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify(["connect", "localAgents", "personal", "portableFs"].sort()) &&
    typeof value.connect === "boolean" &&
    value.personal === true &&
    typeof value.localAgents === "boolean" &&
    typeof value.portableFs === "boolean"
  );
}

function regularFile(filePath, executable = false) {
  const metadata = lstatSync(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${filePath} must be a real regular file.`);
  }
  if (executable && (metadata.mode & 0o111) === 0) {
    throw new Error(`${filePath} must be executable.`);
  }
  return { content: readFileSync(filePath), filePath };
}

function exactObject(file, keys, optionalKeys = []) {
  const value = JSON.parse(file.content.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${file.filePath} must contain one JSON object.`);
  }
  const required = Object.keys(value).filter((key) => !optionalKeys.includes(key));
  if (JSON.stringify(required.sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${file.filePath} contains an unexpected manifest shape.`);
  }
  return value;
}

function asarFile(archivePath, relativePath) {
  const asar = require("@electron/asar");
  const content = asar.extractFile(archivePath, relativePath);
  return { content, filePath: `${archivePath}:${relativePath}` };
}

function containedArtifact(directory, relativePath) {
  if (
    !relativePath ||
    relativePath.includes("\\") ||
    relativePath.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("Personal runtime artifact path is invalid.");
  }
  const root = resolve(directory);
  const candidate = resolve(root, ...relativePath.split("/"));
  if (!candidate.startsWith(`${root}${sep}`)) {
    throw new Error("Personal runtime artifact path escapes its release directory.");
  }
  return candidate;
}

function elfArchitecture(content) {
  if (
    content.length < 20 ||
    content[0] !== 0x7f ||
    content[1] !== 0x45 ||
    content[2] !== 0x4c ||
    content[3] !== 0x46 ||
    content[4] !== 2 ||
    content[5] !== 1
  ) {
    throw new Error("Packaged binary must be a 64-bit little-endian ELF file.");
  }
  switch (content.readUInt16LE(18)) {
    case 62:
      return "amd64";
    case 183:
      return "arm64";
    default:
      throw new Error("Packaged binary has an unsupported ELF architecture.");
  }
}

function binaryArchitecture(content, operatingSystem) {
  return operatingSystem === "linux" ? elfArchitecture(content) : peArchitecture(content);
}

function peArchitecture(content) {
  if (content.length < 0x40 || content[0] !== 0x4d || content[1] !== 0x5a) {
    throw new Error("Packaged Windows binary must be a PE executable.");
  }
  const header = content.readUInt32LE(0x3c);
  if (
    header < 0x40 ||
    header + 6 > content.length ||
    content[header] !== 0x50 ||
    content[header + 1] !== 0x45 ||
    content[header + 2] !== 0 ||
    content[header + 3] !== 0
  ) {
    throw new Error("Packaged Windows binary has an invalid PE header.");
  }
  switch (content.readUInt16LE(header + 4)) {
    case 0x8664:
      return "amd64";
    case 0xaa64:
      return "arm64";
    default:
      throw new Error("Packaged Windows binary has an unsupported architecture.");
  }
}

function supportsCloudflaredTokenFile(version) {
  const [year, month] = version.split(".").map(Number);
  return year > 2025 || (year === 2025 && month >= 4);
}
