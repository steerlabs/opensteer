import { workPolicyAllowsGrant } from "@opensteer/control-plane-protocol";
import {
  minThreadAccessMode,
  OpensteerError,
  type AgentGrant,
  type ThreadAccessMode,
} from "@opensteer/core";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";
import { isWorkHomeDatabase } from "./work-home-context.js";

export async function workPolicyFor(database: Kysely<DatabaseSchema>) {
  if (!isWorkHomeDatabase(database)) return null;
  return database
    .selectFrom("workHomePolicy")
    .select(["policy", "state"])
    .executeTakeFirstOrThrow();
}

export async function connectionPolicyMode(
  database: Kysely<DatabaseSchema>,
  grant: AgentGrant,
  accessMode: ThreadAccessMode,
): Promise<ThreadAccessMode> {
  const work = await workPolicyFor(database);
  return applyConnectionPolicy(work, grant, accessMode);
}

export function applyConnectionPolicy(
  work: Awaited<ReturnType<typeof workPolicyFor>>,
  grant: AgentGrant,
  accessMode: ThreadAccessMode,
): ThreadAccessMode {
  if (!work) return accessMode;
  if (work.state !== "active" || !workPolicyAllowsGrant(work.policy, grant))
    throw organizationRefusal();
  return minThreadAccessMode(accessMode, work.policy.externalMaxMode);
}

export async function assertWorkDeviceEnrollment(database: Kysely<DatabaseSchema>) {
  const work = await workPolicyFor(database);
  if (work && (work.state !== "active" || work.policy.devices !== "assignee-may-enroll"))
    throw organizationRefusal();
}

export function organizationRefusal(): OpensteerError {
  return new OpensteerError({
    code: "forbidden",
    message: "Your organization doesn't allow this",
    reason: "work-policy",
  });
}
