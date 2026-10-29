/**
 * Opt-in Agent Phone soak, the release qualification run through the device
 * suite's real setup, Host and gateway. A fresh agent Run uses the phone once
 * per cycle while the phone is rebooted and its network route cut on a seeded
 * schedule.
 *
 * Failure modes: silent or duplicate actions; a leaked display hold; a dead
 * Run blocking later Runs; reboot or network recovery requiring human input;
 * missed cycle deadlines being counted as uptime; and losing evidence on
 * termination. Never retry an act, even when its answer is lost. Retain all
 * fixture receipts so a late duplicate of an earlier token still fails the
 * final gate.
 *
 * The schedule comes from OPENSTEER_AGENT_PHONE_SOAK_HOURS (24),
 * OPENSTEER_AGENT_PHONE_SOAK_CYCLE_MINUTES (5),
 * OPENSTEER_AGENT_PHONE_SOAK_REBOOT_HOURS (2) and OPENSTEER_AGENT_PHONE_SOAK_SEED;
 * the run has hours × 60 / cycle minutes cycles.
 */
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerId, WorkspaceId } from "@opensteer/core";
import type { AndroidPhoneAction } from "@opensteer/protocol";
import { delay } from "@opensteer/shared/delay";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { expect, it } from "vitest";
import { z } from "zod";
import {
  createMachineAccessDatabase,
  freePort,
  type CallerMachine,
} from "../runtime/machine-access.test-support.js";
import { testRpcData } from "../server/test-host-api-request.js";
import {
  Redaction,
  acquireAndroidDevice,
  buildE2eAgentPhone,
  clearReceipts,
  connectAgentComputer,
  createTestCertificateAuthority,
  deviceFacts,
  elementIndex,
  eventually,
  fixturePackage,
  installFixture,
  phoneRowOf,
  readObservation,
  readReceipts,
  rebootDevice,
  resetPhone,
  resultText,
  runAgentPhoneSetup,
  sha256Hex,
  startAgentPhoneHost,
  startPhoneAgent,
  startTlsFrontDoor,
  waitForPhoneOnline,
  writeDeviceTestManifest,
  type AgentPhoneHost,
  type AndroidDevice,
  type DeviceFacts,
  type PhoneAgent,
  type PhoneObservationText,
  type Receipt,
  type ToolResult,
} from "./agent-phone-device.test-support.js";

const hourMs = 3_600_000;
const recoveryBudgetMs = 120_000;
const ConfigSchema = z.object({
  api: z.coerce.number().int().min(30).max(100),
  hours: z.coerce.number().positive().max(504),
  cycleMinutes: z.coerce.number().min(0.01).max(1_440),
  rebootHours: z.coerce.number().positive().max(504),
  seed: z.string().min(1),
});

interface Cycle {
  index: number;
  token: string;
  scheduledAt: string;
  startedAt: string;
  endedAt: string | null;
  outcome: "running" | "passed" | "failed";
  observeMs: number | null;
  actMs: number | null;
  onlineAfterRebootMs: number | null;
  failure: string | null;
  receiptBaselineId: number | null;
  receiptIds: { setText: number[]; text: number[]; submit: number[]; button: number[] } | null;
  editorValue: string | null;
  screenshot: string | null;
  screenshotFailure: string | null;
}

interface Disruption {
  scheduledAt: string;
  startedAt: string;
  endedAt: string | null;
  outcome: "running" | "passed" | "failed";
  failure: string | null;
  onlineMs: number | null;
}

// Hashing a string seed avoids JS's numeric coercion accepting invalid seeds.
function soakRandom(seed: string): () => number {
  let state = Number.parseInt(sha256Hex(seed).slice(0, 8), 16);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function latencySummary(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number) =>
    sorted.length === 0 ? null : sorted[Math.ceil(sorted.length * fraction) - 1]!;
  return { samples: sorted.length, p50: percentile(0.5), p95: percentile(0.95) };
}

it("Agent Phone remains available and never duplicates fixture effects during a soak", async () => {
  // Parsing and all resource acquisition stay inside the test: `vitest list`
  // must never build an APK, connect to adb or start a Host.
  const config = ConfigSchema.parse({
    api: process.env.OPENSTEER_AGENT_PHONE_API ?? "36",
    hours: process.env.OPENSTEER_AGENT_PHONE_SOAK_HOURS ?? "24",
    cycleMinutes: process.env.OPENSTEER_AGENT_PHONE_SOAK_CYCLE_MINUTES ?? "5",
    rebootHours: process.env.OPENSTEER_AGENT_PHONE_SOAK_REBOOT_HOURS ?? "2",
    seed: process.env.OPENSTEER_AGENT_PHONE_SOAK_SEED ?? "agent-phone-soak-v1",
  });
  const directory =
    process.env.OPENSTEER_AGENT_PHONE_E2E_ARTIFACT_DIR ??
    (await mkdtemp(join(tmpdir(), "opensteer-agent-phone-soak-")));
  await mkdir(join(directory, "screenshots"), { recursive: true });
  process.stdout.write(`Agent Phone soak artifact: ${directory}\n`);
  const scratch = await mkdtemp(join(tmpdir(), "opensteer-agent-phone-soak-scratch-"));
  const redaction = new Redaction();
  const cycles: Cycle[] = [];
  const reboots: (Disruption & { bootedMs: number | null })[] = [];
  const cuts: (Disruption & { durationMs: number; restoredAt: string | null })[] = [];
  const duplicates = new Map<string, { token: string; kind: string; ids: number[] }>();
  const receiptViolations = new Map<
    string,
    { token: string; kind: string; expected: string[]; actual: Receipt[] }
  >();
  let retainedReceipts: readonly Receipt[] = [];
  const cleanup: (() => Promise<void>)[] = [];
  const cleanupFailures: string[] = [];
  const runKey = randomUUID().slice(0, 8);
  const random = soakRandom(config.seed);
  const cycleMs = config.cycleMinutes * 60_000;
  const durationMs = config.hours * hourMs;
  let device: AndroidDevice;
  let host: AgentPhoneHost;
  let facts: DeviceFacts | null = null;
  let apkSha256: string | null = null;
  let fixtureSha256: string | null = null;
  let publicOrigin: string | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let completed = false;
  let fatalFailure: string | null = null;
  let finalReceiptAudit = "not-run";

  const bounded = <Value>(label: string, work: Promise<Value>, ms = 30_000) =>
    withTimeout(work, ms, { timeoutError: () => new Error(`${label} exceeded ${ms} ms`) });
  const availability = () => {
    const passed = cycles.filter((cycle) => cycle.outcome === "passed").length;
    return {
      definition: "successful scheduled cycles / all scheduled cycles (missed slots fail)",
      passed,
      total: cycles.length,
      ratio: cycles.length ? passed / cycles.length : 0,
      minimum: 0.99,
    };
  };
  async function flush(): Promise<void> {
    const artifact = {
      config: {
        ...config,
        recoveryBudgetMs,
        cutSeconds: [10, 90],
        cutIntervalCycles: [0.5, 3],
        disruptionScheduling: "due disruptions run before the next scheduled cycle",
        latencyMeasurement:
          "observe/act are cumulative gateway time per cycle, including failed calls",
        receiptMeasurement:
          "set_text counts ACTION_SET_TEXT attempts; text retains every TextWatcher callback. Each successful cycle requires clear then token, one button tap, one token submit and the observed editor value.",
      },
      device: facts,
      apkSha256,
      fixtureSha256,
      networkPath: { kind: "tls-front-door", publicOrigin },
      startedAt,
      endedAt,
      completed,
      outcome: fatalFailure
        ? "failed"
        : completed
          ? availability().ratio >= 0.99 &&
            duplicates.size === 0 &&
            receiptViolations.size === 0 &&
            cleanupFailures.length === 0
            ? "passed"
            : "failed"
          : "running",
      fatalFailure,
      cleanupFailures,
      finalReceiptAudit,
      cycles,
      reboots,
      cuts,
      duplicateReceipts: [...duplicates.values()],
      receiptViolations: [...receiptViolations.values()],
      receipts: retainedReceipts,
      availability: availability(),
      latenciesMs: {
        observe: latencySummary(cycles.flatMap((c) => (c.observeMs === null ? [] : [c.observeMs]))),
        act: latencySummary(cycles.flatMap((c) => (c.actMs === null ? [] : [c.actMs]))),
        onlineAfterReboot: latencySummary(
          reboots.flatMap((r) => (r.onlineMs === null ? [] : [r.onlineMs])),
        ),
        onlineAfterCut: latencySummary(
          cuts.flatMap((c) => (c.onlineMs === null ? [] : [c.onlineMs])),
        ),
      },
    };
    const bytes = `${JSON.stringify(artifact, null, 2)}\n`;
    // A killed writer leaves the previous complete JSON in place.
    await writeFile(join(directory, "soak.json.tmp"), bytes);
    await rename(join(directory, "soak.json.tmp"), join(directory, "soak.json"));
  }

  function auditReceipts(receipts: readonly Receipt[]): void {
    retainedReceipts = receipts;
    for (const [index, cycle] of cycles.entries()) {
      for (const kind of ["set_text", "submit"]) {
        const ids = receipts
          .filter(
            (receipt) =>
              receipt.kind === kind &&
              receipt.detail === (kind === "set_text" ? cycle.token : `0:${cycle.token}`),
          )
          .map((receipt) => receipt.id);
        if (ids.length > 1)
          duplicates.set(`${cycle.token}:${kind}`, { token: cycle.token, kind, ids });
      }
      if (cycle.receiptBaselineId !== null) {
        const nextBaseline = cycles
          .slice(index + 1)
          .find((next) => next.receiptBaselineId !== null)?.receiptBaselineId;
        const effects = receipts.filter(
          (receipt) =>
            receipt.id > cycle.receiptBaselineId! &&
            (nextBaseline == null || receipt.id <= nextBaseline),
        );
        for (const [kind, expected] of [
          ["set_text", ["", cycle.token]],
          ["submit", [`0:${cycle.token}`]],
          ["button_tap", [""]],
        ] as const) {
          const actual = effects.filter((receipt) => receipt.kind === kind);
          if (actual.length > expected.length)
            duplicates.set(`${cycle.token}:${kind}`, {
              token: cycle.token,
              kind,
              ids: actual.map((receipt) => receipt.id),
            });
          // A failed slot can have a missing suffix; extra or wrong effects
          // still fail the global gate, including writes arriving much later.
          if (
            (cycle.outcome === "passed" && actual.length !== expected.length) ||
            actual.some((receipt, position) => receipt.detail !== expected[position])
          )
            receiptViolations.set(`${cycle.token}:${kind}`, {
              token: cycle.token,
              kind,
              expected: [...expected],
              actual,
            });
        }
      }
    }
    const firstBaseline = cycles.find(
      (cycle) => cycle.receiptBaselineId !== null,
    )?.receiptBaselineId;
    const unassigned = receipts.filter(
      (receipt) =>
        ["set_text", "submit", "button_tap"].includes(receipt.kind) &&
        (firstBaseline == null || receipt.id <= firstBaseline),
    );
    if (unassigned.length)
      receiptViolations.set("unassigned", {
        token: "unassigned",
        kind: "outside cycle",
        expected: [],
        actual: unassigned,
      });
    expect(
      [...receiptViolations.values()],
      "fixture action history must match scheduled cycles",
    ).toEqual([]);
    expect([...duplicates.values()], "fixture actions must never be duplicated").toEqual([]);
  }

  await flush();
  try {
    const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
    if (!databaseUrl)
      throw new Error("Run through pnpm test:agent-phone:soak to provision PostgreSQL.");
    const authority = await createTestCertificateAuthority(scratch);
    const build = await buildE2eAgentPhone({ authority, log: join(directory, "build.log") });
    apkSha256 = build.manifest.apkSha256;
    fixtureSha256 = build.fixtureSha256;
    const isolated = await createMachineAccessDatabase(databaseUrl);
    cleanup.push(() => isolated.drop());
    const publicPort = await freePort();
    host = await startAgentPhoneHost(isolated.url, { publicPort, log: () => undefined });
    cleanup.push(() => host.close());
    redaction.add(...Object.values(host.ownerHeaders));
    publicOrigin = host.publicOrigin;
    const frontDoor = await startTlsFrontDoor({
      authority,
      hostPort: host.hostPort,
      port: publicPort,
    });
    cleanup.push(() => frontDoor.close());
    device = await acquireAndroidDevice({
      api: config.api,
      emulatorLog: join(directory, "emulator.log"),
    });
    cleanup.push(() => device.close());
    facts = await deviceFacts(device);
    await flush();
    await resetPhone(device);
    await installFixture(device);
    const setup = await runAgentPhoneSetup({
      artifact: build.artifact,
      device,
      host,
      redaction,
      runnerName: "Soak phone",
      timeoutMs: 600_000,
    });
    if (setup.outcome !== "done") throw new Error(`Setup stopped: ${JSON.stringify(setup)}`);
    const runnerId = setup.runnerId;
    const owner = { headers: host.ownerHeaders };
    const waitOnline = () => waitForPhoneOnline(device, host, runnerId, recoveryBudgetMs);

    await waitOnline();
    await clearReceipts(device);
    const bootstrap = await testRpcData(host.origin, "bootstrap.get", {}, owner);
    if (!bootstrap.homeWorkspace) throw new Error("No Main Workspace for the soak agent.");
    const workspaceId = bootstrap.homeWorkspace.id;
    startedAt = new Date().toISOString();
    const start = Date.now();
    const deadline = start + durationMs;
    let nextReboot = start + config.rebootHours * hourMs;
    const cutInterval = () => cycleMs * (0.5 + random() * 2.5);
    let nextCut = start + cutInterval();
    let index = 0;

    while (start + index * cycleMs < deadline) {
      const scheduled = start + index * cycleMs;
      if (Date.now() < scheduled) await delay(scheduled - Date.now());
      const cycle: Cycle = {
        index: index + 1,
        token: `s${runKey}-${(index + 1).toString(36)}`,
        scheduledAt: new Date(scheduled).toISOString(),
        startedAt: new Date().toISOString(),
        endedAt: null,
        outcome: "running",
        observeMs: null,
        actMs: null,
        onlineAfterRebootMs: null,
        failure: null,
        receiptBaselineId: null,
        receiptIds: null,
        editorValue: null,
        screenshot: null,
        screenshotFailure: null,
      };
      cycles.push(cycle);
      await flush();
      const failures: string[] = [];
      // Never hide missed samples by sliding the next cycle's deadline.
      if (Date.now() >= scheduled + cycleMs || Date.now() >= deadline) {
        failures.push(
          "Missed scheduled cycle: an earlier operation exceeded the sampling interval.",
        );
      } else {
        if (Date.now() >= nextReboot) {
          const record: Disruption & { bootedMs: number | null } = {
            scheduledAt: new Date(nextReboot).toISOString(),
            startedAt: new Date().toISOString(),
            endedAt: null,
            outcome: "running",
            failure: null,
            onlineMs: null,
            bootedMs: null,
          };
          reboots.push(record);
          await flush();
          const rebootStart = Date.now();
          try {
            record.bootedMs = (await rebootDevice(device)).bootedMs;
            // No unlock, tap or activity start between reboot and online.
            await waitOnline();
            record.onlineMs = Date.now() - rebootStart;
            cycle.onlineAfterRebootMs = record.onlineMs;
            expect(record.onlineMs - record.bootedMs).toBeLessThanOrEqual(recoveryBudgetMs);
            record.outcome = "passed";
          } catch (error) {
            record.failure = redaction.error(error);
            record.outcome = "failed";
            failures.push(`Reboot: ${record.failure}`);
          } finally {
            record.endedAt = new Date().toISOString();
            do nextReboot += config.rebootHours * hourMs;
            while (nextReboot <= Date.now());
            await flush();
          }
        }
        if (Date.now() >= nextCut) {
          const cut: Disruption & { durationMs: number; restoredAt: string | null } = {
            scheduledAt: new Date(nextCut).toISOString(),
            startedAt: new Date().toISOString(),
            endedAt: null,
            outcome: "running",
            failure: null,
            onlineMs: null,
            durationMs: (10 + Math.floor(random() * 81)) * 1_000,
            restoredAt: null,
          };
          cuts.push(cut);
          await flush();
          try {
            try {
              await frontDoor.cut();
              await delay(cut.durationMs);
            } finally {
              await frontDoor.restore();
              cut.restoredAt = new Date().toISOString();
              await flush();
            }
            const restored = Date.now();
            await waitOnline();
            cut.onlineMs = Date.now() - restored;
            cut.outcome = "passed";
          } catch (error) {
            cut.failure = redaction.error(error);
            cut.outcome = "failed";
            failures.push(`Network cut: ${cut.failure}`);
          } finally {
            cut.endedAt = new Date().toISOString();
            nextCut = Date.now() + cutInterval();
            await flush();
          }
        }
        try {
          await exerciseCycle(cycle, runnerId, workspaceId);
        } catch (error) {
          failures.push(redaction.error(error));
        }
        try {
          const screenshot = `screenshots/${String(cycle.index).padStart(5, "0")}.png`;
          await writeFile(join(directory, screenshot), await device.screencap());
          cycle.screenshot = screenshot;
        } catch (error) {
          cycle.screenshotFailure = redaction.error(error);
        }
      }
      // Recovery and actions must finish within this sample's slot; a late
      // success is downtime even when the next missed slots fail separately.
      if (Date.now() >= Math.min(scheduled + cycleMs, deadline)) {
        failures.push("Scheduled cycle did not complete before its sampling deadline.");
      }
      cycle.failure = failures.length ? failures.join("\n") : null;
      cycle.outcome = failures.length ? "failed" : "passed";
      cycle.endedAt = new Date().toISOString();
      await flush();
      index += 1;
    }
    if (Date.now() < deadline) await delay(deadline - Date.now());
    try {
      auditReceipts(await readReceipts(device));
      finalReceiptAudit = "passed";
    } catch (error) {
      finalReceiptAudit = "failed";
      throw error;
    }
    completed = true;

    async function exerciseCycle(
      cycle: Cycle,
      phoneId: RunnerId,
      main: WorkspaceId,
    ): Promise<void> {
      let caller: CallerMachine | undefined;
      let agent: PhoneAgent | undefined;
      let release: string | undefined;
      const errors: string[] = [];
      try {
        // Each sample gets a fresh Run/token and caller. A failed sample cannot
        // leave a half-dispatched Run on the next sample's execution socket.
        caller = await bounded(
          "connect caller",
          connectAgentComputer(host, { key: `soak-caller-${runKey}-${cycle.index}`, redaction }),
          60_000,
        );
        agent = await bounded(
          "dispatch soak Run and connect its MCP gateway",
          startPhoneAgent(host, caller, {
            key: `soak-run-${runKey}-${cycle.index}`,
            redaction,
            title: `Soak cycle ${cycle.index}`,
            workspaceId: main,
          }),
        );
        const { gateway } = agent;
        async function call(toolRef: string, args?: Record<string, unknown>): Promise<ToolResult> {
          const result = await gateway.call("integration_call", {
            toolRef,
            ...(args ? { arguments: args } : {}),
          });
          if (result.isError) throw new Error(resultText(result));
          return result;
        }
        const refs = phoneRowOf(
          await gateway.call("integration_search", { query: "Android phone" }),
          phoneId,
        ).toolRefs;
        if (!refs?.act) throw new Error("Soak phone has no read-write tool refs.");
        release = refs.release;
        const { act: actRef, observe: observeRef } = refs;
        async function observe() {
          const began = performance.now();
          try {
            return readObservation(resultText(await call(observeRef)));
          } finally {
            cycle.observeMs = (cycle.observeMs ?? 0) + performance.now() - began;
          }
        }
        async function act(observation: PhoneObservationText, action: AndroidPhoneAction) {
          const began = performance.now();
          try {
            return readObservation(
              resultText(
                await call(actRef, {
                  observationId: observation.observationId,
                  actions: [action],
                }),
              ),
            );
          } finally {
            cycle.actMs = (cycle.actMs ?? 0) + performance.now() - began;
          }
        }
        let observation = await observe();
        if (observation.screen === "off" || observation.locked)
          observation = await act(observation, { type: "wake" });
        expect(observation.secureLock && observation.locked).toBe(false);
        observation = await act(observation, { type: "navigate", to: "home" });
        observation = await act(observation, { type: "launch", packageName: fixturePackage });
        observation = await eventually(
          "fixture button to draw",
          async () => {
            if (
              observation.tree.some(
                (line) => line.role === "button" && line.label === "Record a tap",
              )
            )
              return observation;
            observation = await observe();
            return undefined;
          },
          15_000,
        );
        const before = await readReceipts(device);
        cycle.receiptBaselineId = before.at(-1)?.id ?? 0;
        const buttonBefore = before.filter((receipt) => receipt.kind === "button_tap").length;
        observation = await act(observation, {
          type: "tap",
          count: 1,
          target: { index: elementIndex(observation, "button", "Record a tap") },
        });
        // Home and launch retain this Activity's editor. Clear through the
        // agent so each sample submits only its own token, using the fresh view.
        observation = await act(observation, {
          type: "clear",
          target: { index: elementIndex(observation, "edittext") },
        });
        observation = await act(observation, {
          type: "type",
          text: cycle.token,
          submit: true,
          target: { index: elementIndex(observation, "edittext") },
        });
        const receipts = await readReceipts(device);
        const effects = receipts.filter((receipt) => receipt.id > cycle.receiptBaselineId!);
        cycle.receiptIds = {
          button: effects.filter((r) => r.kind === "button_tap").map((r) => r.id),
          setText: effects.filter((r) => r.kind === "set_text").map((r) => r.id),
          text: effects
            .filter((r) => r.kind === "text" && r.detail === cycle.token)
            .map((r) => r.id),
          submit: effects.filter((r) => r.kind === "submit").map((r) => r.id),
        };
        cycle.editorValue =
          observation.tree.find((line) => line.role === "edittext")?.label ?? null;
        auditReceipts(receipts);
        const buttonAfter = receipts.filter((receipt) => receipt.kind === "button_tap").length;
        if (buttonAfter > buttonBefore + 1)
          duplicates.set(`${cycle.token}:button_tap`, {
            token: cycle.token,
            kind: "button_tap",
            ids: cycle.receiptIds.button,
          });
        expect(buttonAfter).toBe(buttonBefore + 1);
        expect(effects.filter((r) => r.kind === "set_text").map((r) => r.detail)).toEqual([
          "",
          cycle.token,
        ]);
        expect(effects.filter((r) => r.kind === "submit").map((r) => r.detail)).toEqual([
          `0:${cycle.token}`,
        ]);
        expect(cycle.editorValue).toBe(cycle.token);
      } catch (error) {
        errors.push(redaction.error(error));
      } finally {
        // Still audit effects of a failed/unknown act; never resend it.
        try {
          auditReceipts(await readReceipts(device));
        } catch (error) {
          errors.push(`Receipt audit: ${redaction.error(error)}`);
        }
        if (agent && release) {
          try {
            const result = await bounded(
              "release phone",
              agent.gateway.call("integration_call", { toolRef: release }),
            );
            if (result.isError) errors.push(`Release: ${resultText(result)}`);
          } catch (error) {
            errors.push(`Release: ${redaction.error(error)}`);
          }
        }
        const closing = agent;
        const closingCaller = caller;
        for (const [label, close] of [
          ["gateway", closing ? () => closing.gateway.close() : undefined],
          ["Run", closing ? () => closing.run.complete() : undefined],
          ["caller", closingCaller ? () => closingCaller.close() : undefined],
        ] as const) {
          if (close) {
            try {
              await bounded(`close ${label}`, close());
            } catch (error) {
              errors.push(`Close ${label}: ${redaction.error(error)}`);
            }
          }
        }
      }
      if (errors.length) throw new Error(errors.join("\n"));
    }
  } catch (error) {
    fatalFailure = redaction.error(error);
    throw error;
  } finally {
    endedAt = new Date().toISOString();
    for (const close of cleanup.reverse()) {
      try {
        await bounded("soak cleanup", close(), 90_000);
      } catch (error) {
        cleanupFailures.push(redaction.error(error));
      }
    }
    await rm(scratch, { force: true, recursive: true });
    await flush();
    // Verify with `shasum -a 256 -c summary.sha256` in the artifact directory.
    await writeFile(
      join(directory, "summary.sha256"),
      `${sha256Hex(await readFile(join(directory, "soak.json")))}  soak.json\n`,
    );
    await writeDeviceTestManifest(directory, redaction, { completed, cleanupFailures });
  }
  expect(completed).toBe(true);
  expect(
    availability().ratio,
    "scheduled-cycle availability must be at least 99%",
  ).toBeGreaterThanOrEqual(0.99);
  expect([...duplicates.values()], "fixture effects must never be duplicated").toEqual([]);
  expect(
    [...receiptViolations.values()],
    "fixture action history must match scheduled cycles",
  ).toEqual([]);
  expect(cleanupFailures).toEqual([]);
});
