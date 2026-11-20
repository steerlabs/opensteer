import {
  standardCdpBufferedMaxBytes,
  standardCdpChunkBytes,
  standardCdpMaxPending,
  standardCdpMessageMaxBytes,
  type StandardCdpChunk,
} from "./standard-cdp.js";

export class RawCdpChunks {
  #bytes = 0;
  readonly #parts: Buffer[] = [];

  read(chunk: StandardCdpChunk): Buffer | undefined {
    const part = Buffer.from(chunk.data, "base64");
    if (
      part.length === 0 ||
      part.length > standardCdpChunkBytes ||
      (!chunk.last && part.length !== standardCdpChunkBytes) ||
      this.#bytes + part.length > standardCdpMessageMaxBytes
    )
      throw new Error("Invalid raw CDP frame size.");
    this.#parts.push(part);
    this.#bytes += part.length;
    if (!chunk.last) return undefined;
    const frame = Buffer.concat(this.#parts, this.#bytes);
    this.#parts.length = 0;
    this.#bytes = 0;
    return frame;
  }
}

export class RawCdpWriter {
  #bytes = 0;
  #count = 0;
  #tail = Promise.resolve();
  #closed = false;
  readonly #write: (chunk: StandardCdpChunk) => Promise<void>;

  constructor(write: (chunk: StandardCdpChunk) => Promise<void>) {
    this.#write = write;
  }

  send(frame: Buffer): Promise<void> {
    if (
      this.#closed ||
      frame.length === 0 ||
      frame.length > standardCdpMessageMaxBytes ||
      this.#bytes + frame.length > standardCdpBufferedMaxBytes ||
      this.#count >= standardCdpMaxPending
    )
      return Promise.reject(new Error("Raw CDP relay is overloaded."));
    this.#bytes += frame.length;
    this.#count++;
    const work = this.#tail
      .then(async () => {
        for (let offset = 0; offset < frame.length; offset += standardCdpChunkBytes) {
          if (this.#closed) throw new Error("Raw CDP relay closed.");
          const end = Math.min(offset + standardCdpChunkBytes, frame.length);
          await this.#write({
            type: "cdp.raw",
            data: frame.subarray(offset, end).toString("base64"),
            last: end === frame.length,
          });
        }
      })
      .finally(() => {
        this.#bytes -= frame.length;
        this.#count--;
      });
    this.#tail = work.catch(() => this.close());
    return work;
  }

  close(): void {
    this.#closed = true;
  }
}
