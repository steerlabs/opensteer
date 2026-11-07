import {
  DesktopTailscaleShareResultSchema,
  DesktopTailscaleStatusSchema,
} from "@opensteer/protocol/desktop";
import {
  assertAuthorizedRenderer,
  type DesktopBridgeContext,
  type DesktopBridgeHandler,
} from "../context.js";

export const handleTailscaleStatus =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    return DesktopTailscaleStatusSchema.parse(await context.options.tailscale.status());
  };

export const handleTailscaleShare =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    return DesktopTailscaleShareResultSchema.parse(await context.options.tailscale.share());
  };
