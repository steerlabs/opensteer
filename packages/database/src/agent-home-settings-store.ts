import { AgentHomeSettingsSchema, type AgentHomeSettings, type UserId } from "@opensteer/core";
import {
  RunnerSettingsReportSchema,
  type AgentHomeSettingsFileView,
  type RunnerSettingsReport,
  type TaskRuntimeFenceSchema,
} from "@opensteer/protocol";
import { sql, type Kysely } from "kysely";
import type { z } from "zod";
import type { DatabaseSchema } from "./schema.js";
import { withPersonalTransaction } from "./personal-transaction.js";
import { assertPersonalOwner } from "./private-resource-owner.js";

type Fence = z.infer<typeof TaskRuntimeFenceSchema>;
/** The last valid settings.json and what the hosting Runner last found in the file. */
export interface AgentHomeSettingsState {
  readonly settings: AgentHomeSettings;
  readonly file: AgentHomeSettingsFileView;
}

/** Keeps the last valid settings: an invalid read changes only the file's status. */
export async function reportAgentHomeSettings(
  database: Kysely<DatabaseSchema>,
  authenticated: Fence,
  input: RunnerSettingsReport,
): Promise<boolean> {
  const report = RunnerSettingsReportSchema.parse(input);
  if (Object.entries(authenticated).some(([key, value]) => report[key as keyof Fence] !== value))
    return false;
  return withPersonalTransaction(database, async (transaction) => {
    const owner = await transaction
      .selectFrom("personalSettings")
      .select("ownerId")
      .executeTakeFirst();
    if (!owner) return false;
    const personal = await assertPersonalOwner(transaction, owner.ownerId);
    if (authenticated.runnerId !== personal.hostingComputerId) return false;
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
    const { result } = report;
    const settings =
      result.status === "valid" ? result.settings : result.status === "missing" ? {} : null;
    const error = result.status === "invalid" ? JSON.stringify(result.error) : null;
    const written = await sql`insert into agent_home_settings
      (computer_id,environment_id,boot_id,connection_generation,connection_id,connection_lease_id,binding_generation,read_sequence,read_at,file_status,file_error,settings)
      values(${authenticated.runnerId},${report.environmentId},${report.bootId},${report.connectionGeneration},${report.connectionId},${report.connectionLeaseId},${report.bindingGeneration},${report.readSequence},${report.readAt},${result.status},${error}::jsonb,${JSON.stringify(settings ?? {})}::jsonb)
      on conflict(computer_id) do update set environment_id=excluded.environment_id,boot_id=excluded.boot_id,
        connection_generation=excluded.connection_generation,connection_id=excluded.connection_id,connection_lease_id=excluded.connection_lease_id,
        binding_generation=excluded.binding_generation,read_sequence=excluded.read_sequence,read_at=excluded.read_at,
        file_status=excluded.file_status,file_error=excluded.file_error,
        settings=case when excluded.file_status='invalid' then agent_home_settings.settings else excluded.settings end
      where agent_home_settings.connection_generation<excluded.connection_generation
        or(agent_home_settings.connection_generation=excluded.connection_generation and agent_home_settings.connection_id=excluded.connection_id
          and agent_home_settings.connection_lease_id=excluded.connection_lease_id and agent_home_settings.read_sequence<excluded.read_sequence)
      returning computer_id`.execute(transaction);
    return written.rows.length > 0;
  });
}

/** Before the hosting Runner first reads the file, background models follow the recommended order. */
export async function readAgentHomeSettings(
  database: Kysely<DatabaseSchema>,
  ownerId: UserId,
): Promise<AgentHomeSettingsState> {
  const row = await database
    .selectFrom("personalSettings")
    .innerJoin(
      "agentHomeSettings",
      "agentHomeSettings.computerId",
      "personalSettings.agentHomeComputerId",
    )
    .select([
      "agentHomeSettings.settings",
      "agentHomeSettings.fileStatus",
      "agentHomeSettings.fileError",
    ])
    .where("personalSettings.ownerId", "=", ownerId)
    .executeTakeFirst();
  if (!row) return { settings: {}, file: { status: "missing" } };
  return {
    settings: AgentHomeSettingsSchema.parse(row.settings),
    file: { status: row.fileStatus, ...(row.fileError ? { error: row.fileError } : {}) },
  };
}
