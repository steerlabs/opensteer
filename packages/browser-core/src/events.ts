import type {
  ChooserRef,
  DialogRef,
  DocumentEpoch,
  DocumentRef,
  DownloadRef,
  FrameRef,
  PageRef,
  SessionRef,
  WorkerRef,
} from "./identity.js";

export type ConsoleLevel = "debug" | "log" | "info" | "warn" | "error" | "trace";

interface StepEventBase {
  readonly eventId: string;
  readonly kind: string;
  readonly timestamp: number;
  readonly sessionRef: SessionRef;
  readonly pageRef?: PageRef;
  readonly frameRef?: FrameRef;
  readonly documentRef?: DocumentRef;
  readonly documentEpoch?: DocumentEpoch;
}

export interface PageCreatedStepEvent extends StepEventBase {
  readonly kind: "page-created";
  readonly pageRef: PageRef;
}

export interface PopupOpenedStepEvent extends StepEventBase {
  readonly kind: "popup-opened";
  readonly pageRef: PageRef;
  readonly openerPageRef: PageRef;
}

export interface PageClosedStepEvent extends StepEventBase {
  readonly kind: "page-closed";
  readonly pageRef: PageRef;
}

export interface DialogOpenedStepEvent extends StepEventBase {
  readonly kind: "dialog-opened";
  readonly dialogRef: DialogRef;
  readonly dialogType: "alert" | "beforeunload" | "confirm" | "prompt";
  readonly message: string;
  readonly defaultValue?: string;
}

export interface DownloadStartedStepEvent extends StepEventBase {
  readonly kind: "download-started";
  readonly downloadRef: DownloadRef;
  readonly url: string;
  readonly suggestedFilename?: string;
}

export interface DownloadFinishedStepEvent extends StepEventBase {
  readonly kind: "download-finished";
  readonly downloadRef: DownloadRef;
  readonly state: "completed" | "canceled" | "failed";
  readonly filePath?: string;
}

export interface ChooserOpenedStepEvent extends StepEventBase {
  readonly kind: "chooser-opened";
  readonly chooserRef: ChooserRef;
  readonly chooserType: "file" | "select";
  readonly multiple: boolean;
  readonly options?: readonly {
    readonly index: number;
    readonly label: string;
    readonly value: string;
    readonly selected: boolean;
  }[];
}

export interface WorkerCreatedStepEvent extends StepEventBase {
  readonly kind: "worker-created";
  readonly workerRef: WorkerRef;
  readonly workerType: "dedicated" | "shared" | "service";
  readonly url: string;
}

export interface WorkerDestroyedStepEvent extends StepEventBase {
  readonly kind: "worker-destroyed";
  readonly workerRef: WorkerRef;
  readonly workerType: "dedicated" | "shared" | "service";
  readonly url: string;
}

export interface ConsoleStepEvent extends StepEventBase {
  readonly kind: "console";
  readonly level: ConsoleLevel;
  readonly text: string;
  readonly location?: {
    readonly url?: string;
    readonly lineNumber?: number;
    readonly columnNumber?: number;
  };
}

export interface PageErrorStepEvent extends StepEventBase {
  readonly kind: "page-error";
  readonly message: string;
  readonly stack?: string;
}

export interface WebSocketOpenedStepEvent extends StepEventBase {
  readonly kind: "websocket-opened";
  readonly socketId: string;
  readonly url: string;
}

export interface WebSocketFrameStepEvent extends StepEventBase {
  readonly kind: "websocket-frame";
  readonly socketId: string;
  readonly direction: "sent" | "received";
  readonly opcode?: number;
  readonly payloadPreview?: string;
}

export interface WebSocketClosedStepEvent extends StepEventBase {
  readonly kind: "websocket-closed";
  readonly socketId: string;
  readonly code?: number;
  readonly reason?: string;
}

export interface EventStreamMessageStepEvent extends StepEventBase {
  readonly kind: "event-stream-message";
  readonly streamId: string;
  readonly eventName?: string;
  readonly dataPreview?: string;
}

export interface PausedStepEvent extends StepEventBase {
  readonly kind: "paused";
  readonly reason?: string;
}

export interface ResumedStepEvent extends StepEventBase {
  readonly kind: "resumed";
  readonly reason?: string;
}

export interface FrozenStepEvent extends StepEventBase {
  readonly kind: "frozen";
  readonly reason?: string;
}

export type StepEvent =
  | PageCreatedStepEvent
  | PopupOpenedStepEvent
  | PageClosedStepEvent
  | DialogOpenedStepEvent
  | DownloadStartedStepEvent
  | DownloadFinishedStepEvent
  | ChooserOpenedStepEvent
  | WorkerCreatedStepEvent
  | WorkerDestroyedStepEvent
  | ConsoleStepEvent
  | PageErrorStepEvent
  | WebSocketOpenedStepEvent
  | WebSocketFrameStepEvent
  | WebSocketClosedStepEvent
  | EventStreamMessageStepEvent
  | PausedStepEvent
  | ResumedStepEvent
  | FrozenStepEvent;

export interface StepResult<TData = void> {
  readonly stepId: string;
  readonly sessionRef: SessionRef;
  readonly pageRef?: PageRef;
  readonly frameRef?: FrameRef;
  readonly documentRef?: DocumentRef;
  readonly documentEpoch?: DocumentEpoch;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly durationMs: number;
  readonly events: readonly StepEvent[];
  readonly data: TData;
}
