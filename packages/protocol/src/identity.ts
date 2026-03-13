import {
  enumSchema,
  integerSchema,
  objectSchema,
  oneOfSchema,
  stringSchema,
  type JsonSchema,
} from "./json.js";

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

type PrefixedRef<TPrefix extends RefPrefix> = `${TPrefix}:${string}`;

export type SessionRef = PrefixedRef<"session">;
export type PageRef = PrefixedRef<"page">;
export type FrameRef = PrefixedRef<"frame">;
export type DocumentRef = PrefixedRef<"document">;
export type NodeRef = PrefixedRef<"node">;
export type NetworkRequestId = PrefixedRef<"request">;
export type DownloadRef = PrefixedRef<"download">;
export type DialogRef = PrefixedRef<"dialog">;
export type ChooserRef = PrefixedRef<"chooser">;
export type WorkerRef = PrefixedRef<"worker">;

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

export type DocumentEpoch = number;

export interface NodeLocator {
  readonly documentRef: DocumentRef;
  readonly documentEpoch: DocumentEpoch;
  readonly nodeRef: NodeRef;
}

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

function normalizeRef<TPrefix extends RefPrefix>(
  prefix: TPrefix,
  value: string,
): PrefixedRef<TPrefix> {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new TypeError(`${prefix} reference cannot be empty`);
  }

  const canonicalPrefix = `${prefix}:`;
  if (trimmed.startsWith(canonicalPrefix)) {
    if (trimmed.length === canonicalPrefix.length) {
      throw new TypeError(`${prefix} reference must include an identifier`);
    }

    return trimmed as PrefixedRef<TPrefix>;
  }

  if (trimmed.includes(":")) {
    throw new TypeError(
      `${prefix} reference "${trimmed}" must either omit a prefix or use ${canonicalPrefix}`,
    );
  }

  return `${canonicalPrefix}${trimmed}` as PrefixedRef<TPrefix>;
}

function hasPrefix<TPrefix extends RefPrefix>(
  prefix: TPrefix,
  value: string,
): value is PrefixedRef<TPrefix> {
  return value.startsWith(`${prefix}:`) && value.length > prefix.length + 1;
}

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

export function createSessionRef(value: string): SessionRef {
  return normalizeRef("session", value);
}

export function createPageRef(value: string): PageRef {
  return normalizeRef("page", value);
}

export function createFrameRef(value: string): FrameRef {
  return normalizeRef("frame", value);
}

export function createDocumentRef(value: string): DocumentRef {
  return normalizeRef("document", value);
}

export function createNodeRef(value: string): NodeRef {
  return normalizeRef("node", value);
}

export function createNetworkRequestId(value: string): NetworkRequestId {
  return normalizeRef("request", value);
}

export function createDownloadRef(value: string): DownloadRef {
  return normalizeRef("download", value);
}

export function createDialogRef(value: string): DialogRef {
  return normalizeRef("dialog", value);
}

export function createChooserRef(value: string): ChooserRef {
  return normalizeRef("chooser", value);
}

export function createWorkerRef(value: string): WorkerRef {
  return normalizeRef("worker", value);
}

export function isSessionRef(value: string): value is SessionRef {
  return hasPrefix("session", value);
}

export function isPageRef(value: string): value is PageRef {
  return hasPrefix("page", value);
}

export function isFrameRef(value: string): value is FrameRef {
  return hasPrefix("frame", value);
}

export function isDocumentRef(value: string): value is DocumentRef {
  return hasPrefix("document", value);
}

export function isNodeRef(value: string): value is NodeRef {
  return hasPrefix("node", value);
}

export function isNetworkRequestId(value: string): value is NetworkRequestId {
  return hasPrefix("request", value);
}

export function isDownloadRef(value: string): value is DownloadRef {
  return hasPrefix("download", value);
}

export function isDialogRef(value: string): value is DialogRef {
  return hasPrefix("dialog", value);
}

export function isChooserRef(value: string): value is ChooserRef {
  return hasPrefix("chooser", value);
}

export function isWorkerRef(value: string): value is WorkerRef {
  return hasPrefix("worker", value);
}

export function isOpensteerRef(value: string): value is OpensteerRef {
  return parsePrefixedRef(value) !== null;
}

export function parseOpensteerRef(value: string): ParsedOpensteerRef | null {
  return parsePrefixedRef(value);
}

export function serializeRef(value: OpensteerRef): string {
  return value;
}

export function createDocumentEpoch(value: number): DocumentEpoch {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(
      `document epoch must be a non-negative integer, received ${String(value)}`,
    );
  }

  return value;
}

export function nextDocumentEpoch(value: DocumentEpoch): DocumentEpoch {
  return createDocumentEpoch(value + 1);
}

export function serializeDocumentEpoch(value: DocumentEpoch): number {
  return value;
}

export function createNodeLocator(
  documentRef: DocumentRef,
  documentEpoch: DocumentEpoch,
  nodeRef: NodeRef,
): NodeLocator {
  return {
    documentRef,
    documentEpoch,
    nodeRef,
  };
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
