import { brand, type Brand } from "./brand.js";

type StringRefKind =
  | "SessionRef"
  | "PageRef"
  | "FrameRef"
  | "DocumentRef"
  | "NodeRef"
  | "NetworkRequestId"
  | "DownloadRef"
  | "DialogRef"
  | "ChooserRef"
  | "WorkerRef";

export type SessionRef = Brand<string, "SessionRef">;
export type PageRef = Brand<string, "PageRef">;
export type FrameRef = Brand<string, "FrameRef">;
export type DocumentRef = Brand<string, "DocumentRef">;
export type NodeRef = Brand<string, "NodeRef">;
export type NetworkRequestId = Brand<string, "NetworkRequestId">;
export type DownloadRef = Brand<string, "DownloadRef">;
export type DialogRef = Brand<string, "DialogRef">;
export type ChooserRef = Brand<string, "ChooserRef">;
export type WorkerRef = Brand<string, "WorkerRef">;
export type DocumentEpoch = Brand<number, "DocumentEpoch">;

export interface NodeLocator {
  readonly documentRef: DocumentRef;
  readonly documentEpoch: DocumentEpoch;
  readonly nodeRef: NodeRef;
}

const REF_PREFIXES = {
  session: "session",
  page: "page",
  frame: "frame",
  document: "document",
  node: "node",
  request: "request",
  download: "download",
  dialog: "dialog",
  chooser: "chooser",
  worker: "worker",
} as const;

type RefPrefix = (typeof REF_PREFIXES)[keyof typeof REF_PREFIXES];

function normalizeRef(prefix: RefPrefix, value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new TypeError(`${prefix} reference cannot be empty`);
  }

  const canonicalPrefix = `${prefix}:`;
  if (trimmed.startsWith(canonicalPrefix)) {
    if (trimmed.length === canonicalPrefix.length) {
      throw new TypeError(`${prefix} reference must include an identifier`);
    }
    return trimmed;
  }

  if (trimmed.includes(":")) {
    throw new TypeError(
      `${prefix} reference "${trimmed}" must either omit a prefix or use ${canonicalPrefix}`,
    );
  }

  return `${canonicalPrefix}${trimmed}`;
}

function hasPrefix(prefix: RefPrefix, value: string): boolean {
  return value.startsWith(`${prefix}:`) && value.length > prefix.length + 1;
}

function createStringRef<Name extends StringRefKind>(
  prefix: RefPrefix,
  value: string,
): Brand<string, Name> {
  return brand<string, Name>(normalizeRef(prefix, value));
}

export function createSessionRef(value: string): SessionRef {
  return createStringRef("session", value);
}

export function createPageRef(value: string): PageRef {
  return createStringRef("page", value);
}

export function createFrameRef(value: string): FrameRef {
  return createStringRef("frame", value);
}

export function createDocumentRef(value: string): DocumentRef {
  return createStringRef("document", value);
}

export function createNodeRef(value: string): NodeRef {
  return createStringRef("node", value);
}

export function createNetworkRequestId(value: string): NetworkRequestId {
  return createStringRef("request", value);
}

export function createDownloadRef(value: string): DownloadRef {
  return createStringRef("download", value);
}

export function createDialogRef(value: string): DialogRef {
  return createStringRef("dialog", value);
}

export function createChooserRef(value: string): ChooserRef {
  return createStringRef("chooser", value);
}

export function createWorkerRef(value: string): WorkerRef {
  return createStringRef("worker", value);
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

export function serializeRef(
  ref:
    | SessionRef
    | PageRef
    | FrameRef
    | DocumentRef
    | NodeRef
    | NetworkRequestId
    | DownloadRef
    | DialogRef
    | ChooserRef
    | WorkerRef,
): string {
  return ref;
}

export function createDocumentEpoch(value: number): DocumentEpoch {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(
      `document epoch must be a non-negative integer, received ${String(value)}`,
    );
  }
  return brand<number, "DocumentEpoch">(value);
}

export function nextDocumentEpoch(epoch: DocumentEpoch): DocumentEpoch {
  return createDocumentEpoch(epoch + 1);
}

export function serializeDocumentEpoch(epoch: DocumentEpoch): number {
  return epoch;
}

export function createNodeLocator(
  documentRef: DocumentRef,
  documentEpoch: DocumentEpoch,
  nodeRef: NodeRef,
): NodeLocator {
  return { documentRef, documentEpoch, nodeRef };
}
