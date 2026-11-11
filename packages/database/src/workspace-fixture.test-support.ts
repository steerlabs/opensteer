import { isProjectDeploymentAuthority } from "./deployment-execution-authority.js";
import { createId } from "@opensteer/core";
import type { OpensteerStore } from "./store.js";
import { sql } from "kysely";

/** Fixtures without a Runner still need a real computer reference for local storage. */
export async function createTestWorkspace(
  store: OpensteerStore,
  input: Parameters<OpensteerStore["createWorkspace"]>[0],
) {
  await sql`insert into execution_environments(id, name, kind, runner_id, capabilities)
      values (${input.backing.ownerEnvironmentId}, 'Fixture computer', 'main', null, '[]'::jsonb)
      on conflict (id) do nothing`.execute(store.database);
  if (isProjectDeploymentAuthority(await store.securityEffectAuthority())) {
    if (input.kind !== "project") throw new Error("Cold team fixtures may seed only Projects");
    const id = input.id ?? createId("workspace");
    await store.database.transaction().execute(async (transaction) => {
      await sql`insert into workspaces (id, kind, name, created_by, color, backing, status)
        values (${id}, 'project', ${input.name}, ${input.createdBy}, ${input.color ?? "blue"}, ${JSON.stringify(input.backing)}::jsonb, ${input.status ?? "provisioning"})`.execute(
        transaction,
      );
      await sql`insert into workspace_memberships (id, workspace_id, user_id, role, state)
        values (${createId("workspaceMembership")}, ${id}, ${input.createdBy}, 'owner', 'active')`.execute(
        transaction,
      );
    });
    const workspace = await store.getWorkspace(id);
    if (!workspace) throw new Error("Cold team fixture lost its Workspace");
    return workspace;
  }
  return store.createWorkspace(input);
}
