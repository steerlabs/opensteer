import { OpensteerError } from "@opensteer/core";
import type { AutomationFailureStore, PendingAutomationFailure } from "@opensteer/database";
import type { CommandService } from "@opensteer/orchestration";

const defaultIntervalMs = 30_000;

/**
 * Tells an automation's anchor Thread that it stopped working: its one
 * scheduled run failed, or it was paused after repeated failures. The message
 * wakes that Thread's agent, whose reply is what reaches the person — the same
 * way an answered Request continues the Thread that asked it.
 */
export class AutomationFailureService {
  readonly #commands: Pick<CommandService, "enqueueThreadInput">;
  readonly #intervalMs: number;
  readonly #onError: (error: unknown) => void;
  readonly #store: Pick<AutomationFailureStore, "listDue" | "retryLater" | "settle">;
  #closed = false;
  #drain: Promise<void> | undefined;
  #again = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: {
    readonly commands: Pick<CommandService, "enqueueThreadInput">;
    readonly intervalMs?: number;
    readonly onError: (error: unknown) => void;
    readonly store: Pick<AutomationFailureStore, "listDue" | "retryLater" | "settle">;
  }) {
    this.#commands = options.commands;
    this.#intervalMs = options.intervalMs ?? defaultIntervalMs;
    this.#onError = options.onError;
    this.#store = options.store;
  }

  start(): void {
    if (this.#closed || this.#timer) return;
    this.#timer = setInterval(() => this.notify(), this.#intervalMs);
    this.#timer.unref();
    this.notify();
  }

  /** Something may have stopped; read the notices owed now. */
  notify(): void {
    if (this.#closed) return;
    if (this.#drain) {
      this.#again = true;
      return;
    }
    this.#drain = this.#drainOnce()
      .catch(this.#onError)
      .finally(() => {
        this.#drain = undefined;
        if (this.#again) {
          this.#again = false;
          this.notify();
        }
      });
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#drain;
  }

  async #drainOnce(): Promise<void> {
    for (const notice of await this.#store.listDue()) {
      try {
        const delivered = await this.#commands.enqueueThreadInput({
          content: [{ text: noticeText(notice), type: "text" }],
          idempotencyKey: `automation-failure:${notice.id}`,
          policy: "queue",
          requestedBy: notice.createdBy,
          source: { kind: "automation", noticeId: notice.id, triggerId: notice.triggerId },
          threadId: notice.anchorThreadId,
        });
        await this.#store.settle({
          id: notice.id,
          reason:
            delivered.disposition === "cancelled" ? "The anchor Thread refused the message" : null,
        });
      } catch (error) {
        if (error instanceof OpensteerError && !error.retryable) {
          await this.#store.settle({ id: notice.id, reason: failureReason(error) });
          continue;
        }
        await this.#store.retryLater({ error: failureReason(error), id: notice.id });
        this.#onError(error);
      }
    }
  }
}

/** What the anchor agent reads: which automation stopped, why, and that it will not run. */
function noticeText(notice: PendingAutomationFailure): string {
  if (notice.reason === "final-occurrence-interrupted") {
    // Opensteer cannot know whether the program's effects happened, and running
    // it again is the agent's decision, not something to do silently.
    return [
      `The automation "${notice.triggerName}" was interrupted on its only scheduled run when Opensteer restarted or its computer disconnected. It may not have finished, and it will not run again on its own.`,
      "",
      `Check what it already did, then run it again with trigger_write action "run" (triggerId ${notice.triggerId}) if it still needs to happen.`,
      "",
      `Detail: ${JSON.stringify(notice.detail)}`,
    ].join("\n");
  }
  const ended =
    notice.reason === "final-occurrence-failed"
      ? `The automation "${notice.triggerName}" failed on its only scheduled run, so it will not run again.`
      : `The automation "${notice.triggerName}" was paused after repeated failures and will not run again until it is fixed and resumed.`;
  // The program's own words are quoted as data, so they read as its error and
  // never as something Opensteer is saying.
  return `${ended}\n\nIts error, as the program reported it: ${JSON.stringify(notice.detail)}`;
}

function failureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "Automation failure delivery failed";
  return message.trim().slice(0, 500) || "Automation failure delivery failed";
}
