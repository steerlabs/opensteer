import { randomUUID } from "expo-crypto";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";

/** Bytes handed to the share sheet through a private copy that is erased once it returns. */
export async function shareFileBytes(
  bytes: Uint8Array,
  name: string,
  mediaType: string,
  signal?: AbortSignal,
): Promise<void> {
  const safeName = name.replace(/[\\/\p{Cc}]/gu, "_").slice(0, 160) || "attachment";
  const file = new File(Paths.cache, `${randomUUID()}-${safeName}`);
  const cleanup = () => {
    if (file.exists) file.delete();
  };
  signal?.throwIfAborted();
  signal?.addEventListener("abort", cleanup, { once: true });
  try {
    await file.write(bytes);
    signal?.throwIfAborted();
    await Sharing.shareAsync(file.uri, { mimeType: mediaType || "application/octet-stream" });
  } finally {
    signal?.removeEventListener("abort", cleanup);
    cleanup();
  }
}
