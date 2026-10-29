import { lstat } from "node:fs/promises";
import path from "node:path";
import { agentPhoneApkMaxBytes } from "@opensteer/protocol";
import {
  DesktopAgentPhoneArtifactSchema,
  type DesktopAgentPhoneArtifact,
} from "@opensteer/protocol/desktop";
import { isNodeError } from "@opensteer/shared/nodeError";
import { readBoundedRegularFile } from "@opensteer/shared/privateFiles";

/**
 * The Agent Phone app this build carries, which the Computers page installs
 * on a phone over USB. `pnpm build:agent-phone` writes both files; a release
 * build stages them with its other resources (`prepare-release-resources.ts`),
 * and the after-pack gate refuses a package whose APK does not match its
 * manifest or, for a release, is missing or not a release build.
 */
export const agentPhoneResourceDirectory = "agent-phone";
export const agentPhoneApkName = "opensteer-agent-phone.apk";
export const agentPhoneManifestName = "agent-phone.json";

const maximumManifestBytes = 16 * 1_024;

/**
 * Packaged: beside the other bundled resources. Development: where
 * `scripts/build-agent-phone.ts` writes it, which is empty until somebody
 * builds the app — then this build simply carries none.
 */
export function bundledAgentPhoneDirectory(input: {
  readonly developmentRoot: string;
  readonly packaged: boolean;
  readonly resourcesPath: string | undefined;
}): string {
  if (input.packaged) {
    if (!input.resourcesPath) {
      throw new Error("A packaged desktop app must know its resources directory.");
    }
    return path.join(input.resourcesPath, agentPhoneResourceDirectory);
  }
  return path.join(
    input.developmentRoot,
    "apps",
    "desktop",
    "generated-resources",
    agentPhoneResourceDirectory,
  );
}

/**
 * Reads the fixed pair from `directory`, still unverified — the setup engine
 * checks the APK against its manifest before using either — or null when this
 * build carries no Agent Phone app.
 *
 * The page never names a file: the directory and both names are fixed here,
 * each file must be a real file in that real directory, and both are bounded
 * before they are read.
 */
export async function readBundledAgentPhoneArtifact(
  directory: string,
): Promise<DesktopAgentPhoneArtifact | null> {
  try {
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("The bundled Agent Phone app must be a real directory.");
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
  const manifest = await readBundledFile(directory, agentPhoneManifestName, maximumManifestBytes);
  const apk = await readBundledFile(directory, agentPhoneApkName, agentPhoneApkMaxBytes);
  if (manifest === null && apk === null) return null;
  if (manifest === null || apk === null) {
    throw new Error(
      "This build's Agent Phone app is incomplete; rebuild it with pnpm build:agent-phone.",
    );
  }
  return DesktopAgentPhoneArtifactSchema.parse({
    bytes: new Uint8Array(apk),
    manifest: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifest)),
  });
}

function readBundledFile(
  directory: string,
  name: string,
  maximumBytes: number,
): Promise<Buffer | null> {
  const invalid = () => new Error(`The bundled ${name} must be a real file.`);
  return readBoundedRegularFile(path.join(directory, name), maximumBytes, {
    changedError: invalid,
    invalidFileError: invalid,
    minimumBytes: 1,
    missing: "null",
    sizeError: () => new Error(`The bundled ${name} is larger than an Agent Phone build can be.`),
  });
}
