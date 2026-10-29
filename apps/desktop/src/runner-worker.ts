import { safeMessage } from "@opensteer/shared/safeMessage";
import { runRunnerDaemon } from "@opensteer/runner";
import { refuseInspectorSignal } from "./supervisor/inspector-signal.js";
import { RunnerWorkerSecretsMessageSchema } from "./supervisor/runner-worker-secrets.js";

// Before the Runner holds any credential in memory.
refuseInspectorSignal(process);

const shutdown = new AbortController();
const parent = process.parentPort;

if (!parent)
  throw new Error("The local Runner worker must be launched as an Electron utility process.");

// The desktop posts the credentials first thing; the Runner starts once they
// are here, or not at all if it is stopped before they arrive.
let deliverSecrets: (secrets: Readonly<Record<string, string>> | null) => void = () => undefined;
const delivered = new Promise<Readonly<Record<string, string>> | null>((resolvePromise) => {
  deliverSecrets = resolvePromise;
});

parent.on("message", (event) => {
  const value = event.data as { type?: unknown };
  if (value?.type === "runner.worker.stop") {
    shutdown.abort(new Error("The Opensteer desktop app is stopping local execution."));
    deliverSecrets(null);
    return;
  }
  const secrets = RunnerWorkerSecretsMessageSchema.safeParse(event.data);
  if (secrets.success) deliverSecrets(secrets.data.secrets);
});

void delivered
  .then(async (secrets) => {
    if (secrets === null) return;
    await runRunnerDaemon(process.env, shutdown.signal, {
      onConnected: ({ environmentId, runnerId }) => {
        parent.postMessage({ environmentId, runnerId, type: "runner.worker.connected" });
      },
      onDisconnected: () => {
        parent.postMessage({ type: "runner.worker.reconnecting" });
      },
      onRevoked: () => {
        parent.postMessage({ type: "runner.worker.revoked" });
      },
      secrets,
    });
  })
  .then(() => {
    parent.postMessage({ type: "runner.worker.stopped" });
  })
  .catch((error: unknown) => {
    parent.postMessage({
      message: safeMessage(error, safeMessageOptions),
      type: "runner.worker.failed",
    });
    process.exitCode = 1;
  });

const safeMessageOptions = {
  fallback: "The local Runner failed.",
  redactions: [
    { pattern: /Bearer\s+\S+/giu, replacement: "Bearer [redacted]" },
    { pattern: /os_secret_[A-Za-z0-9_-]+/gu, replacement: "os_secret_[redacted]" },
  ],
} as const;
