const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { existsSync, lstatSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const {
  desktopReleaseIdentity,
  verifyPackagedMacReleaseIdentity,
} = require("./macos-release-identity.cjs");
const { shippedHarnessArtifactModes } = require("./harness-artifact-modes.cjs");

const { timePhase } = require("../../../scripts/release-phase-timing.cjs");
module.exports = async function verifySignedDesktop(context) {
  globalThis.opensteerSignTiming?.();
  return timePhase("package.after-sign", () => verifySignedDesktopContents(context));
};
async function verifySignedDesktopContents(context) {
  if (context.electronPlatformName === "win32") {
    if (isDesktopRelease()) verifySignedWindowsDesktop(context);
    return;
  }
  if (context.electronPlatformName !== "darwin") return;
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const passkeys = require("./passkeys-signing.cjs");
  passkeys.verifyPasskeyAddon(
    appPath,
    true,
    process.env.OPENSTEER_APPLE_TEAM_ID,
    isDesktopRelease(),
  );
  passkeys.verifyNoInheritedPasskeyCapability(appPath);
  if (!isDesktopRelease()) {
    const entitlements = signedEntitlements(appPath);
    if (
      entitlements["com.apple.developer.web-browser.public-key-credential"] !== undefined ||
      existsSync(join(appPath, "Contents/embedded.provisionprofile"))
    )
      throw new Error("Development apps must not carry the passkey entitlement or profile");
  }
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  const helperPath = join(appPath, "Contents", "Resources", "runner", "opensteer-native-fs");
  const computerUseAppPath = join(
    appPath,
    "Contents",
    "Resources",
    "computer-use",
    "Opensteer Computer Use.app",
  );
  const computerUseExecutablePath = join(
    computerUseAppPath,
    "Contents",
    "MacOS",
    "Opensteer Computer Use",
  );
  const passwordsAppPath = join(
    appPath,
    "Contents",
    "Resources",
    "passwords",
    "Opensteer Passwords.app",
  );
  const passwordsExecutablePath = join(
    passwordsAppPath,
    "Contents",
    "MacOS",
    "Opensteer Passwords",
  );
  const passwordsWorkerPath = join(
    passwordsAppPath,
    "Contents",
    "Helpers",
    "Opensteer Passwords Import",
  );
  const processSupervisorPath = join(
    appPath,
    "Contents",
    "Resources",
    "process-supervisor",
    "opensteer-process-supervisor",
  );
  const cloudflaredPath = join(appPath, "Contents", "Resources", "cloudflared", "cloudflared");
  const personalRoot = join(appPath, "Contents", "Resources", "personal-runtime");
  const cloudflaredManifestPath = join(
    appPath,
    "Contents",
    "Resources",
    "cloudflared",
    "release.json",
  );
  const cloudflared = exactObject(cloudflaredManifestPath, [
    "architecture",
    "binarySha256",
    "operatingSystem",
    "schemaVersion",
    "version",
  ]);
  const processSupervisor = exactObject(
    join(appPath, "Contents", "Resources", "process-supervisor", "release.json"),
    ["architecture", "binarySha256", "operatingSystem", "schemaVersion"],
  );
  const cloudflaredDigest = createHash("sha256").update(regularFile(cloudflaredPath)).digest("hex");
  if (
    cloudflared.schemaVersion !== 1 ||
    cloudflared.operatingSystem !== "darwin" ||
    cloudflared.binarySha256 !== cloudflaredDigest ||
    !supportsCloudflaredTokenFile(cloudflared.version)
  ) {
    throw new Error("Packaged cloudflared release identity is invalid.");
  }
  const processSupervisorDigest = createHash("sha256")
    .update(regularFile(processSupervisorPath))
    .digest("hex");
  if (
    processSupervisor.schemaVersion !== 1 ||
    processSupervisor.operatingSystem !== "darwin" ||
    processSupervisor.binarySha256 !== processSupervisorDigest
  ) {
    throw new Error("Packaged process-supervisor release identity is invalid.");
  }
  const personalManifest = JSON.parse(
    regularFile(join(personalRoot, "release.json")).toString("utf8"),
  );
  for (const artifact of personalManifest.files) {
    const artifactPath = join(personalRoot, ...artifact.path.split("/"));
    const digest = createHash("sha256").update(regularFile(artifactPath)).digest("hex");
    if (digest !== artifact.sha256) {
      throw new Error(`Signed Personal runtime artifact ${artifact.path} failed verification.`);
    }
  }
  // Every program the bundle declares, including the harness runtimes the
  // Runner spawns, must carry a valid signature and the app's architecture.
  const harnessModes = shippedHarnessArtifactModes();
  const personalExecutables = [
    ...new Set([
      ...Object.values(personalManifest.entrypoints),
      ...Object.entries(personalManifest.harnesses)
        .filter(([kind]) => harnessModes[kind] === "executable")
        .map(([, program]) => program),
    ]),
  ].map((program) => join(personalRoot, ...program.split("/")));
  const sharpNativeLibraries = personalManifest.files
    .filter(
      ({ path }) =>
        path.startsWith("services/node_modules/@img/sharp-") && /\.(?:node|dylib)$/u.test(path),
    )
    .map(({ path }) => join(personalRoot, ...path.split("/")));
  for (const signedPath of [
    computerUseAppPath,
    passwordsAppPath,
    passwordsWorkerPath,
    helperPath,
    cloudflaredPath,
    processSupervisorPath,
    ...personalExecutables,
    ...sharpNativeLibraries,
  ]) {
    run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", signedPath]);
  }
  // The broker's worker must stay in its sandbox: that entitlement and
  // nothing else, in every build.
  const dictationApp = join(
    appPath,
    "Contents",
    "Resources",
    "dictation",
    "Opensteer Dictation.app",
  );
  run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", dictationApp]);
  const dictationEntitlements = signedEntitlements(dictationApp);
  if (
    JSON.stringify(dictationEntitlements) !==
    JSON.stringify({ "com.apple.security.device.audio-input": true })
  ) {
    throw new Error("Opensteer Dictation must carry only the audio-input entitlement.");
  }
  if (isDesktopRelease()) {
    const detail = run("/usr/bin/codesign", ["-dv", "--verbose=4", dictationApp], true);
    const lines = detail.split(/\r?\n/u);
    if (
      !lines.includes("Identifier=com.opensteer.dictation") ||
      !lines.includes(`TeamIdentifier=${required("OPENSTEER_APPLE_TEAM_ID")}`) ||
      !/^Authority=Developer ID Application:/mu.test(detail) ||
      !detail.includes("runtime")
    ) {
      throw new Error("Opensteer Dictation has an invalid release identity or runtime.");
    }
  }
  const workerEntitlements = signedEntitlements(passwordsWorkerPath);
  if (
    JSON.stringify(Object.keys(workerEntitlements)) !==
      JSON.stringify(["com.apple.security.app-sandbox"]) ||
    workerEntitlements["com.apple.security.app-sandbox"] !== true
  ) {
    throw new Error(
      "The Opensteer Passwords import worker must carry only the App Sandbox entitlement.",
    );
  }
  const appArchitectures = run(
    "/usr/bin/lipo",
    ["-archs", join(appPath, "Contents", "MacOS", context.packager.appInfo.productFilename)],
    true,
  ).trim();
  const helperArchitectures = run("/usr/bin/lipo", ["-archs", helperPath], true).trim();
  const computerUseArchitectures = run("/usr/bin/lipo", ["-archs", computerUseExecutablePath], true)
    .trim()
    .split(/\s+/u)
    .sort()
    .join(" ");
  const cloudflaredArchitectures = run("/usr/bin/lipo", ["-archs", cloudflaredPath], true).trim();
  const processSupervisorArchitectures = run(
    "/usr/bin/lipo",
    ["-archs", processSupervisorPath],
    true,
  ).trim();
  if (helperArchitectures !== appArchitectures) {
    throw new Error(
      `Native filesystem helper architecture ${helperArchitectures} does not match app architecture ${appArchitectures}.`,
    );
  }
  if (!helperArchitecturesMatch(computerUseArchitectures, appArchitectures, isDesktopRelease())) {
    throw new Error(
      `Computer use helper must ${isDesktopRelease() ? "be universal" : "match the app architecture"}; found ${computerUseArchitectures || "no architectures"}.`,
    );
  }
  // Stable and Beta share one installed broker, like the computer use helper.
  for (const program of [passwordsExecutablePath, passwordsWorkerPath]) {
    const architectures = run("/usr/bin/lipo", ["-archs", program], true).trim();
    if (!helperArchitecturesMatch(architectures, appArchitectures, isDesktopRelease())) {
      throw new Error(
        `${program} must ${isDesktopRelease() ? "be universal" : "match the app architecture"}; found ${architectures || "no architectures"}.`,
      );
    }
  }
  if (cloudflaredArchitectures !== appArchitectures) {
    throw new Error(
      `cloudflared architecture ${cloudflaredArchitectures} does not match app architecture ${appArchitectures}.`,
    );
  }
  if (processSupervisorArchitectures !== appArchitectures) {
    throw new Error(
      `Process supervisor architecture ${processSupervisorArchitectures} does not match app architecture ${appArchitectures}.`,
    );
  }
  for (const executable of personalExecutables) {
    const executableArchitectures = run("/usr/bin/lipo", ["-archs", executable], true).trim();
    if (executableArchitectures !== appArchitectures) {
      throw new Error(
        `Personal runtime executable ${executable} architecture ${executableArchitectures} does not match app architecture ${appArchitectures}.`,
      );
    }
  }
  for (const library of sharpNativeLibraries) {
    const libraryArchitectures = run("/usr/bin/lipo", ["-archs", library], true).trim();
    if (libraryArchitectures !== appArchitectures) {
      throw new Error(`Personal runtime Sharp library ${library} has the wrong architecture.`);
    }
  }
  const manifestArchitecture =
    cloudflaredArchitectures === "x86_64" ? "amd64" : cloudflaredArchitectures;
  if (cloudflared.architecture !== manifestArchitecture) {
    throw new Error("Packaged cloudflared architecture does not match its release manifest.");
  }
  if (processSupervisor.architecture !== manifestArchitecture) {
    throw new Error(
      "Packaged process supervisor architecture does not match its release manifest.",
    );
  }
  if (personalManifest.architecture !== manifestArchitecture) {
    throw new Error("Packaged Personal runtime architecture does not match its release manifest.");
  }
  if (process.env.OPENSTEER_DESKTOP_RELEASE !== "1") return;
  const identity = desktopReleaseIdentity(required("OPENSTEER_DESKTOP_RELEASE_CHANNEL"));
  const expectedTeamId = required("OPENSTEER_APPLE_TEAM_ID");
  if (expectedTeamId !== identity.teamId) {
    throw new Error(`The macOS release must use permanent Team ${identity.teamId}.`);
  }
  if (
    context.packager.appInfo.id !== identity.bundleId ||
    context.packager.appInfo.productFilename !== identity.productName
  ) {
    throw new Error("The packaged macOS application identity does not match its release channel.");
  }
  for (const signedPath of [
    appPath,
    computerUseAppPath,
    passwordsAppPath,
    passwordsWorkerPath,
    helperPath,
    cloudflaredPath,
    processSupervisorPath,
    ...personalExecutables,
  ]) {
    const detail = run("/usr/bin/codesign", ["-dv", "--verbose=4", signedPath], true);
    if (!detail.split(/\r?\n/u).includes(`TeamIdentifier=${expectedTeamId}`)) {
      throw new Error(`${signedPath} was not signed by expected Team ${expectedTeamId}.`);
    }
  }
  verifyReleasePasswordsBroker(passwordsAppPath, passwordsWorkerPath, expectedTeamId);
  verifyPackagedMacReleaseIdentity(appPath, identity);
}

/**
 * The release broker: its identifiers, Developer ID with the hardened
 * runtime, and the one restricted entitlement its embedded provisioning
 * profile grants, the broker-only keychain group.
 */
function verifyReleasePasswordsBroker(appPath, workerPath, teamId) {
  for (const [signedPath, identifier] of [
    [appPath, "com.opensteer.passwords"],
    [workerPath, "com.opensteer.passwords.import"],
  ]) {
    const detail = run("/usr/bin/codesign", ["-dv", "--verbose=4", signedPath], true);
    const lines = detail.split(/\r?\n/u);
    if (
      !lines.includes(`Identifier=${identifier}`) ||
      !lines.some((line) => line.startsWith("Authority=Developer ID Application:")) ||
      !/^CodeDirectory .* flags=.*\(runtime\)/mu.test(detail) ||
      !/^Timestamp=.+/mu.test(detail)
    ) {
      throw new Error(`${signedPath} does not carry the Opensteer Passwords release signature.`);
    }
  }
  regularFile(join(appPath, "Contents", "embedded.provisionprofile"));
  const group = `${teamId}.com.opensteer.passwords`;
  const entitlements = signedEntitlements(appPath);
  if (
    JSON.stringify(Object.keys(entitlements).sort()) !==
      JSON.stringify([
        "com.apple.application-identifier",
        "com.apple.developer.team-identifier",
        "keychain-access-groups",
      ]) ||
    entitlements["com.apple.application-identifier"] !== group ||
    entitlements["com.apple.developer.team-identifier"] !== teamId ||
    JSON.stringify(entitlements["keychain-access-groups"]) !== JSON.stringify([group])
  ) {
    throw new Error("Opensteer Passwords must claim exactly its own keychain group.");
  }
}

/** A signature's entitlements as JSON; an unsigned claim reads as none. */
function signedEntitlements(signedPath) {
  const xml = run("/usr/bin/codesign", ["-d", "--entitlements", "-", "--xml", signedPath], true)
    .split(/\r?\n/u)
    .filter((line) => !line.startsWith("Executable="))
    .join("\n")
    .trim();
  if (!xml) return {};
  const result = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], {
    encoding: "utf8",
    input: xml,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`The entitlements of ${signedPath} could not be read.`);
  return JSON.parse(result.stdout);
}

function helperArchitecturesMatch(architectures, appArchitectures, release) {
  return (
    computerUseArchitecturesAreUniversal(architectures) ||
    (!release && architectures.trim() === appArchitectures.trim())
  );
}
module.exports.helperArchitecturesMatch = helperArchitecturesMatch;

function computerUseArchitecturesAreUniversal(architectures) {
  return architectures.trim().split(/\s+/u).sort().join(" ") === "arm64 x86_64";
}

module.exports.computerUseArchitecturesAreUniversal = computerUseArchitecturesAreUniversal;
module.exports.signedEntitlements = signedEntitlements;
module.exports.supportsCloudflaredTokenFile = supportsCloudflaredTokenFile;

function isDesktopRelease() {
  return process.env.OPENSTEER_DESKTOP_RELEASE === "1";
}

function verifySignedWindowsDesktop(context) {
  const resources = join(context.appOutDir, "resources");
  const applicationPath = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.exe`,
  );
  const processSupervisorPath = join(
    resources,
    "process-supervisor",
    "opensteer-process-supervisor.exe",
  );
  const processSupervisor = exactObject(join(resources, "process-supervisor", "release.json"), [
    "architecture",
    "binarySha256",
    "operatingSystem",
    "schemaVersion",
  ]);
  if (
    processSupervisor.schemaVersion !== 1 ||
    processSupervisor.operatingSystem !== "win32" ||
    processSupervisor.binarySha256 !==
      createHash("sha256").update(regularFile(processSupervisorPath)).digest("hex")
  ) {
    throw new Error("Signed Windows process-supervisor release identity is invalid.");
  }
  const personalRoot = join(resources, "personal-runtime");
  const personalManifest = JSON.parse(
    regularFile(join(personalRoot, "release.json")).toString("utf8"),
  );
  if (personalManifest.operatingSystem !== "win32" || !Array.isArray(personalManifest.files)) {
    throw new Error("Signed Windows Personal runtime manifest is invalid.");
  }
  for (const artifact of personalManifest.files) {
    const artifactPath = join(personalRoot, ...artifact.path.split("/"));
    if (createHash("sha256").update(regularFile(artifactPath)).digest("hex") !== artifact.sha256) {
      throw new Error(
        `Signed Windows Personal runtime artifact ${artifact.path} failed verification.`,
      );
    }
  }
  // Every program the bundle declares, including the harness runtimes the
  // Runner spawns, must carry a valid signature and the app's architecture.
  const personalExecutables = [
    ...new Set([
      ...Object.values(personalManifest.entrypoints),
      ...Object.values(personalManifest.harnesses),
    ]),
  ].map((program) => join(personalRoot, ...program.split("/")));
  const sharpNativeLibraries = personalManifest.files
    .filter(
      ({ path }) =>
        path.startsWith("services/node_modules/@img/sharp-") && /\.(?:node|dll)$/u.test(path),
    )
    .map(({ path }) => join(personalRoot, ...path.split("/")));
  const expectedSigner = authenticodeIdentity(applicationPath);
  for (const signedPath of [
    processSupervisorPath,
    ...personalExecutables,
    ...sharpNativeLibraries,
  ]) {
    const signer = authenticodeIdentity(signedPath);
    if (signer.thumbprint !== expectedSigner.thumbprint) {
      throw new Error(`${signedPath} was not signed by the Desktop release identity.`);
    }
  }
}

function authenticodeIdentity(filePath) {
  const script = [
    "$signature = Get-AuthenticodeSignature -LiteralPath $args[0]",
    "if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) { exit 9 }",
    "$value = @{ thumbprint = $signature.SignerCertificate.Thumbprint; subject = $signature.SignerCertificate.Subject }",
    "$value | ConvertTo-Json -Compress",
  ].join("; ");
  const serialized = run(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script, filePath],
    true,
  ).trim();
  let identity;
  try {
    identity = JSON.parse(serialized);
  } catch (error) {
    throw new Error(`Windows Authenticode verification returned invalid output for ${filePath}.`, {
      cause: error,
    });
  }
  if (
    !identity ||
    typeof identity.thumbprint !== "string" ||
    !/^[A-F0-9]{40,128}$/u.test(identity.thumbprint) ||
    typeof identity.subject !== "string" ||
    !identity.subject
  ) {
    throw new Error(`Windows Authenticode identity is invalid for ${filePath}.`);
  }
  return identity;
}

function regularFile(filePath) {
  const metadata = lstatSync(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${filePath} must be a real regular file.`);
  }
  return readFileSync(filePath);
}

function exactObject(filePath, keys) {
  const value = JSON.parse(regularFile(filePath).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${filePath} must contain one JSON object.`);
  }
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${filePath} contains an unexpected manifest shape.`);
  }
  return value;
}

function supportsCloudflaredTokenFile(version) {
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.test(version)) return false;
  const [year, month] = version.split(".").map(Number);
  return year > 2025 || (year === 2025 && month >= 4);
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for a macOS release.`);
  return value;
}

function run(executable, arguments_, capture = false) {
  const result = spawnSync(executable, arguments_, {
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${executable} ${arguments_.join(" ")} failed with exit ${result.status}.`);
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}
