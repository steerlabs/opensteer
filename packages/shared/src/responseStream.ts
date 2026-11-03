import { forEachBoundedResponseChunk, type BoundedResponseOptions } from "./boundedJson.js";

/** Relays a response with backpressure; cancellation also interrupts a silent upstream read. */
export function streamBoundedResponse(
  response: Response,
  options: BoundedResponseOptions,
): {
  readonly body: ReadableStream<Uint8Array>;
  readonly done: Promise<void>;
} {
  const canceled = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, canceled.signal])
    : canceled.signal;
  const channel = new TransformStream<Uint8Array, Uint8Array>();
  const writer = channel.writable.getWriter();
  void writer.closed.catch((reason) => canceled.abort(reason));
  const abort = () => {
    void writer.abort(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const done = (async () => {
    try {
      await forEachBoundedResponseChunk(response, { ...options, signal }, (chunk) =>
        writer.write(chunk),
      );
      await writer.close();
    } catch (error) {
      await writer.abort(error).catch(() => undefined);
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      writer.releaseLock();
    }
  })();
  return { body: channel.readable, done };
}
