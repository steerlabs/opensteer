import {
  DesktopOpenExternalUrlInputSchema,
  DesktopOpenExternalUrlResultSchema,
  DesktopOpenInChromeResultSchema,
  DesktopPickFolderResultSchema,
} from "@opensteer/protocol/desktop";
import {
  assertAuthorizedRenderer,
  type DesktopBridgeContext,
  type DesktopBridgeHandler,
} from "../context.js";

export const handleOpenExternalUrl =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    const { url } = DesktopOpenExternalUrlInputSchema.parse(envelope.input);
    await context.options.portal.openExternal(url);
    return DesktopOpenExternalUrlResultSchema.parse({ opened: true });
  };

/** The same pages `openExternalUrl` opens, in Google Chrome itself. */
export const handleOpenInChrome =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    const { url } = DesktopOpenExternalUrlInputSchema.parse(envelope.input);
    const open = context.options.portal.openInChrome;
    if (!open)
      return DesktopOpenInChromeResultSchema.parse({
        opened: false,
        reason: "chrome-not-installed",
      });
    return DesktopOpenInChromeResultSchema.parse(await open(url));
  };

export const handlePickFolder =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    const picked = await context.options.portal.pickFolder();
    return DesktopPickFolderResultSchema.parse(picked === null ? null : { path: picked });
  };
