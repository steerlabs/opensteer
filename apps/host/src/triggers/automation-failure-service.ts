import { OpensteerError } from "@opensteer/core";
import type { AutomationFailureStore, PendingAutomationFailure } from "@opensteer/database";
import type { CommandService } from "@opensteer/orchestration";
import { DeadlineDrain, retryWithBackoff } from "../runtime/deadline-drain.js";

type FailureStore = Pick<
  AutomationFailureStore,
  "listDue" | "nextDeadline" | "retryLater" | "settle"
>;

/**
 * Tells the task an automation works for that it stopped: its one scheduled
 * run failed, or it was paused after repeated failures. That is its anchor, or
 * the nearest listed task above an automation that runs in its own task. The
 * message wakes that task's agent, whose reply is what reaches the person — the same
 * way an answered Request continues the Thread that asked it.
 */
export class AutomationFailureService {
  readonly #commands: Pick<CommandService, "enqueueThreadInput">;
  readonly #onError: (error: unknown) => void;
  readonly #store: FailureStore;
  readonly #drains: DeadlineDrain;

  constructor(options: {
    readonly commands: Pick<CommandService, "enqueueThreadInput">;
    readonly onError: (error: unknown) => void;
    readonly store: FailureStore;
  }) {
    this.#commands = options.commands;
    this.#onError = options.onError;
    this.#store = options.store;
    this.#drains = new DeadlineDrain({ drain: () => this.#drainOnce(), onError: this.#onError });
  }

  start(): void {
    this.#drains.start();
  }

  notify(): void {
    this.#drains.wake();
  }

  close(): Promise<void> {
    return this.#drains.close();
  }

  async #drainOnce(): Promise<Date | null | typeof retryWithBackoff> {
    const due = await this.#store.listDue();
    for (const notice of due) {
      try {
        const delivered = await this.#commands.enqueueThreadInput({
          content: [{ text: noticeText(notice), type: "text" }],
          idempotencyKey: `automation-failure:${notice.id}`,
          policy: "queue",
          requestedBy: notice.createdBy,
          source: { kind: "automation", noticeId: notice.id, triggerId: notice.triggerId },
          threadId: notice.destinationThreadId,
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
    // Every listed notice was settled or given a durable retry time, so a pass
    // that listed some made progress. One that listed none while a notice is
    // still due (one the listing cannot reach) backs off instead of spinning.
    const next = await this.#store.nextDeadline();
    return due.length === 0 && next && next.getTime() <= Date.now() ? retryWithBackoff : next;
  }
}

/** What the agent reads: which automation stopped, where it runs, why, and that it will not run. */
function noticeText(notice: PendingAutomationFailure): string {
  const automation =
    notice.destinationThreadId === notice.anchorThreadId
      ? `The automation "${notice.triggerName}"`
      : `The automation "${notice.triggerName}", which runs in its own task ${JSON.stringify(notice.anchorThreadTitle)} (${notice.anchorThreadId}),`;
  if (notice.reason === "final-occurrence-interrupted") {
    // Opensteer cannot know whether the program's effects happened, and running
    // it again is the agent's decision, not something to do silently.
    return [
      `${automation} was interrupted on its only scheduled run when Opensteer restarted or its computer disconnected. It may not have finished, and it will not run again on its own.`,
      "",
      `Check what it already did, then run it again with opensteer_automation_control action "run_now" (automationId ${notice.triggerId}) if it still needs to happen.`,
      "",
      `Detail: ${JSON.stringify(notice.detail)}`,
    ].join("\n");
  }
  const ended =
    notice.reason === "final-occurrence-failed"
      ? `${automation} failed on its only scheduled run, so it will not run again.`
      : `${automation} was paused after repeated failures and will not run again until it is fixed and resumed.`;
  // The program's own words are quoted as data, so they read as its error and
  // never as something Opensteer is saying.
  return `${ended}\n\nIts error, as the program reported it: ${JSON.stringify(notice.detail)}`;
}

function failureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "Automation failure delivery failed";
  return message.trim().slice(0, 500) || "Automation failure delivery failed";
}
