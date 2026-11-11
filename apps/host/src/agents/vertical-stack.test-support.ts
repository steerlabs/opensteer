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
    artifactId: attachment.id,
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

export interface PersonalVerticalRuntime {
  readonly api: HostApiClient;
  readonly environmentId: import("@opensteer/core").EnvironmentId;
  readonly harnessInstanceId: import("@opensteer/core").HarnessInstanceId;
  readonly sessionCookie: string;
  readonly hostOrigin: URL;
  /** Observes the durable input's actual consuming Run, including a completion already committed. */
  waitForInput(messageId: MessageId, signal: AbortSignal): Promise<VerticalTurn>;
  restartHost(): Promise<void>;
  restartRunner(): Promise<void>;
  close(): Promise<void>;
}

/** Personal task admission and turn collection; the runtime collaborator owns Host/Runner startup. */
export function createPersonalVerticalStack(
  agentHome: TaskFolder,
  runtime: PersonalVerticalRuntime,
): VerticalStack {
  const send = async (input: {
    readonly text: string;
    readonly threadId: ThreadId;
    readonly attachments?: readonly ArtifactContentPart[];
  }) => {
    const response = await runtime.api["commands.dispatch"]({
      type: "thread.sendMessage",
      idempotencyKey: crypto.randomUUID(),
      delivery: "queue",
      threadId: input.threadId,
      content: [{ type: "text", text: input.text }, ...(input.attachments ?? [])],
    });
    if (!response.ok) throw new Error(response.error.message);
    if (response.data.type !== "thread.sendMessage")
      throw new Error("Host returned another command's receipt");
    return { messageId: response.data.message.id, runId: response.data.run?.id ?? null };
  };
  return {
    api: runtime.api,
    agentHome,
    sessionCookie: runtime.sessionCookie,
    hostOrigin: runtime.hostOrigin,
    async createThread(input) {
      const response = await runtime.api["commands.dispatch"]({
        type: "thread.create",
        idempotencyKey: crypto.randomUUID(),
        environmentId: runtime.environmentId,
        harnessInstanceId: runtime.harnessInstanceId,
        modelSelection: input.modelSelection,
        folder: input.folder ?? agentHome,
        title: input.title ?? "Fixture task",
      });
      if (!response.ok) throw new Error(response.error.message);
      if (response.data.type !== "thread.create")
        throw new Error("Host returned another command's receipt");
      return response.data.thread.id;
    },
    queueMessage: send,
    async sendMessage(input) {
      const receipt = await send(input);
      return runtime.waitForInput(receipt.messageId, AbortSignal.timeout(60_000));
    },
    restartHost: () => runtime.restartHost(),
    restartRunner: () => runtime.restartRunner(),
    close: () => runtime.close(),
  };
}
