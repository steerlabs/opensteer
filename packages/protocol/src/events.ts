export type { ConsoleLevel } from "@opensteer/browser-core";

export type { PageCreatedStepEvent as PageCreatedEvent } from "@opensteer/browser-core";
export type { PopupOpenedStepEvent as PopupOpenedEvent } from "@opensteer/browser-core";
export type { PageClosedStepEvent as PageClosedEvent } from "@opensteer/browser-core";
export type { DialogOpenedStepEvent as DialogOpenedEvent } from "@opensteer/browser-core";
export type { DownloadStartedStepEvent as DownloadStartedEvent } from "@opensteer/browser-core";
export type { DownloadFinishedStepEvent as DownloadFinishedEvent } from "@opensteer/browser-core";
export type { ChooserOpenedStepEvent as ChooserOpenedEvent } from "@opensteer/browser-core";
export type { WorkerCreatedStepEvent as WorkerCreatedEvent } from "@opensteer/browser-core";
export type { WorkerDestroyedStepEvent as WorkerDestroyedEvent } from "@opensteer/browser-core";
export type { ConsoleStepEvent as ConsoleEvent } from "@opensteer/browser-core";
export type { PageErrorStepEvent as PageErrorEvent } from "@opensteer/browser-core";
export type { WebSocketOpenedStepEvent as WebSocketOpenedEvent } from "@opensteer/browser-core";
export type { WebSocketFrameStepEvent as WebSocketFrameEvent } from "@opensteer/browser-core";
export type { WebSocketClosedStepEvent as WebSocketClosedEvent } from "@opensteer/browser-core";
export type { EventStreamMessageStepEvent as EventStreamMessageEvent } from "@opensteer/browser-core";
export type { PausedStepEvent as PausedEvent } from "@opensteer/browser-core";
export type { ResumedStepEvent as ResumedEvent } from "@opensteer/browser-core";
export type { FrozenStepEvent as FrozenEvent } from "@opensteer/browser-core";
export type { StepEvent as OpensteerEvent } from "@opensteer/browser-core";

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
