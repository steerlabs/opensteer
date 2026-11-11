import { projectOriginFromRow } from "./execution-authority.js";
import {
  createId,
  OpensteerError,
  ProjectRunBindingSchema,
  type ProjectRunBinding,
} from "@opensteer/core";
import { PrincipalIdSchema } from "@opensteer/channel-core";
import { ProjectRunControlSchema, type ProjectRunControl } from "@opensteer/protocol";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { sql, type Transaction } from "kysely";
import { z } from "zod";
import { assertProjectAuthority } from "./deployment-execution-authority.js";
import { jsonValue, lockWorkspaceRow } from "./store-primitives.js";
import type { DatabaseSchema } from "./schema.js";

export interface ProjectRequestControlPort {
  find(
    transaction: Transaction<DatabaseSchema>,
    input: { readonly binding: ProjectRunBinding; readonly idempotencyKey: string },
  ): Promise<ProjectRunControl | null>;
  enqueue(
    transaction: Transaction<DatabaseSchema>,
    input: {
      readonly binding: ProjectRunBinding;
      readonly idempotencyKey: string;
      readonly control: ProjectRunControl;
    },
  ): Promise<{ readonly created: boolean }>;
}

export const StoredProjectControlSchema = z.strictObject({
  binding: ProjectRunBindingSchema,
  control: ProjectRunControlSchema,
  correlationId: z.string().uuid(),
});

function controlIdentity(binding: ProjectRunBinding, idempotencyKey: string): string {
  if (!idempotencyKey || idempotencyKey.includes("\0") || Buffer.byteLength(idempotencyKey) > 4096)
    throw new OpensteerError({
      code: "bad_request",
      message: "Project control identity is invalid",
    });
  return `project-control:${createHash("sha256")
    .update(canonicalJson(["project-control-v1", binding, idempotencyKey]))
    .digest("hex")}`;
}

function controlConflict(): never {
  throw new OpensteerError({
    code: "conflict",
    reason: "idempotency-conflict",
    message: "Project control identity was reused with different content",
  });
}

/** The caller reserves the Run before Workspace/Request fences; enqueue never contacts a Runner. */
export class ProjectExecutionStore implements ProjectRequestControlPort {
  async find(
    transaction: Transaction<DatabaseSchema>,
    input: { readonly binding: ProjectRunBinding; readonly idempotencyKey: string },
  ): Promise<ProjectRunControl | null> {
    const binding = ProjectRunBindingSchema.parse(input.binding);
    await assertProjectAuthority(transaction);
    const row = await transaction
      .selectFrom("commands")
      .select("payload")
      .where(
        "actorPrincipalId",
        "=",
        PrincipalIdSchema.parse(binding.authority.principal.principalId),
      )
      .where("idempotencyKey", "=", controlIdentity(binding, input.idempotencyKey))
      .where("type", "=", "run.control.project")
      .executeTakeFirst();
    if (!row) return null;
    const stored = StoredProjectControlSchema.parse(row.payload);
    if (!isDeepStrictEqual(stored.binding, binding)) controlConflict();
    return stored.control;
  }

  async enqueue(
    transaction: Transaction<DatabaseSchema>,
    input: {
      readonly binding: ProjectRunBinding;
      readonly idempotencyKey: string;
      readonly control: ProjectRunControl;
    },
  ): Promise<{ readonly created: boolean }> {
    const binding = ProjectRunBindingSchema.parse(input.binding);
    const control = ProjectRunControlSchema.parse(input.control);
    const prior = await this.find(transaction, { binding, idempotencyKey: input.idempotencyKey });
    if (prior) {
      if (!isDeepStrictEqual(prior, control)) controlConflict();
      return { created: false };
    }
    const run = await transaction
      .selectFrom("runs")
      .innerJoin("threads", "threads.id", "runs.threadId")
      .innerJoin("principals", "principals.id", "runs.actorPrincipalId")
      .innerJoin("grants", "grants.runId", "runs.id")
      .select([
        "runs.id",
        "runs.threadId",
        "runs.environmentId",
        "runs.actorPrincipalId",
        "runs.authoritySource",
        "runs.requestedBy",
        "runs.membershipGeneration",
        "runs.initiatorGeneration",
        "runs.originConnectionId",
        "runs.status",
        "runs.bindingGeneration as currentBindingGeneration",
        "threads.workspaceId",
        "principals.kind as principalKind",
        "principals.workspaceId as principalWorkspaceId",
        "grants.id as grantId",
        "grants.bindingGeneration",
        "grants.runnerId",
        "grants.runnerBootId",
        "grants.status as grantStatus",
      ])
      .where("runs.id", "=", binding.runId)
      .where("grants.id", "=", binding.grantId)
      .forNoKeyUpdate("runs")
      .executeTakeFirst();
    if (!run || run.principalKind !== "project" || run.principalWorkspaceId !== run.workspaceId)
      throw new OpensteerError({
        code: "forbidden",
        message: "Project control binding is unavailable",
      });
    const origin = projectOriginFromRow(run);
    const durable = ProjectRunBindingSchema.parse({
      authority: {
        version: 1,
        principal: {
          kind: "project",
          workspaceId: run.workspaceId,
          principalId: run.actorPrincipalId,
        },
        origin,
      },
      bindingGeneration: run.bindingGeneration,
      environmentId: run.environmentId,
      grantId: run.grantId,
      runId: run.id,
      runnerBootId: run.runnerBootId,
      runnerId: run.runnerId,
      threadId: run.threadId,
      workspaceId: run.workspaceId,
    });
    if (!isDeepStrictEqual(durable, binding))
      throw new OpensteerError({
        code: "forbidden",
        message: "Project control binding does not match its stored origin",
      });
    await lockWorkspaceRow(transaction, run.workspaceId);
    const stopping = control.kind === "run.interrupt" || control.kind === "request.refuse";
    if (!stopping) {
      const live = await sql<{ valid: boolean }>`select public.opensteer_project_work_is_valid(
        ${run.threadId}, ${run.actorPrincipalId}, ${run.requestedBy}, ${run.membershipGeneration},
        ${run.initiatorGeneration}, ${run.originConnectionId}, ${jsonValue(run.authoritySource)}
      ) as valid`.execute(transaction);
      if (
        run.currentBindingGeneration !== binding.bindingGeneration ||
        run.grantStatus !== "active" ||
        !["starting", "running", "waiting"].includes(run.status) ||
        !live.rows[0]?.valid
      )
        throw new OpensteerError({
          code: "forbidden",
          message: "Project control authority has ended",
        });
    }
    const inserted = await transaction
      .insertInto("commands")
      .values({
        id: createId("command"),
        type: "run.control.project",
        status: "pending",
        dispatcherId: null,
        lastError: null,
        actorPrincipalId: run.actorPrincipalId,
        authoritySource: jsonValue(run.authoritySource),
        requestedBy: run.requestedBy,
        membershipGeneration: run.membershipGeneration,
        initiatorGeneration: run.initiatorGeneration,
        originConnectionId: run.originConnectionId,
        environmentId: run.environmentId,
        threadId: run.threadId,
        runId: run.id,
        originatingGrantId: binding.grantId,
        idempotencyKey: controlIdentity(binding, input.idempotencyKey),
        payload: jsonValue(
          StoredProjectControlSchema.parse({ binding, control, correlationId: randomUUID() }),
        ),
      })
      .onConflict((conflict) => conflict.doNothing())
      .returning("id")
      .executeTakeFirst();
    if (inserted) return { created: true };
    const winner = await this.find(transaction, { binding, idempotencyKey: input.idempotencyKey });
    if (!winner || !isDeepStrictEqual(winner, control)) controlConflict();
    return { created: false };
  }
}
