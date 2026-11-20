import { safeMessage } from "@opensteer/shared/safeMessage";
import { manualAgentWork, runRunnerDaemon } from "@opensteer/runner";
import { refuseInspectorSignal } from "./supervisor/inspector-signal.js";
import {
  RunnerWorkerEnginesRecheckMessageSchema,
  RunnerWorkerPowerMessageSchema,
  RunnerWorkerSecretsMessageSchema,
  RunnerWorkerStopRunMessageSchema,
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
// A Run can only be running once the daemon has started.
let stopRun: (runId: string) => boolean = () => false;
let agentNoticeSent: () => Promise<void> = () => Promise.resolve();
// The person's Stop on this Mac, as the desktop app tells this Device Runner.
const agentWork = manualAgentWork();
/** How long a stop for the person's Stop waits for its Home to hear it first. */
const agentNoticeWaitMs = 1_500;

parent.on("message", (event) => {
  const value = event.data as { type?: unknown; agentsStopped?: unknown };
  if (value?.type === "runner.worker.stop") {
    const stop = () => {
      shutdown.abort(new Error("The Opensteer desktop app is stopping local execution."));
      deliverSecrets(null);
    };
    if (value.agentsStopped !== true) {
      stop();
      return;
    }
    // The person stopped agents on this Mac: its Home hears that before the
    // Runner goes, so it says "stopped" rather than "offline".
    agentWork.set(true);
    void Promise.race([
      agentNoticeSent(),
      new Promise<void>((resolve) => setTimeout(resolve, agentNoticeWaitMs).unref()),
    ]).finally(stop);
    return;
  }
  if (RunnerWorkerEnginesRecheckMessageSchema.safeParse(event.data).success) {
    recheckEngines();
    return;
  }
  const stop = RunnerWorkerStopRunMessageSchema.safeParse(event.data);
  if (stop.success) {
    stopRun(stop.data.runId);
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

void delivered
  .then(async (secrets) => {
    if (secrets === null) return;
    await runRunnerDaemon(process.env, shutdown.signal, {
      control: (control) => {
        notifySleeping = control.notifySleeping;
        notifyAwake = control.notifyAwake;
        recheckEngines = control.recheckEngines;
        stopRun = control.stopRun;
        agentNoticeSent = control.agentNoticeSent;
      },
      agentWork,
      onActivity: (runs) => {
        parent.postMessage({
          runs: runs.map(({ runId, startedAt, purpose, engine }) => ({
            runId,
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
