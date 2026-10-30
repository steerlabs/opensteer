import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile, rename } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { plist } from "@opensteer/shared/plist";
import { dictationHelperProtocolVersion } from "@opensteer/protocol/dictation-helper";
import { signedHelperProtocolVersionKey } from "../src/signed-helpers/metadata.js";
const require = createRequire(import.meta.url);
const { signingMode } = require("./macos-release-identity.cjs") as {
  signingMode: import("./signing-input.cjs").SigningMode;
};
const { signingKeychainArguments } =
  require("./signing-input.cjs") as typeof import("./signing-input.cjs");
const directory = path.resolve(import.meta.dirname, "../native/dictation");
const signed = signingMode.mode === "signed";
const identity = signingMode.mode === "signed" ? signingMode.signing.identity : "-";
const requested = process.argv.indexOf("--sign");
if (requested >= 0 && process.argv[requested + 1] !== identity)
  throw new Error("--sign must match the validated signing input.");
const flags = [
  "build",
  "--package-path",
  directory,
  "-c",
  signed ? "release" : "debug",
  "--arch",
  "arm64",
  ...(!signed ? ["-Xswiftc", "-DOPENSTEER_DEV_TRUST"] : []),
];
execFileSync("/usr/bin/swift", [...flags, "--product", "DictationHelper"], { stdio: "inherit" });
const bin = execFileSync("/usr/bin/swift", [...flags, "--show-bin-path"], {
  encoding: "utf8",
}).trim();
const name = "Opensteer Dictation";
const output = path.join(directory, "dist", `${name}.app`);
const staging = `${output}.tmp-${process.pid}`;
const version = (
  JSON.parse(
    await readFile(path.resolve(import.meta.dirname, "../../../package.json"), "utf8"),
  ) as { version: string }
).version;
const entitlements = path.join(directory, "dist", `entitlements-${process.pid}.plist`);
try {
  await rm(staging, { recursive: true, force: true });
  await mkdir(path.join(staging, "Contents/MacOS"), { recursive: true });
  await writeFile(
    path.join(staging, "Contents/MacOS", name),
    await readFile(path.join(bin, "DictationHelper")),
    { mode: 0o755 },
  );
  await writeFile(
    path.join(staging, "Contents/Info.plist"),
    plist({
      CFBundleExecutable: name,
      CFBundleName: name,
      CFBundleDisplayName: name,
      CFBundleIdentifier: signed ? "com.opensteer.dictation" : "com.opensteer.dictation.dev",
      CFBundlePackageType: "APPL",
      CFBundleInfoDictionaryVersion: "6.0",
      CFBundleVersion: version,
      CFBundleShortVersionString: version,
      LSUIElement: true,
      LSMinimumSystemVersion: "26.0",
      NSMicrophoneUsageDescription:
        "Opensteer Dictation turns your speech into message text. It listens only while you dictate.",
      [signedHelperProtocolVersionKey]: dictationHelperProtocolVersion,
    }),
  );
  await writeFile(entitlements, plist({ "com.apple.security.device.audio-input": true }));
  execFileSync(
    "/usr/bin/codesign",
    [
      "--force",
      ...signingKeychainArguments(),
      "--sign",
      identity,
      "--options",
      "runtime",
      ...(signed ? ["--timestamp"] : []),
      "--entitlements",
      entitlements,
      staging,
    ],
    { stdio: "inherit" },
  );
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", staging], {
    stdio: "inherit",
  });
  const xml = execFileSync("/usr/bin/codesign", ["-d", "--entitlements", "-", "--xml", staging], {
    encoding: "utf8",
  });
  const actual: unknown = JSON.parse(
    execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], {
      input: xml,
      encoding: "utf8",
    }),
  );
  if (JSON.stringify(actual) !== JSON.stringify({ "com.apple.security.device.audio-input": true }))
    throw new Error("Unexpected Dictation entitlements");
  await rm(output, { recursive: true, force: true });
  await rename(staging, output);
  process.stdout.write(`${output}\n`);
} finally {
  await rm(staging, { recursive: true, force: true });
  await rm(entitlements, { force: true });
}
