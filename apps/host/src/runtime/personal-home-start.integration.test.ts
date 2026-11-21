import { browserRuntimeWireVersion } from "@opensteer/protocol/browser";
import { expect, it, vi } from "vitest";
import { openAuxiliaryStream } from "./computer-apps.test-support.js";
import {
  closed,
  connectCallerMachine,
  createMachineAccessDatabase,
  startMachineAccessWireHost,
  type MachineAccessWireHost,
} from "./machine-access-protocol.test-support.js";

/**
 * A fresh Personal Home has its owner and its hosting computer before it has
 * Personal settings: the hosting Runner creates Agent home and reports where it
 * is, and only then does the Home write the settings every owner read needs.
 * Until then the Home is still starting, so it answers "not ready", never
 * "forbidden": the desktop waits on the first and gives up on the second.
 */
const runtimeId = "home-start-browser";

async function freshHome(run: (host: MachineAccessWireHost) => Promise<void>) {
  const database = await createMachineAccessDatabase(process.env.OPENSTEER_TEST_DATABASE_URL!);
  try {
    const host = await startMachineAccessWireHost(database.url, { manualRunner: true });
    try {
      await run(host);
    } finally {
      await host.close();
    }
  } finally {
    await database.drop();
  }
}

/** The hosting Runner connected, its Browser Runtime attached, Agent home not yet reported. */
async function connectHosting(host: MachineAccessWireHost) {
  const hosting = await connectCallerMachine(host, {
    name: "Hosting computer",
    token: host.hostingRunnerEnrollmentToken,
    holdAgentHomeReport: true,
    browser: { runtimeId, wireVersion: browserRuntimeWireVersion },
  });
  const browser = await openAuxiliaryStream(host.hostPort, hosting.primary, "browser");
  return {
    ...hosting,
    close: async () => {
      browser.socket.close();
      await closed(browser.socket);
      await hosting.close();
    },
  };
}

const readiness = (host: MachineAccessWireHost) => ({
  runner: () =>
    host.api["personal.readiness.get"]({
      kind: "runner",
      environmentId: host.ownerEnvironmentId,
      runnerId: host.hostingComputerId,
    }),
  browserPlacement: () =>
    host.api["personal.readiness.get"]({
      kind: "browser-placement",
      environmentId: host.ownerEnvironmentId,
      runtimeId,
    }),
});

const settingsRow = (host: MachineAccessWireHost) =>
  host.store.database.selectFrom("personalSettings").select("agentHomePath").executeTakeFirst();

it("answers not ready, never forbidden, while the hosting computer has not reported Agent home", async () => {
  await freshHome(async (host) => {
    const hosting = await connectHosting(host);
    try {
      const read = readiness(host);
      // The Runner is connected and registered: its harness catalog is committed.
      expect(await settingsRow(host)).toBeUndefined();
      // The read the desktop gave up on: an owner's read, refused as if they were not the owner.
      expect(await read.browserPlacement()).toEqual({ ok: true, data: { ready: false } });
      expect(await read.runner()).toEqual({ ok: true, data: { ready: false } });
      // Still the same answer while the report is held: nothing else makes the Home ready.
      expect(await read.runner()).toEqual({ ok: true, data: { ready: false } });
      expect(await settingsRow(host)).toBeUndefined();

      hosting.reportAgentHome();
      await vi.waitFor(
        async () => expect(await read.runner()).toEqual({ ok: true, data: { ready: true } }),
        { timeout: 15_000 },
      );
      expect(await settingsRow(host)).toEqual({ agentHomePath: host.agentHome.path });
      await vi.waitFor(
        async () =>
          expect(await read.browserPlacement()).toEqual({ ok: true, data: { ready: true } }),
        { timeout: 15_000 },
      );
    } finally {
      await hosting.close();
    }
  });
}, 120_000);

it("runs the desktop's start-up reads in order on a fresh Home without a refusal", async () => {
  await freshHome(async (host) => {
    const read = readiness(host);
    const answers: unknown[] = [];
    const record = async <T>(answer: Promise<T>) => {
      const value = await answer;
      answers.push(value);
      return value;
    };
    // Owner claimed by the fixture; the Runner starts and connects.
    const hosting = await connectHosting(host);
    try {
      // waitForRunner: polls until ready. The Runner reports Agent home on its own time.
      expect(await record(read.runner())).toEqual({ ok: true, data: { ready: false } });
      hosting.reportAgentHome();
      await vi.waitFor(
        async () =>
          expect(await record(read.runner())).toEqual({ ok: true, data: { ready: true } }),
        { timeout: 15_000 },
      );
      // ensureAgentHome: one shell read, which now finds the Home's settings and owner profile.
      const shell = await record(host.api["personal.shell.get"]({}));
      expect(shell).toMatchObject({ ok: true, data: { session: { user: { id: host.ownerId } } } });
      // waitForBrowserPlacement: polls until this computer's Browser Runtime is placed.
      await vi.waitFor(
        async () =>
          expect(await record(read.browserPlacement())).toEqual({
            ok: true,
            data: { ready: true },
          }),
        { timeout: 15_000 },
      );
      expect(answers.filter((answer) => (answer as { ok: boolean }).ok !== true)).toEqual([]);
    } finally {
      await hosting.close();
    }
  });
}, 120_000);
