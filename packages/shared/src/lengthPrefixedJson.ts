/**
 * JSON over a byte stream: a 4-byte big-endian length, then that many bytes of
 * UTF-8 JSON. The computer use helper socket and the shell helper's init frame
 * both speak it, and their native ends read exactly this layout.
 */

const headerBytes = 4;

export function encodeLengthPrefixedJson(value: unknown, maxBodyBytes: number): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.byteLength > maxBodyBytes) {
    throw new Error(`A length-prefixed JSON frame exceeds ${maxBodyBytes} bytes`);
  }
  const header = Buffer.alloc(headerBytes);
  header.writeUInt32BE(body.byteLength, 0);
  return Buffer.concat([header, body]);
}

/**
 * Reassembles frames from arbitrary chunks.
 *
 * The announced length is checked before anything is buffered for it — a
 * reader that trusted an attacker-sized header would allocate whatever it was
 * told to — and the JSON is never parsed before its whole body has arrived, so
 * a partial frame is a partial read rather than a partial object.
 */
export class LengthPrefixedFrameReader {
  readonly #maxBodyBytes: number;
  #buffer: Buffer = Buffer.alloc(0);

  constructor(maxBodyBytes: number) {
    this.#maxBodyBytes = maxBodyBytes;
  }

  /** Every whole frame this chunk completed, in order. */
  push(chunk: Buffer): Buffer[] {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const frames: Buffer[] = [];
    for (;;) {
      if (this.#buffer.length < headerBytes) return frames;
      const length = this.#buffer.readUInt32BE(0);
      if (length > this.#maxBodyBytes) {
        throw new Error(`A length-prefixed JSON frame exceeds ${this.#maxBodyBytes} bytes`);
      }
      if (this.#buffer.length < headerBytes + length) return frames;
      const body = this.#buffer.subarray(headerBytes, headerBytes + length);
      this.#buffer = this.#buffer.subarray(headerBytes + length);
      frames.push(body);
    }
  }
}

/** JSON control messages use the same bounded byte framing as media attachments. */
export class LengthPrefixedJsonReader {
  readonly #frames: LengthPrefixedFrameReader;
  constructor(maxBodyBytes: number) {
    this.#frames = new LengthPrefixedFrameReader(maxBodyBytes);
  }
  push(chunk: Buffer): unknown[] {
    return this.#frames.push(chunk).map((body) => JSON.parse(body.toString("utf8")));
  }
}
