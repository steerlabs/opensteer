const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function readPngSize(bytes: Uint8Array): {
  readonly width: number;
  readonly height: number;
} {
  if (bytes.byteLength < 24) {
    throw new Error("PNG payload is too small to contain an IHDR chunk");
  }
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (bytes[index] !== PNG_SIGNATURE[index]) {
      throw new Error("PNG payload did not start with the PNG file signature");
    }
  }

  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ihdrLength = buffer.readUInt32BE(8);
  const ihdrType = buffer.toString("ascii", 12, 16);
  if (ihdrType !== "IHDR" || ihdrLength < 8) {
    throw new Error("PNG payload did not contain a valid IHDR chunk");
  }

  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}
