import type { WebContents } from "electron";
import { DesktopTeamLinkDeliverySchema } from "@opensteer/protocol/desktop";
import {
  assertAuthorizedRenderer,
  type DesktopBridgeContext,
  type DesktopBridgeHandler,
} from "../context.js";
import { desktopBridgeChannels } from "../desktop-bridge-channels.js";

export function teamLinkDelivery(context: DesktopBridgeContext): {
  handle: DesktopBridgeHandler;
  dispose: () => void;
} {
  let owner: WebContents | null = null;
  let detach = () => {};
  const dispose = () => {
    detach();
    owner?.removeListener("did-navigate", dispose);
    owner?.removeListener("destroyed", dispose);
    owner = null;
  };
  return {
    dispose,
    handle: (event, envelope) => {
      assertAuthorizedRenderer(context, event, envelope);
      if (!context.options.isWorkspaceContents?.(event.sender))
        throw new Error("Only the application window may receive team links.");
      const input = DesktopTeamLinkDeliverySchema.parse(envelope.input);
      if (!input.ready) {
        if (owner === event.sender) dispose();
        return;
      }
      if (input.acknowledgedId) {
        if (owner === event.sender) context.options.teamLinks?.acknowledge(input.acknowledgedId);
        return;
      }
      if (owner === event.sender) return;
      dispose();
      owner = event.sender;
      const sender = owner;
      sender.once("did-navigate", dispose);
      sender.once("destroyed", dispose);
      detach =
        context.options.teamLinks?.attach((link) => {
          if (!sender.isDestroyed()) sender.send(desktopBridgeChannels.teamLink, link);
        }) ?? (() => {});
    },
  };
}
