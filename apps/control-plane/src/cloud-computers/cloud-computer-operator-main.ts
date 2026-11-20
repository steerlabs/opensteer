import { readFileSync } from "node:fs";
import { CloudComputerIdSchema } from "@opensteer/control-plane-protocol";
import { z } from "zod";
import { loadControlPlaneConfig } from "../config.js";
import { createControlPlaneDatabase } from "../database/database.js";
import { HostedTeamSetupTokenCipher } from "../hosted-teams/setup-token-cipher.js";
import { ControlPlaneError } from "../server/errors.js";
import { CloudComputerStore } from "./store.js";
import { CloudComputerStripe } from "./stripe.js";

const usage =
  "Usage: cloud-computer-operator-main.js list | show <id> | suspend <id> <reason> | unsuspend <id> | delete <id> | reissue-bootstrap <id> | egress-list | egress-add <url> <username> <password-file> | egress-remove <id>";

async function main([action, subject, ...args]: readonly string[]): Promise<void> {
  const config = loadControlPlaneConfig();
  const cloud = config.cloudComputers;
  if (!cloud) throw new ControlPlaneError("unavailable", "Cloud Computers are disabled");
  const db = createControlPlaneDatabase({
    connectionString: config.databaseUrl,
    maxConnections: 1,
  });
  const store = new CloudComputerStore(db, {
    config: cloud,
    accountOrigin: config.publicOrigin,
    cipher: new HostedTeamSetupTokenCipher(config.adoptionOperationKey),
    stripe: new CloudComputerStripe({ key: cloud.stripeKey, returnUrl: config.portalOrigin }),
  });
  try {
    let result: unknown;
    if (action === "list" && !subject) result = await store.list();
    else if (action === "egress-list" && !subject) result = await store.listEgressEndpoints();
    else if (action === "egress-add" && subject && args.length === 2) {
      result = {
        id: await store.addEgressEndpoint({
          url: subject,
          username: args[0]!,
          password: readFileSync(args[1]!, "utf8").trimEnd(),
        }),
      };
    } else if (action === "egress-remove" && args.length === 0) {
      await store.removeEgressEndpoint(z.uuid().parse(subject));
      result = { removed: true };
    } else {
      if (!subject) throw new ControlPlaneError("bad_request", usage);
      const id = CloudComputerIdSchema.parse(subject);
      if (action === "show" && args.length === 0) result = await store.show(id);
      else if (action === "delete" && args.length === 0) result = await store.mutate(id, "delete");
      else if (action === "suspend" && args.length > 0)
        result = await store.mutate(
          id,
          "operator-suspend",
          undefined,
          args.join(" ").trim().slice(0, 1000),
        );
      else if (action === "unsuspend" && args.length === 0)
        result = await store.mutate(id, "operator-unsuspend");
      else if (action === "reissue-bootstrap" && args.length === 0)
        result = await store.mutate(id, "reissue");
      else throw new ControlPlaneError("bad_request", usage);
    }
    console.info(JSON.stringify(result));
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
