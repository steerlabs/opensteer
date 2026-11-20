import { sql, type Kysely } from "kysely";
import type { ControlPlaneDatabaseSchema } from "../database/schema.js";

export async function resetManagedCloudTables(database: Kysely<ControlPlaneDatabaseSchema>) {
  await sql`
    truncate table
      work_audit_batches, work_audit_records, work_assignments,
      organization_invitations, organization_members, organization_checkouts,
      organization_seat_changes, organizations,
      cloud_computer_egress_endpoints, cloud_computer_backup_namespaces,
      cloud_computer_backup_targets, cloud_computer_provisioner_lease,
      cloud_computers, cloud_computer_stripe_events, cloud_computer_checkouts
  `.execute(database);
}
