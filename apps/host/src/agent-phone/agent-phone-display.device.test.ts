import { createDatabase } from "@opensteer/database";
/**
 * Acceptance written against the locked live-display contract before runtime
 * implementations. Real device journeys, never a fake phone or fake media source.
 * The existing device config discovers this file; default Vitest excludes it.
 */
import { randomInt, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerId } from "@opensteer/core";
import {
  RunnerDescriptorSchema,
  RunnerIntegrationsDisplayStateSchema,
  RunnerIntegrationsComputerUseResultSchema,
  RunnerIntegrationsDisplayInputResultSchema,
  agentPhonePackageName,
  androidPhoneDefinitionId,
  androidIntegrationsProtocolVersion,
  displayDemandGraceMs,
  hostApiVersionHeader,
  type AndroidPhoneAction,
  type ComputerViewId,
  type DisplayInputEvent,
  type DisplayViewerState,
} from "@opensteer/protocol";
import { delay } from "@opensteer/shared/delay";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import WebSocket from "ws";
import {
  createMachineAccessDatabase,
  freePort,
  signUpUser,
  stopRun,
} from "../runtime/machine-access.test-support.js";
import { testRpcData } from "../server/test-host-api-request.js";
import {
  assertNoPhoneApprovalActivity,
  writeDeviceTestManifest,
  DeviceLog,
  Redaction,
  acquireAndroidDevice,
  activityResumed,
  agentPhoneActivities,
  agentPhonePids,
  buildE2eAgentPhone,
  clearReceipts,
  connectAgentComputer,
  createTestCertificateAuthority,
  deviceFacts,
  elementIndex,
  eventually,
  findView,
  fixtureActivities,
  installFixture,
  resultJson,
  readObservation,
  readPhoneStatus,
  readReceipts,
  rebootDevice,
  repositoryRoot,
  resetPhone,
  resultText,
  runAgentPhoneSetup,
  runCommand,
  sha256Hex,
  startAgentPhoneHost,
  startPhoneAgent,
  startTlsFrontDoor,
  tapView,
  waitForPhoneOnline,
  type AndroidDevice,
  type PhoneObservationText,
  type Receipt,
  type ToolResult,
} from "./agent-phone-device.test-support.js";
import {
  ComputerDisplayViewer,
  displayRates,
  parseDragPath,
  type ReceivedFrame,
} from "./agent-phone-display.test-support.js";
import { runExpoPhoneDisplayJourney } from "./agent-phone-expo.test-support.js";

const api = Number(process.env.OPENSTEER_AGENT_PHONE_API ?? "36");
const Pointer = z.object({ x: z.number(), y: z.number() });

const journeyRedaction = new Redaction();

it.each([
  { name: "live phone display and shared input", editingOnly: false },
  { name: "native phone editing", editingOnly: true },
])(`$name on Android API ${api}`, async ({ editingOnly }) => {
  const base =
    process.env.OPENSTEER_AGENT_PHONE_E2E_ARTIFACT_DIR ??
    (await mkdtemp(join(tmpdir(), "opensteer-phone-display-")));
  // Other device files may share the supplied artifact root; never erase it.
  const directory = join(base, `${editingOnly ? "editing" : "display"}-api${api}-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  process.stdout.write(`Agent Phone display artifact: ${directory}\n`);
  const scratch = await mkdtemp(join(tmpdir(), "opensteer-phone-display-scratch-"));
  const redaction = journeyRedaction;
  const cleanup: (() => Promise<void>)[] = [];
  const cleanupFailures: string[] = [];
  const phases: {
    name: string;
    startedMs: number;
    endedMs: number;
    status: string;
    error?: string;
  }[] = [];
  const evidence: Record<string, unknown> = {};
  const hostLog: string[] = [];
  const transcript: unknown[] = [];
  const viewers: ComputerDisplayViewer[] = [];
  const phoneStates: {
    receivedMs: number;
    display: "main";
    streamId: string;
    state: string;
    generation: number;
    reason?: string;
  }[] = [];
  const phoneInputs: z.infer<typeof RunnerIntegrationsDisplayInputResultSchema>[] = [];
  const descriptors: z.infer<typeof RunnerDescriptorSchema>[] = [];
  const ingressErrors: string[] = [];
  const phoneRefusals: { requestId: string; code: string; receivedMs: number }[] = [];
  let device: AndroidDevice | undefined;
  let deviceLog: DeviceLog | undefined;
  let receipts: readonly Receipt[] = [];
  let completed = false;
  let failure: string | null = null;

  async function json(name: string, data: unknown) {
    await writeFile(join(directory, name), `${redaction.apply(JSON.stringify(data, null, 2))}\n`);
  }
  async function decodedPixels(
    name: string,
    frame: ReceivedFrame,
    black = false,
    following: readonly ReceivedFrame[] = [],
  ) {
    const input = join(directory, `${name}.h264`);
    const png = join(directory, `${name}-decoded.png`);
    const pictures = [frame, ...following];
    const selected = `select=eq(n\\,${pictures.length - 1})`;
    await writeFile(input, Buffer.concat(pictures.map((picture) => picture.payload)));
    await runCommand("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-i",
      input,
      "-vf",
      selected,
      "-frames:v",
      "1",
      png,
    ]);
    const pixels = await runCommand(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        input,
        "-vf",
        `${selected},format=rgb24,crop=iw/2:ih/2:iw/4:ih/4:exact=1`,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-",
      ],
      { output: "buffer" },
    );
    expect(pixels.length).toBeGreaterThan(0);
    const maxima = [0, 0, 0];
    const sums = [0, 0, 0];
    for (let index = 0; index < pixels.length; index++) {
      const channel = index % 3;
      maxima[channel] = Math.max(maxima[channel]!, pixels[index]!);
      sums[channel] = sums[channel]! + pixels[index]!;
    }
    const mean = sums.map((sum) => sum / (pixels.length / 3));
    evidence[`${name}-pixels`] = {
      header: pictures.at(-1)!.header,
      maxima,
      mean,
      independentDecoder: "ffmpeg",
    };
    if (black) expect(Math.max(...maxima), "protected central pixels are black").toBeLessThan(8);
    else expect(Math.max(...mean), "real fixture pixels are visible").toBeGreaterThan(8);
  }
  async function flush() {
    await json("display.json", {
      scenario: editingOnly ? "phone-native-editing" : "phone-live-display-owner-control",
      api,
      completed,
      failure,
      outcome: failure || cleanupFailures.length ? "failed" : completed ? "passed" : "running",
      phases,
      evidence,
      cleanupFailures,
      phoneStates,
      phoneInputs,
      ingressErrors,
      phoneRefusals,
      latencyBasis:
        "Phone ptsUs has no clock mapping to this process; receive cadence is reported, not absolute capture latency.",
      viewers: viewers.map((viewer) => ({
        openedMs: viewer.openedMs,
        closed: viewer.closed,
        failure: viewer.failure ? redaction.error(viewer.failure) : null,
        firstFrameMs: viewer.trace.frames[0]
          ? viewer.trace.frames[0].receivedMs - viewer.openedMs
          : null,
        keyframeSizes: viewer.trace.frames
          .filter((frame) => frame.header.key)
          .map((frame) => frame.bytes),
        events: viewer.trace.events.map((event) =>
          event.kind === "frame"
            ? {
                kind: event.kind,
                ...event.frame.header,
                receivedMs: event.frame.receivedMs,
                bytes: event.frame.bytes,
                wireBytes: event.frame.wireBytes,
                nalTypes: event.frame.nalTypes,
              }
            : event,
        ),
        sent: viewer.sent,
      })),
    });
    await json("receipts.json", receipts);
    await json("agent-transcript.json", transcript);
    await writeFile(join(directory, "host.log"), redaction.apply(hostLog.join("\n")));
  }
  async function phase<T>(name: string, run: () => Promise<T>): Promise<T> {
    const record: (typeof phases)[number] = {
      name,
      startedMs: performance.now(),
      endedMs: 0,
      status: "running",
    };
    phases.push(record);
    await flush();
    try {
      const value = await run();
      viewers.forEach((viewer) => viewer.check());
      expect(ingressErrors).toEqual([]);
      record.status = "passed";
      return value;
    } catch (error) {
      record.status = "failed";
      record.error = redaction.error(error);
      throw error;
    } finally {
      record.endedMs = performance.now();
      if (device) {
        receipts = await readReceipts(device).catch(() => receipts);
        await device
          .screencap()
          .then((bytes) => writeFile(join(directory, `${phases.length}-${name}.png`), bytes))
          .catch((error: unknown) => {
            evidence[`screenshot-error-${phases.length}`] = redaction.error(error);
          });
      }
      await flush();
    }
  }

  try {
    const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
    if (!databaseUrl) throw new Error("Run with pnpm test:agent-phone to provision PostgreSQL.");
    const authority = await createTestCertificateAuthority(scratch);
    evidence.testCaSha256 = authority.caSha256;
    const build = await buildE2eAgentPhone({ authority, log: join(directory, "build.log") });
    evidence.apk = build.manifest;
    evidence.fixtureSha256 = build.fixtureSha256;
    evidence.revision = (
      await runCommand("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot })
    ).trim();
    const isolated = await createMachineAccessDatabase(databaseUrl);
    cleanup.push(() => isolated.drop());
    const publicPort = await freePort();
    const host = await startAgentPhoneHost(isolated.url, {
      publicPort,
      signupPolicy: "open",
      log: (line) => hostLog.push(line),
    });
    cleanup.push(() => host.close());
    redaction.add(...Object.values(host.ownerHeaders));
    evidence.publicOrigin = host.publicOrigin;
    // Observe real incoming wire messages without replacing a handler. This
    // also sees stopped after the last viewer is gone; STATUS has no display field.
    const observedSockets = new WeakSet<WebSocket>();
    const observeSocket = (socket: WebSocket) => {
      if (observedSockets.has(socket)) return;
      observedSockets.add(socket);
      socket.on("message", (data, binary) => {
        if (binary) return;
        try {
          const bytes = Array.isArray(data)
            ? Buffer.concat(data)
            : data instanceof ArrayBuffer
              ? Buffer.from(data)
              : data;
          const value: unknown = JSON.parse(bytes.toString());
          const tagged = z
            .object({ type: z.string(), descriptor: z.unknown().optional() })
            .parse(value);
          if (tagged.descriptor) descriptors.push(RunnerDescriptorSchema.parse(tagged.descriptor));
          if (tagged.type === "runner.integrations.computer-use-result") {
            const { requestId, result } = RunnerIntegrationsComputerUseResultSchema.parse(value);
            const code =
              result.kind === "error"
                ? result.code
                : z
                    .object({ error: z.object({ code: z.string() }).nullable().optional() })
                    .parse(result.value).error?.code;
            if (code) phoneRefusals.push({ requestId, code, receivedMs: performance.now() });
          }
          if (tagged.type === "runner.integrations.display.state") {
            const { display, streamId, state, generation, reason } =
              RunnerIntegrationsDisplayStateSchema.parse(value);
            phoneStates.push({
              receivedMs: performance.now(),
              display,
              streamId,
              state,
              generation,
              ...(reason ? { reason } : {}),
            });
          }
          if (tagged.type === "runner.integrations.display.input-result")
            phoneInputs.push(RunnerIntegrationsDisplayInputResultSchema.parse(value));
        } catch (error) {
          ingressErrors.push(redaction.error(error));
        }
      });
    };
    const observePhoneWire = () => {
      const server = host.runtime.app.websocketServer;
      server.clients.forEach(observeSocket);
      server.on("connection", observeSocket);
    };
    observePhoneWire();
    const frontDoor = await startTlsFrontDoor({
      authority,
      hostPort: host.hostPort,
      port: publicPort,
    });
    cleanup.push(() => frontDoor.close());
    async function oldTicketRefused(ticket: string) {
      redaction.add(ticket);
      const url = new URL("/internal/v1/computer-use/display", host.origin);
      url.protocol = "ws:";
      const status = await new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(url, { headers: { authorization: `Bearer ${ticket}` } });
        socket.on("unexpected-response", (_request, response) => {
          response.resume();
          socket.terminate();
          resolve(response.statusCode ?? 0);
        });
        socket.on("open", () => {
          socket.close();
          reject(new Error("Consumed display ticket reopened a data socket"));
        });
        socket.on("error", () => undefined);
        setTimeout(() => {
          socket.terminate();
          reject(new Error("Display ticket refusal timed out"));
        }, 5_000).unref();
      });
      expect(status).toBe(403);
    }
    if (process.env.ANDROID_SERIAL && !/^emulator-\d+$/u.test(process.env.ANDROID_SERIAL))
      throw new Error("Display acceptance requires an emulator serial.");
    const phone = await acquireAndroidDevice({ api, emulatorLog: join(directory, "emulator.log") });
    device = phone;
    cleanup.push(() => phone.close());
    deviceLog = new DeviceLog(phone);
    await deviceLog.start();
    evidence.device = await deviceFacts(phone);
    const owner = { headers: host.ownerHeaders };
    let runnerId!: RunnerId;
    const machine = async () =>
      (await testRpcData(host.origin, "machines.list", {}, owner)).machines.find(
        (row) => row.id === runnerId,
      );
    const sessions = async () => (await machine())?.computerUse?.sessions ?? [];
    async function ownerView() {
      const opened = await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          type: "computer.view.open",
          machineId: runnerId,
          target: { kind: "phone", display: "main" },
          idempotencyKey: randomUUID(),
        },
        owner,
      );
      if (opened.type !== "computer.view.open") throw new Error("Owner command mismatch");
      const source = {
        kind: "owner-view" as const,
        viewId: opened.view.viewId,
        generation: opened.view.generation,
      };
      const view = new ComputerDisplayViewer(host, source);
      viewers.push(view);
      cleanup.push(() => view.close());
      return { source, view, expiresAt: opened.view.expiresAt };
    }
    async function closeOwner(source: { viewId: ComputerViewId; generation: number }) {
      await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          type: "computer.view.close",
          viewId: source.viewId,
          generation: source.generation,
          idempotencyKey: randomUUID(),
        },
        owner,
      );
    }

    await phase("setup-and-capture-grant", async () => {
      await resetPhone(phone);
      await installFixture(phone);
      const setup = await runAgentPhoneSetup({
        artifact: build.artifact,
        device: phone,
        host,
        redaction,
        runnerName: "Display acceptance phone",
        timeoutMs: 600_000,
      });
      if (setup.outcome !== "done") throw new Error(`Setup stopped: ${JSON.stringify(setup)}`);
      runnerId = setup.runnerId;
      await waitForPhoneOnline(phone, host, runnerId, 60_000);
      const appOps = await phone.shell(`appops get ${agentPhonePackageName} PROJECT_MEDIA`);
      evidence.projectMediaAppOp = appOps;
      expect(appOps).toMatch(/PROJECT_MEDIA:\s*allow\b/u);
      const descriptor = descriptors.findLast((row) => row.runnerId === runnerId);
      evidence.phoneDescriptor = descriptor;
      expect(descriptor?.modules.integrations?.protocolVersion).toBe(
        androidIntegrationsProtocolVersion,
      );
      const view = await machine();
      evidence.machine = view;
      expect(view?.computerUse).toMatchObject({ displayStreamSupported: true });
      await phone.shell("svc power stayon true");
      cleanup.push(async () => {
        await phone.shell("svc power stayon false");
      });
      await phone.shell("input keyevent KEYCODE_WAKEUP");
      await phone.shell("input keyevent KEYCODE_HOME");
    });

    if (!editingOnly) {
      await phase("owner-live-without-a-task-two-clients-and-close", async () => {
        const db = createDatabase({ connectionString: isolated.url });
        try {
          const counts = async () => ({
            runs: (
              await db
                .selectFrom("runs")
                .select(db.fn.countAll().as("count"))
                .executeTakeFirstOrThrow()
            ).count,
            grants: (
              await db
                .selectFrom("integrationGrants")
                .select(db.fn.countAll().as("count"))
                .executeTakeFirstOrThrow()
            ).count,
          });
          const before = await counts();
          await phone.shell(`am start -W -n ${fixtureActivities.display}`);
          const opened = await testRpcData(
            host.origin,
            "commands.dispatch",
            {
              type: "computer.view.open",
              machineId: runnerId,
              target: { kind: "phone", display: "main" },
              idempotencyKey: randomUUID(),
            },
            owner,
          );
          if (opened.type !== "computer.view.open")
            throw new Error("Owner open returned another command");
          const source = {
            kind: "owner-view" as const,
            viewId: opened.view.viewId,
            generation: opened.view.generation,
          };
          const a = new ComputerDisplayViewer(host, source);
          const b = new ComputerDisplayViewer(host, source);
          viewers.push(a, b);
          cleanup.push(
            () => a.close(),
            () => b.close(),
          );
          await Promise.all([
            a.wait("owner keyframe", () => a.trace.frames[0]),
            b.wait("second owner keyframe", () => b.trace.frames[0]),
          ]);
          await decodedPixels("owner-without-task", a.trace.frames[0]!);
          a.send({
            type: "display.input",
            geometry: a.trace.frames[0]!.header.generation,
            sequence: 0,
            events: [
              { kind: "pointer", phase: "down", x: 0.5, y: 0.5, t: performance.now() },
              { kind: "pointer", phase: "up", x: 0.5, y: 0.5, t: performance.now() + 1 },
            ],
          });
          await delay(150);
          expect(
            (await readReceipts(phone)).filter(
              (row) =>
                row.kind === "button_touch" ||
                row.kind === "chip_touch" ||
                row.kind === "button_tap",
            ),
          ).toEqual([]);
          expect(await sessions()).toEqual([]);
          expect(await counts()).toEqual(before);
          expect(phoneInputs).toEqual([]);
          const projection = await phone.shell("dumpsys media_projection");
          evidence.ownerWithoutTask = {
            before,
            after: await counts(),
            source,
            projection,
            ownerControlAttemptIgnored: true,
          };
          await testRpcData(
            host.origin,
            "commands.dispatch",
            {
              type: "computer.view.close",
              viewId: source.viewId,
              generation: source.generation,
              idempotencyKey: randomUUID(),
            },
            owner,
          );
          await Promise.all([closed(a), closed(b)]);
          expect(await sessions()).toEqual([]);
        } finally {
          await db.destroy();
        }
      });
    }

    const caller = await connectAgentComputer(host, {
      key: `display-${randomUUID()}`,
      redaction,
      computerTool: 1,
    });
    let currentCaller = caller;
    cleanup.push(() => caller.close());
    const bootstrap = await testRpcData(host.origin, "bootstrap.get", {}, owner);
    if (!bootstrap.homeWorkspace) throw new Error("Owner has no Main Workspace.");
    const agent = await startPhoneAgent(host, caller, {
      key: `display-run-${randomUUID()}`,
      redaction,
      title: "Live phone display acceptance",
      workspaceId: bootstrap.homeWorkspace.id,
    });
    let initialFinished = false;
    const finishInitial = async () => {
      if (initialFinished) return;
      await agent.run.complete();
      await agent.gateway.close();
      initialFinished = true;
    };
    cleanup.push(finishInitial);
    async function phoneRow(gateway = agent.gateway) {
      const catalog = z
        .object({
          catalog: z.array(
            z.object({
              definitionId: z.string(),
              phones: z
                .array(
                  z.object({
                    runnerId: z.string(),
                    name: z.string(),
                    access: z.enum(["read", "read-write"]).optional(),
                    toolRefs: z.never().optional(),
                  }),
                )
                .optional(),
            }),
          ),
        })
        .parse(resultJson(await gateway.call("integration_search", { query: "Android phone" })));
      const row = catalog.catalog
        .find(({ definitionId }) => definitionId === androidPhoneDefinitionId)
        ?.phones?.find((candidate) => candidate.runnerId === runnerId);
      if (!row) throw new Error("The Android phone entry does not list the phone");
      return row;
    }
    const discoveredPhone = await phoneRow();
    expect(discoveredPhone.access).toBe("read-write");
    async function call(
      operation: "observe" | "act" | "release",
      actions?: AndroidPhoneAction[],
      gateway = agent.gateway,
    ): Promise<ToolResult> {
      const code = `const p = await phone(${JSON.stringify(discoveredPhone.name)}); await p.${operation}(${actions ? JSON.stringify(actions) : ""})`;
      const result = await gateway.call("computer", { code });
      transcript.push({ code, result });
      return result;
    }
    function observationResult(result: ToolResult): PhoneObservationText {
      const block = result.content.find(
        (entry) => entry.type === "text" && entry.text.split("\n")[1]?.startsWith("Observation "),
      );
      if (block?.type !== "text") throw new Error(`No phone observation: ${resultText(result)}`);
      return readObservation(block.text);
    }
    async function observe(): Promise<PhoneObservationText> {
      const result = await call("observe");
      expect(result.isError, resultText(result)).not.toBe(true);
      return observationResult(result);
    }
    const act = (actions: AndroidPhoneAction[]) => call("act", actions);
    async function openFixture() {
      let seen = await observe();
      if (seen.screen === "off" || seen.locked) {
        const woke = await act([{ type: "wake" }]);
        expect(woke.isError, resultText(woke)).not.toBe(true);
        seen = observationResult(woke);
      }
      await phone.shell(`am start -W -n ${fixtureActivities.display}`);
      return eventually(
        "fixture button in agent observation",
        async () => {
          const current = await observe();
          return current.tree.some((line) => line.label === "Record a tap") ? current : undefined;
        },
        15_000,
      );
    }
    async function sessionId() {
      const active = await sessions();
      expect(active).toHaveLength(1);
      return active[0]!.sessionId;
    }
    function viewer(id: string, editing = false) {
      const next = new ComputerDisplayViewer(
        host,
        { kind: "task-session", sessionId: id },
        { editing },
      );
      viewers.push(next);
      cleanup.push(() => next.close());
      return next;
    }
    function state(
      view: ComputerDisplayViewer,
      after: number,
      predicate: (message: DisplayViewerState) => boolean,
      timeout = 15_000,
    ) {
      return view.wait(
        "display state",
        () =>
          view.trace.events
            .slice(after)
            .find(
              (event) =>
                event.kind === "message" &&
                event.message.type === "display.state" &&
                predicate(event.message),
            ),
        timeout,
      );
    }
    function firstFrame(view: ComputerDisplayViewer, after = 0, timeout = 15_000) {
      return view.wait("keyframe", () => view.trace.frames[after], timeout);
    }
    const latest = (view: ComputerDisplayViewer) => {
      const frame = view.trace.frames.at(-1);
      if (!frame) throw new Error("Viewer has no picture geometry.");
      return frame;
    };
    async function replayPictures(view: ComputerDisplayViewer) {
      const requested =
        view.sent.findLast((entry) => entry.message.type === "display.keyframe")?.sentMs ??
        -Infinity;
      await delay(Math.max(0, 510 - (performance.now() - requested)));
      const after = view.trace.frames.length;
      const cursor = view.trace.events.length;
      view.send({ type: "display.keyframe" });
      return view.wait("current replay picture", () => {
        const reset = view.trace.events
          .slice(cursor)
          .findLast(
            (event) =>
              event.kind === "message" &&
              event.message.type === "display.state" &&
              event.message.replayThrough !== undefined,
          );
        if (reset?.kind !== "message" || reset.message.type !== "display.state") return undefined;
        const sequence = reset.message.replayThrough;
        const pictures = view.trace.frames.slice(after);
        const through = pictures.findIndex((picture) => picture.header.sequence === sequence);
        return through < 0 ? undefined : pictures.slice(0, through + 1);
      });
    }
    async function physicalScreen() {
      // The stream's own virtual display is listed too. The phone's screen is
      // display 0, whose current size follows rotation.
      const dump = await phone.shell("dumpsys window displays");
      const own = dump.search(/\bmDisplayId=0\b/u);
      const dimensions = own < 0 ? null : /\bcur=(\d+)x(\d+)\b/u.exec(dump.slice(own));
      if (!dimensions) throw new Error("Window manager did not report display 0's current size.");
      const size = { width: Number(dimensions[1]), height: Number(dimensions[2]) };
      evidence.physicalScreen = size;
      return size;
    }
    async function point(viewId: string) {
      return eventually(
        `fixture ${viewId}`,
        async () => {
          const location = await findView(phone, { activity: fixtureActivities.display, viewId });
          return "point" in location ? Pointer.parse(location.point) : undefined;
        },
        15_000,
      );
    }
    async function closed(view: ComputerDisplayViewer) {
      await eventually(
        "viewer socket close",
        async () => {
          view.check();
          return view.closed ? true : undefined;
        },
        15_000,
        20,
      );
    }

    await openFixture();
    if (!editingOnly) {
      await phase("owner-survives-task-release-replacement-and-owner-close", async () => {
        const observationBeforeViewing = await observe();
        const opened = await testRpcData(
          host.origin,
          "commands.dispatch",
          {
            type: "computer.view.open",
            machineId: runnerId,
            target: { kind: "phone", display: "main" },
            idempotencyKey: randomUUID(),
          },
          owner,
        );
        if (opened.type !== "computer.view.open")
          throw new Error("Owner open returned another command");
        const source = {
          kind: "owner-view" as const,
          viewId: opened.view.viewId,
          generation: opened.view.generation,
        };
        const own = new ComputerDisplayViewer(host, source);
        const other = new ComputerDisplayViewer(host, source);
        viewers.push(own, other);
        cleanup.push(
          () => own.close(),
          () => other.close(),
        );
        await Promise.all([firstFrame(own), firstFrame(other)]);
        const oldId = await sessionId();
        const task = viewer(oldId);
        await firstFrame(task);
        const unchangedObservation = await act([{ type: "wait", ms: 1 }]);
        expect(unchangedObservation.isError, resultText(unchangedObservation)).not.toBe(true);
        expect(observationResult(unchangedObservation).observationId).not.toBe(
          observationBeforeViewing.observationId,
        );
        const generation = latest(own).header.generation;
        const stream = frontDoor.latestDisplayStart?.streamId;
        expect((await call("release")).isError).not.toBe(true);
        await closed(task);
        expect(own.closed || other.closed).toBe(false);
        expect((await machine())?.computerUse?.ownerViews).toContainEqual(
          expect.objectContaining({ viewId: source.viewId, generation: source.generation }),
        );
        await openFixture();
        const replacementId = await sessionId();
        expect(replacementId).not.toBe(oldId);
        const replacement = viewer(replacementId);
        await firstFrame(replacement);
        expect(frontDoor.latestDisplayStart?.streamId).toBe(stream);
        expect(latest(own).header.generation).toBe(generation);
        await testRpcData(
          host.origin,
          "commands.dispatch",
          {
            type: "computer.view.close",
            viewId: source.viewId,
            generation: source.generation,
            idempotencyKey: randomUUID(),
          },
          owner,
        );
        await Promise.all([closed(own), closed(other)]);
        expect(replacement.closed).toBe(false);
        evidence.ownerTaskLifetime = {
          source,
          oldId,
          replacementId,
          stream,
          generation,
          observationBeforeViewing: observationBeforeViewing.observationId,
          observationRemainedUsable: true,
        };
        await replacement.close();
      });
    }

    await clearReceipts(phone);
    const initialSession = await sessionId();
    let first!: ComputerDisplayViewer;
    let second!: ComputerDisplayViewer;
    if (editingOnly) {
      await phase("native-editing-viewers", async () => {
        first = viewer(initialSession);
        second = viewer(initialSession);
        await Promise.all([firstFrame(first), firstFrame(second)]);
      });
    } else {
      await phase("live-h264-and-efficiency", async () => {
        first = viewer(initialSession);
        await state(first, 0, (message) => message.state === "live");
        const keyframe = await firstFrame(first);
        expect(keyframe.header.key).toBe(true);
        expect(keyframe.nalTypes).toEqual(expect.arrayContaining([7, 8, 5]));
        evidence.initialProjection = await phone.shell("dumpsys media_projection");
        expect(evidence.initialProjection).toContain(agentPhonePackageName);
        // Swiping within the list gives continuous composition without touching
        // any editable field or Opensteer UI. Alternate to avoid the list end.
        const center = await point("fixture_list");
        const screen = await physicalScreen();
        const start = performance.now();
        let turn = 0;
        while (performance.now() - start < 5_000) {
          const direction = turn++ % 2 === 0 ? 1 : -1;
          await phone.shell(
            `input swipe ${center.x} ${Math.round(center.y + direction * screen.height * 0.12)} ${center.x} ${Math.round(center.y - direction * screen.height * 0.12)} 350`,
          );
        }
        const end = performance.now();
        const active = displayRates(first.trace.frames, start, end);
        evidence.active = active;
        expect(
          active.fps,
          "at least 10 fps throughout continuous fixture swipes",
        ).toBeGreaterThanOrEqual(10);
        expect(active.bytesPerSecond).toBeGreaterThan(0);
        const activeSeconds = Array.from({ length: Math.floor((end - start) / 1000) }, (_, index) =>
          displayRates(first.trace.frames, start + index * 1000, start + (index + 1) * 1000),
        );
        evidence.activeOneSecondWindows = activeSeconds;
        for (const window of activeSeconds)
          expect(
            window.fps,
            "every full active second has at least 10 frames",
          ).toBeGreaterThanOrEqual(10);
        expect((await readReceipts(phone)).some((receipt) => receipt.kind === "scrolled")).toBe(
          true,
        );
        // The fixture draws no text cursor, so a focused editor is not motion in
        // a window intended to measure a static picture. The last fling and its
        // scrollbar fade end within about a second; the input surface then
        // refines the still picture with at most ten repeats 250 ms apart. The
        // stream has gone quiet 3.2-3.6 s after the swipes on API 30 and 33.
        await delay(5_000);
        const staticStart = performance.now();
        await delay(3_000);
        const quiet = displayRates(first.trace.frames, staticStart, performance.now());
        evidence.static = quiet;
        // Bound encoded H.264, separately from its JSON/wire overhead. Android 16's
        // privacy timer changes every second and also triggers surface refinement.
        // Keep both byte rates in evidence so the transport cost remains visible.
        const quietPayloadLimit = api >= 35 ? 4_096 : 2_048;
        evidence.staticPayloadLimit = {
          bytesPerSecond: quietPayloadLimit,
          privacyTimer: api >= 35,
        };
        expect(quiet.payloadBytesPerSecond).toBeLessThanOrEqual(quietPayloadLimit);
        expect(quiet.fps).toBeLessThanOrEqual(6);
        expect(first.trace.frames.length).toBeGreaterThan(2);
      });

      await phase("static-viewer-join", async () => {
        const previousGeneration = latest(first).header.generation;
        second = viewer(initialSession);
        // A static screen gives a fresh encoder nothing to encode, so the Host
        // serves a late joiner from its cache of the current keyframe and what
        // followed it: the phone is not asked and the generation does not change.
        const joinedState = await state(
          second,
          0,
          (message) => message.state === "live" && message.replayThrough !== undefined,
        );
        if (joinedState.kind !== "message" || joinedState.message.type !== "display.state")
          throw new Error("The joining viewer's state was not a display state.");
        const replayThrough = joinedState.message.replayThrough!;
        const joined = await firstFrame(second, 0, 1_000);
        evidence.staticJoinFirstFrameMs = joined.receivedMs - second.openedMs;
        evidence.staticJoinTargetMs = 500;
        evidence.staticJoinReplayThrough = replayThrough;
        expect(evidence.staticJoinFirstFrameMs).toBeLessThanOrEqual(1_000);
        expect(joined.header.key).toBe(true);
        expect(joined.header.generation).toBe(previousGeneration);
        expect(joined.header.sequence).toBeLessThanOrEqual(replayThrough);
        await second.wait("the cached frames through replayThrough", () =>
          second.trace.frames.find((frame) => frame.header.sequence === replayThrough),
        );
        expect(latest(first).header.generation).toBe(previousGeneration);
      });

      await phase("data-socket-loss-preserves-authorities-and-refuses-ticket-replay", async () => {
        const own = await ownerView();
        await firstFrame(own.view);
        const before = frontDoor.latestDisplayStart;
        if (!before) throw new Error("No authenticated producer start recorded");
        redaction.add(before.dataTicket);
        frontDoor.closeDisplayData();
        await Promise.all([closed(first), closed(second), closed(own.view)]);
        expect((await sessions()).map((session) => session.sessionId)).toEqual([initialSession]);
        first = viewer(initialSession);
        second = viewer(initialSession);
        const recoveredOwner = new ComputerDisplayViewer(host, own.source);
        viewers.push(recoveredOwner);
        cleanup.push(() => recoveredOwner.close());
        await Promise.all([firstFrame(first), firstFrame(second), firstFrame(recoveredOwner)]);
        expect(frontDoor.latestDisplayStart?.streamId).not.toBe(before.streamId);
        await oldTicketRefused(before.dataTicket);
        await decodedPixels("data-socket-owner-recovery", recoveredOwner.trace.frames[0]!);
        await closeOwner(own.source);
        await closed(recoveredOwner);
        evidence.dataRecovery = {
          oldStream: before.streamId,
          newStream: frontDoor.latestDisplayStart?.streamId,
          ticketSha256: sha256Hex(Buffer.from(before.dataTicket)),
          source: own.source,
        };
      });
    }
    const protectedOwner = await ownerView();
    await firstFrame(protectedOwner.view);
    let inputSequence = 0;
    function input(view: ComputerDisplayViewer, events: DisplayInputEvent[]) {
      view.send({
        type: "display.input",
        geometry: latest(view).header.generation,
        sequence: inputSequence++,
        events,
      });
    }
    async function inputReady(view: ComputerDisplayViewer) {
      await state(view, 0, (message) => message.state === "live" && message.sharedInput === 1);
    }
    function resetInput(view: ComputerDisplayViewer) {
      view.send({ type: "display.input-reset" });
    }
    // View lookup gives physical screen pixels; observation.geometry is a
    // scaled JPEG and cannot normalize those coordinates. Cache the current
    // window-manager display size before sending any pointer traffic.
    async function pointerSender(view: ComputerDisplayViewer) {
      const screen = await physicalScreen();
      return (phase: "down" | "move" | "up", pixels: { x: number; y: number }) =>
        input(view, [
          {
            kind: "pointer",
            phase,
            x: pixels.x / screen.width,
            y: pixels.y / screen.height,
            t: performance.now(),
          },
        ]);
    }
    async function receipt(kind: string, after: number, detail?: string) {
      return eventually(
        `${kind} fixture receipt`,
        async () =>
          (await readReceipts(phone)).find(
            (row) =>
              row.id > after &&
              row.kind === kind &&
              (detail === undefined || row.detail === detail),
          ),
        10_000,
        50,
      );
    }
    const baseline = async () => (await readReceipts(phone)).at(-1)?.id ?? 0;
    let dragEvidence:
      { after: number; from: { x: number; y: number }; to: { x: number; y: number } } | undefined;

    if (editingOnly) {
      await inputReady(first);
    } else {
      await phase("shared-input-and-agent-contact-admission", async () => {
        const beforeViewing = await observe();
        const before = await baseline();
        await inputReady(first);
        const action: AndroidPhoneAction = {
          type: "tap",
          count: 1,
          target: { index: elementIndex(beforeViewing, "button", "Record a tap") },
        };
        const accepted = await act([action]);
        expect(accepted.isError, resultText(accepted)).not.toBe(true);
        await receipt("button_tap", before);
        const contactStart = await baseline();
        const button = await point("fixture_button");
        const sendPointer = await pointerSender(first);
        sendPointer("down", button);
        await receipt("button_touch", contactStart, "down");
        const observed = await observe();
        const refused = await act([
          {
            type: "tap",
            count: 1,
            target: { index: elementIndex(observed, "button", "Record a tap") },
          },
        ]);
        expect(refused.isError).toBe(true);
        expect(resultText(refused)).toContain("A person is touching the screen; try again.");
        evidence.personContactRefusal = resultText(refused);
        const cursor = second.trace.events.length;
        input(second, [{ kind: "nav", to: "home" }]);
        await second.wait("another viewer is contended while contact is held", () =>
          second.trace.events
            .slice(cursor)
            .find(
              (event) =>
                event.kind === "message" &&
                event.message.type === "display.input.result" &&
                event.message.reason === "contended",
            ),
        );
        await observe();
        sendPointer("up", button);
        await receipt("button_tap", contactStart);
        const afterPerson = await act([{ type: "wait", ms: 1 }]);
        expect(afterPerson.isError, resultText(afterPerson)).not.toBe(true);
        expect((await sessions()).map((row) => row.sessionId)).toEqual([initialSession]);
      });
      await phase("owner-streamed-drag", async () => {
        const from = await point("fixture_drag");
        const to = await point("fixture_drop_target");
        const after = await baseline();
        dragEvidence = { after, from, to };
        const sendPointer = await pointerSender(first);
        sendPointer("down", from);
        // Keep contact alive beyond Android's long-press threshold; moves then
        // cover the requested ~500 ms without crossing the 500 ms watchdog.
        for (let tick = 0; tick < 8; tick += 1) {
          await delay(100);
          sendPointer("move", from);
        }
        await receipt("drag_start", after, "true");
        for (let tick = 1; tick <= 10; tick += 1) {
          await delay(50);
          sendPointer("move", {
            x: from.x + ((to.x - from.x) * tick) / 10,
            y: from.y + ((to.y - from.y) * tick) / 10,
          });
        }
        sendPointer("up", to);
        await receipt("drop", after, "target");
        // Audit the received path after the lifecycle phases so a missing
        // fixture hook does not hide the rest of the acceptance evidence.
      });
    }
    await phase("negotiated-native-editing", async () => {
      resetInput(first);
      const editing = viewer(initialSession, true);
      await firstFrame(editing);
      expect(
        editing.trace.events.some(
          (event) =>
            event.kind === "message" &&
            event.message.type === "display.state" &&
            event.message.editingVersion === 1,
        ),
      ).toBe(true);
      await inputReady(editing);
      const activity =
        "com.opensteer.agentphone.fixture/com.opensteer.agentphone.fixture.EditingFixtureActivity";
      const outcomes: unknown[] = [];
      evidence.editing = {
        api,
        outcomes,
        modes: ["native", "resource-less", "webview", "compose"],
      };
      const context = async (after = 0) =>
        editing.wait("focused editing context", () => {
          const found = editing.trace.events
            .slice(after)
            .findLast(
              (event) => event.kind === "message" && event.message.type === "display.editing",
            );
          return found?.kind === "message" &&
            found.message.type === "display.editing" &&
            found.message.context.field
            ? found.message.context
            : undefined;
        });
      const dispatch = async (
        events: DisplayInputEvent[],
        outcome = "dispatched",
        reason?: string,
      ) => {
        const sequence = inputSequence;
        const after = editing.trace.events.length;
        input(editing, events);
        const result = await editing.wait("editing batch receipt", () => {
          const found = editing.trace.events
            .slice(after)
            .find(
              (event) =>
                event.kind === "message" &&
                event.message.type === "display.input.result" &&
                event.message.sequence === sequence,
            );
          return found?.kind === "message" && found.message.type === "display.input.result"
            ? found.message
            : undefined;
        });
        outcomes.push(result);
        expect(result.outcome).toBe(outcome);
        if (reason) expect(result.reason).toBe(reason);
        // Host-refused rich paste never reaches the phone; forwarded input publishes after receipt.
        if (!events.some((event) => event.kind === "paste" && "items" in event))
          await editing.wait("post-input editing context", () => {
            const receiptIndex = editing.trace.events.findIndex(
              (event) => event.kind === "message" && event.message === result,
            );
            return editing.trace.events
              .slice(receiptIndex + 1)
              .find(
                (event) => event.kind === "message" && event.message.type === "display.editing",
              );
          });
        return sequence;
      };
      const failures: unknown[] = [];
      const independent = async (name: string, action: () => Promise<void>) => {
        try {
          await phase(name, action);
        } catch (error) {
          failures.push(error);
        }
      };
      for (const mode of ["native", "resource-less", "webview", "compose"]) {
        await independent(`editing-${mode}`, async () => {
          if (mode !== "native") {
            resetInput(editing);
            await inputReady(editing);
          }
          const start = editing.trace.events.length;
          const before = await baseline();
          await phone.shell(`am start -W -n ${activity} --es mode ${mode}`);
          if (mode === "webview") {
            await receipt("editing_web_ready", before);
            const at = await eventually(
              "WebView editor",
              async () => {
                const location = await findView(phone, { activity, viewId: "fixture_text" });
                return "point" in location ? Pointer.parse(location.point) : undefined;
              },
              15_000,
            );
            const sendPointer = await pointerSender(editing);
            sendPointer("down", at);
            sendPointer("up", at);
            await receipt("editing_web_focus", before);
          }
          await context(start);
          const typed = "ASCII café 한글 🧑‍💻";
          await phase(`editing-${mode}-typing-ascii-unicode-emoji`, async () => {
            for (const text of Array.from(typed))
              await dispatch([
                { kind: "key", action: "down", code: "", key: text, modifiers: [], text },
              ]);
            await receipt("editing_text", before, typed);
          });
          if (api < 33) {
            await phase(`editing-${mode}-limited-enter-backspace`, async () => {
              const after = await baseline();
              await dispatch([
                { kind: "key", action: "down", code: "Enter", key: "Enter", modifiers: [] },
                { kind: "key", action: "up", code: "Enter", key: "Enter", modifiers: [] },
                { kind: "key", action: "down", code: "Enter", key: "Enter", modifiers: [] },
                { kind: "key", action: "up", code: "Enter", key: "Enter", modifiers: [] },
              ]);
              await receipt("editing_text", after, typed + "\n\n");
              const deleteAfter = await baseline();
              await dispatch([
                { kind: "key", action: "down", code: "Backspace", key: "Backspace", modifiers: [] },
                { kind: "key", action: "up", code: "Backspace", key: "Backspace", modifiers: [] },
                { kind: "key", action: "down", code: "Backspace", key: "Backspace", modifiers: [] },
                { kind: "key", action: "up", code: "Backspace", key: "Backspace", modifiers: [] },
              ]);
              await receipt("editing_text", deleteAfter, typed);
            });
            const current = await context(start);
            await phase(`editing-${mode}-limited-range-refusal`, async () => {
              await dispatch(
                [
                  {
                    kind: "edit",
                    edit: { contextId: current.contextId, text: "!", before: "🧑‍💻", after: "" },
                  },
                ],
                "refused",
                "unsupported",
              );
            });
            await phase(`editing-${mode}-limited-command-refusals`, async () => {
              await dispatch([{ kind: "command", command: "selectAll" }], "refused", "unsupported");
              await dispatch([{ kind: "command", command: "undo" }], "refused", "unsupported");
              await dispatch(
                [{ kind: "command", command: "moveBackward" }],
                "refused",
                "unsupported",
              );
            });
            await phase(`editing-${mode}-limited-copy-refusal`, async () => {
              await dispatch([{ kind: "copy" }], "refused", "unsupported");
              await dispatch(
                [{ kind: "cut", contextId: (await context()).contextId }],
                "refused",
                "unsupported",
              );
            });
            await phase(`editing-${mode}-paste-30000-units`, async () => {
              await dispatch([{ kind: "paste", text: "\n" + "漢".repeat(30000 - 1) }]);
              await receipt("editing_text", before, typed + "\n" + "漢".repeat(30000 - 1));
            });
            return;
          }
          const current = await context(start);
          const replaced = typed.replace("🧑‍💻", "👩‍🚀");
          await phase(`editing-${mode}-verified-replacement`, async () => {
            await dispatch([
              {
                kind: "edit",
                edit: { contextId: current.contextId, text: "👩‍🚀", before: "🧑‍💻", after: "" },
              },
            ]);
            await receipt("editing_text", before, replaced);
          });
          await phase(`editing-${mode}-stale-replacement-refusal`, async () => {
            const fresh = await context(start);
            const staleCursor = editing.trace.events.length;
            await dispatch(
              [
                {
                  kind: "edit",
                  edit: { contextId: fresh.contextId, text: "bad", before: "mismatch", after: "" },
                },
              ],
              "stale",
              "stale",
            );
            expect((await context(staleCursor)).contextId).not.toBe(fresh.contextId);
          });
          await phase(`editing-${mode}-select-all-and-selected-copy`, async () => {
            const previous = await context(start);
            const selectionCursor = editing.trace.events.length;
            const selectionAfter = await baseline();
            await dispatch([{ kind: "command", command: "selectAll" }]);
            await receipt("editing_selection", selectionAfter, `0:${replaced.length}`);
            expect((await context(selectionCursor)).contextId).not.toBe(previous.contextId);
            const copy = await dispatch([{ kind: "copy" }]);
            await editing.wait("selected copy", () =>
              editing.trace.events.find(
                (event) =>
                  event.kind === "message" &&
                  event.message.type === "display.clipboard" &&
                  event.message.sequence === copy &&
                  event.message.text === replaced,
              ),
            );
          });
          await phase(`editing-${mode}-verified-cut`, async () => {
            const selected = await context();
            const beforeCut = await baseline();
            const sequence = await dispatch([{ kind: "cut", contextId: selected.contextId }]);
            await receipt("editing_text", beforeCut, "");
            await editing.wait("cut clipboard", () =>
              editing.trace.events.find(
                (event) =>
                  event.kind === "message" &&
                  event.message.type === "display.clipboard" &&
                  event.message.sequence === sequence &&
                  event.message.outcome === "cut" &&
                  event.message.text === replaced,
              ),
            );
            await dispatch([{ kind: "cut", contextId: selected.contextId }], "stale", "stale");
            await dispatch([{ kind: "paste", text: replaced }]);
            const selectionAfter = await baseline();
            await dispatch([{ kind: "command", command: "selectAll" }]);
            await receipt("editing_selection", selectionAfter, `0:${replaced.length}`);
          });
          await phase(`editing-${mode}-backspace-twice-over-selection`, async () => {
            const after = await baseline();
            await dispatch([
              { kind: "key", action: "down", code: "Backspace", key: "Backspace", modifiers: [] },
              { kind: "key", action: "down", code: "Backspace", key: "Backspace", modifiers: [] },
            ]);
            await receipt("editing_text", after, "");
          });
          await phase(`editing-${mode}-paste-literal-text`, async () => {
            await dispatch([{ kind: "paste", text: "abcd" }]);
            await receipt("editing_text", before, "abcd");
          });
          await phase(`editing-${mode}-arrows-and-middle-selection-copy`, async () => {
            const selectionAfter = await baseline();
            await dispatch([{ kind: "command", command: "moveBackward" }]);
            await dispatch([
              {
                kind: "key",
                action: "down",
                code: "ArrowLeft",
                key: "ArrowLeft",
                modifiers: ["shift"],
              },
              {
                kind: "key",
                action: "up",
                code: "ArrowLeft",
                key: "ArrowLeft",
                modifiers: ["shift"],
              },
            ]);
            await dispatch([
              {
                kind: "key",
                action: "down",
                code: "ArrowLeft",
                key: "ArrowLeft",
                modifiers: ["shift"],
              },
              {
                kind: "key",
                action: "up",
                code: "ArrowLeft",
                key: "ArrowLeft",
                modifiers: ["shift"],
              },
            ]);
            await receipt("editing_selection", selectionAfter, mode === "webview" ? "1:3" : "3:1");
            const selected = await dispatch([{ kind: "copy" }]);
            await editing.wait("middle selection", () =>
              editing.trace.events.find(
                (event) =>
                  event.kind === "message" &&
                  event.message.type === "display.clipboard" &&
                  event.message.sequence === selected &&
                  event.message.text === "bc",
              ),
            );
          });
          await phase(`editing-${mode}-partial-and-empty-cut`, async () => {
            const selected = await context();
            const cutAfter = await baseline();
            const contextAfter = editing.trace.events.length;
            const cut = await dispatch([{ kind: "cut", contextId: selected.contextId }]);
            await receipt("editing_text", cutAfter, "ad");
            await editing.wait("partial cut clipboard", () =>
              editing.trace.events.find(
                (event) =>
                  event.kind === "message" &&
                  event.message.type === "display.clipboard" &&
                  event.message.sequence === cut &&
                  event.message.outcome === "cut" &&
                  event.message.text === "bc",
              ),
            );
            const collapsed = await context(contextAfter);
            const emptyAfter = await baseline();
            const empty = await dispatch([{ kind: "cut", contextId: collapsed.contextId }]);
            await editing.wait("empty cut clipboard", () =>
              editing.trace.events.find(
                (event) =>
                  event.kind === "message" &&
                  event.message.type === "display.clipboard" &&
                  event.message.sequence === empty &&
                  event.message.outcome === "empty" &&
                  event.message.text === undefined,
              ),
            );
            expect(
              (await readReceipts(phone)).filter(
                (row) => row.id > emptyAfter && row.kind === "editing_text",
              ),
            ).toEqual([]);
            const pasteAfter = await baseline();
            await dispatch([{ kind: "paste", text: "bc" }]);
            await receipt("editing_text", pasteAfter, "abcd");
            const selectionAfter = await baseline();
            for (let index = 0; index < 2; index += 1)
              await dispatch([
                {
                  kind: "key",
                  action: "down",
                  code: "ArrowLeft",
                  key: "ArrowLeft",
                  modifiers: ["shift"],
                },
                {
                  kind: "key",
                  action: "up",
                  code: "ArrowLeft",
                  key: "ArrowLeft",
                  modifiers: ["shift"],
                },
              ]);
            await receipt("editing_selection", selectionAfter, mode === "webview" ? "1:3" : "3:1");
          });
          await phase(`editing-${mode}-legacy-delete-twice-over-selection`, async () => {
            await dispatch([{ kind: "text", deleteBackward: 2 }]);
            await receipt("editing_text", before, "d");
          });
          await phase(`editing-${mode}-undo`, async () => {
            await dispatch([{ kind: "command", command: "selectAll" }]);
            await dispatch([{ kind: "paste", text: "abcd" }]);
            await receipt("editing_text", before, "abcd");
            const undoAfter = await baseline();
            await dispatch([{ kind: "command", command: "undo" }]);
            await receipt("editing_text", undoAfter, "d");
          });
          await phase(`editing-${mode}-accent-replacement`, async () => {
            await dispatch([{ kind: "command", command: "selectAll" }]);
            await dispatch([{ kind: "paste", text: "e" }]);
            await receipt("editing_text", before, "e");
            const c = await context(start);
            await dispatch([
              { kind: "edit", edit: { contextId: c.contextId, text: "é", before: "e", after: "" } },
            ]);
            await receipt("editing_text", before, "é");
          });
          await phase(`editing-${mode}-paste-30000-units`, async () => {
            await dispatch([{ kind: "command", command: "moveBackward" }]);
            await dispatch([{ kind: "paste", text: "漢".repeat(30000) }]);
            await receipt("editing_text", before, "漢".repeat(30000) + "é");
          });
        });
      }
      await independent("editing-ime-induced-field-movement", async () => {
        const moveBefore = await baseline();
        await phone.shell(`am start -W -n ${activity} --es mode moving`);
        await receipt("editing_ime_hidden", moveBefore);
        const screen = await physicalScreen();
        const editorPoint = async () => {
          const seen = await observe();
          const field = seen.tree.find((line) => line.role === "edittext");
          if (!field) return undefined;
          const point = {
            x: ((field.bounds.x + field.bounds.width / 2) * screen.width) / seen.geometry.width,
            y: ((field.bounds.y + field.bounds.height / 2) * screen.height) / seen.geometry.height,
          };
          evidence.imeLastPoint = point;
          return point;
        };
        const initialPoint = await eventually("bottom editor", editorPoint, 15000);
        evidence.imeInitialPoint = initialPoint;
        const sendPointer = await pointerSender(editing);
        sendPointer("down", initialPoint);
        sendPointer("up", initialPoint);
        await dispatch([{ kind: "paste", text: "moved by IME" }]);
        await receipt("editing_text", moveBefore, "moved by IME");
        const moved = await eventually(
          "IME moved editor",
          async () => {
            const point = await editorPoint();
            return point && point.y < initialPoint.y ? point : undefined;
          },
          15000,
        );
        outcomes.push({ imeMovement: { before: initialPoint, after: moved } });
      });
      await independent("editing-rich-paste-refusals", async () => {
        for (const type of ["image/png", "application/octet-stream"])
          await dispatch(
            [{ kind: "paste", items: [{ type, size: 10 }] }],
            "refused",
            "unsupported",
          );
      });
      await independent("editing-sensitive-copy-refusal", async () => {
        const secretCursor = editing.trace.events.length;
        const secretAfter = await baseline();
        await phone.shell(`am start -W -n ${activity} --es mode sensitive`);
        expect((await context(secretCursor)).field?.sensitive).toBe(true);
        const secret = "fixture-secret";
        await dispatch([{ kind: "paste", text: secret }]);
        await receipt("editing_text", secretAfter, secret);
        if (api >= 33) {
          const selectedAfter = await baseline();
          await dispatch([{ kind: "command", command: "selectAll" }]);
          await receipt("editing_selection", selectedAfter, `0:${secret.length}`);
        }
        await dispatch([{ kind: "copy" }], "refused", api < 33 ? "unsupported" : "sensitive");
        const cutAfter = await baseline();
        await dispatch(
          [{ kind: "cut", contextId: (await context()).contextId }],
          "refused",
          api < 33 ? "unsupported" : "sensitive",
        );
        expect(
          (await readReceipts(phone)).filter(
            (row) => row.id > cutAfter && row.kind === "editing_text",
          ),
        ).toEqual([]);
      });
      await independent("editing-controller-only-context-copy-and-receipts", async () => {
        expect(
          second.trace.events.some(
            (event) =>
              event.kind === "message" &&
              ["display.editing", "display.clipboard"].includes(event.message.type),
          ),
        ).toBe(false);
        const sentSequences = new Set(
          editing.sent.flatMap(({ message }) =>
            message.type === "display.input" ? [message.sequence] : [],
          ),
        );
        const results = editing.trace.events.flatMap((event) =>
          event.kind === "message" && event.message.type === "display.input.result"
            ? [event.message.sequence]
            : [],
        );
        expect(results).toHaveLength(sentSequences.size);
        expect(new Set(results)).toEqual(sentSequences);
      });
      await writeFile(join(directory, "editing.png"), await phone.screencap());

      resetInput(editing);
      await editing.close();
      await phone.shell(`am start -W -n ${fixtureActivities.display}`);
      await inputReady(first);
      if (failures.length) throw new AggregateError(failures, "Native editing cases failed");
    });

    if (!editingOnly) {
      await phase("owner-text-and-back", async () => {
        const after = await baseline();
        const editor = await point("fixture_text");
        const sendPointer = await pointerSender(first);
        sendPointer("down", editor);
        await delay(80);
        sendPointer("up", editor);
        input(first, [{ kind: "text", insert: "owner-okX" }]);
        await receipt("text", after, "owner-okX");
        input(first, [{ kind: "text", deleteBackward: 1 }]);
        await receipt("text", after, "owner-ok");
        input(first, [{ kind: "text", submit: true }]);
        const submitted = await receipt("submit", after);
        expect(submitted.detail).toMatch(/^[^:]+:owner-ok$/u);
        expect((await observe()).tree).toContainEqual(
          expect.objectContaining({ role: "edittext", label: "owner-ok" }),
        );
        // First dismiss the IME, then Back must leave the Activity itself.
        input(first, [{ kind: "nav", to: "back" }]);
        await delay(500);
        input(first, [{ kind: "nav", to: "back" }]);
        await eventually(
          "owner Back leaves fixture",
          async () =>
            (await activityResumed(phone, fixtureActivities.display)) ? undefined : true,
          10_000,
        );
        await phone.shell(`am start -W -n ${fixtureActivities.display}`);
        const stale = await eventually(
          "fixture returns after owner Back",
          async () => {
            const seen = await observe();
            return seen.tree.some((line) => line.label === "Record a tap") ? seen : undefined;
          },
          15_000,
        );
        resetInput(first);
        const beforeTap = await baseline();
        const action: AndroidPhoneAction = {
          type: "tap",
          count: 1,
          target: { index: elementIndex(stale, "button", "Record a tap") },
        };
        const accepted = await act([action]);
        expect(accepted.isError, resultText(accepted)).not.toBe(true);
        await receipt("button_tap", beforeTap);
        evidence.personResetPreservesObservation = true;
      });

      async function protectedInterval(
        reason: "opensteer-app",
        enter: () => Promise<void>,
        leave: () => Promise<void>,
      ) {
        const tracked = [first, second, protectedOwner.view].map((view) => ({
          view,
          cursor: view.trace.events.length,
          generation: latest(view).header.generation,
        }));
        const beforeContact = (await readReceipts(phone)).at(-1)?.id ?? 0;
        await inputReady(first);
        const contact = await pointerSender(first);
        contact("down", await point("fixture_button"));
        await receipt("button_touch", beforeContact, "down");
        await enter();
        for (const { view, cursor } of tracked)
          await state(
            view,
            cursor,
            (message) => message.state === "protected" && message.reason === reason,
          );
        const counts = tracked.map(({ view }) => view.trace.frames.length);
        await delay(1_000);
        tracked.forEach(({ view }, index) => {
          view.check();
          expect(view.trace.frames).toHaveLength(counts[index]!);
        });
        await writeFile(join(directory, `${reason}-protected.png`), await phone.screencap());
        const resumedHeaders = [];
        await leave();
        for (const [index, { view, generation }] of tracked.entries()) {
          const resumed = await firstFrame(view, counts[index]!);
          expect(resumed.header.generation).toBeGreaterThan(generation);
          expect(resumed.header.key).toBe(true);
          resumedHeaders.push(resumed.header);
          await decodedPixels(`${reason}-resumed-${index}`, resumed);
          // DisplayTrace audits every event: no delta or old-generation media may
          // slip between protected and the next generation's first keyframe.
          view.check();
        }
        evidence[`${reason}-protection`] = {
          protectedFrameCounts: counts,
          silenceMs: 1_000,
          previousGenerations: tracked.map((entry) => entry.generation),
          resumedHeaders,
        };
        expect(
          (await readReceipts(phone)).filter(
            (row) => row.id > beforeContact && row.kind === "button_tap",
          ),
        ).toEqual([]);
      }
      await phase("main-activity-protection", () =>
        protectedInterval(
          "opensteer-app",
          async () => {
            await phone.shell(`am start -W -n ${agentPhoneActivities.main}`);
          },
          async () => {
            await phone.shell(`am start -W -n ${fixtureActivities.display}`);
          },
        ),
      );
      await phase("flag-secure-independent-decoded-pixels", async () => {
        await decodedPixels(
          "secure-fixture-before",
          first.trace.frames.findLast((frame) => frame.header.key)!,
        );
        await phone.shell(`am start -W -n ${fixtureActivities.secure}`);
        await delay(1_000);
        for (const [index, view] of [first, second, protectedOwner.view].entries()) {
          const replay = await replayPictures(view);
          await decodedPixels(`flag-secure-${index}`, replay[0]!, true, replay.slice(1));
        }
        await phone.shell(`am start -W -n ${fixtureActivities.display}`);
        await delay(500);
        const restored = await replayPictures(first);
        await decodedPixels("secure-fixture-after", restored[0]!, false, restored.slice(1));
      });

      await phase("mixed-source-static-sleep-and-local-wake", async () => {
        const watched = [first, second, protectedOwner.view];
        const before = watched.map((view) => ({
          cursor: view.trace.events.length,
          generation: latest(view).header.generation,
        }));
        await phone.shell("input keyevent KEYCODE_SLEEP");
        await Promise.all(
          watched.map((view, index) =>
            state(
              view,
              before[index]!.cursor,
              (message) => message.state === "screen-off" || message.reason === "locked-screen",
            ),
          ),
        );
        const counts = watched.map((view) => view.trace.frames.length);
        await delay(1_000);
        watched.forEach((view, index) => expect(view.trace.frames).toHaveLength(counts[index]!));
        expect(await phone.shell("dumpsys power")).toMatch(/mWakefulness=Asleep/u);
        await phone.shell("input keyevent KEYCODE_WAKEUP");
        await phone.shell("wm dismiss-keyguard");
        for (const [index, view] of watched.entries()) {
          const frame = await firstFrame(view, counts[index]!);
          expect(frame.header.generation).toBeGreaterThan(before[index]!.generation);
          expect(frame.header.key).toBe(true);
          await decodedPixels(`mixed-static-wake-${index}`, frame);
        }
        evidence.sleepSources = {
          owner: protectedOwner.source,
          task: initialSession,
          before,
          counts,
        };
      });
      await closeOwner(protectedOwner.source);
      await closed(protectedOwner.view);

      await phase("rotation-changes-picture-geometry", async () => {
        const accelerometer = (
          await phone.shell("settings get system accelerometer_rotation")
        ).trim();
        const rotation = (await phone.shell("settings get system user_rotation")).trim();
        const restoreSetting = async (name: string, value: string) => {
          if (!/^(?:null|[0-9]+)$/u.test(value)) throw new Error(`Invalid prior ${name} setting.`);
          await phone.shell(
            value === "null"
              ? `settings delete system ${name}`
              : `settings put system ${name} ${value}`,
          );
        };
        cleanup.push(async () => {
          await restoreSetting("accelerometer_rotation", accelerometer);
          await restoreSetting("user_rotation", rotation);
        });
        await phone.shell("settings put system accelerometer_rotation 0");
        const rotate = async (value: 0 | 1, landscape: boolean) => {
          const before = latest(first).header;
          await phone.shell(`settings put system user_rotation ${value}`);
          return first.wait("rotated picture", () =>
            first.trace.frames.find(
              (frame) =>
                frame.header.generation > before.generation &&
                (landscape
                  ? frame.header.width > frame.header.height
                  : frame.header.height > frame.header.width),
            ),
          );
        };
        if (latest(first).header.width > latest(first).header.height) await rotate(0, false);
        const portrait = latest(first).header;
        const nativeCursor = phoneStates.length;
        const releaseStates = frontDoor.holdDisplayStates();
        let landscape: ReceivedFrame["header"];
        try {
          const rotated = await rotate(1, true);
          landscape = rotated.header;
          const heldStates = releaseStates();
          expect(heldStates).toBeGreaterThan(0);
          await delay(900);
          const late = phoneStates
            .slice(nativeCursor)
            .find(
              (message) =>
                message.generation === landscape.generation && message.state === "starting",
            );
          expect(late).toBeDefined();
          expect(late!.receivedMs).toBeGreaterThan(rotated.receivedMs);
          expect(
            first.trace.events.filter(
              (event) =>
                event.kind === "message" &&
                event.message.type === "display.state" &&
                event.message.generation === landscape.generation &&
                event.message.state === "starting",
            ),
          ).toEqual([]);
          evidence.rotationStateAfterMedia = {
            stateReceivedMs: late!.receivedMs,
            mediaReceivedMs: rotated.receivedMs,
            heldStates,
          };
        } finally {
          releaseStates();
        }
        evidence.rotation = { portrait, landscape };
        expect(landscape.key).toBe(true);
        // Codec alignment may differ by a block; a portrait letterbox cannot pass.
        expect(Math.abs(landscape.width - portrait.height)).toBeLessThanOrEqual(16);
        expect(Math.abs(landscape.height - portrait.width)).toBeLessThanOrEqual(16);
        await rotate(0, false);
        await phone.shell(`am start -W -n ${fixtureActivities.display}`);
      });

      await phase("session-end-closes-viewers-and-contact", async () => {
        await inputReady(first);
        const beforeContact = await baseline();
        (await pointerSender(first))("down", await point("fixture_button"));
        await receipt("button_touch", beforeContact, "down");
        const released = await call("release");
        expect(released.isError, resultText(released)).not.toBe(true);
        await Promise.all([
          closed(first),
          closed(second),
          receipt("button_touch", beforeContact, "cancel"),
        ]);
        expect(await sessions()).toEqual([]);
        expect(first.closed && second.closed).toBe(true);
      });
      await phase("last-viewer-grace-stops-projection", async () => {
        await openFixture();
        const id = await sessionId();
        const only = viewer(id);
        await firstFrame(only);
        await state(only, 0, (message) => message.state === "live");
        const stream = frontDoor.latestDisplayStart?.streamId;
        expect(stream).toBeDefined();
        const after = phoneStates.length;
        const leftAt = performance.now();
        await only.close();
        await delay(displayDemandGraceMs - 500);
        expect(
          phoneStates
            .slice(after)
            .some((message) => message.streamId === stream && message.state === "stopped"),
        ).toBe(false);
        const stopped = await eventually(
          "phone reports stopped after demand grace",
          async () =>
            phoneStates
              .slice(after)
              .find((message) => message.streamId === stream && message.state === "stopped"),
          displayDemandGraceMs + 5_000,
          20,
        );
        evidence.lastViewerStopMs = stopped.receivedMs - leftAt;
        expect(stopped.receivedMs - leftAt).toBeGreaterThanOrEqual(displayDemandGraceMs - 100);
        expect(stopped.receivedMs - leftAt).toBeLessThanOrEqual(displayDemandGraceMs + 5_000);
        const dump = await eventually(
          "projection released",
          async () => {
            const output = await phone.shell("dumpsys media_projection");
            return /Media Projection:\s*(?:null|\(null\))/iu.test(output) ? output : undefined;
          },
          10_000,
        );
        evidence.projectionAfterGrace = dump;
        expect(dump).toMatch(/Media Projection:\s*(?:null|\(null\))/iu);
        const released = await call("release");
        expect(released.isError, resultText(released)).not.toBe(true);
      });
      await phase("zero-versus-eight-mixed-viewer-fairness-and-bounds", async () => {
        await openFixture();
        const id = await sessionId();
        async function sample() {
          const rows = [];
          for (let index = 0; index < 8; index++) {
            const at = performance.now();
            const result = await call("observe");
            expect(result.isError, resultText(result)).not.toBe(true);
            expect(
              result.content.some((item) => item.type === "image"),
              "agent screenshot succeeds",
            ).toBe(true);
            const seen = observationResult(result);
            const observationMs = performance.now() - at;
            const actionAt = performance.now();
            const acted = await act([{ type: "wait", ms: 1 }]);
            expect(acted.isError, resultText(acted)).not.toBe(true);
            rows.push({
              observationId: seen.observationId,
              ms: observationMs,
              actionMs: performance.now() - actionAt,
            });
          }
          expect(new Set(rows.map((row) => row.observationId)).size).toBe(rows.length);
          return rows;
        }
        const zero = await sample();
        const beforeMemory = process.memoryUsage();
        const nativeBefore = await phone.shell(`dumpsys meminfo ${agentPhonePackageName}`);
        const own = await ownerView();
        const mixed = [own.view];
        for (let index = 0; index < 7; index++) {
          const view = new ComputerDisplayViewer(
            host,
            index < 3 ? own.source : { kind: "task-session", sessionId: id },
            { acknowledge: index !== 6 },
          );
          viewers.push(view);
          cleanup.push(() => view.close());
          mixed.push(view);
        }
        await Promise.all(mixed.map((view) => firstFrame(view)));
        const liveStream = frontDoor.latestDisplayStart?.streamId;
        const extra = viewer(id);
        await closed(extra);
        expect(extra.trace.frames).toEqual([]);
        let moving = true;
        const screen = await physicalScreen();
        const center = await point("fixture_list");
        const motion = (async () => {
          let direction = 1;
          while (moving) {
            await phone.shell(
              `input swipe ${center.x} ${Math.round(center.y + direction * screen.height * 0.1)} ${center.x} ${Math.round(center.y - direction * screen.height * 0.1)} 300`,
            );
            direction *= -1;
          }
        })();
        let eight: Awaited<ReturnType<typeof sample>>;
        try {
          eight = await sample();
          await closed(mixed.at(-1)!);
        } finally {
          moving = false;
          await motion;
        }
        const maximum = (rows: { ms: number }[]) => Math.max(...rows.map((row) => row.ms));
        expect(maximum(eight), "no screenshot starvation under maximum viewer demand").toBeLessThan(
          Math.max(10_000, maximum(zero) * 4),
        );
        expect(Math.max(...eight.map((row) => row.actionMs))).toBeLessThan(
          Math.max(10_000, Math.max(...zero.map((row) => row.actionMs)) * 4),
        );
        expect(process.memoryUsage().heapUsed - beforeMemory.heapUsed).toBeLessThan(
          200 * 1_048_576,
        );
        expect(frontDoor.latestDisplayStart?.streamId).toBe(liveStream);
        const slow = mixed.at(-1)!;
        const replayThrough = Math.max(
          -1,
          ...slow.trace.events.flatMap((event) =>
            event.kind === "message" &&
            event.message.type === "display.state" &&
            event.message.replayThrough !== undefined
              ? [event.message.replayThrough]
              : [],
          ),
        );
        expect(
          slow.trace.frames.filter((frame) => frame.header.sequence > replayThrough).length,
          "live decoder credit bounds stalled delivery",
        ).toBeLessThanOrEqual(4);
        expect(
          slow.trace.frames.reduce((sum, frame) => sum + frame.wireBytes, 0),
          "byte-paced replay remains bounded",
        ).toBeLessThanOrEqual(1_048_576);
        const fast = mixed[0]!;
        const after = fast.trace.frames.length;
        fast.send({ type: "display.keyframe" });
        await firstFrame(fast, after);
        expect(fast.closed).toBe(false);
        evidence.fairness = {
          zero,
          eight,
          beforeMemory,
          afterMemory: process.memoryUsage(),
          nativeBefore,
          nativeAfter: await phone.shell(`dumpsys meminfo ${agentPhonePackageName}`),
          codecs: await phone.shell("dumpsys media.codec"),
          stream: liveStream,
          slowFrames: slow.trace.frames.length,
          machine: await runCommand("sysctl", ["-n", "machdep.cpu.brand_string", "hw.memsize"]),
          rates: mixed.map((view) =>
            displayRates(view.trace.frames, view.openedMs, performance.now()),
          ),
        };
        for (const view of mixed) await view.close();
        await closeOwner(own.source);
        expect((await call("release")).isError).not.toBe(true);
      });
      await phase("process-death-rebinds-without-input-replay", async () => {
        await openFixture();
        const id = await sessionId();
        const dying = viewer(id);
        const own = await ownerView();
        const replaying = new ComputerDisplayViewer(host, own.source, { acknowledge: false });
        viewers.push(replaying);
        cleanup.push(() => replaying.close());
        await Promise.all([firstFrame(dying), firstFrame(own.view), firstFrame(replaying)]);
        await inputReady(dying);
        const before = await baseline();
        const button = await point("fixture_button");
        const sendPointer = await pointerSender(dying);
        sendPointer("down", button);
        await delay(80);
        sendPointer("up", button);
        await receipt("button_tap", before);
        const history = (await readReceipts(phone)).filter((row) => row.id > before);
        const pids = await agentPhonePids(phone);
        expect(pids).toHaveLength(1);
        const savedTicket = frontDoor.latestDisplayStart?.dataTicket;
        if (!savedTicket) throw new Error("No data ticket before process death");
        redaction.add(savedTicket);
        await phone.shell(`su 0 kill -9 ${pids[0]}`);
        await Promise.all([closed(dying), closed(own.view), closed(replaying)]);
        const nextPid = await eventually(
          "Android rebinds killed runtime",
          async () => {
            const [pid] = await agentPhonePids(phone);
            return pid !== undefined && !pids.includes(pid) ? pid : undefined;
          },
          60_000,
        );
        evidence.processRecovery = { before: pids[0], after: nextPid };
        await waitForPhoneOnline(phone, host, runnerId, 60_000);
        await oldTicketRefused(savedTicket);
        expect((await machine())?.computerUse?.ownerViews ?? []).toEqual([]);
        const refusedOldOwner = new ComputerDisplayViewer(host, own.source);
        await eventually(
          "old owner authority refused after fence replacement",
          async () => (refusedOldOwner.closed ? true : undefined),
          15_000,
        );
        expect(refusedOldOwner.trace.frames).toEqual([]);
        await openFixture();
        const reboundId = await sessionId();
        expect(reboundId).not.toBe(id);
        const recovered = viewer(reboundId);
        await state(recovered, 0, (message) => message.state === "live");
        expect((await firstFrame(recovered)).header.key).toBe(true);
        await delay(1_000);
        // Activity recreation reports its initial scroll layout; only input receipts
        // can prove replay. Compare every other receipt without hiding touches/text.
        expect(
          (await readReceipts(phone)).filter(
            (row) => row.id > before && row.kind !== "scroll_offset",
          ),
        ).toEqual(history.filter((row) => row.kind !== "scroll_offset"));
        // Shared input is available again; none of the dead viewer's input is replayed.
        await inputReady(recovered);
        resetInput(recovered);
        await recovered.close();
        const released = await call("release");
        expect(released.isError, resultText(released)).not.toBe(true);
      });
      await phase("pause-ends-display-and-agent-session", async () => {
        await openFixture();
        const paused = viewer(await sessionId());
        const own = await ownerView();
        await Promise.all([firstFrame(paused), firstFrame(own.view)]);
        const ownerGeneration = latest(own.view).header.generation;
        await observe();
        const cursor = paused.trace.events.length;
        await phone.shell(`am start -W -n ${agentPhoneActivities.main}`);
        await tapView(phone, { activity: agentPhoneActivities.main, viewId: "pause_switch" });
        await state(
          paused,
          cursor,
          (message) => message.state === "stopped" || message.state === "protected",
        );
        await eventually(
          "Pause ends agent phone session",
          async () => ((await sessions()).length === 0 ? true : undefined),
          15_000,
        );
        expect((await readPhoneStatus(phone)).paused).toBe(true);
        const refused = await act([{ type: "navigate", to: "home" }]);
        expect(refused.isError).toBe(true);
        expect(resultText(refused)).toContain("Computer use was stopped for this task");
        await closed(paused);
        expect(own.view.closed).toBe(false);
        await tapView(phone, { activity: agentPhoneActivities.main, viewId: "pause_switch" });
        await waitForPhoneOnline(phone, host, runnerId, 15_000);
        const after = own.view.trace.frames.length;
        await phone.shell(`am start -W -n ${fixtureActivities.display}`);
        const resumed = await firstFrame(own.view, after);
        expect(resumed.header.generation).toBeGreaterThan(ownerGeneration);
        await decodedPixels("owner-resumes-after-pause-without-task", resumed);
        expect(await sessions()).toEqual([]);
        await closeOwner(own.source);
        await closed(own.view);
      });
      await phase("final-publication-and-receipt-audit", async () => {
        viewers.forEach((view) => view.check());
        expect(ingressErrors).toEqual([]);
        expect(phoneRefusals.map((row) => row.code)).not.toContain("owner-in-control");
        // Every positive input has one durable receipt; later duplicates (even
        // after process death) cannot pass an earlier phase's immediate check.
        const all = await readReceipts(phone);
        expect(all.filter((row) => row.kind === "button_tap")).toHaveLength(4);
        expect(all.filter((row) => row.kind === "drop").map((row) => row.detail)).toEqual([
          "target",
        ]);
        expect(all.filter((row) => row.kind === "submit")).toHaveLength(1);
        expect(all.filter((row) => row.kind === "drag_start").map((row) => row.detail)).toEqual([
          "true",
        ]);
      });
      await phase("fixture-monotonic-drag-path", async () => {
        if (!dragEvidence) throw new Error("No streamed drag was sent.");
        const paths = (await readReceipts(phone)).filter(
          (row) => row.id > dragEvidence!.after && row.kind === "drag_path",
        );
        evidence.dragPathReceipts = paths;
        // These samples come from the receiving View, independently of the sender's path.
        expect(
          paths,
          "Fixture records one drag_path in screen pixels and Android monotonic milliseconds",
        ).toHaveLength(1);
        evidence.receivedDragPath = parseDragPath(
          paths[0]!.detail,
          dragEvidence.from,
          dragEvidence.to,
        );
      });
      await finishInitial();
      async function freshTask(
        title: string,
        computer = currentCaller,
        workspaceId = bootstrap.homeWorkspace!.id,
      ) {
        const task = await startPhoneAgent(host, computer, {
          key: randomUUID(),
          redaction,
          title,
          workspaceId,
        });
        let finished = false;
        const finish = async () => {
          if (finished) return;
          await task.run.complete();
          await task.gateway.close();
          finished = true;
        };
        const stopDisconnected = async () => {
          expect(computer.primary.socket.readyState).not.toBe(WebSocket.OPEN);
          await stopRun(host, task.run, randomUUID());
          await task.gateway.close();
          finished = true;
        };
        cleanup.push(finish);
        expect((await phoneRow(task.gateway)).access).toBe("read-write");
        const result = await call("observe", undefined, task.gateway);
        expect(result.isError, resultText(result)).not.toBe(true);
        await phone.shell(`am start -W -n ${fixtureActivities.display}`);
        return { task, id: await sessionId(), finish, stopDisconnected };
      }
      await phase("unlocked-pin-is-viewable-and-keyguard-suppresses-pixels", async () => {
        const pin = String(randomInt(10_000_000, 100_000_000));
        redaction.add(pin);
        let configured = false;
        try {
          const output = await phone.shell(`locksettings set-pin ${pin}`);
          configured = true;
          expect(output.startsWith("Pin set to")).toBe(true);
          await phone.shell(`am start -W -n ${fixtureActivities.display}`);
          const own = await ownerView();
          await decodedPixels("unlocked-pin-configured", await firstFrame(own.view));
          const generation = latest(own.view).header.generation;
          const cursor = own.view.trace.events.length;
          await phone.shell("input keyevent KEYCODE_SLEEP");
          await delay(300);
          await phone.shell("input keyevent KEYCODE_WAKEUP");
          await state(own.view, cursor, (message) => message.reason === "locked-screen");
          const after = own.view.trace.frames.length;
          await delay(500);
          expect(own.view.trace.frames).toHaveLength(after);
          const screen = await physicalScreen();
          await phone.shell(
            `input swipe ${Math.round(screen.width / 2)} ${Math.round(screen.height * 0.8)} ${Math.round(screen.width / 2)} ${Math.round(screen.height * 0.2)} 300`,
          );
          await phone.shell(`input text ${pin}`);
          await phone.shell("input keyevent KEYCODE_ENTER");
          const resumed = await firstFrame(own.view, after);
          expect(resumed.header.generation).toBeGreaterThan(generation);
          await decodedPixels("locally-unlocked-pin", resumed);
          await closeOwner(own.source);
          await closed(own.view);
        } finally {
          if (configured) await phone.shell(`locksettings clear --old ${pin}`);
        }
      });
      await phase("local-and-remote-stop-preserve-owner-producer", async () => {
        await phone.shell(`am start -W -n ${fixtureActivities.display}`);
        const own = await ownerView();
        await firstFrame(own.view);
        const stream = frontDoor.latestDisplayStart?.streamId;
        for (const local of [true, false]) {
          const current = await freshTask(local ? "Local Stop" : "Remote Stop");
          const taskView = viewer(current.id);
          await firstFrame(taskView);
          const cursor = own.view.trace.events.length;
          if (local) {
            await phone.shell(`am start -W -n ${agentPhoneActivities.main}`);
            await tapView(phone, { activity: agentPhoneActivities.main, viewId: "session_stop" });
          } else
            await testRpcData(
              host.origin,
              "integration.computer.session.stop",
              { sessionId: current.id },
              owner,
            );
          await closed(taskView);
          expect(own.view.closed).toBe(false);
          expect(
            own.view.trace.events
              .slice(cursor)
              .some(
                (event) =>
                  event.kind === "message" &&
                  event.message.type === "display.state" &&
                  event.message.reason === "session-ended",
              ),
          ).toBe(false);
          await phone.shell(`am start -W -n ${fixtureActivities.display}`);
          const after = own.view.trace.frames.length;
          own.view.send({ type: "display.keyframe" });
          await firstFrame(own.view, after);
          expect(frontDoor.latestDisplayStart?.streamId).toBe(stream);
          expect((await machine())?.computerUse?.ownerViews).toContainEqual(
            expect.objectContaining({
              viewId: own.source.viewId,
              generation: own.source.generation,
            }),
          );
          await current.finish();
        }
        await closeOwner(own.source);
        await closed(own.view);
      });
      if (process.env.OPENSTEER_AGENT_PHONE_EXPO === "1")
        await phase("expo-ios-and-android-real-tile-full-lifecycle", async () => {
          await runExpoPhoneDisplayJourney({
            host,
            phone,
            directory,
            task: async (platform) => {
              const current = await freshTask(`Expo ${platform} viewer`);
              return {
                sessionId: current.id,
                machineId: runnerId,
                finish: current.finish,
                revoke: async () => {
                  await testRpcData(
                    host.origin,
                    "integration.computer.session.stop",
                    { sessionId: current.id },
                    owner,
                  );
                  await current.finish();
                },
              };
            },
          });
        });
      await phase("owner-no-wake-demand-grace-and-lease-expiry", async () => {
        await phone.shell(`am start -W -n ${fixtureActivities.display}`);
        const receiptsBefore = await readReceipts(phone);
        const controlsBefore = phoneInputs.length;
        await phone.shell("input keyevent KEYCODE_SLEEP");
        const sleeping = await ownerView();
        await state(
          sleeping.view,
          0,
          (message) => message.state === "screen-off" || message.reason === "locked-screen",
        );
        await delay(1_000);
        expect(sleeping.view.trace.frames).toEqual([]);
        expect(await phone.shell("dumpsys power")).toMatch(/mWakefulness=Asleep/u);
        expect(phoneInputs).toHaveLength(controlsBefore);
        expect(await sessions()).toEqual([]);
        await phone.shell("input keyevent KEYCODE_WAKEUP");
        await phone.shell("wm dismiss-keyguard");
        await decodedPixels("owner-static-local-wake", await firstFrame(sleeping.view));
        expect(await readReceipts(phone)).toEqual(receiptsBefore);
        const stream = frontDoor.latestDisplayStart?.streamId;
        const after = phoneStates.length;
        await sleeping.view.close();
        await eventually(
          "owner-only projection stops after grace",
          async () =>
            phoneStates
              .slice(after)
              .find((value) => value.streamId === stream && value.state === "stopped"),
          displayDemandGraceMs + 5_000,
          100,
        );
        // Acks and keyframe requests cannot extend the real three-minute authority.
        const expiry = new ComputerDisplayViewer(host, sleeping.source);
        viewers.push(expiry);
        cleanup.push(() => expiry.close());
        await firstFrame(expiry);
        const deadline = Date.parse(sleeping.expiresAt);
        while (Date.now() < deadline && !expiry.closed) {
          expiry.send({ type: "display.keyframe" });
          await delay(Math.min(10_000, Math.max(1, deadline - Date.now())));
        }
        await closed(expiry);
        expect((await machine())?.computerUse?.ownerViews ?? []).toEqual([]);
        expect(await sessions()).toEqual([]);
        const reopened = await ownerView();
        expect(reopened.source.generation).toBeGreaterThan(sleeping.source.generation);
        await decodedPixels("owner-explicit-reopen", await firstFrame(reopened.view));
        await expect(closeOwner(sleeping.source)).rejects.toThrow("computer-view-stale-generation");
        expect(reopened.view.closed).toBe(false);
        await closeOwner(reopened.source);
        await closed(reopened.view);
        evidence.ownerExpiry = {
          source: sleeping.source,
          expiresAt: sleeping.expiresAt,
          endedAt: new Date().toISOString(),
          reopened: reopened.source,
          renewalCount: 0,
        };
      });
      await phase("reboot-ends-both-authorities-with-explicit-owner-reopen", async () => {
        const current = await freshTask("Reboot authority");
        const taskView = viewer(current.id);
        const own = await ownerView();
        await Promise.all([firstFrame(taskView), firstFrame(own.view)]);
        await inputReady(taskView);
        evidence.reboot = await rebootDevice(phone);
        await Promise.all([closed(taskView), closed(own.view)]);
        await waitForPhoneOnline(phone, host, runnerId, 60_000);
        expect((await machine())?.computerUse?.ownerViews ?? []).toEqual([]);
        expect(await sessions()).toEqual([]);
        await expect(
          testRpcData(
            host.origin,
            "commands.dispatch",
            {
              type: "computer.view.renew",
              viewId: own.source.viewId,
              generation: own.source.generation,
              idempotencyKey: randomUUID(),
            },
            owner,
          ),
        ).rejects.toThrow();
        await phone.shell("input keyevent KEYCODE_WAKEUP");
        await phone.shell("wm dismiss-keyguard");
        await phone.shell(`am start -W -n ${fixtureActivities.display}`);
        const reopened = await ownerView();
        await decodedPixels("owner-after-reboot-explicit-open", await firstFrame(reopened.view));
        await closeOwner(reopened.source);
        await closed(reopened.view);
        await current.finish();
      });
      await phase("host-restart-ends-projection-and-independent-authorities", async () => {
        const current = await freshTask("Host restart authority");
        const taskView = viewer(current.id);
        const own = await ownerView();
        await Promise.all([firstFrame(taskView), firstFrame(own.view)]);
        await inputReady(taskView);
        const savedTicket = frontDoor.latestDisplayStart?.dataTicket;
        if (!savedTicket) throw new Error("No data ticket before Host restart");
        const savedMedia = frontDoor.latestDisplayMedia;
        if (!savedMedia) throw new Error("No media before Host restart");
        redaction.add(savedTicket);
        await host.restart();
        observePhoneWire();
        await Promise.all([closed(taskView), closed(own.view)]);
        await waitForPhoneOnline(phone, host, runnerId, 60_000);
        await oldTicketRefused(savedTicket);
        expect((await machine())?.computerUse?.ownerViews ?? []).toEqual([]);
        expect(await sessions()).toEqual([]);
        await current.stopDisconnected();
        expect(
          await host.store.database
            .selectFrom("runs")
            .select("status")
            .where("id", "=", agent.run.runId)
            .executeTakeFirst(),
        ).toEqual({ status: "completed" });
        await expect(
          testRpcData(
            host.origin,
            "commands.dispatch",
            {
              type: "computer.view.renew",
              viewId: own.source.viewId,
              generation: own.source.generation,
              idempotencyKey: randomUUID(),
            },
            owner,
          ),
        ).rejects.toThrow();
        const nextCaller = await connectAgentComputer(host, {
          key: randomUUID(),
          redaction,
          computerTool: 1,
        });
        currentCaller = nextCaller;
        cleanup.push(() => nextCaller.close());
        const next = await freshTask("Task after Host restart", nextCaller);
        expect(next.id).not.toBe(current.id);
        const recovered = viewer(next.id);
        const reopened = await ownerView();
        await Promise.all([firstFrame(recovered), firstFrame(reopened.view)]);
        await inputReady(recovered);
        resetInput(recovered);
        await decodedPixels("task-after-host-restart", recovered.trace.frames[0]!);
        // Reuse the exact old masked binary packet on the new authenticated
        // data connection: its old stream identity must fail before fanout.
        frontDoor.replayDisplayMedia(savedMedia);
        await Promise.all([closed(recovered), closed(reopened.view)]);
        expect(recovered.trace.events.at(-1)).toMatchObject({
          kind: "close",
          reason: "Invalid display media",
        });
        const taskRetry = viewer(next.id);
        const ownerRetry = new ComputerDisplayViewer(host, reopened.source);
        viewers.push(ownerRetry);
        cleanup.push(() => ownerRetry.close());
        await Promise.all([firstFrame(taskRetry), firstFrame(ownerRetry)]);
        await decodedPixels("task-after-old-media-refusal", taskRetry.trace.frames[0]!);
        evidence.oldMediaRefusal = {
          maskedWireSha256: sha256Hex(savedMedia),
          reason: "Invalid display media",
          authorityPreserved: true,
        };
        await taskRetry.close();
        await closeOwner(reopened.source);
        await next.finish();
      });
      await phase("epoch-old-and-future-requests-are-refused", async () => {
        const results = [];
        for (const version of [41, 43]) {
          const result = await fetch(`${host.origin}/v1/rpc/bootstrap.get`, {
            headers: { ...host.ownerHeaders, [hostApiVersionHeader]: String(version) },
          });
          expect(result.status).toBe(400);
          const body: unknown = await result.json();
          expect(body).toMatchObject({ ok: false, error: { reason: "unsupported-version" } });
          results.push({ version, status: result.status, body });
        }
        evidence.epochRefusals = results;
      });
      await phase("grant-revocation-ends-task-and-control-only", async () => {
        const workspace = await testRpcData(
          host.origin,
          "commands.dispatch",
          {
            type: "workspace.create",
            name: "Display grant revocation",
            idempotencyKey: randomUUID(),
          },
          owner,
        );
        if (workspace.type !== "workspace.create") throw new Error("Workspace command mismatch");
        const { connections } = await testRpcData(host.origin, "integrations.get", {}, owner);
        const connection = connections.find(
          (row) =>
            row.definitionId === androidPhoneDefinitionId &&
            row.computer?.runnerId === runnerId &&
            row.status !== "revoked",
        );
        const installation = (
          await host.store.database
            .selectFrom("integrationInstallations")
            .select(["id", "provenance"])
            .execute()
        ).find(
          (row) =>
            z
              .object({ definitionId: z.literal(androidPhoneDefinitionId) })
              .safeParse(row.provenance).success,
        );
        if (!connection || !installation) throw new Error("Phone connection/installation missing");
        const granted = await testRpcData(
          host.origin,
          "commands.dispatch",
          {
            type: "integration.grant.create",
            idempotencyKey: randomUUID(),
            input: {
              access: "read-write",
              alias: "Revocation phone",
              connectionId: connection.id,
              installationId: installation.id,
              isDefault: false,
              workspaceId: workspace.workspace.id,
            },
          },
          owner,
        );
        if (granted.type !== "integration.grant.create") throw new Error("Grant command mismatch");
        const current = await freshTask(
          "Revoked workspace grant",
          currentCaller,
          workspace.workspace.id,
        );
        const taskView = viewer(current.id);
        const own = await ownerView();
        await Promise.all([firstFrame(taskView), firstFrame(own.view)]);
        await inputReady(taskView);
        await testRpcData(
          host.origin,
          "commands.dispatch",
          {
            type: "integration.grant.revoke",
            grantId: granted.grant.id,
            workspaceId: workspace.workspace.id,
            idempotencyKey: randomUUID(),
          },
          owner,
        );
        await closed(taskView);
        expect(own.view.closed).toBe(false);
        const after = own.view.trace.frames.length;
        own.view.send({ type: "display.keyframe" });
        await firstFrame(own.view, after);
        await closeOwner(own.source);
        await closed(own.view);
        await current.finish();
      });
      await phase("non-owner-privacy-and-effective-owner-revocation", async () => {
        const stranger = await signUpUser(
          host,
          {
            email: `display-${randomUUID()}@example.test`,
            password: randomUUID(),
          },
          host.publicOrigin,
        );
        redaction.add(...Object.values(stranger.headers));
        const current = await freshTask("Ownership revocation");
        const taskView = viewer(current.id);
        const own = await ownerView();
        await Promise.all([firstFrame(taskView), firstFrame(own.view)]);
        await inputReady(taskView);
        const headers = { ...stranger.headers, origin: host.publicOrigin };
        const otherMachine = (
          await testRpcData(host.origin, "machines.list", {}, { headers })
        ).machines.find((row) => row.id === runnerId);
        expect(otherMachine?.computerUse ?? null).toBeNull();
        expect(otherMachine?.apps ?? []).toEqual([]);
        const denied = new ComputerDisplayViewer({ ...host, ownerHeaders: headers }, own.source);
        await eventually(
          "non-owner socket refused",
          async () => (denied.closed ? true : undefined),
          15_000,
        );
        expect(denied.trace.frames).toEqual([]);
        await expect(
          host.store.database
            .updateTable("runners")
            .set({ ownerUserId: stranger.userId })
            .where("id", "=", runnerId)
            .execute(),
        ).rejects.toThrow("runner execution ownership is immutable");
        // Local enrollment ownership cannot be transferred. Inject a changed
        // policy answer at the real Host's owner boundary to exercise its live
        // revocation path without disabling the database's identity invariant.
        const resolveOwners = host.store.effectiveMachineOwners.bind(host.store);
        const ownership = vi
          .spyOn(host.store, "effectiveMachineOwners")
          .mockImplementation(async (ids) => {
            const owners = new Map(await resolveOwners(ids));
            const prior = owners.get(runnerId);
            if (prior) owners.set(runnerId, { ...prior, effectiveOwner: stranger.userId });
            return owners;
          });
        try {
          await Promise.all([closed(taskView), closed(own.view)]);
        } finally {
          ownership.mockRestore();
        }
        await delay(1_000);
        expect(own.view.closed && taskView.closed).toBe(true);
        expect((await machine())?.computerUse?.ownerViews ?? []).toEqual([]);
        evidence.effectiveOwnerRevocation = {
          persistedLocalRunnerOwnershipImmutable: true,
          faultInjectedBoundary: "store.effectiveMachineOwners",
          taskAndOwnerClosed: true,
          reopenedAutomatically: false,
        };
        await current.finish();
      });
      await phase("owner-off-on-lower-and-widen-end-old-authorities", async () => {
        const setAccess = async (access: "read" | "read-write") => {
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
                access,
              },
            },
            owner,
          );
          await assertNoPhoneApprovalActivity(phone);
        };
        const staleAuthorityRefused = async (
          source: ConstructorParameters<typeof ComputerDisplayViewer>[1],
        ) => {
          const path =
            source.kind === "task-session"
              ? `/v1/computer-use/sessions/${source.sessionId}/display`
              : `/v1/computer-use/views/${source.viewId}/${source.generation}/display`;
          const url = new URL(path, host.origin);
          url.protocol = "ws:";
          const refused = await new Promise<{ status: number; body: string }>((resolve, reject) => {
            const socket = new WebSocket(url, {
              headers: { ...host.ownerHeaders, host: new URL(host.publicOrigin).host },
            });
            const timer = setTimeout(() => {
              socket.terminate();
              reject(new Error("Stale authority refusal timed out"));
            }, 5_000);
            socket.once("open", () => {
              clearTimeout(timer);
              socket.terminate();
              reject(new Error("An ended phone authority reopened a viewer"));
            });
            socket.on("error", () => undefined);
            socket.once("unexpected-response", (_request, response) => {
              let body = "";
              response.setEncoding("utf8");
              response.on("data", (chunk: string) => {
                body += chunk;
              });
              response.on("end", () => {
                clearTimeout(timer);
                socket.terminate();
                resolve({ status: response.statusCode ?? 0, body });
              });
            });
          });
          expect(refused.status, "ended authority must refuse the authenticated upgrade").toBe(
            source.kind === "task-session" ? 403 : 409,
          );
          expect(refused.body, "refusal identifies the ended or stale authority").toMatch(
            /ended|stale|not found|reopen/iu,
          );
          return refused;
        };
        const current = await freshTask("Owner turns phone off");
        const taskView = viewer(current.id);
        const own = await ownerView();
        await Promise.all([firstFrame(taskView), firstFrame(own.view)]);
        await inputReady(taskView);
        const oldTicket = frontDoor.latestDisplayStart?.dataTicket;
        if (!oldTicket) throw new Error("No display ticket before owner Off");
        const connection = (
          await testRpcData(host.origin, "integrations.get", {}, owner)
        ).connections.find(
          (row) =>
            row.definitionId === androidPhoneDefinitionId &&
            row.computer?.runnerId === runnerId &&
            row.status !== "revoked",
        );
        if (!connection) throw new Error("Phone connection missing before owner Off");
        await expect(
          testRpcData(
            host.origin,
            "commands.dispatch",
            {
              type: "integration.computer.app.block",
              connectionId: connection.id,
              idempotencyKey: randomUUID(),
            },
            owner,
          ),
        ).rejects.toThrow("Computer app not found");
        expect(
          taskView.closed || own.view.closed,
          "Mac block refusal preserves phone authorities",
        ).toBe(false);
        await testRpcData(
          host.origin,
          "commands.dispatch",
          {
            type: "integration.disconnect",
            connectionId: connection.id,
            idempotencyKey: randomUUID(),
          },
          owner,
        );
        await Promise.all([closed(taskView), closed(own.view)]);
        expect(await sessions(), "Off removes task sessions").toEqual([]);
        expect(
          (await machine())?.computerUse?.ownerViews ?? [],
          "Off removes owner authorities",
        ).toEqual([]);
        await expect(ownerView()).rejects.toThrow();
        await oldTicketRefused(oldTicket);

        await setAccess("read-write");
        await phone.shell(`am start -W -n ${fixtureActivities.display}`);
        const on = await freshTask("Owner turns phone back on");
        expect(on.id, "On opens a new task authority").not.toBe(current.id);
        const onTaskView = viewer(on.id);
        const onOwner = await ownerView();
        await Promise.all([firstFrame(onTaskView), firstFrame(onOwner.view)]);
        // The owner's view keeps its id; reopening it is a newer generation.
        expect(onOwner.source.viewId).toBe(own.source.viewId);
        expect(onOwner.source.generation).toBeGreaterThan(own.source.generation);
        await inputReady(onTaskView);
        const onTicket = frontDoor.latestDisplayStart?.dataTicket;
        if (!onTicket) throw new Error("No display ticket before owner lowers access");
        await oldTicketRefused(oldTicket);
        const offRefusals = await Promise.all([
          staleAuthorityRefused({ kind: "task-session", sessionId: current.id }),
          staleAuthorityRefused(own.source),
        ]);
        await current.finish();

        await setAccess("read");
        await closed(onTaskView);
        expect(await sessions(), "lowering ends the prior task authority").toEqual([]);
        // Seeing needs only read, so the owner's own view of the phone stays.
        expect(onOwner.view.closed, "lowering keeps the owner's view").toBe(false);
        const row = await phoneRow(on.task.gateway);
        expect(row.access).toBe("read");
        const refused = await call("act", [{ type: "wake" }], on.task.gateway);
        expect(refused.isError, "the held phone handle cannot act after lowering").toBe(true);
        expect(resultText(refused), "lowering to read refuses native actions").toBe(
          `failed: ${row.name} allows seeing only. Ask for read-write access to act: call integration_request {kind: "computer-app", runnerId, access, reason} with access "read-write"; do not retry this call until it is fulfilled.`,
        );
        await setAccess("read-write");
        await oldTicketRefused(onTicket);
        const lowerRefusals = await staleAuthorityRefused({
          kind: "task-session",
          sessionId: on.id,
        });
        expect(onOwner.view.closed, "widening keeps the owner's view").toBe(false);
        expect((await sessions()).some(({ sessionId }) => sessionId === on.id)).toBe(false);
        await on.finish();
        const final = await freshTask("New authority after widening");
        const finalTask = viewer(final.id);
        await firstFrame(finalTask);
        await inputReady(finalTask);
        await closeOwner(onOwner.source);
        await final.finish();
        evidence.ownerAccess = {
          offTask: current.id,
          onTask: on.id,
          widenedTask: final.id,
          oldTicketsRefused: true,
          loweredActRefused: true,
          noApprovalActivity: true,
          offRefusals,
          lowerRefusals,
        };
      });
      await phase("sign-out-ends-login-viewers-and-contact", async () => {
        const current = await freshTask("Signed out display");
        const taskView = viewer(current.id);
        const own = await ownerView();
        await Promise.all([firstFrame(taskView), firstFrame(own.view)]);
        await inputReady(taskView);
        const beforeContact = await baseline();
        (await pointerSender(taskView))("down", await point("fixture_button"));
        await receipt("button_touch", beforeContact, "down");
        await testRpcData(host.origin, "auth.signOut", {}, owner);
        await Promise.all([closed(taskView), closed(own.view)]);
        await receipt("button_touch", beforeContact, "cancel");
        expect(taskView.trace.events.at(-1)).toMatchObject({ kind: "close" });
        await current.finish();
      });
    }
    completed = true;
  } catch (error) {
    failure = redaction.error(error);
    throw error;
  } finally {
    for (const close of cleanup.reverse()) {
      try {
        await withTimeout(close(), 90_000, {
          timeoutError: () => new Error("Display journey cleanup exceeded 90s."),
        });
      } catch (error) {
        cleanupFailures.push(redaction.error(error));
      }
    }
    await deviceLog?.stop();
    if (deviceLog)
      await writeFile(
        join(directory, "logcat.txt"),
        redaction.apply(deviceLog.allLines().join("\n")),
      );
    for (const [index, view] of viewers.entries()) {
      const keyframes = view.trace.frames.filter((frame) => frame.header.key);
      for (const frame of keyframes)
        await writeFile(
          join(
            directory,
            `viewer-${index}-generation-${frame.header.generation}-sequence-${frame.header.sequence}.h264`,
          ),
          frame.payload,
        );
    }
    await rm(scratch, { force: true, recursive: true });
    await flush();
    await writeDeviceTestManifest(directory, redaction, { completed, cleanupFailures });
  }
  expect(cleanupFailures, "every display journey resource must stop").toEqual([]);
  expect(completed).toBe(true);
  expect(cleanupFailures).toEqual([]);
});
