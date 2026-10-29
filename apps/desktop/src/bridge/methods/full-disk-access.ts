import {
  DesktopFullDiskAccessStatusSchema,
  DesktopRequestFullDiskAccessResultSchema,
} from "@opensteer/protocol/desktop";
import {
  assertAuthorizedRenderer,
  type DesktopBridgeContext,
  type DesktopBridgeHandler,
} from "../context.js";

export const handleCheckFullDiskAccess =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    const granted = await context.options.fullDiskAccess.check();
    return DesktopFullDiskAccessStatusSchema.parse({ granted });
  };

export const handleRequestFullDiskAccess =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    await context.options.fullDiskAccess.request();
    return DesktopRequestFullDiskAccessResultSchema.parse({ opened: true });
  };

export const handleCloseFullDiskAccessPanel =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    await context.options.fullDiskAccess.closePanel();
  };
