export type {
  HeaderEntry,
  BodyPayloadEncoding,
  NetworkCaptureState,
  NetworkRecordKind,
  NetworkResourceType,
  NetworkInitiatorType,
  NetworkInitiator,
  NetworkTiming,
  NetworkTransferSizes,
  NetworkSourceMetadata,
} from "@opensteer/browser-core";

export { createHeaderEntry } from "@opensteer/browser-core";

import type {
  BodyPayloadEncoding,
  DocumentRef,
  FrameRef,
  HeaderEntry,
  NetworkCaptureState,
  NetworkInitiator,
  NetworkRecordKind,
  NetworkRequestId,
  NetworkResourceType,
  NetworkSourceMetadata,
  NetworkTiming,
  NetworkTransferSizes,
  PageRef,
  SessionRef,
  WorkerRef,
} from "@opensteer/browser-core";

import {
  documentRefSchema,
  frameRefSchema,
  networkRequestIdSchema,
  pageRefSchema,
  sessionRefSchema,
  workerRefSchema,
} from "./identity.js";
import {
  arraySchema,
  enumSchema,
  integerSchema,
  numberSchema,
  objectSchema,
  stringSchema,
  type JsonSchema,
} from "./json.js";

export interface BodyPayload {
  readonly data: string;
  readonly encoding: BodyPayloadEncoding;
  readonly mimeType?: string;
  readonly charset?: string;
  readonly truncated: boolean;
  readonly capturedByteLength: number;
  readonly originalByteLength?: number;
}

export interface NetworkRecord {
  readonly kind: NetworkRecordKind;
  readonly requestId: NetworkRequestId;
  readonly sessionRef: SessionRef;
  readonly pageRef?: PageRef;
  readonly frameRef?: FrameRef;
  readonly documentRef?: DocumentRef;
  readonly method: string;
  readonly url: string;
  readonly requestHeaders: readonly HeaderEntry[];
  readonly responseHeaders: readonly HeaderEntry[];
  readonly status?: number;
  readonly statusText?: string;
  readonly resourceType: NetworkResourceType;
  readonly redirectFromRequestId?: NetworkRequestId;
  readonly redirectToRequestId?: NetworkRequestId;
  readonly navigationRequest: boolean;
  readonly initiator?: NetworkInitiator;
  readonly timing?: NetworkTiming;
  readonly transfer?: NetworkTransferSizes;
  readonly source?: NetworkSourceMetadata;
  readonly captureState: NetworkCaptureState;
  readonly requestBodyState: NetworkCaptureState;
  readonly responseBodyState: NetworkCaptureState;
  readonly requestBodySkipReason?: string;
  readonly responseBodySkipReason?: string;
  readonly requestBodyError?: string;
  readonly responseBodyError?: string;
  readonly requestBody?: BodyPayload;
  readonly responseBody?: BodyPayload;
}

export type NetworkQuerySource = "live" | "saved";

export interface NetworkQueryRecord {
  readonly recordId: string;
  readonly source: NetworkQuerySource;
  readonly actionId?: string;
  readonly tags?: readonly string[];
  readonly savedAt?: number;
  readonly record: NetworkRecord;
}

export function createBodyPayload(
  data: string,
  options: {
    readonly encoding?: BodyPayloadEncoding;
    readonly mimeType?: string;
    readonly charset?: string;
    readonly truncated?: boolean;
    readonly originalByteLength?: number;
  } = {},
): BodyPayload {
  const capturedByteLength = Buffer.from(data, "base64").byteLength;

  return {
    data,
    encoding: options.encoding ?? "identity",
    truncated: options.truncated ?? false,
    capturedByteLength,
    ...(options.mimeType === undefined ? {} : { mimeType: options.mimeType }),
    ...(options.charset === undefined ? {} : { charset: options.charset }),
    ...(options.originalByteLength === undefined
      ? {}
      : { originalByteLength: options.originalByteLength }),
  };
}

export function bodyPayloadFromUtf8(
  value: string,
  options: {
    readonly mimeType?: string;
    readonly encoding?: BodyPayloadEncoding;
    readonly truncated?: boolean;
    readonly originalByteLength?: number;
  } = {},
): BodyPayload {
  return createBodyPayload(Buffer.from(value, "utf8").toString("base64"), {
    ...(options.mimeType === undefined ? {} : { mimeType: options.mimeType }),
    ...(options.encoding === undefined ? {} : { encoding: options.encoding }),
    ...(options.truncated === undefined ? {} : { truncated: options.truncated }),
    ...(options.originalByteLength === undefined
      ? {}
      : { originalByteLength: options.originalByteLength }),
    charset: "utf-8",
  });
}

export const headerEntrySchema: JsonSchema = objectSchema(
  {
    name: stringSchema(),
    value: stringSchema(),
  },
  {
    title: "HeaderEntry",
    required: ["name", "value"],
  },
);

export const bodyPayloadEncodingSchema: JsonSchema = enumSchema(
  ["identity", "base64", "gzip", "deflate", "brotli", "unknown"] as const,
  {
    title: "BodyPayloadEncoding",
  },
);

export const bodyPayloadSchema: JsonSchema = objectSchema(
  {
    data: stringSchema({
      description: "Binary payload encoded as base64.",
    }),
    encoding: bodyPayloadEncodingSchema,
    mimeType: stringSchema(),
    charset: stringSchema(),
    truncated: {
      type: "boolean",
    },
    capturedByteLength: integerSchema({ minimum: 0 }),
    originalByteLength: integerSchema({ minimum: 0 }),
  },
  {
    title: "BodyPayload",
    required: ["data", "encoding", "truncated", "capturedByteLength"],
  },
);

export const networkRecordKindSchema: JsonSchema = enumSchema(
  ["http", "websocket", "event-stream"] as const,
  {
    title: "NetworkRecordKind",
  },
);

export const networkCaptureStateSchema: JsonSchema = enumSchema(
  ["pending", "complete", "failed", "skipped"] as const,
  {
    title: "NetworkCaptureState",
  },
);

export const networkResourceTypeSchema: JsonSchema = enumSchema(
  [
    "document",
    "stylesheet",
    "image",
    "media",
    "font",
    "script",
    "fetch",
    "xhr",
    "websocket",
    "event-stream",
    "manifest",
    "texttrack",
    "beacon",
    "ping",
    "preflight",
    "other",
  ] as const,
  {
    title: "NetworkResourceType",
  },
);

export const networkInitiatorTypeSchema: JsonSchema = enumSchema(
  ["parser", "script", "preload", "redirect", "user", "service-worker", "other"] as const,
  {
    title: "NetworkInitiatorType",
  },
);

export const networkInitiatorSchema: JsonSchema = objectSchema(
  {
    type: networkInitiatorTypeSchema,
    url: stringSchema(),
    lineNumber: integerSchema({ minimum: 0 }),
    columnNumber: integerSchema({ minimum: 0 }),
    requestId: networkRequestIdSchema,
    stackTrace: arraySchema(stringSchema()),
  },
  {
    title: "NetworkInitiator",
    required: ["type"],
  },
);

export const networkTimingSchema: JsonSchema = objectSchema(
  {
    requestStartMs: numberSchema(),
    dnsStartMs: numberSchema(),
    dnsEndMs: numberSchema(),
    connectStartMs: numberSchema(),
    connectEndMs: numberSchema(),
    sslStartMs: numberSchema(),
    sslEndMs: numberSchema(),
    requestSentMs: numberSchema(),
    responseStartMs: numberSchema(),
    responseEndMs: numberSchema(),
    workerStartMs: numberSchema(),
    workerReadyMs: numberSchema(),
  },
  {
    title: "NetworkTiming",
  },
);

export const networkTransferSizesSchema: JsonSchema = objectSchema(
  {
    requestHeadersBytes: integerSchema({ minimum: 0 }),
    responseHeadersBytes: integerSchema({ minimum: 0 }),
    encodedBodyBytes: integerSchema({ minimum: 0 }),
    decodedBodyBytes: integerSchema({ minimum: 0 }),
    transferSizeBytes: integerSchema({ minimum: 0 }),
  },
  {
    title: "NetworkTransferSizes",
  },
);

export const networkSourceMetadataSchema: JsonSchema = objectSchema(
  {
    protocol: stringSchema(),
    remoteAddress: objectSchema(
      {
        ip: stringSchema(),
        port: integerSchema({ minimum: 0 }),
      },
      {
        required: [],
      },
    ),
    fromServiceWorker: {
      type: "boolean",
    },
    fromDiskCache: {
      type: "boolean",
    },
    fromMemoryCache: {
      type: "boolean",
    },
    workerRef: workerRefSchema,
  },
  {
    title: "NetworkSourceMetadata",
  },
);

export const networkRecordSchema: JsonSchema = objectSchema(
  {
    kind: networkRecordKindSchema,
    requestId: networkRequestIdSchema,
    sessionRef: sessionRefSchema,
    pageRef: pageRefSchema,
    frameRef: frameRefSchema,
    documentRef: documentRefSchema,
    method: stringSchema(),
    url: stringSchema(),
    requestHeaders: arraySchema(headerEntrySchema),
    responseHeaders: arraySchema(headerEntrySchema),
    status: integerSchema({ minimum: 0 }),
    statusText: stringSchema(),
    resourceType: networkResourceTypeSchema,
    redirectFromRequestId: networkRequestIdSchema,
    redirectToRequestId: networkRequestIdSchema,
    navigationRequest: {
      type: "boolean",
    },
    initiator: networkInitiatorSchema,
    timing: networkTimingSchema,
    transfer: networkTransferSizesSchema,
    source: networkSourceMetadataSchema,
    captureState: networkCaptureStateSchema,
    requestBodyState: networkCaptureStateSchema,
    responseBodyState: networkCaptureStateSchema,
    requestBodySkipReason: stringSchema(),
    responseBodySkipReason: stringSchema(),
    requestBodyError: stringSchema(),
    responseBodyError: stringSchema(),
    requestBody: bodyPayloadSchema,
    responseBody: bodyPayloadSchema,
  },
  {
    title: "NetworkRecord",
    required: [
      "kind",
      "requestId",
      "sessionRef",
      "method",
      "url",
      "requestHeaders",
      "responseHeaders",
      "resourceType",
      "navigationRequest",
      "captureState",
      "requestBodyState",
      "responseBodyState",
    ],
  },
);

export const networkQuerySourceSchema: JsonSchema = enumSchema(["live", "saved"] as const, {
  title: "NetworkQuerySource",
});

export const networkQueryRecordSchema: JsonSchema = objectSchema(
  {
    recordId: stringSchema({ minLength: 1 }),
    source: networkQuerySourceSchema,
    actionId: stringSchema({ minLength: 1 }),
    tags: arraySchema(stringSchema({ minLength: 1 }), {
      uniqueItems: true,
    }),
    savedAt: integerSchema({ minimum: 0 }),
    record: networkRecordSchema,
  },
  {
    title: "NetworkQueryRecord",
    required: ["recordId", "source", "record"],
  },
);

export const orderedHeadersSchema: JsonSchema = arraySchema(headerEntrySchema, {
  title: "OrderedHeaders",
});
