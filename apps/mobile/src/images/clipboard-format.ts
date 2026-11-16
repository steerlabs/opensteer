// Android exports unknown image signatures as JPEG, which loses transparency.
export function clipboardNeedsPng(mediaType: string, platform: string): boolean {
  const type = mediaType.split(";")[0]?.trim().toLowerCase();
  return platform !== "ios" && type !== "image/png" && type !== "image/jpeg";
}
