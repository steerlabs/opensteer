import type { TeamActor } from "@opensteer/core";
import {
  TeamAccessStore,
  appendTeamAudit,
  type TeamStoreAccessEffects,
  type DatabaseSchema,
} from "@opensteer/database";
import type { Kysely, Transaction } from "kysely";
import type { TeamKnowledgeAudit } from "./team-knowledge.js";

export interface TeamAccessPauses {
  beforeWriteLock?: () => Promise<void>;
  insideWriteLock?: () => Promise<void>;
  beforeHandoff?: () => Promise<void>;
}

export function testTeamAccess(database: Kysely<DatabaseSchema>) {
  const pauses: TeamAccessPauses = {};
  const changes: { readonly actor: TeamActor; readonly action: string }[] = [];
  const access: TeamAccessStore = new (class extends TeamAccessStore {
    override async mutateAs<Value>(
      actor: TeamActor,
      action: string,
      write: (
        transaction: Transaction<DatabaseSchema>,
      ) => Promise<{ readonly value: Value; readonly effects: TeamStoreAccessEffects }>,
      afterAuthority?: (transaction: Transaction<DatabaseSchema>, value: Value) => Promise<void>,
    ): Promise<Value> {
      changes.push({ actor, action });
      return super.mutateAs(actor, action, write, afterAuthority);
    }
    override async knowledgeWrite<Value>(
      write: (transaction: Transaction<DatabaseSchema>) => Promise<Value>,
    ): Promise<Value> {
      await pauses.beforeWriteLock?.();
      return super.knowledgeWrite(async (transaction) => {
        await pauses.insideWriteLock?.();
        return write(transaction);
      });
    }
    override async handoff<Value>(
      authorizedAt: Parameters<TeamAccessStore["handoff"]>[0],
      authorize: () => Promise<boolean>,
      deliver: () => Value,
    ): Promise<Value> {
      await pauses.beforeHandoff?.();
      return super.handoff(authorizedAt, authorize, deliver);
    }
  })(database);
  return { access, pauses, changes };
}

export const testTeamAudit: TeamKnowledgeAudit = appendTeamAudit;
