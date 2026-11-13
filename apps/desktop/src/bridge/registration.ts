import { handleOldPersonalData, handleStartFresh } from "./methods/personal-data-reset.js";
import { teamLinkDelivery } from "./methods/team-links.js";
import {
  DesktopIntegrationAuthorizationSubscriptionSchema,
  DesktopFinishIntegrationAuthorizationInputSchema,
} from "@opensteer/protocol/desktop";
import {
  handleIssuePersonalAccountLinkChallenge,
  handleCompletePersonalAccountLink,
} from "./methods/account-link-courier.js";
import { personalWebLinksAvailable, WebLinkDeliveryOwner } from "./methods/web-links.js";
import { DesktopWebLinkDeliverySchema } from "@opensteer/protocol/desktop";
import { dictationHandlers } from "./methods/dictation.js";
import { passkeyHandlers } from "./methods/passkeys.js";
import { viewerClipboardHandlers } from "./methods/viewer-clipboard.js";
import { downloadsHandlers } from "./methods/downloads.js";
import { deploymentUpdatesHandlers } from "./methods/deployment-updates.js";
import { updatesHandlers } from "./methods/updates.js";
import { browserPresentationHandlers } from "./methods/browser-presentation.js";
import { z } from "zod";
import { isRealtimeFrameMetadata } from "@opensteer/protocol";
import { assertAuthorizedRenderer, trackRenderer } from "./context.js";
import type { WebContents } from "electron";
import {
  DesktopDownloadsSnapshotSchema,
  DesktopUpdateStateSchema,
  DisplayClientDiagnosticSchema,
  RealtimeFrameDiagnosticSchema,
  RendererFailureDiagnosticSchema,
  DeploymentAccessSnapshotSchema,
  DesktopLocalExecutionStatusSchema,
  DesktopPasswordsStatusSchema,
} from "@opensteer/protocol/desktop";
import { desktopBridgeChannels } from "./desktop-bridge-channels.js";
import type { DesktopBridgeContext, DesktopBridgeOptions } from "./context.js";
import {
  handleAgentPhoneAdbOpen,
  handleAgentPhoneAdbCall,
  handleAgentPhoneAdbClose,
  handleChooseUsbDevice,
  handleReadAgentPhoneArtifact,
} from "./methods/agent-phone.js";
import {
  handleCloseComputerAppSetup,
  handleComputerAppSetupBegin,
  handleComputerAppSetupShowAgain,
  handleComputerAppSetupStartDrag,
  handleComputerAppSetupStatus,
  handleOpenComputerAppSetup,
} from "./methods/computer-apps.js";
import {
  handleCloseComputerUsePermissionsPanel,
  handleUseComputerViewOnThisMac,
  handleGetComputerUsePermissions,
  handleOpenComputerUsePermissionsPanel,
  handleOpenComputerUseSystemSettings,
  handleRequestComputerUsePermissions,
} from "./methods/computer-use.js";
import {
  handleAddDirect,
  handleCancel,
  handleConnectPrivate,
  handleCreatePersonalDeployment,
  handleGetDeploymentAccessSnapshot,
  handleLinkPersonal,
  handleReauthorize,
  handleCheckDeployments,
  handleRefreshDirectory,
  handleRemoveFromAccount,
  handleRetry,
  handleSelect,
  handleSignIn,
  handleSignOut,
  handleUnlinkPersonal,
} from "./methods/connections.js";
import {
  handleCloseHostWebSocket,
  handleHostRequest,
  handleHostBinaryOpen,
  handleHostBinaryWrite,
  handleHostBinaryFinish,
  handleHostBinaryRead,
  handleHostBinaryClose,
  handleOpenHostWebSocket,
  handleSendHostWebSocket,
} from "./methods/host.js";
import {
  handleOpenIntegrationAuthorization,
  handlePrepareIntegrationAuthorizationReturn,
} from "./methods/integrations.js";
import {
  handleGetNotificationSupport,
  handleOpenNotificationSettings,
  handleSetBadgeCount,
  handleShowNotification,
  handleTestNotification,
} from "./methods/notifications.js";
import { handleTailscaleShare, handleTailscaleStatus } from "./methods/tailscale.js";
import {
  handleCheckFullDiskAccess,
  handleCloseFullDiskAccessPanel,
  handleRequestFullDiskAccess,
} from "./methods/full-disk-access.js";
import {
  handleGetLocalExecutionStatus,
  handleRecheckLocalEngines,
  handleStartLocalRunner,
  handleSetUpDevice,
  handleRetryDeviceConnection,
  handlePrepareDeviceSetup,
  handleAccountSignOutPreview,
  handleLeaveDeployment,
  handleSignDeviceSessionBinding,
  handleStopLocalRunner,
} from "./methods/local-execution.js";
import { handleGetPasswordsStatus, handleOpenPasswords } from "./methods/passwords.js";
import { handleOpenExternalUrl, handlePickFolder } from "./methods/window.js";

/** Admits 120 records per ten seconds, answering how many it held back since the last. */
function diagnosticBudget(): () => number | null {
  let windowAt = 0;
  let admitted = 0;
  let suppressed = 0;
  return () => {
    const now = Date.now();
    if (now - windowAt >= 10_000) {
      windowAt = now;
      admitted = 0;
    }
    if (admitted++ >= 120) {
      suppressed++;
      return null;
    }
    const heldBack = suppressed;
    suppressed = 0;
    return heldBack;
  };
}

export function registerDesktopBridge(options: DesktopBridgeOptions): () => void {
  const context: DesktopBridgeContext = {
    downloadsSenders: new Set(),
    updatesSenders: new Set(),
    accessSenders: new Set(),
    localExecutionSenders: new Map(),
    options,
    passwordsSenders: new Set(),
    trackedHostSenders: new Set(),
  };
  const unsubscribeDownloads = options.downloads.subscribe((snapshot) => {
    const parsed = DesktopDownloadsSnapshotSchema.parse(snapshot);
    for (const sender of context.downloadsSenders) {
      if (!sender.isDestroyed() && sender.mainFrame.url.startsWith("app://opensteer/")) {
        sender.send(desktopBridgeChannels.downloadsChanged, parsed);
      }
    }
  });
  const unsubscribeUpdates = options.updates?.subscribe((state) => {
    const parsed = DesktopUpdateStateSchema.parse(state);
    for (const sender of context.updatesSenders) {
      if (!sender.isDestroyed() && sender.mainFrame.url.startsWith("app://opensteer/")) {
        sender.send(desktopBridgeChannels.updateChanged, parsed);
      }
    }
  });
  const localExecutionPushGeneration = new WeakMap<WebContents, number>();
  const unsubscribeLocalExecution = options.runner.subscribe(() => {
    for (const [sender, deploymentId] of context.localExecutionSenders) {
      const generation = (localExecutionPushGeneration.get(sender) ?? 0) + 1;
      localExecutionPushGeneration.set(sender, generation);
      void options.runner.status(deploymentId).then(
        (status) => {
          if (
            sender.isDestroyed() ||
            context.localExecutionSenders.get(sender) !== deploymentId ||
            localExecutionPushGeneration.get(sender) !== generation
          ) {
            return;
          }
          sender.send(
            desktopBridgeChannels.localExecutionStatusChanged,
            DesktopLocalExecutionStatusSchema.parse(status),
          );
        },
        () => undefined,
      );
    }
  });
  const unsubscribeAccess = options.access.subscribe((snapshot) => {
    const parsed = DeploymentAccessSnapshotSchema.parse(snapshot);
    for (const sender of context.accessSenders) {
      if (!sender.isDestroyed()) {
        sender.send(desktopBridgeChannels.deploymentAccessSnapshotChanged, parsed);
      }
    }
  });
  const unsubscribePasswords = options.passwords.subscribe((status) => {
    const parsed = DesktopPasswordsStatusSchema.parse(status);
    for (const sender of context.passwordsSenders) {
      if (!sender.isDestroyed()) {
        sender.send(desktopBridgeChannels.passwordsStatusChanged, parsed);
      }
    }
  });
  const visibilitySenders = new Set<WebContents>();
  const unsubscribeVisibility = options.localVisibility.subscribe((visible) => {
    for (const sender of visibilitySenders) {
      if (!sender.isDestroyed()) sender.send(desktopBridgeChannels.localVisibilityChanged, visible);
    }
  });
  const register = options.ipcMain.handle.bind(options.ipcMain);
  register(desktopBridgeChannels.dismissMcpAuthorization, (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    if (!options.isWorkspaceContents?.(event.sender))
      throw new Error("Only the workspace may dismiss agent consent.");
    options.mcpAuthorizationLinks?.clear(
      z
        .string()
        .regex(/^[A-Za-z0-9_-]{43}$/)
        .parse(envelope.input),
    );
  });
  const admitDisplayDiagnostic = diagnosticBudget();
  register(desktopBridgeChannels.reportDisplayDiagnostic, (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    const record = DisplayClientDiagnosticSchema.parse(envelope.input);
    const suppressed = admitDisplayDiagnostic();
    if (suppressed === null) return;
    try {
      const fields: Record<string, string | number | boolean> = {};
      for (const [key, value] of Object.entries(record)) {
        if (value !== undefined) fields[key] = value;
      }
      fields.suppressed = (record.suppressed ?? 0) + suppressed;
      options.log?.("computer.display.client", fields);
    } catch {
      /* Diagnostics must not affect viewing. */
    }
  });
  const admitRealtimeDiagnostic = diagnosticBudget();
  register(desktopBridgeChannels.reportRealtimeDiagnostic, (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    const record = RealtimeFrameDiagnosticSchema.parse(envelope.input);
    if (!isRealtimeFrameMetadata(record))
      throw new Error("A realtime diagnostic may only name what the wire schemas declare.");
    const { event: name, issuePaths, ...fields } = record;
    const suppressed = admitRealtimeDiagnostic();
    if (suppressed === null) return;
    try {
      options.log?.(name, { ...fields, issuePaths: issuePaths.join(";"), suppressed });
    } catch {
      /* Diagnostics must not affect the channel they describe. */
    }
  });
  const admitRendererFailure = diagnosticBudget();
  register(desktopBridgeChannels.reportRendererFailure, (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    const { componentFrames, errorFrames, errorName } = RendererFailureDiagnosticSchema.parse(
      envelope.input,
    );
    const suppressed = admitRendererFailure();
    if (suppressed === null) return;
    try {
      options.log?.("desktop.renderer.failed", {
        componentFrames: componentFrames.join(";"),
        errorFrames: errorFrames.join(";"),
        errorName,
        suppressed,
      });
    } catch {
      /* Diagnostics must not affect the page's recovery. */
    }
  });
  register(desktopBridgeChannels.getLocalVisibility, (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    trackRenderer(visibilitySenders, event.sender);
    return z.boolean().parse(options.localVisibility.getSnapshot());
  });

  for (const [channel, handler] of passkeyHandlers(context)) register(channel, handler);
  for (const [channel, handler] of dictationHandlers(context)) register(channel, handler);
  for (const [channel, handler] of viewerClipboardHandlers(context)) register(channel, handler);
  for (const [channel, handler] of downloadsHandlers(context)) register(channel, handler);
  for (const [channel, handler] of updatesHandlers(context)) register(channel, handler);
  for (const [channel, handler] of deploymentUpdatesHandlers(context)) register(channel, handler);
  for (const [channel, handler] of browserPresentationHandlers(context)) register(channel, handler);

  register(desktopBridgeChannels.useComputerViewOnThisMac, handleUseComputerViewOnThisMac(context));
  register(desktopBridgeChannels.openComputerAppSetup, handleOpenComputerAppSetup(context));
  register(desktopBridgeChannels.computerAppSetupStatus, handleComputerAppSetupStatus(context));
  register(desktopBridgeChannels.computerAppSetupBegin, handleComputerAppSetupBegin(context));
  register(
    desktopBridgeChannels.computerAppSetupShowAgain,
    handleComputerAppSetupShowAgain(context),
  );
  register(
    desktopBridgeChannels.computerAppSetupStartDrag,
    handleComputerAppSetupStartDrag(context),
  );
  register(desktopBridgeChannels.closeComputerAppSetup, handleCloseComputerAppSetup(context));
  register(
    desktopBridgeChannels.getComputerUsePermissions,
    handleGetComputerUsePermissions(context),
  );
  register(
    desktopBridgeChannels.requestComputerUsePermissions,
    handleRequestComputerUsePermissions(context),
  );
  register(
    desktopBridgeChannels.openComputerUsePermissionsPanel,
    handleOpenComputerUsePermissionsPanel(context),
  );
  register(
    desktopBridgeChannels.closeComputerUsePermissionsPanel,
    handleCloseComputerUsePermissionsPanel(context),
  );
  register(
    desktopBridgeChannels.openComputerUseSystemSettings,
    handleOpenComputerUseSystemSettings(context),
  );
  register(desktopBridgeChannels.getPasswordsStatus, handleGetPasswordsStatus(context));
  register(desktopBridgeChannels.openPasswords, handleOpenPasswords(context));
  register(desktopBridgeChannels.addDirect, handleAddDirect(context));
  register(desktopBridgeChannels.cancel, handleCancel(context));
  register(desktopBridgeChannels.checkFullDiskAccess, handleCheckFullDiskAccess(context));
  register(desktopBridgeChannels.agentPhoneAdbOpen, handleAgentPhoneAdbOpen(context));
  register(desktopBridgeChannels.agentPhoneAdbCall, handleAgentPhoneAdbCall(context));
  register(desktopBridgeChannels.agentPhoneAdbClose, handleAgentPhoneAdbClose(context));
  register(desktopBridgeChannels.chooseUsbDevice, handleChooseUsbDevice(context));
  register(desktopBridgeChannels.closeFullDiskAccessPanel, handleCloseFullDiskAccessPanel(context));
  register(desktopBridgeChannels.closeHostWebSocket, handleCloseHostWebSocket(context));
  register(desktopBridgeChannels.connectPrivate, handleConnectPrivate(context));
  register(desktopBridgeChannels.createPersonalDeployment, handleCreatePersonalDeployment(context));
  register(
    desktopBridgeChannels.getDeploymentAccessSnapshot,
    handleGetDeploymentAccessSnapshot(context),
  );
  register(desktopBridgeChannels.getLocalExecutionStatus, handleGetLocalExecutionStatus(context));
  register(desktopBridgeChannels.hostRequest, handleHostRequest(context));
  register(desktopBridgeChannels.hostBinaryOpen, handleHostBinaryOpen(context));
  register(desktopBridgeChannels.hostBinaryWrite, handleHostBinaryWrite(context));
  register(desktopBridgeChannels.hostBinaryFinish, handleHostBinaryFinish(context));
  register(desktopBridgeChannels.hostBinaryRead, handleHostBinaryRead(context));
  register(desktopBridgeChannels.hostBinaryClose, handleHostBinaryClose(context));
  register(
    desktopBridgeChannels.issuePersonalAccountLinkChallenge,
    handleIssuePersonalAccountLinkChallenge(context),
  );
  register(
    desktopBridgeChannels.completePersonalAccountLink,
    handleCompletePersonalAccountLink(context),
  );
  register(desktopBridgeChannels.linkPersonal, handleLinkPersonal(context));
  const webLinkOwner = options.webLinks
    ? new WebLinkDeliveryOwner(
        options.webLinks,
        (sender) => options.isWorkspaceContents?.(sender) === true,
        (deploymentId) => personalWebLinksAvailable(options.access.snapshot(), deploymentId),
      )
    : null;
  register(desktopBridgeChannels.personalOldData, handleOldPersonalData(context));
  register(desktopBridgeChannels.personalStartFresh, handleStartFresh(context));
  const teamLinkOwner = teamLinkDelivery(context);
  register(desktopBridgeChannels.teamLinkDelivery, teamLinkOwner.handle);
  register(desktopBridgeChannels.webLinkDelivery, (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    return (
      webLinkOwner?.handle(event.sender, DesktopWebLinkDeliverySchema.parse(envelope.input)) ?? null
    );
  });
  register(desktopBridgeChannels.openExternalUrl, handleOpenExternalUrl(context));
  register(desktopBridgeChannels.getNotificationSupport, handleGetNotificationSupport(context));
  register(desktopBridgeChannels.showNotification, handleShowNotification(context));
  register(desktopBridgeChannels.testNotification, handleTestNotification(context));
  register(desktopBridgeChannels.openNotificationSettings, handleOpenNotificationSettings(context));
  register(desktopBridgeChannels.setBadgeCount, handleSetBadgeCount(context));
  register(desktopBridgeChannels.recheckLocalEngines, handleRecheckLocalEngines(context));
  register(desktopBridgeChannels.tailscaleStatus, handleTailscaleStatus(context));
  register(desktopBridgeChannels.tailscaleShare, handleTailscaleShare(context));
  register(desktopBridgeChannels.openHostWebSocket, handleOpenHostWebSocket(context));
  register(
    desktopBridgeChannels.prepareIntegrationAuthorizationReturn,
    handlePrepareIntegrationAuthorizationReturn(context),
  );
  register(
    desktopBridgeChannels.openIntegrationAuthorization,
    handleOpenIntegrationAuthorization(context),
  );
  let integrationSubscription: {
    sender: Electron.WebContents;
    generation: string;
    detach: () => void;
  } | null = null;
  const detachIntegrationSubscription = () => {
    integrationSubscription?.detach();
    integrationSubscription = null;
  };
  register(desktopBridgeChannels.integrationAuthorizationSubscription, (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    if (options.isWorkspaceContents?.(event.sender) !== true)
      throw new Error("Only the workspace window may receive integration returns.");
    const input = DesktopIntegrationAuthorizationSubscriptionSchema.parse(envelope.input);
    if (!input.ready) {
      if (
        integrationSubscription?.sender === event.sender &&
        integrationSubscription.generation === input.generation
      )
        detachIntegrationSubscription();
      return;
    }
    detachIntegrationSubscription();
    const detach =
      options.integrationAuthorizations?.attach(input, (callback) => {
        if (!event.sender.isDestroyed())
          event.sender.send(desktopBridgeChannels.integrationAuthorizationReturn, callback);
      }) ?? (() => {});
    const cleanup = () => {
      if (integrationSubscription?.generation === input.generation) detachIntegrationSubscription();
    };
    event.sender.once("destroyed", cleanup);
    // Not did-start-loading: Electron fires that for every route change and iframe.
    event.sender.once("did-navigate", cleanup);
    integrationSubscription = {
      sender: event.sender,
      generation: input.generation,
      detach: () => {
        detach();
        event.sender.removeListener("destroyed", cleanup);
        event.sender.removeListener("did-navigate", cleanup);
      },
    };
  });
  register(desktopBridgeChannels.finishIntegrationAuthorization, async (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    if (options.isWorkspaceContents?.(event.sender) !== true)
      throw new Error("Only the workspace window may finish integration returns.");
    const input = DesktopFinishIntegrationAuthorizationInputSchema.parse(envelope.input);
    if (input.attemptId)
      await options.integrationAuthorizations?.forget({
        ...input,
        attemptId: input.attemptId,
      });
    else await options.integrationAuthorizations?.clear(input.deploymentId);
  });
  register(desktopBridgeChannels.pickFolder, handlePickFolder(context));
  register(desktopBridgeChannels.readAgentPhoneArtifact, handleReadAgentPhoneArtifact(context));
  register(desktopBridgeChannels.reauthorize, handleReauthorize(context));
  register(desktopBridgeChannels.checkDeployments, handleCheckDeployments(context));
  register(desktopBridgeChannels.refreshDirectory, handleRefreshDirectory(context));
  register(desktopBridgeChannels.removeFromAccount, handleRemoveFromAccount(context));
  register(desktopBridgeChannels.retry, handleRetry(context));
  register(desktopBridgeChannels.requestFullDiskAccess, handleRequestFullDiskAccess(context));
  register(desktopBridgeChannels.select, handleSelect(context));
  register(desktopBridgeChannels.sendHostWebSocket, handleSendHostWebSocket(context));
  register(desktopBridgeChannels.signIn, handleSignIn(context));
  register(desktopBridgeChannels.signOut, handleSignOut(context));
  register(desktopBridgeChannels.prepareDeviceSetup, handlePrepareDeviceSetup(context));
  register(desktopBridgeChannels.accountSignOutPreview, handleAccountSignOutPreview(context));
  register(desktopBridgeChannels.retryDeviceConnection, handleRetryDeviceConnection(context));
  register(desktopBridgeChannels.setUpDevice, handleSetUpDevice(context));
  register(desktopBridgeChannels.leaveDeployment, handleLeaveDeployment(context));
  register(desktopBridgeChannels.signDeviceSessionBinding, handleSignDeviceSessionBinding(context));
  register(desktopBridgeChannels.startLocalRunner, handleStartLocalRunner(context));
  register(desktopBridgeChannels.stopLocalRunner, handleStopLocalRunner(context));
  register(desktopBridgeChannels.unlinkPersonal, handleUnlinkPersonal(context));

  return () => {
    detachIntegrationSubscription();
    webLinkOwner?.dispose();
    teamLinkOwner.dispose();
    unsubscribeDownloads();
    context.downloadsSenders.clear();
    unsubscribeUpdates?.();
    context.updatesSenders.clear();
    unsubscribeVisibility();
    visibilitySenders.clear();
    unsubscribeAccess();
    unsubscribeLocalExecution();
    unsubscribePasswords();
    context.accessSenders.clear();
    context.localExecutionSenders.clear();
    context.passwordsSenders.clear();
    for (const channel of Object.values(desktopBridgeChannels)) {
      options.ipcMain.removeHandler(channel);
    }
  };
}
