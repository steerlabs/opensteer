import type {
  AttachmentId,
  MessageId,
  RequestId,
  Request,
  RunId,
  RunnerId,
  TabId,
  ThreadId,
  TriggerId,
} from "@opensteer/core";
import type {
  AvailableReference,
  AssetUrlsInput,
  AssetUrls,
  FileSource,
  ReferenceResolveInput,
  ReferenceResolveResult,
  TranscriptFileOpenInput,
  TranscriptFileOpen,
  TranscriptFileContentInput,
  TranscriptFileContent,
} from "@opensteer/protocol";
import type { HostClient } from "../host/client.js";

export type ReferenceDestination =
  | { kind: "task"; threadId: ThreadId }
  | { kind: "run"; threadId: ThreadId; runId: RunId; anchorMessageId: MessageId }
  | {
      kind: "message";
      threadId: ThreadId;
      messageId: MessageId;
      location: "transcript" | "input-queue";
    }
  | { kind: "request"; threadId: ThreadId; requestId: RequestId; status: Request["status"] }
  | { kind: "automation"; triggerId: TriggerId }
  | { kind: "computer"; runnerId: RunnerId }
  | { kind: "attachment"; attachmentId: AttachmentId }
  | { kind: "tab"; tabId: TabId };
export type ReferenceState =
  | { state: "unresolved" }
  | { state: "available"; value: AvailableReference }
  | { state: "unavailable" }
  | { state: "failed" };
export interface ReferenceRenderContext {
  readonly kind: "personal";
  readonly deploymentId: string;
  readonly client: HostClient;
  readonly threadId: ThreadId | null;
}
export interface FileOpenInput {
  readonly source: FileSource;
  readonly line?: number;
  readonly column?: number;
  readonly endLine?: number;
}
export interface ReferenceNavigationPorts {
  readonly openReference: (destination: ReferenceDestination) => Promise<void>;
}
export interface PersonalReferenceNavigationPorts extends ReferenceNavigationPorts {
  readonly openFile: (input: FileOpenInput) => Promise<void>;
}
/** Adapters unwrap RPC results; these ports stay usable before RPC registration. */
export interface ReferenceReadPorts {
  readonly assetUrls: (input: AssetUrlsInput, signal?: AbortSignal) => Promise<AssetUrls>;
  readonly resolveReferences: (
    input: ReferenceResolveInput,
    signal?: AbortSignal,
  ) => Promise<ReferenceResolveResult>;
  readonly openFile: (
    input: TranscriptFileOpenInput,
    signal?: AbortSignal,
  ) => Promise<TranscriptFileOpen>;
  readonly readFile: (
    input: TranscriptFileContentInput,
    signal?: AbortSignal,
  ) => Promise<TranscriptFileContent>;
}
