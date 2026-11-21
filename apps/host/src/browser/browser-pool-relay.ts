import { randomUUID } from "node:crypto";
import {
  openBrowserPoolRelay,
  settleBrowserPoolRelay,
  type BrowserPoolTargetIdentity,
  type OpensteerStore,
} from "@opensteer/database";
import { z } from "zod";
import type { BrowserPoolReservation } from "./browser-pool-gate.js";

/** A relay actor can finish before everything it sent to Chromium does. */
export class PooledBrowserRelay {
  readonly #pending = new Set<Promise<unknown>>();
  readonly #channels = new Set<string>();
  readonly #finish: (confirmed: boolean) => Promise<void>;
  #outstanding = 0;
  #closing?: Promise<void>;

  private constructor(finish: (confirmed: boolean) => Promise<void>) {
    this.#finish = finish;
  }

  static async open(
    database: OpensteerStore["database"],
    target: BrowserPoolTargetIdentity,
    reservation: BrowserPoolReservation,
  ) {
    const id = randomUUID();
    await openBrowserPoolRelay(database, id, target);
    return new PooledBrowserRelay(async (confirmed) => {
      try {
        if (confirmed) await settleBrowserPoolRelay(database, id);
      } finally {
        reservation.release();
      }
    });
  }

  submitted() {
    this.#outstanding++;
  }

  acknowledged() {
    this.#outstanding--;
  }

  confirmedClosed() {
    this.#outstanding = 0;
    this.#channels.clear();
  }

  track(
    method: string,
    parameters: Record<string, unknown> | undefined,
    reply: Promise<{ readonly result: unknown }>,
  ) {
    const track = reply.then(({ result }) => {
      if (method === "Target.attachToTarget") {
        const id = z.object({ sessionId: z.string() }).safeParse(result);
        if (id.success) this.#channels.add(id.data.sessionId);
        else this.#outstanding++;
      } else if (
        method === "Target.detachFromTarget" &&
        typeof parameters?.sessionId === "string"
      ) {
        this.#channels.delete(parameters.sessionId);
      }
    });
    this.#pending.add(track);
    const forget = () => this.#pending.delete(track);
    void track.then(forget, forget);
  }

  close(): Promise<void> {
    this.#closing ??= Promise.allSettled(this.#pending).then(() =>
      this.#finish(this.#outstanding === 0 && this.#channels.size === 0),
    );
    return this.#closing;
  }
}
