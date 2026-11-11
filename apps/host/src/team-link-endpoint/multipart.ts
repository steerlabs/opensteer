import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import type { TeamBinaryUploadMetadataSchema } from "@opensteer/protocol";
import type { z } from "zod";
import { linkError } from "./contracts.js";

export interface TeamUploadPart {
  readonly name: "original" | "preview";
  readonly bytes: AsyncIterable<Uint8Array>;
}

/** Metadata fixes part lengths; binary contents never need an unbounded boundary search. */
export function teamUploadParts(
  source: Readable,
  contentType: string,
  metadata: z.infer<typeof TeamBinaryUploadMetadataSchema>,
  signal: AbortSignal,
) {
  const match = /^multipart\/form-data; boundary=([A-Za-z0-9'()+_,./:=?-]{1,70})$/.exec(
    contentType,
  );
  if (!match) throw linkError("bad_request");
  const boundary = match[1]!;
  let complete = false;
  const parts: AsyncIterable<TeamUploadPart> = (async function* () {
    const input = source[Symbol.asyncIterator]();
    let buffer = Buffer.alloc(0);
    let ended = false;
    const fill = async () => {
      signal.throwIfAborted();
      const next = await input.next();
      if (next.done) ended = true;
      else buffer = Buffer.concat([buffer, Buffer.from(next.value)]);
    };
    const exact = async (expected: string) => {
      const bytes = Buffer.from(expected);
      while (buffer.length < bytes.length && !ended) await fill();
      if (!buffer.subarray(0, bytes.length).equals(bytes)) throw linkError("bad_request");
      buffer = buffer.subarray(bytes.length);
    };
    const seen = new Set<string>();
    try {
      await exact(`--${boundary}\r\n`);
      for (;;) {
        while (buffer.indexOf("\r\n\r\n") < 0 && !ended) {
          if (buffer.length > 8192) throw linkError("bad_request");
          await fill();
        }
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0 || end > 8192) throw linkError("bad_request");
        const header = buffer.subarray(0, end).toString("latin1");
        buffer = buffer.subarray(end + 4);
        const disposition = header
          .split("\r\n")
          .filter((line) => /^content-disposition:/i.test(line));
        const nameMatch =
          disposition.length === 1
            ? /^content-disposition: form-data; name="(original|preview)"(?:; filename="[^"\r\n]{0,255}")?$/i.exec(
                disposition[0]!,
              )
            : null;
        const name = nameMatch?.[1] as TeamUploadPart["name"] | undefined;
        if (!name || seen.has(name) || (name === "preview" && metadata.previewSizeBytes === 0))
          throw linkError("bad_request");
        seen.add(name);
        let remaining = name === "original" ? metadata.sizeBytes : metadata.previewSizeBytes;
        let consumed = false;
        const hash = createHash("sha256");
        const bytes = (async function* () {
          while (remaining > 0) {
            signal.throwIfAborted();
            while (!buffer.length && !ended) await fill();
            if (!buffer.length) throw linkError("bad_request");
            const size = Math.min(remaining, buffer.length, 64 * 1024);
            const chunk = buffer.subarray(0, size);
            hash.update(chunk);
            remaining -= size;
            buffer = buffer.subarray(size);
            yield chunk;
          }
          if (name === "original" && hash.digest("hex") !== metadata.sha256)
            throw linkError("bad_request");
          consumed = true;
        })();
        yield { name, bytes };
        if (!consumed) throw linkError("bad_request");
        await exact(`\r\n--${boundary}`);
        while (buffer.length < 2 && !ended) await fill();
        if (buffer.subarray(0, 2).equals(Buffer.from("--"))) {
          buffer = buffer.subarray(2);
          while (!ended) {
            if (buffer.length > 2) throw linkError("bad_request");
            await fill();
          }
          if (buffer.length && !buffer.equals(Buffer.from("\r\n"))) throw linkError("bad_request");
          if (!seen.has("original") || (metadata.previewSizeBytes > 0 && !seen.has("preview")))
            throw linkError("bad_request");
          complete = true;
          return;
        }
        await exact("\r\n");
      }
    } finally {
      await input.return?.();
      source.destroy();
    }
  })();
  return {
    parts,
    get complete() {
      return complete;
    },
  };
}
