import { File } from "expo-file-system";

/** Deletes a pasted image's temporary file once nothing will read it. */
export function discardPastedImage(uri: string): void {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // Already gone: the system may clear temporary files at any time.
  }
}
