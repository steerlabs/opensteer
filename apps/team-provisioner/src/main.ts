import { AccountClient, workloadIdentityToken } from "./account.js";
import { loadProvisionerConfig } from "./config.js";
import { KubernetesClient } from "./kubernetes.js";
import { Reconciler } from "./reconcile.js";

const passIntervalMilliseconds = 10_000;

function log(event: string, fields: Readonly<Record<string, unknown>> = {}): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
}

async function main(): Promise<void> {
  const config = loadProvisionerConfig(process.env);
  const reconciler = new Reconciler({
    account: new AccountClient({
      origin: config.accountOrigin,
      token: workloadIdentityToken(config.accountOrigin.origin),
    }),
    kubernetes: new KubernetesClient(config.kubernetes),
    images: config.images,
    log,
  });
  log("provisioner.started", {
    hostImage: config.images.host,
    gatewayImage: config.images.gateway,
  });
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
    } catch (error) {
      log("pass.failed", { error: error instanceof Error ? error.message : String(error) });
    }
    await new Promise<void>((resolve) => {
      wake = resolve;
      setTimeout(resolve, passIntervalMilliseconds);
    });
  }
  log("provisioner.stopped");
}

main().catch((error: unknown) => {
  log("provisioner.crashed", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
