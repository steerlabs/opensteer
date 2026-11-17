import type { TeamSessionClient } from "@opensteer/client/team";
import type { TeamMessage } from "@opensteer/protocol";
import type { ImageActionsSource } from "../images/image-actions.js";
import { shareFileBytes } from "../platform/share-file-bytes.js";
import { dataUri } from "./team-context.js";

export function teamImageSource(
  session: TeamSessionClient,
  file: TeamMessage["attachments"][number],
): ImageActionsSource {
  return {
    signal: session.signal ?? session.owner?.signal,
    name: file.filename,
    read: (signal) => readTeamFile(session, file, signal),
  };
}

async function readTeamFile(
  session: TeamSessionClient,
  file: TeamMessage["attachments"][number],
  actionSignal?: AbortSignal,
) {
  const ownerSignal = session.signal ?? session.owner?.signal;
  const signal =
    actionSignal && ownerSignal
      ? AbortSignal.any([actionSignal, ownerSignal])
      : (actionSignal ?? ownerSignal);
  const blob = await session.file(file, true, signal);
  if (blob === null) throw new Error(`${file.filename} isn't available to you any more.`);
  const uri = await dataUri(blob, signal);
  signal?.throwIfAborted();
  return { bytes: base64Bytes(uri.slice(uri.indexOf(",") + 1)), mediaType: file.mediaType };
}

export async function shareTeamFile(
  session: TeamSessionClient,
  file: TeamMessage["attachments"][number],
): Promise<void> {
  const { bytes, mediaType } = await readTeamFile(session, file);
  await shareFileBytes(bytes, file.filename, mediaType, session.signal ?? session.owner?.signal);
}
function base64Bytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
