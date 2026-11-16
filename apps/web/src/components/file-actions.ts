/**
 * How long a download's object URL outlives the click. The browser copies the
 * bytes when it starts the download, but not synchronously in every engine.
 */
const downloadUrlLifetimeMs = 30_000;

/** Saves bytes as a file, never opened in place: an opaque type keeps the browser from rendering them. */
export function saveFile(bytes: Blob | Uint8Array<ArrayBuffer>, name: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), downloadUrlLifetimeMs);
}

/** A page reached over plain HTTP has no clipboard API, so it can only save an image. */
export function canCopyImages(): boolean {
  return typeof ClipboardItem === "function" && typeof navigator.clipboard?.write === "function";
}

/**
 * Copies an image as PNG, the one image type every clipboard takes. It must
 * be called within the click: the bytes are handed over as a promise so the
 * browser keeps the gesture while they arrive.
 */
export function copyImage(read: () => Promise<Blob>): Promise<void> {
  return navigator.clipboard.write([new ClipboardItem({ "image/png": read().then(asPng) })]);
}

async function asPng(image: Blob): Promise<Blob> {
  if (image.type === "image/png") return image;
  const bitmap = await createImageBitmap(image);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (png) => (png ? resolve(png) : reject(new Error("The image couldn't be converted."))),
        "image/png",
      ),
    );
  } finally {
    bitmap.close();
  }
}
