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
  return store.createWorkspace(input);
}
