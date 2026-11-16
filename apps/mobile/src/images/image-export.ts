import { encodeBase64 } from "@opensteer/shared/base64url";
import * as Clipboard from "expo-clipboard";
import { File } from "expo-file-system";
import * as Haptics from "expo-haptics";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { Platform } from "react-native";
import { clipboardNeedsPng } from "./clipboard-format.js";

export { shareFileBytes } from "../platform/share-file-bytes.js";

export async function copyImageBytes(
  bytes: Uint8Array,
  mediaType: string,
  signal: AbortSignal,
): Promise<void> {
  let base64 = encodeBase64(bytes);
  if (!clipboardNeedsPng(mediaType, Platform.OS)) {
    try {
      await Clipboard.setImageAsync(base64);
      void Haptics.selectionAsync();
      return;
    } catch {
      signal.throwIfAborted();
    }
  }
  const context = ImageManipulator.manipulate(`data:${mediaType};base64,${base64}`);
  let rendered: Awaited<ReturnType<typeof context.renderAsync>> | undefined;
  let output: File | undefined;
  try {
    rendered = await context.renderAsync();
    const result = await rendered.saveAsync({ format: SaveFormat.PNG, base64: true });
    output = new File(result.uri);
    if (!result.base64) throw new Error("Image conversion failed.");
    base64 = result.base64;
  } finally {
    if (output?.exists) output.delete();
    rendered?.release();
    context.release();
  }
  signal.throwIfAborted();
  await Clipboard.setImageAsync(base64);
  void Haptics.selectionAsync();
}
