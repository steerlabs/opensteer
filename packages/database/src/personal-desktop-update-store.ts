import { requirePersonalOwner } from "./personal-settings-store.js";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { OpensteerError, type AuthenticatedSession } from "@opensteer/core";
import {
  DesktopUpdateOperationSchema,
  type DesktopUpdateOperation,
  type DesktopUpdateRequest,
} from "@opensteer/protocol/maintenance";
import type { DesktopUpdateProgress } from "@opensteer/protocol/desktop-supervisor";
import type { Kysely, Selectable, Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { requestSettlementActor } from "./request-settlement.js";

const active = ["pending", "running", "staged", "installing"] as const;
function view(row: Selectable<DatabaseSchema["personalDesktopUpdate"]>): DesktopUpdateOperation {
  return DesktopUpdateOperationSchema.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}
function conflict(message: string): never {
  throw new OpensteerError({ code: "conflict", message });
}

export class PersonalDesktopUpdateStore {
  readonly database: Kysely<DatabaseSchema>;
  constructor(database: Kysely<DatabaseSchema>) {
    this.database = database;
  }

  async latest(): Promise<DesktopUpdateOperation | null> {
    const row = await this.database
      .selectFrom("personalDesktopUpdate")
      .selectAll()
      .orderBy("position", "desc")
      .limit(1)
      .executeTakeFirst();
    return row ? view(row) : null;
  }

  async request(
    session: AuthenticatedSession,
    request: DesktopUpdateRequest,
  ): Promise<DesktopUpdateOperation> {
    return this.database.transaction().execute(async (tx) => {
      await this.#lock(tx);
      await requirePersonalOwner(tx, session.user.id);
      await requestSettlementActor(tx, session.user.id, session.id);
      const replay = await tx
        .selectFrom("personalDesktopUpdate")
        .selectAll()
        .where("requestedBy", "=", session.user.id)
        .where("idempotencyKey", "=", request.idempotencyKey)
        .executeTakeFirst();
      if (replay) {
        if (!isDeepStrictEqual(replay.intent, request.intent))
          conflict("This operation key was already used for another action");
        return view(replay);
      }
      const existing = await tx
        .selectFrom("personalDesktopUpdate")
        .select("id")
        .where("state", "in", active)
        .executeTakeFirst();
      if (existing) conflict("A desktop update is already pending");
      return view(
        await tx
          .insertInto("personalDesktopUpdate")
          .values({
            id: randomUUID(),
            requestedBy: session.user.id,
            idempotencyKey: request.idempotencyKey,
            intent: request.intent,
            state: "pending",
            fromVersion: null,
            targetVersion: null,
            incarnationId: null,
            detail: null,
          })
          .returningAll()
          .executeTakeFirstOrThrow(),
      );
    });
  }

  async progress(
    incarnationId: string,
    progress: DesktopUpdateProgress,
    currentVersion: string,
  ): Promise<void> {
    await this.database.transaction().execute(async (tx) => {
      await this.#lock(tx);
      const row = await tx
        .selectFrom("personalDesktopUpdate")
        .selectAll()
        .where("id", "=", progress.operationId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      const reconciling =
        row.targetVersion !== null &&
        row.incarnationId !== incarnationId &&
        row.state !== "succeeded" &&
        row.state !== "failed";
      if (reconciling) {
        const applied = row.targetVersion === currentVersion;
        if (
          progress.state !== (applied ? "succeeded" : "failed") ||
          progress.detail !== (applied ? null : "not-applied")
        )
          conflict("A new desktop process must reconcile the installed version");
      }
      if (row.state === progress.state) {
        if (
          row.targetVersion !== progress.targetVersion ||
          row.fromVersion !== progress.fromVersion ||
          row.detail !== progress.detail
        )
          conflict("The acknowledged update phase cannot change");
        return;
      }
      if (row.state === "succeeded" || row.state === "failed")
        conflict("The desktop update has ended");
      if (!reconciling) {
        const next = {
          pending: "running",
          running: "staged",
          staged: "installing",
          installing: "succeeded",
        }[row.state];
        if (
          progress.state !== "failed" &&
          progress.state !== next &&
          !(row.state === "running" && progress.state === "succeeded" && !progress.targetVersion)
        )
          conflict("Invalid desktop update phase");
      }
      if (
        (progress.state === "staged" || progress.state === "installing") &&
        !progress.targetVersion
      )
        conflict("An update target is required before staging");
      if (
        row.targetVersion &&
        (row.targetVersion !== progress.targetVersion || row.fromVersion !== progress.fromVersion)
      )
        conflict("The desktop update target cannot change");
      await tx
        .updateTable("personalDesktopUpdate")
        .set({
          state: progress.state,
          fromVersion: progress.fromVersion,
          targetVersion: progress.targetVersion,
          detail: progress.detail,
          incarnationId,
          updatedAt: new Date(),
        })
        .where("id", "=", row.id)
        .execute();
    });
  }

  async #lock(tx: Transaction<DatabaseSchema>): Promise<void> {
    await tx
      .selectFrom("personalRemoteAccess")
      .select("singletonKey")
      .where("singletonKey", "=", "personal")
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
  }
}
