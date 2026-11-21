import {
  desktopHostRouteOrigin,
  desktopHostTransportErrorHeader,
  parseDesktopHostRoute,
  parseDesktopHostStreamErrorRoute,
} from "@opensteer/protocol/desktop";
import type { DesktopHostTransport } from "../connections/host-transport.js";

/**
 * The bundled UI's Host traffic. Electron sets `initiatorOrigin` from the frame
 * that made the request, not from anything the page sends, so a framed app or
 * site cannot spend this Mac's Host credentials here.
 */
export async function forwardHostRoute(
  request: Request,
  transport: Pick<DesktopHostTransport, "forward"> &
    Partial<Pick<DesktopHostTransport, "takeStreamError">>,
): Promise<Response> {
  const initiator = "initiatorOrigin" in request ? request.initiatorOrigin : undefined;
  const streamErrorRequestId =
    request.method === "GET" ? parseDesktopHostStreamErrorRoute(request.url) : null;
  if (streamErrorRequestId !== null) {
    if (initiator !== desktopHostRouteOrigin) return new Response(null, { status: 403 });
    const code = (await transport.takeStreamError?.(streamErrorRequestId)) ?? null;
    return new Response(null, {
      status: 204,
      headers: code ? { [desktopHostTransportErrorHeader]: code } : {},
    });
  }
  const route = parseDesktopHostRoute(request.url);
  if (!route) return new Response(null, { status: 404 });
  if (initiator !== desktopHostRouteOrigin) return new Response(null, { status: 403 });
  return transport.forward(route.deploymentId, route.path, request);
}
