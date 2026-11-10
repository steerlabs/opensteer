import type {
  BrowserActionEvent,
  BrowserActionRequest,
  BrowserActionResult,
  BrowserClientMessage,
  BrowserDialog,
  BrowserRuntimeActivity,
  HeldLocalProfile,
  LocalProfileBinding,
} from "@opensteer/protocol/browser";
import type { EditingContext } from "@opensteer/protocol/editing";
import type { NativeSyntheticEvent, ViewProps } from "react-native";
import type {
  NativeViewerMessage,
  PhoneBrowserNativePort as ManagerPort,
} from "../../src/phone-browser/native-port.js";

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

export type PhoneBrowserNativeEvent =
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
      readonly type: "cdpEvent";
      readonly pipeHandle: string;
      readonly method: string;
      readonly params: Readonly<Record<string, unknown>>;
    })
  | (Epoch & {
      readonly type: "agentEvent";
      readonly attachmentId: string;
      readonly event: BrowserActionEvent;
    })
  | (Epoch & { readonly type: "memoryPressure"; readonly level: "warning" | "critical" })
  | (Epoch & { readonly type: "rendererGone"; readonly tabs: readonly NativeTabRef[] });

export interface PhoneBrowserNativePort extends Pick<
  ManagerPort,
  | "attachAgent"
  | "detachAgent"
  | "authorizeCdp"
  | "openCdpPipe"
  | "sendCdp"
  | "closeCdpPipe"
  | "releaseCdp"
> {
  initialize(
    input: Epoch & { deploymentId: string; runnerId: string },
  ): Promise<NativeQualification>;
  fence(reason: string): number;
  setForeground(input: Epoch & { active: boolean }): Promise<void>;
  onEvent(listener: (event: PhoneBrowserNativeEvent) => Promise<void>): () => void;
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

/** Where the presented page is scrolled, from its top: `end` is the furthest it scrolls. */
export interface PhoneBrowserPageScroll {
  readonly y: number;
  readonly end: number;
  /** The person's finger moved it, or its fling is still carrying it. */
  readonly person: boolean;
}

export type PhoneBrowserHostProps = ViewProps & {
  hostId: string;
  onReady?: (event: NativeSyntheticEvent<{ hostId: string }>) => void;
  /** The page's own controls float over these edges: the page lays out clear of them without changing size. */
  barInsets?: { readonly top: number; readonly bottom: number } | null;
  /** Pull to refresh and edge swipes through the page's history, while its page is here. */
  pageGestures?: boolean;
  /** Whether `onPageScroll` is sent; nothing crosses per frame otherwise. */
  pageScroll?: boolean;
  onPageScroll?: (event: NativeSyntheticEvent<PhoneBrowserPageScroll>) => void;
};
export type PhoneBrowserPictureProps = ViewProps & { tabId: string };
export type PhoneBrowserDownloadProps = ViewProps & { downloadId: string };
