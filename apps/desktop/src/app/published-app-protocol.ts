import { appFrameHeaders, appFrameScheme } from "@opensteer/shared/appFrame";
import type { DesktopHostTransport } from "../connections/host-transport.js";
import type { DesktopProtocolRegistrar } from "./app-protocol.js";

export function isPublishedAppUrl(value: string): boolean {
  try {
    return appPath(new URL(value)) !== null;
  } catch {
    return false;
  }
}

function appPath(url: URL): string | null {
  if (
    url.protocol !== `${appFrameScheme}:` ||
    url.hostname !== "view" ||
    url.port ||
    url.username ||
    url.password
  )
    return null;
  const path = `${url.pathname}${url.search}`;
  if (!/^\/v1\/apps\/app_[0-9a-f-]{36}\/(light|dark)\/[A-Za-z0-9_-]{43}\//u.test(path)) return null;
  for (const part of url.pathname.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      return null;
    }
    if (decoded === "." || decoded === ".." || /[\\/\0\r\n]/u.test(decoded)) return null;
  }
  return path;
}

export function createPublishedAppProtocolHandler(
  transport: Pick<DesktopHostTransport, "streamApp">,
) {
  return async (request: Request): Promise<Response> => {
    let path: string | null = null;
    try {
      path = appPath(new URL(request.url));
    } catch {
      /* Invalid URL. */
    }
    if (path === null)
      return new Response("Not Found", { status: 404, headers: appFrameHeaders() });
    try {
      const headers: Record<string, string> = {};
      for (const name of [
        "accept",
        "content-type",
        "content-length",
        "last-event-id",
        "range",
        "if-none-match",
        "if-modified-since",
        "access-control-request-method",
        "access-control-request-headers",
      ]) {
        const value = request.headers.get(name);
        if (value) headers[name] = value;
      }
      const result = await transport.streamApp({
        method: request.method,
        headers,
        path,
        signal: request.signal,
        ...(request.body ? { body: request.body } : {}),
      });
      const responseHeaders = new Headers(result.headers);
      for (const [name, value] of Object.entries(appFrameHeaders()))
        if (name !== "content-type") responseHeaders.set(name, value);
      const location = responseHeaders.get("location");
      if (location && location.startsWith("/v1/apps/"))
        responseHeaders.set("location", `${appFrameScheme}://view${location}`);
      return new Response(
        [204, 205, 304].includes(result.status) || request.method === "HEAD" ? null : result.body,
        { status: result.status, headers: responseHeaders },
      );
    } catch {
      return new Response("App unavailable", { status: 503, headers: appFrameHeaders() });
    }
  };
}

export function installPublishedAppProtocol(
  protocol: DesktopProtocolRegistrar,
  transport: Pick<DesktopHostTransport, "streamApp">,
): () => void {
  protocol.handle(appFrameScheme, createPublishedAppProtocolHandler(transport));
  return () => protocol.unhandle(appFrameScheme);
}
