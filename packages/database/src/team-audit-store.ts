import type { TeamActor, TeamAgentRequestId, TeamChannelId, TeamLinkId } from "@opensteer/core";
import { TeamAuditSchema } from "@opensteer/protocol";
import { sql, type Kysely, type Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";

export interface TeamAuditInput {
  readonly actor: TeamActor | null;
  readonly action: string;
  readonly resourceKind:
    "team" | "member" | "group" | "channel" | "topic" | "message" | "file" | "link" | "request";
  readonly resourceId?: string | undefined;
  readonly channelId?: TeamChannelId | undefined;
  readonly linkId?: TeamLinkId | undefined;
  readonly requestId?: TeamAgentRequestId | undefined;
  readonly outcome?: "allowed" | "denied";
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export async function appendTeamAudit(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  input: TeamAuditInput,
) {
  const row = await database
    .insertInto("teamAudit")
    .values({
      occurredAt: new Date(),
      actorUserId: input.actor?.userId ?? null,
      actorKind: input.actor?.kind ?? "system",
      linkId: input.linkId ?? null,
      agentRequestId: input.requestId ?? null,
      action: input.action,
      resourceKind: input.resourceKind,
      resourceId: input.resourceId ?? null,
      channelId: input.channelId ?? null,
      outcome: input.outcome ?? "allowed",
      metadata: sql`${JSON.stringify(input.metadata ?? {})}::jsonb`,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

export class TeamAuditStore {
  readonly database: Kysely<DatabaseSchema>;
  constructor(database: Kysely<DatabaseSchema>) {
    this.database = database;
  }
  async page(before?: string) {
    let query = this.database.selectFrom("teamAudit").selectAll();
    if (before) query = query.where("id", "<", before);
    const rows = await query.orderBy("id", "desc").limit(51).execute();
    return {
      audit: rows.slice(0, 50).map((row) =>
        TeamAuditSchema.strip().parse({
          ...row,
          occurredAt: row.occurredAt.toISOString(),
          actor: row.actorUserId === null ? null : { kind: row.actorKind, userId: row.actorUserId },
        }),
      ),
      hasMore: rows.length > 50,
    };
  }
}
