import type { DesktopUpdateOperation } from "@opensteer/protocol/maintenance";
import type { DesktopUpdateProgress } from "@opensteer/protocol/desktop-supervisor";
import type { DesktopUpdater } from "../app/desktop-updater.js";
import type { DesktopSupervisor } from "./desktop-supervisor.js";

export class DesktopUpdateExecutor {
  readonly #supervisor: DesktopSupervisor;
  readonly #updater: DesktopUpdater;
  readonly #install: () => Promise<void>;
  readonly #unsubscribe: () => void;
  readonly #unsubscribeState: () => void;
  #running = false;
  #queued: DesktopUpdateOperation | null = null;
  #stopped = false;
  readonly #results = new Map<string, DesktopUpdateProgress>();
  constructor(options: {
    supervisor: DesktopSupervisor;
    updater: DesktopUpdater;
    install: () => Promise<void>;
  }) {
    this.#supervisor = options.supervisor;
    this.#updater = options.updater;
    this.#install = options.install;
    this.#unsubscribeState = options.updater.subscribe((state) => options.supervisor.state(state));
    this.#unsubscribe = options.supervisor.subscribe((message) => {
      if (message.type !== "desktop-update.operation") return;
      this.#queued = message.operation;
      void this.#drain();
    });
  }
  stop(): void {
    this.#stopped = true;
    this.#unsubscribe();
    this.#unsubscribeState();
  }
  #dropQueued(id: string): void {
    if (this.#queued?.id === id) this.#queued = null;
  }
  async #drain(): Promise<void> {
    if (this.#running || this.#stopped || !this.#queued) return;
    const operation = this.#queued;
    this.#queued = null;
    this.#running = true;
    let phase = operation.state;
    let targetVersion = operation.targetVersion;
    const fromVersion = operation.fromVersion ?? this.#updater.state().currentVersion;
    const progress = async (
      state: DesktopUpdateProgress["state"],
      detail: DesktopUpdateProgress["detail"] = null,
    ) => {
      const message: DesktopUpdateProgress = {
        type: "desktop-update.progress",
        messageId: crypto.randomUUID(),
        operationId: operation.id,
        state,
        fromVersion,
        targetVersion,
        detail,
      };
      if (state === "failed" || state === "succeeded") {
        this.#results.clear();
        this.#results.set(operation.id, message);
      }
      await this.#supervisor.acknowledge(message);
      phase = state;
    };
    try {
      const result = this.#results.get(operation.id);
      if (result) {
        await this.#supervisor.acknowledge({ ...result, messageId: crypto.randomUUID() });
        return;
      }
      if (targetVersion && operation.incarnationId !== this.#supervisor.incarnationId) {
        const applied = this.#updater.state().currentVersion === targetVersion;
        await progress(applied ? "succeeded" : "failed", applied ? null : "not-applied");
        return;
      }
      await this.#updater.remoteAction(async (action) => {
        if (phase === "pending") await progress("running");
        if (phase === "running") {
          const state =
            operation.intent.action === "channel"
              ? await action.setChannel(operation.intent.channel)
              : await action.check();
          if (state.status === "ahead" || state.status === "up-to-date") {
            await progress("succeeded", state.status);
            return;
          }
          if (
            (state.status !== "available" && state.status !== "downloaded") ||
            !state.availableVersion
          )
            throw new Error("No desktop update available");
          targetVersion = state.availableVersion;
          await progress("staged");
        }
        if (!targetVersion) throw new Error("No desktop update target");
        await action.download(targetVersion);
        if (phase === "staged") await progress("installing");
        await action.restart(this.#install);
      });
    } catch {
      try {
        await progress("failed", phase === "installing" ? "handoff-failed" : "update-failed");
      } catch {
        /* Replayed from the acknowledged journal or cached result on reconnect. */
      }
    } finally {
      this.#running = false;
      // Intermediate publications for this action are obsolete after its acknowledged completion.
      this.#dropQueued(operation.id);
      void this.#drain();
    }
  }
}
