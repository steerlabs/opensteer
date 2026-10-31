import {
  type DesktopAgentPhoneAdbBridge,
  DesktopAgentPhoneAdbOpenSchema,
  DesktopAgentPhoneAdbOpenResultSchema,
  DesktopAgentPhoneAdbCallSchema,
  DesktopAgentPhoneAdbResultSchema,
  DesktopAgentPhoneAdbSessionSchema,
  DesktopWebLinkDeliverySchema,
  DesktopWebLinkSchema,
} from "@opensteer/protocol/desktop";
import type { DictationPort } from "@opensteer/protocol/dictation";
import type { ViewerClipboardBridge } from "@opensteer/client/editing";
import {
  DesktopDownloadsSnapshotSchema,
  DesktopDownloadActionResultSchema,
  DesktopDownloadTargetSchema,
  type DesktopDownloadsBridge,
} from "@opensteer/protocol/desktop";
import { BrowserPresentationResultSchema } from "./bridge/browser-presentation-result.js";
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
  DesktopBrowserPresentationEventSchema,
  type DesktopBrowserPresentationBridge,
} from "@opensteer/protocol/desktop";
import { z } from "zod";
import { contextBridge, ipcRenderer } from "electron";
import type {
  DesktopWorkspaceTabCommand,
  DeploymentAccessSnapshot,
  DesktopAgentPhoneArtifact,
  DesktopChooseUsbDeviceInput,
  DesktopUsbDeviceChoice,
  DesktopComputerUseApprovalKeyResult,
  DesktopReviewComputerAppSetupInput,
  DesktopReviewComputerAppSetupResult,
  DesktopComputerAppSetupStatus,
  DesktopComputerAppSetupTarget,
  DesktopOpenComputerAppSetupInput,
  DesktopOpenComputerAppSetupResult,
  DesktopAddDirectRouteInput,
  DesktopCloseHostWebSocketInput,
  DesktopComputerUseApprovalInput,
  DesktopComputerUseApprovalPresentation,
  DesktopComputerUseApprovalRespondInput,
  DesktopComputerUsePermissionsResult,
  DesktopConfigurePersonalRemoteAccessInput,
  DesktopConnectPrivateDeploymentInput,
  DesktopFullDiskAccessStatus,
  DesktopOpenComputerUsePermissionsPanelResult,
  DesktopOpenComputerUseSettingsInput,
  DesktopHostHttpRequest,
  DesktopHostResult,
  DesktopHostHttpResponse,
  DesktopHostBinaryOpenInput,
  DesktopHostBinaryOpenResult,
  DesktopHostBinaryWriteInput,
  DesktopHostBinaryTransferInput,
  DesktopHostBinaryReadResult,
  DesktopHostWebSocketCommand,
  DesktopHostWebSocketEvent,
  DesktopLocalExecutionStatus,
  DesktopLocalExecutionInput,
  DesktopOpenExternalUrlInput,
  DesktopOpenExternalUrlResult,
  DesktopOpenHostWebSocketInput,
  DesktopOpenHostWebSocketResult,
  DesktopOpenIntegrationAuthorizationInput,
  DesktopOpenIntegrationAuthorizationResult,
  DesktopPickFolderResult,
  DesktopPersonalPairingCode,
  DesktopPersonalRemoteAccessStatus,
  DesktopRequestFullDiskAccessResult,
  DesktopRemoveAccountDeploymentInput,
  DesktopBadgeCountInput,
  DesktopNotificationResult,
  DesktopNotificationSupport,
  DesktopNotificationTarget,
  DesktopPasswordsSignInCardInput,
  DesktopPasswordsSignInCardState,
  DesktopPasswordsSignInApproveInput,
  DesktopPasswordsStatus,
  DesktopSelectDeploymentInput,
  DesktopStartLocalRunnerInput,
  OpensteerDesktopBridge,
  DesktopCloudDeploymentOperationInput,
  DesktopDeleteCloudDeploymentInput,
} from "@opensteer/protocol/desktop";
import type {
  CloudDeploymentOperation,
  CreateCloudDeploymentRequest,
  ListCloudDeploymentsResponse,
} from "@opensteer/control-plane-protocol";
import {
  DisplayClientDiagnosticSchema,
  DesktopWorkspaceTabCommandSchema,
  DeploymentAccessSnapshotSchema,
  DesktopChooseUsbDeviceInputSchema,
  DesktopReadAgentPhoneArtifactResultSchema,
  DesktopUsbDeviceChoiceSchema,
  DesktopComputerUseApprovalKeyResultSchema,
  DesktopReviewComputerAppSetupInputSchema,
  DesktopReviewComputerAppSetupResultSchema,
  DesktopComputerAppSetupStatusSchema,
  DesktopComputerAppSetupTargetSchema,
  DesktopOpenComputerAppSetupInputSchema,
  DesktopOpenComputerAppSetupResultSchema,
  DesktopAddDirectRouteInputSchema,
  DesktopCloseHostWebSocketInputSchema,
  DesktopUseComputerViewInputSchema,
  DesktopUseComputerViewResultSchema,
  DesktopComputerUseApprovalInputSchema,
  DesktopComputerUseApprovalPresentationSchema,
  DesktopComputerUseApprovalRespondInputSchema,
  DesktopComputerUsePermissionsResultSchema,
  DesktopOpenComputerUsePermissionsPanelResultSchema,
  DesktopOpenComputerUseSettingsInputSchema,
  DesktopConfigurePersonalRemoteAccessInputSchema,
  DesktopCloudDeploymentOperationInputSchema,
  DesktopDeleteCloudDeploymentInputSchema,
  DesktopConnectPrivateDeploymentInputSchema,
  DesktopFullDiskAccessStatusSchema,
  DesktopHostHttpRequestSchema,
  DesktopHostHttpResultSchema,
  DesktopHostVoidResultSchema,
  DesktopHostBinaryOpenInputSchema,
  DesktopHostBinaryOpenResponseSchema,
  DesktopHostBinaryWriteInputSchema,
  DesktopHostBinaryTransferInputSchema,
  DesktopHostBinaryReadResponseSchema,
  DesktopHostWebSocketCommandSchema,
  DesktopHostWebSocketEventSchema,
  DesktopLocalExecutionInputSchema,
  DesktopLocalExecutionStatusSchema,
  DesktopOpenExternalUrlInputSchema,
  DesktopOpenExternalUrlResultSchema,
  DesktopPickFolderResultSchema,
  DesktopOpenHostWebSocketInputSchema,
  DesktopOpenHostWebSocketResultSchema,
  DesktopOpenIntegrationAuthorizationInputSchema,
  DesktopOpenIntegrationAuthorizationResultSchema,
  DesktopPersonalPairingCodeSchema,
  DesktopPersonalRemoteAccessStatusSchema,
  DesktopRequestFullDiskAccessResultSchema,
  DesktopRemoveAccountDeploymentInputSchema,
  DesktopBadgeCountInputSchema,
  DesktopNotificationResultSchema,
  DesktopNotificationSupportSchema,
  DesktopNotificationTargetSchema,
  DesktopPasswordsSignInCardInputSchema,
  DesktopPasswordsSignInCardStateSchema,
  DesktopPasswordsSignInCardChangedSchema,
  DesktopPasswordsSignInApproveInputSchema,
  DesktopPasswordsSignInApproveResultSchema,
  DesktopPasswordsStatusSchema,
  DesktopSelectDeploymentInputSchema,
  DesktopStartLocalRunnerInputSchema,
} from "@opensteer/protocol/desktop";
import {
  CloudDeploymentOperationSchema,
  CreateCloudDeploymentRequestSchema,
  ListCloudDeploymentsResponseSchema,
} from "@opensteer/control-plane-protocol";
import {
  DictationAvailabilitySchema,
  DictationEventSchema,
  DictationSessionInputSchema,
} from "@opensteer/protocol/dictation";
import { PasswordsBridgeResultSchema } from "./bridge/passwords-result.js";
import { desktopBridgeChannels } from "./bridge/desktop-bridge-channels.js";

const argumentPrefix = "--opensteer-desktop-bridge-token=";
const bridgeToken = process.argv
  .find((argument) => argument.startsWith(argumentPrefix))
  ?.slice(argumentPrefix.length);

if (!bridgeToken || bridgeToken.length < 32 || bridgeToken.length > 255) {
  throw new Error("Opensteer desktop bridge capability is missing.");
}

async function invoke<T>(channel: string, input?: unknown): Promise<T> {
  return ipcRenderer.invoke(channel, {
    bridgeToken,
    ...(input === undefined ? {} : { input }),
  }) as Promise<T>;
}

async function invokePasswords<T = unknown>(channel: string, input?: unknown): Promise<T> {
  const result = PasswordsBridgeResultSchema.parse(await invoke(channel, input));
  if (!result.ok) throw new Error(result.message);
  return (result.value ?? undefined) as T;
}

async function invokePresentation(channel: string, input?: unknown): Promise<unknown> {
  const result = BrowserPresentationResultSchema.parse(await invoke(channel, input));
  if (!result.ok)
    // ContextBridge copies Error.message but drops custom Error fields.
    throw Object.freeze({
      message: `Native browser presentation unavailable: ${result.reason}`,
      reason: result.reason,
    });
  return result.value;
}

const browserPresentation: DesktopBrowserPresentationBridge =
  Object.freeze<DesktopBrowserPresentationBridge>({
    setNavigationAvailable: async (input) => {
      await invokePresentation(
        desktopBridgeChannels.browserNavigationAvailable,
        DesktopBrowserNavigationAvailableSchema.parse(input),
      );
    },
    isLocal: async (input) =>
      z
        .boolean()
        .parse(
          await invokePresentation(
            desktopBridgeChannels.browserIsLocal,
            DesktopBrowserPresentationLocalInputSchema.parse(input),
          ),
        ),
    present: async (input) =>
      DesktopBrowserPresentResultSchema.parse(
        await invokePresentation(
          desktopBridgeChannels.browserPresent,
          DesktopBrowserPresentInputSchema.parse(input),
        ),
      ),
    update: async (input) =>
      DesktopBrowserPresentationUpdateResultSchema.parse(
        await invokePresentation(
          desktopBridgeChannels.browserPresentationUpdate,
          DesktopBrowserPresentationUpdateInputSchema.parse(input),
        ),
      ),
    release: async (input) => {
      await invokePresentation(
        desktopBridgeChannels.browserPresentationRelease,
        DesktopBrowserPresentationTargetSchema.parse(input),
      );
    },
    windowFocused: async () =>
      z.boolean().parse(await invokePresentation(desktopBridgeChannels.browserWindowFocused)),
    acquireOverlay: async (input) => {
      await invokePresentation(
        desktopBridgeChannels.browserAcquireOverlay,
        DesktopBrowserOverlayInputSchema.parse(input),
      );
    },
    releaseOverlay: async (input) => {
      await invokePresentation(
        desktopBridgeChannels.browserReleaseOverlay,
        DesktopBrowserOverlayInputSchema.parse(input),
      );
    },
    find: async (input) => {
      await invokePresentation(
        desktopBridgeChannels.browserFind,
        DesktopBrowserFindInputSchema.parse(input),
      );
    },
    stopFind: async (input) => {
      await invokePresentation(
        desktopBridgeChannels.browserStopFind,
        DesktopBrowserPresentationTargetSchema.parse(input),
      );
    },
    exitFullscreen: async (input) => {
      await invokePresentation(
        desktopBridgeChannels.browserExitFullscreen,
        DesktopBrowserPresentationTargetSchema.parse(input),
      );
    },
    focusPage: async (input) => {
      await invokePresentation(
        desktopBridgeChannels.browserFocusPage,
        DesktopBrowserPresentationTargetSchema.parse(input),
      );
    },
    setGlass: (input) => {
      void invokePresentation(
        desktopBridgeChannels.browserSetGlass,
        DesktopBrowserGlassInputSchema.parse(input),
      ).catch((error: unknown) => console.error(error));
    },
    onEvent: (listener) => {
      const receive = (_event: Electron.IpcRendererEvent, value: unknown) =>
        listener(DesktopBrowserPresentationEventSchema.parse(value));
      ipcRenderer.on(desktopBridgeChannels.browserPresentationEvent, receive);
      return () => {
        ipcRenderer.removeListener(desktopBridgeChannels.browserPresentationEvent, receive);
      };
    },
  });

const bridge: OpensteerDesktopBridge & ViewerClipboardBridge = Object.freeze({
  writeViewerClipboard: (items: Parameters<ViewerClipboardBridge["writeViewerClipboard"]>[0]) =>
    invoke<void>(desktopBridgeChannels.writeViewerClipboard, items),
  pasteViewerClipboard: () => invoke<void>(desktopBridgeChannels.pasteViewerClipboard),
  setViewerKeyboardActive: (active: boolean) =>
    invoke<void>(desktopBridgeChannels.setViewerKeyboardActive, z.boolean().parse(active)),
  webLinkDelivery: async (input: import("@opensteer/protocol/desktop").DesktopWebLinkDelivery) => {
    const result = await invoke(
      desktopBridgeChannels.webLinkDelivery,
      DesktopWebLinkDeliverySchema.parse(input),
    );
    return result === null ? null : DesktopWebLinkSchema.parse(result);
  },
  onWorkspaceTabCommand: (listener: (command: DesktopWorkspaceTabCommand) => void) => {
    const receive = (_event: Electron.IpcRendererEvent, value: unknown) =>
      listener(DesktopWorkspaceTabCommandSchema.parse(value));
    ipcRenderer.on(desktopBridgeChannels.workspaceTabCommand, receive);
    return () => ipcRenderer.removeListener(desktopBridgeChannels.workspaceTabCommand, receive);
  },
  passkeys: Object.freeze({
    available: async () => z.boolean().parse(await invoke(desktopBridgeChannels.passkeyAvailable)),
    present: async (input: { readonly requestId: string }) => {
      await invoke(
        desktopBridgeChannels.passkeyPresent,
        z.strictObject({ requestId: z.uuid() }).parse(input),
      );
    },
  }),
  browserPresentation,
  reportDisplayDiagnostic: async (record: z.input<typeof DisplayClientDiagnosticSchema>) => {
    await invoke(
      desktopBridgeChannels.reportDisplayDiagnostic,
      DisplayClientDiagnosticSchema.parse(record),
    );
  },
  getLocalVisibility: async () =>
    z.boolean().parse(await invoke<boolean>(desktopBridgeChannels.getLocalVisibility)),
  onLocalVisibilityChanged: (listener: (visible: boolean) => void) => {
    const receive = (_event: Electron.IpcRendererEvent, value: unknown) =>
      listener(z.boolean().parse(value));
    ipcRenderer.on(desktopBridgeChannels.localVisibilityChanged, receive);
    return () => {
      ipcRenderer.removeListener(desktopBridgeChannels.localVisibilityChanged, receive);
    };
  },
  agentPhoneAdb: {
    open: async (input) =>
      DesktopAgentPhoneAdbOpenResultSchema.parse(
        await invoke(
          desktopBridgeChannels.agentPhoneAdbOpen,
          DesktopAgentPhoneAdbOpenSchema.parse(input),
        ),
      ),
    call: async (input) =>
      DesktopAgentPhoneAdbResultSchema.parse(
        await invoke(
          desktopBridgeChannels.agentPhoneAdbCall,
          DesktopAgentPhoneAdbCallSchema.parse(input),
        ),
      ),
    close: async (input) => {
      await invoke(
        desktopBridgeChannels.agentPhoneAdbClose,
        DesktopAgentPhoneAdbSessionSchema.parse(input),
      );
    },
    onAuthorize: (listener) => {
      const receive = (_event: Electron.IpcRendererEvent, value: unknown) =>
        listener(DesktopAgentPhoneAdbSessionSchema.parse(value));
      ipcRenderer.on(desktopBridgeChannels.agentPhoneAdbAuthorize, receive);
      return () =>
        ipcRenderer.removeListener(desktopBridgeChannels.agentPhoneAdbAuthorize, receive);
    },
  } satisfies DesktopAgentPhoneAdbBridge,
  readAgentPhoneArtifact: async () =>
    DesktopReadAgentPhoneArtifactResultSchema.parse(
      await invoke<DesktopAgentPhoneArtifact | null>(desktopBridgeChannels.readAgentPhoneArtifact),
    ),
  onUsbDeviceChoice: (listener: (choice: DesktopUsbDeviceChoice) => void) => {
    const receive = (_event: Electron.IpcRendererEvent, value: unknown) => {
      listener(DesktopUsbDeviceChoiceSchema.parse(value));
    };
    ipcRenderer.on(desktopBridgeChannels.usbDeviceChoice, receive);
    return () => ipcRenderer.removeListener(desktopBridgeChannels.usbDeviceChoice, receive);
  },
  chooseUsbDevice: (input: DesktopChooseUsbDeviceInput) =>
    invoke<void>(
      desktopBridgeChannels.chooseUsbDevice,
      DesktopChooseUsbDeviceInputSchema.parse(input),
    ),
  downloads: {
    get: async () =>
      DesktopDownloadsSnapshotSchema.parse(await invoke(desktopBridgeChannels.getDownloads)),
    onChanged: (listener) => {
      const receive = (_event: Electron.IpcRendererEvent, value: unknown) =>
        listener(DesktopDownloadsSnapshotSchema.parse(value));
      ipcRenderer.on(desktopBridgeChannels.downloadsChanged, receive);
      return () => ipcRenderer.removeListener(desktopBridgeChannels.downloadsChanged, receive);
    },
    open: async (input) =>
      DesktopDownloadActionResultSchema.parse(
        await invoke(desktopBridgeChannels.openDownload, DesktopDownloadTargetSchema.parse(input)),
      ),
    show: async (input) =>
      DesktopDownloadActionResultSchema.parse(
        await invoke(desktopBridgeChannels.showDownload, DesktopDownloadTargetSchema.parse(input)),
      ),
    cancel: async (input) =>
      DesktopDownloadActionResultSchema.parse(
        await invoke(
          desktopBridgeChannels.cancelDownload,
          DesktopDownloadTargetSchema.parse(input),
        ),
      ),
  } satisfies DesktopDownloadsBridge,
  dictation: {
    availability: async () =>
      DictationAvailabilitySchema.parse(await invoke(desktopBridgeChannels.dictationAvailability)),
    start: async (session) => {
      await invoke(
        desktopBridgeChannels.dictationStart,
        DictationSessionInputSchema.parse({ session }),
      );
    },
    download: async (session) => {
      await invoke(
        desktopBridgeChannels.dictationDownload,
        DictationSessionInputSchema.parse({ session }),
      );
    },
    stop: async (session) => {
      await invoke(
        desktopBridgeChannels.dictationStop,
        DictationSessionInputSchema.parse({ session }),
      );
    },
    cancel: async (session) => {
      await invoke(
        desktopBridgeChannels.dictationCancel,
        DictationSessionInputSchema.parse({ session }),
      );
    },
    openMicrophoneSettings: async () => {
      await invoke(desktopBridgeChannels.dictationSettings);
    },
    subscribe: (listener) => {
      const receive = (_event: unknown, value: unknown) =>
        listener(DictationEventSchema.parse(value));
      ipcRenderer.on(desktopBridgeChannels.dictationEvent, receive);
      return () => ipcRenderer.removeListener(desktopBridgeChannels.dictationEvent, receive);
    },
  } satisfies DictationPort,
  passwordsStatus: async () =>
    DesktopPasswordsStatusSchema.parse(
      await invokePasswords<DesktopPasswordsStatus>(desktopBridgeChannels.getPasswordsStatus),
    ),
  onPasswordsStatusChanged: (listener: (status: DesktopPasswordsStatus) => void) => {
    const receive = (_event: Electron.IpcRendererEvent, value: unknown) => {
      listener(DesktopPasswordsStatusSchema.parse(value));
    };
    ipcRenderer.on(desktopBridgeChannels.passwordsStatusChanged, receive);
    return () => ipcRenderer.removeListener(desktopBridgeChannels.passwordsStatusChanged, receive);
  },
  passwordsOpen: () => invokePasswords<void>(desktopBridgeChannels.openPasswords),
  passwordsSignInGet: async (input: DesktopPasswordsSignInCardInput) =>
    DesktopPasswordsSignInCardStateSchema.parse(
      await invokePasswords<DesktopPasswordsSignInCardState>(
        desktopBridgeChannels.getPasswordsSignIn,
        DesktopPasswordsSignInCardInputSchema.parse(input),
      ),
    ),
  onPasswordsSignInChanged: (
    input: DesktopPasswordsSignInCardInput,
    listener: (state: DesktopPasswordsSignInCardState) => void,
  ) => {
    const { operationId } = DesktopPasswordsSignInCardInputSchema.parse(input);
    const receive = (_event: unknown, value: unknown): void => {
      const change = DesktopPasswordsSignInCardChangedSchema.parse(value);
      if (change.operationId === operationId) listener(change.state);
    };
    ipcRenderer.on(desktopBridgeChannels.passwordsSignInChanged, receive);
    return () => ipcRenderer.removeListener(desktopBridgeChannels.passwordsSignInChanged, receive);
  },
  passwordsSignInApprove: async (input: DesktopPasswordsSignInApproveInput) =>
    DesktopPasswordsSignInApproveResultSchema.parse(
      await invokePasswords(
        desktopBridgeChannels.approvePasswordsSignIn,
        DesktopPasswordsSignInApproveInputSchema.parse(input),
      ),
    ),
  useComputerViewOnThisMac: async (input: unknown) =>
    DesktopUseComputerViewResultSchema.parse(
      await invoke(
        desktopBridgeChannels.useComputerViewOnThisMac,
        DesktopUseComputerViewInputSchema.parse(input),
      ),
    ),
  computerUseApprovalKey: async () =>
    DesktopComputerUseApprovalKeyResultSchema.parse(
      await invoke<DesktopComputerUseApprovalKeyResult>(
        desktopBridgeChannels.computerUseApprovalKey,
      ),
    ),
  reviewComputerAppSetup: async (input: DesktopReviewComputerAppSetupInput) =>
    DesktopReviewComputerAppSetupResultSchema.parse(
      await invoke<DesktopReviewComputerAppSetupResult>(
        desktopBridgeChannels.reviewComputerAppSetup,
        DesktopReviewComputerAppSetupInputSchema.parse(input),
      ),
    ),
  openComputerAppSetup: async (input: DesktopOpenComputerAppSetupInput) =>
    DesktopOpenComputerAppSetupResultSchema.parse(
      await invoke<DesktopOpenComputerAppSetupResult>(
        desktopBridgeChannels.openComputerAppSetup,
        DesktopOpenComputerAppSetupInputSchema.parse(input),
      ),
    ),
  computerAppSetupStatus: async () =>
    DesktopComputerAppSetupStatusSchema.parse(
      await invoke<DesktopComputerAppSetupStatus>(desktopBridgeChannels.computerAppSetupStatus),
    ),
  computerAppSetupBegin: (input: DesktopComputerAppSetupTarget) =>
    invoke<void>(
      desktopBridgeChannels.computerAppSetupBegin,
      DesktopComputerAppSetupTargetSchema.parse(input),
    ),
  computerAppSetupShowAgain: () => invoke<void>(desktopBridgeChannels.computerAppSetupShowAgain),
  computerAppSetupStartDrag: () => invoke<void>(desktopBridgeChannels.computerAppSetupStartDrag),
  closeComputerAppSetup: (input: DesktopComputerAppSetupTarget) =>
    invoke<void>(
      desktopBridgeChannels.closeComputerAppSetup,
      DesktopComputerAppSetupTargetSchema.parse(input),
    ),
  computerUseApprovalGet: async (input: DesktopComputerUseApprovalInput) =>
    DesktopComputerUseApprovalPresentationSchema.parse(
      await invoke<DesktopComputerUseApprovalPresentation>(
        desktopBridgeChannels.getComputerUseApproval,
        DesktopComputerUseApprovalInputSchema.parse(input),
      ),
    ),
  computerUseApprovalRespond: (input: DesktopComputerUseApprovalRespondInput) =>
    invoke<void>(
      desktopBridgeChannels.respondComputerUseApproval,
      DesktopComputerUseApprovalRespondInputSchema.parse(input),
    ),
  computerUseOpenSystemSettings: (input: DesktopOpenComputerUseSettingsInput) =>
    invoke<void>(
      desktopBridgeChannels.openComputerUseSystemSettings,
      DesktopOpenComputerUseSettingsInputSchema.parse(input),
    ),
  computerUsePermissionsGet: async () =>
    DesktopComputerUsePermissionsResultSchema.parse(
      await invoke<DesktopComputerUsePermissionsResult>(
        desktopBridgeChannels.getComputerUsePermissions,
      ),
    ),
  computerUsePermissionsRequest: async (input: DesktopOpenComputerUseSettingsInput) =>
    DesktopComputerUsePermissionsResultSchema.parse(
      await invoke<DesktopComputerUsePermissionsResult>(
        desktopBridgeChannels.requestComputerUsePermissions,
        DesktopOpenComputerUseSettingsInputSchema.parse(input),
      ),
    ),
  openComputerUsePermissionsPanel: async () =>
    DesktopOpenComputerUsePermissionsPanelResultSchema.parse(
      await invoke<DesktopOpenComputerUsePermissionsPanelResult>(
        desktopBridgeChannels.openComputerUsePermissionsPanel,
      ),
    ),
  closeComputerUsePermissionsPanel: () =>
    invoke<void>(desktopBridgeChannels.closeComputerUsePermissionsPanel),
  acknowledgePortableFsApproval: (input: DesktopLocalExecutionInput) =>
    invoke<DesktopLocalExecutionStatus>(
      desktopBridgeChannels.acknowledgePortableFsApproval,
      DesktopLocalExecutionInputSchema.parse(input),
    ),
  addDirect: (input: DesktopAddDirectRouteInput) =>
    invoke<void>(desktopBridgeChannels.addDirect, DesktopAddDirectRouteInputSchema.parse(input)),
  cancel: () => invoke<void>(desktopBridgeChannels.cancel),
  checkFullDiskAccess: async () =>
    DesktopFullDiskAccessStatusSchema.parse(
      await invoke<DesktopFullDiskAccessStatus>(desktopBridgeChannels.checkFullDiskAccess),
    ),
  closeFullDiskAccessPanel: () => invoke<void>(desktopBridgeChannels.closeFullDiskAccessPanel),
  closeHostWebSocket: (input: DesktopCloseHostWebSocketInput) =>
    invoke<void>(
      desktopBridgeChannels.closeHostWebSocket,
      DesktopCloseHostWebSocketInputSchema.parse(input),
    ),
  configurePersonalRemoteAccess: async (input: DesktopConfigurePersonalRemoteAccessInput) =>
    DesktopPersonalRemoteAccessStatusSchema.parse(
      await invoke<DesktopPersonalRemoteAccessStatus>(
        desktopBridgeChannels.configurePersonalRemoteAccess,
        DesktopConfigurePersonalRemoteAccessInputSchema.parse(input),
      ),
    ),
  connectPrivate: (input: DesktopConnectPrivateDeploymentInput) =>
    invoke<void>(
      desktopBridgeChannels.connectPrivate,
      DesktopConnectPrivateDeploymentInputSchema.parse(input),
    ),
  createPersonalDeployment: () => invoke<void>(desktopBridgeChannels.createPersonalDeployment),
  createCloudDeployment: async (input: CreateCloudDeploymentRequest) =>
    CloudDeploymentOperationSchema.parse(
      await invoke<CloudDeploymentOperation>(
        desktopBridgeChannels.createCloudDeployment,
        CreateCloudDeploymentRequestSchema.parse(input),
      ),
    ),
  deleteCloudDeployment: async (input: DesktopDeleteCloudDeploymentInput) =>
    CloudDeploymentOperationSchema.parse(
      await invoke<CloudDeploymentOperation>(
        desktopBridgeChannels.deleteCloudDeployment,
        DesktopDeleteCloudDeploymentInputSchema.parse(input),
      ),
    ),
  getDeploymentAccessSnapshot: async () =>
    DeploymentAccessSnapshotSchema.parse(
      await invoke<DeploymentAccessSnapshot>(desktopBridgeChannels.getDeploymentAccessSnapshot),
    ),
  getLocalExecutionStatus: (input: DesktopLocalExecutionInput) =>
    invoke<DesktopLocalExecutionStatus>(
      desktopBridgeChannels.getLocalExecutionStatus,
      DesktopLocalExecutionInputSchema.parse(input),
    ),
  listCloudDeployments: async () =>
    ListCloudDeploymentsResponseSchema.parse(
      await invoke<ListCloudDeploymentsResponse>(desktopBridgeChannels.listCloudDeployments),
    ),
  getPersonalRemoteAccessStatus: async () =>
    DesktopPersonalRemoteAccessStatusSchema.parse(
      await invoke<DesktopPersonalRemoteAccessStatus>(
        desktopBridgeChannels.getPersonalRemoteAccessStatus,
      ),
    ),
  hostRequest: async (input: DesktopHostHttpRequest) =>
    DesktopHostHttpResultSchema.parse(
      await invoke<DesktopHostResult<DesktopHostHttpResponse>>(
        desktopBridgeChannels.hostRequest,
        DesktopHostHttpRequestSchema.parse(input),
      ),
    ),
  hostBinaryOpen: async (input: DesktopHostBinaryOpenInput) =>
    DesktopHostBinaryOpenResponseSchema.parse(
      await invoke<DesktopHostResult<DesktopHostBinaryOpenResult>>(
        desktopBridgeChannels.hostBinaryOpen,
        DesktopHostBinaryOpenInputSchema.parse(input),
      ),
    ),
  hostBinaryWrite: async (input: DesktopHostBinaryWriteInput) =>
    DesktopHostVoidResultSchema.parse(
      await invoke<DesktopHostResult<null>>(
        desktopBridgeChannels.hostBinaryWrite,
        DesktopHostBinaryWriteInputSchema.parse(input),
      ),
    ),
  hostBinaryFinish: async (input: DesktopHostBinaryTransferInput) =>
    DesktopHostHttpResultSchema.parse(
      await invoke<DesktopHostResult<DesktopHostHttpResponse>>(
        desktopBridgeChannels.hostBinaryFinish,
        DesktopHostBinaryTransferInputSchema.parse(input),
      ),
    ),
  hostBinaryRead: async (input: DesktopHostBinaryTransferInput) =>
    DesktopHostBinaryReadResponseSchema.parse(
      await invoke<DesktopHostResult<DesktopHostBinaryReadResult>>(
        desktopBridgeChannels.hostBinaryRead,
        DesktopHostBinaryTransferInputSchema.parse(input),
      ),
    ),
  hostBinaryClose: async (input: DesktopHostBinaryTransferInput) =>
    DesktopHostVoidResultSchema.parse(
      await invoke<DesktopHostResult<null>>(
        desktopBridgeChannels.hostBinaryClose,
        DesktopHostBinaryTransferInputSchema.parse(input),
      ),
    ),
  installPortableFs: (input: DesktopLocalExecutionInput) =>
    invoke<DesktopLocalExecutionStatus>(
      desktopBridgeChannels.installPortableFs,
      DesktopLocalExecutionInputSchema.parse(input),
    ),
  issuePersonalPairingCode: async () =>
    DesktopPersonalPairingCodeSchema.parse(
      await invoke<DesktopPersonalPairingCode>(desktopBridgeChannels.issuePersonalPairingCode),
    ),
  onDeploymentAccessSnapshotChanged: (listener: (snapshot: DeploymentAccessSnapshot) => void) => {
    const receive = (_event: Electron.IpcRendererEvent, value: unknown) => {
      listener(DeploymentAccessSnapshotSchema.parse(value));
    };
    ipcRenderer.on(desktopBridgeChannels.deploymentAccessSnapshotChanged, receive);
    return () =>
      ipcRenderer.removeListener(desktopBridgeChannels.deploymentAccessSnapshotChanged, receive);
  },
  onHostWebSocketEvent: (listener: (event: DesktopHostWebSocketEvent) => void) => {
    const receive = (_event: Electron.IpcRendererEvent, value: unknown) => {
      listener(DesktopHostWebSocketEventSchema.parse(value));
    };
    ipcRenderer.on(desktopBridgeChannels.hostWebSocketEvent, receive);
    return () => ipcRenderer.removeListener(desktopBridgeChannels.hostWebSocketEvent, receive);
  },
  onLocalExecutionStatusChanged: (listener: (status: DesktopLocalExecutionStatus) => void) => {
    const receive = (_event: Electron.IpcRendererEvent, value: unknown) => {
      listener(DesktopLocalExecutionStatusSchema.parse(value));
    };
    ipcRenderer.on(desktopBridgeChannels.localExecutionStatusChanged, receive);
    return () =>
      ipcRenderer.removeListener(desktopBridgeChannels.localExecutionStatusChanged, receive);
  },
  onPersonalRemoteAccessStatusChanged: (
    listener: (status: DesktopPersonalRemoteAccessStatus) => void,
  ) => {
    const receive = (_event: Electron.IpcRendererEvent, value: unknown) => {
      listener(DesktopPersonalRemoteAccessStatusSchema.parse(value));
    };
    ipcRenderer.on(desktopBridgeChannels.personalRemoteAccessStatusChanged, receive);
    return () =>
      ipcRenderer.removeListener(desktopBridgeChannels.personalRemoteAccessStatusChanged, receive);
  },
  onNotificationActivated: (listener: (target: DesktopNotificationTarget) => void) => {
    const receive = (_event: Electron.IpcRendererEvent, value: unknown) => {
      listener(DesktopNotificationTargetSchema.parse(value));
    };
    ipcRenderer.on(desktopBridgeChannels.notificationActivated, receive);
    return () => ipcRenderer.removeListener(desktopBridgeChannels.notificationActivated, receive);
  },
  getNotificationSupport: async () =>
    DesktopNotificationSupportSchema.parse(
      await invoke<DesktopNotificationSupport>(desktopBridgeChannels.getNotificationSupport),
    ),
  showNotification: async (input: DesktopNotificationTarget) =>
    DesktopNotificationResultSchema.parse(
      await invoke<DesktopNotificationResult>(
        desktopBridgeChannels.showNotification,
        DesktopNotificationTargetSchema.parse(input),
      ),
    ),
  setBadgeCount: (input: DesktopBadgeCountInput) =>
    invoke<void>(desktopBridgeChannels.setBadgeCount, DesktopBadgeCountInputSchema.parse(input)),
  openExternalUrl: async (input: DesktopOpenExternalUrlInput) =>
    DesktopOpenExternalUrlResultSchema.parse(
      await invoke<DesktopOpenExternalUrlResult>(
        desktopBridgeChannels.openExternalUrl,
        DesktopOpenExternalUrlInputSchema.parse(input),
      ),
    ),
  openHostWebSocket: async (input: DesktopOpenHostWebSocketInput) =>
    DesktopOpenHostWebSocketResultSchema.parse(
      await invoke<DesktopOpenHostWebSocketResult>(
        desktopBridgeChannels.openHostWebSocket,
        DesktopOpenHostWebSocketInputSchema.parse(input),
      ),
    ),
  openIntegrationAuthorization: async (input: DesktopOpenIntegrationAuthorizationInput) =>
    DesktopOpenIntegrationAuthorizationResultSchema.parse(
      await invoke<DesktopOpenIntegrationAuthorizationResult>(
        desktopBridgeChannels.openIntegrationAuthorization,
        DesktopOpenIntegrationAuthorizationInputSchema.parse(input),
      ),
    ),
  openPortableFsSetup: (input: DesktopLocalExecutionInput) =>
    invoke<DesktopLocalExecutionStatus>(
      desktopBridgeChannels.openPortableFsSetup,
      DesktopLocalExecutionInputSchema.parse(input),
    ),
  pickFolder: async () =>
    DesktopPickFolderResultSchema.parse(
      await invoke<DesktopPickFolderResult>(desktopBridgeChannels.pickFolder),
    ),
  reauthorize: () => invoke<void>(desktopBridgeChannels.reauthorize),
  checkDeployments: () => invoke<void>(desktopBridgeChannels.checkDeployments),
  refreshDirectory: () => invoke<void>(desktopBridgeChannels.refreshDirectory),
  removeFromAccount: (input: DesktopRemoveAccountDeploymentInput) =>
    invoke<void>(
      desktopBridgeChannels.removeFromAccount,
      DesktopRemoveAccountDeploymentInputSchema.parse(input),
    ),
  linkPersonal: () => invoke<void>(desktopBridgeChannels.linkPersonal),
  retry: () => invoke<void>(desktopBridgeChannels.retry),
  requestFullDiskAccess: async () =>
    DesktopRequestFullDiskAccessResultSchema.parse(
      await invoke<DesktopRequestFullDiskAccessResult>(desktopBridgeChannels.requestFullDiskAccess),
    ),
  retryCloudDeployment: async (input: DesktopCloudDeploymentOperationInput) =>
    CloudDeploymentOperationSchema.parse(
      await invoke<CloudDeploymentOperation>(
        desktopBridgeChannels.retryCloudDeployment,
        DesktopCloudDeploymentOperationInputSchema.parse(input),
      ),
    ),
  select: (input: DesktopSelectDeploymentInput) =>
    invoke<void>(desktopBridgeChannels.select, DesktopSelectDeploymentInputSchema.parse(input)),
  sendHostWebSocket: (input: DesktopHostWebSocketCommand) =>
    invoke<void>(
      desktopBridgeChannels.sendHostWebSocket,
      DesktopHostWebSocketCommandSchema.parse(input),
    ),
  signIn: () => invoke<void>(desktopBridgeChannels.signIn),
  signOut: () => invoke<void>(desktopBridgeChannels.signOut),
  startLocalRunner: (input: DesktopStartLocalRunnerInput) =>
    invoke<DesktopLocalExecutionStatus>(
      desktopBridgeChannels.startLocalRunner,
      DesktopStartLocalRunnerInputSchema.parse(input),
    ),
  stopLocalRunner: (input: DesktopLocalExecutionInput) =>
    invoke<DesktopLocalExecutionStatus>(
      desktopBridgeChannels.stopLocalRunner,
      DesktopLocalExecutionInputSchema.parse(input),
    ),
  unlinkPersonal: () => invoke<void>(desktopBridgeChannels.unlinkPersonal),
});

contextBridge.exposeInMainWorld("opensteerDesktop", bridge);
