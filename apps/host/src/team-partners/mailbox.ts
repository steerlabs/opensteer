import { randomUUID } from "node:crypto";
import { OpensteerError, OpensteerErrorCodeSchema } from "@opensteer/core";
import type { TeamBus } from "@opensteer/database/team-bus";
import type { TeamShareOperation } from "@opensteer/protocol";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { sql } from "kysely";
import { z } from "zod";
import { partnerError } from "./identity.js";
import type { TeamPartnerStore } from "./store.js";

const ErrorSchema = z.object({
  code: OpensteerErrorCodeSchema,
  message: z.string(),
  reason: z.string().optional(),
  next: z.string().optional(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export function partnerCallError(error: unknown) {
  const value = error instanceof OpensteerError ? error : partnerError("partner-unreachable");
  return {
    code: value.code,
    message: value.message,
    reason: value.reason,
    next: value.next,
    retryable: value.retryable,
    details: value.details,
  };
}

export class PartnerMailbox {
  readonly #waiting = new Map<string, () => void>();
  readonly #unsubscribe: () => void;
  readonly store: TeamPartnerStore;
  readonly processId: string;
  constructor(store: TeamPartnerStore, bus: TeamBus, processId: string) {
    this.store = store;
    this.processId = processId;
    this.#unsubscribe = bus.on((event) => {
      if (event.kind === "partnerResult") this.#waiting.get(event.callId)?.();
    });
  }
  async request(
    linkId: string,
    operation: TeamShareOperation,
    signal: AbortSignal,
    handoff: (send: () => Promise<void>) => Promise<void>,
  ) {
    const id = randomUUID();
    let wake = () => {};
    const ready = new Promise<void>((resolve) => {
      wake = resolve;
    });
    this.#waiting.set(id, wake);
    try {
      await handoff(async () => {
        signal.throwIfAborted();
        await this.store.access.database.transaction().execute(async (t) => {
          // Serialize admission per link so concurrent callers cannot exceed the queue cap.
          await t
            .selectFrom("teamPartnerLinks")
            .select("id")
            .where("id", "=", linkId)
            .forUpdate()
            .executeTakeFirstOrThrow();
          const count = await t
            .selectFrom("teamPartnerCalls")
            .select(t.fn.countAll<string>().as("n"))
            .where("linkId", "=", linkId)
            .where("state", "=", "queued")
            .executeTakeFirstOrThrow();
          if (Number(count.n) >= 64) throw partnerError("partner-unreachable");
          await t
            .insertInto("teamPartnerCalls")
            .values({
              id,
              linkId,
              operation: sql`${JSON.stringify(operation)}::jsonb`,
              state: "queued",
              claimedBy: null,
              result: null,
              error: null,
              expiresAt: new Date(Date.now() + 5000),
            })
            .execute();
        });
      });
      try {
        await withTimeout(ready, 5000, {
          signal,
          timeoutError: () => partnerError("partner-unreachable"),
        });
      } catch (error) {
        await this.store.access.database
          .updateTable("teamPartnerCalls")
          .set({
            state: "failed",
            claimedBy: this.processId,
            error: sql`${JSON.stringify(partnerCallError(error))}::jsonb`,
          })
          .where("id", "=", id)
          .where("state", "in", ["queued", "claimed"])
          .execute();
      }
      const row = await this.store.access.database
        .selectFrom("teamPartnerCalls")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      signal.throwIfAborted();
      if (row.state !== "done") {
        const e = ErrorSchema.parse(row.error ?? partnerCallError(undefined));
        throw new OpensteerError({
          code: e.code,
          message: e.message,
          retryable: e.retryable,
          ...(e.reason === undefined ? {} : { reason: e.reason }),
          ...(e.next === undefined ? {} : { next: e.next }),
          ...(e.details === undefined ? {} : { details: e.details }),
        });
      }
      return row.result;
    } finally {
      this.#waiting.delete(id);
      await this.store.access.database
        .deleteFrom("teamPartnerCalls")
        .where("id", "=", id)
        .execute();
    }
  }
  async claim(linkId: string) {
    return this.store.access.database.transaction().execute(async (t) => {
      const rows = await t
        .selectFrom("teamPartnerCalls")
        .select("id")
        .where("linkId", "=", linkId)
        .where("state", "=", "queued")
        .where("expiresAt", ">", sql<Date>`now()`)
        .orderBy("createdAt")
        .limit(32)
        .forUpdate()
        .skipLocked()
        .execute();
      if (!rows.length) return [];
      return t
        .updateTable("teamPartnerCalls")
        .set({ state: "claimed", claimedBy: this.processId })
        .where(
          "id",
          "in",
          rows.map((r) => r.id),
        )
        .returningAll()
        .execute();
    });
  }
  async maintenance() {
    await this.store.access.database
      .deleteFrom("teamPartnerCalls")
      .where("createdAt", "<", sql<Date>`now() - interval '1 minute'`)
      .execute();
  }
  close() {
    this.#unsubscribe();
    for (const wake of this.#waiting.values()) wake();
  }
}
