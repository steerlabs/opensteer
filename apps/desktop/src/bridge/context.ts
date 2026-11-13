import type { DesktopWebLinks } from "../app/web-links.js";
import type { DesktopPasskeyRequests } from "../passkeys/passkey-requests.js";
import type { DesktopDownloads } from "../downloads/desktop-downloads.js";
import type { DesktopUpdater } from "../app/desktop-updater.js";
import type { DesktopBrowserPresentationManager } from "../browser/browser-presentation.js";
import type { IpcMain, IpcMainInvokeEvent, NativeImage, WebContents, WebFrameMain } from "electron";
import type { DesktopUpdates } from "@opensteer/client/connections";
import type { DeploymentId } from "@opensteer/core";
import type {
  DesktopComputerAppSetupStatus,
  DesktopComputerAppSetupTarget,
  DesktopOpenComputerAppSetupInput,
  DesktopOpenComputerAppSetupResult,
  DesktopComputerUseSettingsPane,
  DesktopPasswordsStatus,
  DesktopUseComputerViewInput,
  DesktopUseComputerViewResult,
  DesktopAgentPhoneArtifact,
  DesktopChooseUsbDeviceInput,
  DesktopLocalExecutionStatus,
  DesktopTailscaleShareResult,
  DesktopTailscaleStatus,
} from "@opensteer/protocol/desktop";
import type { DeploymentAccessService } from "../connections/deployment-access-service.js";
import type { DesktopHostTransport } from "../connections/host-transport.js";
import type { LocalRunnerService } from "../supervisor/local-runner-service.js";
import type { ComputerUsePermissions } from "@opensteer/protocol";
import type { ComputerUseRunnerTargetResult } from "../supervisor/local-runner-authority.js";

export interface BridgeEnvelope {
  readonly bridgeToken: string;
  readonly input?: unknown;
}

export interface DesktopBridgeOptions {
  readonly mcpAuthorizationLinks?: Pick<
    import("../app/mcp-authorization-links.js").McpAuthorizationLinks,
    "clear"
  >;
  readonly accountLinkCourier?: Pick<
    import("@opensteer/client/connections").AccountDeploymentDirectoryService,
    "issuePersonalHostAccountLinkChallenge" | "completePersonalHostAccountLink"
  >;
  readonly webLinks?: DesktopWebLinks;
  readonly integrationAuthorizations?: import("../app/integration-authorizations.js").DesktopIntegrationAuthorizations;
  readonly isWorkspaceContents?: (
    sender: Pick<WebContents, "send" | "once" | "removeListener" | "isDestroyed">,
  ) => boolean;
  readonly passkeys?: Pick<DesktopPasskeyRequests, "available" | "present">;
  readonly dictation?: import("../dictation/dictation-service.js").DictationService;
  readonly downloads: Pick<DesktopDownloads, "snapshot" | "subscribe" | "open" | "show" | "cancel">;
  /** Pinned to one Deployment, selected or not, and independent of attachment. */
  readonly deploymentUpdates?: (deploymentId: DeploymentId) => DesktopUpdates;
  readonly updates?: Pick<DesktopUpdater, "state" | "subscribe" | "download" | "setChannel"> & {
    /** Restarts into the downloaded version, refusing an unavailable or reserved action. */
    restart(): void | Promise<void>;
  };
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
    readonly adb?: Pick<
      import("../app/agent-phone-adb-server.js").AgentPhoneAdbServer,
      "open" | "call" | "close"
    >;
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

    /**
     * Waits for this Mac's answer to one of the Deployment's setup requests by
     * id, which reaches this Mac through its Runner like every other.
     */

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

    /** Answers for the panel whose own contents are `sender`, and no other. */

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
  readonly fullDiskAccess: {
    readonly check: () => Promise<boolean>;
    readonly closePanel: () => Promise<void>;
    readonly request: () => Promise<void>;
  };
  readonly teamLinks?: import("../app/team-links.js").DesktopTeamLinks;
  /** Account's hosted-team calls; absent without an Account service. */
  readonly accountTeams?: import("@opensteer/client/team").AccountTeamsClient | null;
  /** Entering teams with the Account's identity; absent without an Account service. */
  readonly teamSessions?: import("../app/team-sessions.js").DesktopTeamSessions | null;
  readonly personalDataReset?: {
    oldData(): import("@opensteer/protocol/desktop").DesktopPersonalOldDataState | null;
    startFresh(): Promise<void>;
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
    readonly status: () => Promise<DesktopPasswordsStatus>;
    readonly subscribe: (listener: (status: DesktopPasswordsStatus) => void) => () => void;
  };
  readonly notifications: {
    /** This app's page in the system's notification settings, where the system has one. */
    readonly openSettings: () => Promise<void>;
  };
  readonly tailscale: {
    readonly share: () => Promise<DesktopTailscaleShareResult>;
    readonly status: () => Promise<DesktopTailscaleStatus>;
  };
  readonly portal: {
    readonly openExternal: (url: string) => Promise<void>;
    /** The chosen folder, or null when the dialog was closed without one. */
    readonly pickFolder: () => Promise<string | null>;
  };
  readonly runner: Pick<
    LocalRunnerService,
    | "recheckEngines"
    | "status"
    | "subscribe"
    | "setUpDevice"
    | "prepareDeviceSetup"
    | "accountSignOutPreview"
    | "signDeviceSessionBinding"
    | "leaveDeployment"
    | "retryDeviceConnection"
  >;
}

export interface DesktopBridgeContext {
  readonly downloadsSenders: Set<WebContents>;
  readonly updatesSenders: Set<WebContents>;
  readonly accessSenders: Set<WebContents>;
  readonly localExecutionSenders: Map<WebContents, DeploymentId>;
  readonly options: DesktopBridgeOptions;
  readonly passwordsSenders: Set<WebContents>;
  /**
   * Sign-in toolbars that read their window through the bridge: the only
   * renderers a window's change is pushed to, and each only its own.
   */
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
