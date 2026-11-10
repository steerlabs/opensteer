import { canonicalJson } from "@opensteer/shared/canonicalJson";
import { OpensteerError, type WorkspaceId } from "@opensteer/core";
import type { Transaction } from "kysely";
import { createChannelId, type PrincipalId } from "@opensteer/channel-core";
import type { DatabaseSchema } from "./schema.js";

/** The caller reserves the Project and its memberships before looking up its principal. */
export async function ensureProjectPrincipal(
  transaction: Transaction<DatabaseSchema>,
  workspaceId: WorkspaceId,
): Promise<PrincipalId> {
  const workspace = await transaction
    .selectFrom("workspaces")
    .select(["name", "kind", "status", "deletedAt"])
    .where("id", "=", workspaceId)
    .executeTakeFirst();
  if (
    !workspace ||
    workspace.kind !== "project" ||
    workspace.deletedAt !== null ||
    workspace.status === "deleting" ||
    workspace.status === "deleted"
  )
    throw new OpensteerError({ code: "workspace_unavailable", message: "Project is unavailable" });
  const existing = await transaction
    .selectFrom("principals")
    .select("id")
    .where("workspaceId", "=", workspaceId)
    .where("kind", "=", "project")
    .executeTakeFirst();
  if (existing) return existing.id;
  const inserted = await transaction
    .insertInto("principals")
    .values({
      id: createChannelId("principal"),
      kind: "project",
      workspaceId,
      userId: null,
      displayName: workspace.name,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflict((conflict) =>
      conflict.column("workspaceId").where("workspaceId", "is not", null).doNothing(),
    )
    .returning("id")
    .executeTakeFirst();
  if (inserted) return inserted.id;
  const winner = await transaction
    .selectFrom("principals")
    .select("id")
    .where("workspaceId", "=", workspaceId)
    .where("kind", "=", "project")
    .executeTakeFirstOrThrow();
  return winner.id;
}

export type ProjectExchange = {
  readonly project: import("@opensteer/core").ProjectAuthority["principal"];
  readonly threadId: import("@opensteer/core").ThreadId;
  readonly assignmentId: import("@opensteer/core").AssignmentId | null;
  readonly replyTarget: import("@opensteer/core").ReplyTarget | null;
} & (
  | { readonly origin: import("@opensteer/core").HumanRoot }
  | {
      readonly origin: null;
      readonly source: {
        readonly kind: "trigger" | "watch" | "platform";
        readonly id: string;
        readonly incarnation: string;
      };
    }
);

export function projectExchangeKey(exchange: ProjectExchange): string {
  return canonicalJson([
    "project-exchange-v1",
    exchange.project.workspaceId,
    exchange.project.principalId,
    exchange.threadId,
    exchange.origin
      ? [
          "human",
          exchange.origin.userId,
          exchange.origin.initiatorGeneration,
          exchange.origin.membershipGeneration,
          exchange.origin.originConnectionId,
        ]
      : ["unattended", exchange.source.kind, exchange.source.id, exchange.source.incarnation],
    exchange.assignmentId,
    exchange.replyTarget,
  ]);
}
