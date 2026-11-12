import { DesktopPersonalOldDataStateSchema } from "@opensteer/protocol/desktop";
import {
  assertAuthorizedRenderer,
  type DesktopBridgeContext,
  type DesktopBridgeHandler,
} from "../context.js";

export const handleOldPersonalData =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    return DesktopPersonalOldDataStateSchema.nullable().parse(
      context.options.personalDataReset?.oldData() ?? null,
    );
  };

export const handleStartFresh =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    if (!context.options.isWorkspaceContents?.(event.sender))
      throw new Error("Only the application window may start fresh.");
    if (!context.options.personalDataReset) throw new Error("Personal data reset is unavailable.");
    await context.options.personalDataReset.startFresh();
  };
