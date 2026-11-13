import type { TeamSessionClient } from "@opensteer/client/team";
import type { TeamMessage } from "@opensteer/protocol";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { dataUri } from "./team-context.js";

export async function shareTeamFile(
  session: TeamSessionClient,
  file: TeamMessage["attachments"][number],
): Promise<void> {
  const signal = session.signal ?? session.owner?.signal;
  const blob = await session.file(file, true);
  if (blob === null) throw new Error(`${file.filename} isn't available to you any more.`);
  const uri = await dataUri(blob, signal);
  signal?.throwIfAborted();
  const target = new File(
    Paths.cache,
    `team-${globalThis.crypto.randomUUID()}-${file.id}-${file.filename.replace(/[^\w.-]+/g, "_")}`,
  );
  const cleanup = () => {
    if (target.exists) target.delete();
  };
  signal?.addEventListener("abort", cleanup, { once: true });
  try {
    cleanup();
    target.create();
    await target.write(base64Bytes(uri.slice(uri.indexOf(",") + 1)));
    signal?.throwIfAborted();
    await Sharing.shareAsync(target.uri, { mimeType: file.mediaType, dialogTitle: file.filename });
  } finally {
    signal?.removeEventListener("abort", cleanup);
    cleanup();
  }
}
function base64Bytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
