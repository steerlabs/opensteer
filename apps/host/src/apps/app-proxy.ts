import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { Readable, Transform, type Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";
import { appMaxBytes, refused } from "@opensteer/core";
import { appFrameHeaders, prepareAppHtml, type AppTheme } from "@opensteer/shared/appFrame";

export const appRequestBodyMaxBytes = 32 * 1_024 * 1_024;
export interface AppHttpResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[]>;
  readonly body: Readable;
}
export const appCorsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS, POST, PUT, PATCH, DELETE",
  "access-control-expose-headers": "content-type, location",
};
const hopHeaders = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "cookie",
  "authorization",
  "set-cookie",
  "host",
];
export function appProxyHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const entries = Object.entries(headers);
  const denied = new Set(hopHeaders);
  for (const [name, value] of entries) {
    if (name.toLowerCase() !== "connection") continue;
    for (const nominated of (Array.isArray(value) ? value.join(",") : (value ?? "")).split(","))
      denied.add(nominated.trim().toLowerCase());
  }
  const forwarded: [string, string | string[]][] = [];
  for (const [name, value] of entries) {
    const normalized = name.toLowerCase();
    if (!denied.has(normalized) && value !== undefined) forwarded.push([normalized, value]);
  }
  return Object.fromEntries(forwarded);
}
export function appRequestPath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//") || /[\\\0\r\n#]/u.test(value))
    throw refused("bad_request", "Use an app-relative HTTP path");
  const url = new URL(value, "http://app.invalid");
  if (url.origin !== "http://app.invalid" || url.pathname !== value.split("?")[0])
    throw refused("bad_request", "Use a normalized app-relative HTTP path");
  return value;
}
export async function requestAppHttp(input: {
  readonly connect: (signal: AbortSignal) => Promise<{ stream: Duplex; port: number }>;
  readonly method: string;
  readonly path: string;
  readonly prefix: string;
  readonly theme?: AppTheme;
  readonly headers: IncomingHttpHeaders;
  readonly body?: Readable;
  readonly signal: AbortSignal;
}): Promise<AppHttpResponse> {
  appRequestPath(input.path);
  const headers = appProxyHeaders(input.headers);
  const length = headers["content-length"];
  if (
    length !== undefined &&
    (!/^\d+$/u.test(String(length)) || Number(length) > appRequestBodyMaxBytes)
  )
    throw bodyTooLarge();
  const { stream, port } = await input.connect(input.signal);
  delete headers["accept-encoding"];
  headers["accept-encoding"] = "identity";
  headers["x-forwarded-prefix"] = input.prefix;
  headers.host = `127.0.0.1:${port}`;
  headers.connection = "close";
  const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: input.method,
        path: input.path,
        headers,
        createConnection: () => stream,
        signal: input.signal,
      },
      resolve,
    );
    upstream.once("error", reject);
    if (input.body) {
      let size = 0;
      const cap = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          size += chunk.length;
          if (size > appRequestBodyMaxBytes) {
            done(bodyTooLarge());
            return;
          }
          // HTTP may hand a single buffered agent body to the socket; every WS frame stays bounded.
          for (let offset = 0; offset < chunk.length; offset += 16 * 1_024)
            this.push(chunk.subarray(offset, offset + 16 * 1_024));
          done();
        },
      });
      void pipeline(input.body, cap, upstream).catch((error) => {
        upstream.destroy(error);
        reject(error);
      });
    } else upstream.end();
  });
  response.on("error", () => undefined);
  const outgoing: Record<string, string | string[]> = {
    ...appProxyHeaders(response.headers),
    ...(input.theme ? { ...appFrameHeaders(), ...appCorsHeaders } : {}),
  };
  outgoing["content-type"] = response.headers["content-type"] ?? "application/octet-stream";
  const location = response.headers.location;
  if (location) {
    if (location.startsWith("/") && !location.startsWith("//"))
      outgoing.location = input.prefix + location;
    else {
      try {
        const url = new URL(location);
        if (
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
          Number(url.port || 80) === port
        )
          outgoing.location = input.prefix + url.pathname + url.search + url.hash;
      } catch {
        /* Relative redirects already resolve inside the frame. */
      }
    }
  }
  if (
    input.theme &&
    /^text\/html(?:;|$)/iu.test(String(outgoing["content-type"])) &&
    input.method !== "HEAD" &&
    ![204, 304].includes(response.statusCode ?? 200)
  ) {
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of response) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > appMaxBytes) throw refused("conflict", "App HTML exceeds the 5 MiB limit");
        chunks.push(bytes);
      }
    } catch (error) {
      response.destroy();
      stream.destroy();
      throw error;
    }
    const html = Buffer.from(prepareAppHtml(Buffer.concat(chunks).toString("utf8"), input.theme));
    outgoing["content-length"] = String(html.length);
    delete outgoing["content-encoding"];
    return { status: response.statusCode ?? 502, headers: outgoing, body: Readable.from([html]) };
  }
  return { status: response.statusCode ?? 502, headers: outgoing, body: response };
}
function bodyTooLarge(): Error & { statusCode: number } {
  return Object.assign(new Error("App request exceeds the 32 MiB limit"), { statusCode: 413 });
}
