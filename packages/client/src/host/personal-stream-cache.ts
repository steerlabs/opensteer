import type { ThreadStateProjection } from "./thread-state.js";
import type { DeploymentResumeCursor } from "@opensteer/core";
import type { HostSnapshot } from "./client.js";
export interface PersonalCacheScope {
  readonly deploymentId: string;
  readonly userId: string;
  readonly apiVersion: number;
}
export interface PersonalStreamCheckpoint {
  readonly scope: PersonalCacheScope;
  readonly cursor: DeploymentResumeCursor;
  readonly threadStates: ReturnType<ThreadStateProjection["checkpoint"]>;
  readonly snapshot: Pick<
    HostSnapshot,
    | "threads"
    | "tasks"
    | "activeTasks"
    | "transcripts"
    | "transcriptWindows"
    | "requests"
    | "waitingRequests"
    | "needsYou"
    | "threadVisits"
  >;
}
// The port commits rows and their cursor atomically, fenced against logout or attachment replacement.
export interface PersonalStreamCache {
  load(scope: PersonalCacheScope): Promise<PersonalStreamCheckpoint | null>;
  commit(checkpoint: PersonalStreamCheckpoint, isCurrent: () => boolean): Promise<void>;
  remove(scope: PersonalCacheScope): Promise<void>;
}
