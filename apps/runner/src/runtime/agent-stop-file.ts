import { readFileSync } from "node:fs";
import { nodeErrorCode } from "@opensteer/shared/nodeError";
import { z } from "zod";

const StoredStopSchema = z.object({ stopped: z.boolean() });

/**
 * Whether the person stopped agents on this computer, as the app that started
 * this Runner saved it. Read at each admission, so Resume holds from the next
 * one. No file is not stopped; a file that cannot be read or understood is,
 * because a Stop the person pressed must never be lost to a bad read.
 */
export function agentStopFile(path: string): () => boolean {
  return () => {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      return nodeErrorCode(error) !== "ENOENT";
    }
    try {
      return StoredStopSchema.parse(JSON.parse(text)).stopped;
    } catch {
      return true;
    }
  };
}
