import { pathToFileURL } from "node:url";
import { DeploymentIdSchema } from "@opensteer/core";
import { parseHostConfig } from "@opensteer/config";
import { createDatabase, OpensteerStore } from "@opensteer/database";
import {
  Ed25519PortableFsProductAuthorizationSigner,
  PortableFsManagerClient,
  PortableFsWorkspaceLifecycleDriver,
} from "@opensteer/workspace-portablefs";
import {
  loadOrCreatePortableFsProductKey,
  loadPortableFsManagerTlsIdentity,
} from "./identity/portablefs-manager-identity.js";
import {
  assertManagedDestructionConfig,
  destroyManagedDeploymentData,
  prepareManagedDestructionDatabase,
} from "./managed-destruction.js";

export async function main(
  environment: NodeJS.ProcessEnv = process.env,
  arguments_: readonly string[] = process.argv.slice(2),
): Promise<void> {
  if (arguments_.length !== 1) {
    throw new Error("Usage: node dist/destroy-managed-main.js <expected-deployment-id>");
  }
  const expectedDeploymentId = DeploymentIdSchema.parse(arguments_[0]);
  let config: ReturnType<typeof parseHostConfig>;
  try {
    config = parseHostConfig(environment);
  } finally {
    delete environment.OPENSTEER_ACCOUNT_BUNDLE_FD;
    delete environment.OPENSTEER_ACCOUNT_BUNDLE_PATH;
    delete environment.OPENSTEER_AUTH_SECRET;
    delete environment.OPENSTEER_AUTH_SECRET_FILE;
  }
  assertManagedDestructionConfig(config, expectedDeploymentId);

  const storage = config.workspace.storage;
  const productKey = await loadOrCreatePortableFsProductKey({
    dataDirectory: config.dataDirectory,
    ...(storage.productPrivateKeyPath ? { privateKeyPath: storage.productPrivateKeyPath } : {}),
  });
  const managerTls =
    storage.managerUrl.protocol === "https:"
      ? await loadPortableFsManagerTlsIdentity({
          caPath: requiredPath(storage.managerCaPath, "PortableFS manager CA"),
          certificatePath: requiredPath(
            storage.managerCertPath,
            "PortableFS product mTLS certificate",
          ),
          privateKeyPath: requiredPath(
            storage.managerKeyPath,
            "PortableFS product mTLS private key",
          ),
          ...(storage.managerServerName ? { serverName: storage.managerServerName } : {}),
        })
      : undefined;
  const manager = new PortableFsManagerClient({
    authorizationDomain: storage.authorizationDomain,
    baseUrl: storage.managerUrl,
    productIssuer: storage.productIssuer,
    signer: new Ed25519PortableFsProductAuthorizationSigner(productKey.privateKey),
    ...(managerTls ? { tls: managerTls } : {}),
  });
  const database = createDatabase({
    applicationName: "opensteer-managed-destruction",
    connectionString: config.databaseUrl,
    maxConnections: 1,
  });
  try {
    if ((await prepareManagedDestructionDatabase(database)) === "pristine") {
      process.stdout.write("Managed database is pristine; no workspace volumes exist.\n");
      return;
    }
    const outcome = await destroyManagedDeploymentData({
      config,
      driver: new PortableFsWorkspaceLifecycleDriver({
        controlPlane: manager,
        serviceId: storage.serviceId,
      }),
      expectedDeploymentId,
      store: new OpensteerStore(database),
    });
    process.stdout.write(
      `Destroyed ${outcome.destroyedPortableFsWorkspaces} managed PortableFS workspace volume(s).\n`,
    );
    // An erase that reaches only the storage this Host owns has to say so.
    // Files on somebody's own computer are still on that computer.
    if (outcome.outstandingLocalWorkspaces.length > 0) {
      process.stdout.write(
        `${outcome.outstandingLocalWorkspaces.length} Workspace(s) live on computers this deployment does not control and were NOT erased:\n`,
      );
      for (const outstanding of outcome.outstandingLocalWorkspaces) {
        process.stdout.write(
          `  ${outstanding.workspaceId} on machine ${outstanding.ownerEnvironmentId}\n`,
        );
      }
      process.stdout.write(
        "Their owners must remove them from those computers; this deployment cannot.\n",
      );
    }
  } finally {
    await database.destroy();
  }
}

function requiredPath(value: string | undefined, description: string): string {
  if (!value) throw new Error(`${description} path is required for HTTPS`);
  return value;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
