import type {
  MessageId,
  RunId,
  TeamAgentRequestId,
  TeamSource,
  TeamTaskOrigin,
  ThreadId,
} from "@opensteer/core";

export interface TeamTaskAdmission {
  readonly bodyMarkdown: string;
  readonly origin: TeamTaskOrigin;
  readonly requestId: TeamAgentRequestId;
  readonly triggerMessageId: TeamTaskOrigin["threadRootId"];
  readonly source: TeamSource;
}
export interface TeamTaskAdmissionReceipt {
  readonly taskId: ThreadId;
  readonly inputId: MessageId;
  readonly runId: RunId | null;
}
export interface TaskAdmissionPort {
  /** Atomically binds the task, reopens Done, records the receipt, and queues its own turn under team:<teamId>:<requestId>. */
  admitTeamRequest(input: TeamTaskAdmission): Promise<TeamTaskAdmissionReceipt>;
  /** Pending input is cancelled; an already-started input stops only its associated Run. */
  cancelTeamRequest(input: {
    readonly teamId: TeamTaskOrigin["teamId"];
    readonly requestId: TeamAgentRequestId;
  }): Promise<void>;
}
