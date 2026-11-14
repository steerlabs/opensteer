import { imagePathMaxLength, type ToolOutputImage } from "@opensteer/core";

/** Native engines save the bytes; only their bounded file reference crosses events. */
export function generatedImage(path: unknown): ToolOutputImage[] {
  if (typeof path !== "string" || !path.trim() || path.length > imagePathMaxLength) return [];
  const extension = path.split(".").at(-1)?.toLowerCase();
  const mediaType =
    extension === "jpg" || extension === "jpeg"
      ? "image/jpeg"
      : extension === "webp"
        ? "image/webp"
        : extension === "gif"
          ? "image/gif"
          : extension === "avif"
            ? "image/avif"
            : extension === "svg"
              ? "image/svg+xml"
              : "image/png";
  return [{ path, mediaType, generated: true }];
}
