import { setPrivateDirectoryMode, setPrivateHandleMode } from "@opensteer/shared/privateFiles";
import { noFollowFlag } from "@opensteer/shared/privateFiles";
import { isNodeError } from "@opensteer/shared/nodeError";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { HostInstanceIdSchema, createId, type HostInstanceId } from "@opensteer/core";
import { z } from "zod";

const maximumHostInstanceFileBytes = 4_096;

const HostInstanceFileSchema = z.strictObject({
  hostInstanceId: HostInstanceIdSchema,
  schemaVersion: z.literal(1),
});

interface HostInstanceIdentity {
  readonly hostInstanceId: HostInstanceId;
  readonly path: string;
}

/**
 * Loads the identity of this Host installation. This file is intentionally
 * outside PostgreSQL: a Deployment export moves the database, but the target
 * installation must receive a new Host instance identity.
 */
export async function loadOrCreateHostInstance(
  dataDirectory: string,
  expectedHostInstanceId?: HostInstanceId,
): Promise<HostInstanceIdentity> {
  const path = resolve(dataDirectory, "host-instance.json");
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  await setPrivateDirectoryMode(dirname(path));
  const candidate = HostInstanceFileSchema.parse({
    hostInstanceId: expectedHostInstanceId ?? createId("hostInstance"),
    schemaVersion: 1,
  });
  try {
    await writeFile(path, `${JSON.stringify(candidate)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!(isNodeError(error) && error.code === "EEXIST")) throw error;
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY | noFollowFlag() | fsConstants.O_NONBLOCK);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximumHostInstanceFileBytes) {
      throw new Error("Host instance identity file is invalid");
    }
    const parsed: unknown = JSON.parse(await handle.readFile("utf8"));
    const identity = HostInstanceFileSchema.parse(parsed);
    if (
      expectedHostInstanceId !== undefined &&
      identity.hostInstanceId !== expectedHostInstanceId
    ) {
      throw new Error("Host instance identity does not match the managed provisioning bundle");
    }
    await setPrivateHandleMode(handle, 0o600);
    return { hostInstanceId: identity.hostInstanceId, path };
  } catch (error) {
    throw new Error(`Unable to load Host instance identity at ${path}`, { cause: error });
  } finally {
    await handle?.close();
  }
}
