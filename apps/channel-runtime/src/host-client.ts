import { randomUUID } from "node:crypto";
import type { ChannelRuntimeCapability } from "@opensteer/channel-core";
import type { MessagingModule } from "@opensteer/messaging-module";
import { RunnerBootIdSchema, type RunnerDescriptor } from "@opensteer/protocol";
import {
  RunnerModuleConnection,
  moduleReadiness,
  type FileRunnerIdentityStore,
  type RunnerIdentity,
} from "@opensteer/runner-client";
import type { ChannelRuntimeConfig } from "./config.js";

/**
 * The messaging module of a Runner.
 *
 * This process is a computer the Deployment enrolled, not a separate kind of
 * identity: it holds a Runner key, opens the primary connection with it, and
 * carries every messaging operation on the module stream that connection
 * authorized, through the shared `MessagingModule`.
 */
export class RunnerMessagingConnection {
  readonly #connection: RunnerModuleConnection;
  readonly #module: MessagingModule;
  readonly #stop = new AbortController();
  #run: Promise<void> | undefined;

  constructor(options: {
    readonly config: ChannelRuntimeConfig;
    readonly identity: RunnerIdentity;
    readonly identityStore: Pick<FileRunnerIdentityStore, "acceptHostConnection">;
    readonly module: MessagingModule;
    readonly runtimeVersion: string;
  }) {
    this.#module = options.module;
    const capabilities: readonly ChannelRuntimeCapability[] = options.module.capabilities();
    const bootId = RunnerBootIdSchema.parse(`rbt_${randomUUID()}`);
    this.#connection = new RunnerModuleConnection({
      bootId,
      ...(options.config.controlCaPath ? { controlCaPath: options.config.controlCaPath } : {}),
      descriptor: (identity): RunnerDescriptor => ({
        bootId,
        capabilities: [],
        modules: { messaging: { capabilities: [...capabilities] } },
        name: options.config.name,
        runnerId: identity.runnerId,
        runnerKind: "managed",
        runtimeVersion: options.runtimeVersion,
      }),
      ...(options.config.enrollmentToken
        ? { enrollmentToken: options.config.enrollmentToken }
        : {}),
      hostOrigin: options.config.hostUrl,
      identity: options.identity,
      identityStore: options.identityStore,
      logger: {
        error: (message, details) => report("channel-runtime.disconnected", message, details),
        info: (message, details) => report("channel-runtime.connected", message, details),
      },
      module: "messaging",
      mode: options.config.mode,
      onStream: async (stream) => await this.#module.attach(stream),
      onStreamClosed: async () => await this.#module.detach(),
      onStreamFrame: (frame, isBinary, signal) => this.#module.handleFrame(frame, isBinary, signal),
      readiness: () => moduleReadiness("messaging", "ready"),
    });
  }

  get authenticated(): boolean {
    return this.#module.attached;
  }

  start(): void {
    if (this.#run) return;
    this.#run = this.#connection.run(this.#stop.signal);
  }

  async close(): Promise<void> {
    this.#stop.abort();
    await this.#run;
  }
}

function report(
  event: string,
  message: string,
  details: Readonly<Record<string, unknown>> | undefined,
): void {
  process.stdout.write(`${JSON.stringify({ ...details, event, message })}\n`);
}
