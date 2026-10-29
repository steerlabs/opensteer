import { pathToFileURL } from "node:url";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  replacePrivateFileAtomically,
  securePrivateDirectory,
} from "@opensteer/shared/atomicPrivateFile";
import { readBoundedRegularFile } from "@opensteer/shared/privateFiles";

const managedSecretNames = [
  "account-bundle.json",
  "browser-profile.key",
  "credential.key",
  "host-private.pem",
  "host-public.pem",
  "portablefs-ca.pem",
  "portablefs-client.pem",
  "portablefs-client-key.pem",
  "portablefs-product.pem",
] as const;
const maximumSecretBytes = 1024 * 1024;

export async function stageManagedSecrets(
  sourceDirectory = "/staged",
  destinationDirectory = "/run/opensteer",
): Promise<void> {
  await securePrivateDirectory(destinationDirectory);
  for (const name of managedSecretNames) {
    const sourcePath = await realpath(join(sourceDirectory, name));
    const content = await readBoundedRegularFile(sourcePath, maximumSecretBytes, {
      changedError: () => new Error(`Managed secret ${name} changed while being read`),
      invalidFileError: () => new Error(`Managed secret ${name} must be a regular file`),
      minimumBytes: 1,
      sizeError: () => new Error(`Managed secret ${name} exceeds the size limit`),
    });
    if (!content) throw new Error(`Managed secret ${name} is missing`);
    await replacePrivateFileAtomically(join(destinationDirectory, name), content.toString("utf8"));
  }
}

export async function main(arguments_: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (arguments_.length !== 0) {
    throw new Error("Usage: node dist/stage-managed-secrets-main.js");
  }
  await stageManagedSecrets();
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
