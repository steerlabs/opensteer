import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { z } from "zod";
import { createId } from "../../../../../packages/core/src/index.js";
import { testRpcData } from "../../../../host/src/server/test-host-api-request.js";
import {
  connectCallerMachine,
  createMachineAccessDatabase,
  dispatchCallerRun,
  enrollmentToken,
  startMachineAccessHost,
  waitForCondition,
} from "../../../../host/src/runtime/machine-access.test-support.js";
import {
  integrationGateway,
  operation,
  requestComputerAppSetup,
  toolText,
} from "../../../../host/src/runtime/computer-apps.test-support.js";

const packagePath = fileURLToPath(new URL("../ios", import.meta.url));
const sourceRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
const frameSchema = z.object({ type: z.string() }).passthrough();
const responseSchema = z.object({ kind: z.string() }).passthrough();
type NativeResponse = z.infer<typeof responseSchema>;

class NativeLines {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly waiting: ((response: NativeResponse) => void)[] = [];
  readonly stderr: string[] = [];
  constructor() {
    this.process = spawn(
      "swift",
      ["run", "-j", "2", "--package-path", packagePath, "IphoneAppsNativeJourney"],
      { cwd: sourceRoot, stdio: ["pipe", "pipe", "pipe"], detached: true },
    );
    const lines = createInterface({ input: this.process.stdout });
    lines.on("line", (line) => {
      const answer = responseSchema.parse(JSON.parse(line) as unknown);
      const next = this.waiting.shift();
      if (next) next(answer);
    });
    this.process.stderr.on("data", (chunk: Buffer) => this.stderr.push(chunk.toString("utf8")));
  }
  command(value: Record<string, unknown>): Promise<NativeResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Swift core did not answer a journey command")),
        120_000,
      );
      this.waiting.push((answer) => {
        clearTimeout(timer);
        resolve(answer);
      });
      this.process.stdin.write(JSON.stringify(value) + "\n");
    });
  }
  async close() {
    this.process.stdin.end();
    await new Promise<void>((resolve) => {
      if (this.process.exitCode !== null) {
        resolve();
        return;
      }
      const terminate = setTimeout(() => {
        try {
          if (this.process.pid) process.kill(-this.process.pid, "SIGTERM");
        } catch {
          /* exited */
        }
      }, 3_000);
      const force = setTimeout(() => {
        try {
          if (this.process.pid) process.kill(-this.process.pid, "SIGKILL");
        } catch {
          /* exited */
        }
      }, 6_000);
      this.process.once("exit", () => {
        clearTimeout(terminate);
        clearTimeout(force);
        resolve();
      });
    });
  }
}

class HostBridge {
  private primary: WebSocket;
  private auxiliary: WebSocket | null = null;
  private heartbeats: ReturnType<typeof setInterval> | null = null;
  online = false;
  synchronized = false;
  approvalCount = 0;
  approvalRequestIds: string[] = [];
  approvalKeyId: string | null = null;
  outcome: string | null = null;
  failure: Error | null = null;
  readonly observed: unknown[] = [];
  lastInvoke: Record<string, unknown> | null = null;
  lastApprovals: Record<string, unknown> | null = null;
  constructor(
    private readonly native: NativeLines,
    private readonly hostPort: number,
  ) {
    this.primary = this.socket("primary", "/internal/v1/runners");
  }
  private socket(channel: "primary" | "auxiliary", path: string): WebSocket {
    const socket = new WebSocket(`ws://127.0.0.1:${this.hostPort}${path}`);
    socket.on("message", (raw: WebSocket.RawData) => {
      void this.frame(channel, raw.toString()).catch((error: unknown) => {
        this.failure = error instanceof Error ? error : new Error(String(error));
      });
    });
    socket.on("error", (error) => {
      this.failure = error;
    });
    return socket;
  }
  private async frame(channel: "primary" | "auxiliary", raw: string) {
    const frame = frameSchema.parse(JSON.parse(raw) as unknown);
    if (frame.type === "host.integrations.invoke") this.lastInvoke = frame;
    if (frame.type === "host.integrations.computer-app-approvals") this.lastApprovals = frame;
    this.observed.push({ channel, type: frame.type });
    if (frame.type === "host.error" || frame.type === "host.auxiliary.rejected") {
      throw new Error(`Host refused native Swift: ${raw}`);
    }
    const answer = await this.native.command({ command: channel, frame });
    await this.route(answer);
    if (frame.type === "host.auxiliary.welcome") {
      this.online = true;
      this.heartbeats = setInterval(() => {
        void this.native
          .command({ command: "heartbeat" })
          .then((next) => this.route(next))
          .catch((error: unknown) => {
            this.failure = error instanceof Error ? error : new Error(String(error));
          });
      }, 5_000);
    }
    if (answer.kind === "approvals") {
      this.synchronized = true;
      this.approvalCount = Number(answer.count);
      this.approvalRequestIds = z.array(z.string()).parse(answer.requestIds);
      this.approvalKeyId = typeof frame.approvalKeyId === "string" ? frame.approvalKeyId : null;
    }
    if (answer.kind === "outcome") {
      const value = z.object({ kind: z.string() }).parse(answer.value);
      this.outcome = value.kind;
    }
  }
  async route(answer: NativeResponse): Promise<void> {
    if (answer.kind === "error")
      throw new Error(`Swift core rejected Host frame: ${String(answer.message)}`);
    if (answer.kind === "answer-dropped") {
      // Lose the transport after the fake OS saved, before its reply reaches
      // the Host. A healthy stream with one omitted reply is a different fault.
      expect((await this.native.command({ command: "transport-lost" })).kind).toBe("detached");
      await this.close();
      return;
    }
    if (answer.kind === "ticket") {
      if (this.auxiliary) throw new Error("Host sent two auxiliary tickets");
      this.auxiliary = this.socket("auxiliary", "/internal/v1/runners/auxiliary/integrations");
    }
    const messages =
      answer.kind === "frames"
        ? z.array(z.unknown()).parse(answer.frames)
        : answer.kind === "frame"
          ? [answer]
          : [];
    for (const message of messages) {
      const outgoing = z
        .object({
          channel: z.enum(["primary", "auxiliary"]),
          frame: z.record(z.string(), z.unknown()),
        })
        .parse(message);
      const socket = outgoing.channel === "primary" ? this.primary : this.auxiliary;
      if (!socket) throw new Error("Swift tried to send before auxiliary attach");
      socket.send(JSON.stringify(outgoing.frame));
    }
  }
  async close() {
    if (this.heartbeats) clearInterval(this.heartbeats);
    for (const socket of [this.auxiliary, this.primary]) {
      if (!socket || socket.readyState === WebSocket.CLOSED) continue;
      socket.close(1000, "Native journey complete");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          socket.terminate();
          resolve();
        }, 3_000);
        socket.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
suite.sequential("production Swift core against real Host and PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof createMachineAccessDatabase>>;
  beforeAll(async () => {
    database = await createMachineAccessDatabase(databaseUrl!);
  }, 120_000);
  afterAll(async () => {
    await database.drop();
  }, 120_000);

  it("executes Calendar, Location and Photos through production Swift and fake OS ports", async () => {
    const evidence =
      process.env.OPENSTEER_IPHONE_APPS_EVIDENCE_DIR ??
      (await mkdtemp(join(tmpdir(), "opensteer-iphone-native-journey-")));
    await mkdir(evidence, { recursive: true });
    const host = await startMachineAccessHost(database.url, { signupPolicy: "open" });
    const native = new NativeLines();
    let bridge: HostBridge | null = null;
    let caller: Awaited<ReturnType<typeof connectCallerMachine>> | null = null;
    let run: Awaited<ReturnType<typeof dispatchCallerRun>> | null = null;
    let gateway: Awaited<ReturnType<typeof integrationGateway>> | null = null;
    const record: Record<string, unknown> = { kind: "incomplete" };
    let stage = "enrollment";
    try {
      const runnerId = createId("runner");
      const mintInput = {
        idempotencyKey: `iphone-native:${randomUUID()}`,
        name: "VM fake iPhone",
        profile: "iphone",
        type: "runner.enrollment.createPhone" as const,
      };
      const target = await testRpcData(host.origin, "commands.dispatch", mintInput, {
        headers: host.ownerHeaders,
      });
      if (target.type !== "runner.enrollment.createPhone")
        throw new Error("Wrong enrollment answer");
      const descriptor = {
        bootId: `rbt_${randomUUID()}`,
        capabilities: [],
        device: { form: "phone", platform: "ios" },
        modules: {
          integrations: { computerAppApprovals: true, platform: "ios", protocolVersion: 1 },
        },
        name: "VM fake iPhone",
        runnerId,
        runnerKind: "local",
        runtimeVersion: "0.1.202",
      };
      const started = z
        .object({
          kind: z.literal("started"),
          approvalPublicKey: z.string(),
          approvalKeyId: z.string(),
        })
        .parse(
          await native.command({
            command: "start",
            descriptor,
            enrollmentToken: target.token,
            runnerSeed: Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index)).toString(
              "hex",
            ),
            approvalSeed: Buffer.from(
              Uint8Array.from({ length: 32 }, (_, index) => 255 - index),
            ).toString("hex"),
          }),
        );
      bridge = new HostBridge(native, host.hostPort);
      await waitForCondition(async () => bridge!.synchronized || bridge!.failure !== null);
      if (bridge.failure) throw bridge.failure;

      await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          idempotencyKey: `iphone-approval-key:${runnerId}`,
          input: { publicKey: started.approvalPublicKey, runnerId },
          type: "integration.computer.approval-key.set",
        },
        { headers: host.ownerHeaders },
      );
      const setup = await requestComputerAppSetup(
        host,
        runnerId,
        "read-write",
        `iphone-calendar:${randomUUID()}`,
        "apple-calendar",
      );
      await waitForCondition(
        async () =>
          (bridge!.approvalRequestIds.includes(setup.id) &&
            bridge!.approvalKeyId === started.approvalKeyId) ||
          bridge!.failure !== null,
      );
      if (bridge.failure) throw bridge.failure;
      const answer = await native.command({
        command: "answer",
        setupRequestId: setup.id,
        definitionId: "apple-calendar",
        access: "read-write",
        decision: "allow",
      });
      await bridge.route(answer);
      await waitForCondition(async () => bridge!.outcome !== null || bridge!.failure !== null);
      if (bridge.failure) throw bridge.failure;
      expect(bridge.outcome).toBe("allowed");
      const connection = await host.store.database
        .selectFrom("integrationConnections")
        .select("id")
        .where("runnerId", "=", runnerId)
        .where("integrationDefinitionId", "=", "apple-calendar")
        .executeTakeFirstOrThrow();

      const approvedApps: {
        access: "read" | "read-write";
        connectionId: string;
        definitionId: string;
        name: string;
      }[] = [
        {
          access: "read-write",
          connectionId: connection.id,
          definitionId: "apple-calendar",
          name: "Calendar",
        },
      ];
      const metadataApprovals: Record<string, string | null> = {};
      for (const app of [
        { definitionId: "iphone-location", name: "Location" },
        { definitionId: "iphone-photos", name: "Photos" },
      ]) {
        stage = `${app.definitionId}-approval`;
        const request = await requestComputerAppSetup(
          host,
          runnerId,
          "read",
          `${app.definitionId}:${randomUUID()}`,
          app.definitionId,
        );
        await waitForCondition(
          async () => bridge!.approvalRequestIds.includes(request.id) || bridge!.failure !== null,
        );
        if (bridge.failure) throw bridge.failure;
        bridge.outcome = null;
        await bridge.route(
          await native.command({
            command: "answer",
            setupRequestId: request.id,
            definitionId: app.definitionId,
            access: "read",
            decision: "allow",
          }),
        );
        await waitForCondition(async () => bridge!.outcome !== null || bridge!.failure !== null);
        if (bridge.failure) throw bridge.failure;
        expect(bridge.outcome).toBe("allowed");
        metadataApprovals[app.definitionId] = bridge.outcome;
        const metadataConnection = await host.store.database
          .selectFrom("integrationConnections")
          .select("id")
          .where("runnerId", "=", runnerId)
          .where("integrationDefinitionId", "=", app.definitionId)
          .executeTakeFirstOrThrow();
        approvedApps.push({ ...app, access: "read", connectionId: metadataConnection.id });
      }

      stage = "caller-enrollment";
      caller = await connectCallerMachine(host, {
        name: "Caller",
        token: await enrollmentToken(host, {
          allowedModules: ["agents"],
          idempotencyKey: `iphone-caller:${randomUUID()}`,
          name: "Caller",
        }),
      });
      stage = "caller-run";
      run = await dispatchCallerRun(host, caller, {
        key: `iphone-run:${randomUUID()}`,
        title: "VM iPhone providers",
      });
      stage = "gateway-open";
      gateway = await integrationGateway(run.integrationTools);
      for (const app of approvedApps) {
        stage = `${app.definitionId}-agent-access`;
        await gateway.call("integration_request", {
          access: app.access,
          integration: app.definitionId,
          reason: `Exercise the native ${app.name} dispatcher`,
        });
        const pending = await host.store.requests.listPendingIntegrationAccessRequests(
          host.ownerId,
        );
        const accessRequest = pending.at(-1);
        if (!accessRequest) throw new Error(`${app.name} agent access request missing`);
        await testRpcData(
          host.origin,
          "commands.dispatch",
          {
            idempotencyKey: `iphone-agent-access:${randomUUID()}`,
            requestId: accessRequest.request.id,
            response: {
              kind: "external",
              value: {
                access: app.access,
                alias: `${app.name} on VM fake iPhone`,
                connectionId: app.connectionId,
                decision: "fulfilled",
                isDefault: true,
              },
            },
            type: "request.respond",
          },
          { headers: host.ownerHeaders },
        );
      }
      stage = "integration-search";
      const search = await gateway.call("integration_search", { query: "Calendar" });
      stage = "calendar-list";
      const listed = await gateway.call("integration_call", {
        arguments: {},
        toolRef: operation(search, "list_calendars").toolRef,
      });
      expect(listed).toMatchObject({ calendars: [expect.objectContaining({ id: "vm-calendar" })] });
      stage = "calendar-create";
      const created = await gateway.call("integration_call", {
        arguments: {
          title: "Native VM event",
          start: "2030-01-01T10:00:00Z",
          end: "2030-01-01T11:00:00Z",
        },
        toolRef: operation(search, "create_event").toolRef,
      });
      expect(created).toMatchObject({
        event: expect.objectContaining({ title: "Native VM event" }),
      });
      const afterCreate = await native.command({ command: "snapshot" });
      expect(afterCreate.fakeCalendarSaveCount).toBe(1);
      expect(afterCreate.workTransitions).toEqual(expect.arrayContaining([1, 0]));
      stage = "location-current";
      const locationSearch = await gateway.call("integration_search", { query: "Location" });
      const location = await gateway.call("integration_call", {
        arguments: { maxAgeSeconds: 0 },
        toolRef: operation(locationSearch, "current_location").toolRef,
      });
      expect(location).toEqual({
        latitude: 40.7128,
        longitude: -74.006,
        horizontalAccuracyMeters: 120,
        capturedAt: expect.any(String),
        accuracy: "approximate",
      });
      expect(Number.isFinite(Date.parse(String(location.capturedAt)))).toBe(true);
      stage = "photos-list-assets";
      const photosSearch = await gateway.call("integration_search", { query: "Photos" });
      const photos = await gateway.call("integration_call", {
        arguments: {},
        toolRef: operation(photosSearch, "list_assets").toolRef,
      });
      expect(photos).toEqual({
        scope: "selected",
        assets: [
          {
            id: "vm-selected-photo",
            createdAt: "2030-01-01T10:00:00.000Z",
            modifiedAt: "2030-01-02T10:00:00.000Z",
            mediaKind: "image",
            width: 1200,
            height: 800,
            durationSeconds: null,
            favorite: true,
          },
        ],
        nextCursor: null,
      });
      const providerSnapshot = await native.command({ command: "snapshot" });
      expect(providerSnapshot.fakeLocationStarts).toBe(1);
      expect(providerSnapshot.fakeLocationStops).toBe(1);
      expect(providerSnapshot.fakePhotosAssetFetches).toBeGreaterThan(0);
      expect((await native.command({ command: "drop-next-answer" })).kind).toBe("armed");
      stage = "lost-answer";
      const lost = await gateway.callRaw("integration_call", {
        arguments: {
          title: "Native VM lost-answer event",
          start: "2030-01-02T10:00:00Z",
          end: "2030-01-02T11:00:00Z",
        },
        toolRef: operation(search, "create_event").toolRef,
      });
      expect(toolText(lost)).toContain("did not confirm this");
      expect((await native.command({ command: "snapshot" })).fakeCalendarSaveCount).toBe(2);
      const previousInvoke = bridge.lastInvoke;
      expect(previousInvoke).not.toBeNull();
      const previousApprovals = bridge.lastApprovals;
      expect(previousApprovals).not.toBeNull();
      expect((await native.command({ command: "transport-lost" })).kind).toBe("detached");
      expect((await native.command({ command: "auxiliary", frame: previousApprovals })).kind).toBe(
        "error",
      );
      const stale = await native.command({
        command: "auxiliary",
        frame: { ...previousInvoke, requestId: `stale-${randomUUID()}` },
      });
      expect(stale.kind).not.toBe("answer-dropped");
      expect((await native.command({ command: "snapshot" })).fakeCalendarSaveCount).toBe(2);
      const approvalOutcome = bridge.outcome;
      const enrollmentFrames = bridge.observed;
      await bridge.close();
      expect((await native.command({ command: "resume" })).kind).toBe("resumed");
      bridge = new HostBridge(native, host.hostPort);
      await waitForCondition(async () => bridge!.synchronized || bridge!.failure !== null);
      if (bridge.failure) throw bridge.failure;
      stage = "reauthenticated-list";
      const afterReauthentication = await gateway.call("integration_call", {
        arguments: {},
        toolRef: operation(search, "list_calendars").toolRef,
      });
      expect(afterReauthentication).toMatchObject({
        calendars: [expect.objectContaining({ id: "vm-calendar" })],
      });
      expect((await native.command({ command: "snapshot" })).fakeCalendarSaveCount).toBe(2);
      Object.assign(record, {
        kind: "passed",
        runnerId,
        connectionId: connection.id,
        approvedApps,
        listed,
        created,
        location,
        photos,
        metadataApprovals,
        providerEvidence: {
          calendar: { osPort: "fake Calendar", productionDispatch: true },
          location: {
            provider: "IphoneLocationProvider",
            osPort: "fake IphoneLocationPort",
            validated: ["fresh fix acquisition", "approximate coordinates", "capturedAt"],
            starts: providerSnapshot.fakeLocationStarts,
            stops: providerSnapshot.fakeLocationStops,
          },
          photos: {
            provider: "IphonePhotosProvider",
            osPort: "fake IphonePhotosStorePort",
            validated: ["selected scope", "asset metadata", "metadata-only result schema"],
            assetFetches: providerSnapshot.fakePhotosAssetFetches,
          },
          unverified: ["real CoreLocation", "real PhotoKit", "iOS consent dialogs"],
        },
        lost: toolText(lost),
        fakeSaveCount: 2,
        reauthenticated: true,
        approvalOutcome,
        observedFrames: [...enrollmentFrames, ...bridge.observed],
      });
    } catch (error) {
      record.stage = stage;
      record.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      await gateway?.close().catch(() => undefined);
      await run?.complete().catch(() => undefined);
      await caller?.close().catch(() => undefined);
      await bridge?.close().catch(() => undefined);
      await native.close();
      await host.close();
      await writeFile(
        join(evidence, "native-journey-result.json"),
        JSON.stringify({ ...record, swiftStderr: native.stderr.join("") }, null, 2),
      );
    }
  }, 180_000);
});
