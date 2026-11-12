import { teamPreviewMaxBytes, teamUploadMaxBytes } from "@opensteer/protocol";
import type { TeamFileUpload } from "@opensteer/client/team";

const previewEdges = [480, 320, 200] as const;
const previewTypes = ["image/webp", "image/jpeg"] as const;

/**
 * A small preview of an image, made here before upload so a channel shows
 * images without fetching originals: at most 64 KiB, or none when the
 * browser cannot draw the file.
 */
export async function imagePreview(file: Blob): Promise<Blob | null> {
  if (!file.type.startsWith("image/") || typeof createImageBitmap !== "function") return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  try {
    for (const edge of previewEdges) {
      const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const type of previewTypes)
        for (const quality of [0.8, 0.6, 0.4]) {
          const blob = await new Promise<Blob | null>((resolve) =>
            canvas.toBlob(resolve, type, quality),
          );
          if (blob && blob.type === type && blob.size > 0 && blob.size <= teamPreviewMaxBytes)
            return blob;
        }
    }
    return null;
  } finally {
    bitmap.close();
  }
}

async function sha256(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** One file ready to post: its bytes, its preview and the metadata the team checks them against. */
export async function prepareTeamUpload(
  channelId: TeamFileUpload["channelId"],
  file: File,
  signal?: AbortSignal,
): Promise<TeamFileUpload> {
  if (file.size === 0) throw new Error("This file is empty.");
  if (file.size > teamUploadMaxBytes) throw new Error("Files can be up to 100 MB.");
  const [hash, preview] = await Promise.all([sha256(file), imagePreview(file)]);
  return {
    channelId,
    original: file,
    preview,
    metadata: {
      clientUploadId: crypto.randomUUID(),
      filename: file.name.slice(0, 255) || "file",
      mediaType: file.type || "application/octet-stream",
      sizeBytes: file.size,
      sha256: hash,
      previewSizeBytes: preview?.size ?? 0,
    },
    ...(signal ? { signal } : {}),
  };
}
