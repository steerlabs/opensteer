import { organizationsPortalPath } from "../organizations/portal-pages.js";
import { loadControlPlaneConfig } from "../config.js";
import { createControlPlaneDatabase } from "../database/database.js";
import { HostedTeamSetupTokenCipher } from "../hosted-teams/setup-token-cipher.js";
import { OrganizationStore } from "../organizations/store.js";
import { ControlPlaneError } from "../server/errors.js";
import { cloudComputerOperatorUsage, runCloudComputerOperator } from "./operator.js";
import { CloudComputerStore } from "./store.js";
import { CloudComputerStripe } from "./stripe.js";

async function main(args: readonly string[]): Promise<void> {
  if (!args.length || (args.length === 1 && ["--help", "help"].includes(args[0]!))) {
    console.info(cloudComputerOperatorUsage);
    return;
  }
  const config = loadControlPlaneConfig();
  const cloud = config.cloudComputers;
  if (!cloud) throw new ControlPlaneError("unavailable", "Cloud Computers are disabled");
  const db = createControlPlaneDatabase({
    connectionString: config.databaseUrl,
    // Billing reconciliation keeps its advisory lock on one session while using the other.
    maxConnections: 2,
  });
  const stripe = new CloudComputerStripe({ key: cloud.stripeKey, returnUrl: config.publicOrigin });
  const organizations = new OrganizationStore(db, {
    stripe,
    offer: config.organizationOffer,
    returnUrl: new URL(organizationsPortalPath, config.portalOrigin),
  });
  const store = new CloudComputerStore(db, {
    config: cloud,
    accountOrigin: config.publicOrigin,
    cipher: new HostedTeamSetupTokenCipher(config.adoptionOperationKey),
    stripe,
    organizations,
  });
  try {
    console.info(JSON.stringify(await runCloudComputerOperator(store, args)));
  } finally {
    await db.destroy();
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(
    error instanceof ControlPlaneError ? error.message : "Cloud Computer operator command failed",
  );
  process.exitCode = 1;
});
