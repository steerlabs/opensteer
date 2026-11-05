import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { Readable, Transform, type Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";
import { appMaxBytes, refused } from "@opensteer/core";
import { appFrameHeaders, prepareAppHtml, type AppTheme } from "@opensteer/shared/appFrame";

export const appGatewayCookieName = "__Host-opensteer-app";
export interface AppOriginMode {
  readonly origin: string;
  readonly parents: readonly string[];
}
export function appOriginHeaders(mode: AppOriginMode): Record<string, string> {
  const headers = appFrameHeaders();
  delete headers["content-type"];
  delete headers["cache-control"];
  headers["content-security-policy"] = `frame-ancestors ${mode.parents.join(" ")}`;
  // `no-referrer` makes a page's own form posts send `Origin: null`, which CSRF checks refuse.
  headers["referrer-policy"] = "same-origin";
  return headers;
}
/** Cloudflare obeys these over `Cache-Control`, and it keys its cache on the Connect URL. */
const appEdgeCacheHeaders = [
  "cache-tag",
  "cdn-cache-control",
  "cloudflare-cdn-cache-control",
  "surrogate-control",
  "surrogate-key",
];
/** The Connect edge would otherwise cache static files and serve them with no authorization. */
function appOriginCacheControl(value: string | undefined): string {
  const directives = (value ?? "no-cache")
    .split(",")
    .map((directive) => directive.trim())
    .filter((directive) => directive && !/^(?:public|private|s-maxage=.*)$/iu.test(directive));
  return ["private", ...directives].join(", ");
}
export function appOriginCookies(value: string | undefined): string | undefined {
  const cookies = (value ?? "")
    .split(/; ?/u)
    .filter((cookie) => {
      const separator = cookie.indexOf("=");
      const name = separator < 0 ? cookie : cookie.slice(0, separator);
      return separator > 7 && name.startsWith("__Host-") && name !== appGatewayCookieName;
    })
    .map((cookie) => cookie.slice(7));
  return cookies.length ? cookies.join("; ") : undefined;
}
export function appOriginSetCookie(value: string): string | undefined {
  const [pair = "", ...attributes] = value.split(";");
  const separator = pair.indexOf("=");
  const name = pair.slice(0, separator);
  if (
    separator <= 0 ||
    !/^[^=;\s]+$/u.test(name) ||
    name === "opensteer-app" ||
    name === appGatewayCookieName
  )
    return undefined;
  const kept = attributes.filter((attribute) =>
    /^\s*(?:HttpOnly\s*$|(?:Expires|Max-Age)=)/iu.test(attribute),
  );
  return `__Host-${pair}; Path=/; Secure; SameSite=None; Partitioned${kept.map((attribute) => `;${attribute}`).join("")}`;
}
export function appOriginRequestHeaders(
  headers: IncomingHttpHeaders,
): Record<string, string | string[]> {
  const forwarded = appProxyHeaders(headers);
  if (headers.authorization !== undefined) forwarded.authorization = headers.authorization;
  const cookie = appOriginCookies(headers.cookie);
  if (cookie) forwarded.cookie = cookie;
  delete forwarded["x-opensteer-app-origin"];
  delete forwarded["x-forwarded-prefix"];
  return forwarded;
}

/**
 * An app sees itself where it listens. Dev servers and frameworks refuse unknown Host values, and
 * CSRF checks compare Origin with Host, so both describe loopback. The gateway has already
 * refused other origins, so rewriting a same-origin request hides nothing from the app.
 */
export function appOriginLoopbackHeaders(
  headers: Record<string, string | string[]>,
  mode: AppOriginMode,
  port: number,
): void {
  const loopback = `http://127.0.0.1:${port}`;
  headers.host = `127.0.0.1:${port}`;
  if (headers.origin === mode.origin) headers.origin = loopback;
  const referer = headers.referer;
  if (typeof referer === "string" && (referer + "/").startsWith(`${mode.origin}/`))
    headers.referer = loopback + referer.slice(mode.origin.length);
}

export function appOriginResponseHeaders(
  headers: IncomingHttpHeaders,
  mode: AppOriginMode,
): Record<string, string | string[]> {
  const outgoing: Record<string, string | string[]> = {
    ...appProxyHeaders(headers),
    ...appOriginHeaders(mode),
  };
  for (const name of ["clear-site-data", "x-frame-options", ...appEdgeCacheHeaders])
    delete outgoing[name];
  const cookies = (headers["set-cookie"] ?? []).flatMap((value) => {
    const rewritten = appOriginSetCookie(value);
    return rewritten ? [rewritten] : [];
  });
  if (cookies.length) outgoing["set-cookie"] = cookies;
  outgoing["cache-control"] = /^text\/html(?:;|$)/iu.test(headers["content-type"] ?? "")
    ? "private, no-store"
    : appOriginCacheControl(headers["cache-control"]);
  return outgoing;
}

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
  readonly originMode?: AppOriginMode;
  readonly headers: IncomingHttpHeaders;
  readonly body?: Readable;
  readonly signal: AbortSignal;
}): Promise<AppHttpResponse> {
  appRequestPath(input.path);
  const headers = input.originMode
    ? appOriginRequestHeaders(input.headers)
    : appProxyHeaders(input.headers);
  const length = headers["content-length"];
  if (
    length !== undefined &&
    (!/^\d+$/u.test(String(length)) || Number(length) > appRequestBodyMaxBytes)
  )
    throw bodyTooLarge();
  const { stream, port } = await input.connect(input.signal);
  delete headers["accept-encoding"];
  headers["accept-encoding"] = "identity";
  if (!input.originMode) headers["x-forwarded-prefix"] = input.prefix;
  if (input.originMode) appOriginLoopbackHeaders(headers, input.originMode, port);
  else headers.host = `127.0.0.1:${port}`;
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
  const outgoing: Record<string, string | string[]> = input.originMode
    ? appOriginResponseHeaders(response.headers, input.originMode)
    : {
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
        const url = input.originMode
          ? new URL(location, input.originMode.origin)
          : new URL(location);
        if (
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
          (input.originMode || Number(url.port || 80) === port)
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
    const html = Buffer.from(
      prepareAppHtml(Buffer.concat(chunks).toString("utf8"), input.theme, !!input.originMode),
    );
    outgoing["content-length"] = String(html.length);
    delete outgoing["content-encoding"];
    return { status: response.statusCode ?? 502, headers: outgoing, body: Readable.from([html]) };
  }
  return { status: response.statusCode ?? 502, headers: outgoing, body: response };
}
function bodyTooLarge(): Error & { statusCode: number } {
  return Object.assign(new Error("App request exceeds the 32 MiB limit"), { statusCode: 413 });
}
