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
import {
  chooserRefSchema,
  dialogRefSchema,
  documentEpochSchema,
  documentRefSchema,
  downloadRefSchema,
  frameRefSchema,
  pageRefSchema,
  sessionRefSchema,
  workerRefSchema,
} from "./identity.js";
import {
  arraySchema,
  enumSchema,
  integerSchema,
  objectSchema,
  oneOfSchema,
  stringSchema,
  type JsonSchema,
} from "./json.js";

export type ConsoleLevel = "debug" | "log" | "info" | "warn" | "error" | "trace";

interface OpensteerEventBase {
  readonly eventId: string;
  readonly kind: string;
  readonly timestamp: number;
  readonly sessionRef: SessionRef;
  readonly pageRef?: PageRef;
  readonly frameRef?: FrameRef;
  readonly documentRef?: DocumentRef;
  readonly documentEpoch?: DocumentEpoch;
}

export interface PageCreatedEvent extends OpensteerEventBase {
  readonly kind: "page-created";
  readonly pageRef: PageRef;
}

export interface PopupOpenedEvent extends OpensteerEventBase {
  readonly kind: "popup-opened";
  readonly pageRef: PageRef;
  readonly openerPageRef: PageRef;
}

export interface PageClosedEvent extends OpensteerEventBase {
  readonly kind: "page-closed";
  readonly pageRef: PageRef;
}

export interface DialogOpenedEvent extends OpensteerEventBase {
  readonly kind: "dialog-opened";
  readonly dialogRef: DialogRef;
  readonly dialogType: "alert" | "beforeunload" | "confirm" | "prompt";
  readonly message: string;
  readonly defaultValue?: string;
}

export interface DownloadStartedEvent extends OpensteerEventBase {
  readonly kind: "download-started";
  readonly downloadRef: DownloadRef;
  readonly url: string;
  readonly suggestedFilename?: string;
}

export interface DownloadFinishedEvent extends OpensteerEventBase {
  readonly kind: "download-finished";
  readonly downloadRef: DownloadRef;
  readonly state: "completed" | "canceled" | "failed";
  readonly filePath?: string;
}

export interface ChooserOpenedEvent extends OpensteerEventBase {
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

export interface WorkerCreatedEvent extends OpensteerEventBase {
  readonly kind: "worker-created";
  readonly workerRef: WorkerRef;
  readonly workerType: "dedicated" | "shared" | "service";
  readonly url: string;
}

export interface WorkerDestroyedEvent extends OpensteerEventBase {
  readonly kind: "worker-destroyed";
  readonly workerRef: WorkerRef;
  readonly workerType: "dedicated" | "shared" | "service";
  readonly url: string;
}

export interface ConsoleEvent extends OpensteerEventBase {
  readonly kind: "console";
  readonly level: ConsoleLevel;
  readonly text: string;
  readonly location?: {
    readonly url?: string;
    readonly lineNumber?: number;
    readonly columnNumber?: number;
  };
}

export interface PageErrorEvent extends OpensteerEventBase {
  readonly kind: "page-error";
  readonly message: string;
  readonly stack?: string;
}

export interface WebSocketOpenedEvent extends OpensteerEventBase {
  readonly kind: "websocket-opened";
  readonly socketId: string;
  readonly url: string;
}

export interface WebSocketFrameEvent extends OpensteerEventBase {
  readonly kind: "websocket-frame";
  readonly socketId: string;
  readonly direction: "sent" | "received";
  readonly opcode?: number;
  readonly payloadPreview?: string;
}

export interface WebSocketClosedEvent extends OpensteerEventBase {
  readonly kind: "websocket-closed";
  readonly socketId: string;
  readonly code?: number;
  readonly reason?: string;
}

export interface EventStreamMessageEvent extends OpensteerEventBase {
  readonly kind: "event-stream-message";
  readonly streamId: string;
  readonly eventName?: string;
  readonly dataPreview?: string;
}

export interface PausedEvent extends OpensteerEventBase {
  readonly kind: "paused";
  readonly reason?: string;
}

export interface ResumedEvent extends OpensteerEventBase {
  readonly kind: "resumed";
  readonly reason?: string;
}

export interface FrozenEvent extends OpensteerEventBase {
  readonly kind: "frozen";
  readonly reason?: string;
}

export type OpensteerEvent =
  | PageCreatedEvent
  | PopupOpenedEvent
  | PageClosedEvent
  | DialogOpenedEvent
  | DownloadStartedEvent
  | DownloadFinishedEvent
  | ChooserOpenedEvent
  | WorkerCreatedEvent
  | WorkerDestroyedEvent
  | ConsoleEvent
  | PageErrorEvent
  | WebSocketOpenedEvent
  | WebSocketFrameEvent
  | WebSocketClosedEvent
  | EventStreamMessageEvent
  | PausedEvent
  | ResumedEvent
  | FrozenEvent;

function eventBaseSchema(kind: string): Record<string, JsonSchema> {
  return {
    eventId: stringSchema(),
    kind: enumSchema([kind] as const),
    timestamp: integerSchema({ minimum: 0 }),
    sessionRef: sessionRefSchema,
    pageRef: pageRefSchema,
    frameRef: frameRefSchema,
    documentRef: documentRefSchema,
    documentEpoch: documentEpochSchema,
  };
}

const dialogTypeSchema = enumSchema(["alert", "beforeunload", "confirm", "prompt"] as const);
const downloadStateSchema = enumSchema(["completed", "canceled", "failed"] as const);
const chooserTypeSchema = enumSchema(["file", "select"] as const);
const workerTypeSchema = enumSchema(["dedicated", "shared", "service"] as const);
const consoleLevelSchema = enumSchema(["debug", "log", "info", "warn", "error", "trace"] as const);
const websocketDirectionSchema = enumSchema(["sent", "received"] as const);

const pageCreatedEventSchema = objectSchema(eventBaseSchema("page-created"), {
  title: "PageCreatedEvent",
  required: ["eventId", "kind", "timestamp", "sessionRef", "pageRef"],
});

const popupOpenedEventSchema = objectSchema(
  {
    ...eventBaseSchema("popup-opened"),
    openerPageRef: pageRefSchema,
  },
  {
    title: "PopupOpenedEvent",
    required: ["eventId", "kind", "timestamp", "sessionRef", "pageRef", "openerPageRef"],
  },
);

const pageClosedEventSchema = objectSchema(eventBaseSchema("page-closed"), {
  title: "PageClosedEvent",
  required: ["eventId", "kind", "timestamp", "sessionRef", "pageRef"],
});

const dialogOpenedEventSchema = objectSchema(
  {
    ...eventBaseSchema("dialog-opened"),
    dialogRef: dialogRefSchema,
    dialogType: dialogTypeSchema,
    message: stringSchema(),
    defaultValue: stringSchema(),
  },
  {
    title: "DialogOpenedEvent",
    required: ["eventId", "kind", "timestamp", "sessionRef", "dialogRef", "dialogType", "message"],
  },
);

const downloadStartedEventSchema = objectSchema(
  {
    ...eventBaseSchema("download-started"),
    downloadRef: downloadRefSchema,
    url: stringSchema(),
    suggestedFilename: stringSchema(),
  },
  {
    title: "DownloadStartedEvent",
    required: ["eventId", "kind", "timestamp", "sessionRef", "downloadRef", "url"],
  },
);

const downloadFinishedEventSchema = objectSchema(
  {
    ...eventBaseSchema("download-finished"),
    downloadRef: downloadRefSchema,
    state: downloadStateSchema,
    filePath: stringSchema(),
  },
  {
    title: "DownloadFinishedEvent",
    required: ["eventId", "kind", "timestamp", "sessionRef", "downloadRef", "state"],
  },
);

const chooserOpenedEventSchema = objectSchema(
  {
    ...eventBaseSchema("chooser-opened"),
    chooserRef: chooserRefSchema,
    chooserType: chooserTypeSchema,
    multiple: {
      type: "boolean",
    },
    options: arraySchema(
      objectSchema(
        {
          index: integerSchema({ minimum: 0 }),
          label: stringSchema(),
          value: stringSchema(),
          selected: {
            type: "boolean",
          },
        },
        {
          required: ["index", "label", "value", "selected"],
        },
      ),
    ),
  },
  {
    title: "ChooserOpenedEvent",
    required: [
      "eventId",
      "kind",
      "timestamp",
      "sessionRef",
      "chooserRef",
      "chooserType",
      "multiple",
    ],
  },
);

const workerCreatedEventSchema = objectSchema(
  {
    ...eventBaseSchema("worker-created"),
    workerRef: workerRefSchema,
    workerType: workerTypeSchema,
    url: stringSchema(),
  },
  {
    title: "WorkerCreatedEvent",
    required: ["eventId", "kind", "timestamp", "sessionRef", "workerRef", "workerType", "url"],
  },
);

const workerDestroyedEventSchema = objectSchema(
  {
    ...eventBaseSchema("worker-destroyed"),
    workerRef: workerRefSchema,
    workerType: workerTypeSchema,
    url: stringSchema(),
  },
  {
    title: "WorkerDestroyedEvent",
    required: ["eventId", "kind", "timestamp", "sessionRef", "workerRef", "workerType", "url"],
  },
);

const consoleEventSchema = objectSchema(
  {
    ...eventBaseSchema("console"),
    level: consoleLevelSchema,
    text: stringSchema(),
    location: objectSchema(
      {
        url: stringSchema(),
        lineNumber: integerSchema({ minimum: 0 }),
        columnNumber: integerSchema({ minimum: 0 }),
      },
      {
        required: [],
      },
    ),
  },
  {
    title: "ConsoleEvent",
    required: ["eventId", "kind", "timestamp", "sessionRef", "level", "text"],
  },
);

const pageErrorEventSchema = objectSchema(
  {
    ...eventBaseSchema("page-error"),
    message: stringSchema(),
    stack: stringSchema(),
  },
  {
    title: "PageErrorEvent",
    required: ["eventId", "kind", "timestamp", "sessionRef", "message"],
  },
);

const websocketOpenedEventSchema = objectSchema(
  {
    ...eventBaseSchema("websocket-opened"),
    socketId: stringSchema(),
    url: stringSchema(),
  },
  {
    title: "WebSocketOpenedEvent",
    required: ["eventId", "kind", "timestamp", "sessionRef", "socketId", "url"],
  },
);

const websocketFrameEventSchema = objectSchema(
  {
    ...eventBaseSchema("websocket-frame"),
    socketId: stringSchema(),
    direction: websocketDirectionSchema,
    opcode: integerSchema({ minimum: 0 }),
    payloadPreview: stringSchema(),
  },
  {
    title: "WebSocketFrameEvent",
    required: ["eventId", "kind", "timestamp", "sessionRef", "socketId", "direction"],
  },
);

const websocketClosedEventSchema = objectSchema(
  {
    ...eventBaseSchema("websocket-closed"),
    socketId: stringSchema(),
    code: integerSchema({ minimum: 0 }),
    reason: stringSchema(),
  },
  {
    title: "WebSocketClosedEvent",
    required: ["eventId", "kind", "timestamp", "sessionRef", "socketId"],
  },
);

const eventStreamMessageEventSchema = objectSchema(
  {
    ...eventBaseSchema("event-stream-message"),
    streamId: stringSchema(),
    eventName: stringSchema(),
    dataPreview: stringSchema(),
  },
  {
    title: "EventStreamMessageEvent",
    required: ["eventId", "kind", "timestamp", "sessionRef", "streamId"],
  },
);

const pausedEventSchema = objectSchema(
  {
    ...eventBaseSchema("paused"),
    reason: stringSchema(),
  },
  {
    title: "PausedEvent",
    required: ["eventId", "kind", "timestamp", "sessionRef"],
  },
);

const resumedEventSchema = objectSchema(
  {
    ...eventBaseSchema("resumed"),
    reason: stringSchema(),
  },
  {
    title: "ResumedEvent",
    required: ["eventId", "kind", "timestamp", "sessionRef"],
  },
);

const frozenEventSchema = objectSchema(
  {
    ...eventBaseSchema("frozen"),
    reason: stringSchema(),
  },
  {
    title: "FrozenEvent",
    required: ["eventId", "kind", "timestamp", "sessionRef"],
  },
);

export const opensteerEventSchema: JsonSchema = oneOfSchema(
  [
    pageCreatedEventSchema,
    popupOpenedEventSchema,
    pageClosedEventSchema,
    dialogOpenedEventSchema,
    downloadStartedEventSchema,
    downloadFinishedEventSchema,
    chooserOpenedEventSchema,
    workerCreatedEventSchema,
    workerDestroyedEventSchema,
    consoleEventSchema,
    pageErrorEventSchema,
    websocketOpenedEventSchema,
    websocketFrameEventSchema,
    websocketClosedEventSchema,
    eventStreamMessageEventSchema,
    pausedEventSchema,
    resumedEventSchema,
    frozenEventSchema,
  ],
  {
    title: "OpensteerEvent",
  },
);
