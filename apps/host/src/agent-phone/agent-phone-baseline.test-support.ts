import { fork } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { z } from "zod";
import type { Redaction } from "./agent-phone-device.test-support.js";

export const BaselineHostSchema = z.object({
  databaseUrl: z.string(),
  dataDirectory: z.string(),
  hostPort: z.number(),
  publicOrigin: z.url(),
  managerUrl: z.url(),
  origin: z.url(),
  ownerHeaders: z.record(z.string(), z.string()),
});

/** Keep old workspace imports in their own process; never resolve them to current packages. */
export async function startPhoneBaseline(input: {
  baseline: string;
  scratch: string;
  directory: string;
  apkPath: string;
  databaseUrl: string;
  publicPort: number;
  serial: string;
  decision: "allow" | "deny";
  redaction: Redaction;
  log: (line: string) => void;
}) {
  const entry = join(input.scratch, "baseline-host.mjs");
  const helper = pathToFileURL(
    join(input.baseline, "apps/host/src/agent-phone/agent-phone-device.test-support.ts"),
  ).href;
  const database = pathToFileURL(
    join(input.baseline, "apps/host/src/runtime/machine-access.test-support.ts"),
  ).href;
  const rpc = pathToFileURL(
    join(input.baseline, "apps/host/src/server/test-host-api-request.ts"),
  ).href;
  // This script deliberately executes the historical setup engine, including its old prompt.
  await writeFile(
    entry,
    `
import { readFile, writeFile } from 'node:fs/promises';
import { acquireAndroidDevice, startAgentPhoneHost, runAgentPhoneSetup, readPhoneStatus, waitForPhoneOnline, eventually, findView, tapView, Redaction } from ${JSON.stringify(helper)};
import { createMachineAccessDatabase } from ${JSON.stringify(database)};
import { testRpcData } from ${JSON.stringify(rpc)};
const redaction = new Redaction();
let isolated, host;
async function close() { try { await host?.close(); } finally { await isolated?.drop(); } }
process.on('SIGTERM', () => { void close().finally(() => process.exit(0)); });
try {
  isolated = await createMachineAccessDatabase(process.env.OPENSTEER_BASELINE_DATABASE_URL);
  host = await startAgentPhoneHost(isolated.url, { publicPort: Number(process.env.OPENSTEER_BASELINE_PUBLIC_PORT), log: line => console.log(line) });
  const storage = host.config.workspace.storage;
  if (storage.kind !== 'portablefs') throw new Error('Expected baseline portablefs harness');
  process.send({ id: 0, value: { databaseUrl: isolated.url, dataDirectory: host.config.dataDirectory, hostPort: host.hostPort, publicOrigin: host.publicOrigin, managerUrl: storage.managerUrl.href, origin: host.origin, ownerHeaders: host.ownerHeaders } });
  let lane = Promise.resolve();
  process.on('message', message => {
    lane = lane.then(async () => {
      try {
        if (message.command === 'setup') {
          const device = await acquireAndroidDevice({ api: 36, emulatorLog: 'unused-handed-emulator.log' });
          const activity = 'com.opensteer.agentphone/com.opensteer.agentphone.ui.ApprovalActivity';
          const steps = [];
          const result = await runAgentPhoneSetup({
            artifact: { bytes: new Uint8Array(await readFile(message.apk)), manifest: message.manifest },
            onStep: step => steps.push(step),
            device, host, redaction, runnerName: 'Baseline ' + message.decision + ' phone', timeoutMs: 180000,
            answerPrompt: async () => {
              const viewId = message.decision === 'allow' ? 'approval_allow' : 'approval_deny';
              await eventually('baseline owner prompt', async () => 'point' in await findView(device, { activity, viewId }) ? true : undefined, 30000);
              await writeFile(message.screenshot, await device.screencap());
              await tapView(device, { activity, viewId });
            },
          });
          const status = await readPhoneStatus(device);
          const runnerId = status.pairing?.runnerId;
          if (!runnerId) throw new Error('Baseline lost pairing');
          await waitForPhoneOnline(device, host, runnerId, 60000);
          const integrations = await testRpcData(host.origin, 'integrations.get', {}, { headers: host.ownerHeaders });
          const connection = integrations.connections.find(row => row.definitionId === 'android-phone' && row.computer?.runnerId === runnerId && row.status !== 'revoked') ?? null;
          const runner = await host.store.database.selectFrom('runners').select(['id', 'ownerUserId', 'publicKeyFingerprint', 'connectionGeneration', 'moduleDescriptors']).where('id', '=', runnerId).executeTakeFirstOrThrow();
          process.send({ id: message.id, value: { result, status, connection, runner, steps } });
        } else if (message.command === 'stop-host') {
          await host.runtime.close();
          process.send({ id: message.id, value: { stopped: true } });
        } else if (message.command === 'close') {
          await close(); process.send({ id: message.id, value: { stopped: true } }, () => process.exit(0));
        } else throw new Error('Unknown baseline command');
      } catch (error) { process.send({ id: message.id, error: redaction.error(error) }); }
    });
  });
} catch (error) { process.send({ id: 0, error: redaction.error(error) }); await close(); process.exit(1); }
`,
  );
  await writeFile(join(input.directory, "baseline-host.mjs"), await readFile(entry, "utf8"));
  const child = fork(entry, [], {
    cwd: input.baseline,
    execArgv: [
      "--import",
      pathToFileURL(join(input.baseline, "node_modules/tsx/dist/loader.mjs")).href,
    ],
    env: {
      ...process.env,
      ANDROID_SERIAL: input.serial,
      OPENSTEER_BASELINE_DATABASE_URL: input.databaseUrl,
      OPENSTEER_BASELINE_PUBLIC_PORT: String(input.publicPort),
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout?.on("data", (bytes: Buffer) => input.log(bytes.toString()));
  child.stderr?.on("data", (bytes: Buffer) => input.log(bytes.toString()));
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const exited = once(child, "exit");
  child.on("message", (wire: unknown) => {
    const message = z
      .object({ id: z.number(), value: z.unknown().optional(), error: z.string().optional() })
      .parse(wire);
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request?.reject(new Error(message.error));
    else request?.resolve(message.value);
  });
  child.on("exit", (code) => {
    for (const request of pending.values())
      request.reject(new Error(`Baseline process exited (${code})`));
    pending.clear();
  });
  let id = 0;
  const wait = (requestId: number) =>
    withTimeout(
      new Promise<unknown>((resolve, reject) => pending.set(requestId, { resolve, reject })),
      240_000,
      { timeoutError: () => new Error(`Baseline request ${requestId} timed out`) },
    );
  const request = async (command: string, fields: Record<string, unknown> = {}) => {
    const requestId = ++id;
    const value = wait(requestId);
    child.send({ ...fields, command, id: requestId });
    return value;
  };
  try {
    const host = BaselineHostSchema.parse(await wait(0));
    input.redaction.add(...Object.values(host.ownerHeaders));
    return {
      host,
      setup: (manifest: unknown) =>
        request("setup", {
          apk: input.apkPath,
          manifest,
          decision: input.decision,
          screenshot: join(input.directory, "baseline-owner-prompt.png"),
        }),
      stopHost: () => request("stop-host"),
      close: async () => {
        try {
          await request("close");
          await exited;
        } finally {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGTERM");
            await withTimeout(exited, 15_000, {
              timeoutError: () => {
                child.kill("SIGKILL");
                return new Error("Baseline cleanup required SIGKILL");
              },
            });
          }
        }
      },
    };
  } catch (error) {
    child.kill("SIGTERM");
    await withTimeout(exited, 15_000, {
      timeoutError: () => {
        child.kill("SIGKILL");
        return new Error("Baseline startup cleanup required SIGKILL");
      },
    });
    throw error;
  }
}
