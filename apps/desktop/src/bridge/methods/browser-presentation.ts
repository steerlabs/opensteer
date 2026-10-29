import { z } from "zod";
import {
  DesktopBrowserNavigationAvailableSchema,
  DesktopBrowserPresentationLocalInputSchema,
  DesktopBrowserPresentInputSchema,
  DesktopBrowserPresentResultSchema,
  DesktopBrowserPresentationUpdateInputSchema,
  DesktopBrowserPresentationUpdateResultSchema,
  DesktopBrowserPresentationTargetSchema,
  DesktopBrowserOverlayInputSchema,
  DesktopBrowserFindInputSchema,
  DesktopBrowserGlassInputSchema,
} from "@opensteer/protocol/desktop";
import { BrowserPresentationUnavailable } from "../browser-presentation-result.js";
import { desktopBridgeChannels } from "../desktop-bridge-channels.js";
import {
  assertAuthorizedRenderer,
  type DesktopBridgeContext,
  type DesktopBridgeHandler,
} from "../context.js";

export function browserPresentationHandlers(
  context: DesktopBridgeContext,
): ReadonlyArray<readonly [string, DesktopBridgeHandler]> {
  const handler =
    <T>(
      schema: z.ZodType<T>,
      action: (
        manager: NonNullable<typeof context.options.browserPresentation>,
        sender: Electron.WebContents,
        input: T,
      ) => unknown,
    ): DesktopBridgeHandler =>
    async (event, envelope) => {
      assertAuthorizedRenderer(context, event, envelope);
      const input = schema.parse(envelope.input);
      const manager = context.options.browserPresentation;
      if (!manager) throw new Error("Native browser presentation is unavailable.");
      try {
        return { ok: true, value: await action(manager, event.sender, input) };
      } catch (error) {
        if (error instanceof BrowserPresentationUnavailable)
          return { ok: false, reason: error.reason };
        throw error;
      }
    };
  return [
    [
      desktopBridgeChannels.browserNavigationAvailable,
      handler(DesktopBrowserNavigationAvailableSchema, (manager, sender, input) =>
        manager.setNavigationAvailable(sender, input),
      ),
    ],
    [
      desktopBridgeChannels.browserIsLocal,
      handler(DesktopBrowserPresentationLocalInputSchema, (manager, _sender, input) =>
        manager.isLocal(input.sessionId),
      ),
    ],
    [
      desktopBridgeChannels.browserPresent,
      handler(DesktopBrowserPresentInputSchema, async (manager, sender, input) =>
        DesktopBrowserPresentResultSchema.parse(await manager.present(sender, input)),
      ),
    ],
    [
      desktopBridgeChannels.browserPresentationUpdate,
      handler(DesktopBrowserPresentationUpdateInputSchema, async (manager, sender, input) =>
        DesktopBrowserPresentationUpdateResultSchema.parse(await manager.update(sender, input)),
      ),
    ],
    [
      desktopBridgeChannels.browserPresentationRelease,
      handler(DesktopBrowserPresentationTargetSchema, (manager, sender, input) =>
        manager.release(sender, input),
      ),
    ],
    [
      desktopBridgeChannels.browserWindowFocused,
      handler(z.undefined(), (manager, sender) => manager.windowFocused(sender)),
    ],
    [
      desktopBridgeChannels.browserAcquireOverlay,
      handler(DesktopBrowserOverlayInputSchema, (manager, sender, input) =>
        manager.acquireOverlay(sender, input),
      ),
    ],
    [
      desktopBridgeChannels.browserReleaseOverlay,
      handler(DesktopBrowserOverlayInputSchema, (manager, sender, input) =>
        manager.releaseOverlay(sender, input),
      ),
    ],
    [
      desktopBridgeChannels.browserFind,
      handler(DesktopBrowserFindInputSchema, (manager, sender, input) =>
        manager.find(sender, input),
      ),
    ],
    [
      desktopBridgeChannels.browserStopFind,
      handler(DesktopBrowserPresentationTargetSchema, (manager, sender, input) =>
        manager.stopFind(sender, input),
      ),
    ],
    [
      desktopBridgeChannels.browserExitFullscreen,
      handler(DesktopBrowserPresentationTargetSchema, (manager, sender, input) =>
        manager.exitFullscreen(sender, input),
      ),
    ],
    [
      desktopBridgeChannels.browserSetGlass,
      handler(DesktopBrowserGlassInputSchema, (manager, sender, input) =>
        manager.setGlass(sender, input),
      ),
    ],
    [
      desktopBridgeChannels.browserFocusPage,
      handler(DesktopBrowserPresentationTargetSchema, (manager, sender, input) =>
        manager.focusPage(sender, input),
      ),
    ],
  ];
}
