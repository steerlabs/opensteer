/** Bound Host JSON before decoding, including chunked responses. */
export async function readHostJson(
  response: Response,
  options: { maximumBytes: number },
): Promise<unknown> {
  if (response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
    throw new Error("Unexpected response.");
  }
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    (!/^(?:0|[1-9][0-9]*)$/u.test(length) || Number(length) > options.maximumBytes)
  ) {
    await response.body?.cancel();
    throw new Error("Response too large.");
  }
  if (!response.body) throw new Error("Empty response.");
  let size = 0;
  const limited = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > options.maximumBytes) throw new Error("Response too large.");
        controller.enqueue(chunk);
      },
    }),
  );
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(await new Response(limited).arrayBuffer()),
  );
}
