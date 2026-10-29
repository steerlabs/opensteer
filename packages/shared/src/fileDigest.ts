import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { noFollowFlag } from "./privateFiles.js";

/** Stream large build inputs without retaining compiler/SDK bytes in memory. */
export async function sha256File(filename: string, signal?: AbortSignal): Promise<string> {
  const digest = createHash("sha256");
  const handle = await open(filename, constants.O_RDONLY | noFollowFlag());
  const input = handle.createReadStream({
    autoClose: false,
    ...(signal ? { signal } : {}),
  });
  try {
    for await (const chunk of input) digest.update(chunk);
    return digest.digest("hex");
  } finally {
    input.destroy();
    await handle.close();
  }
}
