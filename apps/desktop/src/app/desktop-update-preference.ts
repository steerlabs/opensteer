import { readFile } from "node:fs/promises";
import path from "node:path";
import { DesktopUpdateChannelSchema, type DesktopUpdateChannel } from "@opensteer/protocol/desktop";
import {
  replacePrivateFileAtomically,
  securePrivateDirectory,
} from "@opensteer/shared/atomicPrivateFile";
import { isNodeError } from "@opensteer/shared/nodeError";
import { z } from "zod";
import type { ShutdownLog } from "./desktop-shutdown.js";

const PreferenceSchema = z.strictObject({ channel: DesktopUpdateChannelSchema });

export async function loadDesktopUpdatePreference(dataDirectory: string, log: ShutdownLog) {
  const file = path.join(dataDirectory, "update-channel.json");
  let channel: DesktopUpdateChannel = "stable";
  try {
    const parsed = PreferenceSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
    if (parsed.success) channel = parsed.data.channel;
    else log("desktop.update.preference-defaulted", { reason: "invalid" });
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT")
      log("desktop.update.preference-defaulted", {
        reason: error instanceof SyntaxError ? "corrupt" : "unreadable",
      });
  }
  return {
    channel,
    async save(value: DesktopUpdateChannel): Promise<void> {
      const next = PreferenceSchema.parse({ channel: value });
      await securePrivateDirectory(dataDirectory);
      await replacePrivateFileAtomically(file, `${JSON.stringify(next)}\n`);
    },
  };
}
