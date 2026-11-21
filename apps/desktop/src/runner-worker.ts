import { safeMessage } from "@opensteer/shared/safeMessage";
import { runRunnerDaemon, type RunnerShutdownProof } from "@opensteer/runner";
import { refuseInspectorSignal } from "./supervisor/inspector-signal.js";
import {
  RunnerWorkerEnginesRecheckMessageSchema,
  RunnerWorkerPowerMessageSchema,
  RunnerWorkerSecretsMessageSchema,
} from "./supervisor/runner-worker-secrets.js";

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

// Before the daemon's first connection there is nothing to recheck: its hello
// reads the engines fresh.
let recheckEngines: () => void = () => undefined;
let notifySleeping: () => void = () => undefined;
let notifyAwake: () => void = () => undefined;
parent.on("message", (event) => {
  const value = event.data as { type?: unknown; restart?: unknown };
  if (value?.type === "runner.worker.stop") {
    shutdown.abort(new Error(value.restart === true ? "device-restarting" : "Runner stopping"));
    deliverSecrets(null);
    return;
  }
  if (RunnerWorkerEnginesRecheckMessageSchema.safeParse(event.data).success) {
    recheckEngines();
    return;
  }
  const power = RunnerWorkerPowerMessageSchema.safeParse(event.data);
  if (power.success) {
    if (power.data.type === "runner.worker.power.sleeping") notifySleeping();
    else notifyAwake();
    return;
  }
  const secrets = RunnerWorkerSecretsMessageSchema.safeParse(event.data);
  if (secrets.success) deliverSecrets(secrets.data.secrets);
});

let proof: RunnerShutdownProof | undefined;
void delivered
  .then(async (secrets) => {
    if (secrets === null) return;
    await runRunnerDaemon(process.env, shutdown.signal, {
      control: (control) => {
        notifySleeping = control.notifySleeping;
        notifyAwake = control.notifyAwake;
        recheckEngines = control.recheckEngines;
      },
      enrollmentNotice: (message) => process.stderr.write(`${message}\n`),
      onStarted: (control) => parent.postMessage({ type: "runner.worker.ready", control }),
      onShutdown: (result) => {
        proof = result;
      },
      onActivity: (runs) => {
        parent.postMessage({
          runs: runs.map(({ runId, threadId, startedAt, purpose, engine }) => ({
            runId,
            threadId,
            startedAt,
            purpose,
            engine,
          })),
          type: "runner.worker.activity",
        });
      },
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
    parent.postMessage({ type: "runner.worker.stopped", ...(proof ? { proof } : {}) });
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
