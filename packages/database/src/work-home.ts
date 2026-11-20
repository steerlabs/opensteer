import {
  defaultWorkPolicy,
  ManagedHomeClaimReceiptSchema,
  WorkAuditRecordSchema,
  workAuditKindValues,
  WorkPolicySchema,
  workPolicyAllowsGrant,
  type WorkHomeMarker,
  type WorkPolicyDocument,
  type EffectiveWorkPolicy,
} from "@opensteer/control-plane-protocol";
import {
  minThreadAccessMode,
  OpensteerError,
  type AgentGrant,
  type DeploymentId,
} from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import { AgentConnectionStore } from "./agent-connection-store.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import { withPersonalReadTransaction, withPersonalTransaction } from "./personal-transaction.js";
import type { DatabaseSchema } from "./schema.js";
import { jsonValue } from "./store-primitives.js";
import { enableWorkHomeTriggers } from "./work-home-migration.js";
import { isWorkHomeDatabase, markWorkHomeDatabase } from "./work-home-context.js";

const assignmentStates = ["active", "offboarding", "ended"] as const;

export class WorkHomeStore {
  readonly #db: Kysely<DatabaseSchema>;

  constructor(database: Kysely<DatabaseSchema>) {
    this.#db = database;
  }

  async claimedMarker(): Promise<WorkHomeMarker | undefined> {
    const latest = await this.#db
      .selectFrom("securityAudit")
      .select("metadata")
      .where("action", "=", "instance.managed-owner-claimed")
      .orderBy("createdAt", "desc")
      .limit(1)
      .executeTakeFirst();
    if (!latest) return undefined;
    return ManagedHomeClaimReceiptSchema.parse(latest.metadata["receipt"]).document.work;
  }

  async initialize(marker: WorkHomeMarker, deploymentId: DeploymentId): Promise<void> {
    await this.#db.transaction().execute(async (tx) => {
      const inserted = await tx
        .insertInto("workHomePolicy")
        .values({
          assignmentId: marker.assignmentId,
          deploymentId,
          organizationName: marker.organizationName,
          policy: jsonValue(defaultWorkPolicy),
        })
        .onConflict((conflict) => conflict.column("singleton").doNothing())
        .returning("assignmentId")
        .executeTakeFirst();
      if (inserted) {
        await tx.insertInto("workAuditHead").values({ singleton: true }).execute();
        await enableWorkHomeTriggers(tx);
      }
      const current = await tx.selectFrom("workHomePolicy").selectAll().executeTakeFirstOrThrow();
      if (current.assignmentId !== marker.assignmentId || current.deploymentId !== deploymentId)
        throw new Error("The work marker belongs to a different Home");
    });
    markWorkHomeDatabase(this.#db);
  }

  async applied(): Promise<EffectiveWorkPolicy> {
    const row = await this.#db.selectFrom("workHomePolicy").selectAll().executeTakeFirstOrThrow();
    return {
      ...WorkPolicySchema.parse(row.policy),
      organizationName: row.organizationName,
      appliedRevision: row.revision,
      auditRecordKinds: [...workAuditKindValues],
    };
  }

  previewDeviceEnrollment(tokenHash: string) {
    return withPersonalReadTransaction(this.#db, async (tx) => {
      const enrollment = await tx
        .selectFrom("runnerEnrollments as enrollment")
        .innerJoin("personalSettings as home", "home.ownerId", "enrollment.ownerUserId")
        .innerJoin("users as owner", "owner.id", "home.ownerId")
        .select("enrollment.id")
        .where("home.singletonKey", "=", "personal")
        .where("owner.disabledAt", "is", null)
        .where("enrollment.tokenHash", "=", tokenHash)
        .where("enrollment.ownerKind", "=", "user")
        .whereRef("enrollment.createdBy", "=", "home.ownerId")
        .where("enrollment.runnerKind", "=", "local")
        .where("enrollment.consumedAt", "is", null)
        .where("enrollment.runnerId", "is", null)
        .where("enrollment.expiresAt", ">", sql<Date>`clock_timestamp()`)
        .executeTakeFirst();
      if (!enrollment)
        throw new OpensteerError({
          code: "forbidden",
          message: "This device setup code is invalid or expired.",
        });
      if (!isWorkHomeDatabase(tx)) return {};
      const { organizationName, policy } = await tx
        .selectFrom("workHomePolicy")
        .select(["organizationName", "policy"])
        .executeTakeFirstOrThrow();
      return { organizationName, devices: WorkPolicySchema.parse(policy).devices };
    });
  }

  apply(document: WorkPolicyDocument): Promise<{ revision: number; changed: boolean }> {
    return commitPersonalMutation(this.#db, async (tx, mutation) => {
      const current = await tx.selectFrom("workHomePolicy").selectAll().executeTakeFirstOrThrow();
      if (
        document.assignmentId !== current.assignmentId ||
        document.deploymentId !== current.deploymentId
      )
        throw new Error("Policy belongs to a different work Home");
      if (document.revision < current.revision)
        return { revision: current.revision, changed: false };
      const state =
        assignmentStates[
          Math.max(
            assignmentStates.indexOf(current.state),
            assignmentStates.indexOf(document.state),
          )
        ]!;
      if (document.revision === current.revision && state === current.state)
        return { revision: current.revision, changed: false };

      const policy = document.revision === current.revision ? current.policy : document.policy;
      const rows = await tx
        .selectFrom("agentConnections")
        .select(["id", "userId", "grant", "grantRevision", "accessMode"])
        .where("revokedAt", "is", null)
        .orderBy("id")
        .execute();
      const connections = new AgentConnectionStore(tx);
      for (const row of rows) {
        if (
          state !== "active" ||
          (row.grant.scope === "everything" && !workPolicyAllowsGrant(policy, row.grant))
        ) {
          await connections.revoke(row.userId, row.id);
          continue;
        }
        const grant: AgentGrant =
          row.grant.scope === "selected" && !policy.allowTasks
            ? { ...row.grant, tasks: false }
            : row.grant;
        const accessMode = minThreadAccessMode(row.accessMode, policy.externalMaxMode);
        const tasksRemoved =
          row.grant.scope === "selected" && row.grant.tasks && !policy.allowTasks;
        if (tasksRemoved || accessMode !== row.accessMode) {
          await connections.update(row.userId, {
            connectionId: row.id,
            expectedRevision: row.grantRevision,
            grant,
            accessMode,
          });
        }
      }
      await tx
        .updateTable("workHomePolicy")
        .set({ revision: document.revision, state, policy: jsonValue(policy) })
        .where("singleton", "=", true)
        .execute();
      if (document.revision !== current.revision) mutation.resetScope("shell");
      return { revision: document.revision, changed: true };
    });
  }

  async offboard(): Promise<void> {
    await withPersonalTransaction(this.#db, async (tx) => {
      await tx
        .updateTable("workHomePolicy")
        .set({ state: "offboarding" })
        .where("state", "=", "active")
        .execute();
    });
  }

  prepareAuditBatch() {
    return this.#db.transaction().execute(async (tx) => {
      const head = await tx
        .selectFrom("workAuditHead")
        .selectAll()
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      if (head.acknowledgedSequence === head.sequence) return null;
      const fromSequence = head.acknowledgedSequence + 1;
      const through = head.sendingThrough ?? Math.min(head.sequence, fromSequence + 255);
      const rows = await tx
        .selectFrom("workAuditOutbox")
        .selectAll()
        .where("sequence", ">=", fromSequence)
        .where("sequence", "<=", through)
        .orderBy("sequence")
        .execute();
      if (rows.length !== through - fromSequence + 1)
        throw new Error("Work audit outbox has a gap");
      if (head.sendingThrough === null)
        await tx
          .updateTable("workAuditHead")
          .set({ sendingThrough: through })
          .where("singleton", "=", true)
          .execute();
      return {
        fromSequence,
        through,
        records: rows.map(({ record }) => WorkAuditRecordSchema.parse(record)),
        headHash: rows[rows.length - 1]!.hash,
      };
    });
  }

  async acknowledgeAuditBatch(through: number): Promise<void> {
    await this.#db.transaction().execute(async (tx) => {
      const result = await tx
        .updateTable("workAuditHead")
        .set({ acknowledgedSequence: through, sendingThrough: null })
        .where("singleton", "=", true)
        .where("sendingThrough", "=", through)
        .returning("sequence")
        .executeTakeFirst();
      if (!result) return;
      await tx
        .selectFrom("workAuditOutbox")
        .select("sequence")
        .where("sequence", "<=", through)
        .orderBy("sequence")
        // FOR UPDATE: Acquire the locks required by the delete in sequence order.
        .forUpdate()
        .execute();
      await tx.deleteFrom("workAuditOutbox").where("sequence", "<=", through).execute();
    });
  }
}
