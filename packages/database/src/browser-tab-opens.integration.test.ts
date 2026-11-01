import { createId } from "@opensteer/core";
import {
  BrowserSurfaceIdSchema,
  createBrowserSessionId,
  type BrowserTabOpenBinding,
} from "@opensteer/protocol";
import { sql } from "kysely";
import { expect, it } from "vitest";
import {
  getBrowserTabOpen,
  interruptPendingBrowserTabOpens,
  settleBrowserTabOpen,
} from "./browser-session-store.js";
import { createDatabase } from "./connection.js";

it("settles each open once and interrupts pending operations before a new Host admits work", async () => {
  const database = createDatabase({ connectionString: process.env.OPENSTEER_TEST_DATABASE_URL! });
  try {
    await database.transaction().execute(async (tx) => {
      await sql`create schema tab_open_settlement;
        set local search_path = tab_open_settlement, public;
        create table browser_tab_opens (owner_id text not null, idempotency_key text not null, binding jsonb not null, runner_id text, identity_key text, primary key (owner_id, idempotency_key));`.execute(
        tx,
      );
      const binding: BrowserTabOpenBinding = {
        callerUserId: createId("user"),
        idempotencyKey: "retained-key",
        requestFingerprint: "a".repeat(64),
        chosenSessionId: createBrowserSessionId(),
        browserStarted: false,
        initialPageOperationKey: "opaque-operation",
        outcome: { kind: "pending" },
      };
      await tx
        .insertInto("browserTabOpens")
        .values({
          ownerId: binding.callerUserId,
          idempotencyKey: binding.idempotencyKey,
          binding,
          runnerId: createId("runner"),
          identityKey: null,
        })
        .execute();
      const read = () => getBrowserTabOpen(tx, binding.callerUserId, binding.idempotencyKey);
      await settleBrowserTabOpen(tx, {
        ...binding,
        requestFingerprint: "b".repeat(64),
        outcome: { kind: "failed", reason: "failed" },
      });
      expect((await read())?.outcome.kind).toBe("pending");
      await settleBrowserTabOpen(tx, { ...binding, outcome: { kind: "failed", reason: "failed" } });
      await settleBrowserTabOpen(tx, {
        ...binding,
        outcome: { kind: "opened", tabId: BrowserSurfaceIdSchema.parse("late-page") },
      });
      expect((await read())?.outcome).toEqual({ kind: "failed", reason: "failed" });
      await tx.updateTable("browserTabOpens").set({ binding }).execute();
      await interruptPendingBrowserTabOpens(tx);
      expect((await read())?.outcome).toEqual({ kind: "failed", reason: "interrupted" });
      await settleBrowserTabOpen(tx, {
        ...binding,
        outcome: { kind: "opened", tabId: BrowserSurfaceIdSchema.parse("old-runtime") },
      });
      expect((await read())?.outcome).toEqual({ kind: "failed", reason: "interrupted" });
      const opened = {
        ...binding,
        outcome: { kind: "opened" as const, tabId: BrowserSurfaceIdSchema.parse("recorded-page") },
      };
      await tx.updateTable("browserTabOpens").set({ binding: opened }).execute();
      await interruptPendingBrowserTabOpens(tx);
      await settleBrowserTabOpen(tx, { ...binding, outcome: { kind: "failed", reason: "failed" } });
      expect((await read())?.outcome).toEqual(opened.outcome);
      await sql`drop schema tab_open_settlement cascade`.execute(tx);
    });
  } finally {
    await database.destroy();
  }
});
