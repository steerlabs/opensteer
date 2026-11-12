import type { HostConfig } from "@opensteer/config";
import type { HarnessRegistry, HarnessRuntimeBoundary } from "@opensteer/harness";
import type {
  FolderAccessManager,
  PreparedIntegrationsModule,
  RunnerLogger,
  RunnerRuntimeOptions,
} from "@opensteer/runner";
import type {
  EnvironmentId,
  HarnessInstanceId,
  NotificationView,
  ProviderSessionId,
  ThreadAccessMode,
} from "@opensteer/core";
import type { HarnessInstanceCatalogView, HarnessModelDescriptor } from "@opensteer/protocol";
import type { HostRuntime } from "../runtime/runtime.js";
import type { NetworkPartition } from "./network-partition.test-support.js";
import type { RunnerWire, RunnerWireOptions } from "./runner-wire.test-support.js";
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
  readonly host: HostRuntime;
  readonly environmentId: EnvironmentId;
  readonly harnessInstanceId: HarnessInstanceId;
  readonly additionalHarnessInstanceIds: readonly HarnessInstanceId[];
  readonly catalog: Extract<HarnessInstanceCatalogView, { status: "ready" }>;
  readonly initialCatalog: HarnessInstanceCatalogView;
  readonly notifications: readonly NotificationView[];
  readonly wire?: RunnerWire;
  readonly runnerDataDirectory: string;
  readonly network: Pick<NetworkPartition, "block" | "drop" | "unblock">;
  readonly folderPreparations: readonly Parameters<FolderAccessManager["prepare"]>[0][];
  settledRunEvent(runId: RunId): import("@opensteer/protocol").PendingAgentEvent | undefined;
  crashRunner(beforeRestart?: () => Promise<void>): Promise<void>;
  createFolder(name: string): Promise<TaskFolder>;
  /** A separate database/Deployment using this harness; closed with this fixture. */
  startAdditionalPersonal(): Promise<VerticalStack>;
  configureModel(
    nativeModelId: string,
    settings: { readonly contextWindow: number; readonly maxOutputTokens?: number } | null,
  ): Promise<HarnessModelDescriptor>;
  createThread(input: {
    readonly folder?: TaskFolder;
    readonly generateTitle?: true;
    readonly idempotencyKey?: string;
    readonly modelSelection: ModelSelection;
    readonly title?: string;
  }): Promise<ThreadId>;
  updateThreadExecution(
    threadId: ThreadId,
    modelSelection: ModelSelection,
    options?: {
      readonly harnessInstanceId?: HarnessInstanceId;
      readonly expectedProviderSessionId?: ProviderSessionId | null;
      readonly idempotencyKey?: string;
    },
  ): Promise<void>;
  updateThreadAccess(threadId: ThreadId, accessMode: ThreadAccessMode): Promise<void>;
  interruptRun(threadId: ThreadId, runId: RunId): Promise<void>;
  resumeThreadInputQueue(threadId: ThreadId): Promise<void>;
  queueMessage(input: {
    readonly text: string;
    readonly threadId: ThreadId;
  }): Promise<{ readonly messageId: MessageId; readonly runId: RunId | null }>;
  uploadAttachment(input: {
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly name: string;
  }): Promise<Attachment>;
  waitForToolStart(runId: RunId, count?: number): Promise<void>;
  steerMessage(input: {
    readonly attachments?: readonly ArtifactContentPart[];
    readonly text: string;
    readonly threadId: ThreadId;
  }): Promise<{ readonly messageId: MessageId; readonly runId: RunId | null }>;
  sendMessage(input: {
    readonly text: string;
    readonly threadId: ThreadId;
    readonly attachments?: readonly ArtifactContentPart[];
    readonly onQueued?: (runId: RunId) => Promise<RunId | void>;
  }): Promise<VerticalTurn>;
  restartHost(outage?: {
    readonly downForMs?: number;
    readonly whileDown?: () => Promise<void>;
  }): Promise<void>;
  restartRunner(): Promise<void>;
  close(): Promise<void>;
}

export interface VerticalStackOptions {
  readonly agentHome?: TaskFolder;
  readonly startPersonal?: (options: VerticalStackOptions) => Promise<VerticalStack>;
  readonly executionClock?: import("@opensteer/shared/clock").Clock;
  readonly account?: HostConfig["account"];
  readonly accountDirectoryFetch?: typeof globalThis.fetch;
  readonly runnerWire?: RunnerWireOptions;
  /** Child-process Runner for crash/reaping acceptance journeys. */
  readonly runnerChild?: { readonly fixture: string; readonly arguments: readonly string[] };
  /** Personal Main Runner with its desktop authority; no server enrollment shortcut. */
  readonly integrations?: () => PreparedIntegrationsModule;
  /**
   * A browser this computer relays, reached over the same loopback bridge the
   * desktop app's Runner uses. Without it the Runner offers no browser.
   */
  readonly browser?: {
    readonly bridgeToken: string;
    readonly runtimeId: string;
    readonly url: URL;
  };
  /** The Browser Harness executable a Run's commands invoke. */
  readonly browserHarnessExecutable?: string;
  /**
   * The one-use token a separately running browser service enrolls with, as a
   * self-hosted Deployment configures it.
   */
  readonly browserServiceEnrollmentToken?: string;
  readonly cleanupTimeoutMs?: number;
  /** Final browser saves run after engines stop, while Host and storage remain alive. */
  readonly beforeHostClose?: (host: HostRuntime) => Promise<void>;
  readonly databaseUrl: string;
  /**
   * The Runner's engines. A factory gives each Runner boot its own registry,
   * as a restarted process has; `restartRunner` needs one, because a Runner
   * closes its registry when it stops.
   */
  readonly harnesses: HarnessRegistry | (() => HarnessRegistry);
  readonly harnessRuntimeBoundary: HarnessRuntimeBoundary;
  /** The one account the deployment is given before its Runner connects. */
  readonly harnessInstance: {
    readonly config: Readonly<Record<string, unknown>>;
    readonly driverKind: string;
    readonly sourceId: string;
    readonly stateKind: "ambient" | "isolated";
    /**
     * A key to sign the account in with, through the same setup commands the
     * Settings screen sends, when the Runner reports it signed out. With no
     * `value` the method needs nothing typed, as when the server's own
     * settings hold the key.
     */
    readonly apiKey?: {
      readonly connectionSlot?: string;
      readonly methodId: string;
      readonly value?: string;
    };
  };
  /** Additional accounts on the same connected Runner for route-switch journeys. */
  readonly additionalHarnessInstances?: readonly VerticalStackOptions["harnessInstance"][];
  /** How long the Runner may take to report that account's catalog ready. */
  readonly catalogTimeoutMs: number;
  /** How long one Run may take to complete. */
  readonly runTimeoutMs: number;
  /** Captures Runner diagnostics for engine lifecycle journeys. */
  readonly runnerLogger?: RunnerLogger;
  /** Original Host diagnostics, before an acceptance journey scrubs exports. */
  readonly hostLog?: (line: string) => void;
  /** Runs the one Runner executes at once; one unless a journey needs more. */
  readonly maxConcurrentRuns?: number;
  /** How long a Run survives without word from its Runner; shortened by reattach journeys. */
  readonly executionLeaseMs?: number;
  /** Where the Runner reads model server apps' own settings; a temporary home in tests. */
  readonly modelServerHome?: string;
  /** How long a Run's capability tokens live, shortened by refresh journeys. */
  readonly runCapabilityLifetimeSeconds?: number;
  readonly runCapabilityNow?: () => number;
  readonly credentialRefreshClock?: RunnerRuntimeOptions["credentialRefreshClock"];
  readonly notificationTiming?: Pick<
    import("../notifications/notification-dispatcher.js").NotificationDispatcherOptions,
    "now" | "wait"
  >;
  /** Controls only Host browser activity expiry. */
  readonly browserActivityClock?: import("@opensteer/shared/clock").Clock;
  /** How this Runner's Runs reach other computers; without it they reach none. */
  readonly machineAccess?: RunnerRuntimeOptions["machineAccess"];
  /**
   * Where people, phones and Runs reach this Host when it is not where it
   * listens, such as a TLS front door in front of it. It is the canonical and
   * the runtime origin both: the signed-in person's requests name it, a phone
   * pairs with it, and the Runner's tool URLs are minted from it. The Host
   * itself stays bound to loopback, where the stack's clients and Runner
   * connection dial it.
   */
  readonly publicOrigin?: URL;
}

export async function startVerticalStack(options: VerticalStackOptions): Promise<VerticalStack> {
  if (!options.startPersonal)
    throw new Error(
      "The vertical fixture needs lanes P/R/X's production local-owner bootstrap, folder admission and Runner composition",
    );
  return options.startPersonal(options);
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
  waitForInput(
    messageId: MessageId,
    signal: AbortSignal,
    replacementRunId?: RunId,
  ): Promise<VerticalTurn>;
  restartHost(): Promise<void>;
  restartRunner(): Promise<void>;
  close(): Promise<void>;
}

/** Personal task admission and turn collection; the runtime collaborator owns Host/Runner startup. */
export function createPersonalVerticalStack(
  agentHome: TaskFolder,
  runtime: PersonalVerticalRuntime,
): Pick<
  VerticalStack,
  | "api"
  | "agentHome"
  | "sessionCookie"
  | "hostOrigin"
  | "createThread"
  | "queueMessage"
  | "sendMessage"
  | "restartHost"
  | "restartRunner"
  | "close"
> {
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
        idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
        ...(input.generateTitle ? { generateTitle: true } : {}),
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
      const replacementRunId =
        input.onQueued && receipt.runId ? await input.onQueued(receipt.runId) : undefined;
      return runtime.waitForInput(
        receipt.messageId,
        AbortSignal.timeout(60_000),
        replacementRunId ?? undefined,
      );
    },
    restartHost: () => runtime.restartHost(),
    restartRunner: () => runtime.restartRunner(),
    close: () => runtime.close(),
  };
}
