import {
  DesktopConfigurePersonalRemoteAccessInputSchema,
  DesktopPersonalPairingCodeSchema,
  DesktopPersonalRemoteAccessStatusSchema,
} from "@opensteer/protocol/desktop";
import {
  assertAuthorizedRenderer,
  type DesktopBridgeContext,
  type DesktopBridgeHandler,
  trackRenderer,
} from "../context.js";

export const handleGetPersonalRemoteAccessStatus =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    trackRenderer(context.personalRemoteSenders, event.sender);
    return DesktopPersonalRemoteAccessStatusSchema.parse(context.options.personalRemote.status);
  };

export const handleConfigurePersonalRemoteAccess =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    trackRenderer(context.personalRemoteSenders, event.sender);
    return DesktopPersonalRemoteAccessStatusSchema.parse(
      await context.options.personalRemote.configure(
        DesktopConfigurePersonalRemoteAccessInputSchema.parse(envelope.input),
      ),
    );
  };

export const handleIssuePersonalPairingCode =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    return DesktopPersonalPairingCodeSchema.parse(
      await context.options.personalRemote.issuePairingCode(),
    );
  };
