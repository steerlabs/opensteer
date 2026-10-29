import {
  DesktopUseComputerViewInputSchema,
  DesktopUseComputerViewResultSchema,
  DesktopComputerUseApprovalInputSchema,
  DesktopComputerUseApprovalPresentationSchema,
  DesktopComputerUseApprovalRespondInputSchema,
  DesktopComputerUsePermissionsResultSchema,
  DesktopOpenComputerUsePermissionsPanelResultSchema,
  DesktopOpenComputerUseSettingsInputSchema,
} from "@opensteer/protocol/desktop";
import {
  assertAuthorizedRenderer,
  type DesktopBridgeContext,
  type DesktopBridgeHandler,
} from "../context.js";
import { AdHocSignedHelperError } from "../../signed-helpers/signed-helper.js";

export const handleGetComputerUseApproval =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    const input = DesktopComputerUseApprovalInputSchema.parse(envelope.input);
    return DesktopComputerUseApprovalPresentationSchema.parse(
      context.options.computerUse.approvalGet(input.token, event.sender),
    );
  };

export const handleRespondComputerUseApproval =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    const input = DesktopComputerUseApprovalRespondInputSchema.parse(envelope.input);
    // The window's own contents are the only sender that may answer: another
    // renderer holding the token is still not the panel the person sees.
    context.options.computerUse.approvalRespond(input.token, input.allow, event.sender);
  };

export const handleGetComputerUsePermissions =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    return DesktopComputerUsePermissionsResultSchema.parse(
      await context.options.computerUse.permissions(),
    );
  };

export const handleRequestComputerUsePermissions =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    const input = DesktopOpenComputerUseSettingsInputSchema.parse(envelope.input);
    return DesktopComputerUsePermissionsResultSchema.parse(
      await context.options.computerUse.requestPermissions(input.pane),
    );
  };

export const handleOpenComputerUsePermissionsPanel =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    try {
      await context.options.computerUse.verifyBundledHelper();
    } catch (error) {
      if (!(error instanceof AdHocSignedHelperError)) throw error;
      return DesktopOpenComputerUsePermissionsPanelResultSchema.parse({
        opened: false,
        reason: "unsigned-build",
      });
    }
    await context.options.computerUse.openPermissionsPanel();
    return DesktopOpenComputerUsePermissionsPanelResultSchema.parse({ opened: true });
  };

export const handleCloseComputerUsePermissionsPanel =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    await context.options.computerUse.closePermissionsPanel();
  };

export const handleOpenComputerUseSystemSettings =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    const input = DesktopOpenComputerUseSettingsInputSchema.parse(envelope.input);
    await context.options.computerUse.openSystemSettings(input.pane);
  };

export const handleUseComputerViewOnThisMac =
  (context: DesktopBridgeContext): DesktopBridgeHandler =>
  async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    const input = DesktopUseComputerViewInputSchema.parse(envelope.input);
    try {
      const current = await context.options.hostTransport.current();
      if (current.resolved.deploymentId !== input.deploymentId)
        return DesktopUseComputerViewResultSchema.parse({
          activated: false,
          reason: "deployment-changed",
        });
      const computerUse = context.options.computerUse;
      if (!computerUse.checkLocalComputerViewTarget || !computerUse.useComputerViewOnThisMac)
        return DesktopUseComputerViewResultSchema.parse({ activated: false, reason: "not-local" });
      const target = await computerUse.checkLocalComputerViewTarget(
        input.deploymentId,
        input.machineId,
      );
      if (!target.local)
        return DesktopUseComputerViewResultSchema.parse({
          activated: false,
          reason: target.reason,
        });
      if ((await context.options.hostTransport.current()).resolved.key !== current.resolved.key)
        return DesktopUseComputerViewResultSchema.parse({
          activated: false,
          reason: "deployment-changed",
        });
      return DesktopUseComputerViewResultSchema.parse(
        await computerUse.useComputerViewOnThisMac(input),
      );
    } catch (error) {
      context.options.computerUse.onActivationError(error);
      return DesktopUseComputerViewResultSchema.parse({ activated: false, reason: "unavailable" });
    }
  };
