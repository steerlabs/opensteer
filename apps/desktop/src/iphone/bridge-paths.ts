import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import {
  codesignRequirementOption,
  opensteerAppleTeamId,
  opensteerDeveloperIdRequirement,
} from "../signed-helpers/developer-id.js";
import { IphoneServiceError } from "./iphone-store.js";

/** Inside this install's own data directory, so a source build never touches an installed app's. */
export function iphoneOwnershipRoot(dataDirectory: string): string {
  return path.join(dataDirectory, "iPhone Ownership");
}
export function bundledIphoneBridgePath(input: {
  packaged: boolean;
  developmentRoot: string;
  resourcesPath?: string;
  arch?: string;
}): string {
  const arch = input.arch ?? process.arch;
  if (arch !== "arm64" && arch !== "x64") throw new IphoneServiceError("unsupported-mac");
  if (input.packaged) {
    if (!input.resourcesPath) throw new IphoneServiceError("bridge-signature-invalid");
    return path.join(input.resourcesPath, "iphone-bridge", "opensteer-iphone-bridge");
  }
  return path.join(
    input.developmentRoot,
    "apps",
    "desktop",
    "generated-native",
    `darwin-${arch === "x64" ? "amd64" : arch}`,
    "opensteer-iphone-bridge",
  );
}
const releaseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  operatingSystem: z.literal("darwin"),
  architecture: z.enum(["amd64", "arm64"]),
  binarySha256: z.string().regex(/^[a-f0-9]{64}$/u),
  protocolVersion: z.literal(1),
});
export async function verifyIphoneBridge(input: {
  binary: string;
  packaged: boolean;
  arch?: string;
  verifySignature?: (binary: string, requirement: string) => Promise<void>;
}): Promise<string> {
  try {
    if (!path.isAbsolute(input.binary) || (await realpath(input.binary)) !== input.binary)
      throw new Error();
    const stat = await lstat(input.binary);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o111) === 0 ||
      stat.size > 128 * 1024 * 1024
    )
      throw new Error();
    const bytes = await readFile(input.binary);
    const arch = (input.arch ?? process.arch) === "x64" ? "amd64" : "arm64";
    const cpu = arch === "arm64" ? 0x0100000c : 0x01000007;
    if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== cpu)
      throw new Error();
    if (input.packaged) {
      const manifestPath = path.join(path.dirname(input.binary), "release.json");
      if ((await realpath(manifestPath)) !== manifestPath || !(await lstat(manifestPath)).isFile())
        throw new Error();
      const release = releaseSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
      if (
        release.architecture !== arch ||
        release.binarySha256 !== createHash("sha256").update(bytes).digest("hex")
      )
        throw new Error();
      const requirement = opensteerDeveloperIdRequirement(
        opensteerAppleTeamId,
        "com.opensteer.iphone-bridge",
      );
      if (input.verifySignature) await input.verifySignature(input.binary, requirement);
      else
        await promisify(execFile)(
          "/usr/bin/codesign",
          ["--verify", "--strict", codesignRequirementOption(requirement), input.binary],
          { timeout: 10000, maxBuffer: 16384 },
        );
    }
    return input.binary;
  } catch {
    throw new IphoneServiceError(input.packaged ? "bridge-signature-invalid" : "bridge-not-built");
  }
}
