import { DeploymentIdSchema, UserIdSchema } from "@opensteer/core";
import { TeamCommandSchema } from "@opensteer/protocol";
import { z } from "zod";

export interface TeamCacheScope {
  readonly teamDeploymentId: string;
  readonly userId: string;
}
export function teamCacheKey(scope: TeamCacheScope): string {
  return JSON.stringify([
    DeploymentIdSchema.parse(scope.teamDeploymentId),
    UserIdSchema.parse(scope.userId),
  ]);
}
export const TeamSendCommandSchema = TeamCommandSchema.transform((command, context) => {
  if (command.type === "team.message.send") return command;
  context.addIssue({ code: "custom", message: "Expected a pending team message send." });
  return z.NEVER;
});
export const PendingTeamSendSchema = z.strictObject({
  command: TeamSendCommandSchema,
  createdAt: z.iso.datetime({ offset: true }),
});
export type PendingTeamSend = z.infer<typeof PendingTeamSendSchema>;
export const TeamSavedStateSchema = z.strictObject({
  drafts: z
    .record(z.string(), z.string().max(16384))
    .refine((rows) => Object.keys(rows).length <= 100),
  pending: z.array(PendingTeamSendSchema).max(100),
});
export type TeamSavedState = z.infer<typeof TeamSavedStateSchema>;
// Native ports keep this beside their protected per-Host credential; no credentials enter the cache.
export interface TeamPersistence {
  load(scope: TeamCacheScope): Promise<TeamSavedState | null>;
  save(scope: TeamCacheScope, state: TeamSavedState): Promise<void>;
  remove(scope: TeamCacheScope): Promise<void>;
}
export function createMemoryTeamPersistence(): TeamPersistence {
  const entries = new Map<string, TeamSavedState>();
  return {
    async load(scope) {
      const value = entries.get(teamCacheKey(scope));
      return value ? structuredClone(value) : null;
    },
    async save(scope, state) {
      entries.set(teamCacheKey(scope), TeamSavedStateSchema.parse(structuredClone(state)));
    },
    async remove(scope) {
      entries.delete(teamCacheKey(scope));
    },
  };
}
