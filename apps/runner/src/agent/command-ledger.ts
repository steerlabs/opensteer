import { createHash } from "node:crypto";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import type { ProtocolError, RunnerCommand } from "@opensteer/protocol";

export type CommandDecision =
  | { readonly status: "accepted"; readonly workspacePath?: string }
  | { readonly message: string; readonly status: "uncertain" }
  | { readonly error: ProtocolError; readonly status: "rejected" };

interface LedgerEntry {
  readonly fingerprint: string;
  readonly result: Promise<CommandDecision>;
  touchedAt: number;
}

export class CommandLedger {
  readonly #entries = new Map<string, LedgerEntry>();
  readonly #maxEntries: number;
  readonly #ttlMs: number;

  constructor(options: { readonly maxEntries?: number; readonly ttlMs?: number } = {}) {
    this.#maxEntries = options.maxEntries ?? 10_000;
    this.#ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1_000;
    if (!Number.isSafeInteger(this.#maxEntries) || this.#maxEntries < 1) {
      throw new TypeError("Command ledger maxEntries must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 1) {
      throw new TypeError("Command ledger ttlMs must be a positive safe integer");
    }
  }

  execute(
    command: RunnerCommand,
    operation: () => Promise<CommandDecision>,
  ): Promise<CommandDecision> {
    const now = Date.now();
    this.#prune(now);
    const fingerprint = fingerprintCommand(command);
    const existing = this.#entries.get(command.commandId);
    if (existing) {
      existing.touchedAt = now;
      if (existing.fingerprint !== fingerprint) {
        return Promise.resolve({
          error: {
            code: "conflict",
            message: "Command identity was reused with different content",
            retryable: false,
          },
          status: "rejected",
        });
      }
      return existing.result;
    }
    const result: Promise<CommandDecision> = Promise.resolve()
      .then(operation)
      .catch((error: unknown) => ({
        error: toProtocolError(error),
        status: "rejected" as const,
      }))
      .then((decision) => {
        // A retryable rejection says the Runner was not ready, not that the
        // command was wrong. Forgetting it lets the Host's paced retry of the
        // same command ID be admitted again — with a fresh execution
        // generation if the Host issued one — instead of replaying the refusal
        // or reporting identity reuse until the entry expires.
        if (
          decision.status === "rejected" &&
          decision.error.retryable &&
          this.#entries.get(command.commandId)?.result === result
        ) {
          this.#entries.delete(command.commandId);
        }
        return decision;
      });
    this.#entries.set(command.commandId, { fingerprint, result, touchedAt: now });
    this.#prune(now);
    return result;
  }

  #prune(now: number): void {
    for (const [commandId, entry] of this.#entries) {
      if (now - entry.touchedAt > this.#ttlMs) this.#entries.delete(commandId);
    }
    while (this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#entries.delete(oldest);
    }
  }
}

function fingerprintCommand(command: RunnerCommand): string {
  return createHash("sha256").update(canonicalJson(command)).digest("hex");
}

function toProtocolError(error: unknown): ProtocolError {
  return {
    code: "internal",
    message: safeErrorMessage(error),
    retryable: false,
  };
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Runner command failed";
  return message.slice(0, 2_000) || "Runner command failed";
}
