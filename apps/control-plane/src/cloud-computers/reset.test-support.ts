import { sql, type Kysely } from "kysely";
import type { ControlPlaneDatabaseSchema } from "../database/schema.js";
import { resetAccountSigningKeys } from "../auth/signing-keys.test-support.js";

export async function resetManagedCloudTables(database: Kysely<ControlPlaneDatabaseSchema>) {
  await resetAccountSigningKeys(database);
  await sql`
    truncate table
      cloud_computer_egress_endpoints, cloud_computer_backup_namespaces,
      cloud_computer_backup_targets, cloud_computer_provisioner_lease,
      browser_pool_slots, browser_pool_hosts,
      cloud_computers, cloud_computer_stripe_events, cloud_computer_checkouts
  `.execute(database);
  await database.deleteFrom("deployments").where("oidcClientId", "like", "occ\\_%").execute();
  await database.deleteFrom("oauthClients").where("clientId", "like", "occ\\_%").execute();
}
