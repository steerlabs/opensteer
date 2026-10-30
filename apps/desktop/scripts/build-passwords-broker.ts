import { buildSwiftProducts } from "./build-swift-products.js";
import { plist } from "@opensteer/shared/plist";
/**
 * Build `Opensteer Passwords.app`: the broker that holds the vault and every
 * approval, with its sandboxed import worker at
 * `Contents/Helpers/Opensteer Passwords Import` (docs/passwords.md).
 *
 *   pnpm --filter @opensteer/desktop build:passwords-broker
 *   pnpm --filter @opensteer/desktop build:passwords-broker -- --sign "Developer ID Application: …"
 *
 * The validated external input selects signing; Swift derives peer authority
 * from the running helper's own signature. Non-release builds without signing input pass
 * OPENSTEER_DEV_TRUST to Swift. Distributable release builds require valid signing
 * input and never pass that condition. See ../SIGNING.md. --sign, if supplied, must match the input identity.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { arch } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { passwordsBrokerProtocolVersion } from "@opensteer/protocol/passwords-broker";
import { signedHelperProtocolVersionKey } from "../src/signed-helpers/metadata.js";
import {
  nativeBuildProducts,
  nativeReleaseInputs,
  verifyNativeProducts,
} from "./native-build-cache.js";

const { signingKeychainArguments } = createRequire(import.meta.url)(
  "./signing-input.cjs",
) as typeof import("./signing-input.cjs");

const desktopDirectory = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = path.resolve(desktopDirectory, "../..");
const packageDirectory = path.join(desktopDirectory, "native/passwords");
const distDirectory = path.join(packageDirectory, "dist");

const productName = "Opensteer Passwords";
const workerName = "Opensteer Passwords Import";
const minimumSystemVersion = "14.0";
const releaseArchitectures = ["arm64", "x86_64"] as const;

const require = createRequire(import.meta.url);
const { opensteerAppleTeamId, signingMode } = require("./macos-release-identity.cjs") as {
  opensteerAppleTeamId: string;
  signingMode: import("./signing-input.cjs").SigningMode;
};

/** Must match `apps/desktop/src/passwords/paths.ts`. */
function bundleIdentifier(release: boolean): string {
  return release ? "com.opensteer.passwords" : "com.opensteer.passwords.dev";
}

function workerIdentifier(release: boolean): string {
  return `${bundleIdentifier(release)}.import`;
}

const keychainAccessGroup = `${opensteerAppleTeamId}.com.opensteer.passwords`;

async function main(): Promise<void> {
  const mode = signingMode;
  const requested = signingIdentity(process.argv.slice(2));
  const identity = mode.mode === "signed" ? mode.signing.identity : undefined;
  if (requested !== undefined && requested !== identity)
    throw Error("--sign must match the validated signing input.");
  const release = Boolean(identity);
  if (process.env.OPENSTEER_DESKTOP_RELEASE === "1" && !release) {
    throw new Error("A Desktop release must pass --sign <identity> for Opensteer Passwords.");
  }
  // Checked before anything is compiled: a release broker without its
  // profile could never read its keychain group on a customer's Mac.
  const profile = release ? await provisioningProfile() : undefined;

  await rm(path.join(packageDirectory, "build/generated"), { recursive: true, force: true });
  await rm(path.join(packageDirectory, "Sources/PasswordsBroker/BuildMode.generated.swift"), {
    force: true,
  });
  await rm(path.join(packageDirectory, "Sources/PasswordsImportWorker/Info.generated.plist"), {
    force: true,
  });
  process.stdout.write(
    release
      ? `Opensteer Passwords: own signature team. Keychain group: ${keychainAccessGroup}\n`
      : "Opensteer Passwords: development trust, separate file store.\n",
  );
  if (process.argv.includes("--generate-only")) return;

  const version = await brokerVersion();
  const architectures = release
    ? releaseArchitectures
    : ([arch() === "x64" ? "x86_64" : "arm64"] as const);
  const build = async () => {
    const binPath = await buildSwift(architectures);
    return {
      PasswordsBroker: path.join(binPath, "PasswordsBroker"),
      PasswordsImportWorker: path.join(binPath, "PasswordsImportWorker"),
    };
  };
  const output = path.join(distDirectory, `${productName}.app`);
  const staging = `${output}.tmp-${process.pid}`;
  const signingDirectory = path.join(distDirectory, `.signing-${process.pid}`);

  const packageAndVerify = async (products: Readonly<Record<string, string>>) => {
    try {
      await rm(staging, { force: true, recursive: true });
      const contents = path.join(staging, "Contents");
      await mkdir(path.join(contents, "MacOS"), { mode: 0o755, recursive: true });
      await mkdir(path.join(contents, "Helpers"), { mode: 0o755, recursive: true });
      await mkdir(path.join(contents, "Resources"), { mode: 0o755, recursive: true });
      await writeFile(path.join(contents, "PkgInfo"), "APPL????", { mode: 0o644 });
      await writeFile(path.join(contents, "Info.plist"), infoPlist(release, version), {
        mode: 0o644,
      });
      await copyExecutable(products.PasswordsBroker!, path.join(contents, "MacOS", productName));
      const worker = path.join(contents, "Helpers", workerName);
      await copyExecutable(products.PasswordsImportWorker!, worker);
      await writeAppIcon(path.join(contents, "Resources", "AppIcon.icns"));
      if (profile) await copyFile(profile, path.join(contents, "embedded.provisionprofile"));

      await mkdir(signingDirectory, { mode: 0o700, recursive: true });
      // The worker is sealed inside the app, so it is signed first and the
      // app's signature covers it.
      await sign(worker, workerIdentifier(release), identity, signingDirectory, workerEntitlements);
      await sign(
        staging,
        bundleIdentifier(release),
        identity,
        signingDirectory,
        release ? appEntitlements : null,
      );
      await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", staging]);
      await verifyEntitlements(worker, workerEntitlements);
      await verifyEntitlements(staging, release ? appEntitlements : null);
      await verifyWorkerAnswers(worker);

      await rm(output, { force: true, recursive: true });
      await mkdir(distDirectory, { mode: 0o755, recursive: true });
      await rename(staging, output);
    } catch (error) {
      await rm(staging, { force: true, recursive: true }).catch(() => undefined);
      throw error;
    } finally {
      await rm(signingDirectory, { force: true, recursive: true }).catch(() => undefined);
    }
  };
  if (identity)
    await nativeBuildProducts({
      kind: "passwords",
      names: ["PasswordsBroker", "PasswordsImportWorker"],
      sourceRevision: process.env.OPENSTEER_SOURCE_REVISION ?? "",
      cacheDirectory: process.env.OPENSTEER_NATIVE_BUILD_CACHE_DIRECTORY,
      inputs: () => nativeReleaseInputs(repositoryRoot, "passwords", identity, architectures),
      build,
      verify: (files) => verifyNativeProducts(files, architectures),
      packageAndVerify,
    });
  else await packageAndVerify(await build());

  process.stdout.write(
    `Architectures: ${architectures.join(", ")}\n` +
      (release
        ? "Signed with the release identity, the hardened runtime and the embedded provisioning profile.\n"
        : "Ad-hoc signed development build.\n") +
      `${output}\n`,
  );
}

/**
 * The Developer ID provisioning profile that grants the keychain group,
 * decoded and checked so a wrong file is refused with a sentence rather than
 * shipped as a broker that cannot start on anyone's Mac.
 */
async function provisioningProfile(): Promise<string> {
  const value = process.env.OPENSTEER_PASSWORDS_PROVISIONING_PROFILE?.trim();
  if (!value) {
    throw new Error(
      "A release Opensteer Passwords needs its Developer ID provisioning profile: set " +
        "OPENSTEER_PASSWORDS_PROVISIONING_PROFILE to the .provisionprofile file for " +
        `${opensteerAppleTeamId}.com.opensteer.passwords (see apps/desktop/native/passwords/README.md).`,
    );
  }
  const profile = path.resolve(value);
  const metadata = await lstat(profile).catch(() => null);
  if (!metadata?.isFile()) {
    throw new Error(`OPENSTEER_PASSWORDS_PROVISIONING_PROFILE is not a file: ${profile}`);
  }
  // A profile holds dates and certificate data, which plutil cannot write as
  // JSON, so only the three fields checked here are read, each in a form it can.
  const field = async (key: string, format: "json" | "raw"): Promise<string> =>
    await capture("/bin/sh", [
      "-c",
      'set -o pipefail; /usr/bin/security cms -D -i "$1" 2>/dev/null | /usr/bin/plutil -extract "$2" "$3" -o - - 2>/dev/null',
      "decode",
      profile,
      key,
      format,
    ]).catch(() => {
      throw new Error(
        `OPENSTEER_PASSWORDS_PROVISIONING_PROFILE is not a provisioning profile with ${key}: ${profile}`,
      );
    });
  const decoded = {
    Entitlements: JSON.parse(await field("Entitlements", "json")) as Readonly<
      Record<string, unknown>
    >,
    ExpirationDate: (await field("ExpirationDate", "raw")).trim(),
    TeamIdentifier: JSON.parse(await field("TeamIdentifier", "json")) as readonly string[],
  };
  const entitlements = decoded.Entitlements ?? {};
  const groups = entitlements["keychain-access-groups"];
  const problems = [
    decoded.TeamIdentifier?.includes(opensteerAppleTeamId) ? null : `team ${opensteerAppleTeamId}`,
    entitlements["com.apple.application-identifier"] ===
    `${opensteerAppleTeamId}.com.opensteer.passwords`
      ? null
      : `the App ID ${opensteerAppleTeamId}.com.opensteer.passwords`,
    Array.isArray(groups) &&
    groups.some((group) => group === keychainAccessGroup || group === `${opensteerAppleTeamId}.*`)
      ? null
      : `the keychain group ${keychainAccessGroup}`,
    decoded.ExpirationDate && Date.parse(decoded.ExpirationDate) > Date.now()
      ? null
      : "a date in the future",
  ].filter((problem): problem is string => problem !== null);
  if (problems.length > 0) {
    throw new Error(`The provisioning profile ${profile} does not name ${problems.join(", ")}.`);
  }
  return profile;
}

/** Exactly what each signature may claim; read back after signing. */
const workerEntitlements: Readonly<Record<string, unknown>> = {
  // No network, no files: the worker reads its standard input and writes
  // its standard output, which the sandbox allows.
  "com.apple.security.app-sandbox": true,
};
const appEntitlements: Readonly<Record<string, unknown>> = {
  // A provisioning profile's restricted entitlement is honoured only when the
  // signature also names the profile's App ID and team.
  "com.apple.application-identifier": `${opensteerAppleTeamId}.com.opensteer.passwords`,
  "com.apple.developer.team-identifier": opensteerAppleTeamId,
  "keychain-access-groups": [keychainAccessGroup],
};

async function sign(
  target: string,
  identifier: string,
  identity: string | undefined,
  signingDirectory: string,
  entitlements: Readonly<Record<string, unknown>> | null,
): Promise<void> {
  const entitlementsPath = path.join(signingDirectory, `${identifier}.entitlements.plist`);
  if (entitlements) await writeFile(entitlementsPath, plist(entitlements), { mode: 0o644 });
  await run("/usr/bin/codesign", [
    "--force",
    ...signingKeychainArguments(),
    "--sign",
    identity ?? "-",
    ...(identity ? ["--timestamp", "--options", "runtime"] : []),
    ...(entitlements ? ["--entitlements", entitlementsPath] : []),
    "--identifier",
    identifier,
    target,
  ]);
}

async function verifyEntitlements(
  target: string,
  expected: Readonly<Record<string, unknown>> | null,
): Promise<void> {
  const xml = await capture("/usr/bin/codesign", ["-d", "--entitlements", "-", "--xml", target]);
  const actual =
    xml.trim().length === 0
      ? {}
      : (JSON.parse(
          await capture("/bin/sh", [
            "-c",
            'printf "%s" "$1" | /usr/bin/plutil -convert json -o - -',
            "entitlements",
            xml,
          ]),
        ) as Record<string, unknown>);
  if (JSON.stringify(sortKeys(actual)) !== JSON.stringify(sortKeys(expected ?? {}))) {
    throw new Error(
      `${path.basename(target)} is signed with unexpected entitlements: ${JSON.stringify(actual)}`,
    );
  }
}

function sortKeys(value: Readonly<Record<string, unknown>>): [string, unknown][] {
  return Object.entries(value).sort(([left], [right]) => (left < right ? -1 : 1));
}

/**
 * The embedded worker, signed and sandboxed, parses a one-line export: proof
 * that it starts under its sandbox and has the Public Suffix List compiled in.
 */
async function verifyWorkerAnswers(worker: string): Promise<void> {
  const answer = await capture(
    worker,
    [],
    "url,username,password\nhttps://example.com,a,synthetic\n",
  );
  if (
    !answer.startsWith('{"result":{"candidates":[{') ||
    !answer.includes('"https://example.com"')
  ) {
    throw new Error("The signed import worker did not answer a one-line export.");
  }
}

/** Release output is universal; development targets this Mac. */
async function buildSwift(architectures: readonly string[]): Promise<string> {
  return buildSwiftProducts(
    packageDirectory,
    ["PasswordsBroker", "PasswordsImportWorker"],
    architectures,
    signingMode.mode === "development" ? "debug" : "release",
    signingMode.mode === "development" ? ["-Xswiftc", "-DOPENSTEER_DEV_TRUST"] : [],
  );
}

function signingIdentity(arguments_: readonly string[]): string | undefined {
  const index = arguments_.indexOf("--sign");
  if (index === -1) return undefined;
  const identity = arguments_[index + 1]?.trim();
  if (!identity || identity.startsWith("--"))
    throw new Error("--sign requires a signing identity.");
  if (arguments_.indexOf("--sign", index + 1) !== -1) {
    throw new Error("--sign may be provided only once.");
  }
  return identity;
}

async function copyExecutable(source: string, destination: string): Promise<void> {
  await writeFile(destination, await readFile(source), { mode: 0o755 });
}

function infoPlist(release: boolean, version: string): string {
  return plist({
    CFBundleDevelopmentRegion: "en",
    CFBundleDisplayName: productName,
    CFBundleExecutable: productName,
    CFBundleIconFile: "AppIcon",
    CFBundleIdentifier: bundleIdentifier(release),
    CFBundleInfoDictionaryVersion: "6.0",
    CFBundleName: productName,
    CFBundlePackageType: "APPL",
    CFBundleShortVersionString: version,
    CFBundleVersion: version,
    LSMinimumSystemVersion: minimumSystemVersion,
    LSUIElement: true,
    NSHighResolutionCapable: true,
    NSSupportsAutomaticTermination: false,
    NSSupportsSuddenTermination: false,
    // What the installer compares before the version: a build between
    // releases shares the last release's version.
    [signedHelperProtocolVersionKey]: passwordsBrokerProtocolVersion,
  });
}

/**
 * The release version the root manifest declares; the Desktop manifest
 * carries `0.0.0` until packaging rewrites it, and a broker whose
 * `CFBundleVersion` is `0.0.0` would never be replaced by the installer,
 * which only ever upgrades.
 */
async function brokerVersion(): Promise<string> {
  const pattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
  const desktop = await manifestVersion(path.join(desktopDirectory, "package.json"));
  if (pattern.test(desktop) && desktop !== "0.0.0") return desktop;
  const root = await manifestVersion(path.join(repositoryRoot, "package.json"));
  if (!pattern.test(root)) {
    throw new Error("Opensteer does not declare a stable release version to build the broker at.");
  }
  return root;
}

async function manifestVersion(manifestPath: string): Promise<string> {
  const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  return typeof manifest === "object" && manifest !== null && "version" in manifest
    ? String((manifest as { version: unknown }).version)
    : "";
}

/** The Opensteer mark the web app uses, as the app icon. */
async function writeAppIcon(destination: string): Promise<void> {
  const iconset = `${destination}.iconset`;
  await rm(iconset, { force: true, recursive: true });
  await mkdir(iconset, { mode: 0o755, recursive: true });
  const master = path.join(iconset, "icon_512x512@2x.png");
  const source = path.join(repositoryRoot, "apps/web/public/opensteer.png");
  await run(
    "/usr/bin/sips",
    ["-z", "1024", "1024", source, "--out", master],
    repositoryRoot,
    "ignore",
  );
  for (const [name, size] of [
    ["icon_16x16", 16],
    ["icon_16x16@2x", 32],
    ["icon_32x32", 32],
    ["icon_32x32@2x", 64],
    ["icon_128x128", 128],
    ["icon_128x128@2x", 256],
    ["icon_256x256", 256],
    ["icon_256x256@2x", 512],
    ["icon_512x512", 512],
  ] as const) {
    await run(
      "/usr/bin/sips",
      ["-z", String(size), String(size), master, "--out", path.join(iconset, `${name}.png`)],
      repositoryRoot,
      "ignore",
    );
  }
  await run("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", destination]);
  await rm(iconset, { force: true, recursive: true });
}

async function run(
  executable: string,
  arguments_: readonly string[],
  cwd: string = repositoryRoot,
  stdio: "ignore" | "inherit" = "inherit",
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(executable, [...arguments_], {
      cwd,
      env: process.env,
      shell: false,
      stdio,
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${executable} failed (${signal ?? `exit ${code}`}).`));
    });
  });
}

async function capture(
  executable: string,
  arguments_: readonly string[],
  input?: string,
  cwd: string = repositoryRoot,
): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(executable, [...arguments_], {
      cwd,
      env: process.env,
      shell: false,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "inherit"],
    });
    let output = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (piece: string) => {
      output += piece;
    });
    child.once("error", rejectPromise);
    // `close`, not `exit`: the answer is whole only once stdout has ended.
    child.once("close", (code, signal) => {
      if (code === 0) resolvePromise(output);
      else rejectPromise(new Error(`${executable} failed (${signal ?? `exit ${code}`}).`));
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
