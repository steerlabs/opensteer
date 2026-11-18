import { desktopHostRouteOrigin, parseDesktopHostRoute } from "@opensteer/protocol/desktop";
import type { DesktopHostTransport } from "../connections/host-transport.js";

/**
 * The bundled UI's Host traffic. Electron sets `initiatorOrigin` from the frame
 * that made the request, not from anything the page sends, so a framed app or
 * site cannot spend this Mac's Host credentials here.
 */
export function forwardHostRoute(
  request: Request,
  transport: Pick<DesktopHostTransport, "forward">,
): Promise<Response> {
  const route = parseDesktopHostRoute(request.url);
  if (!route) return Promise.resolve(new Response(null, { status: 404 }));
  const initiator = "initiatorOrigin" in request ? request.initiatorOrigin : undefined;
  if (initiator !== desktopHostRouteOrigin)
    return Promise.resolve(new Response(null, { status: 403 }));
  return transport.forward(route.deploymentId, route.path, request);
}
