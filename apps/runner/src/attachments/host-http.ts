import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { runnerHttpTransport, type RunnerTransportPolicy } from "@opensteer/runner-client";

export async function runnerFileRequest(
  transport: RunnerTransportPolicy,
  path: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  upload?: AsyncIterable<Uint8Array>,
): Promise<IncomingMessage> {
  const { url, ca } = await runnerHttpTransport(transport, path);
  signal.throwIfAborted();
  return await new Promise<IncomingMessage>((resolve, reject) => {
    const options = { ca, headers, signal, method: upload ? "PUT" : "GET" };
    let sent: Promise<void> = Promise.resolve();
    const received = (response: IncomingMessage): void => {
      void sent.then(
        () => resolve(response),
        (error: unknown) => {
          response.destroy();
          reject(error);
        },
      );
    };
    const request =
      url.protocol === "https:"
        ? httpsRequest(url, options, received)
        : httpRequest(url, options, received);
    request.once("error", reject);
    if (upload) {
      sent = pipeline(Readable.from(upload), request, { signal });
      void sent.catch(reject);
    } else request.end();
  });
}
