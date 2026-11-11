import type { TaskFolder, UserId } from "@opensteer/core";
import {
  RunnerSkillMetadataReportSchema,
  type RunnerSkillMetadataReport,
  type TaskRuntimeFenceSchema,
} from "@opensteer/protocol";
import { sql, type Kysely } from "kysely";
import type { z } from "zod";
import type { DatabaseSchema } from "./schema.js";
import { withPersonalTransaction } from "./personal-transaction.js";
import { assertPersonalOwner } from "./private-resource-owner.js";

type Fence = z.infer<typeof TaskRuntimeFenceSchema>;
export interface PersonalSkillInventory {
  readonly folder: TaskFolder;
  readonly ownerRunnerId: string | null;
  readonly observedAt: string;
  readonly scanStatus: "complete" | "failed";
  readonly stale: boolean;
  readonly skills: Extract<RunnerSkillMetadataReport["result"], { status: "complete" }>["skills"];
}

export async function reportFolderSkills(
  database: Kysely<DatabaseSchema>,
  authenticated: Fence,
  input: RunnerSkillMetadataReport,
): Promise<boolean> {
  const report = RunnerSkillMetadataReportSchema.parse(input);
  if (
    Object.entries(authenticated).some(([key, value]) => report[key as keyof Fence] !== value) ||
    report.binding.computerId !== authenticated.runnerId
  )
    return false;
  return withPersonalTransaction(database, async (transaction) => {
    const owner = await transaction
      .selectFrom("personalSettings")
      .select("ownerId")
      .executeTakeFirst();
    if (!owner) return false;
    const personal = await assertPersonalOwner(transaction, owner.ownerId);
    if (report.binding.computerId !== personal.hostingComputerId) return false;
    const live = await transaction
      .selectFrom("runners")
      .innerJoin("executionEnvironments", "executionEnvironments.runnerId", "runners.id")
      .select("runners.id")
      .where("runners.id", "=", authenticated.runnerId)
      .where("runners.revokedAt", "is", null)
      .where("runners.connectionGeneration", "=", String(authenticated.connectionGeneration))
      .where("executionEnvironments.id", "=", authenticated.environmentId)
      .forShare(["runners", "executionEnvironments"])
      .executeTakeFirst();
    if (!live) return false;
    const skills =
      report.result.status === "complete"
        ? report.result.skills.filter((skill) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(skill.fullName))
        : [];
    const result = await sql`insert into folder_skill_inventory
      (folder_computer_id,folder_path,environment_id,boot_id,connection_generation,connection_id,connection_lease_id,binding_generation,scan_sequence,scanned_at,scan_status,metadata)
      values(${report.binding.computerId},${report.binding.path},${report.environmentId},${report.bootId},${report.connectionGeneration},${report.connectionId},${report.connectionLeaseId},${report.bindingGeneration},${report.scanSequence},${report.scannedAt},${report.result.status},${JSON.stringify(skills)}::jsonb)
      on conflict(folder_computer_id,folder_path) do update set environment_id=excluded.environment_id,boot_id=excluded.boot_id,
        connection_generation=excluded.connection_generation,connection_id=excluded.connection_id,connection_lease_id=excluded.connection_lease_id,
        binding_generation=excluded.binding_generation,scan_sequence=excluded.scan_sequence,scan_status=excluded.scan_status,
        scanned_at=case when excluded.scan_status='complete' then excluded.scanned_at else folder_skill_inventory.scanned_at end,
        metadata=case when excluded.scan_status='complete' then excluded.metadata else folder_skill_inventory.metadata end
      where folder_skill_inventory.connection_generation<excluded.connection_generation
        or(folder_skill_inventory.connection_generation=excluded.connection_generation and folder_skill_inventory.connection_id=excluded.connection_id
          and folder_skill_inventory.connection_lease_id=excluded.connection_lease_id and folder_skill_inventory.scan_sequence<excluded.scan_sequence)
      returning folder_computer_id`.execute(transaction);
    return result.rows.length > 0;
  });
}

export async function listPersonalSkillInventory(
  database: Kysely<DatabaseSchema>,
  ownerId: UserId,
): Promise<PersonalSkillInventory[]> {
  const owner = await assertPersonalOwner(database, ownerId);
  const result = await sql<{
    folderComputerId: TaskFolder["computerId"];
    folderPath: string;
    observedAt: Date;
    scanStatus: "complete" | "failed";
    stale: boolean;
    skills: PersonalSkillInventory["skills"];
  }>`
    select i.folder_computer_id,i.folder_path,i.scanned_at as observed_at,i.scan_status,i.metadata as skills,
      (i.scan_status<>'complete' or r.revoked_at is not null or r.last_seen_at is null or r.connection_generation<>i.connection_generation) as stale
    from folder_skill_inventory i join runners r on r.id=i.folder_computer_id
    where i.folder_computer_id=${owner.hostingComputerId} order by i.scanned_at desc,i.folder_path limit 128`.execute(
    database,
  );
  return result.rows.map((row) => ({
    folder: { computerId: row.folderComputerId, path: row.folderPath },
    ownerRunnerId: row.folderComputerId,
    observedAt: new Date(row.observedAt).toISOString(),
    scanStatus: row.scanStatus,
    stale: row.stale,
    skills: row.skills,
  }));
}
