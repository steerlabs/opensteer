import type {
  AgentEvent,
  ArtifactContentPart,
  Attachment,
  MessageId,
  ModelSelection,
  RunId,
  TaskFolder,
  ThreadId,
} from "@opensteer/core";
import type { HostApiClient } from "@opensteer/protocol";
import { HostToClientMessageSchema, type HostToClientMessage } from "@opensteer/protocol";
import type { RawData, WebSocket } from "ws";

export interface VerticalTurn {
  readonly assistantText: string;
  readonly events: readonly AgentEvent[];
  readonly runId: RunId;
}
export interface VerticalStack {
  readonly api: HostApiClient;
  readonly agentHome: TaskFolder;
  readonly sessionCookie: string;
  readonly hostOrigin: URL;
  createThread(input: {
    readonly folder?: TaskFolder;
    readonly modelSelection: ModelSelection;
    readonly title?: string;
  }): Promise<ThreadId>;
  queueMessage(input: {
    readonly text: string;
    readonly threadId: ThreadId;
  }): Promise<{ readonly messageId: MessageId; readonly runId: RunId | null }>;
  sendMessage(input: {
    readonly text: string;
    readonly threadId: ThreadId;
    readonly attachments?: readonly ArtifactContentPart[];
  }): Promise<VerticalTurn>;
  restartHost(): Promise<void>;
  restartRunner(): Promise<void>;
  close(): Promise<void>;
}
export interface VerticalStackOptions {
  readonly databaseUrl: string;
  readonly agentHome: TaskFolder;
  readonly startPersonal?: (options: {
    readonly databaseUrl: string;
    readonly agentHome: TaskFolder;
  }) => Promise<VerticalStack>;
}
export async function startVerticalStack(options: VerticalStackOptions): Promise<VerticalStack> {
  if (!options.startPersonal)
    throw new Error(
      "The vertical fixture needs lanes P/R/X's production local-owner bootstrap, folder admission and Runner composition",
    );
  return options.startPersonal({ databaseUrl: options.databaseUrl, agentHome: options.agentHome });
}
export function attachmentReference(attachment: Attachment): ArtifactContentPart {
  return {
    type: "artifact",
    attachmentId: attachment.id,
    name: attachment.name,
    mediaType: attachment.mediaType,
    sizeBytes: attachment.sizeBytes,
  };
}
export function waitForRealtimeMessage(
  socket: WebSocket,
  predicate: (message: HostToClientMessage) => boolean,
): Promise<HostToClientMessage> {
  return new Promise((resolve, reject) => {
    const finish = (effect: () => void) => {
      clearTimeout(timer);
      socket.off("message", receive);
      socket.off("close", closed);
      effect();
    };
    const receive = (frame: RawData, isBinary: boolean) => {
      try {
        if (isBinary) throw new Error("Realtime sent a binary frame");
        const message = HostToClientMessageSchema.parse(JSON.parse(frame.toString()));
        if (predicate(message)) finish(() => resolve(message));
      } catch (error) {
        finish(() => reject(error));
      }
    };
    const closed = () =>
      finish(() => reject(new Error("Realtime closed before the expected message")));
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(new Error("Expected realtime message did not arrive within 10 seconds")),
        ),
      10_000,
    );
    socket.on("message", receive);
    socket.on("close", closed);
  });
}
