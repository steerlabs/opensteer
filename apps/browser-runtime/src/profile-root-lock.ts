import { closeSync, constants, openSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { securePrivateDirectory } from "@opensteer/shared/atomicPrivateFile";
import { noFollowFlag } from "@opensteer/shared/privateFiles";

/** Held outside logical runtime lifetimes, until every owned browser has closed. */
export async function acquireProfileRootLock(root: string): Promise<() => void> {
  await securePrivateDirectory(root);
  const descriptor = openSync(
    path.join(root, ".owner.lock"),
    constants.O_CREAT | constants.O_RDWR | noFollowFlag(),
    0o600,
  );
  try {
    // Keep resolution relative to the installed app; the prebuild stays external.
    const { tryLock } = createRequire(import.meta.url)("fs-native-extensions") as {
      tryLock(descriptor: number): boolean;
    };
    if (!tryLock(descriptor))
      throw new Error("This local browser profile storage is already in use.");
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    closeSync(descriptor);
  };
}
