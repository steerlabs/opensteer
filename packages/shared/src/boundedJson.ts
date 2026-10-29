/** Bounded HTTP response decoding. */

export interface BoundedResponseOptions {
  readonly abortError?: () => Error;
  readonly emptyError?: () => Error;
  readonly invalidContentLengthError?: () => Error;
  readonly maximumBytes: number;
  readonly signal?: AbortSignal;
  readonly sizeError?: () => Error;
}

interface BoundedJsonOptions extends BoundedResponseOptions {
  readonly emptyValue?: unknown;
  readonly expectedContentType?: string;
  readonly fatalUtf8?: boolean;
  readonly invalidJsonError?: (cause: unknown) => Error;
  readonly unexpectedContentTypeError?: () => Error;
}

/**
 * Keeps byte-reader dependencies inside one closure so privileged browser worlds
 * can serialize the same bounded reader without copying its limits or cleanup.
 */
export function createBoundedResponseReader() {
  async function readBoundedResponse(
    response: Response,
    options: BoundedResponseOptions,
  ): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    const total = await forEachBoundedResponseChunk(response, options, (chunk) => {
      chunks.push(chunk);
    });
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  /** Streams a bounded HTTP body to a caller-owned sink without buffering it. */
  async function forEachBoundedResponseChunk(
    response: Response,
    options: BoundedResponseOptions,
    consume: (chunk: Uint8Array) => void | Promise<void>,
  ): Promise<number> {
    const sizeError = options.sizeError ?? (() => new Error("Response exceeded its size limit"));
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && !/^(?:0|[1-9][0-9]*)$/u.test(declaredLength)) {
      await response.body?.cancel();
      throw options.invalidContentLengthError?.() ?? sizeError();
    }
    if (declaredLength !== null && Number(declaredLength) > options.maximumBytes) {
      await response.body?.cancel();
      throw sizeError();
    }
    const body = response.body;
    if (!body) {
      if (options.emptyError) throw options.emptyError();
      return 0;
    }
    const reader = body.getReader();
    let total = 0;
    try {
      while (true) {
        const result = await readChunk(reader, options.signal, options.abortError);
        if (result.done) break;
        total += result.value.byteLength;
        if (total > options.maximumBytes) {
          await reader.cancel();
          throw sizeError();
        }
        await consume(result.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
    return total;
  }

  async function readChunk(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal?: AbortSignal,
    abortError?: () => Error,
  ): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>> {
    if (!signal) return reader.read();
    const reason = () =>
      signal.reason instanceof Error
        ? signal.reason
        : (abortError?.() ?? new Error("Request aborted"));
    if (signal.aborted) throw reason();
    return new Promise((resolvePromise, rejectPromise) => {
      const aborted = () => {
        void reader.cancel().catch(() => undefined);
        rejectPromise(reason());
      };
      signal.addEventListener("abort", aborted, { once: true });
      void reader
        .read()
        .then(resolvePromise, rejectPromise)
        .finally(() => {
          signal.removeEventListener("abort", aborted);
        });
    });
  }
  return { readBoundedResponse, forEachBoundedResponseChunk };
}

export const { readBoundedResponse, forEachBoundedResponseChunk } = createBoundedResponseReader();

export async function readBoundedText(
  response: Response,
  options: BoundedResponseOptions & { readonly fatalUtf8?: boolean },
): Promise<string> {
  const bytes = await readBoundedResponse(response, options);
  return new TextDecoder("utf-8", { fatal: options.fatalUtf8 ?? false }).decode(bytes);
}

export async function readBoundedJson(
  response: Response,
  options: BoundedJsonOptions,
): Promise<unknown> {
  if (options.expectedContentType) {
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (contentType !== options.expectedContentType) {
      throw options.unexpectedContentTypeError?.() ?? new Error("Response content type is invalid");
    }
  }
  if (!response.body && "emptyValue" in options) return options.emptyValue;
  const bytes = await readBoundedResponse(response, options);
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: options.fatalUtf8 ?? true }).decode(bytes),
    ) as unknown;
  } catch (error) {
    throw options.invalidJsonError?.(error) ?? error;
  }
}
