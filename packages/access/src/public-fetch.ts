import { request as httpsRequest, type RequestOptions } from "node:https";
import { Readable } from "node:stream";
import { OpensteerError } from "@opensteer/core";
import { resolvePublicAddress, tlsServerName } from "./public-network.js";

const forbiddenRequestHeaders = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const forbiddenResponseHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * A Fetch implementation for trusted remote connectors. DNS is resolved and
 * checked by Opensteer, then the TCP connection is pinned to that exact public
 * address. Redirects are intentionally returned, never followed, so configured
 * headers cannot cross an origin boundary.
 */
export function createPublicHttpsFetch(
  options: {
    readonly maxRequestBytes?: number;
    readonly maxResponseBytes?: number;
    readonly timeoutMs?: number;
  } = {},
): typeof fetch {
  const maxRequestBytes = positiveInteger(options.maxRequestBytes ?? 8 * 1_024 * 1_024);
  const maxResponseBytes = positiveInteger(options.maxResponseBytes ?? 16 * 1_024 * 1_024);
  const timeoutMs = positiveInteger(options.timeoutMs ?? 60_000);
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      request.redirect !== "manual"
    ) {
      throw denied("Connector requests require uncredentialed HTTPS and redirect: manual");
    }
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? Buffer.alloc(0)
        : Buffer.from(await request.arrayBuffer());
    if (body.byteLength > maxRequestBytes)
      throw denied("Connector request exceeded its byte limit");
    const address = await resolvePublicAddress(url.hostname);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      if (!forbiddenRequestHeaders.has(name.toLowerCase())) headers[name.toLowerCase()] = value;
    });
    headers.host = url.host;
    headers["accept-encoding"] = "identity";
    if (body.byteLength > 0) headers["content-length"] = String(body.byteLength);
    const servername = tlsServerName(url.hostname);
    const requestOptions: RequestOptions = {
      family: address.family,
      headers,
      hostname: address.address,
      method: request.method,
      path: `${url.pathname}${url.search}`,
      port: url.port || 443,
      ...(servername ? { servername } : {}),
    };
    return new Promise<Response>((resolveResponse, reject) => {
      let responseStarted = false;
      const outgoing = httpsRequest(requestOptions, (incoming) => {
        responseStarted = true;
        if (!incoming.statusCode) {
          incoming.destroy();
          reject(denied("Connector returned no HTTP status"));
          return;
        }
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value === undefined || forbiddenResponseHeaders.has(name.toLowerCase())) continue;
          for (const item of typeof value === "string" ? [value] : value) {
            responseHeaders.append(name, String(item));
          }
        }
        const bodyForbidden =
          request.method === "HEAD" || [204, 205, 304].includes(incoming.statusCode);
        if (bodyForbidden) incoming.resume();
        const source = bodyForbidden
          ? null
          : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>);
        resolveResponse(
          new Response(source ? limitResponse(source, maxResponseBytes) : null, {
            headers: responseHeaders,
            status: incoming.statusCode,
            ...(incoming.statusMessage ? { statusText: incoming.statusMessage } : {}),
          }),
        );
      });
      const deadline = setTimeout(
        () => outgoing.destroy(new Error("Connector request timed out")),
        timeoutMs,
      );
      deadline.unref();
      const abort = () => outgoing.destroy(request.signal.reason as Error | undefined);
      request.signal.addEventListener("abort", abort, { once: true });
      outgoing.once("error", (error) => {
        clearTimeout(deadline);
        request.signal.removeEventListener("abort", abort);
        if (!responseStarted) reject(error);
      });
      outgoing.once("close", () => {
        clearTimeout(deadline);
        request.signal.removeEventListener("abort", abort);
      });
      outgoing.end(body);
    });
  }) as typeof fetch;
}

function limitResponse(
  source: ReadableStream<Uint8Array>,
  maximumBytes: number,
): ReadableStream<Uint8Array> {
  let total = 0;
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > maximumBytes) {
          controller.error(denied("Connector response exceeded its byte limit"));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

function positiveInteger(value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new TypeError("Expected a positive integer");
  return value;
}

function denied(message: string): OpensteerError {
  return new OpensteerError({ code: "forbidden", message });
}
