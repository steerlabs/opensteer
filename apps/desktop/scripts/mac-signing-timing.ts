import { setPrivateFileMode } from "@opensteer/shared/privateFiles";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Add per-file wall/CPU observations without replacing the stock signer or
 * its retry, entitlements, hardened-runtime and timestamp configuration. */
export async function withMacSigningTimings<T>(
  environment: NodeJS.ProcessEnv,
  root: string,
  work: (environment: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  if (!environment.OPENSTEER_RELEASE_TIMING_FILE || environment.OPENSTEER_MAC_SIGN_TIMINGS !== "1")
    return work(environment);
  const directory = await mkdtemp(path.join(tmpdir(), "opensteer-codesign-timing-"));
  try {
    const shim = path.join(directory, "codesign");
    await copyFile(fileURLToPath(new URL("./codesign-timing.cjs", import.meta.url)), shim);
    await setPrivateFileMode(shim, 0o700);
    return await work({
      ...environment,
      PATH: directory + path.delimiter + (environment.PATH ?? "/usr/bin:/bin"),
      OPENSTEER_CODESIGN_TIMING_ROOT: root,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
