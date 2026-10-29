/**
 * The Agent Phone, end to end on a real Android phone or emulator: the real
 * Agent Phone APK, set up by the real setup engine over the local adb server,
 * paired with a real Host whose public origin is `https://10.0.2.2:<port>` —
 * a TLS front door the emulator reaches with no ADB channel in the path — and
 * operated by agents through their Runs' real MCP gateway. Only the agent's
 * computer is scripted: it speaks the Runner protocol and runs no AI engine
 * (`agent-phone-agent.device.test.ts` runs a real one). Where a person's
 * finger is needed on the phone, the harness taps the app's own buttons found
 * in `dumpsys activity top`; it never uses `uiautomator`, which would suspend
 * the Agent Phone's accessibility service.
 *
 * Ways this can fail, each asserted below:
 *  1. Setup leaves the phone unpaired, paired to the wrong identity or with a
 *     grant wider than `integrations`, or waits for an approval prompt; the accessibility setting drops other services.
 *  2. A dark screen leaks a tree or a picture, or `wake` does not wake it; an
 *     observation's picture is not the size it claims.
 *  3. An agent cannot learn which apps the phone can launch, is shown the
 *     Opensteer app among them, or cannot open one by the package it read.
 *  4. An action does nothing, does it twice, or types other text than asked;
 *     a stale observation lets an action run.
 *  5. A window that keeps itself out of screenshots loses its picture or its
 *     tree, is reported as anything but the screenshot Android gave, or
 *     cannot be operated.
 *  6. A batch near the 40 s limit is not answered within the Host's budget
 *     because another request queued behind it, or that queued request runs
 *     late, or is answered after the Host gave up on it.
 *  7. A second task reaches a phone another holds, or is not told whose task
 *     holds it; releasing is not a no-op when nothing is held.
 *  8. A read-only grant lets an act reach the phone, or cannot release.
 *  9. A person's Stop of a Run, a Watch Stop, Stop on the phone, lowered or
 *     withdrawn access each leave an action batch running: a wait does not end
 *     promptly, or its later tap still reaches the fixture after the Host has
 *     ended the session; a drag stopped during its hold leaves the finger
 *     down; or the next task cannot take the phone.
 * 10. A Run's replacement attempt loses its own session to the authority its
 *     superseded attempt lost, or to late word about that attempt.
 * 11. Pause on the phone leaves the phone usable or the session alive, or
 *     stops its app list from answering; its readiness reads
 *     "Paused on the phone on <name>".
 * 12. Setup overwrites an owner-lowered connection or cannot widen it from a client.
 * 13. A network cut mid-act reads as success or runs anything twice, or the
 *     phone does not come back by itself.
 * 14. A frame the phone cannot read — at the start of a connection or after
 *     its stream's welcome — crashes the app or its accessibility service, is
 *     not reported as a protocol error once it keeps happening, or leaves the
 *     phone unable to come back by itself once the Host speaks clearly again.
 * 15. RETARGET combines its new stored address with the previous target's
 *     Online report; a phone moved to another address enrolls again, changes
 *     identity or keeps using the old one; setup run again mints, or cannot
 *     move it back to the address its Host gives.
 * 16. A Host restart, a killed process or a reboot needs a person.
 * 17. A revoked grant leaves a live session; removing the phone leaves it with
 *     an identity.
 * 18. The Opensteer app's own screen is shown to an agent, or operated, or an
 *     agent is stuck there; the launcher is named by its package although it
 *     has a label.
 * 19. An end-to-end build, which trusts a test CA, overwrites the app the web
 *     and desktop apps hand a person's phone.
 * 20. An editable node rebound to another field accepts the old element
 *     index, or ordinary text changes make the same field unusable.
 * 21. Observed agent keypad taps cannot unlock a secure keyguard; wake leaves a
 *     credential-free Swipe keyguard in front of the apps.
 * 22. Stop on the phone leaves queued observations holding an orphaned
 *     session, preventing the next task from taking the display.
 * 23. A failed Stop-ledger write is mistaken for persistence, or an ordinary
 *     Host frame clears the phone's replay before a new stream records it.
 * 24. An owner's Stop the Host never received is lost when the app process
 *     dies before reconnecting, so the stopped Run uses the phone again.
 *
 * `OPENSTEER_AGENT_PHONE_REBOOTS` sets how many unattended reboots the
 * journey ends with. It is 1 by default, which keeps a developer's run short;
 * release qualification runs set it to 10.
 *
 * The artifact directory (OPENSTEER_AGENT_PHONE_E2E_ARTIFACT_DIR, else a new
 * temporary directory) receives `result.json` with each step's outcome and
 * timing, the device, the APK and its manifest, the revision, the network
 * path, the measured stop and deadline timings and the reboot timings;
 * `screenshots/`; the redacted Host log, the agents' transcript and the app's
 * logcat, and the whole device's logcat when the run failed; and
 * `summary.json` with `summary.sha256` over its stable fields.
 */
import { stagePhonePin } from "./agent-phone-pin.test-support.js";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentPhoneArtifact, AgentPhoneSetupStep } from "@opensteer/agent-phone-setup";
import { DeploymentIdSchema, type RunnerId, type WorkspaceId } from "@opensteer/core";
import {
  agentPhoneAccessibilityService,
  agentPhoneMinSdk,
  agentPhonePackageName,
  androidPhoneDefinitionId,
  type AgentPhoneArtifactManifest,
  type AndroidPhoneAction,
} from "@opensteer/protocol";
import { delay } from "@opensteer/shared/delay";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createMachineAccessDatabase,
  freePort,
  revokeMachine,
  steerRun,
  stopRun,
  waitForMessage,
  type CallerMachine,
  type MachineAccessDatabase,
} from "../runtime/machine-access.test-support.js";
import { testRpcData } from "../server/test-host-api-request.js";
import {
  assertNoPhoneApprovalActivity,
  writeDeviceTestManifest,
  DeviceLog,
  Redaction,
  acquireAndroidDevice,
  activityFocused,
  activityResumed,
  agentPhoneActivities,
  agentPhonePids,
  buildE2eAgentPhone,
  clearReceipts,
  connectAgentComputer,
  connectAgentGateway,
  createTestCertificateAuthority,
  deploymentIdOf,
  deviceFacts,
  elementIndex,
  emulatorHostAlias,
  eventually,
  fixtureActivities,
  fixturePackage,
  installFixture,
  jpegSize,
  phoneRowOf,
  readObservation,
  readPhoneStatus,
  readReceipts,
  rebootDevice,
  repositoryRoot,
  resetPhone,
  resultImages,
  resultJson,
  resultText,
  retargetPhone,
  runAgentPhoneSetup,
  runCommand,
  sha256Hex,
  startAgentPhoneHost,
  startPhoneAgent,
  startTlsFrontDoor,
  tapView,
  waitForPhoneOnline,
  type AgentPhoneHost,
  type AndroidDevice,
  type DeviceFacts,
  type FrameInjection,
  type PhoneAgent,
  type PhoneObservationText,
  type PhoneRow,
  type PhoneToolRefs,
  type Receipt,
  type TestCertificateAuthority,
  type TlsFrontDoor,
  type ToolResult,
} from "./agent-phone-device.test-support.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const api = Number(process.env.OPENSTEER_AGENT_PHONE_API ?? "36");
const reboots = Number(process.env.OPENSTEER_AGENT_PHONE_REBOOTS ?? "1");
const phoneName = "E2E Pixel";
const typedText = "héllo 😀 مرحبا";
/** How long the phone may take, with nobody touching it, to be back at work. */
const reconnectBudgetMs = 60_000;
const rebootOnlineBudgetMs = 120_000;
/** Back from a run of unreadable frames: the phone's longest backoff is 30 s. */
const protocolRecoveryBudgetMs = 90_000;
/** How soon an ended authority must reach the phone, well inside any wait it cuts short. */
const promptStopMs = 3_000;
/** The Host's wait for a phone's answer: its deadline for the operation and 6 s past it. */
const hostBudgetMs = { act: 66_000, observe: 36_000 } as const;

interface StepRecord {
  readonly durationMs: number;
  readonly endedAt: string;
  readonly error?: string;
  readonly name: string;
  readonly startedAt: string;
  readonly status: "passed" | "failed";
}

interface RebootTiming {
  readonly actedMs: number;
  readonly bootedMs: number;
  readonly index: number;
  readonly onlineMs: number;
}

/** One agent: a Run on an agent computer, its gateway, and the Thread's title. */
interface Agent extends PhoneAgent {
  readonly title: string;
}

const PhoneAppsSchema = z.object({
  apps: z.array(z.object({ label: z.string(), packageName: z.string() })),
  nextOffset: z.number().int().nonnegative().nullable(),
  total: z.number().int().nonnegative(),
});

const IssuedCredentialsSchema = z.object({
  result: z.object({
    credentials: z.object({ integrationTools: z.string().min(1) }),
    status: z.literal("issued"),
  }),
  type: z.literal("host.grants.credentials"),
});

/** The copies of the app the web and desktop apps hand a person's phone. */
const productArtifactDirectories = [
  "apps/web/public/agent-phone",
  "apps/desktop/generated-resources/agent-phone",
] as const;

/** Each product copy's digest, or that it is absent, so a build that touches one shows. */
async function productArtifacts(): Promise<Readonly<Record<string, string>>> {
  const files: Record<string, string> = {};
  for (const directory of productArtifactDirectories) {
    for (const name of ["opensteer-agent-phone.apk", "agent-phone.json"]) {
      files[`${directory}/${name}`] = await readFile(join(repositoryRoot, directory, name)).then(
        sha256Hex,
        () => "absent",
      );
    }
  }
  return files;
}

/**
 * What the phone cannot read: a type no Host sends, and a challenge a Host
 * would send but for one field the protocol does not have.
 */
const unreadableFrameTexts = [
  JSON.stringify({ type: "host.unknown" }),
  JSON.stringify({
    challengeId: `rch_${randomUUID()}`,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    hostSessionId: randomBytes(24).toString("base64url"),
    injected: true,
    nonce: randomBytes(24).toString("base64url"),
    proofFormatVersion: 2,
    type: "host.challenge",
  }),
] as const;

const git = (args: readonly string[]) => runCommand("git", args, { cwd: repositoryRoot });

describe.sequential(`Agent Phone on Android API ${api}, end to end`, () => {
  const steps: StepRecord[] = [];
  const rebootTimings: RebootTiming[] = [];
  const measurements: Record<string, number> = {};
  const hostLog: string[] = [];
  const transcript: string[] = [];
  let sensitivePhoneEntry = false;
  const redaction = new Redaction();
  const appPids = new Set<number>();
  const closers: (() => Promise<void>)[] = [];
  let artifactDirectory = "";
  let scratch = "";
  let screenshotCount = 0;
  let completed = false;
  let isolated: MachineAccessDatabase | null = null;
  let authority: TestCertificateAuthority;
  let device: AndroidDevice | null = null;
  let deviceLog: DeviceLog | null = null;
  let facts: DeviceFacts | null = null;
  let manifest: AgentPhoneArtifactManifest | null = null;
  let artifact: AgentPhoneArtifact;
  let host: AgentPhoneHost;
  let frontDoor: TlsFrontDoor;
  /** A second address for the same Host, which the phone is moved to. */
  let secondDoor: TlsFrontDoor | null = null;
  let fixtureSha256 = "";
  let productBeforeBuild: Readonly<Record<string, string>> = {};
  let productAfterBuild: Readonly<Record<string, string>> = {};
  const restoreConsole = captureConsole(hostLog);

  beforeAll(async () => {
    if (!databaseUrl) {
      throw new Error(
        "OPENSTEER_TEST_DATABASE_URL is unset: run this suite with pnpm test:agent-phone.",
      );
    }
    artifactDirectory =
      process.env.OPENSTEER_AGENT_PHONE_E2E_ARTIFACT_DIR ??
      (await mkdtemp(join(tmpdir(), `opensteer-agent-phone-e2e-api${api}-`)));
    await rm(artifactDirectory, { force: true, recursive: true });
    await mkdir(join(artifactDirectory, "screenshots"), { recursive: true });
    process.stdout.write(`Agent Phone E2E artifact: ${artifactDirectory}\n`);
    scratch = await mkdtemp(join(tmpdir(), "opensteer-agent-phone-e2e-scratch-"));

    // The debug APK trusts this run's CA only, compiled into its debug-overrides.
    authority = await createTestCertificateAuthority(scratch);
    productBeforeBuild = await productArtifacts();
    const build = await buildE2eAgentPhone({
      authority,
      log: join(artifactDirectory, "build.log"),
    });
    productAfterBuild = await productArtifacts();
    manifest = build.manifest;
    artifact = build.artifact;
    fixtureSha256 = build.fixtureSha256;

    device = await acquireAndroidDevice({
      api,
      emulatorLog: join(artifactDirectory, "emulator.log"),
    });
    facts = await deviceFacts(device);
    // Setup and the phone's hello name it by Android's device name, so the
    // journey sets the name it asserts and gives the device its own back.
    const ownDeviceName = (await device.shell("settings get global device_name")).trim();
    if (!/^[\w .-]{1,120}$/u.test(ownDeviceName))
      throw new Error("Unexpected original device name");
    await device.shell(`settings put global device_name '${phoneName}'`);
    const phone = device;
    closers.push(async () => {
      await phone.shell(
        ownDeviceName === "null"
          ? "settings delete global device_name"
          : `settings put global device_name '${ownDeviceName}'`,
      );
    });
    deviceLog = new DeviceLog(device);
    await deviceLog.start();

    isolated = await createMachineAccessDatabase(databaseUrl);
    const publicPort = await freePort();
    host = await startAgentPhoneHost(isolated.url, {
      log: (line) => hostLog.push(line),
      publicPort,
    });
    redaction.add(...Object.values(host.ownerHeaders));
    frontDoor = await startTlsFrontDoor({ authority, hostPort: host.hostPort, port: publicPort });
  }, 900_000);

  afterAll(async () => {
    restoreConsole();
    const teardown: { name: string; stopped: boolean; error?: string }[] = [];
    const close = async (name: string, action: () => Promise<unknown>) => {
      try {
        await action();
        teardown.push({ name, stopped: true });
      } catch (error) {
        teardown.push({ name, stopped: false, error: redaction.error(error) });
      }
    };
    for (const [index, action] of closers.reverse().entries())
      await close(`caller-${index}`, action);
    await close("second-door", async () => secondDoor?.close());
    await close("front-door", async () => frontDoor?.close());
    await close("host", async () => host?.close());
    await close("logcat", async () => deviceLog?.stop());
    await close("device", async () => device?.close());
    await close("database", async () => isolated?.drop());
    await close("scratch", async () => {
      if (scratch) await rm(scratch, { force: true, recursive: true });
    });
    if (artifactDirectory) {
      await writeArtifact();
      await writeDeviceTestManifest(artifactDirectory, redaction, { completed, teardown });
    }
    expect(
      teardown.filter(({ stopped }) => !stopped),
      "every owned resource must stop",
    ).toEqual([]);
  }, 300_000);

  async function writeArtifact(): Promise<void> {
    const revision = (await git(["rev-parse", "HEAD"]).catch(() => "unknown")).trim();
    const dirty = (await git(["status", "--porcelain"]).catch(() => "")).trim().length > 0;
    const networkPath = {
      kind: "tls-front-door",
      phoneReaches: host ? host.publicOrigin : null,
      detail:
        "The phone dials https://10.0.2.2:<port>, the emulator's address for this computer, where a TLS front door with a per-run test CA pipes to the Host on loopback. No adb reverse or other ADB channel carries Host traffic.",
      testCaSha256: authority?.caSha256 ?? null,
    };
    const stable = {
      apkSha256: manifest?.apkSha256 ?? null,
      completed,
      device: facts ? { fingerprint: facts.fingerprint, model: facts.model, sdk: facts.sdk } : null,
      fixtureSha256,
      networkPath: networkPath.kind,
      reboots: rebootTimings.length,
      revision,
      scenario: "agent-phone-emulator-journey",
      steps: steps.map(({ name, status }) => ({ name, status })),
    };
    const result = {
      ...stable,
      apk: manifest,
      device: facts,
      dirtyWorktree: dirty,
      measurementsMs: measurements,
      networkPath,
      productCopies: { afterBuild: productAfterBuild, beforeBuild: productBeforeBuild },
      rebootTimings,
      screenshots: screenshotCount,
      steps,
    };
    await writeFile(join(artifactDirectory, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    const summary = `${JSON.stringify(stable, null, 2)}\n`;
    await writeFile(join(artifactDirectory, "summary.json"), summary);
    await writeFile(
      join(artifactDirectory, "summary.sha256"),
      `${sha256Hex(summary)}  summary.json\n`,
    );
    await writeFile(
      join(artifactDirectory, "host.log"),
      `${redaction.apply(hostLog.join("\n"))}\n`,
    );
    await writeFile(
      join(artifactDirectory, "agent-transcript.txt"),
      `${redaction.apply(transcript.join("\n\n"))}\n`,
    );
    if (deviceLog) {
      await writeFile(
        join(artifactDirectory, "logcat.txt"),
        `${redaction.apply(deviceLog.linesFrom(appPids).join("\n"))}\n`,
      );
      // A failure is often decided by the system, not the app, as when
      // Android's accessibility manager rewrote a setting; keep all of it.
      if (!completed) {
        await writeFile(
          join(artifactDirectory, "logcat-device.txt"),
          `${redaction.apply(deviceLog.allLines().join("\n"))}\n`,
        );
      }
    }
  }

  async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
    const started = Date.now();
    const finish = async (status: "passed" | "failed", error?: unknown) => {
      steps.push({
        durationMs: Date.now() - started,
        endedAt: new Date().toISOString(),
        ...(error === undefined ? {} : { error: redaction.error(error).slice(0, 4_000) }),
        name,
        startedAt: new Date(started).toISOString(),
        status,
      });
      await screenshot(name).catch(() => undefined);
      if (device) for (const pid of await agentPhonePids(device)) appPids.add(pid);
    };
    try {
      const value = await run();
      await finish("passed");
      return value;
    } catch (error) {
      await finish("failed", error);
      throw error;
    }
  }

  async function screenshot(name: string): Promise<void> {
    if (!device) return;
    screenshotCount += 1;
    const file = `${String(screenshotCount).padStart(2, "0")}-${name.replace(/[^a-z0-9]+/giu, "-").toLowerCase()}.png`;
    await writeFile(join(artifactDirectory, "screenshots", file), await device.screencap());
  }

  async function screenshotThemes(name: string, activity: string): Promise<void> {
    try {
      for (const [theme, mode] of [
        ["dark", "yes"],
        ["light", "no"],
      ] as const) {
        await phone().shell(`cmd uimode night ${mode}`);
        // A theme change recreates the activity; its window holding focus
        // again is the system's word that it is back on screen.
        await eventually(
          "the themed phone screen to come back",
          async () => ((await activityFocused(phone(), activity)) ? true : undefined),
          15_000,
        );
        await delay(500);
        await screenshot(`${name}-${theme}`);
      }
    } finally {
      await phone().shell("cmd uimode night no");
    }
  }

  /* ---- The phone and the owner ---------------------------------------- */

  function phone(): AndroidDevice {
    if (!device) throw new Error("No device.");
    return device;
  }

  const owner = () => ({ headers: host.ownerHeaders });

  async function phoneMachine(runnerId: RunnerId) {
    const { machines } = await testRpcData(host.origin, "machines.list", {}, owner());
    return machines.find((machine) => machine.id === runnerId) ?? null;
  }

  async function phoneSessions(runnerId: RunnerId) {
    return (await phoneMachine(runnerId))?.computerUse?.sessions ?? [];
  }

  async function phoneConnection(runnerId: RunnerId) {
    const { connections } = await testRpcData(host.origin, "integrations.get", {}, owner());
    return connections.find(
      (connection) =>
        connection.definitionId === androidPhoneDefinitionId &&
        connection.computer?.runnerId === runnerId &&
        connection.status !== "revoked",
    );
  }

  const waitForOnline = (runnerId: RunnerId, timeoutMs: number) =>
    waitForPhoneOnline(phone(), host, runnerId, timeoutMs);

  /** Android's own word that the Agent Phone's accessibility service is bound and has not crashed. */
  async function accessibilityServiceBound(): Promise<boolean> {
    const dump = await phone().shell("dumpsys accessibility", { timeoutMs: 30_000 });
    const bound = /^\s*Bound services:\{(.*)\}\s*$/mu.exec(dump)?.[1];
    if (bound === undefined) throw new Error("dumpsys accessibility lists no bound services.");
    const crashed = /^\s*Crashed services:\{(.*)\}\s*$/mu.exec(dump)?.[1] ?? "";
    return (
      bound.includes("label=Opensteer Agent Phone") && !crashed.includes(agentPhonePackageName)
    );
  }

  /** Whether the window manager marks an activity's window SECURE, keeping it out of screenshots. */
  async function windowIsSecure(activity: string): Promise<boolean> {
    const lines = (await phone().shell("dumpsys window windows", { timeoutMs: 30_000 })).split(
      "\n",
    );
    const start = lines.findIndex(
      (line) => /^\s*Window #\d+ Window\{/u.test(line) && line.includes(` ${activity}}`),
    );
    if (start === -1) throw new Error(`The window manager lists no window for ${activity}.`);
    const end = lines.findIndex((line, index) => index > start && /^\s*Window #\d+ /u.test(line));
    return lines
      .slice(start + 1, end === -1 ? undefined : end)
      .some((line) => /\bfl=[^\n]*\bSECURE\b/u.test(line));
  }

  async function createWorkspace(name: string): Promise<WorkspaceId> {
    const created = await testRpcData(
      host.origin,
      "commands.dispatch",
      { idempotencyKey: `workspace-${randomUUID()}`, name, type: "workspace.create" },
      owner(),
    );
    if (created.type !== "workspace.create") throw new Error("Workspace command mismatch.");
    return created.workspace.id;
  }

  /** The owner lets a Workspace use the phone, as the Workspace's integration settings do. */
  async function grantPhone(
    runnerId: RunnerId,
    workspaceId: WorkspaceId,
    access: "read" | "read-write",
  ) {
    const connection = await phoneConnection(runnerId);
    if (!connection) throw new Error("The phone has no connection to grant.");
    const installation = (
      await host.store.database
        .selectFrom("integrationInstallations")
        .select(["id", "provenance"])
        .execute()
    ).find(
      ({ provenance }) =>
        (provenance as { definitionId?: unknown }).definitionId === androidPhoneDefinitionId,
    );
    if (!installation) throw new Error("The Android phone definition is not installed.");
    const created = await testRpcData(
      host.origin,
      "commands.dispatch",
      {
        idempotencyKey: `grant-${randomUUID()}`,
        input: {
          access,
          alias: phoneName,
          connectionId: connection.id,
          installationId: installation.id,
          isDefault: false,
          workspaceId,
        },
        type: "integration.grant.create",
      },
      owner(),
    );
    if (created.type !== "integration.grant.create") throw new Error("Grant command mismatch.");
    return created.grant;
  }

  async function newCaller(key: string, restartsRuns = false): Promise<CallerMachine> {
    const caller = await connectAgentComputer(host, { key, redaction, restartsRuns });
    closers.push(() => caller.close());
    return caller;
  }

  async function homeWorkspace(): Promise<WorkspaceId> {
    const bootstrap = await testRpcData(host.origin, "bootstrap.get", {}, owner());
    if (!bootstrap.homeWorkspace) throw new Error("The owner has no Main Workspace.");
    return bootstrap.homeWorkspace.id;
  }

  async function startAgent(
    caller: CallerMachine,
    input: { readonly title: string; readonly workspaceId: WorkspaceId },
  ): Promise<Agent> {
    const agent = await startPhoneAgent(host, caller, {
      key: `run-${randomUUID()}`,
      redaction,
      title: input.title,
      workspaceId: input.workspaceId,
    });
    closers.push(() => agent.gateway.close());
    return { ...agent, title: input.title };
  }

  /** A Run that has done its part reports itself finished, as its engine would. */
  async function finish(agent: Agent): Promise<void> {
    await agent.gateway.close();
    await agent.run.complete();
  }

  /* ---- The agent ------------------------------------------------------ */

  async function call(
    agent: Agent,
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const result = await agent.gateway.call(name, args);
    if (sensitivePhoneEntry) {
      transcript.push(`## ${agent.title}: ${name} [credential entry redacted]`);
      return result;
    }
    transcript.push(
      [
        `## ${agent.title}: ${name} ${JSON.stringify(args)}`,
        ...result.content.map((block) =>
          block.type === "text"
            ? block.text
            : `[image ${block.mimeType}, ${block.data.length} base64 chars]`,
        ),
        result.isError ? "(isError)" : "",
      ].join("\n"),
    );
    return result;
  }

  async function phoneRow(agent: Agent, runnerId: RunnerId): Promise<PhoneRow> {
    return phoneRowOf(
      await call(agent, "integration_search", { query: "Android phone" }),
      runnerId,
    );
  }

  async function toolRefs(agent: Agent, runnerId: RunnerId): Promise<PhoneToolRefs> {
    const row = await phoneRow(agent, runnerId);
    if (!row.toolRefs) throw new Error(`The phone is not callable: ${JSON.stringify(row)}`);
    return row.toolRefs;
  }

  /** One page of the phone's launchable apps, as an agent lists them by the phone's runnerId. */
  async function phoneApps(
    agent: Agent,
    runnerId: RunnerId,
    query: string,
    offset = 0,
  ): Promise<z.infer<typeof PhoneAppsSchema>> {
    return PhoneAppsSchema.parse(
      resultJson(await call(agent, "integration_search", { limit: 20, offset, query, runnerId })),
    );
  }

  async function observe(
    agent: Agent,
    refs: PhoneToolRefs,
  ): Promise<{
    readonly observation: PhoneObservationText;
    readonly result: ToolResult;
  }> {
    const result = await call(agent, "integration_call", { toolRef: refs.observe });
    if (result.isError) throw new Error(`Observe was refused: ${resultText(result)}`);
    return { observation: readObservation(resultText(result)), result };
  }

  function act(
    agent: Agent,
    refs: PhoneToolRefs,
    observationId: string,
    actions: readonly AndroidPhoneAction[],
  ): Promise<ToolResult> {
    if (!refs.act) throw new Error("This agent may not act on the phone.");
    return call(agent, "integration_call", {
      arguments: { actions, observationId },
      toolRef: refs.act,
    });
  }

  /** An act that must succeed, and the observation it returns. */
  async function actOk(
    agent: Agent,
    refs: PhoneToolRefs,
    observationId: string,
    actions: readonly AndroidPhoneAction[],
  ): Promise<{ readonly observation: PhoneObservationText; readonly result: ToolResult }> {
    const result = await act(agent, refs, observationId, actions);
    if (result.isError) throw new Error(`The act failed: ${resultText(result)}`);
    return { observation: readObservation(resultText(result)), result };
  }

  /** Look first, then wake a dark phone or dismiss its nonsecure keyguard. */
  async function lookAwake(agent: Agent, refs: PhoneToolRefs): Promise<PhoneObservationText> {
    const { observation } = await observe(agent, refs);
    if (observation.screen === "on" && !observation.locked) return observation;
    return (await actOk(agent, refs, observation.observationId, [{ type: "wake" }])).observation;
  }

  /** Home, then the fixture app, the way an agent opens an app by its package. */
  async function openFixture(agent: Agent, refs: PhoneToolRefs): Promise<PhoneObservationText> {
    const awake = await lookAwake(agent, refs);
    const home = await actOk(agent, refs, awake.observationId, [{ to: "home", type: "navigate" }]);
    const launched = await actOk(agent, refs, home.observation.observationId, [
      { packageName: fixturePackage, type: "launch" },
    ]);
    return untilShown(agent, refs, launched.observation, "button", "Record a tap");
  }

  /**
   * A batch of a tap, `waits` waits of 5 s and another tap. The first receipt
   * proves the batch started; the waits leave time to withdraw its authority.
   * `laterTapDueAt` is when the second tap would land if nothing stopped it.
   */
  async function startWaitingBatch(agent: Agent, refs: PhoneToolRefs, waits = 1) {
    const fixture = await openFixture(agent, refs);
    await clearReceipts(phone());
    const tap: AndroidPhoneAction = {
      count: 1,
      target: { index: elementIndex(fixture, "button", "Record a tap") },
      type: "tap",
    };
    const acting = act(agent, refs, fixture.observationId, [
      tap,
      ...Array.from({ length: waits }, () => ({ ms: 5_000, type: "wait" as const })),
      tap,
    ]);
    await eventually(
      "the batch's first tap to reach the fixture",
      async () => (counts(await readReceipts(phone())).button_tap === 1 ? true : undefined),
      10_000,
      200,
    );
    const laterTapDueAt = Date.now() + waits * 5_000;
    // Let the first gesture and its settling delay finish, placing the executor in the wait.
    await delay(600);
    return { acting, laterTapDueAt, observationId: fixture.observationId };
  }

  /**
   * Observes until an element is on screen, as an agent waits for an app it
   * opened to draw: a launch answers once Android has the app in front, which
   * can be before its window has anything in it.
   */
  async function untilShown(
    agent: Agent,
    refs: PhoneToolRefs,
    first: PhoneObservationText,
    role: string,
    label: string,
  ): Promise<PhoneObservationText> {
    const shown = (observation: PhoneObservationText) =>
      observation.tree.some((line) => line.role === role && line.label === label);
    let latest = first;
    for (let attempt = 0; attempt < 20 && !shown(latest); attempt += 1) {
      await delay(500);
      latest = (await observe(agent, refs)).observation;
    }
    if (!shown(latest)) throw new Error(`No ${role} "${label}" ever showed:\n${latest.treeText}`);
    return latest;
  }

  /** The Opensteer app's own window can stay in front a moment after it finished; an agent looks again. */
  async function observeOutsideOpensteer(
    agent: Agent,
    refs: PhoneToolRefs,
  ): Promise<PhoneObservationText> {
    const ours = (observation: PhoneObservationText) =>
      observation.foreground.endsWith(`(${agentPhonePackageName})`);
    let latest = (await observe(agent, refs)).observation;
    for (let attempt = 0; attempt < 20 && ours(latest); attempt += 1) {
      await delay(500);
      latest = (await observe(agent, refs)).observation;
    }
    if (ours(latest)) throw new Error(`The Opensteer app stayed in front:\n${latest.headline}`);
    return latest;
  }

  function refusalOf(result: ToolResult): string {
    if (!result.isError) throw new Error(`Expected a refusal, got:\n${resultText(result)}`);
    return resultText(result);
  }

  /**
   * What the fixture recorded of actions. Its raw touch and scroll-offset
   * traces are for the live display journey, and layout alone can add them.
   */
  function actions(receipts: readonly Receipt[]): Receipt[] {
    return receipts.filter(({ kind }) => !kind.endsWith("_touch") && kind !== "scroll_offset");
  }

  function counts(receipts: readonly Receipt[]): Record<string, number> {
    const tally: Record<string, number> = {};
    for (const receipt of actions(receipts)) tally[receipt.kind] = (tally[receipt.kind] ?? 0) + 1;
    return tally;
  }

  async function screenIsOn(): Promise<boolean> {
    const power = await phone().shell("dumpsys power");
    return /mWakefulness=Awake/u.test(power);
  }

  async function sleepScreen(): Promise<void> {
    await phone().shell("input keyevent 223");
    await eventually(
      "the screen to go dark",
      async () => ((await screenIsOn()) ? undefined : true),
      15_000,
    );
  }

  /** The owner opens the Agent Phone app and flips Pause, as with the phone in hand. */
  async function flipPause(): Promise<void> {
    await phone().shell("input keyevent KEYCODE_WAKEUP");
    await phone().shell(`am start -W -n ${agentPhoneActivities.main}`);
    await screenshotThemes("main-using-phone", agentPhoneActivities.main);
    await tapView(phone(), { activity: agentPhoneActivities.main, viewId: "pause_switch" });
    const status = await readPhoneStatus(phone());
    await screenshotThemes(
      status.paused ? "main-paused" : "main-online",
      agentPhoneActivities.main,
    );
  }

  it("is set up over USB, serves agents, and survives what a dedicated phone goes through", async () => {
    const device = phone();
    let runnerId!: RunnerId;
    let enrollmentId = "";
    const deploymentId = await deploymentIdOf(host);
    // ---- 0. A phone older than Android 11 is refused before anything changes
    if (facts!.sdk < agentPhoneMinSdk) {
      await step("setup refuses an Android older than 11", async () => {
        const mints: string[] = [];
        const result = await runAgentPhoneSetup({
          artifact,
          device,
          host,
          onMinted: ({ enrollmentId: minted }) => mints.push(minted),
          redaction,
          runnerName: phoneName,
          timeoutMs: 120_000,
        });
        expect(result).toEqual({
          issue: {
            code: "android-too-old",
            detail: `Android ${facts!.release} (API ${facts!.sdk}); needs API ${manifest!.minSdk}`,
          },
          outcome: "issue",
          runnerId: null,
        });
        expect(mints).toEqual([]);
      });
      completed = true;
      return;
    }

    // ---- 1. Setup through the real engine ----------------------------------
    await step("the end-to-end build leaves the web and desktop copies alone", async () => {
      expect(productAfterBuild).toEqual(productBeforeBuild);
      expect(fixtureSha256).toMatch(/^[0-9a-f]{64}$/u);
    });

    await step("setup through the real engine", async () => {
      await resetPhone(device);
      await installFixture(device);
      const otherService = (
        await device.shell("settings get secure enabled_accessibility_services")
      ).trim();
      const minted: { enrollmentId: string; token: string }[] = [];
      const onSteps: AgentPhoneSetupStep[] = [];
      const result = await runAgentPhoneSetup({
        artifact,
        device,
        host,
        onMinted: (enrollment) => minted.push(enrollment),
        onStep: (next) => onSteps.push(next),
        redaction,
        runnerName: phoneName,
        timeoutMs: 600_000,
      });
      if (result.outcome !== "done") throw new Error(`Setup stopped: ${JSON.stringify(result)}`);
      runnerId = result.runnerId;
      await writeFile(
        join(artifactDirectory, "setup-progress.json"),
        JSON.stringify(onSteps, null, 2) + "\n",
      );
      expect(onSteps.map(({ step: name }) => name)).toEqual([
        "inspect",
        "inspect",
        "install",
        "configure",
        "pair",
        "done",
      ]);
      expect(onSteps[1]).toEqual({
        phone: {
          manufacturer: facts!.manufacturer,
          model: facts!.model,
          release: facts!.release,
          sdk: facts!.sdk,
          secureLock: false,
        },
        step: "inspect",
      });
      expect(onSteps[2]).toEqual({ step: "install" });
      // One enrollment for one phone.
      expect(minted).toHaveLength(1);
      enrollmentId = minted[0]!.enrollmentId;

      const status = await readPhoneStatus(device);
      expect(status).toEqual({
        accessibility: { connected: true, enabled: true },
        app: { versionCode: manifest!.versionCode, versionName: manifest!.versionName },
        batteryOptimizationExempt: true,
        connection: "online",
        issue: null,
        pairing: {
          deploymentId,
          deploymentName: new URL(host.publicOrigin).hostname,
          enrollmentId,
          hostUrl: host.publicOrigin,
          runnerId,
        },
        paused: false,
        version: 1,
      });
      // Every other accessibility service the phone had stays on.
      const services = (
        await device.shell("settings get secure enabled_accessibility_services")
      ).trim();
      expect(services.split(":")).toEqual([
        ...(otherService === "null" || otherService === "" ? [] : otherService.split(":")),
        agentPhoneAccessibilityService,
      ]);

      const machine = await phoneMachine(runnerId);
      expect(machine).toMatchObject({
        allowedModules: ["integrations"],
        device: { form: "phone", platform: "android" },
        enrollmentId,
        name: phoneName,
        ownership: "mine",
        runtimeVersion: manifest!.versionName,
        status: "online",
      });
      expect(Object.keys(machine!.modules)).toEqual(["integrations"]);
      expect(machine!.computerUse).toMatchObject({
        appApproval: null,
        approvalKeyId: null,
        state: "ready",
      });
      const stored = await host.store.database
        .selectFrom("runners")
        .select(["allowedModules", "kind", "ownerKind", "ownerUserId"])
        .where("id", "=", runnerId)
        .executeTakeFirstOrThrow();
      expect(stored).toEqual({
        allowedModules: ["integrations"],
        kind: "local",
        ownerKind: "user",
        ownerUserId: host.ownerId,
      });
      expect(await phoneConnection(runnerId)).toMatchObject({
        computer: { access: "read-write", app: null, runnerId },
        status: "connected",
      });
      await assertNoPhoneApprovalActivity(device);
    });

    // ---- 2. An agent in the owner's Main ------------------------------------
    const caller = await newCaller("caller-1");
    const main = await homeWorkspace();
    const agentA = await startAgent(caller, { title: "Text the driver", workspaceId: main });
    let refsA!: PhoneToolRefs;
    let firstObservation = "";

    await step("main agent finds the phone", async () => {
      const row = await phoneRow(agentA, runnerId);
      expect(row).toMatchObject({
        access: "read-write",
        approval: "approved",
        inUse: false,
        name: phoneName,
        runnerId,
        state: "ready",
        toolRefs: {
          act: expect.any(String),
          observe: expect.any(String),
          release: expect.any(String),
        },
      });
      refsA = row.toolRefs!;
    });

    await step("a dark screen shows nothing and wake turns it on", async () => {
      await sleepScreen();
      const dark = await observe(agentA, refsA);
      firstObservation = dark.observation.observationId;
      expect(dark.observation).toMatchObject({
        elementCount: 0,
        screen: "off",
        tree: [],
      });
      expect(resultImages(dark.result)).toEqual([]);
      expect(resultText(dark.result)).toContain(
        'The screen is off, so there is nothing to see. Act with {"type":"wake"} to turn it on.',
      );
      const woke = await actOk(agentA, refsA, dark.observation.observationId, [{ type: "wake" }]);
      expect(woke.observation.headline).toBe("Turned the screen on");
      expect(woke.observation.screen).toBe("on");
      expect(await screenIsOn()).toBe(true);
    });

    await step("wake dismisses a nonsecure Swipe keyguard", async () => {
      const previousDisabled = (await device.shell("locksettings get-disabled")).trim();
      if (!/^(?:true|false)$/u.test(previousDisabled)) {
        throw new Error("The dedicated device did not report its screen-lock setting.");
      }
      try {
        await device.shell("locksettings set-disabled false");
        await device.shell("input keyevent KEYCODE_POWER");
        const locked = await eventually(
          "the dedicated phone's nonsecure keyguard to show while dark",
          async () => {
            const current = (await observe(agentA, refsA)).observation;
            return current.screen === "off" && current.locked && !current.secureLock
              ? current
              : undefined;
          },
          15_000,
        );
        const woke = await actOk(agentA, refsA, locked.observationId, [{ type: "wake" }]);
        expect(woke.observation).toMatchObject({ screen: "on", locked: false, secureLock: false });
        await screenshot("nonsecure-keyguard-dismissed-by-agent");
      } finally {
        await device.shell(`locksettings set-disabled ${previousDisabled}`);
      }
    });

    await step("an awake phone is seen whole", async () => {
      const { observation, result } = await observe(agentA, refsA);
      expect(observation).toMatchObject({
        locked: false,
        screen: "on",
        secureLock: false,
      });
      expect(observation.foreground).not.toBe("none");
      expect(observation.elementCount).toBeGreaterThan(0);
      const [picture, ...others] = resultImages(result);
      expect(others).toEqual([]);
      expect(picture?.mimeType).toBe("image/jpeg");
      expect(jpegSize(picture!.data)).toEqual(observation.geometry);
    });

    await step(
      "main agent lists the phone's apps and opens one by the package it read",
      async () => {
        // A query matches labels and packages alike; the Opensteer app, labelled
        // "Opensteer Agent Phone", is never among them.
        const found = await phoneApps(agentA, runnerId, "Agent Phone");
        expect(found).toEqual({
          apps: [{ label: "Agent Phone fixture", packageName: fixturePackage }],
          nextOffset: null,
          total: 1,
        });
        // Every page together: each package once, all of them counted, ours absent.
        const listed: { label: string; packageName: string }[] = [];
        let offset: number | null = 0;
        let total = -1;
        while (offset !== null) {
          const page = await phoneApps(agentA, runnerId, "", offset);
          if (total === -1) total = page.total;
          expect(page.total).toBe(total);
          listed.push(...page.apps);
          offset = page.nextOffset;
        }
        expect(listed).toHaveLength(total);
        expect(new Set(listed.map(({ packageName }) => packageName)).size).toBe(total);
        expect(listed.map(({ packageName }) => packageName)).not.toContain(agentPhonePackageName);
        expect(listed).toContainEqual(found.apps[0]);
        // Listing is not control: it took no hold on the phone.
        expect(await phoneSessions(runnerId)).toHaveLength(1);

        const awake = await lookAwake(agentA, refsA);
        const home = await actOk(agentA, refsA, awake.observationId, [
          { to: "home", type: "navigate" },
        ]);
        expect(await activityResumed(device, fixtureActivities.main)).toBe(false);
        await actOk(agentA, refsA, home.observation.observationId, [
          { packageName: found.apps[0]!.packageName, type: "launch" },
        ]);
        await eventually(
          "Android to have the fixture in front",
          async () => ((await activityResumed(device, fixtureActivities.main)) ? true : undefined),
          15_000,
        );
      },
    );

    await step("main agent operates the fixture app", async () => {
      await clearReceipts(device);
      const fixture = await openFixture(agentA, refsA);
      expect(fixture.foreground).toBe(`Agent Phone fixture (${fixturePackage})`);
      expect(actions(await readReceipts(device))).toEqual([]);

      const tapped = await actOk(agentA, refsA, fixture.observationId, [
        {
          count: 1,
          target: { index: elementIndex(fixture, "button", "Record a tap") },
          type: "tap",
        },
      ]);
      expect(tapped.observation.headline).toBe('Tapped "Record a tap"');
      expect(counts(await readReceipts(device))).toEqual({ button_tap: 1 });

      const typed = await actOk(agentA, refsA, tapped.observation.observationId, [
        {
          submit: true,
          target: { index: elementIndex(tapped.observation, "edittext", "Type here") },
          text: typedText,
          type: "type",
        },
      ]);
      expect(typed.observation.headline).toBe(
        `Typed "${typedText}" into "Type here" and submitted`,
      );
      const afterTyping = await readReceipts(device);
      expect(afterTyping.filter(({ kind }) => kind === "set_text")).toEqual([
        expect.objectContaining({ detail: typedText }),
      ]);
      expect(typed.observation.tree).toContainEqual(
        expect.objectContaining({ role: "edittext", label: typedText }),
      );
      // Submit is `ACTION_IME_ENTER`, which Android delivers as the field's
      // `imeActionId`: 0 for a field that declares only `imeOptions`.
      expect(afterTyping.filter(({ kind }) => kind === "submit")).toEqual([
        expect.objectContaining({ detail: `0:${typedText}` }),
      ]);

      const scrolled = await actOk(agentA, refsA, typed.observation.observationId, [
        {
          amount: 1,
          direction: "down",
          target: { index: elementIndex(typed.observation, "textview", "Row 1") },
          type: "scroll",
        },
      ]);
      expect(scrolled.observation.headline).toMatch(/^Scrolled down/u);
      // The list records where it came to rest once its fling settles, after the act answered.
      const scrolls = await eventually(
        "the list to come to rest",
        async () => {
          const settled = (await readReceipts(device)).filter(({ kind }) => kind === "scrolled");
          return settled.length > 0 ? settled : undefined;
        },
        10_000,
        250,
      );
      await delay(1_000);
      expect((await readReceipts(device)).filter(({ kind }) => kind === "scrolled")).toEqual(
        scrolls,
      );
      expect(scrolls).toHaveLength(1);
      expect(Number(scrolls[0]!.detail)).toBeGreaterThan(1);

      const dragged = await actOk(agentA, refsA, scrolled.observation.observationId, [
        {
          durationMs: 600,
          from: { index: elementIndex(scrolled.observation, "textview", "Drag me") },
          holdMs: 800,
          to: { index: elementIndex(scrolled.observation, "textview", "Drop here") },
          type: "drag",
        },
      ]);
      expect(dragged.observation.headline).toMatch(/^Dragged "Drag me" to /u);
      const afterDrag = await readReceipts(device);
      expect(afterDrag.filter(({ kind }) => kind === "drag_start")).toEqual([
        expect.objectContaining({ detail: "true" }),
      ]);
      expect(afterDrag.filter(({ kind }) => kind === "drop")).toEqual([
        expect.objectContaining({ detail: "target" }),
      ]);

      const pressed = await actOk(agentA, refsA, dragged.observation.observationId, [
        {
          durationMs: 1_000,
          target: { index: elementIndex(dragged.observation, "textview", "Long-press me") },
          type: "longPress",
        },
      ]);
      expect(pressed.observation.headline).toBe('Long-pressed "Long-press me"');
      const all = await readReceipts(device);
      expect(counts(all)).toMatchObject({
        button_tap: 1,
        drag_start: 1,
        drop: 1,
        long_press: 1,
        scrolled: 1,
        submit: 1,
        set_text: 1,
      });
    });

    await step("a secure window is shared as Android pictures it, and still works", async () => {
      await clearReceipts(device);
      await device.shell(`am start -W -n ${fixtureActivities.secure}`);
      await untilShown(
        agentA,
        refsA,
        (await observe(agentA, refsA)).observation,
        "button",
        "Secure tap",
      );
      // The fixture's premise: Android keeps this window out of screenshots.
      expect(await windowIsSecure(fixtureActivities.secure)).toBe(true);
      const { observation, result } = await observe(agentA, refsA);
      expect(observation.foreground).toBe(`Agent Phone fixture (${fixturePackage})`);
      const [picture, ...others] = resultImages(result);
      expect(others).toEqual([]);
      expect(picture?.mimeType).toBe("image/jpeg");
      expect(jpegSize(picture!.data)).toEqual(observation.geometry);
      expect(resultText(result)).not.toMatch(/secure.content/iu);
      const tapped = await actOk(agentA, refsA, observation.observationId, [
        {
          count: 1,
          target: { index: elementIndex(observation, "button", "Secure tap") },
          type: "tap",
        },
      ]);
      expect(tapped.observation.headline).toBe('Tapped "Secure tap"');
      expect(resultText(tapped.result)).not.toMatch(/secure.content/iu);
      expect(actions(await readReceipts(device))).toEqual([
        expect.objectContaining({ detail: "", kind: "secure_tap" }),
      ]);
      await screenshot("secure-window-blacked-out-by-android");
    });

    await step("a stale observation runs nothing", async () => {
      const fixture = await openFixture(agentA, refsA);
      const before = actions(await readReceipts(device));
      const stale = await act(agentA, refsA, firstObservation, [
        {
          count: 1,
          target: { index: elementIndex(fixture, "button", "Record a tap") },
          type: "tap",
        },
      ]);
      expect(refusalOf(stale)).toBe(
        `Stopped. Observation ${firstObservation} is not this phone's latest; observe again.\nNothing was done. Observe the phone before acting further.`,
      );
      expect(actions(await readReceipts(device))).toEqual(before);
    });

    await step(
      "a batch near 40 s answers within its budget while a look queued behind it expires unrun",
      async () => {
        const fixture = await openFixture(agentA, refsA);
        await clearReceipts(device);
        const tap: AndroidPhoneAction = {
          count: 1,
          target: { index: elementIndex(fixture, "button", "Record a tap") },
          type: "tap",
        };
        // 39 s of waits between two taps: within a second of the most a batch may hold.
        const waits: AndroidPhoneAction[] = [
          ...Array.from({ length: 7 }, () => ({ ms: 5_000, type: "wait" as const })),
          { ms: 4_000, type: "wait" },
        ];
        const actedAt = Date.now();
        const acting = act(agentA, refsA, fixture.observationId, [tap, ...waits, tap]);
        await eventually(
          "the batch's first tap to reach the fixture",
          async () => (counts(await readReceipts(device)).button_tap === 1 ? true : undefined),
          10_000,
          200,
        );
        // The phone runs one look or batch at a time: this look waits behind
        // the batch past its own 30 s deadline.
        const queuedAt = Date.now();
        const queued = await call(agentA, "integration_call", { toolRef: refsA.observe });
        measurements.queuedObserveAnsweredMs = Date.now() - queuedAt;
        expect(refusalOf(queued)).toContain("The request expired before it ran.");
        expect(measurements.queuedObserveAnsweredMs).toBeLessThan(hostBudgetMs.observe);
        const acted = await acting;
        measurements.nearLimitBatchAnsweredMs = Date.now() - actedAt;
        if (acted.isError) throw new Error(`The batch failed: ${resultText(acted)}`);
        expect(measurements.nearLimitBatchAnsweredMs).toBeLessThan(hostBudgetMs.act);
        expect(counts(await readReceipts(device))).toEqual({ button_tap: 2 });
        // The expired look never ran, so the batch's own observation is still the latest.
        const latest = readObservation(resultText(acted));
        await actOk(agentA, refsA, latest.observationId, [{ to: "home", type: "navigate" }]);
      },
    );

    for (const labelKind of ["description", "hint"] as const) {
      for (const operation of ["type", "clear"] as const) {
        await step(
          `a rebound editor with a changed ${labelKind} refuses stale ${operation}`,
          async () => {
            await device.shell(
              `am start -W -f 0x10008000 -n ${fixtureActivities.rebound} --es labelKind ${labelKind}`,
            );
            const editor = await untilShown(
              agentA,
              refsA,
              (await observe(agentA, refsA)).observation,
              "edittext",
              "Keep me",
            );
            const index = elementIndex(editor, "edittext", "Keep me");
            await clearReceipts(device);
            await tapView(device, {
              activity: fixtureActivities.rebound,
              viewId: "fixture_rebind",
            });
            await eventually(
              "the same editor to represent the other field",
              async () =>
                (await readReceipts(device)).some(({ kind }) => kind === "rebound_label")
                  ? true
                  : undefined,
              10_000,
            );
            // No fresh observe: this act still cites the node before its label changed.
            const action: AndroidPhoneAction =
              operation === "type"
                ? { submit: false, target: { index }, text: "wrong field", type: "type" }
                : { target: { index }, type: "clear" };
            const refused = refusalOf(await act(agentA, refsA, editor.observationId, [action]));
            expect(refused).toContain(`Element [${index}]`);
            expect(refused).toContain("is no longer on screen; observe again.");
            expect(
              (await readReceipts(device)).filter(({ kind }) => kind === "rebound_text"),
            ).toEqual([]);
            const fresh = (await observe(agentA, refsA)).observation;
            expect(elementIndex(fresh, "edittext", "Keep me")).toEqual(index);
            await actOk(agentA, refsA, fresh.observationId, [{ target: { index }, type: "clear" }]);
            expect(
              (await readReceipts(device)).filter(({ kind }) => kind === "rebound_text"),
            ).toEqual([expect.objectContaining({ detail: "" })]);
            await screenshot(`rebound-${labelKind}-${operation}`);
          },
        );
      }
    }

    await step("an editor whose label stays the same accepts its updated text", async () => {
      await device.shell(
        `am start -W -f 0x10008000 -n ${fixtureActivities.rebound} --es labelKind description`,
      );
      const editor = await untilShown(
        agentA,
        refsA,
        (await observe(agentA, refsA)).observation,
        "edittext",
        "Keep me",
      );
      const index = elementIndex(editor, "edittext", "Keep me");
      await clearReceipts(device);
      await tapView(device, { activity: fixtureActivities.rebound, viewId: "fixture_change_text" });
      await eventually(
        "the owner to update the same field's text",
        async () =>
          (await readReceipts(device)).some(
            ({ kind, detail }) => kind === "rebound_text" && detail === "Updated ",
          )
            ? true
            : undefined,
        10_000,
      );
      await actOk(agentA, refsA, editor.observationId, [
        { submit: false, target: { index }, text: "accepted", type: "type" },
      ]);
      expect((await readReceipts(device)).filter(({ kind }) => kind === "rebound_text")).toEqual([
        expect.objectContaining({ detail: "Updated " }),
        expect.objectContaining({ detail: "Updated accepted" }),
      ]);
      await screenshot("same-editor-updated-text");
    });

    await step("the Opensteer app in front is hidden, and only leaving it runs", async () => {
      const before = actions(await readReceipts(device));
      await device.shell("input keyevent KEYCODE_WAKEUP");
      await device.shell(`am start -W -n ${agentPhoneActivities.main}`);
      await eventually(
        "the Opensteer app in front",
        async () => ((await activityResumed(device, agentPhoneActivities.main)) ? true : undefined),
        15_000,
      );
      const { observation, result } = await observe(agentA, refsA);
      expect(observation).toMatchObject({
        elementCount: 0,
        foreground: `Opensteer Agent Phone (${agentPhonePackageName})`,
        screen: "on",
        tree: [],
      });
      expect(resultImages(result)).toEqual([]);
      expect(resultText(result)).toContain(
        'The Opensteer Agent Phone app is in front. Agents may not see or operate it, so nothing of the screen is shared. Act with {"type":"navigate","to":"home"}, or launch another app, to continue.',
      );
      // A batch that would touch the app is refused whole: not even its Home runs.
      const refused = refusalOf(
        await act(agentA, refsA, observation.observationId, [
          { to: "home", type: "navigate" },
          { count: 1, target: { x: 10, y: 10 }, type: "tap" },
        ]),
      );
      expect(refused).toBe(
        "The Opensteer Agent Phone app is in front, and agents may not operate it. Navigate home or launch another app first.",
      );
      expect(
        refusalOf(
          await act(agentA, refsA, observation.observationId, [
            { packageName: agentPhonePackageName, type: "launch" },
          ]),
        ),
      ).toBe("Agents may not open the Opensteer Agent Phone app; launch another app.");
      expect(await activityResumed(device, agentPhoneActivities.main)).toBe(true);
      expect(actions(await readReceipts(device))).toEqual(before);
      // Leaving is always allowed, and the launcher is named as it names itself.
      await actOk(agentA, refsA, observation.observationId, [{ to: "home", type: "navigate" }]);
      const home = await observeOutsideOpensteer(agentA, refsA);
      const launcher = /^(.+) \(([^()]+)\)$/u.exec(home.foreground);
      expect(launcher, home.foreground).not.toBeNull();
      expect(launcher![2]).not.toBe(agentPhonePackageName);
      expect(launcher![1]).not.toBe(launcher![2]);
      expect(home.elementCount).toBeGreaterThan(0);
      expect(actions(await readReceipts(device))).toEqual(before);
    });

    // ---- 3. Concurrency ----------------------------------------------------
    const lunch = await createWorkspace("Lunch orders");
    const grantB = await grantPhone(runnerId, lunch, "read-write");
    let agentB = await startAgent(caller, { title: "Order lunch", workspaceId: lunch });
    let refsB!: PhoneToolRefs;

    await step("a second task finds the phone held and is told by whom", async () => {
      const row = await phoneRow(agentB, runnerId);
      expect(row).toMatchObject({ access: "read-write", inUse: true });
      expect(row.nextAction).toContain(
        `${phoneName} is already being used by another task. (Thread: Text the driver)`,
      );
      refsB = row.toolRefs!;
      const busy = refusalOf(await call(agentB, "integration_call", { toolRef: refsB.observe }));
      expect(busy).toContain(
        `${phoneName} is already being used by another task. (Thread: Text the driver)`,
      );
    });

    await step("release hands the phone over, and releasing nothing is fine", async () => {
      expect(resultText(await call(agentA, "integration_call", { toolRef: refsA.release }))).toBe(
        `Released ${phoneName}. Another task can use it now.`,
      );
      const seen = await observe(agentB, refsB);
      expect(seen.observation.headline).toBe(`Looked at ${phoneName}`);
      expect(resultText(await call(agentB, "integration_call", { toolRef: refsB.release }))).toBe(
        `Released ${phoneName}. Another task can use it now.`,
      );
      expect(resultText(await call(agentA, "integration_call", { toolRef: refsA.release }))).toBe(
        `This task was not holding ${phoneName}, so there was nothing to release.`,
      );
      await finish(agentB);
    });

    // ---- 4. Read-only ------------------------------------------------------
    await step("a read-only grant sees, cannot act, and can let go", async () => {
      const reading = await createWorkspace("Delivery tracking");
      await grantPhone(runnerId, reading, "read");
      const agentC = await startAgent(caller, {
        title: "Track the delivery",
        workspaceId: reading,
      });
      const row = await phoneRow(agentC, runnerId);
      expect(row).toMatchObject({ access: "read", approval: "approved" });
      expect(row.nextAction).toBe(
        `Call integration_call with the toolRefs: observe, and release when you are done so another task can use the phone. This task may only look at ${phoneName}; to act, ask with integration_request {kind: "computer-app", runnerId, access, reason} and access "read-write".`,
      );
      expect(Object.keys(row.toolRefs!).sort()).toEqual(["observe", "release"]);
      await sleepScreen();
      const { observation } = await observe(agentC, row.toolRefs!);
      expect(observation.screen).toBe("off");
      // The act toolRef another task holds is no authority here, and `wake` is an act.
      const refused = refusalOf(
        await call(agentC, "integration_call", {
          arguments: { actions: [{ type: "wake" }], observationId: observation.observationId },
          toolRef: refsA.act!,
        }),
      );
      expect(refused).toBe("Integration operation is no longer available; search again");
      expect(await screenIsOn()).toBe(false);
      expect(
        resultText(await call(agentC, "integration_call", { toolRef: row.toolRefs!.release })),
      ).toBe(`Released ${phoneName}. Another task can use it now.`);
      await finish(agentC);
      await finish(agentA);
    });

    // ---- 5. Stops and pause ------------------------------------------------
    const agentA2 = await startAgent(caller, { title: "Book the table", workspaceId: main });
    let refsA2!: PhoneToolRefs;
    const agentA3 = await startAgent(caller, { title: "Pay the bill", workspaceId: main });
    let refsA3 = await toolRefs(agentA3, runnerId);

    /** The waiting task's next Run takes the phone, then lets it go. */
    async function nextTaskTakesThePhone(): Promise<void> {
      refsA2 = await toolRefs(agentA2, runnerId);
      expect((await observe(agentA2, refsA2)).observation.headline).toBe(`Looked at ${phoneName}`);
      await call(agentA2, "integration_call", { toolRef: refsA2.release });
    }

    await step(
      "an agent unlocks a secure screen using observed keys and confirms a fixture receipt",
      async () => {
        const lockedAgent = await startAgent(caller, {
          title: "Unlock the phone",
          workspaceId: main,
        });
        const lockedRefs = await toolRefs(lockedAgent, runnerId);
        const credential = await stagePhonePin(device, redaction);
        const observations: PhoneObservationText[] = [];
        const look = async () => {
          const current = (await observe(lockedAgent, lockedRefs)).observation;
          observations.push(current);
          return current;
        };
        try {
          let current = await eventually(
            "secure phone locked with its screen off",
            async () => {
              const observed = await look();
              return observed.locked && observed.secureLock && observed.screen === "off"
                ? observed
                : undefined;
            },
            15_000,
          );
          expect(current).toMatchObject({ locked: true, secureLock: true, screen: "off" });
          await actOk(lockedAgent, lockedRefs, current.observationId, [{ type: "wake" }]);
          current = await eventually(
            "awake secure lock screen to draw",
            async () => {
              const observed = await look();
              return observed.screen === "on" && observed.locked && observed.elementCount > 0
                ? observed
                : undefined;
            },
            15_000,
          );
          await actOk(lockedAgent, lockedRefs, current.observationId, [
            {
              type: "swipe",
              from: {
                x: Math.floor(current.geometry.width / 2),
                y: Math.floor(current.geometry.height * 0.8),
              },
              to: {
                x: Math.floor(current.geometry.width / 2),
                y: Math.floor(current.geometry.height * 0.2),
              },
              durationMs: 200,
            },
          ]);
          current = await eventually(
            "observed PIN keypad",
            async () => {
              const observed = await look();
              return observed.tree.some(({ label }) =>
                /^1(?:\s+[A-Za-z]+)?$/u.test(label?.trim() ?? ""),
              )
                ? observed
                : undefined;
            },
            15_000,
          );
          // Indices plus the observed tree reconstruct a PIN, so omit entry arguments/results.
          sensitivePhoneEntry = true;
          for (const digit of credential.pin) {
            const key = current.tree.find(({ label }) =>
              new RegExp(`^${digit}(?:\\s+[A-Za-z]+)?$`, "u").test(label?.trim() ?? ""),
            );
            if (!key) throw new Error("The observed keypad is missing a required digit control");
            await actOk(lockedAgent, lockedRefs, current.observationId, [
              { type: "tap", count: 1, target: { index: key.index } },
            ]);
            current = await look();
          }
          const confirm = current.tree.find(({ label }) =>
            /^(?:enter|confirm|unlock|done|ok|return)$/iu.test(label?.trim() ?? ""),
          );
          if (!confirm)
            throw new Error(`No observed confirm control on secure keypad: ${current.treeText}`);
          await actOk(lockedAgent, lockedRefs, current.observationId, [
            { type: "tap", count: 1, target: { index: confirm.index } },
          ]);
          current = await eventually(
            "secure keyguard to unlock through agent actions",
            async () => {
              const observed = await look();
              return observed.locked ? undefined : observed;
            },
            15_000,
          );
          sensitivePhoneEntry = false;
          expect(current).toMatchObject({ locked: false, secureLock: true });
          const fixture = await openFixture(lockedAgent, lockedRefs);
          await clearReceipts(device);
          await actOk(lockedAgent, lockedRefs, fixture.observationId, [
            {
              type: "tap",
              count: 1,
              target: { index: elementIndex(fixture, "button", "Record a tap") },
            },
          ]);
          const receipts = await readReceipts(device);
          expect(counts(receipts), "one unlocked fixture tap must reach Android").toEqual({
            button_tap: 1,
          });
          await writeFile(
            join(artifactDirectory, "unlock-receipts.json"),
            JSON.stringify(receipts, null, 2) + "\n",
          );
        } finally {
          sensitivePhoneEntry = false;
          try {
            try {
              await credential.restore();
            } finally {
              await finish(lockedAgent);
            }
          } finally {
            await writeFile(
              join(artifactDirectory, "unlock-observations.json"),
              redaction.apply(
                JSON.stringify(
                  observations.map((observation) =>
                    observation.locked
                      ? { ...observation, tree: [], treeText: "[redacted keypad trace]" }
                      : observation,
                  ),
                  null,
                  2,
                ),
              ) + "\n",
            );
          }
        }
      },
    );

    await step(
      "Stop on the phone closes queued old work before another task takes it",
      async () => {
        const stoppedAgent = await startAgent(caller, {
          title: "Stop locally with observations in transit",
          workspaceId: main,
        });
        const stoppedRefs = await toolRefs(stoppedAgent, runnerId);
        const { acting } = await startWaitingBatch(stoppedAgent, stoppedRefs);
        const queued = Array.from({ length: 3 }, () =>
          call(stoppedAgent, "integration_call", { toolRef: stoppedRefs.observe }),
        );
        const recordStop = vi
          .spyOn(host.store, "recordComputerUseStop")
          .mockRejectedValueOnce(new Error("Injected temporary Stop-ledger outage"));
        try {
          await device.shell(`am start -W -n ${agentPhoneActivities.main}`);
          await tapView(device, { activity: agentPhoneActivities.main, viewId: "session_stop" });
          await eventually(
            "the local Stop to remove the Host's session",
            async () => ((await phoneSessions(runnerId)).length === 0 ? true : undefined),
            15_000,
          );
          await Promise.all([acting, ...queued]);
          expect(counts(await readReceipts(device))).toEqual({ button_tap: 1 });
          expect(
            refusalOf(
              await call(stoppedAgent, "integration_call", { toolRef: stoppedRefs.observe }),
            ),
          ).toBe(`Computer use was stopped for this task on ${phoneName}.`);
          await eventually(
            "the first Stop-ledger write to fail without claiming persistence",
            async () => (recordStop.mock.calls.length === 1 ? true : undefined),
            15_000,
          );
          expect(await host.store.activeComputerUseStops()).not.toContainEqual({
            runId: stoppedAgent.run.runId,
            runnerId,
          });
          const replayStarted = Date.now();
          await frontDoor.cut();
          await frontDoor.restore();
          await waitForOnline(runnerId, reconnectBudgetMs);
          await eventually(
            "the reconnected phone to replay its Stop into PostgreSQL",
            async () =>
              (await host.store.activeComputerUseStops()).some(
                (stop) => stop.runId === stoppedAgent.run.runId && stop.runnerId === runnerId,
              )
                ? true
                : undefined,
            reconnectBudgetMs,
          );
          expect(recordStop.mock.calls.length).toBeGreaterThanOrEqual(2);
          measurements.localStopReplayPersistedMs = Date.now() - replayStarted;
          await nextTaskTakesThePhone();
        } finally {
          recordStop.mockRestore();
        }
        await finish(stoppedAgent);
      },
    );

    await step("an owner's Stop the Host never heard survives the app being killed", async () => {
      const lostAgent = await startAgent(caller, {
        title: "Stop lost on the way",
        workspaceId: main,
      });
      const lostRefs = await toolRefs(lostAgent, runnerId);
      expect((await observe(lostAgent, lostRefs)).observation.headline).toBe(
        `Looked at ${phoneName}`,
      );
      const [before] = await agentPhonePids(device);
      expect(before).toEqual(expect.any(Number));
      // The link loses everything the phone sends from here on.
      frontDoor.dropFromPhone(true);
      try {
        await device.shell(`am start -W -n ${agentPhoneActivities.main}`);
        await tapView(device, { activity: agentPhoneActivities.main, viewId: "session_stop" });
        // The Stop is on disk before it is reported; only then is the app killed.
        await eventually(
          "the phone to keep the accepted Stop on disk",
          async () =>
            (
              await device.shell("run-as com.opensteer.agentphone cat shared_prefs/agent_phone.xml")
            ).includes(lostAgent.run.runId)
              ? true
              : undefined,
          15_000,
        );
        await device.shell(`su 0 kill -9 ${before}`);
        const after = await eventually(
          "Android to start the app again",
          async () => {
            const [pid] = await agentPhonePids(device);
            return pid !== undefined && pid !== before ? pid : undefined;
          },
          60_000,
        );
        appPids.add(after);
        expect(await host.store.activeComputerUseStops()).not.toContainEqual({
          runId: lostAgent.run.runId,
          runnerId,
        });
      } finally {
        await frontDoor.cut();
        frontDoor.dropFromPhone(false);
        await frontDoor.restore();
      }
      await waitForOnline(runnerId, reconnectBudgetMs);
      await eventually(
        "the Stop the restarted app kept to reach PostgreSQL",
        async () =>
          (await host.store.activeComputerUseStops()).some(
            (stop) => stop.runId === lostAgent.run.runId && stop.runnerId === runnerId,
          )
            ? true
            : undefined,
        reconnectBudgetMs,
      );
      expect(
        refusalOf(await call(lostAgent, "integration_call", { toolRef: lostRefs.observe })),
      ).toBe(`Computer use was stopped for this task on ${phoneName}.`);
      await device.shell("input keyevent KEYCODE_HOME");
      await nextTaskTakesThePhone();
      await finish(lostAgent);
    });

    await step("remote Watch Stop cancels a waiting batch before its later tap", async () => {
      const stoppedAgent = await startAgent(caller, {
        title: "Stop a waiting task",
        workspaceId: main,
      });
      const stoppedRefs = await toolRefs(stoppedAgent, runnerId);
      const { acting } = await startWaitingBatch(stoppedAgent, stoppedRefs);
      const [held] = await phoneSessions(runnerId);
      if (!held) throw new Error("The waiting task has no phone session to stop.");
      const stoppedAt = Date.now();
      await testRpcData(
        host.origin,
        "integration.computer.session.stop",
        { sessionId: held.sessionId },
        owner(),
      );
      expect(await phoneSessions(runnerId)).toEqual([]);
      expect(refusalOf(await acting)).toBe(
        `Computer use was stopped for this task on ${phoneName}.`,
      );
      expect(Date.now() - stoppedAt).toBeLessThan(promptStopMs);
      expect(counts(await readReceipts(device))).toEqual({ button_tap: 1 });
      expect(
        refusalOf(await call(stoppedAgent, "integration_call", { toolRef: stoppedRefs.observe })),
      ).toBe(`Computer use was stopped for this task on ${phoneName}.`);
      await nextTaskTakesThePhone();
      await finish(stoppedAgent);
    });

    await step("a Stop during a drag's hold lifts the finger where it pressed", async () => {
      const stoppedAgent = await startAgent(caller, {
        title: "Stop a drag mid-hold",
        workspaceId: main,
      });
      const stoppedRefs = await toolRefs(stoppedAgent, runnerId);
      const fixture = await openFixture(stoppedAgent, stoppedRefs);
      await clearReceipts(device);
      const acting = act(stoppedAgent, stoppedRefs, fixture.observationId, [
        {
          durationMs: 600,
          from: { index: elementIndex(fixture, "textview", "Drag me") },
          holdMs: 3_000,
          to: { index: elementIndex(fixture, "textview", "Drop here") },
          type: "drag",
        },
      ]);
      // The chip lifts under the held finger: Android's drag has begun.
      await eventually(
        "the held chip to start its drag",
        async () =>
          (await readReceipts(device)).some(({ kind }) => kind === "drag_start") ? true : undefined,
        3_000,
        100,
      );
      const [held] = await phoneSessions(runnerId);
      if (!held) throw new Error("The dragging task has no phone session to stop.");
      await testRpcData(
        host.origin,
        "integration.computer.session.stop",
        { sessionId: held.sessionId },
        owner(),
      );
      expect(refusalOf(await acting)).toBe(
        `Computer use was stopped for this task on ${phoneName}.`,
      );
      // Lifted where it pressed, the drag ends off its target; a finger left
      // down would end no drag at all.
      const drops = await eventually(
        "the stopped drag to end",
        async () => {
          const ended = (await readReceipts(device)).filter(({ kind }) => kind === "drop");
          return ended.length > 0 ? ended : undefined;
        },
        5_000,
        100,
      );
      expect(drops).toEqual([expect.objectContaining({ detail: "outside" })]);
      await nextTaskTakesThePhone();
      await finish(stoppedAgent);
    });

    await step("a person's Stop of a Run ends its phone batch at once", async () => {
      const stopped = await startAgent(caller, {
        title: "Stopped by its person",
        workspaceId: main,
      });
      const stoppedRefs = await toolRefs(stopped, runnerId);
      const { acting, laterTapDueAt } = await startWaitingBatch(stopped, stoppedRefs, 3);
      expect(await phoneSessions(runnerId)).toHaveLength(1);
      const stoppedAt = Date.now();
      // The Thread's Stop button: the Run's authority ends with its grant.
      await stopRun(host, stopped.run, `stop-${randomUUID()}`);
      await eventually(
        "the Host to end the stopped Run's phone session",
        async () => ((await phoneSessions(runnerId)).length === 0 ? true : undefined),
        promptStopMs,
        100,
      );
      measurements.runStopSessionEndedMs = Date.now() - stoppedAt;
      expect(refusalOf(await acting)).toContain("ended before this answer arrived");
      measurements.runStopBatchAnsweredMs = Date.now() - stoppedAt;
      expect(measurements.runStopBatchAnsweredMs).toBeLessThan(promptStopMs);
      // Past the moment its later tap was due, that tap never came.
      await delay(Math.max(0, laterTapDueAt - Date.now()) + 2_000);
      expect(counts(await readReceipts(device))).toEqual({ button_tap: 1 });
      // The Runner reports the interrupt landed, as it does after a Stop.
      await stopped.run.reportInterrupted();
      await stopped.gateway.close();
      await nextTaskTakesThePhone();
    });

    await step("a Run's replacement attempt keeps its own phone session", async () => {
      const restarting = await newCaller("caller-restarts", true);
      const restarted = await startAgent(restarting, {
        title: "Restarted mid-task",
        workspaceId: main,
      });
      const first = restarted.run.attempt;
      await lookAwake(restarted, await toolRefs(restarted, runnerId));
      const [superseded] = await phoneSessions(runnerId);
      if (!superseded) throw new Error("The first attempt holds no phone session.");
      // A steer restarts the Run: the first attempt's authority ends, and its session with it.
      const steer = { key: `restart-${randomUUID()}`, text: "Use the phone again." };
      expect(await steerRun(host, restarted.run, steer)).toEqual({ wasDuplicate: false });
      await eventually(
        "the superseded attempt's phone session to end",
        async () => ((await phoneSessions(runnerId)).length === 0 ? true : undefined),
        promptStopMs,
        100,
      );
      await restarted.run.reportInterrupted();
      const second = await restarted.run.startNextAttempt();
      expect(second.bindingGeneration).toBeGreaterThan(first.bindingGeneration);
      // The replacement's own bearer, as its Runner holds it.
      const issued = waitForMessage(
        restarting.primary.socket,
        (message) => message.type === "host.grants.credentials",
      );
      expect(await restarted.run.refreshCredentials()).toBe("issued");
      const token = IssuedCredentialsSchema.parse(await issued).result.credentials.integrationTools;
      redaction.add(token);
      const replacement: Agent = {
        gateway: await connectAgentGateway(host, {
          token,
          url: restarted.run.integrationTools.url,
        }),
        run: restarted.run,
        title: "Restarted mid-task, replacement attempt",
      };
      closers.push(() => replacement.gateway.close());
      const refs = await toolRefs(replacement, runnerId);
      const seen = await lookAwake(replacement, refs);
      const [own] = await phoneSessions(runnerId);
      expect(own?.sessionId).toEqual(expect.any(String));
      expect(own!.sessionId).not.toBe(superseded.sessionId);
      // Late word about the first attempt: its steer again, its end again.
      expect(await steerRun(host, restarted.run, steer)).toEqual({ wasDuplicate: true });
      await restarted.run.reportInterrupted(first);
      await delay(1_000);
      expect((await phoneSessions(runnerId)).map(({ sessionId }) => sessionId)).toEqual([
        own!.sessionId,
      ]);
      await actOk(replacement, refs, seen.observationId, [{ to: "home", type: "navigate" }]);
      expect(
        resultText(await call(replacement, "integration_call", { toolRef: refs.release })),
      ).toBe(`Released ${phoneName}. Another task can use it now.`);
      await finish(replacement);
      await restarted.gateway.close();
    });

    await step("pause on the phone stops agents and ends the session", async () => {
      refsA2 = await toolRefs(agentA2, runnerId);
      await lookAwake(agentA2, refsA2);
      expect(await phoneSessions(runnerId)).toHaveLength(1);
      await flipPause();
      await eventually(
        "the phone to say it is paused",
        async () => ((await readPhoneStatus(device)).paused ? true : undefined),
        15_000,
      );
      await eventually(
        "the Host to show the phone paused",
        async () => {
          const machine = await phoneMachine(runnerId);
          return machine?.computerUse?.state === "unavailable" ? machine : undefined;
        },
        15_000,
      ).then((machine) => {
        expect(machine.computerUse).toMatchObject({ detail: "Paused on the phone", sessions: [] });
      });
      // The task whose session the pause ended is told so, for observe and act alike.
      const stopped = `Computer use was stopped for this task on ${phoneName}.`;
      expect(refusalOf(await call(agentA2, "integration_call", { toolRef: refsA2.observe }))).toBe(
        stopped,
      );
      expect(
        refusalOf(await act(agentA2, refsA2, firstObservation, [{ to: "home", type: "navigate" }])),
      ).toBe(stopped);
      // A task that held nothing is refused too, while the phone is paused.
      const pausedObserve = refusalOf(
        await call(agentA3, "integration_call", { toolRef: refsA3.observe }),
      );
      const pausedAct = refusalOf(
        await act(agentA3, refsA3, firstObservation, [{ to: "home", type: "navigate" }]),
      );
      const paused = "Paused on the phone: its owner has stopped agents from using it.";
      expect(pausedObserve).toBe(paused);
      expect(pausedAct).toBe(paused);
      // What a task searching for the phone reads is a sentence about the phone.
      const search = resultText(
        await call(agentA3, "integration_search", { query: "Android phone" }),
      );
      expect(search).toContain(
        `${phoneName} is paused on the phone. The person can resume it there.`,
      );
      expect(search).not.toContain("Paused on the phone on");
      // Its app list still answers: listing is not control.
      expect(await phoneApps(agentA3, runnerId, "Agent Phone")).toMatchObject({
        apps: [{ label: "Agent Phone fixture", packageName: fixturePackage }],
        total: 1,
      });
      expect(await phoneSessions(runnerId)).toEqual([]);
    });

    await step("unpausing lets agents back", async () => {
      await flipPause();
      await eventually(
        "the phone to say it is not paused",
        async () => ((await readPhoneStatus(device)).paused ? undefined : true),
        15_000,
      );
      await waitForOnline(runnerId, 15_000);
      // The task the person stopped stays stopped; a new one may use the phone.
      expect(refusalOf(await call(agentA2, "integration_call", { toolRef: refsA2.observe }))).toBe(
        `Computer use was stopped for this task on ${phoneName}.`,
      );
      expect((await observe(agentA3, refsA3)).observation.headline).toBe(`Looked at ${phoneName}`);
      await finish(agentA2);
    });

    // ---- 6. Owner access commands -----------------------------------------
    await step("owner lowering, setup rerun and widening preserve the chosen access", async () => {
      // The owner narrows the phone to seeing only, which ends the session acting on it.
      const { acting } = await startWaitingBatch(agentA3, refsA3);
      const narrowedAt = Date.now();
      const narrowed = await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          idempotencyKey: `narrow-${randomUUID()}`,
          input: {
            access: "read",
            app: null,
            definitionId: androidPhoneDefinitionId,
            kind: "app",
            runnerId,
          },
          type: "integration.computer.setup.set",
        },
        owner(),
      );
      expect(narrowed.type).toBe("integration.computer.setup.set");
      expect(await phoneSessions(runnerId)).toEqual([]);
      expect(refusalOf(await acting)).toContain("ended before this answer arrived");
      expect(Date.now() - narrowedAt).toBeLessThan(promptStopMs);
      expect(counts(await readReceipts(device))).toEqual({ button_tap: 1 });
      const narrow = await phoneRow(agentA3, runnerId);
      expect(narrow).toMatchObject({ access: "read" });
      expect(Object.keys(narrow.toolRefs!).sort()).toEqual(["observe", "release"]);
      const asked = resultJson(
        await call(agentA3, "integration_request", {
          access: "read-write",
          kind: "computer-app",
          reason: "Pay the restaurant bill.",
          runnerId,
        }),
      );
      expect(asked).toMatchObject({ kind: "computer.app.access", status: "pending" });
      const setup = await runAgentPhoneSetup({
        artifact,
        device,
        host,
        redaction,
        runnerName: phoneName,
        timeoutMs: 120_000,
      });
      expect(setup.outcome, "setup rerun completes after owner lowered access").toBe("done");
      expect(
        (await phoneConnection(runnerId))?.computer?.access,
        "setup must preserve owner-lowered read access",
      ).toBe("read");
      await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          type: "integration.computer.setup.set",
          idempotencyKey: randomUUID(),
          input: {
            kind: "app",
            definitionId: androidPhoneDefinitionId,
            runnerId,
            app: null,
            access: "read-write",
          },
        },
        owner(),
      );
      await assertNoPhoneApprovalActivity(device);
      await eventually(
        "the phone to allow control again",
        async () =>
          (await phoneConnection(runnerId))?.computer?.access === "read-write" ? true : undefined,
        30_000,
      );
      const widened = await phoneRow(agentA3, runnerId);
      expect(widened).toMatchObject({ access: "read-write", approval: "approved" });
      refsA3 = widened.toolRefs!;
      expect(refsA3.act).toEqual(expect.any(String));
      const awake = await lookAwake(agentA3, refsA3);
      await actOk(agentA3, refsA3, awake.observationId, [{ to: "home", type: "navigate" }]);
    });

    // ---- 7. Network loss and unreadable frames ---------------------------
    await step(
      "a network cut mid-act is never a silent success, and the phone comes back",
      async () => {
        const fixture = await openFixture(agentA3, refsA3);
        await clearReceipts(device);
        const acting = act(agentA3, refsA3, fixture.observationId, [
          {
            count: 1,
            target: { index: elementIndex(fixture, "button", "Record a tap") },
            type: "tap",
          },
          { ms: 5_000, type: "wait" },
          { ms: 5_000, type: "wait" },
          { ms: 5_000, type: "wait" },
        ]);
        await eventually(
          "the tap to land",
          async () =>
            (await readReceipts(device)).some(({ kind }) => kind === "button_tap")
              ? true
              : undefined,
          20_000,
          200,
        );
        await frontDoor.cut();
        expect(refusalOf(await acting)).toBe(
          "That computer went offline. The actions may already have taken effect. Do not repeat them. Observe the phone before deciding the next action.",
        );
        await delay(5_000);
        const restored = Date.now();
        await frontDoor.restore();
        await waitForOnline(runnerId, reconnectBudgetMs);
        const reconnectedMs = Date.now() - restored;
        expect(reconnectedMs).toBeLessThanOrEqual(reconnectBudgetMs);
        const after = await observe(agentA3, refsA3);
        expect(after.observation.headline).toBe(`Looked at ${phoneName}`);
        await delay(2_000);
        expect(counts(await readReceipts(device))).toEqual({ button_tap: 1 });
      },
    );

    /**
     * The door slips frames the phone cannot read into each new connection
     * at `at`, then the connection is cut so the phone dials through it.
     */
    async function withUnreadableFrames(at: FrameInjection["at"]): Promise<void> {
      const [pid] = await agentPhonePids(device);
      expect(pid).toEqual(expect.any(Number));
      const injectedBefore = frontDoor.injected;
      frontDoor.inject({ at, frames: unreadableFrameTexts });
      try {
        await frontDoor.cut();
        await frontDoor.restore();
        const status = await eventually(
          "the phone to report a protocol error",
          async () => {
            const current = await readPhoneStatus(device);
            return current.issue?.code === "protocol-error" ? current : undefined;
          },
          180_000,
          250,
        );
        expect(status.pairing).toMatchObject({ runnerId });
        expect(frontDoor.injected - injectedBefore).toBeGreaterThanOrEqual(2);
        // Still the same process, and Android still has its service bound.
        expect(await agentPhonePids(device)).toEqual([pid]);
        expect(await accessibilityServiceBound()).toBe(true);
        if (at === "upgrade") {
          // Never welcomed, so its owner's Computers page shows it offline.
          expect(status.connection).not.toBe("online");
          await eventually(
            "the Host to list the phone offline",
            async () => ((await phoneMachine(runnerId))?.status === "online" ? undefined : true),
            30_000,
          );
        }
        // What the owner reads on the phone meanwhile.
        await device.shell("input keyevent KEYCODE_WAKEUP");
        await device.shell(`am start -W -n ${agentPhoneActivities.main}`);
        await screenshotThemes(`main-protocol-error-${at}`, agentPhoneActivities.main);
        await device.shell("input keyevent KEYCODE_HOME");
      } finally {
        frontDoor.inject(null);
      }
      // The Host speaks clearly again: back by itself, as the same process and identity.
      await waitForOnline(runnerId, protocolRecoveryBudgetMs);
      expect(await agentPhonePids(device)).toEqual([pid]);
      expect(await readPhoneStatus(device)).toMatchObject({
        connection: "online",
        issue: null,
        pairing: { enrollmentId, runnerId },
      });
      expect((await observe(agentA3, refsA3)).observation.headline).toBe(`Looked at ${phoneName}`);
    }

    await step("frames the phone cannot read on connecting never crash it", () =>
      withUnreadableFrames("upgrade"),
    );

    await step("a frame it cannot read after its stream is welcomed is the same error", () =>
      withUnreadableFrames("stream-welcome"),
    );

    await step("retarget status never calls an unreachable new target online", async () => {
      const target = await testRpcData(host.origin, "agentPhone.target.get", {}, owner());
      const unreachable = `https://${emulatorHostAlias}:${await freePort()}`;
      const applied = await retargetPhone(device, { ...target, hostUrl: unreachable });
      expect(applied.code).toBe(-1);
      expect(applied.status.pairing).toMatchObject({ hostUrl: unreachable, runnerId });
      expect(applied.status.connection).not.toBe("online");
      await eventually(
        "the new target's unreachable issue without an old Online report",
        async () => {
          const status = await readPhoneStatus(device);
          expect(status.pairing).toMatchObject({ hostUrl: unreachable, runnerId });
          expect(status.connection).not.toBe("online");
          return status.issue?.code === "host-unreachable" ? true : undefined;
        },
        45_000,
        200,
      );
      expect((await retargetPhone(device, target)).code).toBe(-1);
      await eventually(
        "the original target to reconnect as the same phone",
        async () => {
          const status = await readPhoneStatus(device);
          return status.connection === "online" &&
            status.pairing?.hostUrl === target.hostUrl &&
            status.pairing.runnerId === runnerId &&
            status.issue === null
            ? true
            : undefined;
        },
        reconnectBudgetMs,
      );
      await waitForOnline(runnerId, reconnectBudgetMs);
      expect((await observe(agentA3, refsA3)).observation.headline).toBe(`Looked at ${phoneName}`);
    });

    // ---- 7b. A moved address -----------------------------------------------
    let movedTo = "";
    await step("a moved address is adopted over USB, keeping the phone's identity", async () => {
      const port = await freePort();
      secondDoor = await startTlsFrontDoor({ authority, hostPort: host.hostPort, port });
      const target = await testRpcData(host.origin, "agentPhone.target.get", {}, owner());
      expect(target).toEqual({
        deploymentId,
        deploymentName: new URL(host.publicOrigin).hostname,
        hostInstanceId: expect.any(String),
        hostUrl: host.publicOrigin,
      });
      movedTo = `https://${emulatorHostAlias}:${port}`;
      // What setup sends when the Host's route moved, here to a second door to the same Host.
      expect((await retargetPhone(device, { ...target, hostUrl: movedTo })).code).toBe(-1);
      // The old address goes dead; only the new one can bring the phone back.
      await frontDoor.cut();
      await waitForOnline(runnerId, reconnectBudgetMs);
      expect(await readPhoneStatus(device)).toMatchObject({
        connection: "online",
        issue: null,
        pairing: { deploymentId, enrollmentId, hostUrl: movedTo, runnerId },
      });
      // Another Deployment's phone is not moved, and nothing about this one changes.
      expect(
        (
          await retargetPhone(device, {
            ...target,
            deploymentId: DeploymentIdSchema.parse("dep_00000000-0000-4000-8000-000000000000"),
            hostUrl: host.publicOrigin,
          })
        ).code,
      ).toBe(2);
      const phones = (await testRpcData(host.origin, "machines.list", {}, owner())).machines.filter(
        (machine) => machine.device?.form === "phone",
      );
      expect(phones.map(({ id, status }) => ({ id, status }))).toEqual([
        { id: runnerId, status: "online" },
      ]);
      expect((await observe(agentA3, refsA3)).observation.headline).toBe(`Looked at ${phoneName}`);
    });

    await step("setup moves the phone back to its Host's address, minting nothing", async () => {
      await frontDoor.restore();
      const minted: string[] = [];
      const result = await runAgentPhoneSetup({
        artifact,
        device,
        host,
        onMinted: (enrollment) => minted.push(enrollment.enrollmentId),
        redaction,
        runnerName: phoneName,
        timeoutMs: 300_000,
      });
      expect(result).toMatchObject({ outcome: "done", runnerId });
      expect(minted).toEqual([]);
      expect(await readPhoneStatus(device)).toMatchObject({
        connection: "online",
        pairing: { deploymentId, enrollmentId, hostUrl: host.publicOrigin, runnerId },
      });
      await secondDoor?.close();
      secondDoor = null;
      await waitForOnline(runnerId, reconnectBudgetMs);
      expect((await observe(agentA3, refsA3)).observation.headline).toBe(`Looked at ${phoneName}`);
    });

    // ---- 8. Host restart ---------------------------------------------------
    let agentE!: Agent;
    let refsE!: PhoneToolRefs;
    await step("the phone reconnects to a restarted Host by itself", async () => {
      for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
      await host.restart();
      await waitForOnline(runnerId, reconnectBudgetMs);
      const restartedCaller = await newCaller("caller-2");
      agentE = await startAgent(restartedCaller, { title: "After the restart", workspaceId: main });
      refsE = await toolRefs(agentE, runnerId);
      const fixture = await openFixture(agentE, refsE);
      await clearReceipts(device);
      await actOk(agentE, refsE, fixture.observationId, [
        {
          count: 1,
          target: { index: elementIndex(fixture, "button", "Record a tap") },
          type: "tap",
        },
      ]);
      expect(counts(await readReceipts(device))).toEqual({ button_tap: 1 });
    });

    // ---- 9. Process death --------------------------------------------------
    await step("a killed app process comes back by itself", async () => {
      const [before] = await agentPhonePids(device);
      expect(before).toEqual(expect.any(Number));
      await device.shell(`su 0 kill -9 ${before}`);
      const after = await eventually(
        "Android to start the app again",
        async () => {
          const [pid] = await agentPhonePids(device);
          return pid !== undefined && pid !== before ? pid : undefined;
        },
        60_000,
      );
      appPids.add(after);
      await waitForOnline(runnerId, reconnectBudgetMs);
      expect((await observe(agentE, refsE)).observation.headline).toBe(`Looked at ${phoneName}`);
    });

    // ---- 10. Reboot gate ---------------------------------------------------
    for (let index = 1; index <= reboots; index += 1) {
      await step(
        `reboot ${index} of ${reboots}: back at work with nobody touching it`,
        async () => {
          const started = Date.now();
          await deviceLog?.stop();
          const { bootedMs } = await rebootDevice(device);
          await deviceLog?.start();
          await waitForOnline(runnerId, rebootOnlineBudgetMs);
          const onlineMs = Date.now() - started;
          expect(onlineMs - bootedMs).toBeLessThanOrEqual(rebootOnlineBudgetMs);
          const before = counts(await readReceipts(device)).button_tap ?? 0;
          const fixture = await openFixture(agentE, refsE);
          await actOk(agentE, refsE, fixture.observationId, [
            {
              count: 1,
              target: { index: elementIndex(fixture, "button", "Record a tap") },
              type: "tap",
            },
          ]);
          expect(counts(await readReceipts(device)).button_tap).toBe(before + 1);
          rebootTimings.push({ actedMs: Date.now() - started, bootedMs, index, onlineMs });
        },
      );
    }

    // ---- 11. Revoke --------------------------------------------------------
    await step("revoking a holding Workspace's grant ends its session at once", async () => {
      const restartedCaller = await newCaller("caller-3");
      agentB = await startAgent(restartedCaller, {
        title: "Order lunch again",
        workspaceId: lunch,
      });
      refsB = await toolRefs(agentB, runnerId);
      expect(resultText(await call(agentE, "integration_call", { toolRef: refsE.release }))).toBe(
        `Released ${phoneName}. Another task can use it now.`,
      );
      const { acting, observationId } = await startWaitingBatch(agentB, refsB);
      expect(await phoneSessions(runnerId)).toHaveLength(1);
      const revokedAt = Date.now();
      const revoked = await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          grantId: grantB.id,
          idempotencyKey: `revoke-${randomUUID()}`,
          type: "integration.grant.revoke",
          workspaceId: lunch,
        },
        owner(),
      );
      expect(revoked.type).toBe("integration.grant.revoke");
      expect(await phoneSessions(runnerId)).toEqual([]);
      expect(refusalOf(await acting)).toContain("ended before this answer arrived");
      expect(Date.now() - revokedAt).toBeLessThan(promptStopMs);
      expect(counts(await readReceipts(device))).toEqual({ button_tap: 1 });
      expect(
        refusalOf(await act(agentB, refsB, observationId, [{ to: "home", type: "navigate" }])),
      ).toBe("Integration operation is no longer available; search again");
    });

    // ---- 12. Remove --------------------------------------------------------
    await step("removing the computer wipes the phone's identity", async () => {
      await revokeMachine(host, { key: `remove-${randomUUID()}`, runnerId });
      const status = await eventually(
        "the phone to say it was removed",
        async () => {
          const current = await readPhoneStatus(device);
          return current.connection === "removed" ? current : undefined;
        },
        30_000,
      );
      expect(status).toMatchObject({
        connection: "removed",
        issue: { code: "removed" },
        pairing: null,
      });
      expect(await phoneMachine(runnerId)).toBeNull();
      await device.shell("input keyevent KEYCODE_WAKEUP");
      await device.shell(`am start -W -n ${agentPhoneActivities.main}`);
      await eventually(
        "the app to show it was removed",
        async () => ((await activityResumed(device, agentPhoneActivities.main)) ? true : undefined),
        15_000,
      );
      await screenshotThemes("main-removed", agentPhoneActivities.main);
    });

    completed = true;
  });
});

/** Keeps the in-process Host's console output for the artifact, still printing it. */
function captureConsole(sink: string[]): () => void {
  const methods = ["debug", "error", "info", "log", "warn"] as const;
  const originals = methods.map((method) => [method, console[method]] as const);
  for (const [method, original] of originals) {
    console[method] = (...values: unknown[]) => {
      sink.push(
        `${new Date().toISOString()} ${method} ${values
          .map((value) =>
            value instanceof Error ? `${value.message}\n${value.stack ?? ""}` : String(value),
          )
          .join(" ")}`,
      );
      original.apply(console, values);
    };
  }
  return () => {
    for (const [method, original] of originals) console[method] = original;
  };
}
