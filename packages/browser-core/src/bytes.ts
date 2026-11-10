export function utf8Size(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes++;
    else if (code < 0x800) bytes += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

export function encodeFrameEnvelope(header: unknown, payload: Uint8Array): Uint8Array {
  const encoded = new TextEncoder().encode(JSON.stringify(header));
  const output = new Uint8Array(4 + encoded.byteLength + payload.byteLength);
  new DataView(output.buffer).setUint32(0, encoded.byteLength);
  output.set(encoded, 4);
  output.set(payload, 4 + encoded.byteLength);
  return output;
}

export function decodeFrameEnvelope(value: Uint8Array): {
  readonly header: unknown;
  readonly payload: Uint8Array;
} {
  if (value.byteLength < 7) throw new Error("The binary browser frame is invalid.");
  const length = new DataView(value.buffer, value.byteOffset, value.byteLength).getUint32(0);
  if (length < 2 || length > 16_384 || 4 + length >= value.byteLength)
    throw new Error("The binary browser frame is invalid.");
  return {
    header: JSON.parse(
      new TextDecoder("utf-8", { ignoreBOM: true }).decode(value.subarray(4, 4 + length)),
    ) as unknown,
    payload: value.subarray(4 + length),
  };
}
