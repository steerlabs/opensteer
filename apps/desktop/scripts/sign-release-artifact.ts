/**
 * Sign one reviewed standalone release input with the macOS release identity
 * and print the digest packaging must pin.
 *
 * The Desktop release contract treats the digest of `cloudflared`, the process
 * supervisor, and every other reviewed binary as immutable: packaging copies
 * the exact reviewed bytes into the application and verifies the same digest
 * again after the application is signed. A reviewed binary therefore has to
 * carry the release signing identity before its digest is taken, which is what
 * this script does.
 *
 *   OPENSTEER_DESKTOP_SIGNING_FILE=/absolute/path/signing.json \
 *   tsx scripts/sign-release-artifact.ts <source> <destination>
 *
 * The destination copy is left read-only, and the SHA-256 of the signed copy is
 * written to stdout for the matching `*_SHA256` packaging variable.
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { setFileMode } from "@opensteer/shared/privateFiles";
import { copyFile, lstat, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

const { signingKeychainArguments, readSigningMode } = createRequire(import.meta.url)(
  "./signing-input.cjs",
) as typeof import("./signing-input.cjs");

const [sourceArgument, destinationArgument] = process.argv.slice(2);
if (!sourceArgument || !destinationArgument) {
  throw new Error("Usage: sign-release-artifact.ts <source> <destination>");
}
const signingMode = readSigningMode();
const legacyIdentity = process.env.OPENSTEER_RELEASE_SIGNING_IDENTITY?.trim();
const identity = signingMode.mode === "signed" ? signingMode.signing.identity : legacyIdentity;
if (legacyIdentity && legacyIdentity !== identity)
  throw Error("Artifact identity must match the signing input.");
if (!identity) {
  throw new Error("OPENSTEER_RELEASE_SIGNING_IDENTITY is required to sign a release artifact.");
}
const entitlements = process.env.OPENSTEER_RELEASE_SIGNING_ENTITLEMENTS?.trim();

const source = path.resolve(sourceArgument);
const destination = path.resolve(destinationArgument);
const metadata = await lstat(source);
if (!metadata.isFile() || metadata.isSymbolicLink()) {
  throw new Error(`${source} must be a real regular file.`);
}
if (source === destination) {
  throw new Error("A reviewed release artifact is signed into a separate destination copy.");
}

await mkdir(path.dirname(destination), { mode: 0o700, recursive: true });
await rm(destination, { force: true });
await copyFile(source, destination);
await setFileMode(destination, 0o755);
await run("/usr/bin/codesign", [
  "--force",
  ...signingKeychainArguments(),
  "--sign",
  identity,
  "--timestamp",
  "--options",
  "runtime",
  ...(entitlements ? ["--entitlements", entitlements] : []),
  destination,
]);
await run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", destination]);
await setFileMode(destination, 0o555);

process.stdout.write(
  `${createHash("sha256")
    .update(await readFile(destination))
    .digest("hex")}\n`,
);

async function run(executable: string, arguments_: readonly string[]): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(executable, [...arguments_], {
      shell: false,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${executable} failed (${signal ?? `exit ${code}`}).`));
    });
  });
}
