import { personalWebLinksAvailable, WebLinkDeliveryOwner } from "./methods/web-links.js";
import { DesktopWebLinkDeliverySchema } from "@opensteer/protocol/desktop";
import { dictationHandlers } from "./methods/dictation.js";
import { passkeyHandlers } from "./methods/passkeys.js";
import { viewerClipboardHandlers } from "./methods/viewer-clipboard.js";
import { downloadsHandlers } from "./methods/downloads.js";
import { browserPresentationHandlers } from "./methods/browser-presentation.js";
import { z } from "zod";
import { assertAuthorizedRenderer, trackRenderer } from "./context.js";
import type { WebContents } from "electron";
import {
  DesktopDownloadsSnapshotSchema,
  DisplayClientDiagnosticSchema,
  DeploymentAccessSnapshotSchema,
  DesktopLocalExecutionStatusSchema,
  DesktopPasswordsSignInCardChangedSchema,
  DesktopPasswordsStatusSchema,
  DesktopPersonalRemoteAccessStatusSchema,
} from "@opensteer/protocol/desktop";
import { desktopBridgeChannels } from "./desktop-bridge-channels.js";
import type { DesktopBridgeContext, DesktopBridgeOptions } from "./context.js";
import { handleChooseUsbDevice, handleReadAgentPhoneArtifact } from "./methods/agent-phone.js";
import {
  handleCloseComputerAppSetup,
  handleComputerAppSetupBegin,
  handleComputerAppSetupShowAgain,
  handleComputerAppSetupStartDrag,
  handleComputerAppSetupStatus,
  handleComputerUseApprovalKey,
  handleOpenComputerAppSetup,
  handleReviewComputerAppSetup,
} from "./methods/computer-apps.js";
import {
  handleCloseComputerUsePermissionsPanel,
  handleUseComputerViewOnThisMac,
  handleGetComputerUseApproval,
  handleGetComputerUsePermissions,
  handleOpenComputerUsePermissionsPanel,
  handleOpenComputerUseSystemSettings,
  handleRequestComputerUsePermissions,
  handleRespondComputerUseApproval,
} from "./methods/computer-use.js";
import {
  handleCreateCloudDeployment,
  handleDeleteCloudDeployment,
  handleListCloudDeployments,
  handleRetryCloudDeployment,
} from "./methods/cloud.js";
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
import { handleOpenIntegrationAuthorization } from "./methods/integrations.js";
import {
  handleGetNotificationSupport,
  handleSetBadgeCount,
  handleShowNotification,
} from "./methods/notifications.js";
import {
  handleCheckFullDiskAccess,
  handleCloseFullDiskAccessPanel,
  handleRequestFullDiskAccess,
} from "./methods/full-disk-access.js";
import {
  handleAcknowledgePortableFsApproval,
  handleGetLocalExecutionStatus,
  handleInstallPortableFs,
  handleOpenPortableFsSetup,
  handleStartLocalRunner,
  handleStopLocalRunner,
} from "./methods/local-execution.js";
import {
  handleGetPasswordsSignIn,
  handleApprovePasswordsSignIn,
  handleGetPasswordsStatus,
  handleOpenPasswords,
} from "./methods/passwords.js";
import {
  handleConfigurePersonalRemoteAccess,
  handleGetPersonalRemoteAccessStatus,
  handleIssuePersonalPairingCode,
} from "./methods/personal.js";
import { handleOpenExternalUrl, handlePickFolder } from "./methods/window.js";

export function registerDesktopBridge(options: DesktopBridgeOptions): () => void {
  const context: DesktopBridgeContext = {
    downloadsSenders: new Set(),
    accessSenders: new Set(),
    localExecutionSenders: new Map(),
    options,
    passwordsSenders: new Set(),
    passwordsSignInCards: new Map(),
    personalRemoteSenders: new Set(),
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
  const unsubscribePersonalRemote = options.personalRemote.subscribe((status) => {
    const parsed = DesktopPersonalRemoteAccessStatusSchema.parse(status);
    for (const sender of context.personalRemoteSenders) {
      if (!sender.isDestroyed()) {
        sender.send(desktopBridgeChannels.personalRemoteAccessStatusChanged, parsed);
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
  const unsubscribeSignIns = options.passwords.signIns.subscribe((change) => {
    const parsed = DesktopPasswordsSignInCardChangedSchema.parse(change);
    for (const [sender, operations] of context.passwordsSignInCards) {
      if (operations.has(change.operationId) && !sender.isDestroyed())
        sender.send(desktopBridgeChannels.passwordsSignInChanged, parsed);
    }
  });
  const visibilitySenders = new Set<WebContents>();
  const unsubscribeVisibility = options.localVisibility.subscribe((visible) => {
    for (const sender of visibilitySenders) {
      if (!sender.isDestroyed()) sender.send(desktopBridgeChannels.localVisibilityChanged, visible);
    }
  });
  const register = options.ipcMain.handle.bind(options.ipcMain);
  let diagnosticWindow = 0;
  let diagnosticCount = 0;
  let diagnosticSuppressed = 0;
  register(desktopBridgeChannels.reportDisplayDiagnostic, (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    const record = DisplayClientDiagnosticSchema.parse(envelope.input);
    const now = Date.now();
    if (now - diagnosticWindow >= 10_000) {
      diagnosticWindow = now;
      diagnosticCount = 0;
    }
    if (diagnosticCount++ >= 120) {
      diagnosticSuppressed++;
      return;
    }
    try {
      const fields: Record<string, string | number | boolean> = {
        suppressed: diagnosticSuppressed,
      };
      for (const [key, value] of Object.entries(record)) {
        if (value !== undefined) fields[key] = value;
      }
      fields.suppressed = (record.suppressed ?? 0) + diagnosticSuppressed;
      options.log?.("computer.display.client", fields);
      diagnosticSuppressed = 0;
    } catch {
      /* Diagnostics must not affect viewing. */
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
  for (const [channel, handler] of browserPresentationHandlers(context)) register(channel, handler);

  register(desktopBridgeChannels.useComputerViewOnThisMac, handleUseComputerViewOnThisMac(context));
  register(desktopBridgeChannels.computerUseApprovalKey, handleComputerUseApprovalKey(context));
  register(desktopBridgeChannels.reviewComputerAppSetup, handleReviewComputerAppSetup(context));
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
  register(desktopBridgeChannels.getComputerUseApproval, handleGetComputerUseApproval(context));
  register(
    desktopBridgeChannels.respondComputerUseApproval,
    handleRespondComputerUseApproval(context),
  );
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
  register(desktopBridgeChannels.getPasswordsSignIn, handleGetPasswordsSignIn(context));
  register(desktopBridgeChannels.approvePasswordsSignIn, handleApprovePasswordsSignIn(context));
  register(
    desktopBridgeChannels.acknowledgePortableFsApproval,
    handleAcknowledgePortableFsApproval(context),
  );
  register(desktopBridgeChannels.addDirect, handleAddDirect(context));
  register(desktopBridgeChannels.cancel, handleCancel(context));
  register(desktopBridgeChannels.checkFullDiskAccess, handleCheckFullDiskAccess(context));
  register(desktopBridgeChannels.chooseUsbDevice, handleChooseUsbDevice(context));
  register(desktopBridgeChannels.closeFullDiskAccessPanel, handleCloseFullDiskAccessPanel(context));
  register(desktopBridgeChannels.createCloudDeployment, handleCreateCloudDeployment(context));
  register(desktopBridgeChannels.deleteCloudDeployment, handleDeleteCloudDeployment(context));
  register(desktopBridgeChannels.closeHostWebSocket, handleCloseHostWebSocket(context));
  register(
    desktopBridgeChannels.configurePersonalRemoteAccess,
    handleConfigurePersonalRemoteAccess(context),
  );
  register(desktopBridgeChannels.listCloudDeployments, handleListCloudDeployments(context));
  register(desktopBridgeChannels.retryCloudDeployment, handleRetryCloudDeployment(context));
  register(desktopBridgeChannels.connectPrivate, handleConnectPrivate(context));
  register(desktopBridgeChannels.createPersonalDeployment, handleCreatePersonalDeployment(context));
  register(
    desktopBridgeChannels.getDeploymentAccessSnapshot,
    handleGetDeploymentAccessSnapshot(context),
  );
  register(desktopBridgeChannels.getLocalExecutionStatus, handleGetLocalExecutionStatus(context));
  register(
    desktopBridgeChannels.getPersonalRemoteAccessStatus,
    handleGetPersonalRemoteAccessStatus(context),
  );
  register(desktopBridgeChannels.hostRequest, handleHostRequest(context));
  register(desktopBridgeChannels.hostBinaryOpen, handleHostBinaryOpen(context));
  register(desktopBridgeChannels.hostBinaryWrite, handleHostBinaryWrite(context));
  register(desktopBridgeChannels.hostBinaryFinish, handleHostBinaryFinish(context));
  register(desktopBridgeChannels.hostBinaryRead, handleHostBinaryRead(context));
  register(desktopBridgeChannels.hostBinaryClose, handleHostBinaryClose(context));
  register(desktopBridgeChannels.installPortableFs, handleInstallPortableFs(context));
  register(desktopBridgeChannels.issuePersonalPairingCode, handleIssuePersonalPairingCode(context));
  register(desktopBridgeChannels.linkPersonal, handleLinkPersonal(context));
  const webLinkOwner = options.webLinks
    ? new WebLinkDeliveryOwner(
        options.webLinks,
        (sender) => options.isWorkspaceContents?.(sender) === true,
        (deploymentId) => personalWebLinksAvailable(options.access.snapshot(), deploymentId),
      )
    : null;
  register(desktopBridgeChannels.webLinkDelivery, (event, envelope) => {
    assertAuthorizedRenderer(context, event, envelope);
    return (
      webLinkOwner?.handle(event.sender, DesktopWebLinkDeliverySchema.parse(envelope.input)) ?? null
    );
  });
  register(desktopBridgeChannels.openExternalUrl, handleOpenExternalUrl(context));
  register(desktopBridgeChannels.getNotificationSupport, handleGetNotificationSupport(context));
  register(desktopBridgeChannels.showNotification, handleShowNotification(context));
  register(desktopBridgeChannels.setBadgeCount, handleSetBadgeCount(context));
  register(desktopBridgeChannels.openHostWebSocket, handleOpenHostWebSocket(context));
  register(
    desktopBridgeChannels.openIntegrationAuthorization,
    handleOpenIntegrationAuthorization(context),
  );
  register(desktopBridgeChannels.openPortableFsSetup, handleOpenPortableFsSetup(context));
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
  register(desktopBridgeChannels.startLocalRunner, handleStartLocalRunner(context));
  register(desktopBridgeChannels.stopLocalRunner, handleStopLocalRunner(context));
  register(desktopBridgeChannels.unlinkPersonal, handleUnlinkPersonal(context));

  return () => {
    webLinkOwner?.dispose();
    unsubscribeDownloads();
    context.downloadsSenders.clear();
    unsubscribeVisibility();
    visibilitySenders.clear();
    unsubscribeAccess();
    unsubscribeLocalExecution();
    unsubscribePersonalRemote();
    unsubscribePasswords();
    unsubscribeSignIns();
    context.passwordsSignInCards.clear();
    context.accessSenders.clear();
    context.localExecutionSenders.clear();
    context.passwordsSenders.clear();
    context.personalRemoteSenders.clear();
    for (const channel of Object.values(desktopBridgeChannels)) {
      options.ipcMain.removeHandler(channel);
    }
  };
}
