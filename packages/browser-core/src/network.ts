import type {
  DocumentRef,
  FrameRef,
  NetworkRequestId,
  PageRef,
  SessionRef,
  WorkerRef,
} from "./identity.js";

export interface HeaderEntry {
  readonly name: string;
  readonly value: string;
}

export type BodyPayloadEncoding = "identity" | "base64" | "gzip" | "deflate" | "brotli" | "unknown";

export interface BodyPayload {
  readonly bytes: Uint8Array;
  readonly encoding: BodyPayloadEncoding;
  readonly mimeType?: string;
  readonly charset?: string;
  readonly truncated: boolean;
  readonly capturedByteLength: number;
  readonly originalByteLength?: number;
}

export type NetworkRecordKind = "http" | "websocket" | "event-stream";

export type NetworkResourceType =
  | "document"
  | "stylesheet"
  | "image"
  | "media"
  | "font"
  | "script"
  | "fetch"
  | "xhr"
  | "websocket"
  | "event-stream"
  | "manifest"
  | "texttrack"
  | "beacon"
  | "ping"
  | "preflight"
  | "other";

export type NetworkInitiatorType =
  | "parser"
  | "script"
  | "preload"
  | "redirect"
  | "user"
  | "service-worker"
  | "other";

export interface NetworkInitiator {
  readonly type: NetworkInitiatorType;
  readonly url?: string;
  readonly lineNumber?: number;
  readonly columnNumber?: number;
  readonly requestId?: NetworkRequestId;
  readonly stackTrace?: readonly string[];
}

export interface NetworkTiming {
  readonly requestStartMs?: number;
  readonly dnsStartMs?: number;
  readonly dnsEndMs?: number;
  readonly connectStartMs?: number;
  readonly connectEndMs?: number;
  readonly sslStartMs?: number;
  readonly sslEndMs?: number;
  readonly requestSentMs?: number;
  readonly responseStartMs?: number;
  readonly responseEndMs?: number;
  readonly workerStartMs?: number;
  readonly workerReadyMs?: number;
}

export interface NetworkTransferSizes {
  readonly requestHeadersBytes?: number;
  readonly responseHeadersBytes?: number;
  readonly encodedBodyBytes?: number;
  readonly decodedBodyBytes?: number;
  readonly transferSizeBytes?: number;
}

export interface NetworkSourceMetadata {
  readonly protocol?: string;
  readonly remoteAddress?: {
    readonly ip?: string;
    readonly port?: number;
  };
  readonly fromServiceWorker?: boolean;
  readonly fromDiskCache?: boolean;
  readonly fromMemoryCache?: boolean;
  readonly workerRef?: WorkerRef;
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
  readonly requestBody?: BodyPayload;
  readonly responseBody?: BodyPayload;
}

export function createHeaderEntry(name: string, value: string): HeaderEntry {
  return { name, value };
}

export function createBodyPayload(
  bytes: Uint8Array,
  options: {
    encoding?: BodyPayloadEncoding;
    mimeType?: string;
    charset?: string;
    truncated?: boolean;
    originalByteLength?: number;
  } = {},
): BodyPayload {
  return {
    bytes,
    encoding: options.encoding ?? "identity",
    truncated: options.truncated ?? false,
    capturedByteLength: bytes.byteLength,
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
    mimeType?: string;
    encoding?: BodyPayloadEncoding;
    truncated?: boolean;
    originalByteLength?: number;
  } = {},
): BodyPayload {
  return createBodyPayload(new TextEncoder().encode(value), {
    ...(options.mimeType === undefined ? {} : { mimeType: options.mimeType }),
    ...(options.encoding === undefined ? {} : { encoding: options.encoding }),
    ...(options.truncated === undefined ? {} : { truncated: options.truncated }),
    ...(options.originalByteLength === undefined
      ? {}
      : { originalByteLength: options.originalByteLength }),
    charset: "utf-8",
  });
}
