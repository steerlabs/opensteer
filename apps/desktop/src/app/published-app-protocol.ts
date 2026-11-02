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
    url.password ||
    url.hash
  )
    return null;
  const path = `${url.pathname}${url.search}`;
  return /^\/v1\/apps\/app_[0-9a-f-]{36}\/content\?token=[A-Za-z0-9_-]{43}&theme=(light|dark)$/u.test(
    path,
  )
    ? path
    : null;
}

export function createPublishedAppProtocolHandler(
  transport: Pick<DesktopHostTransport, "request">,
) {
  return async (request: Request): Promise<Response> => {
    let path: string | null = null;
    try {
      path = appPath(new URL(request.url));
    } catch {
      /* Invalid URL. */
    }
    if (request.method !== "GET" || path === null)
      return new Response("Not Found", { status: 404, headers: appFrameHeaders() });
    try {
      const result = await transport.request({ method: "GET", headers: {}, path });
      return new Response(result.status === 200 ? result.body : "App unavailable", {
        status: result.status,
        headers: appFrameHeaders(),
      });
    } catch {
      return new Response("App unavailable", { status: 503, headers: appFrameHeaders() });
    }
  };
}

export function installPublishedAppProtocol(
  protocol: DesktopProtocolRegistrar,
  transport: Pick<DesktopHostTransport, "request">,
): () => void {
  protocol.handle(appFrameScheme, createPublishedAppProtocolHandler(transport));
  return () => protocol.unhandle(appFrameScheme);
}
