import { isCanonicalEd25519SshPublicKey, type RunnerShellModule } from "@opensteer/protocol";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { probeFullDiskAccess } from "./full-disk-access.js";

const executeFile = promisify(execFile);

export interface PreparedShellModule {
  readonly descriptor: RunnerShellModule;
  readonly helperBinary: string;
  readonly hostKeyPath: string;
}

export async function prepareShellModule(options: {
  readonly dataDirectory: string;
  readonly helperBinary: string;
  readonly platform?: NodeJS.Platform;
  readonly probeFullDiskAccess?: (binary: string) => Promise<boolean>;
  readonly runKeygen?: (binary: string, directory: string) => Promise<string>;
}): Promise<PreparedShellModule | undefined> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") return undefined;
  const helperBinary = resolve(options.helperBinary);
  try {
    await access(helperBinary, constants.X_OK);
  } catch {
    return undefined;
  }

  const dataDirectory = resolve(options.dataDirectory);
  const hostKeyPath = join(dataDirectory, "shell_host_ed25519");
  const publicKey = (
    await (options.runKeygen ?? runShellKeygen)(helperBinary, dataDirectory)
  ).trim();
  if (!isCanonicalEd25519SshPublicKey(publicKey)) {
    throw new Error("The native filesystem helper produced an invalid shell host public key");
  }
  // The grant is a macOS fact and macOS offers no API for it, so the answer is
  // probed once here and restated on the connection whenever it changes. Linux
  // has no such gate, and a key absent from the descriptor is how the Host
  // tells "no gate exists" apart from "the gate is closed".
  const fullDiskAccess =
    platform === "darwin"
      ? await (options.probeFullDiskAccess ?? probeFullDiskAccess)(helperBinary)
      : undefined;
  return {
    descriptor: {
      ...(fullDiskAccess === undefined ? {} : { fullDiskAccess }),
      hostPublicKey: publicKey,
      platform,
    },
    helperBinary,
    hostKeyPath,
  };
}

async function runShellKeygen(binary: string, directory: string): Promise<string> {
  const result = await executeFile(binary, ["shell-keygen", "--out", directory], {
    encoding: "utf8",
    maxBuffer: 16 * 1_024,
    timeout: 15_000,
  });
  const stdout = result.stdout.trim();
  if (!stdout) {
    throw new Error("The native filesystem helper did not print its shell host public key");
  }
  return stdout;
}
