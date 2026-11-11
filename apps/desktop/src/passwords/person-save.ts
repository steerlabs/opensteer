import { randomUUID } from "node:crypto";
import type { PersonSaveBegin, PersonSaveCandidate } from "@opensteer/browser-runtime-core";
import type { PersonSaveStatus } from "@opensteer/protocol";
import type { PasswordsBrokerPersonSaveSession, PasswordsBrokerSession } from "./broker-session.js";

type Session = PasswordsBrokerSession & Partial<PasswordsBrokerPersonSaveSession>;
const skip: PersonSaveBegin = { kind: "skip" };

/**
 * Hands a login a person typed to the broker, which holds it until the person
 * answers. Desktop main keeps only transaction ids; see
 * docs/passwords.md#saving-for-people.
 */
export class PasswordsPersonSaveAuthority {
  readonly #session: Session;
  readonly #allowed: (origin: string) => boolean;
  readonly #held = new Set<string>();
  readonly #closing = new AbortController();
  /** Setup is suggested at most once each time Opensteer starts. */
  #suggestedSetup = false;

  constructor(broker: PasswordsBrokerSession, allowed: (origin: string) => boolean) {
    this.#session = broker;
    this.#allowed = allowed;
  }

  /** Only a protocol 9 connection saves, and a reconnect can change that. */
  get #broker(): (PasswordsBrokerSession & PasswordsBrokerPersonSaveSession) | undefined {
    const session = this.#session;
    return typeof session.saveBegin === "function" && typeof session.saveCommit === "function"
      ? (session as PasswordsBrokerSession & PasswordsBrokerPersonSaveSession)
      : undefined;
  }

  async begin(candidate: PersonSaveCandidate): Promise<PersonSaveBegin> {
    const broker = this.#broker;
    if (!broker || this.#closing.signal.aborted || !this.#allowed(candidate.origin)) return skip;
    const transactionId = randomUUID();
    try {
      const { decision, lifetime } = await broker.saveBegin(
        {
          transactionId,
          origin: candidate.origin,
          username: candidate.username,
          password: candidate.password,
        },
        this.#closing.signal,
      );
      if (decision.decision === "skip") {
        if (decision.reason !== "not-set-up" || candidate.presence !== "here") return skip;
        if (this.#suggestedSetup) return skip;
        this.#suggestedSetup = true;
        return { kind: "setup" };
      }
      if (lifetime.aborted || this.#closing.signal.aborted) {
        void broker.cancel(transactionId).catch(() => undefined);
        return skip;
      }
      this.#held.add(transactionId);
      lifetime.addEventListener("abort", () => this.#held.delete(transactionId), { once: true });
      return { kind: "offer", transactionId, expiresAt: Date.parse(decision.expiresAt) };
    } catch {
      // A broker failure can carry the login in its cause; only `skip` leaves here.
      return skip;
    }
  }

  async commit(transactionId: string): Promise<PersonSaveStatus> {
    const broker = this.#broker;
    if (!this.#held.delete(transactionId)) return "ended";
    if (!broker) return "unavailable";
    try {
      const result = await broker.saveCommit(transactionId);
      if (result.saved) return "saved";
      return result.reason === "saved"
        ? "exists"
        : result.reason === "ended"
          ? "ended"
          : "unavailable";
    } catch {
      return "unavailable";
    }
  }

  cancel(transactionId: string): void {
    if (!this.#held.delete(transactionId)) return;
    void this.#session.cancel(transactionId).catch(() => undefined);
  }

  close(): void {
    this.#closing.abort();
    for (const transactionId of [...this.#held]) this.cancel(transactionId);
  }
}
