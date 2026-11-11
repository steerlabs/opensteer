import { sql } from "kysely";
import { storedProjectDeployment } from "./deployment-execution-authority.js";
import { OpensteerError, sameStringSet } from "@opensteer/core";
import type { RunnerDescriptor, RunnerModules, RunnerModuleName } from "@opensteer/protocol";

/** Storage control is carried by agents' environment/localStorage, not a sixth module. */
export const teamComputerModules = ["agents", "shell"] as const;
const capabilities = new Set([
  "project-authority-v1",
  "assignments-v1",
  "attempts-v1",
  "earlier-boots-contained-v1",
  "environment-list-v1",
  "trigger-program-v3",
  "execution-plane-v2",
  "filesystem",
  "network-egress",
  "native-session-continuation-v1",
  "agent-tools-plan-v1",
  "steer-answer-v1",
  "thread-state-v1",
  "task-done-v1",
]);
export function teamComputerCapabilities<T extends string>(names: readonly T[]) {
  return names.filter((name) => capabilities.has(name));
}
export function teamComputerGrantIsCurrent(modules: readonly RunnerModuleName[]) {
  return sameStringSet(modules, teamComputerModules);
}
export function teamComputerModulesOnly(modules: RunnerModules): RunnerModules {
  const agents = modules.agents ? { ...modules.agents } : undefined;
  if (agents) {
    delete agents.computerTool;
    delete agents.knowledgeSkill;
  }
  const shell = modules.shell ? { ...modules.shell } : undefined;
  if (shell) delete shell.fullDiskAccess;
  return {
    ...(agents ? { agents } : {}),
    ...(shell ? { shell } : {}),
  };
}
export function isDeploymentComputer(input: {
  ownerKind: "deployment" | "user";
  ownerUserId: unknown;
  kind: "main" | "local" | "managed";
  deviceProfile?: string | null;
  device?: RunnerDescriptor["device"] | null;
}) {
  return (
    input.ownerKind === "deployment" &&
    input.ownerUserId === null &&
    input.kind !== "local" &&
    !input.deviceProfile &&
    (!input.device ||
      (input.device.platform === "linux" && input.device.form !== "phone" && !input.device.app))
  );
}
export function assertTeamComputerDescriptor(descriptor: RunnerDescriptor) {
  if (
    (descriptor.device &&
      (descriptor.device.platform !== "linux" ||
        descriptor.device.form === "phone" ||
        descriptor.device.app)) ||
    Object.keys(descriptor.modules).some(
      (name) => !teamComputerModules.includes(name as (typeof teamComputerModules)[number]),
    ) ||
    !descriptor.modules.agents ||
    !descriptor.modules.agents.providerStateModes.includes("isolated") ||
    (descriptor.modules.shell && descriptor.modules.shell.platform !== "linux")
  )
    throw new OpensteerError({
      code: "forbidden",
      message: "Team computers offer only Linux agent, shell and storage control",
    });
}
export function teamComputerHasExecutionGrant(input: {
  device: RunnerDescriptor["device"] | null;
  allowedModules: readonly RunnerModuleName[];
  ownerKind: "deployment" | "user";
  ownerUserId: unknown;
}) {
  return (
    input.ownerKind === "deployment" &&
    input.ownerUserId === null &&
    input.device?.platform === "linux" &&
    input.device.form !== "phone" &&
    !input.device.app &&
    teamComputerGrantIsCurrent(input.allowedModules)
  );
}

export function teamComputerExecutionSql(alias: "r"): string {
  const modules = JSON.stringify(teamComputerModules);
  return `(${alias}.owner_kind = 'deployment' and ${alias}.owner_user_id is null
    and ${alias}.allowed_modules @> '${modules}'::jsonb
    and jsonb_array_length(${alias}.allowed_modules) = ${teamComputerModules.length}
    and ${alias}.device->>'platform' = 'linux'
    and coalesce(${alias}.device->>'form', '') <> 'phone'
    and ${alias}.device->>'app' is null)`;
}

export function teamComputerInventoryCondition(table: "runners" | "runnerEnrollments") {
  const kind = table === "runners" ? "kind" : "runnerKind";
  return sql<boolean>`(not ${storedProjectDeployment} or (
    ${sql.ref(`${table}.ownerKind`)} = 'deployment' and ${sql.ref(`${table}.ownerUserId`)} is null
    and ${sql.ref(`${table}.allowedModules`)} @> '["agents"]'::jsonb
    and ${sql.ref(`${table}.${kind}`)} <> 'local' and ${sql.ref(`${table}.deviceProfile`)} is null
    ${
      table === "runners"
        ? sql`and (${sql.ref(`${table}.device`)} is null or (
      ${sql.ref(`${table}.device`)}->>'platform' = 'linux'
      and coalesce(${sql.ref(`${table}.device`)}->>'form', '') <> 'phone'
      and ${sql.ref(`${table}.device`)}->>'app' is null))`
        : sql``
    }
  ))`;
}
