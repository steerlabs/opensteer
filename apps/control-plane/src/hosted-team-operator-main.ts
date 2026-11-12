import { HostedTeamSlugSchema } from "@opensteer/control-plane-protocol/hosted-teams";
import { loadControlPlaneMigrationConfig } from "./config.js";
import { createControlPlaneDatabase } from "./database/database.js";
import { HostedTeamStore } from "./hosted-teams/hosted-team-store.js";

const usage = "Usage: hosted-team-operator.js suspend <slug> <reason> | unsuspend <slug> | delete <slug>";

/** Opensteer's abuse controls for a hosted team, run inside an Account pod. */
async function main([command, slug, ...reason]: readonly string[]): Promise<void> {
  const team = HostedTeamSlugSchema.parse(slug);
  const database = createControlPlaneDatabase({
    connectionString: loadControlPlaneMigrationConfig().databaseUrl,
    maxConnections: 1,
  });
  const store = new HostedTeamStore(database);
  try {
    if (command === "suspend" && reason.length > 0)
      await store.suspend(team, reason.join(" ").slice(0, 1_000));
    else if (command === "unsuspend" && reason.length === 0) await store.unsuspend(team);
    else if (command === "delete" && reason.length === 0) await store.deleteBySlug(team);
    else throw new Error(usage);
    console.info(`${command}: ${team}`);
  } finally {
    await database.destroy();
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
