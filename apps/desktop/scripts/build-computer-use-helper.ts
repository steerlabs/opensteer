/**
 * Build `Opensteer Computer Use.app` — the only process on a Mac that holds the
 * Accessibility and Screen Recording grants (docs/computer-use.md §1).
 *
 *   pnpm --filter @opensteer/desktop build:computer-use-helper
 *
 * The validated external input selects signing; Swift derives peer authority
 * from the running helper's own signature. Non-release builds without signing input pass
 * OPENSTEER_DEV_TRUST to Swift. Distributable release builds require valid signing
 * input and never pass that condition. See ../SIGNING.md. --sign, if supplied, must match the input identity.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { arch } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computerUseHelperProtocolVersion } from "@opensteer/protocol";
import { signedHelperProtocolVersionKey } from "../src/signed-helpers/metadata.js";
import { generateAppleDataContracts } from "../../../scripts/generate-apple-data-contracts.js";
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
const packageDirectory = path.join(desktopDirectory, "native/computer-use");
const entitlementsPath = path.join(packageDirectory, "dist", "entitlements.plist");

const bundleIdentifier = "com.opensteer.computer-use";
const productName = "Opensteer Computer Use";
const minimumSystemVersion = "14.0";
const releaseArchitectures = ["arm64", "x86_64"] as const;

const require = createRequire(import.meta.url);
const { signingMode } = require("./macos-release-identity.cjs") as {
  signingMode: import("./signing-input.cjs").SigningMode;
};

async function main(): Promise<void> {
  const mode = signingMode;
  const requested = signingIdentity(process.argv.slice(2));
  const identity = mode.mode === "signed" ? mode.signing.identity : undefined;
  if (requested !== undefined && requested !== identity)
    throw Error("--sign must match the validated signing input.");
  const release = Boolean(identity);
  if (process.env.OPENSTEER_DESKTOP_RELEASE === "1" && !release) {
    throw new Error("A Desktop release must pass --sign <identity> for the Computer use helper.");
  }
  const version = await helperVersion();
  const output = path.join(packageDirectory, "dist", `${productName}.app`);
  const staging = `${output}.tmp-${process.pid}`;

  await rm(path.join(packageDirectory, "build/generated"), { recursive: true, force: true });
  await rm(
    path.join(packageDirectory, "Sources/ComputerUseCore/Support/PeerRequirement.generated.swift"),
    { force: true },
  );
  await generateAppleDataContracts();
  process.stdout.write(
    release
      ? "Peer requirement: own signature team, Developer ID and exact desktop identifiers.\n"
      : "Peer requirement: development trust, same user.\n",
  );
  if (process.argv.includes("--requirement-only")) return;

  const architectures = release ? releaseArchitectures : [arch() === "x64" ? "x86_64" : "arm64"];
  const build = async () => ({
    ComputerUseHelper: await builtExecutable(await buildSwift(release)),
  });
  const packageAndVerify = async (products: Readonly<Record<string, string>>) => {
    const executable = products.ComputerUseHelper;
    if (!executable) throw Error("Computer use compiler product missing");

    try {
      await rm(staging, { force: true, recursive: true });
      const contents = path.join(staging, "Contents");
      await mkdir(path.join(contents, "MacOS"), { mode: 0o755, recursive: true });
      await mkdir(path.join(contents, "Resources"), { mode: 0o755, recursive: true });

      await writeFile(path.join(contents, "PkgInfo"), "APPL????", { mode: 0o644 });
      await writeFile(path.join(contents, "Info.plist"), infoPlist(version), { mode: 0o644 });
      await copyExecutable(executable, path.join(contents, "MacOS", productName));
      await writeAppIcon(path.join(contents, "Resources", "AppIcon.icns"));

      await sign(staging, identity);
      await run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", staging]);

      await rm(output, { force: true, recursive: true });
      await mkdir(path.dirname(output), { mode: 0o755, recursive: true });
      await rename(staging, output);
    } catch (error) {
      await rm(staging, { force: true, recursive: true }).catch(() => undefined);
      throw error;
    }
  };
  if (identity)
    await nativeBuildProducts({
      kind: "computer-use",
      names: ["ComputerUseHelper"],
      sourceRevision: process.env.OPENSTEER_SOURCE_REVISION ?? "",
      cacheDirectory: process.env.OPENSTEER_NATIVE_BUILD_CACHE_DIRECTORY,
      inputs: () => nativeReleaseInputs(repositoryRoot, "computer-use", identity, architectures),
      build,
      verify: (files) => verifyNativeProducts(files, architectures),
      packageAndVerify,
    });
  else await packageAndVerify(await build());

  process.stdout.write(
    `Architectures: ${architectures.join(", ")}\n` +
      (release
        ? `Signed with the release identity and the hardened runtime.\n`
        : "Ad-hoc signed: this is a development build and macOS will treat it as a new app " +
          "the first time it asks for a grant.\n"),
  );
  process.stdout.write(`${output}\n`);
}

/** Release output is universal; development explicitly targets this host. */
async function buildSwift(release: boolean): Promise<readonly string[]> {
  const architectures = release
    ? releaseArchitectures
    : ([arch() === "x64" ? "x86_64" : "arm64"] as const);
  await run(
    "/usr/bin/swift",
    [
      "build",
      "-c",
      "release",
      // Only the shipped helper: test support imports the core @testable, which an optimized build refuses.
      "--product",
      "ComputerUseHelper",
      ...(!release ? ["-Xswiftc", "-DOPENSTEER_DEV_TRUST"] : []),
      ...architectures.flatMap((architecture) => ["--arch", architecture]),
    ],
    packageDirectory,
  );
  return architectures;
}

function signingIdentity(arguments_: readonly string[]): string | undefined {
  const index = arguments_.indexOf("--sign");
  if (index === -1) return undefined;
  const identity = arguments_[index + 1]?.trim();
  if (!identity) throw new Error("--sign requires a signing identity.");
  if (arguments_.indexOf("--sign", index + 1) !== -1) {
    throw new Error("--sign may be provided only once.");
  }
  return identity;
}

async function builtExecutable(architectures: readonly string[]): Promise<string> {
  const binPath = (
    await capture(
      "/usr/bin/swift",
      [
        "build",
        "-c",
        "release",
        ...architectures.flatMap((architecture) => ["--arch", architecture]),
        "--show-bin-path",
      ],
      packageDirectory,
    )
  ).trim();
  return path.join(binPath, "ComputerUseHelper");
}

async function copyExecutable(source: string, destination: string): Promise<void> {
  const bytes = await readFile(source);
  await writeFile(destination, bytes, { mode: 0o755 });
}

function infoPlist(version: string): string {
  // Neither Accessibility nor Screen Recording takes a usage-description
  // string: macOS composes those two prompts itself from the app's name, and
  // there is no `NSAccessibilityUsageDescription` or
  // `NSScreenCaptureUsageDescription` key in any macOS SDK. Contacts,
  // Calendars and Reminders do: macOS refuses a request from an app that does
  // not say why it asks. What the person reads in System Settings is
  // `CFBundleDisplayName`, which is why that is the name the panels use.
  const entries: Record<string, string | boolean | number> = {
    CFBundleDevelopmentRegion: "en",
    CFBundleDisplayName: productName,
    CFBundleExecutable: productName,
    CFBundleIconFile: "AppIcon",
    CFBundleIdentifier: bundleIdentifier,
    CFBundleInfoDictionaryVersion: "6.0",
    CFBundleName: productName,
    CFBundlePackageType: "APPL",
    CFBundleShortVersionString: version,
    CFBundleVersion: version,
    LSMinimumSystemVersion: minimumSystemVersion,
    LSUIElement: true,
    NSAppleEventsUsageDescription:
      "Opensteer sends messages in Messages when you let agents use it.",
    NSCalendarsFullAccessUsageDescription:
      "Opensteer uses your calendars when you let agents read or change them.",
    NSContactsUsageDescription: "Opensteer reads your contacts when you let agents use them.",
    NSHighResolutionCapable: true,
    NSRemindersFullAccessUsageDescription:
      "Opensteer uses your reminders when you let agents read or change them.",
    NSSupportsAutomaticTermination: false,
    NSSupportsSuddenTermination: false,
    // What the installer compares before the version: a build between
    // releases shares the last release's version (§2 "Install").
    [signedHelperProtocolVersionKey]: computerUseHelperProtocolVersion,
  };
  const body = Object.entries(entries)
    .map(([key, value]) =>
      typeof value === "boolean"
        ? `\t<key>${key}</key>\n\t<${value}/>`
        : typeof value === "number"
          ? `\t<key>${key}</key>\n\t<integer>${value}</integer>`
          : `\t<key>${key}</key>\n\t<string>${value}</string>`,
    )
    .join("\n");
  return plist(body);
}

/** A property list document around one dictionary's entries. */
function plist(body: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ` +
    `"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`
  );
}

/**
 * Under the hardened runtime macOS denies Apple events (sending in Messages),
 * Contacts and Calendars (which also covers Reminders) to an app that does not
 * claim them, whatever the person allows. Full Disk Access needs no claim. A
 * development build is not hardened and needs none.
 */
const hardenedRuntimeEntitlements = [
  "com.apple.security.automation.apple-events",
  "com.apple.security.personal-information.addressbook",
  "com.apple.security.personal-information.calendars",
] as const;

async function sign(bundle: string, identity: string | undefined): Promise<void> {
  if (identity) {
    await mkdir(path.dirname(entitlementsPath), { mode: 0o755, recursive: true });
    await writeFile(
      entitlementsPath,
      plist(hardenedRuntimeEntitlements.map((key) => `\t<key>${key}</key>\n\t<true/>`).join("\n")),
      { encoding: "utf8", mode: 0o644 },
    );
  }
  await run("/usr/bin/codesign", [
    "--force",
    ...signingKeychainArguments(),
    "--sign",
    identity ?? "-",
    ...(identity
      ? ["--timestamp", "--options", "runtime", "--entitlements", entitlementsPath]
      : []),
    "--identifier",
    bundleIdentifier,
    bundle,
  ]);
}

/**
 * The release version is the one the root manifest declares; the Desktop
 * manifest carries `0.0.0` until packaging rewrites it, and a helper whose
 * `CFBundleVersion` is `0.0.0` would never be replaced by the installer, which
 * only ever upgrades (§2 "Install").
 */
async function helperVersion(): Promise<string> {
  const pattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
  const desktop = await manifestVersion(path.join(desktopDirectory, "package.json"));
  if (pattern.test(desktop) && desktop !== "0.0.0") return desktop;
  const root = await manifestVersion(path.join(repositoryRoot, "package.json"));
  if (!pattern.test(root)) {
    throw new Error("Opensteer does not declare a stable release version to build the helper at.");
  }
  return root;
}

async function manifestVersion(manifestPath: string): Promise<string> {
  const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  return typeof manifest === "object" && manifest !== null && "version" in manifest
    ? String((manifest as { version: unknown }).version)
    : "";
}

/**
 * Build the helper icon from its own mark, the Opensteer circle with a pointer
 * badge: System Settings lists the helper beside Opensteer itself, and two
 * identical icons there are how a person switches on the wrong one.
 */
async function writeAppIcon(destination: string): Promise<void> {
  const iconset = `${destination}.iconset`;
  await rm(iconset, { force: true, recursive: true });
  await mkdir(iconset, { mode: 0o755, recursive: true });
  const master = path.join(iconset, "icon_512x512@2x.png");
  await run(
    "/usr/bin/sips",
    [
      "-z",
      "1024",
      "1024",
      path.join(repositoryRoot, "apps/web/public/computer-use.png"),
      "--out",
      master,
    ],
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
  if (arguments_.includes("--keychain"))
    process.stdout.write(
      `${executable} ${arguments_.map((value) => JSON.stringify(value)).join(" ")}\n`,
    );
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
  cwd: string = repositoryRoot,
): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(executable, [...arguments_], {
      cwd,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (piece: string) => {
      output += piece;
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
