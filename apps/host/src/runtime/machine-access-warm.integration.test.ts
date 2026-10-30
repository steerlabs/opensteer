import { readCodexCaptures } from "../agents/codex-capture.test-support.js";
import { freePort } from "@opensteer/shared/test-support/loopbackPort";
import { startHoldingHop, type HoldingHop } from "./machine-access-hop.test-support.js";
import { probeTestServer } from "@opensteer/shared/test-support/serverProbes";
import { ManualClock } from "@opensteer/shared/test-support/clock";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { connect, createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  createId,
  ModelSelectionSchema,
  type RunId,
  type RunnerId,
  type ThreadId,
} from "@opensteer/core";
import {
  HarnessRegistry,
  nativeUserHarnessRuntimeBoundary,
  type HarnessAdapter,
} from "@opensteer/harness";
import { CodexHarnessDriver } from "@opensteer/harness-codex";
import type { MachineAccessPolicy } from "@opensteer/protocol";
import { harnessLaunchValidationHook, type MachineAccessValidationHook } from "@opensteer/runner";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { startVerticalStack, type VerticalStack } from "../agents/vertical-stack.test-support.js";
import { testRpcData } from "../server/test-host-api-request.js";
import {
  connectTargetMachine,
  enrollmentToken,
  nativeFsHelperBinary,
  revokeMachine,
  runCommand,
  runShim,
  startShim,
  updateAccessPolicy,
  type MachineAccessOwner,
  type RunningShim,
  type TargetMachine,
} from "./machine-access.test-support.js";

/*
 * A warm engine keeps the launch directory it reaches other computers through
 * for as long as it runs, and lends its relay to one Run at a time. Each
 * journey drives the real Host and Runner with the Codex driver against the
 * fake app server, computers attached with the production shell module serving
 * the built helper, and this computer's OpenSSH through the launch directory's
 * own shims, run with the environment the setup probe proved. The fake engine
 * holds each turn until its release file appears, so a journey acts while a
 * Run is live; the shell relay reaches the Host through a hop that can hold a
 * handshake in flight.
 *
 * The artifact records, per journey, each Run's engine process and start, its
 * launch directory and route-manifest hash, the session rows with their end
 * reasons, and what an idle or ended relay answered. It records no token.
 */

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
// The helper runs `$SHELL -c`, so the journeys pin the shell they assert against.
process.env.SHELL = "/bin/sh";

const fakeCodexAppServer = fileURLToPath(
  new URL(
    "../../../../packages/harness-codex/src/test-fixtures/fake-codex-app-server.mjs",
    import.meta.url,
  ),
);
const selection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: { effort: "low" },
  providerId: "openai",
});
const commandsOnly: MachineAccessPolicy = {
  commands: true,
  forwarding: false,
  reach: "owner",
  shares: [],
};
const noRunSentence = "This Run's access to other computers has ended.";
const unlistedSentence =
  "That computer is not listed for this Run, so it cannot be addressed from it.";
const sshNoticeHeading = "Other computers you can reach over SSH";

interface Launch {
  readonly environment: Readonly<Record<string, string>>;
  readonly launchDirectory: string;
}

interface Probe {
  readonly launch: Launch;
  readonly relaySocket: string;
}

interface LiveRun {
  readonly enginePid: number;
  /** The launch directory the Run's engine uses, when its note lists computers. */
  readonly launch: Launch | undefined;
  readonly notice: string;
  readonly relaySocket: string | undefined;
  readonly routeManifest: string | null;
  readonly runId: RunId;
}

interface RunRecord {
  readonly engineStart: string | null;
  readonly enginePid: number;
  readonly launchDirectory: string | null;
  readonly routeManifest: string | null;
  readonly runId: RunId;
  readonly status: string;
}

interface JourneyRecord {
  readonly name: string;
  readonly notes: Readonly<Record<string, unknown>>;
  readonly refusals: readonly { readonly answer: unknown; readonly when: string }[];
  readonly runs: readonly RunRecord[];
  readonly sessions: readonly Readonly<Record<string, unknown>>[];
}

integration("Warm engines with machine access", () => {
  const journeys: JourneyRecord[] = [];
  let rig: Rig | undefined;

  afterEach(async () => {
    await rig?.close();
    rig = undefined;
  }, 120_000);

  afterAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), "opensteer-warm-machine-access-"));
    const artifact = join(directory, "warm-machine-access.json");
    await writeFile(artifact, JSON.stringify(journeys, null, 2) + "\n");
    console.info(`Warm machine access artifact: ${artifact}`);
  });

  it(
    "serves successive Runs from one engine and launch directory, lending its relay only to the Run that holds it",
    { timeout: 180_000 },
    async () => {
      // The full six-second jump expires the four-second dispatch tokens.
      // SSH works only after the real refresh response replaces them.
      const clock = new ManualClock();
      rig = await startRig({ capabilityClock: clock, runCapabilityLifetimeSeconds: 4 });
      const mac = await rig.addMachine("Example Mac", commandsOnly);
      const first = await rig.heldRun("First question");
      const launch = required(first.launch, "the first Run's launch directory");
      expect(await runShim(launch, "ssh", ["example-mac", "echo first"])).toMatchObject({
        code: 0,
        stdout: "first\n",
      });
      await rig.finish(first);

      // Between Runs the socket is still there, and nothing proceeds through it.
      const relaySocket = required(first.relaySocket, "the relay socket");
      const idleAnswer = await relayAnswer(relaySocket, mac.runnerId);
      expect(idleAnswer).toEqual({ message: noRunSentence, ok: false });
      const idleSsh = await runShim(launch, "ssh", ["example-mac", "true"]);
      expect(idleSsh.code).toBe(255);
      expect(idleSsh.stderr).toContain(noRunSentence);
      expect(await rig.sessions()).toHaveLength(1);

      const second = await rig.heldRun("Second question");
      const beforeRefresh = clock.now();
      await rig.advanceCapabilityTime(6_000);
      expect(clock.now() - beforeRefresh).toBe(6_000);
      expect(await runShim(launch, "ssh", ["example-mac", "echo second"])).toMatchObject({
        code: 0,
        stdout: "second\n",
      });
      await rig.finish(second);

      expect(rig.probes).toHaveLength(1);
      expect(second.launch?.launchDirectory).toBe(launch.launchDirectory);
      expect(rig.runs.map((run) => run.engineStart)).toEqual(["cold", "warm"]);
      expect(new Set(rig.runs.map((run) => run.enginePid)).size).toBe(1);
      const sessions = await rig.sessions();
      expect(sessions.map((session) => session.runId)).toEqual([first.runId, second.runId]);
      expect(sessions.every((session) => session.state === "ended")).toBe(true);
      const record = await rig.record("same routes, successive Runs", {
        notes: { capabilityLifetimeMs: 4_000, advancedCapabilityTimeMs: 6_000 },
        refusals: [
          { answer: idleAnswer, when: "relay while idle" },
          { answer: idleSsh.stderr.trim(), when: "ssh while idle" },
        ],
      });

      // Stopping the Runner retires the engine, and its launch directory with it.
      await rig.close();
      rig = undefined;
      await expect(stat(launch.launchDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      journeys.push({ ...record, notes: { ...record.notes, launchDirectoryRemovedAtStop: true } });
    },
  );

  it(
    "starts a new engine and launch directory when a route changes, and keeps it when only policy or connectivity does",
    { timeout: 240_000 },
    async () => {
      rig = await startRig();
      const active = rig;
      const mac = await active.addMachine("Example Mac", commandsOnly);
      const original = await active.run("Routes as enrolled");

      const shared = await mkdtemp(join(tmpdir(), "opensteer-warm-share-"));
      active.temporary.push(shared);
      await active.setPolicy(mac, {
        commands: false,
        forwarding: true,
        reach: "owner",
        shares: [{ mode: "read", path: shared }],
      });
      const policyChanged = await active.run("Policy changed");
      expect(policyChanged.notice).toContain(
        `- example-mac (macOS, online): shares ${shared} (read-only); commands off; port forwarding allowed`,
      );

      await mac.disconnect();
      await active.waitForStatus(mac, "offline");
      const offline = await active.run("Computer offline");
      expect(offline.notice).toContain("- example-mac (macOS, offline");
      await mac.reconnect();
      await active.waitForStatus(mac, "online");
      await active.setPolicy(mac, commandsOnly);

      // A second computer with the same name: the two aliases are allocated together.
      const twin = await active.addMachine("Example Mac", commandsOnly);
      const collided = await active.run("Same name");
      expect(aliasesIn(collided.notice).sort()).toEqual(["example-mac", "example-mac-2"]);

      await active.rename(twin, "Lab Box");
      const renamed = await active.run("Renamed");
      expect(aliasesIn(renamed.notice).sort()).toEqual(["example-mac", "lab-box"]);

      const previousKey = mac.hostPublicKey;
      await mac.rotateHostKey();
      await active.waitForStatus(mac, "online");
      expect(mac.hostPublicKey).not.toBe(previousKey);
      const rotated = await active.heldRun("Host key rotated");
      const rotatedLaunch = required(rotated.launch, "the rotated launch directory");
      const knownHosts = await readFile(join(rotatedLaunch.launchDirectory, "known_hosts"), "utf8");
      expect(knownHosts).toContain(`${mac.runnerId} ${mac.hostPublicKey}`);
      expect(knownHosts).not.toContain(previousKey);
      expect(await runShim(rotatedLaunch, "ssh", ["example-mac", "echo rotated"])).toMatchObject({
        code: 0,
        stdout: "rotated\n",
      });
      await active.finish(rotated);

      await revokeMachine(active.owner, { key: `revoke-${randomUUID()}`, runnerId: twin.runnerId });
      const revoked = await active.run("Revoked");
      expect(aliasesIn(revoked.notice)).toEqual(["example-mac"]);

      await active.setPolicy(mac, { ...commandsOnly, reach: "nobody" });
      const unreachable = await active.run("Nothing reachable");
      expect(unreachable.notice).toContain("No other computers are reachable from this Run.");
      expect(unreachable.launch).toBeUndefined();

      await active.setPolicy(mac, commandsOnly);
      const reachable = await active.run("Reachable again");

      expect(active.runs.map((run) => run.engineStart)).toEqual([
        "cold",
        "warm",
        "warm",
        "cold",
        "cold",
        "cold",
        "cold",
        "cold",
        "cold",
      ]);
      const launchOf = (run: LiveRun) => run.launch?.launchDirectory ?? null;
      expect(launchOf(policyChanged)).toBe(launchOf(original));
      expect(launchOf(offline)).toBe(launchOf(original));
      expect(policyChanged.routeManifest).toBe(original.routeManifest);
      expect(offline.routeManifest).toBe(original.routeManifest);
      const changed = [original, collided, renamed, rotated, revoked, reachable];
      expect(new Set(changed.map(launchOf)).size).toBe(changed.length);
      // Every cold start with computers follows a change of routes; the last
      // one has the routes `revoked` had, but an engine with none came between.
      const manifests = [original, collided, renamed, rotated, revoked].map(
        (run) => run.routeManifest,
      );
      expect(new Set(manifests).size).toBe(manifests.length);
      expect(unreachable.routeManifest).toBeNull();
      expect(reachable.routeManifest).toBe(revoked.routeManifest);
      expect(active.probes).toHaveLength(changed.length);
      // Each engine a route change retired took its launch directory with it.
      for (const run of changed.slice(0, -1)) {
        await expect(stat(required(launchOf(run), "a launch directory"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      journeys.push(
        await active.record("route and policy changes", {
          notes: {
            changes: [
              "enrolled",
              "policy",
              "offline",
              "same-name computer added",
              "renamed",
              "host key rotated",
              "revoked",
              "reach removed",
              "reach restored",
            ],
          },
        }),
      );
    },
  );

  it("refuses a computer the Run's note does not list", { timeout: 240_000 }, async () => {
    rig = await startRig();
    const active = rig;
    const machines: TargetMachine[] = [];
    // Enough computers with long share lists that the note leaves some out.
    for (const index of [1, 2, 3, 4, 5, 6]) {
      machines.push(
        await active.addMachine(`Mac ${index}`, {
          commands: true,
          forwarding: false,
          reach: "owner",
          shares: [1, 2, 3].map((share) => ({
            mode: "read" as const,
            path: `/Users/Shared/opensteer-${"x".repeat(120)}/computer-${index}-share-${share}`,
          })),
        }),
      );
    }
    const live = await active.heldRun("Many computers");
    const launch = required(live.launch, "the launch directory");
    const relaySocket = required(live.relaySocket, "the relay socket");
    const listedAliases = aliasesIn(live.notice);
    const omitted = machines.filter(
      (_machine, index) => !listedAliases.includes(`mac-${index + 1}`),
    );
    expect(omitted.length).toBeGreaterThan(0);
    expect(live.notice).toMatch(/…and \d+ more computers? (is|are) not listed/u);
    const sshConfig = await readFile(join(launch.launchDirectory, "ssh_config"), "utf8");
    for (const machine of omitted) expect(sshConfig).not.toContain(machine.runnerId);

    expect(await runShim(launch, "ssh", ["mac-1", "echo listed"])).toMatchObject({
      code: 0,
      stdout: "listed\n",
    });
    const before = await active.sessions();
    // The helper itself, run the way a model could, aimed past ssh_config at a
    // computer the Host would admit but the note leaves out.
    const omittedComputer = required(omitted[0], "an omitted computer");
    const direct = await runCommand(
      nativeFsHelperBinary,
      ["ssh-proxy", "--relay", relaySocket, omittedComputer.runnerId],
      { environment: launch.environment },
    );
    expect(direct.code).toBe(255);
    expect(direct.stderr).toContain(unlistedSentence);
    const arbitrary = await relayAnswer(relaySocket, createId("runner"));
    expect(arbitrary).toEqual({ message: unlistedSentence, ok: false });
    expect(await active.sessions()).toHaveLength(before.length);
    await active.finish(live);

    // Only shares change, but the note now fits every computer: the routes
    // are different, so a new engine starts, and the computer the first one
    // refused is reachable through it.
    for (const machine of machines) await active.setPolicy(machine, commandsOnly);
    const refitted = await active.heldRun("Fewer shares");
    const refittedLaunch = required(refitted.launch, "the refitted launch directory");
    expect(aliasesIn(refitted.notice)).toEqual(
      machines.map((_machine, index) => `mac-${index + 1}`),
    );
    expect(refittedLaunch.launchDirectory).not.toBe(launch.launchDirectory);
    expect(refitted.routeManifest).not.toBe(live.routeManifest);
    const omittedAlias = `mac-${machines.indexOf(omittedComputer) + 1}`;
    expect(await runShim(refittedLaunch, "ssh", [omittedAlias, "echo admitted"])).toMatchObject({
      code: 0,
      stdout: "admitted\n",
    });
    await active.finish(refitted);
    expect(active.runs.map((run) => run.engineStart)).toEqual(["cold", "cold"]);
    journeys.push(
      await active.record("targets outside the note", {
        notes: {
          listed: listedAliases,
          omitted: omitted.map((machine) => machine.name),
          refittedListed: aliasesIn(refitted.notice),
        },
        refusals: [
          { answer: direct.stderr.trim(), when: "helper aimed at an omitted computer" },
          { answer: arbitrary, when: "relay asked for an arbitrary Runner" },
        ],
      }),
    );
  });

  it(
    "cuts SSH sessions and forwards when a Run ends, and at Stop before its engine stops",
    { timeout: 240_000 },
    async () => {
      // An engine that ignores the interrupt and takes its time to exit, so the
      // Runner waits out its stop grace and a cut that waited for that shows.
      rig = await startRig({ slowStop: true });
      const active = rig;
      await active.addMachine("Example Mac", { ...commandsOnly, forwarding: true });
      const echo = await startEchoServer();
      active.closers.push(() => echo.close());

      // A Run that completes: its engine is kept, and nothing of the Run is.
      const completed = await active.heldRun("Long work");
      const kept = required(completed.launch, "the launch directory");
      const completedWork = await openWork(active, kept, echo.port);
      await active.finish(completed);
      const completedEnds = await completedWork.ended();
      expect(completedEnds.every((exit) => exit.code !== 0)).toBe(true);
      expect(await probeEcho(completedWork.port)).toBe("no-listener");

      const next = await active.heldRun("Next question");
      expect(next.enginePid).toBe(completed.enginePid);
      expect(next.launch?.launchDirectory).toBe(kept.launchDirectory);
      expect(await probeEcho(completedWork.port)).toBe("no-listener");
      expect(await runShim(kept, "ssh", ["example-mac", "echo clean"])).toMatchObject({
        code: 0,
        stdout: "clean\n",
      });
      const completedSessions = (await active.sessions()).filter(
        (session) => session.runId === completed.runId,
      );
      expect(completedSessions).toHaveLength(2);
      expect(completedSessions.every((session) => session.state === "ended")).toBe(true);

      // Stop: the command and the forward end as the engine is told to stop,
      // not when it has.
      const stopWork = await openWork(active, kept, echo.port);
      const stopInterrupt = await active.armInterrupt();
      const stoppedAt = Date.now();
      await active.stack.interruptRun(active.threadId, next.runId);
      const stopEnds = await stopWork.ended();
      const stopCutAt = Date.now();
      const engineAliveAtStopCut = alive(next.enginePid);
      const stopCutMs = stopCutAt - stoppedAt;
      const stopCutAfterInterruptMs = stopCutAt - (await stopInterrupt.seen);
      expect(engineAliveAtStopCut).toBe(true);
      expect(stopCutAfterInterruptMs).toBeLessThan(1_500);
      expect(stopEnds.every((exit) => exit.code !== 0)).toBe(true);
      expect(await probeEcho(stopWork.port)).toBe("no-listener");
      await settled(active.stack, next.runId);
      expect((await runRow(active.stack, next.runId)).status).toBe("interrupted");
      const stopped = (await active.sessions()).filter((session) => session.runId === next.runId);
      expect(stopped.length).toBeGreaterThanOrEqual(2);
      expect(stopped.every((session) => session.state === "ended")).toBe(true);
      journeys.push(
        await active.record("SSH ends with its Run and at Stop", {
          notes: { engineAliveAtStopCut, stopCutAfterInterruptMs, stopCutMs },
        }),
      );
    },
  );

  it(
    "cuts SSH sessions and forwards when the Runner loses a Run's lease, before its engine stops",
    { timeout: 240_000 },
    async () => {
      rig = await startRig({ executionLeaseMs: 12_000, slowStop: true });
      const active = rig;
      await active.addMachine("Example Mac", { ...commandsOnly, forwarding: true });
      const echo = await startEchoServer();
      active.closers.push(() => echo.close());
      const leased = await active.heldRun("Before the network goes");
      const launch = required(leased.launch, "the launch directory");
      const leaseWork = await openWork(active, launch, echo.port);
      const leaseInterrupt = await active.armInterrupt(60_000);
      const blockedAt = Date.now();
      // The Runner loses the Host; its shell relay still reaches it.
      active.stack.network.block();
      const leaseEnds = await leaseWork.ended(60_000);
      const leaseCutAt = Date.now();
      const engineAliveAtLeaseCut = alive(leased.enginePid);
      const leaseCutMs = leaseCutAt - blockedAt;
      const leaseCutAfterInterruptMs = leaseCutAt - (await leaseInterrupt.seen);
      expect(engineAliveAtLeaseCut).toBe(true);
      expect(leaseCutAfterInterruptMs).toBeLessThan(1_500);
      expect(leaseEnds.every((exit) => exit.code !== 0)).toBe(true);
      expect(await probeEcho(leaseWork.port)).toBe("no-listener");
      active.stack.network.unblock();
      await waitFor(
        async () => {
          const attempts = await active.stack.api["run.attempts.list"]({ runId: leased.runId });
          return (
            attempts.ok &&
            attempts.data.attempts.at(-1)?.reason === "recovery" &&
            attempts.data.attempts.at(-1)?.startedAt !== null &&
            (await runRow(active.stack, leased.runId)).status === "running"
          );
        },
        "the same Run's recovery attempt to start",
        90_000,
      );
      const recovering = await active.stack.api["run.attempts.list"]({ runId: leased.runId });
      if (!recovering.ok) throw new Error(recovering.error.message);
      expect(
        recovering.data.attempts.map(({ reason, outcome, engineStart }) => ({
          reason,
          outcome,
          engineStart,
        })),
      ).toEqual([
        { reason: "initial", outcome: "interrupted", engineStart: "cold" },
        { reason: "recovery", outcome: null, engineStart: "cold" },
      ]);
      await active.finish(leased);
      expect((await runRow(active.stack, leased.runId)).status).toBe("completed");
      const sessions = (await active.sessions()).filter(
        (session) => session.runId === leased.runId,
      );
      expect(sessions.length).toBeGreaterThanOrEqual(2);
      expect(sessions.every((session) => session.state === "ended")).toBe(true);
      journeys.push(
        await active.record("SSH ends at lease loss", {
          notes: {
            engineAliveAtLeaseCut,
            leaseCutAfterInterruptMs,
            leaseCutMs,
            lostEnginePid: leased.enginePid,
            recoveredAttempt: recovering.data.attempts.at(-1),
          },
        }),
      );
    },
  );

  it(
    "never carries a connection accepted under one Run into the next",
    { timeout: 180_000 },
    async () => {
      rig = await startRig();
      const active = rig;
      const mac = await active.addMachine("Example Mac", commandsOnly);
      const first = await active.heldRun("First question");
      const launch = required(first.launch, "the launch directory");
      const relaySocket = required(first.relaySocket, "the relay socket");
      const sessionsBefore = (await active.sessions()).length;

      // Accepted under the first Run, its request line not yet finished.
      const partial = await openPartialRequest(relaySocket, mac.runnerId);
      // Its request read under the first Run, its Host handshake in flight.
      active.hop.hold();
      const inFlight = startShim(launch, "ssh", ["example-mac", "echo in-flight"]);
      await waitFor(async () => active.hop.counts().held === 1, "the held handshake");
      await probeTestServer(active.hop.server);

      await active.finish(first);
      await partial.closed;
      const inFlightExit = await inFlight.exited;
      expect(inFlightExit.code).toBe(255);
      expect(inFlightExit.stdout).not.toContain("in-flight");

      const second = await active.heldRun("Second question");
      expect(second.enginePid).toBe(first.enginePid);
      active.hop.release();
      partial.finish();
      expect(active.hop.counts()).toEqual({ closedBeforeRelease: 1, forwarded: 0, held: 1 });
      expect(await active.sessions()).toHaveLength(sessionsBefore);

      expect(await runShim(launch, "ssh", ["example-mac", "echo second"])).toMatchObject({
        code: 0,
        stdout: "second\n",
      });
      const sessions = await active.sessions();
      expect(sessions.slice(sessionsBefore).map((session) => session.runId)).toEqual([
        second.runId,
      ]);
      await active.finish(second);
      journeys.push(
        await active.record("accept, suspend, bind race", {
          notes: { hop: active.hop.counts(), inFlightStderr: inFlightExit.stderr.trim() },
        }),
      );
    },
  );

  it(
    "gives an engine without warm reuse its own launch directory each Run",
    { timeout: 180_000 },
    async () => {
      rig = await startRig({ warm: false });
      const active = rig;
      const mac = await active.addMachine("Example Mac", commandsOnly);
      const first = await active.heldRun("First question");
      const firstLaunch = required(first.launch, "the first launch directory");
      expect(await runShim(firstLaunch, "ssh", ["example-mac", "echo first"])).toMatchObject({
        code: 0,
        stdout: "first\n",
      });
      await active.finish(first);
      await expect(stat(firstLaunch.launchDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      const ended = await relayAnswer(
        required(first.relaySocket, "the relay socket"),
        mac.runnerId,
      );
      expect(ended).toBe("no-socket");

      const second = await active.heldRun("Second question");
      const secondLaunch = required(second.launch, "the second launch directory");
      expect(secondLaunch.launchDirectory).not.toBe(firstLaunch.launchDirectory);
      expect(await runShim(secondLaunch, "ssh", ["example-mac", "echo second"])).toMatchObject({
        code: 0,
        stdout: "second\n",
      });
      await active.finish(second);
      await expect(stat(secondLaunch.launchDirectory)).rejects.toMatchObject({ code: "ENOENT" });

      expect(active.runs.map((run) => run.engineStart)).toEqual(["cold", "cold"]);
      expect(new Set(active.runs.map((run) => run.enginePid)).size).toBe(2);
      expect(active.probes).toHaveLength(2);
      const sessions = await active.sessions();
      expect(sessions.map((session) => session.runId)).toEqual([first.runId, second.runId]);
      journeys.push(
        await active.record("engine without warm reuse", {
          refusals: [{ answer: ended, when: "relay after its Run ended" }],
        }),
      );
    },
  );
});

interface Rig {
  readonly closers: (() => Promise<void>)[];
  readonly hop: HoldingHop;
  readonly owner: MachineAccessOwner;
  readonly probes: readonly Probe[];
  readonly runs: readonly RunRecord[];
  readonly stack: VerticalStack;
  readonly temporary: string[];
  readonly threadId: ThreadId;
  addMachine(name: string, policy: MachineAccessPolicy): Promise<TargetMachine>;
  advanceCapabilityTime(milliseconds: number): Promise<void>;
  close(): Promise<void>;
  /** Lets the held turn finish and waits for its Run to end. */
  finish(run: LiveRun): Promise<void>;
  /** Starts a Run and returns once its engine is mid-turn. */
  heldRun(text: string): Promise<LiveRun>;
  /** Watches for an engine's next interrupt; `seen` is the clock read on seeing it. */
  armInterrupt(timeoutMs?: number): Promise<{ readonly seen: Promise<number> }>;
  record(
    name: string,
    extra?: {
      readonly notes?: Readonly<Record<string, unknown>>;
      readonly refusals?: JourneyRecord["refusals"];
    },
  ): Promise<JourneyRecord>;
  release(): Promise<void>;
  rename(machine: TargetMachine, name: string): Promise<void>;
  run(text: string): Promise<LiveRun>;
  sessions(): Promise<SessionRow[]>;
  setPolicy(machine: TargetMachine, policy: MachineAccessPolicy): Promise<void>;
  waitForStatus(machine: TargetMachine, status: "offline" | "online"): Promise<void>;
}

interface SessionRow {
  readonly endReason: string | null;
  readonly endedAt: Date | null;
  readonly id: string;
  readonly runId: string;
  readonly runnerId: string;
  readonly startedAt: Date;
  readonly state: string;
}

async function startRig(
  options: {
    readonly capabilityClock?: ManualClock;
    readonly executionLeaseMs?: number;
    readonly runCapabilityLifetimeSeconds?: number;
    readonly slowStop?: boolean;
    readonly warm?: boolean;
  } = {},
): Promise<Rig> {
  const closers: (() => Promise<void>)[] = [];
  const temporary: string[] = [];
  const close = async () => {
    for (const closer of closers.splice(0).reverse()) await closer().catch(() => undefined);
    for (const path of temporary.splice(0)) await rm(path, { force: true, recursive: true });
  };
  try {
    const scratch = await mkdtemp(join(tmpdir(), "opensteer-warm-ma-"));
    temporary.push(scratch);
    const captureFile = join(scratch, "capture.jsonl");
    const releaseFile = join(scratch, "release");
    await writeFile(releaseFile, "");
    const preload = join(scratch, "slow-exit.cjs");
    if (options.slowStop) {
      // The engine also ignores SIGTERM and exits seconds after it is told
      // to, as one flushing its state would; the Runner still kills it.
      await writeFile(
        preload,
        [
          'process.on("SIGTERM", () => undefined);',
          "const exit = process.exit.bind(process);",
          "process.exit = (code) => { setTimeout(() => exit(code), 5000); };",
        ].join("\n"),
      );
    }
    const hop = await startHoldingHop();
    closers.push(() => hop.close());
    const probes: Probe[] = [];
    const Driver = options.warm === false ? ColdCodexHarnessDriver : CodexHarnessDriver;
    let refreshed = Promise.withResolvers<void>();
    const stack = await startVerticalStack({
      ...(options.capabilityClock
        ? {
            runCapabilityNow: options.capabilityClock.now,
            credentialRefreshClock: {
              schedule: (callback: () => void, milliseconds: number) => {
                const cancel = options.capabilityClock!.schedule(callback, milliseconds);
                // The next refresh is scheduled only after current credentials are replaced.
                if (milliseconds === options.runCapabilityLifetimeSeconds! * 500)
                  refreshed.resolve();
                return cancel;
              },
            },
          }
        : {}),
      catalogTimeoutMs: 30_000,
      databaseUrl: databaseUrl!,
      ...(options.executionLeaseMs ? { executionLeaseMs: options.executionLeaseMs } : {}),
      harnessInstance: {
        config: {},
        driverKind: "codex",
        sourceId: "openai",
        stateKind: "isolated",
      },
      harnesses: () => {
        const registry = new HarnessRegistry();
        registry.registerDriver(
          new Driver({
            launch: {
              arguments: [
                ...(options.slowStop ? ["--require", preload] : []),
                fakeCodexAppServer,
                "--scenario=long-stream-held",
                `--release-file=${releaseFile}`,
                "--capture-records",
                `--capture=${captureFile}`,
                ...(options.slowStop ? ["--ignore-interrupt"] : []),
              ],
              executable: process.execPath,
            },
          }),
        );
        return registry;
      },
      harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
      machineAccess: {
        helperBinary: nativeFsHelperBinary,
        hostUrl: hop.url,
        validationHook: recordingHook(probes),
      },
      ...(options.runCapabilityLifetimeSeconds
        ? { runCapabilityLifetimeSeconds: options.runCapabilityLifetimeSeconds }
        : {}),
      runTimeoutMs: 60_000,
    });
    closers.push(() => stack.close());
    hop.target(Number(stack.hostOrigin.port));
    const threadId = await stack.createThread({
      modelSelection: selection,
      title: "Reach other computers",
      workspaceId: stack.mainWorkspaceId,
    });
    // Codex reaches the relay socket only with its network on, in Full access.
    await stack.updateThreadAccess(threadId, "full-access");
    const owner: MachineAccessOwner = {
      hostPort: Number(stack.hostOrigin.port),
      origin: stack.hostOrigin.origin,
      ownerHeaders: { cookie: stack.sessionCookie, origin: stack.hostOrigin.origin },
    };
    const revisions = new Map<RunnerId, number>();
    const runs: RunRecord[] = [];
    const live = new Map<RunId, LiveRun>();
    const sessions = async (): Promise<SessionRow[]> =>
      stack.host.store.database
        .selectFrom("machineAccessSessions")
        .select(["endReason", "endedAt", "id", "runId", "runnerId", "startedAt", "state"])
        .orderBy("startedAt", "asc")
        .orderBy("id", "asc")
        .execute();
    const setPolicy = async (machine: TargetMachine, policy: MachineAccessPolicy) => {
      const expectedRevision = revisions.get(machine.runnerId) ?? 1;
      await updateAccessPolicy(owner, {
        expectedRevision,
        key: `policy-${randomUUID()}`,
        policy,
        runnerId: machine.runnerId,
      });
      revisions.set(machine.runnerId, expectedRevision + 1);
    };
    const heldRun = async (text: string): Promise<LiveRun> => {
      await rm(releaseFile, { force: true });
      const turnsBefore = turnsOf(await captured(captureFile)).length;
      const queued = await stack.queueMessage({ text, threadId });
      const runId = required(queued.runId, "a Run for the message");
      await waitFor(
        async () => turnsOf(await captured(captureFile)).length > turnsBefore,
        "the engine's turn",
        60_000,
      ).catch(async (error: unknown) => {
        const run = await stack.host.store.database
          .selectFrom("runs")
          .select(["status", "failure"])
          .where("id", "=", runId)
          .executeTakeFirst();
        throw new Error(`${String(error)}\n${JSON.stringify(run)}`);
      });
      const turn = required(turnsOf(await captured(captureFile)).at(-1), "the turn");
      const probe = turn.notice.includes(sshNoticeHeading) ? probes.at(-1) : undefined;
      const started: LiveRun = {
        enginePid: turn.pid,
        launch: probe?.launch,
        notice: turn.notice,
        relaySocket: probe?.relaySocket,
        routeManifest: probe ? await routeManifest(probe.launch.launchDirectory) : null,
        runId,
      };
      live.set(runId, started);
      return started;
    };
    const finish = async (run: LiveRun) => {
      await writeFile(releaseFile, "");
      await settled(stack, run.runId);
      runs.push({
        engineStart: await engineStart(stack, run.runId),
        enginePid: run.enginePid,
        launchDirectory: run.launch?.launchDirectory ?? null,
        routeManifest: run.routeManifest,
        runId: run.runId,
        status: (await runRow(stack, run.runId)).status,
      });
    };
    return {
      advanceCapabilityTime: async (milliseconds) => {
        if (!options.capabilityClock) throw new Error("This rig has no capability clock");
        refreshed = Promise.withResolvers<void>();
        options.capabilityClock.advanceBy(milliseconds);
        await refreshed.promise;
      },
      addMachine: async (name, policy) => {
        const machine = await connectTargetMachine(owner, {
          fullDiskAccess: false,
          name,
          token: await enrollmentToken(owner, {
            allowedModules: ["shell"],
            idempotencyKey: `target-${randomUUID()}`,
            name,
          }),
        });
        closers.push(() => machine.close());
        await setPolicy(machine, policy);
        return machine;
      },
      close,
      closers,
      finish,
      heldRun,
      hop,
      armInterrupt: async (timeoutMs = 30_000) => {
        const interrupts = async () =>
          (await captured(captureFile)).filter((line) => line.rootInterrupted !== undefined).length;
        const before = await interrupts();
        const seen = (async () => {
          let seenAt = 0;
          await waitFor(
            async () => {
              if ((await interrupts()) <= before) return false;
              seenAt = Date.now();
              return true;
            },
            "the engine to be told to interrupt",
            timeoutMs,
            10,
          );
          return seenAt;
        })();
        return { seen };
      },
      owner,
      probes,
      record: async (name, extra = {}) => {
        // Runs ended by Stop or lease loss are recorded here, not by `finish`.
        for (const [runId, run] of live) {
          if (runs.some((recorded) => recorded.runId === runId)) continue;
          runs.push({
            engineStart: await engineStart(stack, runId),
            enginePid: run.enginePid,
            launchDirectory: run.launch?.launchDirectory ?? null,
            routeManifest: run.routeManifest,
            runId,
            status: (await runRow(stack, runId)).status,
          });
        }
        return {
          name,
          notes: extra.notes ?? {},
          refusals: extra.refusals ?? [],
          runs: [...runs],
          sessions: (await sessions()).map((session) => ({
            endReason: session.endReason,
            endedAt: session.endedAt?.toISOString() ?? null,
            id: session.id,
            runId: session.runId,
            runnerId: session.runnerId,
            startedAt: session.startedAt.toISOString(),
            state: session.state,
          })),
        };
      },
      release: () => writeFile(releaseFile, ""),
      rename: async (machine, name) => {
        const renamed = await testRpcData(
          owner.origin,
          "commands.dispatch",
          {
            idempotencyKey: `rename-${randomUUID()}`,
            machineId: machine.runnerId,
            name,
            type: "machine.rename",
          },
          { headers: owner.ownerHeaders },
        );
        if (renamed.type !== "machine.rename") throw new Error("Rename command mismatch.");
      },
      run: async (text) => {
        const started = await heldRun(text);
        await finish(started);
        return started;
      },
      runs,
      sessions,
      setPolicy,
      stack,
      temporary,
      threadId,
      waitForStatus: (machine, status) =>
        waitFor(async () => {
          const listed = await testRpcData(
            owner.origin,
            "machines.list",
            {},
            { headers: owner.ownerHeaders },
          );
          return listed.machines.some(
            (entry) => entry.id === machine.runnerId && entry.status === status,
          );
        }, `${machine.name} ${status}`),
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** The Codex driver run as an engine without warm reuse: one engine per Run. */
class ColdCodexHarnessDriver extends CodexHarnessDriver {
  override async create(
    context: Parameters<CodexHarnessDriver["create"]>[0],
  ): Promise<HarnessAdapter> {
    const adapter = await super.create(context);
    const capabilities = { ...adapter.capabilities, warmReuse: false };
    return new Proxy(adapter, {
      get: (target, property) => {
        if (property === "capabilities") return capabilities;
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]): unknown => Reflect.apply(value, target, args);
      },
    });
  }
}

/** Records each launch directory the Runner proves, then proves it the production way. */
function recordingHook(probes: Probe[]): MachineAccessValidationHook {
  return {
    execute: async (command) => {
      if (command.arguments[0] === "ssh-proxy") {
        const relaySocket = command.arguments[2] ?? "";
        probes.push({
          // What the harness's commands run with, without the engine's
          // containment marker: these commands are the test's, not the engine's.
          launch: {
            environment: {
              HOME: command.environment.HOME ?? tmpdir(),
              PATH: command.environment.PATH ?? "",
            },
            launchDirectory: dirname(relaySocket),
          },
          relaySocket,
        });
      }
      return harnessLaunchValidationHook.execute(command);
    },
  };
}

/** A long command and a port forward, both open and carrying bytes. */
async function openWork(rig: Rig, launch: Launch, echoPort: number) {
  const known = new Set((await rig.sessions()).map((session) => session.id));
  const port = await freePort();
  const command = startShim(launch, "ssh", ["example-mac", "sleep 60"]);
  const forward = startShim(launch, "ssh", [
    "-N",
    "-L",
    `${port}:127.0.0.1:${echoPort}`,
    "example-mac",
  ]);
  let commandExit: unknown;
  void command.exited.then((exit) => (commandExit = exit));
  await waitFor(async () => (await probeEcho(port)) === "ping-pong", "the forward to carry bytes");
  await waitFor(
    async () =>
      (await rig.sessions()).filter(
        (session) => !known.has(session.id) && session.state === "active",
      ).length === 2,
    "both sessions active",
  ).catch(async (error: unknown) => {
    throw new Error(
      `${String(error)}\n${JSON.stringify({ commandExit, sessions: await rig.sessions() })}`,
    );
  });
  return {
    ended: (timeoutMs = 15_000) => exitedWithin([command, forward], timeoutMs),
    port,
  };
}

async function exitedWithin(shims: readonly RunningShim[], timeoutMs: number) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.all(shims.map((shim) => shim.exited)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("An SSH process outlived its Run")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

interface Turn {
  readonly notice: string;
  readonly pid: number;
}

interface Captured {
  readonly fakeTurn?: { readonly pid: number; readonly threadId: string };
  readonly method?: string;
  readonly rootInterrupted?: string | null;
  readonly params?: {
    readonly threadId?: string;
    readonly additionalContext?: { readonly opensteer_computers?: { readonly value?: string } };
  };
}

/** Each turn the engines started, with the computers note it was given. */
function turnsOf(capture: readonly Captured[]): Turn[] {
  const runThreads = new Set(
    capture.flatMap((line) => (line.fakeTurn ? [line.fakeTurn.threadId] : [])),
  );
  const notices = capture.flatMap((line) =>
    line.method === "turn/start" && line.params?.threadId && runThreads.has(line.params.threadId)
      ? [line.params?.additionalContext?.opensteer_computers?.value ?? ""]
      : [],
  );
  const pids = capture.flatMap((line) => (line.fakeTurn ? [line.fakeTurn.pid] : []));
  return pids.map((pid, index) => ({ notice: notices[index] ?? "", pid }));
}

async function captured(file: string): Promise<Captured[]> {
  return (await readCodexCaptures(file)) as Captured[];
}

function aliasesIn(notice: string): string[] {
  return [...notice.matchAll(/^- ([a-z0-9-]+) \(/gmu)].map((match) => match[1] ?? "");
}

/**
 * The launch directory's routes as ssh_config and known_hosts state them —
 * alias, Runner and pinned key — hashed so the artifact can compare them.
 */
async function routeManifest(launchDirectory: string): Promise<string> {
  const config = await readFile(join(launchDirectory, "ssh_config"), "utf8");
  const knownHosts = await readFile(join(launchDirectory, "known_hosts"), "utf8");
  const keys = new Map(
    knownHosts
      .split("\n")
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf(" ")), line.slice(line.indexOf(" ") + 1)]),
  );
  const routes = [...config.matchAll(/^Host (\S+)\n {2}HostName (\S+)$/gmu)]
    .map((match) => [match[1] ?? "", match[2] ?? "", keys.get(match[2] ?? "") ?? ""].join(" "))
    .sort();
  return createHash("sha256").update(routes.join("\n")).digest("hex").slice(0, 16);
}

/** The relay's answer to one request line: its response, a close, or no socket at all. */
function relayAnswer(socketPath: string, target: string): Promise<unknown> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let output = "";
    let connected = false;
    socket.once("connect", () => {
      connected = true;
      socket.write(`${JSON.stringify({ target })}\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const newline = output.indexOf("\n");
      if (newline === -1) return;
      socket.destroy();
      resolve(JSON.parse(output.slice(0, newline)) as unknown);
    });
    socket.once("error", () => resolve(connected ? "closed" : "no-socket"));
    socket.once("close", () => resolve("closed"));
  });
}

/** A relay connection that has written part of its request line and waits. */
async function openPartialRequest(socketPath: string, target: string) {
  const socket = createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  socket.on("error", () => undefined);
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  socket.write(`{"target":"${target}"`);
  return {
    closed,
    /** Writes the rest of the line; a connection the relay ended takes nothing. */
    finish: () => {
      if (!socket.destroyed) socket.write("}\n");
    },
  };
}

async function startEchoServer(): Promise<{ readonly port: number; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.pipe(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("echo server has no port");
  return {
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    port: address.port,
  };
}

/** What a connection through a forwarded port finds. */
function probeEcho(port: number): Promise<"no-listener" | "channel-refused" | "ping-pong"> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let output = "";
    let settledProbe = false;
    let connected = false;
    const settle = (value: "no-listener" | "channel-refused" | "ping-pong") => {
      if (settledProbe) return;
      settledProbe = true;
      socket.destroy();
      resolve(value);
    };
    socket.once("error", () => settle(connected ? "channel-refused" : "no-listener"));
    socket.once("connect", () => {
      connected = true;
      socket.write("ping");
    });
    socket.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output === "ping") settle("ping-pong");
    });
    socket.once("close", () => settle(connected ? "channel-refused" : "no-listener"));
    setTimeout(() => settle("channel-refused"), 3_000).unref();
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function required<Value>(value: Value | null | undefined, label: string): Value {
  if (value === undefined || value === null) throw new Error(`Expected ${label}`);
  return value;
}

async function settled(stack: VerticalStack, runId: RunId, timeoutMs = 30_000) {
  await waitFor(
    async () =>
      ["completed", "failed", "interrupted"].includes((await runRow(stack, runId)).status),
    "the Run to end",
    timeoutMs,
  );
}

async function waitFor(
  check: () => Promise<boolean>,
  label: string,
  timeoutMs = 30_000,
  intervalMs = 50,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** How the Run's engine started, as its execution details report it. */
async function engineStart(stack: VerticalStack, runId: RunId) {
  const listed = await stack.api["run.attempts.list"]({ runId });
  if (!listed.ok) throw new Error(listed.error.message);
  return listed.data.attempts.at(-1)?.engineStart ?? null;
}

function runRow(stack: VerticalStack, runId: RunId) {
  return stack.host.store.database
    .selectFrom("runs")
    .select("status")
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
}
