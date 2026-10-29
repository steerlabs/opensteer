import { startEchoTestServer as startEchoServer } from "@opensteer/shared/test-support/tcpServer";
import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream } from "node:fs";
import { connect, createServer } from "node:net";
import { mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MachineAccessPolicy } from "@opensteer/protocol";
import type { MachineAccessSetup } from "@opensteer/runner";
import {
  activeSessionId,
  enrollmentToken,
  machineAccessHistory,
  openRealtime,
  createMachineAccessDatabase,
  resetMachineAccessDatabase,
  revokeMachine,
  runShim,
  shellSessionRows,
  signUpUser,
  startMachineAccessScenario,
  startShim,
  stopShellSession,
  updateAccessPolicy,
  waitForCondition,
  type MachineAccessScenario,
} from "./machine-access.test-support.js";
import { testRpcData } from "../server/test-host-api-request.js";

/** What the Host recorded about the traffic it carried, and who was told. */
const baseDatabaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = baseDatabaseUrl ? describe : describe.skip;
let database: Awaited<ReturnType<typeof createMachineAccessDatabase>> | undefined;
let databaseUrl = "postgres://unconfigured";
process.env.SHELL = "/bin/sh";

const artifactDirectory = process.env.OPENSTEER_MACHINE_ACCESS_ARTIFACT_DIR;

const transferBytes = 200 * 1_024 * 1_024;

integration("Machine access audit, transfer and realtime", () => {
  beforeAll(async () => {
    database = await createMachineAccessDatabase(baseDatabaseUrl ?? "");
    databaseUrl = database.url;
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
    database = undefined;
  }, 120_000);

  let scenario: MachineAccessScenario | undefined;
  let share = "";

  beforeEach(async () => {
    await resetMachineAccessDatabase(databaseUrl);
    share = await realpath(await mkdtemp(join(tmpdir(), "opensteer-ma-share-")));
  });

  afterEach(async () => {
    await scenario?.close();
    scenario = undefined;
    if (share) await rm(share, { force: true, recursive: true });
  }, 60_000);

  // Failures: fixture allocation pollutes process RSS; a failed operation
  // abandons its infinite producer; one stalled session blocks other traffic.
  it.each([false, true])(
    "moves 200 MB intact and reaps children (injected failure: %s)",
    async (failOperation) => {
      const source = join(share, "payload.bin");
      const expectedDigest = await writeRandomFile(source, transferBytes);
      scenario = await startMachineAccessScenario(databaseUrl, {
        policy: { ...sharePolicy(share, "read"), commands: true },
      });
      const { alias, host, launch, target } = scenario;
      const local = await mkdtemp(join(tmpdir(), "opensteer-ma-download-"));
      let stalled: ChildProcess | undefined;
      let stalledExited: Promise<unknown> | undefined;
      let feeding: ReturnType<typeof feedForever> | undefined;
      const shims: ReturnType<typeof startShim>[] = [];
      const facts: Record<string, unknown> = {
        payloadBytes: transferBytes,
        expectedDigest,
        failOperation,
      };
      let passed = false;
      let injectedFailureObserved = false;
      try {
        stalled = spawn(join(launch.launchDirectory, "bin", "ssh"), [alias, "cat"], {
          env: { ...launch.environment },
          shell: false,
          stdio: ["pipe", "pipe", "ignore"],
        });
        stalledExited = new Promise((resolve, reject) => {
          stalled?.once("error", reject);
          stalled?.once("close", (code, signal) => resolve({ code, signal }));
        });
        if (!stalled.stdin) throw new Error("Stalled SSH has piped stdin");
        feeding = feedForever(stalled.stdin);
        const stalledSessionId = await waitForValueOf(
          async () => (await shellSessionRows(host)).find((row) => row.state === "active")?.id,
        );
        facts.stalledSessionId = stalledSessionId;
        const stopped = startShim(launch, "ssh", [alias, "sleep 120"]);
        shims.push(stopped);
        const stoppedSessionId = await waitForValueOf(
          async () =>
            (await shellSessionRows(host)).find(
              (row) => row.state === "active" && row.id !== stalledSessionId,
            )?.id,
        );
        if (failOperation) throw new Error("Injected transfer operation failure");
        const sessionsBeforeTransfer = new Set((await shellSessionRows(host)).map((row) => row.id));
        const transfer = startShim(launch, "scp", [
          `${alias}:${source}`,
          join(local, "payload.bin"),
        ]);
        shims.push(transfer);
        await stopShellSession(host, { key: "stop-mid-transfer", sessionId: stoppedSessionId });
        await stopped.exited;
        expect(await transfer.exited).toMatchObject({ code: 0 });
        const actualDigest = await digestOf(join(local, "payload.bin"));
        facts.actualDigest = actualDigest;
        expect(actualDigest).toBe(expectedDigest);
        await waitForCondition(async () =>
          (await shellSessionRows(host)).some(
            (row) => row.id === stoppedSessionId && row.endReason === "stopped-by-owner",
          ),
        );
        const transferRow = await waitForValueOf(async () =>
          (await shellSessionRows(host)).find(
            (row) =>
              !sessionsBeforeTransfer.has(row.id) &&
              row.state === "ended" &&
              Number(row.bytesOut) > transferBytes / 2 &&
              Number(row.bytesIn) > 0,
          ),
        );
        const rows = await shellSessionRows(host);
        expect(rows.find((row) => row.id === stoppedSessionId)?.endReason).toBe("stopped-by-owner");
        expect(rows.every((row) => row.runnerId === target.runnerId)).toBe(true);
        facts.transfer = transferRow;
        facts.stopped = rows.find((row) => row.id === stoppedSessionId);
        passed = true;
      } catch (error) {
        if (
          !failOperation ||
          !(error instanceof Error) ||
          error.message !== "Injected transfer operation failure"
        )
          throw error;
        injectedFailureObserved = true;
        passed = true;
      } finally {
        feeding?.stop();
        stalled?.kill("SIGKILL");
        for (const shim of shims) shim.kill();
        try {
          facts.stalledExit = await stalledExited;
          facts.childExits = await Promise.all(shims.map((shim) => shim.exited));
          facts.childrenReaped = true;
        } finally {
          await rm(local, { force: true, recursive: true });
          await auditArtifact(`transfer-${failOperation ? "failure" : "success"}.json`, {
            passed,
            injectedFailureObserved,
            ...facts,
          });
        }
      }
      expect(injectedFailureObserved).toBe(failOperation);
      expect(facts.childrenReaped).toBe(true);
    },
    180_000,
  );

  it("reports each session's requests newest first, and truncates a flood at 1,000", async () => {
    await writeFile(join(share, "small.txt"), "small body");
    scenario = await startMachineAccessScenario(databaseUrl, {
      policy: { ...sharePolicy(share, "read-write"), commands: true, forwarding: true },
    });
    const { alias, host, launch, target } = scenario;
    const local = await mkdtemp(join(tmpdir(), "opensteer-ma-audit-"));
    const echo = await startEchoServer();
    try {
      expect(await runShim(launch, "ssh", [alias, "printf audited; exit 7"])).toMatchObject({
        code: 7,
      });
      const refusedShell = await runShim(launch, "ssh", [alias]);
      expect(refusedShell.code).toBe(126);

      const batch = join(local, "batch.txt");
      await writeFile(
        batch,
        [
          `get "${join(share, "small.txt")}" "${join(local, "small.txt")}"`,
          `mkdir "${join(share, "made")}"`,
          `rename "${join(share, "small.txt")}" "${join(share, "renamed.txt")}"`,
          "",
        ].join("\n"),
      );
      expect(await runShim(launch, "sftp", ["-b", batch, alias])).toMatchObject({ code: 0 });

      const forwardPort = await freeLocalPort();
      const forward = startShim(launch, "ssh", [
        "-N",
        "-L",
        `${forwardPort}:127.0.0.1:${echo.port}`,
        alias,
      ]);
      await waitForCondition(async () => (await pingThrough(forwardPort)) === "ping-pong");
      forward.kill();
      await forward.exited;

      await waitForAllSessionsEnded(host);
      let history = await machineAccessHistory(host, target.runnerId);
      await waitForCondition(async () => {
        history = await machineAccessHistory(host, target.runnerId);
        const requestChannels = history.sessions.flatMap((session) =>
          session.events.flatMap((event) =>
            event.kind === "exec" || event.kind === "forward" || event.kind === "sftp.open"
              ? [{ channel: event.channel, sessionId: session.id }]
              : [],
          ),
        );
        const requestKinds = new Set(
          history.sessions.flatMap((session) =>
            session.events.flatMap((event) =>
              event.kind === "exec" || event.kind === "forward" || event.kind === "sftp.open"
                ? [event.kind]
                : [],
            ),
          ),
        );
        return (
          requestKinds.has("exec") &&
          requestKinds.has("forward") &&
          requestKinds.has("sftp.open") &&
          requestChannels.every(({ channel, sessionId }) =>
            history.sessions
              .find((session) => session.id === sessionId)
              ?.events.some(
                (event) => event.kind === "channel.closed" && event.channel === channel,
              ),
          )
        );
      });
      // Newest first, by (startedAt, id).
      const startTimes = history.sessions.map((session) => Date.parse(session.startedAt));
      expect([...startTimes].sort((left, right) => right - left)).toEqual(startTimes);
      const events = history.sessions.flatMap((session) => session.events);
      expect(events).toContainEqual({
        channel: expect.any(Number),
        command: "printf audited; exit 7",
        kind: "exec",
      });
      expect(events).toContainEqual({
        channel: expect.any(Number),
        exitStatus: 7,
        kind: "channel.closed",
      });
      expect(events).toContainEqual({
        channel: expect.any(Number),
        detail: "shell",
        kind: "denied",
        what: "shell",
      });
      expect(events).toContainEqual({
        channel: expect.any(Number),
        kind: "sftp.open",
        mode: "read",
        path: join(share, "small.txt"),
      });
      expect(events).toContainEqual({
        channel: expect.any(Number),
        kind: "sftp.mutate",
        op: "mkdir",
        path: join(share, "made"),
      });
      expect(events).toContainEqual({
        channel: expect.any(Number),
        kind: "sftp.mutate",
        op: "rename",
        path: join(share, "small.txt"),
        target: join(share, "renamed.txt"),
      });
      expect(events).toContainEqual({
        channel: expect.any(Number),
        host: "127.0.0.1",
        kind: "forward",
        port: echo.port,
      });
      const completedRequestSessions = history.sessions.filter((session) =>
        session.events.some(
          (event) =>
            event.kind === "exec" || event.kind === "forward" || event.kind === "sftp.open",
        ),
      );
      expect(completedRequestSessions.length).toBeGreaterThan(0);
      for (const completed of completedRequestSessions) {
        const closedChannels = new Set(
          completed.events.flatMap((event) =>
            event.kind === "channel.closed" ? [event.channel] : [],
          ),
        );
        const requestChannels = new Set(
          completed.events.flatMap((event) =>
            event.kind === "exec" || event.kind === "forward" || event.kind === "sftp.open"
              ? [event.channel]
              : [],
          ),
        );
        expect([...requestChannels].every((channel) => closedChannels.has(channel))).toBe(true);
        expect(completed.events.some((event) => event.kind === "truncated")).toBe(false);
      }
      const transferSession = history.sessions.find((session) =>
        session.events.some((event) => event.kind === "sftp.open"),
      );
      expect(transferSession?.bytesIn).toBeGreaterThan(0);
      expect(transferSession?.bytesOut).toBeGreaterThan(0);

      // One session, more requests than a row may hold: the first thousand are
      // kept and the omission is the single marker that says so.
      const flood = join(local, "flood.txt");
      await writeFile(
        flood,
        `${Array.from(
          { length: 1_100 },
          () => `get "${join(share, "renamed.txt")}" "${join(local, "flooded.txt")}"`,
        ).join("\n")}\n`,
      );
      const floodRun = await runShim(launch, "sftp", ["-b", flood, alias], {
        timeoutMs: 120_000,
      });
      expect(floodRun).toMatchObject({ code: 0 });
      await waitForAllSessionsEnded(host);
      const flooded = (await machineAccessHistory(host, target.runnerId)).sessions[0];
      expect(flooded?.events.filter((event) => event.kind === "sftp.open")).toHaveLength(1_000);
      expect(flooded?.events.filter((event) => event.kind === "truncated")).toHaveLength(1);
      expect(flooded?.events).toHaveLength(1_001);
      expect(flooded?.events.at(-1)).toEqual({ kind: "truncated" });
    } finally {
      await echo.close();
      await rm(local, { force: true, recursive: true });
    }
  }, 300_000);

  it("tells the machine's owner about each session and tells nobody else", async () => {
    scenario = await startMachineAccessScenario(databaseUrl, {
      policy: { commands: true, forwarding: false, reach: "owner", shares: [] },
      signupPolicy: "open",
    });
    const { alias, host, launch, target } = scenario;
    const bystander = await signUpUser(host, {
      email: "bystander@example.com",
      password: "machine-access-bystander-password",
    });
    const ownerFeed = await openRealtime(host, host.ownerHeaders);
    const bystanderFeed = await openRealtime(host, bystander.headers);
    try {
      expect(await runShim(launch, "ssh", [alias, "echo watched"])).toMatchObject({ code: 0 });
      const started = await waitForValueOf(async () =>
        ownerFeed.messages.find(
          (message) => message.type === "host.machine.access.session.started",
        ),
      );
      const sessionId = (started.session as { readonly id: string }).id;
      const persisted = await waitForValueOf(async () =>
        (await shellSessionRows(host)).find((row) => row.id === sessionId && row.state === "ended"),
      );
      const ended = await waitForValueOf(async () =>
        ownerFeed.messages.find(
          (message) =>
            message.type === "host.machine.access.session.ended" &&
            (message.session as { readonly id: string }).id === sessionId,
        ),
      );
      expect(started).toMatchObject({
        runnerId: target.runnerId,
        session: {
          callerMachineName: "Caller computer",
          requestedBy: host.ownerId,
          threadTitle: "Reach out",
        },
      });
      expect(["client-closed", "target-closed"]).toContain(persisted.endReason);
      expect(ended).toMatchObject({
        endReason: persisted.endReason,
        runnerId: target.runnerId,
        session: { id: sessionId },
      });
      expect(
        ownerFeed.messages.filter(
          (message) =>
            message.type === "host.machine.access.session.started" &&
            (message.session as { readonly id: string }).id === sessionId,
        ),
      ).toHaveLength(1);
      expect(
        ownerFeed.messages.filter(
          (message) =>
            message.type === "host.machine.access.session.ended" &&
            (message.session as { readonly id: string }).id === sessionId,
        ),
      ).toHaveLength(1);
      // Reach is what lets a Run connect; it never makes a viewer a manager.
      expect(
        bystanderFeed.messages.filter((message) =>
          String(message.type).startsWith("host.machine.access."),
        ),
      ).toEqual([]);
    } finally {
      await ownerFeed.close();
      await bystanderFeed.close();
      await auditArtifact("owner-notification.json", {
        ownerId: host.ownerId,
        ownerEvents: ownerFeed.messages.filter((message) =>
          String(message.type).startsWith("host.machine.access."),
        ),
        bystanderEvents: bystanderFeed.messages.filter((message) =>
          String(message.type).startsWith("host.machine.access."),
        ),
        persisted: await shellSessionRows(host),
      });
    }
  }, 180_000);

  it("tells every connected client the computers list changed, and names nothing", async () => {
    scenario = await startMachineAccessScenario(databaseUrl, {
      policy: { commands: true, forwarding: false, reach: "owner", shares: [] },
      signupPolicy: "open",
    });
    const { host, target } = scenario;
    const bystander = await signUpUser(host, {
      email: "listener@example.com",
      password: "machine-access-listener-password",
    });
    const ownerFeed = await openRealtime(host, host.ownerHeaders);
    const bystanderFeed = await openRealtime(host, bystander.headers);
    const changes = (feed: { readonly messages: readonly Record<string, unknown>[] }) =>
      feed.messages.filter((message) => message.type === "host.machines.changed");
    const settle = async (atLeast: number) => {
      await waitForCondition(async () => changes(ownerFeed).length >= atLeast);
      return changes(ownerFeed).length;
    };
    try {
      // A Runner disconnecting and reconnecting are both changes to the list.
      await target.disconnect();
      let seen = await settle(1);
      await target.reconnect();
      seen = await settle(seen + 1);

      // Minting a pending computer, renaming one, writing an access policy,
      // and removing one: each is a row the list now reads differently.
      await enrollmentToken(host, {
        allowedModules: ["shell"],
        idempotencyKey: "changed-enrollment",
        name: "Pending computer",
      });
      seen = await settle(seen + 1);

      await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          idempotencyKey: "changed-rename",
          machineId: target.runnerId,
          name: "Studio Mac",
          type: "machine.rename",
        },
        { headers: host.ownerHeaders },
      );
      seen = await settle(seen + 1);

      await updateAccessPolicy(host, {
        expectedRevision: 2,
        key: "changed-policy",
        policy: { commands: true, forwarding: false, reach: "deployment", shares: [] },
        runnerId: target.runnerId,
      });
      seen = await settle(seen + 1);

      await revokeMachine(host, { key: "changed-revoke", runnerId: target.runnerId });
      seen = await settle(seen + 1);

      // It names nothing: the machine, the person, and what happened are all
      // absent, because every client answers it by rereading the list.
      expect(changes(ownerFeed)).toEqual(
        Array.from({ length: seen }, () => ({ type: "host.machines.changed" })),
      );
      // And it goes to everybody, unlike the two session messages, which are
      // facts about one machine and reach only its managers.
      await waitForCondition(async () => changes(bystanderFeed).length === seen);
      expect(
        bystanderFeed.messages.filter((message) =>
          String(message.type).startsWith("host.machine.access."),
        ),
      ).toEqual([]);
    } finally {
      await ownerFeed.close();
      await bystanderFeed.close();
    }
  }, 180_000);

  it("is ready before a byte moves and records the helper's own idle ending", async () => {
    scenario = await startMachineAccessScenario(databaseUrl, {
      idleTimeoutMs: 1_500,
      policy: { commands: true, forwarding: false, reach: "owner", shares: [] },
    });
    const { alias, host, launch, target } = scenario;

    // The Runner writes its init frame, the helper accepts it and answers
    // `ready`, and only then does the Host activate — so the acknowledgement
    // the ssh proxy waits for cannot precede the module saying it is open.
    const relay = await relayHandshake(launch, target.runnerId);
    expect(reportedBefore(target, relay.acknowledgedAt, "runner.shell.session.opened")).toBe(true);
    relay.close();
    // That handshake was a session of its own; let it finish so the idle one
    // below is unambiguously the session this test is watching.
    await waitForAllSessionsEnded(host);

    const idle = startShim(launch, "ssh", [alias, "sleep 30"]);
    const sessionId = await activeSessionId(host, target.runnerId);
    const exited = await idle.exited;
    expect(exited.code).not.toBe(0);
    await waitForCondition(async () =>
      (await shellSessionRows(host)).some((row) => row.id === sessionId && row.state === "ended"),
    );
    expect((await shellSessionRows(host)).find((row) => row.id === sessionId)?.endReason).toBe(
      "idle-timeout",
    );
    // The module reports the helper's own reason rather than a bare socket close.
    expect(
      target.reported.some(
        (entry) =>
          entry.frame.type === "runner.shell.session.closed" &&
          entry.frame.sessionId === sessionId &&
          entry.frame.reason === "idle-timeout",
      ),
    ).toBe(true);
  }, 180_000);
});

async function waitForAllSessionsEnded(
  host: Parameters<typeof shellSessionRows>[0],
): Promise<void> {
  // Generous on purpose: a thousand audited requests are persisted one batch at
  // a time, and this suite shares a machine with whatever else is building.
  const deadline = Date.now() + 120_000;
  for (;;) {
    const rows = await shellSessionRows(host);
    if (rows.every((row) => row.state === "ended")) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `sessions still open: ${JSON.stringify(rows.filter((row) => row.state !== "ended"))}`,
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

function sharePolicy(path: string, mode: "read" | "read-write"): MachineAccessPolicy {
  return { commands: false, forwarding: false, reach: "owner", shares: [{ mode, path }] };
}

async function writeRandomFile(path: string, bytes: number): Promise<string> {
  const hash = createHash("sha256");
  const chunk = randomBytes(1_024 * 1_024);
  const handle = await open(path, "wx");
  try {
    for (let written = 0; written < bytes;) {
      const part = chunk.subarray(0, Math.min(chunk.byteLength, bytes - written));
      await handle.writeFile(part);
      hash.update(part);
      written += part.byteLength;
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function digestOf(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Keeps offering bytes to a session whose output nobody is reading. */
function feedForever(stdin: NodeJS.WritableStream): { stop(): void } {
  const block = Buffer.alloc(64 * 1_024, 0x61);
  let stopped = false;
  const write = () => {
    while (!stopped && stdin.write(block)) {
      // Keep going until the socket refuses more.
    }
    if (!stopped) stdin.once("drain", write);
  };
  stdin.on("error", () => undefined);
  write();
  return {
    stop: () => {
      stopped = true;
      stdin.end(() => undefined);
    },
  };
}

async function waitForValueOf<Value>(produce: () => Promise<Value | undefined>): Promise<Value> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await produce();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error("timed out waiting for a value");
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

function reportedBefore(
  target: {
    readonly reported: readonly { readonly at: number; readonly frame: Record<string, unknown> }[];
  },
  instant: number,
  type: string,
): boolean {
  return target.reported.some((entry) => entry.frame.type === type && entry.at <= instant);
}

/** One relay connection, timestamped at the acknowledgement the proxy waits for. */
async function relayHandshake(
  launch: MachineAccessSetup,
  runnerId: string,
): Promise<{ readonly acknowledgedAt: number; close(): void }> {
  return new Promise((resolve, reject) => {
    const socket = connect(launch.machineAccessRelaySocket);
    let pending = "";
    const timer = setTimeout(() => reject(new Error("relay never acknowledged")), 15_000);
    timer.unref();
    socket.once("error", reject);
    socket.once("connect", () => socket.write(`${JSON.stringify({ target: runnerId })}\n`));
    socket.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      const newline = pending.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(timer);
      const acknowledgedAt = Date.now();
      if (pending.slice(0, newline) !== '{"ok":true}') {
        reject(new Error(`relay answered ${pending.slice(0, newline)}`));
        return;
      }
      socket.removeAllListeners("data");
      resolve({ acknowledgedAt, close: () => socket.destroy() });
    });
  });
}

async function freeLocalPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no free port");
  const { port } = address;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function pingThrough(port: number): Promise<"unreachable" | "ping-pong"> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    let settled = false;
    const settle = (value: "unreachable" | "ping-pong") => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once("error", () => settle("unreachable"));
    socket.once("connect", () => socket.write("ping"));
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).toString("utf8") === "ping") settle("ping-pong");
    });
    socket.once("close", () => settle("unreachable"));
    setTimeout(() => settle("unreachable"), 3_000).unref();
  });
}

async function auditArtifact(name: string, facts: unknown): Promise<void> {
  if (!artifactDirectory) return;
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(
    join(artifactDirectory, name),
    JSON.stringify(
      facts,
      (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
      2,
    ),
  );
}
