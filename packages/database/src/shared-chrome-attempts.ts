import {
  OpensteerError,
  type BrowserSourceId,
  type ThreadId,
  type ThreadAccessMode,
  type UserId,
} from "@opensteer/core";
import { sql, type Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";

export function sharedChromeAttempts(database: Kysely<DatabaseSchema>) {
  return {
    async open(witness: {
      id: string;
      connectionId: string;
      ownerId: UserId;
      sourceId: BrowserSourceId;
      shareId: string;
      grantRevision: number;
      mode: ThreadAccessMode;
      threadId: ThreadId | null;
    }): Promise<void> {
      const updated = await database
        .updateTable("agentConnections")
        .set({
          sharedChromeAttempts: sql`shared_chrome_attempts || jsonb_build_object(${witness.id}::text, ${JSON.stringify(witness)}::jsonb)`,
        })
        .where("id", "=", witness.connectionId)
        .where("userId", "=", witness.ownerId)
        .where("grantRevision", "=", witness.grantRevision)
        .where("revokedAt", "is", null)
        .where("expiresAt", ">", sql<Date>`now()`)
        .executeTakeFirst();
      if (updated.numUpdatedRows !== 1n)
        throw new OpensteerError({
          code: "forbidden",
          message: "This connected agent's access ended.",
        });
    },
    async finish(connectionId: string, id: string, detached: boolean): Promise<void> {
      await database
        .updateTable("agentConnections")
        .set({
          sharedChromeAttempts: detached
            ? sql`case when shared_chrome_attempts -> ${id}::text ? 'contactLostAt'
                then jsonb_set(shared_chrome_attempts, array[${id}, 'terminalEvidenceAt'], to_jsonb(now()))
                else shared_chrome_attempts - ${id}::text end`
            : sql`jsonb_set(shared_chrome_attempts, array[${id}, 'contactLostAt'], to_jsonb(now()))`,
        })
        .where("id", "=", connectionId)
        .where(
          sql<boolean>`shared_chrome_attempts ? ${id} and not (shared_chrome_attempts -> ${id}::text ? 'terminalEvidenceAt')`,
        )
        .$if(!detached, (query) =>
          query.where(sql<boolean>`not (shared_chrome_attempts -> ${id}::text ? 'contactLostAt')`),
        )
        .execute();
    },
    async recordDetach(input: {
      ownerId: UserId;
      sourceId: BrowserSourceId;
      shareId: string;
    }): Promise<void> {
      const matches = sql`witness->>'sourceId' = ${input.sourceId}
        and witness->>'shareId' = ${input.shareId} and not (witness ? 'terminalEvidenceAt')`;
      await sql`update agent_connections
        set shared_chrome_attempts = coalesce((
          select jsonb_object_agg(id, case when ${matches}
            then witness || jsonb_build_object('terminalEvidenceAt', now()) else witness end)
          from jsonb_each(shared_chrome_attempts) a(id, witness)
          where not ((${matches}) is true and not (witness ? 'contactLostAt'))
        ), '{}')
        where user_id = ${input.ownerId} and exists (
          select 1 from jsonb_each(shared_chrome_attempts) a(id, witness) where ${matches}
        )`.execute(database);
    },
    async recover(): Promise<void> {
      await sql`update agent_connections
        set shared_chrome_attempts = (
          select jsonb_object_agg(id, case when witness ?| array['terminalEvidenceAt', 'contactLostAt']
            then witness else witness || jsonb_build_object('contactLostAt', now()) end)
          from jsonb_each(shared_chrome_attempts) a(id, witness)
        ) where shared_chrome_attempts <> '{}'`.execute(database);
    },
  };
}
