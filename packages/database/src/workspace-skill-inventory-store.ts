import { effectiveMembershipPredicate } from "./effective-membership.js";
import type { UserId, WorkspaceId } from "@opensteer/core";
import {
  RunnerSkillMetadataReportSchema,
  type RunnerSkillMetadataReport,
  type WorkspaceStorageFence,
} from "@opensteer/protocol";
import { sql, type Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { withDatabaseTransaction } from "./connection.js";

export interface WorkspaceSkillInventory {
  workspaceId: WorkspaceId;
  ownerRunnerId: string | null;
  observedAt: string;
  scanStatus: "complete" | "failed";
  stale: boolean;
  skills: Extract<RunnerSkillMetadataReport["result"], { status: "complete" }>["skills"];
}

/** The caller supplies the live registry fence, never identity taken from the report. */
export async function reportWorkspaceSkills(
  database: Kysely<DatabaseSchema>,
  authenticated: WorkspaceStorageFence,
  input: RunnerSkillMetadataReport,
): Promise<boolean> {
  const report = RunnerSkillMetadataReportSchema.parse(input);
  if (
    Object.entries(authenticated).some(
      ([key, value]) => report[key as keyof WorkspaceStorageFence] !== value,
    )
  )
    return false;
  const binding = report.binding;
  if (
    binding.ownerEnvironmentId !== report.environmentId ||
    binding.storageAuthorityId !== report.storageAuthorityId
  )
    return false;
  return withDatabaseTransaction(database, async (transaction) => {
    // Lock the authoritative rows before replacing the cache, serializing deletion,
    // relocation and reconnect against a report that was already in flight.
    const owner = await sql`select w.id from workspaces w
      join execution_environments e on e.id = w.owner_environment_id
      join runners r on r.id = e.runner_id
      where w.id = ${binding.workspaceId} and w.deleted_at is null
        and w.deletion_requested_at is null and w.status not in ('deleting','deleted')
        and e.id = ${report.environmentId} and r.id = ${authenticated.runnerId}
        and r.revoked_at is null and r.connection_generation = ${authenticated.connectionGeneration}
        and w.backing->>'bindingId' = ${binding.bindingId}
        and w.backing->>'generation' = ${String(binding.generation)}
        and w.backing->>'storageAuthorityId' = ${binding.storageAuthorityId}
      for no key update of w, r, e`.execute(transaction);
    if (owner.rows.length === 0) return false;
    const skills =
      report.result.status === "complete"
        ? report.result.skills.filter((skill) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(skill.fullName))
        : [];
    const result = await sql`insert into workspace_skill_inventory
      (workspace_id, binding_id, binding_generation, storage_authority_id, owner_runner_id, metadata_owner_runner_id, boot_id, connection_generation, connection_id, connection_lease_id, scan_sequence, scanned_at, scan_status, metadata)
      values (${binding.workspaceId}, ${binding.bindingId}, ${binding.generation}, ${binding.storageAuthorityId}, ${authenticated.runnerId}, ${report.result.status === "complete" ? authenticated.runnerId : null}, ${authenticated.bootId}, ${authenticated.connectionGeneration}, ${authenticated.connectionId}, ${authenticated.connectionLeaseId}, ${report.scanSequence}, ${report.scannedAt}, ${report.result.status}, ${JSON.stringify(skills)}::jsonb)
      on conflict (workspace_id) do update set
        binding_id = excluded.binding_id, binding_generation = excluded.binding_generation,
        storage_authority_id = excluded.storage_authority_id, owner_runner_id = excluded.owner_runner_id,
        boot_id = excluded.boot_id, connection_generation = excluded.connection_generation,
        connection_id = excluded.connection_id, connection_lease_id = excluded.connection_lease_id,
        scan_sequence = excluded.scan_sequence, scanned_at = case when excluded.scan_status = 'complete' then excluded.scanned_at else workspace_skill_inventory.scanned_at end,
        scan_status = excluded.scan_status,
        metadata_owner_runner_id = case when excluded.scan_status = 'complete' then excluded.metadata_owner_runner_id else workspace_skill_inventory.metadata_owner_runner_id end,
        metadata = case when excluded.scan_status = 'complete' then excluded.metadata else workspace_skill_inventory.metadata end
      where workspace_skill_inventory.connection_generation < excluded.connection_generation
        or (workspace_skill_inventory.connection_generation = excluded.connection_generation
          and workspace_skill_inventory.connection_id = excluded.connection_id
          and workspace_skill_inventory.scan_sequence < excluded.scan_sequence)
        or workspace_skill_inventory.owner_runner_id <> excluded.owner_runner_id
      returning workspace_id`.execute(transaction);
    return result.rows.length > 0;
  });
}

/** Set-based viewer membership check; callers may pass their already-authorized overview IDs. */
export async function listWorkspaceSkillInventory(
  database: Kysely<DatabaseSchema>,
  viewerId: UserId,
  workspaceIds: readonly WorkspaceId[],
): Promise<WorkspaceSkillInventory[]> {
  if (workspaceIds.length === 0) return [];
  const result =
    await sql<WorkspaceSkillInventory>`select i.workspace_id, i.metadata_owner_runner_id as owner_runner_id, i.scanned_at::text as observed_at, i.scan_status, i.metadata as skills,
    (i.scan_status <> 'complete' or w.backing->>'bindingId' <> i.binding_id
      or w.backing->>'generation' <> i.binding_generation::text
      or w.backing->>'storageAuthorityId' is distinct from i.storage_authority_id
      or e.runner_id is distinct from i.owner_runner_id
      or r.connection_generation <> i.connection_generation or r.revoked_at is not null or r.last_seen_at is null) as stale
    from workspace_skill_inventory i
    join workspaces w on w.id = i.workspace_id
    join workspace_memberships m on m.workspace_id = w.id and m.user_id = ${viewerId} and ${effectiveMembershipPredicate("m")}
    left join execution_environments e on e.id = w.owner_environment_id
    left join runners r on r.id = e.runner_id
    where w.id in (${sql.join(workspaceIds)}) and w.deleted_at is null and w.deletion_requested_at is null`.execute(
      database,
    );
  return result.rows.map((row) => ({ ...row, observedAt: new Date(row.observedAt).toISOString() }));
}
