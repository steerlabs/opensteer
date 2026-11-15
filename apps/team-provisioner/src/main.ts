import pg from "pg";
import { Storage } from "@google-cloud/storage";
import { GoogleAuth } from "google-auth-library";
import { PostgresTeamDatabase } from "./database.js";
import { GcsTeamStorage } from "./storage.js";
import { createServer } from "node:http";
import { AccountClient, workloadIdentityToken } from "./account.js";
import { loadProvisionerConfig } from "./config.js";
import { KubernetesClient } from "./kubernetes.js";
import { Reconciler } from "./reconcile.js";

const passIntervalMilliseconds = 10_000;
/** Ready only while whole passes succeed: Account admits this identity and the cluster lists teams. */
const readyWithinMilliseconds = 3 * passIntervalMilliseconds;
const readinessPort = 8081;

function log(event: string, fields: Readonly<Record<string, unknown>> = {}): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
}

async function main(): Promise<void> {
  const config = loadProvisionerConfig(process.env);
  // One Google identity for Storage's managed folders and the IAM database login.
  const google = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const pool = new pg.Pool({
    host: config.platform.databaseHost,
    port: 5432,
    database: "postgres",
    user: config.databaseUser,
    // IAM database authentication: a fresh short-lived access token is the password.
    password: async () => {
      const token = await google.getAccessToken();
      if (!token) throw new Error("No Google access token for the database");
      return token;
    },
    ssl: { ca: config.platform.databaseCa, servername: config.platform.databaseHost },
    max: 2,
    connectionTimeoutMillis: 15_000,
    query_timeout: 30_000,
  });
  // The pool drops an idle client the server ends; without a listener that would crash.
  pool.on("error", () => {});
  const reconciler = new Reconciler({
    account: new AccountClient({
      origin: config.accountOrigin,
      token: workloadIdentityToken(config.accountOrigin.origin),
    }),
    kubernetes: new KubernetesClient(config.kubernetes),
    images: config.images,
    replicas: config.replicas,
    platform: config.platform,
    database: new PostgresTeamDatabase(pool),
    storage: new GcsTeamStorage(
      new Storage({ authClient: google }),
      google,
      config.platform.bucket,
      config.project,
      config.projectNumber,
    ),
    log,
  });
  log("provisioner.started", {
    hostImage: config.images.host,
  });
  let lastPassAt = 0;
  const readiness = createServer((request, response) => {
    const ready = request.url === "/readyz" && Date.now() - lastPassAt < readyWithinMilliseconds;
    response.writeHead(ready ? 200 : 503).end();
  }).listen(readinessPort);
  let stopping = false;
  let wake: (() => void) | undefined;
  const stop = () => {
    stopping = true;
    wake?.();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  while (!stopping) {
    try {
      await reconciler.pass();
      lastPassAt = Date.now();
    } catch {
      log("pass.failed", { error: "Provisioner operation failed" });
    }
    await new Promise<void>((resolve) => {
      wake = resolve;
      setTimeout(resolve, passIntervalMilliseconds);
    });
  }
  readiness.close();
  await pool.end();
  log("provisioner.stopped");
}

main().catch(() => {
  log("provisioner.crashed", { error: "Provisioner operation failed" });
  process.exitCode = 1;
});
