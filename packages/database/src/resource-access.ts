import {
  RunIdSchema,
  ThreadIdSchema,
  TriggerOccurrenceIdSchema,
  TriggerWatchActivationIdSchema,
  intersectResourceAccess,
  lineageCompatibleForReuse,
  OpensteerError,
  type ResourceAccessLevel,
  type ThreadId,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";

export interface ResourceAccessInput {
  readonly ownerUserId: UserId;
  readonly workspaceId: WorkspaceId;
  readonly threadId?: ThreadId;
  readonly agentBindingId?: string;
  /** Explicit consent must already be filtered to its owner and active membership. */
  readonly explicitAccess?: ResourceAccessLevel | null;
  readonly connectionCeiling?: ResourceAccessLevel | null;
  /** A later specialist registration can only narrow Workspace authority. */
  readonly specialistAccess?: ResourceAccessLevel | null;
}

export async function resolveResourceAccess(
  database: Kysely<DatabaseSchema>,
  input: ResourceAccessInput,
) {
  let threadId = input.threadId;
  if (!threadId && input.agentBindingId?.startsWith("run:")) {
    const run = await database
      .selectFrom("runs")
      .select("threadId")
      .where("id", "=", RunIdSchema.parse(input.agentBindingId.slice(4)))
      .executeTakeFirst();
    threadId = run?.threadId;
  }
  if (!threadId && input.agentBindingId?.startsWith("thread:"))
    threadId = ThreadIdSchema.parse(input.agentBindingId.slice(7));
  if (!threadId && input.agentBindingId?.startsWith("trigger:")) {
    threadId = (
      await database
        .selectFrom("triggerOccurrences")
        .innerJoin("triggers", "triggers.id", "triggerOccurrences.triggerId")
        .select("triggers.anchorThreadId")
        .where(
          "triggerOccurrences.id",
          "=",
          TriggerOccurrenceIdSchema.parse(input.agentBindingId.slice(8)),
        )
        .executeTakeFirst()
    )?.anchorThreadId;
  }
  if (!threadId && input.agentBindingId?.startsWith("watch:")) {
    threadId = (
      await database
        .selectFrom("triggerWatchActivations")
        .innerJoin("triggers", "triggers.id", "triggerWatchActivations.triggerId")
        .select("triggers.anchorThreadId")
        .where(
          "triggerWatchActivations.id",
          "=",
          TriggerWatchActivationIdSchema.parse(input.agentBindingId.slice(6)),
        )
        .executeTakeFirst()
    )?.anchorThreadId;
  }
  const workspace = await database
    .selectFrom("workspaces")
    .select(["kind", "createdBy"])
    .where("id", "=", input.workspaceId)
    .executeTakeFirst();
  const main = workspace?.kind === "main" && workspace.createdBy === input.ownerUserId;
  const root = threadId
    ? await database
        .selectFrom("threads as asking")
        .innerJoin("threads as root", "root.id", "asking.lineageRootThreadId")
        .select(["root.capabilityProfileId", "asking.workspaceId"])
        .where("asking.id", "=", threadId)
        .executeTakeFirst()
    : undefined;
  // No agent identity means an owner client, rather than an agent Run.
  const inheritsMain =
    main &&
    (root
      ? root.workspaceId === input.workspaceId && root.capabilityProfileId === "main"
      : !input.threadId && !input.agentBindingId);
  const access = intersectResourceAccess(
    intersectResourceAccess(
      inheritsMain ? "read-write" : (input.explicitAccess ?? null),
      input.connectionCeiling,
    ),
    input.specialistAccess,
  );
  return {
    access,
    inheritsMain,
    mainAccess: main ? (inheritsMain ? ("inherited" as const) : ("withheld" as const)) : null,
  };
}

export async function assertLineageCompatibleReuse(
  database: Kysely<DatabaseSchema>,
  callerId: ThreadId,
  targetId: ThreadId,
): Promise<void> {
  const roots = await database
    .selectFrom("threads as asking")
    .innerJoin("threads as root", "root.id", "asking.lineageRootThreadId")
    .select(["asking.id", "root.capabilityProfileId"])
    .where("asking.id", "in", [callerId, targetId])
    .execute();
  const inherits = (id: ThreadId) =>
    roots.find((row) => row.id === id)?.capabilityProfileId === "main";
  if (!lineageCompatibleForReuse(inherits(callerId), inherits(targetId))) {
    throw new OpensteerError({
      code: "forbidden",
      message:
        "This Thread inherits Main access that your lineage does not have. Start a new task instead.",
    });
  }
}
