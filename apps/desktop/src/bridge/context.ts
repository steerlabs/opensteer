import type { DesktopWebLinks } from "../app/web-links.js";
import type { DesktopDownloads } from "../downloads/desktop-downloads.js";
import type { DesktopBrowserPresentationManager } from "../browser/browser-presentation.js";
import type { PasswordsSignInOperations } from "../passwords/sign-in-operations.js";
import type { IpcMain, IpcMainInvokeEvent, NativeImage, WebContents, WebFrameMain } from "electron";
import type { DeploymentId } from "@opensteer/core";
import type {
  DesktopComputerAppSetupStatus,
  DesktopComputerAppSetupTarget,
  DesktopOpenComputerAppSetupInput,
  DesktopOpenComputerAppSetupResult,
  DesktopComputerUseApprovalKeyResult,
  DesktopComputerUseApprovalPresentation,
  DesktopComputerUseSettingsPane,
  DesktopPasswordsStatus,
  DesktopReviewComputerAppSetupResult,
  DesktopUseComputerViewInput,
  DesktopUseComputerViewResult,
  DesktopAgentPhoneArtifact,
  DesktopChooseUsbDeviceInput,
  DesktopLocalExecutionStatus,
} from "@opensteer/protocol/desktop";
import type { DeploymentAccessService } from "../connections/deployment-access-service.js";
import type { DesktopHostTransport } from "../connections/host-transport.js";
import type { DesktopPersonalRemoteAccessService } from "../connections/personal-remote-access.js";
import type { LocalRunnerService } from "../supervisor/local-runner-service.js";
import type { AccountConnectClient } from "@opensteer/client/connections";
import type { ComputerUsePermissions } from "@opensteer/protocol";
import type { ComputerUseRunnerTargetResult } from "../supervisor/local-runner-authority.js";

export interface BridgeEnvelope {
  readonly bridgeToken: string;
  readonly input?: unknown;
}

export interface DesktopBridgeOptions {
  readonly webLinks?: DesktopWebLinks;
  readonly isWorkspaceContents?: (
    sender: Pick<WebContents, "send" | "once" | "removeListener" | "isDestroyed">,
  ) => boolean;
  readonly dictation?: import("../dictation/dictation-service.js").DictationService;
  readonly downloads: Pick<DesktopDownloads, "snapshot" | "subscribe" | "open" | "show" | "cancel">;
  readonly log?: (
    event: string,
    fields: Readonly<Record<string, string | number | boolean>>,
  ) => void;
  readonly browserPresentation?: DesktopBrowserPresentationManager;
  readonly access: Pick<
    DeploymentAccessService,
    | "addDirect"
    | "cancel"
    | "checkDeployments"
    | "connectPrivate"
    | "createPersonalDeployment"
    | "linkPersonal"
    | "reauthorize"
    | "refreshDirectory"
    | "removeFromAccount"
    | "retry"
    | "select"
    | "signIn"
    | "signOut"
    | "snapshot"
    | "subscribe"
    | "unlinkPersonal"
  >;
  /** Setting an Android phone up over USB from this window. */
  readonly agentPhone: {
    /** The Agent Phone app this build carries, verified; null when it carries none. */
    readonly readArtifact: () => Promise<DesktopAgentPhoneArtifact | null>;
    /** The page's pick between several phones, from the frame that was asked. */
    readonly chooseUsbDevice: (
      input: DesktopChooseUsbDeviceInput,
      frame: WebFrameMain | null,
    ) => void;
  };
  readonly localVisibility: {
    readonly getSnapshot: () => boolean;
    readonly subscribe: (listener: (visible: boolean) => void) => () => void;
  };
  readonly bridgeToken: string;
  readonly computerApps: {
    /** This desktop's approval key's public half, for the page on this Mac to register. */
    readonly approvalKey: () => Promise<DesktopComputerUseApprovalKeyResult>;
    /**
     * Waits for this Mac's answer to one of the Deployment's setup requests by
     * id, which reaches this Mac through its Runner like every other.
     */
    readonly review: (
      deploymentId: DeploymentId,
      setupRequestId: string,
    ) => Promise<DesktopReviewComputerAppSetupResult>;
    /**
     * The setup guide for apps the helper serves: one panel on this Mac that
     * takes every macOS step an app's access needs.
     */
    /** The picture macOS shows under the pointer while one file is dragged. */
    readonly dragIcon: (file: string) => Promise<NativeImage>;
    readonly setup: {
      readonly begin: (input: DesktopComputerAppSetupTarget) => Promise<void>;
      readonly close: (input: DesktopComputerAppSetupTarget) => Promise<void>;
      /** The installed helper to drag, while that is the step; null otherwise. */
      readonly dragItem: () => { readonly file: string } | null;
      readonly open: (
        input: DesktopOpenComputerAppSetupInput,
      ) => Promise<DesktopOpenComputerAppSetupResult>;
      readonly showAgain: () => Promise<void>;
      readonly status: () => Promise<DesktopComputerAppSetupStatus>;
    };
  };
  /**
   * The two computer-use panels' own surface. The approval reads and answers a
   * token the main process minted; the permissions panel reads, asks and opens
   * one System Settings pane by name.
   */
  readonly computerUse: {
    readonly onActivationError: (error: unknown) => void;
    readonly checkLocalComputerViewTarget?: (
      deploymentId: string,
      machineId: string,
    ) => Promise<ComputerUseRunnerTargetResult>;
    readonly useComputerViewOnThisMac?: (
      input: DesktopUseComputerViewInput,
    ) => Promise<DesktopUseComputerViewResult>;
    /** Reads the presentation for the panel whose own contents are `sender`. */
    readonly approvalGet: (
      token: string,
      sender: WebContents,
    ) => DesktopComputerUseApprovalPresentation;
    /** Answers for the panel whose own contents are `sender`, and no other. */
    readonly approvalRespond: (token: string, allow: boolean, sender: WebContents) => void;
    readonly closePermissionsPanel: () => Promise<void>;
    readonly openPermissionsPanel: () => Promise<void>;
    /** Throws `AdHocSignedHelperError` when this build would refuse its own helper. */
    readonly verifyBundledHelper: () => Promise<void>;
    readonly openSystemSettings: (pane: DesktopComputerUseSettingsPane) => Promise<void>;
    readonly permissions: () => Promise<ComputerUsePermissions>;
    readonly requestPermissions: (
      pane: DesktopComputerUseSettingsPane,
    ) => Promise<ComputerUsePermissions>;
  };
  readonly cloud?: Pick<
    AccountConnectClient,
    | "createCloudDeployment"
    | "deleteCloudDeployment"
    | "listCloudDeployments"
    | "retryCloudDeployment"
  > | null;
  readonly fullDiskAccess: {
    readonly check: () => Promise<boolean>;
    readonly closePanel: () => Promise<void>;
    readonly request: () => Promise<void>;
  };
  readonly hostTransport: Pick<
    DesktopHostTransport,
    | "closeSocketsForOwner"
    | "closeBinaryForOwner"
    | "openBinary"
    | "writeBinary"
    | "finishBinary"
    | "readBinary"
    | "closeBinary"
    | "closeWebSocket"
    | "current"
    | "integrationAuthorizationOrigin"
    | "openWebSocket"
    | "request"
    | "sendWebSocket"
  >;
  readonly ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  /**
   * Opensteer Passwords on this Mac and its approval cards.
   */
  readonly passwords: {
    readonly open: () => Promise<void>;
    readonly signIns: Pick<PasswordsSignInOperations, "get" | "approve" | "subscribe">;
    readonly status: () => Promise<DesktopPasswordsStatus>;
    readonly subscribe: (listener: (status: DesktopPasswordsStatus) => void) => () => void;
  };
  readonly personalRemote: Pick<
    DesktopPersonalRemoteAccessService,
    "configure" | "issuePairingCode" | "status" | "subscribe"
  >;
  readonly portal: {
    readonly openExternal: (url: string) => Promise<void>;
    /** The chosen folder, or null when the dialog was closed without one. */
    readonly pickFolder: () => Promise<string | null>;
  };
  readonly runner: Pick<
    LocalRunnerService,
    "portableFs" | "remove" | "start" | "status" | "subscribe"
  >;
}

export interface DesktopBridgeContext {
  readonly downloadsSenders: Set<WebContents>;
  readonly accessSenders: Set<WebContents>;
  readonly localExecutionSenders: Map<WebContents, DeploymentId>;
  readonly options: DesktopBridgeOptions;
  readonly passwordsSenders: Set<WebContents>;
  /**
   * Sign-in toolbars that read their window through the bridge: the only
   * renderers a window's change is pushed to, and each only its own.
   */
  readonly passwordsSignInCards: Map<WebContents, Set<string>>;
  readonly personalRemoteSenders: Set<WebContents>;
  readonly trackedHostSenders: Set<number>;
}

export type DesktopBridgeHandler = (
  event: IpcMainInvokeEvent,
  envelope: BridgeEnvelope,
) => DesktopLocalExecutionStatus | Promise<unknown> | unknown;

export function assertAuthorizedRenderer(
  context: DesktopBridgeContext,
  event: IpcMainInvokeEvent,
  envelope: BridgeEnvelope,
): void {
  if (!envelope || envelope.bridgeToken !== context.options.bridgeToken) {
    throw new Error("Desktop bridge capability is invalid.");
  }
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) {
    throw new Error("Desktop bridge calls are allowed only from the main application frame.");
  }
  let senderUrl: URL;
  try {
    senderUrl = new URL(frame.url);
  } catch {
    throw new Error("Desktop bridge sender URL is invalid.");
  }
  if (
    senderUrl.protocol !== "app:" ||
    senderUrl.hostname !== "opensteer" ||
    senderUrl.port ||
    senderUrl.username ||
    senderUrl.password
  ) {
    throw new Error("Desktop bridge sender is not the bundled Opensteer application.");
  }
}

export function trackRenderer(senders: Set<WebContents>, sender: WebContents): void {
  if (senders.has(sender)) return;
  senders.add(sender);
  sender.once("destroyed", () => senders.delete(sender));
}

export function trackLocalExecutionRenderer(
  senders: Map<WebContents, DeploymentId>,
  sender: WebContents,
  deploymentId: DeploymentId,
): void {
  const tracked = senders.has(sender);
  senders.set(sender, deploymentId);
  if (!tracked) sender.once("destroyed", () => senders.delete(sender));
}
