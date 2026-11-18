import {
  TeamChannelIdSchema,
  TeamLinkIdSchema,
  TeamMessageIdSchema,
  UserIdSchema,
} from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import type { Notification } from "pg";
import { z } from "zod";
import { checkoutSession } from "./connection.js";
import type { DatabaseSchema } from "./schema.js";
import { teamBusChannel } from "./team-copies-migration.js";

const RevisionSchema = z.string().regex(/^\d+$/);

/** What the team database tells every team Host process. Ids only: listeners re-read state. */
export const TeamBusEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("channel"), channelId: TeamChannelIdSchema }),
  z.strictObject({ kind: z.literal("access"), revision: RevisionSchema }),
  z.strictObject({ kind: z.literal("request"), linkId: TeamLinkIdSchema }),
  z.strictObject({ kind: z.literal("member"), userId: UserIdSchema }),
  z.strictObject({ kind: z.literal("link"), linkId: TeamLinkIdSchema, epoch: RevisionSchema }),
  z.strictObject({ kind: z.literal("linkPresence"), userId: UserIdSchema }),
  z.strictObject({ kind: z.literal("presence"), userId: UserIdSchema }),
  z.strictObject({ kind: z.literal("partnerLink"), linkId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("partnerCall"), linkId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("partnerResult"), callId: z.string().uuid() }),
  z.strictObject({ kind: z.literal("account") }),
  z.strictObject({
    kind: z.literal("typing"),
    channelId: TeamChannelIdSchema,
    rootId: TeamMessageIdSchema.nullable(),
    userId: UserIdSchema,
    typing: z.boolean(),
  }),
]);
export type TeamBusEvent = z.infer<typeof TeamBusEventSchema>;
/** Events a process sends itself; every other kind comes from a trigger on durable state. */
export type TeamBusEphemeralEvent = Extract<TeamBusEvent, { kind: "typing" }>;

export interface TeamBusOptions {
  readonly onError?: (error: unknown) => void;
  /**
   * Probes the listening session so a silently stalled connection is noticed; a probe that
   * does not answer within the interval ends the session, which turns the bus unhealthy.
   */
  readonly probeIntervalMs?: number;
}

/**
 * One LISTEN session per team Host process. A notification is a hint: every handler re-reads
 * durable state, and after any (re)connection the bus runs every resync handler so nothing missed
 * while the session was down is lost.
 */
export class TeamBus {
  readonly #database: Kysely<DatabaseSchema>;
  readonly #options: TeamBusOptions;
  readonly #handlers = new Set<(event: TeamBusEvent) => void>();
  readonly #resyncs = new Set<() => Promise<void>>();
  readonly #health = new Set<(healthy: boolean) => void>();
  #healthy = false;
  #closed = false;
  #attempt = 0;
  #reconnect: ReturnType<typeof setTimeout> | undefined;
  #connecting: Promise<void> | undefined;

  constructor(database: Kysely<DatabaseSchema>, options: TeamBusOptions = {}) {
    this.#database = database;
    this.#options = options;
  }

  get healthy() {
    return this.#healthy;
  }

  /** Resolves once listening; resync handlers registered before start run after it. */
  start(): Promise<void> {
    return this.#connect();
  }

  on(handler: (event: TeamBusEvent) => void): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  onResync(handler: () => Promise<void>): () => void {
    this.#resyncs.add(handler);
    return () => this.#resyncs.delete(handler);
  }

  onHealth(handler: (healthy: boolean) => void): () => void {
    this.#health.add(handler);
    return () => this.#health.delete(handler);
  }

  async publish(event: TeamBusEphemeralEvent): Promise<void> {
    await sql`select team_bus_notify(${JSON.stringify(event)}::jsonb)`.execute(this.#database);
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#reconnect);
    // A lost session may have left a rescan in flight. Discard the LISTEN
    // client without waiting for that work or another database round trip.
    this.#end?.(undefined, false);
  }

  #end: ((error: Error | undefined, report: boolean) => void) | undefined;

  #connect(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#connecting ??= (async () => {
      const session = await checkoutSession(this.#database);
      if (this.#closed) {
        session.release(true);
        return;
      }
      let ended = false;
      const disconnected = Promise.withResolvers<void>();
      let probe: ReturnType<typeof setInterval> | undefined;
      const end = (error: Error | undefined, report: boolean) => {
        if (ended) return;
        ended = true;
        clearInterval(probe);
        session.removeAllListeners("notification");
        session.off("end", lost);
        // The pool's client-level listener still handles any later socket error.
        session.off("error", lost);
        this.#end = undefined;
        session.release(error ?? true);
        disconnected.resolve();
        this.#setHealthy(false);
        if (report && error) this.#error(error);
        this.#schedule();
      };
      const lost = (error?: unknown) =>
        end(error instanceof Error ? error : new Error("Team bus session ended"), true);
      session.on("error", lost);
      session.on("end", lost);
      session.on("notification", (message) => this.#notify(message));
      this.#end = end;
      try {
        await session.query(`listen ${teamBusChannel}`);
      } catch (error) {
        if (this.#closed) return;
        lost(error);
        throw error;
      }
      if (ended) return;
      const interval = this.#options.probeIntervalMs ?? 5_000;
      let probing = false;
      probe = setInterval(() => {
        if (probing) {
          lost(new Error("Team bus probe timed out"));
          return;
        }
        probing = true;
        session.query("select 1").then(
          () => {
            probing = false;
          },
          (error: unknown) => lost(error),
        );
      }, interval);
      probe.unref();
      // Healthy only once every missed change is recovered; a failed rescan reconnects and retries.
      try {
        const rescan = async () => {
          for (const resync of this.#resyncs) {
            if (ended) return;
            await resync();
          }
        };
        await Promise.race([rescan(), disconnected.promise]);
      } catch (error) {
        lost(error);
        return;
      }
      if (ended) return;
      this.#attempt = 0;
      this.#setHealthy(true);
    })().finally(() => {
      this.#connecting = undefined;
    });
    return this.#connecting;
  }

  #schedule() {
    if (this.#closed || this.#reconnect) return;
    const delay = Math.min(5_000, 250 * 2 ** this.#attempt++) * (0.5 + Math.random() / 2);
    this.#reconnect = setTimeout(() => {
      this.#reconnect = undefined;
      this.#connect().catch(() => this.#schedule());
    }, delay);
    this.#reconnect.unref();
  }

  #notify(message: Notification) {
    if (message.channel !== teamBusChannel || !message.payload) return;
    let event: TeamBusEvent;
    try {
      event = TeamBusEventSchema.parse(JSON.parse(message.payload));
    } catch (error) {
      this.#error(error);
      return;
    }
    for (const handler of this.#handlers) {
      try {
        handler(event);
      } catch (error) {
        this.#error(error);
      }
    }
  }

  #setHealthy(healthy: boolean) {
    if (this.#healthy === healthy) return;
    this.#healthy = healthy;
    for (const handler of this.#health) handler(healthy);
  }

  #error(error: unknown) {
    this.#options.onError?.(error);
  }
}
