import type {
  BrowserActionErrorCode,
  BrowserActionEvent,
  BrowserActionRequest,
  BrowserActionResult,
  BrowserAttachTicketClaims,
  BrowserClientMessage,
  BrowserDialog,
  BrowserRuntimeActivity,
  BrowserServerMessage,
  BrowserSurface,
  HeldLocalProfile,
  LocalProfileBinding,
} from "@opensteer/protocol/browser";
import type { EditingContext } from "@opensteer/protocol/editing";
import type {
  BrowserRelayToHostMessage,
  RoutedHostToBrowserRelayMessage,
} from "@opensteer/protocol/browser-relay";
import type { RunnerAuxiliaryFrameFence } from "@opensteer/protocol/runner-auxiliary";
import type { ReplayLedgerState } from "@opensteer/browser-core/attach-ticket-policy";

export interface Epoch {
  readonly epoch: number;
}
export interface NativeTabRef extends Epoch {
  readonly sessionId: string;
  readonly tabId: string;
  readonly generation: number;
}
export interface NativeDocumentRef extends NativeTabRef {
  readonly documentId: string;
  readonly geometryRevision: number;
}
export interface NativeTabMetadata {
  readonly generation: number;
  readonly revision: number;
  readonly documentId: string;
  readonly geometryRevision: number;
  readonly captureRevision: number;
  readonly title: string;
  readonly url: string;
  readonly loading: boolean;
  readonly navigationFailed: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly width: number;
  readonly height: number;
}
export interface NativeQualification {
  readonly platform: "ios" | "android";
  readonly runtimeId: string;
  readonly storageInstanceId: string;
  readonly browser: boolean;
  readonly sharedControl: boolean;
  readonly agentActions: boolean;
  readonly cdpBoundary: boolean;
  readonly fileStaging: boolean;
}
export interface VerifiedAttach {
  readonly claims: BrowserAttachTicketClaims;
  readonly claimsDigest: string;
  readonly replayState: ReplayLedgerState;
  readonly maxReplayEntries: number;
}
export type NativeViewerMessage = Extract<
  BrowserServerMessage,
  {
    type:
      | "browser.cursor"
      | "browser.editing"
      | "browser.activity"
      | "browser.stream.state"
      | "browser.contextmenu"
      | "clipboard.result"
      | "clipboard.part"
      | "clipboard.data";
  }
>;

type AttachCommand = Extract<RoutedHostToBrowserRelayMessage, { type: "browser.attach" }>;
export type PhoneRelayCommand =
  | Exclude<RoutedHostToBrowserRelayMessage, AttachCommand | { type: `host.auxiliary.${string}` }>
  | (Omit<AttachCommand, "attachTicket"> & { readonly attachHandle: string });

export type PhoneBrowserNativeEvent =
  | {
      readonly type: "connection";
      readonly state: "offline";
      readonly reason: string;
      readonly fence: RunnerAuxiliaryFrameFence;
    }
  | {
      readonly type: "connection";
      readonly state: "online";
      readonly fence: RunnerAuxiliaryFrameFence;
      readonly leaseDeadline: number;
    }
  | {
      readonly type: "relayCommand";
      readonly message: PhoneRelayCommand;
      /** Native strips Opensteer.openTab's operationAuthority ticket as well. */
      readonly authorityHandle?: string;
    }
  | (NativeTabRef & { readonly type: "closed" })
  | (NativeTabRef & { readonly type: "tabChanged"; readonly metadata: NativeTabMetadata })
  | (NativeTabRef & { readonly type: "documentChanged"; readonly metadata: NativeTabMetadata })
  | (NativeTabRef & {
      readonly type: "navigationCommitted";
      readonly metadata: NativeTabMetadata;
      readonly navigationId: string;
    })
  | (NativeTabRef & {
      readonly type: "popup";
      readonly openerId: string;
      readonly metadata: NativeTabMetadata;
      readonly consumerToken?: string;
    })
  | (NativeDocumentRef & { readonly type: "dialog" } & (
        { readonly dialog: BrowserDialog } | { readonly dialog: null; readonly dialogId: string }
      ))
  | (NativeDocumentRef & {
      readonly type: "upload";
      readonly chooserId: string;
      readonly accept: readonly string[];
      readonly multiple: boolean;
    })
  | (NativeTabRef & {
      readonly type: "download";
      readonly downloadId: string;
      readonly state: "receiving" | "complete" | "failed";
      readonly name: string;
      readonly received: number;
      readonly total?: number;
    })
  | (NativeTabRef & { readonly type: "geometry"; readonly metadata: NativeTabMetadata })
  | (NativeDocumentRef & {
      readonly type: "activity";
      readonly channelId: string;
      readonly report: BrowserRuntimeActivity;
    })
  | (NativeDocumentRef & {
      readonly type: "editing";
      readonly channelId: string;
      readonly context: EditingContext;
    })
  | (NativeDocumentRef & {
      readonly type: "serverMessage";
      readonly channelId: string;
      readonly message: NativeViewerMessage;
    })
  | (Epoch & {
      readonly type: "agentEvent";
      readonly attachmentId: string;
      readonly event: BrowserActionEvent;
    })
  | (Epoch & {
      readonly type: "cdpEvent";
      readonly pipeHandle: string;
      readonly method: string;
      readonly params: Readonly<Record<string, unknown>>;
    })
  | (Epoch & { readonly type: "memoryPressure"; readonly level: "warning" | "critical" })
  | (Epoch & { readonly type: "rendererGone"; readonly tabs: readonly NativeTabRef[] });

export class PhoneBrowserError extends Error {
  readonly code: BrowserActionErrorCode;
  constructor(code: BrowserActionErrorCode, message: string) {
    super(message);
    this.name = "PhoneBrowserError";
    this.code = code;
  }
}

/** Native owns deadlines, authority revalidation, transport, keys, storage and all pixels. */
export interface PhoneBrowserNativePort {
  initialize(
    input: Epoch & { deploymentId: string; runnerId: string },
  ): Promise<NativeQualification>;
  /** Stops admission/captures/pipes and cancels dialogs/choosers; reports unavailable before draining. */
  fence(reason: string): number;
  setForeground(input: Epoch & { active: boolean }): Promise<void>;
  onEvent(listener: (event: PhoneBrowserNativeEvent) => Promise<void>): () => void;
  verifyAttach(input: Epoch & { attachHandle: string }): Promise<VerifiedAttach>;
  /** Atomically compares the native ledger witness, fsyncs the claim, then permits allocation. */
  commitAttach(
    input: Epoch & {
      attachHandle: string;
      claimsDigest: string;
      replayTransition: ReplayLedgerState;
    },
  ): Promise<string>;
  sendRelay(input: Epoch & { message: BrowserRelayToHostMessage }): Promise<void>;
  closeChannel(input: Epoch & { channelId: string; code: number }): Promise<void>;
  ensureProfile(
    input: Epoch & {
      binding: LocalProfileBinding;
      initialized: boolean;
      allocationPermit: string;
    },
  ): Promise<string>;
  listProfiles(input: Epoch & { deploymentId: string }): Promise<readonly HeldLocalProfile[]>;
  eraseProfile(
    input: Epoch & {
      binding: LocalProfileBinding;
      deletionId: string;
    },
  ): Promise<"deleted" | "pending-restart">;
  eraseDeployment(input: Epoch & { deploymentId: string }): Promise<readonly HeldLocalProfile[]>;
  createTab(
    input: Epoch & {
      sessionId: string;
      tabId: string;
      allocationPermit: string;
      storeHandle: string | null;
      state: "live" | "retained";
      restoreFrom?: { readonly sessionId: string; readonly generation: number };
      viewport: { width: number; height: number };
      url?: string;
      navigationId?: string;
    },
  ): Promise<NativeTabMetadata>;
  destroyTab(input: NativeTabRef): Promise<void>;
  suspendTab(input: NativeTabRef & { state: "retained" | "discarded" }): Promise<void>;
  resumeTab(input: NativeTabRef): Promise<NativeTabMetadata>;
  mountTab(
    input: NativeTabRef & {
      hostId: string;
      presentationGeneration: number;
      interactive: boolean;
    },
  ): Promise<NativeTabMetadata>;
  unmountTab(input: NativeTabRef & { presentationGeneration: number }): Promise<void>;
  resizeTab(
    input: NativeDocumentRef & { width: number; height: number },
  ): Promise<NativeTabMetadata>;
  navigate(
    input: NativeDocumentRef & {
      kind: "go" | "back" | "forward" | "reload" | "stop";
      url?: string;
      ignoreCache?: boolean;
      navigationId?: string;
    },
  ): Promise<void>;
  respondDialog(
    input: NativeDocumentRef & {
      dialogId: string;
      accept: boolean;
      promptText?: string;
    },
  ): Promise<void>;
  respondUpload(
    input: NativeDocumentRef & {
      chooserId: string;
      stagedFileIds: readonly string[];
    },
  ): Promise<readonly { fileId: string; name: string; size: number }[]>;
  attachAgent(
    input: Epoch & {
      channelId: string;
      sessionId: string;
      attachmentId: string;
      actorToken: string;
      backend: "actions" | "cdp";
    },
  ): Promise<void>;
  detachAgent(input: Epoch & { attachmentId: string }): Promise<void>;
  /** The page.capture result is written directly to the admitted route, never returned as JS bytes. */
  performAction(
    input: NativeDocumentRef & {
      channelId: string;
      attachmentId: string;
      actorToken: string;
      requestId: string;
      deadline: number;
      request: BrowserActionRequest;
    },
  ): Promise<Exclude<BrowserActionResult, { type: "page.capture" }> | { type: "delivered" }>;
  applyViewerInput(
    input: NativeDocumentRef & {
      channelId: string;
      message: BrowserClientMessage;
    },
  ): Promise<void>;
  setCaptureDemand(
    input: NativeTabRef & {
      channelId: string;
      density: number;
      frames: boolean;
      frameWindow?: 1;
      maxFps: 8;
    },
  ): Promise<void>;
  ackFrame(input: NativeTabRef & { channelId: string; token: string }): Promise<void>;
  captureOnce(
    input: NativeDocumentRef & {
      channelId: string;
      requestId: string;
      attachmentId: string;
      format: "png" | "jpeg";
      quality?: number;
      clip?: { x: number; y: number; width: number; height: number };
    },
  ): Promise<string>;
  /** Checks native attachment authority; releasing the last permit disables debugging. */
  authorizeCdp(
    input: Epoch & {
      channelId: string;
      actorToken: string;
    },
  ): Promise<{ attachmentId: string; filesRoot: string }>;
  openCdpPipe(input: NativeDocumentRef & { attachmentId: string }): Promise<string>;
  sendCdp(
    input: NativeDocumentRef & {
      pipeHandle: string;
      id: number;
      method: string;
      params: Readonly<Record<string, unknown>>;
    },
  ): Promise<unknown>;
  closeCdpPipe(input: Epoch & { pipeHandle: string }): Promise<void>;
  releaseCdp(input: Epoch & { attachmentId: string }): Promise<void>;
  stageChunk(
    input: Epoch & {
      sessionId: string;
      fileId: string;
      name: string;
      offset: number;
      data: string;
      size?: number;
    },
  ): Promise<{ fileId: string; complete: boolean }>;
  finishSessionFiles(input: Epoch & { sessionId: string }): Promise<void>;
  cancelDownload(input: Epoch & { sessionId: string; downloadId: string }): Promise<void>;
}

export type PhoneSurface = BrowserSurface & { readonly documentId: string };
