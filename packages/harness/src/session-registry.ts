import { OpensteerError } from "@opensteer/core";

/** What the registry needs of a driver's session: its identity and a way to end it. */
export interface RegisteredHarnessSession {
  readonly providerSessionReference: string;
  stop(): Promise<void>;
}

/**
 * The live provider sessions one adapter holds, and the rules every adapter
 * owes them.
 *
 * A provider session reference is a conversation, and a conversation carries
 * exactly one Run's context: a second open against a reference this adapter is
 * already serving is a conflict, never a second attachment. Opens in flight
 * count as held, because the reference is claimed from the moment the provider
 * is asked for it.
 *
 * A session that opened into a closed adapter, or that lost a race for its
 * reference, is always stopped. It is a live provider process nobody can reach
 * any more, so leaving it running would leak the process and hold the
 * conversation against the next attempt to resume it.
 */
export class HarnessSessionRegistry<S extends RegisteredHarnessSession> {
  readonly #engineLabel: string;
  readonly #sessions = new Map<string, S>();
  readonly #keyedOpens = new Map<string, Promise<S>>();
  readonly #anonymousOpens = new Set<Promise<S>>();
  #closed = false;

  /** @param engineLabel the engine's own name, as it reads in a refusal. */
  constructor(engineLabel: string) {
    this.#engineLabel = engineLabel;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** True while this adapter holds, or is opening, a session for the reference. */
  holds(reference: string): boolean {
    return this.#sessions.has(reference) || this.#keyedOpens.has(reference);
  }

  assertOpen(): void {
    if (this.#closed) {
      throw new OpensteerError({
        code: "harness_error",
        message: `${this.#engineLabel} harness adapter is closed`,
      });
    }
  }

  /**
   * Opens a session whose provider reference is known before the provider is
   * asked — a resume, or a start whose reference the driver mints itself.
   */
  async open(reference: string, start: () => Promise<S>): Promise<S> {
    if (this.holds(reference)) throw this.#conflict(reference);
    const opening = start();
    this.#keyedOpens.set(reference, opening);
    try {
      const session = await opening;
      this.assertOpen();
      if (this.#sessions.has(reference)) {
        await session.stop();
        throw this.#conflict(reference);
      }
      this.#sessions.set(reference, session);
      return session;
    } catch (error) {
      const session = await opening.catch(() => undefined);
      if (session) await session.stop();
      throw error;
    } finally {
      this.#keyedOpens.delete(reference);
    }
  }

  /**
   * Opens a session whose provider reference only exists once the provider has
   * answered, so the claim can only be made after the fact.
   */
  async openUnreferenced(start: () => Promise<S>): Promise<S> {
    const opening = start();
    this.#anonymousOpens.add(opening);
    let session: S;
    try {
      session = await opening;
      this.assertOpen();
    } catch (error) {
      const opened = await opening.catch(() => undefined);
      if (opened) await opened.stop();
      throw error;
    } finally {
      this.#anonymousOpens.delete(opening);
    }
    const reference = session.providerSessionReference;
    if (this.#sessions.has(reference)) {
      await session.stop();
      throw this.#conflict(reference);
    }
    this.#sessions.set(reference, session);
    return session;
  }

  /** Forgets a session that has already stopped itself. */
  release(session: S): void {
    for (const [reference, candidate] of this.#sessions) {
      if (candidate === session) this.#sessions.delete(reference);
    }
  }

  /**
   * Stops every session this adapter holds, including the ones still opening:
   * an open that lands after the adapter closed would otherwise leave a
   * provider process running with nothing able to reach it.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const opening = await Promise.allSettled([
      ...this.#keyedOpens.values(),
      ...this.#anonymousOpens,
    ]);
    const sessions = [
      ...this.#sessions.values(),
      ...opening.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
    ];
    this.#sessions.clear();
    this.#keyedOpens.clear();
    await Promise.allSettled([...new Set(sessions)].map((session) => session.stop()));
  }

  #conflict(reference: string): OpensteerError {
    return new OpensteerError({
      code: "conflict",
      message: `${this.#engineLabel} session ${reference} is already active in this harness instance`,
    });
  }
}
