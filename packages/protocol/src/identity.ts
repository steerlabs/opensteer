export type {
  SessionRef,
  PageRef,
  FrameRef,
  DocumentRef,
  NodeRef,
  NetworkRequestId,
  DownloadRef,
  DialogRef,
  ChooserRef,
  WorkerRef,
  DocumentEpoch,
  NodeLocator,
} from "@opensteer/browser-core";

export {
  createSessionRef,
  createPageRef,
  createFrameRef,
  createDocumentRef,
  createNodeRef,
  createNetworkRequestId,
  createDownloadRef,
  createDialogRef,
  createChooserRef,
  createWorkerRef,
  isSessionRef,
  isPageRef,
  isFrameRef,
  isDocumentRef,
  isNodeRef,
  isNetworkRequestId,
  isDownloadRef,
  isDialogRef,
  isChooserRef,
  isWorkerRef,
  serializeRef,
  createDocumentEpoch,
  nextDocumentEpoch,
  serializeDocumentEpoch,
  createNodeLocator,
} from "@opensteer/browser-core";

import type {
  SessionRef,
  PageRef,
  FrameRef,
  DocumentRef,
  NodeRef,
  NetworkRequestId,
  DownloadRef,
  DialogRef,
  ChooserRef,
  WorkerRef,
} from "@opensteer/browser-core";

import {
  enumSchema,
  integerSchema,
  objectSchema,
  oneOfSchema,
  stringSchema,
  type JsonSchema,
} from "./json.js";

export type OpensteerRef =
  | SessionRef
  | PageRef
  | FrameRef
  | DocumentRef
  | NodeRef
  | NetworkRequestId
  | DownloadRef
  | DialogRef
  | ChooserRef
  | WorkerRef;

type RefPrefix =
  | "session"
  | "page"
  | "frame"
  | "document"
  | "node"
  | "request"
  | "download"
  | "dialog"
  | "chooser"
  | "worker";

export interface ParsedOpensteerRef {
  readonly kind: RefPrefix;
  readonly value: string;
}

const refPrefixes = [
  "session",
  "page",
  "frame",
  "document",
  "node",
  "request",
  "download",
  "dialog",
  "chooser",
  "worker",
] as const satisfies readonly RefPrefix[];

function parsePrefixedRef(value: string): ParsedOpensteerRef | null {
  const separatorIndex = value.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    return null;
  }

  const kind = value.slice(0, separatorIndex);
  if (!refPrefixes.includes(kind as RefPrefix)) {
    return null;
  }

  return {
    kind: kind as RefPrefix,
    value: value.slice(separatorIndex + 1),
  };
}

export function isOpensteerRef(value: string): value is OpensteerRef {
  return parsePrefixedRef(value) !== null;
}

export function parseOpensteerRef(value: string): ParsedOpensteerRef | null {
  return parsePrefixedRef(value);
}

function prefixedRefSchema(prefix: RefPrefix, title: string): JsonSchema {
  return stringSchema({
    title,
    pattern: `^${prefix}:.+$`,
  });
}

export const opensteerRefKindSchema: JsonSchema = enumSchema(refPrefixes, {
  title: "OpensteerRefKind",
});

export const sessionRefSchema = prefixedRefSchema("session", "SessionRef");
export const pageRefSchema = prefixedRefSchema("page", "PageRef");
export const frameRefSchema = prefixedRefSchema("frame", "FrameRef");
export const documentRefSchema = prefixedRefSchema("document", "DocumentRef");
export const nodeRefSchema = prefixedRefSchema("node", "NodeRef");
export const networkRequestIdSchema = prefixedRefSchema("request", "NetworkRequestId");
export const downloadRefSchema = prefixedRefSchema("download", "DownloadRef");
export const dialogRefSchema = prefixedRefSchema("dialog", "DialogRef");
export const chooserRefSchema = prefixedRefSchema("chooser", "ChooserRef");
export const workerRefSchema = prefixedRefSchema("worker", "WorkerRef");

export const opensteerRefSchema: JsonSchema = oneOfSchema(
  [
    sessionRefSchema,
    pageRefSchema,
    frameRefSchema,
    documentRefSchema,
    nodeRefSchema,
    networkRequestIdSchema,
    downloadRefSchema,
    dialogRefSchema,
    chooserRefSchema,
    workerRefSchema,
  ],
  {
    title: "OpensteerRef",
  },
);

export const documentEpochSchema: JsonSchema = integerSchema({
  title: "DocumentEpoch",
  minimum: 0,
});

export const nodeLocatorSchema: JsonSchema = objectSchema(
  {
    documentRef: documentRefSchema,
    documentEpoch: documentEpochSchema,
    nodeRef: nodeRefSchema,
  },
  {
    title: "NodeLocator",
    required: ["documentRef", "documentEpoch", "nodeRef"],
  },
);
