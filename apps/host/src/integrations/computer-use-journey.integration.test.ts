import { type ComputerViewNativeResult } from "@opensteer/protocol";
import { BrowserService } from "../browser/browser-service.js";
import { BrowserAttachTicketSigner } from "../browser/browser-ticket.js";
import { BrowserProfileVault } from "../browser/profile-vault.js";
import { placeList, type HostSnapshot } from "@opensteer/client/host";
import { createHostServer } from "../server.js";
import { hostServerTestDependencies } from "../server/host-server-test-harness.js";
import { injectRpcRequest } from "../server/test-host-api-request.js";
import { signHostDiscovery } from "../identity/host-keys.js";
import { AgentControlService } from "../agents/agent-control-service.js";
import { CommandService, KeyedAdmissionQueue } from "@opensteer/orchestration";
import { placeInputFailure } from "@opensteer/core";
import { PlaceContextService } from "../computer-use/place-context-service.js";
import { resolvedInputParts } from "@opensteer/harness";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  HarnessIdSchema,
  SequenceSchema,
  ModelSelectionSchema,
  ThreadAccessModeSchema,
  createId,
  type AgentEvent,
  type ContentPart,
  type EnvironmentId,
  type HarnessInstanceId,
  type RunnerId,
  type RunId,
  type ThreadId,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import {
  createDatabase,
  IntegrationPlatformStore,
  IntegrationStore,
  OpensteerStore,
} from "@opensteer/database";
import { computerAppIntegrations } from "@opensteer/integration-catalog";
import { type ComputerAppIdentity, type IntegrationDefinition } from "@opensteer/integration-core";
import {
  RealtimeHub,
  type RealtimeSink,
  type RunnerAuxiliaryStream,
} from "@opensteer/orchestration";
import {
  readComputerUseResultHeadline,
  WindowInfoSchema,
  ComputerUseObservationSchema,
  RunnerAuxiliaryStreamIdSchema,
  RunnerBootIdSchema,
  RunnerConnectionIdSchema,
  RunnerConnectionLeaseIdSchema,
  ComputerUseSessionIdSchema,
  type ComputerUseSessionId,
  type ComputerAppApprovalAnswer,
  type ComputerAppApprovalList,
  type ComputerAppApprovalOutcome,
  type ComputerUseErrorCode,
  createBrowserSessionId,
  type BrowserSessionOpenerRecord,
  type BrowserTabOpenBinding,
  BrowserSurfaceIdSchema,
  type BrowserSessionId,
  type HostIntegrationsComputerView,
  type HostIntegrationsComputerUse,
  type HostIntegrationsOperation,
  type PendingAgentEvent,
  type RunnerAuxiliaryFrameFence,
  type RunnerDescriptor,
} from "@opensteer/protocol";
import { createComputerAppApproval } from "@opensteer/runner-auth";
import { ManualClock } from "@opensteer/shared/test-support/clock";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  continuationMessage,
  type IntegrationInventorySource,
} from "../agents/continuation-service.js";
import { ComputerAppHub, type ComputerAppControlPeer } from "../computer-apps/computer-app-hub.js";
import {
  ComputerUseService,
  computerUseBusyNextStep,
} from "../computer-use/computer-use-service.js";
import {
  createMachineAccessDatabase,
  resetMachineAccessDatabase,
  startMachineAccessHost,
} from "../runtime/machine-access.test-support.js";
import { notifyComputerPresence } from "../shell/machine-access-events.js";
import { projectMachines } from "../runtime/machines.js";
import type { RunCapabilityClaims } from "../agents/run-capability.js";
import { createHostRuntime } from "../runtime/runtime.js";
import { testRpcData } from "../server/test-host-api-request.js";
import { IntegrationPlatformService } from "./integration-platform-service.js";

/**
 * The whole computer-use journey as a model walks it: the real gateway MCP
 * handlers, the real platform and session services, real Postgres stores, and
 * fake Macs and phones answering on real fenced `integrations` streams.
 * Assertions cover the model's answers, the dispatched frames and durable
 * execution authority.
 */

interface McpCallExtra {
  readonly authInfo?: {
    readonly clientId: string;
    readonly extra?: Record<string, unknown>;
    readonly scopes: string[];
    readonly token: string;
  };
  readonly requestId: string | number;
  readonly sessionId?: string;
  readonly signal: AbortSignal;
}
type CallHandler = (
  request: { params: { arguments?: unknown; name: string } },
  extra: McpCallExtra,
) => Promise<ToolResult>;
interface ToolResult {
  readonly content: readonly (
    | { readonly text: string; readonly type: "text" }
    | { readonly data: string; readonly mimeType: string; readonly type: "image" }
  )[];
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
}

const mcp = vi.hoisted(() => ({
  callHandler: undefined as CallHandler | undefined,
  instructions: "",
  listHandler: undefined as
    ((request: unknown, extra: McpCallExtra) => Promise<unknown>) | undefined,
  registrations: 0,
}));

vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: class {
    constructor(_identity: unknown, options: { instructions: string }) {
      mcp.instructions = options.instructions;
    }
    async close() {}
    async connect() {}
    setRequestHandler(_schema: unknown, handler: unknown) {
      mcp.registrations += 1;
      if (mcp.registrations % 2 === 1)
        mcp.listHandler = handler as (request: unknown, extra: McpCallExtra) => Promise<unknown>;
      else mcp.callHandler = handler as CallHandler;
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => ({
  StreamableHTTPServerTransport: class {
    readonly sessionId = randomUUID();
    onclose?: () => void;
    readonly #initialized: (id: string) => void;
    constructor(options: { onsessioninitialized: (id: string) => void }) {
      this.#initialized = options.onsessioninitialized;
    }
    async handleRequest() {
      this.#initialized(this.sessionId);
    }
  },
}));

const { IntegrationToolsMcpService } = await import("./integration-tools-mcp-service.js");

const baseDatabaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = baseDatabaseUrl ? describe : describe.skip;
const definition = computerAppIntegrations.find(({ id }) => id === "macos-app")!;
const phoneDefinition = computerAppIntegrations.find(({ id }) => id === "android-phone")!;
const mac = "Alex's Mac";
const phone = "Pixel 8";

const apps = {
  notes: { bundleId: "com.apple.Notes", displayName: "Notes", teamId: null },
  calendar: { bundleId: "com.apple.iCal", displayName: "Calendar", teamId: null },
  textEdit: { bundleId: "com.apple.TextEdit", displayName: "TextEdit", teamId: null },
  onePassword: {
    bundleId: "com.1password.1password",
    displayName: "1Password",
    teamId: "2BUA8C4S2C",
  },
} satisfies Record<string, ComputerAppIdentity>;

integration.sequential("Computer use, end to end as a model sees it", () => {
  let isolated: Awaited<ReturnType<typeof createMachineAccessDatabase>>;
  let database: ReturnType<typeof createDatabase>;
  beforeAll(async () => {
    isolated = await createMachineAccessDatabase(baseDatabaseUrl!);
    database = createDatabase({
      applicationName: "host-computer-use-journey-test",
      connectionString: isolated.url,
      maxConnections: 4,
    });
  }, 120_000);
  beforeEach(async () => {
    mcp.callHandler = undefined;
    mcp.listHandler = undefined;
    mcp.registrations = 0;
    await resetMachineAccessDatabase(isolated.url);
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.drop();
  });

  it("runs computer code through the authenticated Run gateway and tears it down", async () => {
    const world = await createWorld(database);
    try {
      const run = await world.startRun("Use computer code");
      const gateway = await world.gateway(run);
      const first = await gateway.call("computer", {
        code: "globalThis.value = 40; return value + 2",
      });
      expect(first.isError, JSON.stringify(first)).toBeUndefined();
      expect(text(first)).toContain("42");
      expect(text(await gateway.call("computer", { code: "return ++value" }))).toContain("41");
      expect(
        (await gateway.call("computer", { code: 'throw new Error("script failed")' })).isError,
      ).toBe(true);
      expect(text(await gateway.call("computer", { code: "return value" }))).toBe("41");
      const warm = await world.gateway(await world.startRun("Warm engine, new Run"));
      expect(text(await warm.call("computer", { code: "return typeof value" }))).toBe(
        '"undefined"',
      );
      const trigger = await world.gateway(run, true);
      expect((await trigger.call("computer", { code: "return 1" })).isError).toBe(true);
      const artifactDirectory = process.env.OPENSTEER_SHARED_SURFACES_ARTIFACT_DIR;
      if (artifactDirectory) {
        await mkdir(artifactDirectory, { recursive: true });
        await writeFile(
          path.join(artifactDirectory, "computer-repl-journey.json"),
          JSON.stringify({ first }, null, 2),
        );
      }
    } finally {
      await world.close();
    }
  });

  it("persists Host computer operation pairs without Runner ordinals and finalizes after restart", async () => {
    const world = await createWorld(database);
    try {
      const run = await world.startRun("Record computer operations");
      const subject = {
        account: "Notes",
        computerApp: {
          app: "Notes",
          bundleId: apps.notes.bundleId,
          computer: mac,
          runnerId: world.macId,
        },
        effect: "read" as const,
        integration: "Computer use",
        operation: { name: "observe", title: "Observe Notes" },
      };
      const started = await world.persistence.computerOperations.start({
        context: run.claims,
        operation: "observe",
        subject,
      });
      expect(started.type).toBe("tool.started");
      const recovered = await new IntegrationPlatformStore(database).computerOperations.finalize();
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({
        type: "tool.completed",
        data: { callId: started.data.callId, isError: true },
      });
      const completed = recovered[0];
      if (completed?.type !== "tool.completed") throw new Error("Missing completion");
      expect(completed.data.output.text).toBe("Stopped. This step was cancelled.");
      expect(await world.persistence.computerOperations.finalize()).toEqual([]);
      const rows = await database
        .selectFrom("workspaceEvents")
        .selectAll()
        .where("runId", "=", run.runId)
        .where("type", "in", ["tool.started", "tool.completed"])
        .orderBy("sequence")
        .execute();
      expect(rows).toHaveLength(2);
      expect(
        rows.every(
          (row) =>
            row.runnerOrdinal === null &&
            row.runnerBindingGeneration === null &&
            row.runnerId === null,
        ),
      ).toBe(true);
    } finally {
      await world.close();
    }
  });

  it("reloads reordered Host transcript pairs across turn pages and cancels unfinished steps on Host restart", async () => {
    const host = await startMachineAccessHost(isolated.url);
    // The scripted engine owns both turns; a live continuation worker would race it.
    await host.runtime.close();
    const world = await createWorld(database, { phone: true, ownerUserId: host.ownerId });
    let restarted: Awaited<ReturnType<typeof createHostRuntime>> | undefined;
    try {
      const first = await world.startRun("Paginated phone transcript");
      const gateway = await world.gateway(first);
      await replPhone(world, gateway);
      expect(
        (
          await gateway.call("computer", {
            code: 'const p=await phone("Pixel 8"); await p.observe(); await p.tap(1); await p.release()',
          })
        ).isError,
      ).toBeUndefined();
      const store = new OpensteerStore(database);
      const hostEvents = (
        await store.eventsAfter(first.workspaceId, SequenceSchema.parse("0"))
      ).filter(
        (event) => event.type === "tool.started" && event.data.tool.name.startsWith("computer."),
      );
      expect(hostEvents).toHaveLength(3);
      const outer: PendingAgentEvent = {
        bindingGeneration: first.claims.bindingGeneration,
        environmentId: first.environmentId,
        threadId: first.threadId,
        runId: first.runId,
        workspaceId: first.workspaceId,
        emittedAt: new Date().toISOString(),
        ordinal: 1,
        type: "tool.started",
        data: {
          callId: "outer-computer",
          tool: { name: "computer", namespace: "opensteer.integrations" },
          arguments: { code: "await p.tap(1)" },
        },
      };
      const commit = (event: PendingAgentEvent) =>
        store.commitRunnerEvent({
          environmentId: first.environmentId,
          runnerBootId: first.runnerBootId,
          runnerId: first.agentRunnerId,
          event,
        });
      const { providerSessionId } = await database
        .selectFrom("runs")
        .select("providerSessionId")
        .where("id", "=", first.runId)
        .executeTakeFirstOrThrow();
      if (!providerSessionId) throw new Error("Missing native session");
      await store.bindProviderSession({
        bindingGeneration: first.claims.bindingGeneration,
        harnessInstanceId: world.owner.harnessInstanceId,
        providerSessionId,
        providerSessionReference: `native:${first.threadId}`,
        runId: first.runId,
        runnerBootId: first.runnerBootId,
        runnerId: first.agentRunnerId,
        threadId: first.threadId,
      });
      const delivered = await commit(outer);
      expect(
        hostEvents.every((event) => BigInt(event.sequence) < BigInt(delivered.event.sequence)),
      ).toBe(true);
      await commit({
        ...outer,
        ordinal: 2,
        type: "tool.completed",
        data: { callId: "outer-computer", isError: false, output: { text: "Finished" } },
      });
      await commit({ ...outer, ordinal: 3, type: "run.completed", data: { status: "completed" } });
      await world.platform.endComputerRun(first.runId);
      const second = await startRun(
        world.store,
        world.owner,
        world.workspace,
        "Next turn",
        first.threadId,
      );
      const next = await world.gateway(second);
      expect(
        (await next.call("computer", { code: 'const p=await phone("Pixel 8"); await p.observe()' }))
          .isError,
      ).toBeUndefined();
      const subject =
        hostEvents[0]?.type === "tool.started" ? hostEvents[0].data.integration : undefined;
      if (!subject) throw new Error("Missing admitted phone subject");
      const unfinished = await world.persistence.computerOperations.start({
        context: second.claims,
        operation: "act",
        subject: { ...subject, effect: "write", operation: { name: "act", title: "Act" } },
      });
      const expected = (
        await store.eventsAfter(first.workspaceId, SequenceSchema.parse("0"))
      ).filter((event) => event.threadId === first.threadId);
      const paged: AgentEvent[] = [];
      let before: string | undefined;
      let pages = 0;
      do {
        // Each page uses a fresh store, as after a client reload.
        const page = await new OpensteerStore(database).threadEventPageForOwner({
          ownerId: host.ownerId,
          threadId: first.threadId,
          maxItems: 2,
          ...(before ? { before } : {}),
        });
        if (!page) throw new Error("Missing transcript page");
        paged.unshift(...page.events);
        pages++;
        before = page.window.nextBefore ?? undefined;
      } while (before);
      expect(pages).toBeGreaterThan(2);
      expect(paged).toEqual(expected);
      expect(new Set(paged.map((event) => event.runId))).toEqual(
        new Set([null, first.runId, second.runId]),
      );
      const completedIds = new Set(
        paged.flatMap((event) => (event.type === "tool.completed" ? [event.data.callId] : [])),
      );
      for (const event of hostEvents) {
        if (event.type !== "tool.started") throw new Error("Not a start");
        expect(completedIds.has(event.data.callId)).toBe(true);
        expect(event.data.arguments).toEqual({});
        expect(event.data.integration?.phone?.computer).toBe(phone);
      }
      await host.runtime.close();
      restarted = await createHostRuntime(host.config, { logger: { level: "error" } });
      await restarted.listen();
      const after = await new OpensteerStore(database).eventsAfter(
        first.workspaceId,
        SequenceSchema.parse("0"),
      );
      const cancelled = after.filter(
        (event) => event.type === "tool.completed" && event.data.callId === unfinished.data.callId,
      );
      expect(cancelled).toHaveLength(1);
      expect(cancelled[0]).toMatchObject({
        type: "tool.completed",
        data: { isError: true, output: { text: "Stopped. This step was cancelled." } },
      });
      expect(await new IntegrationPlatformStore(database).computerOperations.finalize()).toEqual(
        [],
      );
      const dir = process.env.OPENSTEER_SHARED_SURFACES_ARTIFACT_DIR;
      if (dir) {
        await mkdir(dir, { recursive: true });
        await writeFile(
          path.join(dir, "computer-transcript-reload.json"),
          JSON.stringify({ pages, paged, cancelled }, null, 2),
        );
      }
    } finally {
      await world.close();
      await restarted?.close();
      await host.close();
    }
  }, 90_000);

  async function replPhone(
    world: Awaited<ReturnType<typeof createWorld>>,
    gateway: Awaited<ReturnType<typeof world.gateway>>,
    access: "read" | "read-write" = "read-write",
  ) {
    if (!world.phoneId || !world.fakePhone) throw new Error("Missing phone");
    const result = await gateway.call("integration_request", {
      kind: "computer-app",
      runnerId: world.phoneId,
      access,
      reason: "Use the phone",
    });
    expect(result.isError).toBeUndefined();
    const setup = (await world.persistence.listComputerAppSetupRequests(world.owner.userId)).find(
      (row) => row.definitionId === "android-phone",
    );
    if (!setup) throw new Error("Missing phone approval");
    await world.allowPhoneFromClient(setup);
    return world.fakePhone;
  }

  it("computer REPL gates tools/list and tools/call against each request", async () => {
    const world = await createWorld(database);
    try {
      const run = await world.startRun("Capability gating");
      const gateway = await world.gateway(run);
      expect(await gateway.list()).toMatchObject({
        tools: expect.arrayContaining([expect.objectContaining({ name: "computer" })]),
      });
      world.executionCapability.on = false;
      const listed = (await gateway.list()) as { tools: { name: string }[] };
      expect(listed.tools.map((row) => row.name)).not.toContain("computer");
      expect((await gateway.call("computer", { code: "return 1" })).isError).toBe(true);
      world.executionCapability.on = true;
      const trigger = await world.gateway(run, true);
      expect(
        ((await trigger.list()) as { tools: { name: string }[] }).tools.map((row) => row.name),
      ).not.toContain("computer");
      expect((await trigger.call("computer", { code: "return 1" })).isError).toBe(true);
    } finally {
      await world.close();
    }
  });

  it("computer REPL phones serialize aliases, reindex explicitly, emit images in order and persist receipts", async () => {
    const world = await createWorld(database, { phone: true });
    try {
      const run = await world.startRun("Use phone through code");
      const gateway = await world.gateway(run);
      const fake = await replPhone(world, gateway);
      world.imageGate.on = true;
      const result = await gateway.call("computer", {
        code: 'const p=await phone("Pixel 8"); const alias=await phone("Pixel 8"); await p.observe(); await Promise.all([p.tap(1),alias.type("hello")]); await p.release(); return "finished"',
      });
      expect(result.isError, JSON.stringify(result)).toBeUndefined();
      expect(result.content.map((block) => block.type)).toEqual([
        "text",
        "image",
        "text",
        "text",
        "image",
        "text",
        "text",
        "image",
        "text",
      ]);
      expect(
        fake.frames
          .filter((frame) => frame.operation === "act")
          .map((frame) => frame.params.observationId),
      ).toEqual(["phone-obs-1", "phone-obs-2"]);
      expect(fake.completedActions).toBe(2);
      const rows = await database
        .selectFrom("workspaceEvents")
        .selectAll()
        .where("runId", "=", run.runId)
        .where("type", "in", ["tool.started", "tool.completed"])
        .orderBy("sequence")
        .execute();
      expect(rows).toHaveLength(8);
      expect(rows.every((row) => row.runnerOrdinal === null)).toBe(true);
      expect(
        rows
          .filter((row) => row.type === "tool.completed")
          .every((row) => (row.data as { isError: boolean }).isError === false),
      ).toBe(true);
      expect(JSON.stringify(rows)).not.toContain('"hello"');
      const discovery = json(await gateway.call("integration_search", { query: "Android phone" }));
      expect(JSON.stringify(discovery)).not.toContain("toolRef");
      const artifactDirectory = process.env.OPENSTEER_SHARED_SURFACES_ARTIFACT_DIR;
      if (artifactDirectory) {
        await mkdir(artifactDirectory, { recursive: true });
        await writeFile(
          path.join(artifactDirectory, "computer-repl-phone.json"),
          JSON.stringify({ result, rows, frames: fake.frames }, null, 2),
        );
      }
    } finally {
      await world.close();
    }
  });

  it("computer REPL read access refuses act and legacy integration_call names computer", async () => {
    const world = await createWorld(database, { phone: true });
    try {
      const run = await world.startRun("Read phone through code");
      const gateway = await world.gateway(run);
      const fake = await replPhone(world, gateway, "read");
      const result = await gateway.call("computer", {
        code: 'const p=await phone("Pixel 8"); await p.observe(); await p.tap(1)',
      });
      expect(result.isError).toBe(true);
      expect(
        result.content
          .filter((row) => row.type === "text")
          .map((row) => row.text)
          .join("\n"),
      ).toContain("read-write access");
      expect(fake.received("act")).toBe(0);
      const [row] = await world.platform.listCallableTools({
        ownerUserId: world.owner.userId,
        threadId: run.threadId,
        workspaceId: run.workspaceId,
      });
      if (!row) throw new Error("Missing callable phone");
      expect(
        await gateway.call("integration_call", {
          toolRef: `${row.grant.id}.${row.tool.id}.${row.tool.schemaDigest}`,
        }),
      ).toEqual(refusal("Use the computer tool to see and operate apps and phones."));
    } finally {
      await world.close();
    }
  });

  it("computer REPL refuses overlap and busy, cancels a stalled mutation without retry and fences Run end", async () => {
    const world = await createWorld(database, { phone: true });
    let resume = () => {};
    try {
      const run = await world.startRun("Cancel phone code");
      const gateway = await world.gateway(run);
      const fake = await replPhone(world, gateway);
      expect(
        (
          await gateway.call("computer", {
            code: 'globalThis.p=await phone("Pixel 8"); await p.observe()',
          })
        ).isError,
      ).toBeUndefined();
      fake.gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const cancellation = new AbortController();
      const pending = gateway.call("computer", { code: "await p.tap(1)" }, cancellation.signal);
      await fake.reached("act");
      expect(fake.received("act")).toBe(1);
      expect((await gateway.call("computer", { code: "return 2" })).isError).toBe(true);
      const competitor = await world.gateway(await world.startRun("Competing phone code"));
      const busy = await competitor.call("computer", {
        code: 'const p=await phone("Pixel 8"); await p.observe()',
      });
      expect(busy.isError).toBe(true);
      expect(
        busy.content
          .filter((row) => row.type === "text")
          .map((row) => row.text)
          .join("\n"),
      ).toContain("busy");
      cancellation.abort();
      const cancelled = await pending;
      expect(cancelled.isError).toBe(true);
      expect(JSON.stringify(cancelled)).toContain("outcome-unknown");
      resume();
      await vi.waitFor(async () => {
        const rows = await database
          .selectFrom("workspaceEvents")
          .select("data")
          .where("runId", "=", run.runId)
          .where("type", "=", "tool.completed")
          .execute();
        expect(rows).toHaveLength(2);
        expect(JSON.stringify(rows)).toContain("This step was cancelled.");
      });
      expect(fake.received("act")).toBe(1);
      await world.platform.endComputerRun(run.runId);
      expect((await gateway.call("computer", { code: "return 3" })).isError).toBe(true);
    } finally {
      resume();
      await world.close();
    }
  });

  it.each(["MCP cancellation", "Run end"] as const)(
    "computer REPL audit settlement preserves partial receipts after %s without resuming the guest",
    async (termination) => {
      const passwords = {
        validateLease: () => true,
        seal: vi.fn<
          NonNullable<ConstructorParameters<typeof ComputerUseService>[0]["passwords"]>["seal"]
        >(async (input) => ({
          type: "login.seal.result",
          status: "sealed",
          envelope: {
            binding: input.binding,
            senderPublicKey: input.receiver.publicKey,
            salt: "A".repeat(43),
            nonce: "A".repeat(16),
            ciphertext: "",
            tag: "A".repeat(22),
          },
        })),
      };
      const world = await createWorld(database, { passwords });
      const abort = new AbortController();
      let resume = () => {};
      let ending: Promise<void> | undefined;
      try {
        const run = await world.startRun("Retain cancelled action audit");
        const gateway = await world.gateway(run);
        await gateway.call("integration_request", {
          kind: "computer-app",
          runnerId: world.macId,
          app: "Notes",
          access: "read-write",
          reason: "Audit partial actions",
        });
        const [setup] = await world.persistence.listComputerAppSetupRequests(world.owner.userId);
        if (!setup) throw new Error("Missing approval");
        await world.approveOnMac(setup);
        expect(
          (
            await gateway.call("computer", {
              code: 'globalThis.w=await (await app("Notes")).window(); await w.observe()',
            })
          ).isError,
        ).toBeUndefined();
        world.fakeMac.partialActGate = new Promise<void>((resolve) => {
          resume = resolve;
        });
        const saved = termination === "Run end";
        const loginRef = `lgn_${"a".repeat(32)}`;
        world.fakeMac.partialReceipt = saved
          ? 'Typed "secret-not-in-transcript"'
          : "Clicked element 1";
        const first = saved
          ? { type: "type", text: { loginRef, field: "password" } }
          : { type: "click", target: { index: 1 } };
        const pending = gateway.call(
          "computer",
          {
            code: `await w.act(${JSON.stringify([first, { type: "key", keys: "cmd+s" }])}); print("guest-resumed")`,
          },
          abort.signal,
        );
        await vi.waitFor(() => expect(world.fakeMac.completedActions).toBe(1));
        const started = (
          await world.store.eventsAfter(run.workspaceId, SequenceSchema.parse("0"))
        ).find((event) => event.type === "tool.started" && event.data.tool.name === "computer.act");
        if (started?.type !== "tool.started") throw new Error("Missing admitted batch");
        if (termination === "MCP cancellation") abort.abort();
        else ending = world.platform.endComputerRun(run.runId);
        const cancelled = await pending;
        expect(cancelled.isError).toBe(true);
        if (termination === "MCP cancellation")
          expect(JSON.stringify(cancelled)).toContain("outcome-unknown");
        ending ??= world.platform.endComputerRun(run.runId);
        const before = (
          await world.store.eventsAfter(run.workspaceId, SequenceSchema.parse("0"))
        ).filter(
          (event) => event.type === "tool.completed" && event.data.callId === started.data.callId,
        );
        expect(before).toEqual([]);
        resume();
        await ending;
        const events = await world.store.eventsAfter(run.workspaceId, SequenceSchema.parse("0"));
        const completed = events.filter(
          (event) => event.type === "tool.completed" && event.data.callId === started.data.callId,
        );
        expect(completed).toHaveLength(1);
        const receipt = saved ? "Typed saved password" : "Clicked element 1";
        expect(completed[0]).toMatchObject({
          type: "tool.completed",
          data: {
            isError: true,
            output: { text: `${receipt}, then stopped. This step was cancelled.\n${receipt}` },
          },
        });
        expect(JSON.stringify(events)).not.toContain("secret-not-in-transcript");
        expect(JSON.stringify(events)).not.toContain(loginRef);
        expect(JSON.stringify(cancelled)).not.toContain("guest-resumed");
        expect(JSON.stringify(cancelled)).not.toContain(receipt);
        expect(world.fakeMac.actReceivedCount).toBe(1);
        expect(world.computerUse.sessionsForRunner(world.macId)).toEqual([]);
        const dir = process.env.OPENSTEER_SHARED_SURFACES_ARTIFACT_DIR;
        if (dir) {
          await mkdir(dir, { recursive: true });
          await writeFile(
            path.join(dir, `audit-${saved ? "run-end" : "mcp"}.json`),
            JSON.stringify({ cancelled, completed }, null, 2),
          );
        }
      } finally {
        abort.abort();
        resume();
        await ending;
        await world.close();
      }
    },
  );

  it("computer REPL Stop during sleep fences caught errors and future calls", async () => {
    const world = await createWorld(database, { phone: true });
    try {
      const run = await world.startRun("Stop sleeping code");
      const gateway = await world.gateway(run);
      const fake = await replPhone(world, gateway);
      expect(
        (
          await gateway.call("computer", {
            code: 'globalThis.p=await phone("Pixel 8"); await p.observe()',
          })
        ).isError,
      ).toBeUndefined();
      const pending = gateway.call("computer", {
        code: "await sleep(100); try{await p.tap(1)}catch(e){print(e.code)}; await p.tap(1)",
      });
      fake.stopFromPhone();
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(
        result.content
          .filter((row) => row.type === "text")
          .map((row) => row.text)
          .join("\n"),
      ).toContain("stopped-by-user");
      expect(fake.received("act")).toBe(0);
      expect(
        (
          await gateway.call("computer", {
            code: 'const p=await phone("Pixel 8"); await p.observe()',
          })
        ).isError,
      ).toBe(true);
    } finally {
      await world.close();
    }
  });

  it("computer REPL Stop interrupts a stalled operation and keeps later calls fenced", async () => {
    const world = await createWorld(database, { phone: true });
    let resume = () => {};
    try {
      const run = await world.startRun("Stop stalled phone input");
      const gateway = await world.gateway(run);
      const fake = await replPhone(world, gateway);
      expect(
        (
          await gateway.call("computer", {
            code: 'globalThis.p=await phone("Pixel 8"); await p.observe()',
          })
        ).isError,
      ).toBeUndefined();
      fake.gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const pending = gateway.call("computer", { code: "await p.tap(1)" });
      await fake.reached("act");
      expect(fake.received("act")).toBe(1);
      fake.stopFromPhone();
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("stopped-by-user");
      expect(
        (
          await gateway.call("computer", {
            code: "try{await p.observe()}catch(e){print(e.code)};await p.observe()",
          })
        ).isError,
      ).toBe(true);
      expect(fake.received("act")).toBe(1);
    } finally {
      resume();
      await world.close();
    }
  });

  it("computer REPL seals saved-login typing and records only sanitized receipts", async () => {
    const passwords = {
      validateLease: () => true,
      seal: vi.fn<
        NonNullable<ConstructorParameters<typeof ComputerUseService>[0]["passwords"]>["seal"]
      >(async (input) => ({
        type: "login.seal.result",
        status: "sealed",
        envelope: {
          binding: input.binding,
          senderPublicKey: input.receiver.publicKey,
          salt: "A".repeat(43),
          nonce: "A".repeat(16),
          ciphertext: "",
          tag: "A".repeat(22),
        },
      })),
    };
    const world = await createWorld(database, { passwords });
    try {
      const run = await world.startRun("Type a saved login");
      const gateway = await world.gateway(run);
      await gateway.call("integration_request", {
        kind: "computer-app",
        runnerId: world.macId,
        app: "Notes",
        access: "read-write",
        reason: "Type a saved login",
      });
      const [setup] = await world.persistence.listComputerAppSetupRequests(world.owner.userId);
      if (!setup) throw new Error("Missing approval");
      await world.approveOnMac(setup);
      const loginRef = `lgn_${"a".repeat(32)}`;
      const result = await gateway.call("computer", {
        code: `const a=await app("Notes");const w=await a.window(7);await w.observe();await w.type({loginRef:"${loginRef}",field:"password"})`,
      });
      expect(result.isError, JSON.stringify(result)).toBeUndefined();
      expect(JSON.stringify(result)).toContain("Typed saved password");
      expect(passwords.seal).toHaveBeenCalledTimes(1);
      const frame = world.fakeMac.frames.find((frame) => frame.operation === "act");
      expect(frame?.params.actions).toMatchObject([
        { type: "type", text: { sealed: expect.any(Object) } },
      ]);
      expect(JSON.stringify(frame)).not.toContain(loginRef);
      const rows = await database
        .selectFrom("workspaceEvents")
        .select("data")
        .where("runId", "=", run.runId)
        .where("type", "in", ["tool.started", "tool.completed"])
        .execute();
      expect(JSON.stringify(rows)).not.toContain(loginRef);
      expect(JSON.stringify(rows)).toContain("Typed saved password");
    } finally {
      await world.close();
    }
  });

  it("computer REPL writes repeatable shared-app surface evidence through one session", async () => {
    const world = await createWorld(database);
    try {
      const run = await world.startRun("Observe Notes, Calendar, Notes");
      const gateway = await world.gateway(run);
      for (const app of ["Notes", "Calendar"]) {
        await gateway.call("integration_request", {
          kind: "computer-app",
          runnerId: world.macId,
          app,
          access: "read",
          reason: "Read app",
        });
        const [setup] = await world.persistence.listComputerAppSetupRequests(world.owner.userId);
        if (!setup) throw new Error("Missing approval");
        await world.approveOnMac(setup);
      }
      world.imageGate.on = true;
      const result = await gateway.call("computer", {
        code: 'for(const name of ["Notes","Calendar","Notes"]){const a=await app(name);const w=await a.window();await w.observe({screenshot:true})}',
      });
      expect(result.isError, JSON.stringify(result)).toBeUndefined();
      expect(result.content.map((row) => row.type)).toEqual([
        "text",
        "image",
        "text",
        "image",
        "text",
        "image",
      ]);
      const observations = world.fakeMac.frames.filter((frame) => frame.operation === "observe");
      expect(observations.map((frame) => frame.app?.displayName)).toEqual([
        "Notes",
        "Calendar",
        "Notes",
      ]);
      expect(new Set(observations.map((frame) => frame.sessionId)).size).toBe(1);
      const artifactDirectory = process.env.OPENSTEER_SHARED_SURFACES_ARTIFACT_DIR;
      if (artifactDirectory) {
        await mkdir(artifactDirectory, { recursive: true });
        await writeFile(
          path.join(artifactDirectory, "computer-app-surfaces.json"),
          JSON.stringify(
            { result, observations, sessions: world.computerUse.sessionsForRunner(world.macId) },
            null,
            2,
          ),
        );
      }
    } finally {
      await world.close();
    }
  }, 60000);

  it("computer REPL enforces code, text, slice, CPU and memory limits through MCP", async () => {
    const world = await createWorld(database);
    try {
      const run = await world.startRun("Bound computer programs");
      const gateway = await world.gateway(run);
      for (const code of [
        " ".repeat(65537),
        'print("x".repeat(524289))',
        "while(true){}",
        "const chunks=[]; for(let i=0;i<80;i++){chunks.push(new Uint8Array(1024*1024)); await sleep(0)}",
      ]) {
        const result = await gateway.call("computer", { code });
        expect(result.isError, code.slice(0, 80)).toBe(true);
      }
      const cpu = await gateway.call("computer", {
        code: "for(;;){let x=0; for(let i=0;i<200000;i++) x+=i; await sleep(0)}",
      });
      expect(cpu.isError).toBe(true);
      expect(JSON.stringify(cpu)).toContain("cpu-limit");
    } finally {
      await world.close();
    }
  }, 60000);

  it("computer REPL enforces its wall deadline while a script sleeps", async () => {
    // Domain time: the deadline passes only once the script is sleeping.
    const clock = new ManualClock();
    const sleeping = Promise.withResolvers<void>();
    const world = await createWorld(database, {
      computerReplTime: {
        clock,
        wait: (milliseconds, signal) => {
          sleeping.resolve();
          return clock.wait(milliseconds, signal);
        },
      },
    });
    try {
      const run = await world.startRun("Bound sleeping programs");
      const gateway = await world.gateway(run);
      const call = gateway.call("computer", {
        code: 'await sleep(100000); return "too late"',
      });
      await sleeping.promise;
      clock.advanceBy(100_000);
      const result = await call;
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("100 second deadline");
      expect(JSON.stringify(result)).not.toContain('"too late"');
    } finally {
      await world.close();
    }
  }, 60000);

  it("computer REPL queues a fifth execution and evicts the least recently used idle context", async () => {
    const world = await createWorld(database);
    try {
      const gateways = [];
      for (let i = 0; i < 17; i++)
        gateways.push(await world.gateway(await world.startRun(`Resident computer context ${i}`)));
      const runs = await Promise.all(
        gateways.slice(0, 5).map((gateway) =>
          gateway.call("computer", {
            code: "const started=Date.now(); await sleep(500); return {started,finished:Date.now()}",
          }),
        ),
      );
      const intervals = runs.map(
        (result) => JSON.parse(text(result)) as { started: number; finished: number },
      );
      expect(intervals[4]!.started).toBeGreaterThanOrEqual(
        Math.min(...intervals.slice(0, 4).map((interval) => interval.finished)),
      );
      for (let i = 0; i < gateways.length; i++)
        expect(
          (await gateways[i]!.call("computer", { code: "globalThis.seed=1; return seed" })).isError,
        ).toBeUndefined();
      expect(text(await gateways[0]!.call("computer", { code: "return typeof seed" }))).toBe(
        '"undefined"',
      );
    } finally {
      await world.close();
    }
  }, 180000);

  it("computer REPL revocation tears down globals and handles before the next call", async () => {
    const world = await createWorld(database, { phone: true });
    try {
      const run = await world.startRun("Revoke computer authority");
      const gateway = await world.gateway(run);
      await replPhone(world, gateway);
      expect(
        (
          await gateway.call("computer", {
            code: 'globalThis.p=await phone("Pixel 8"); globalThis.secretMarker=123; await p.observe()',
          })
        ).isError,
      ).toBeUndefined();
      const connection = await world.phoneConnection();
      const grant = (
        await world.persistence.listGrants({
          ownerUserId: world.owner.userId,
          workspaceId: run.workspaceId,
        })
      ).find((row) => row.connectionId === connection.id);
      if (!grant) throw new Error("Missing phone grant");
      await world.platform.revokeGrant({
        grantId: grant.id,
        ownerUserId: world.owner.userId,
        workspaceId: run.workspaceId,
        requestId: "revoke-repl-phone",
      });
      expect(
        text(await gateway.call("computer", { code: "return [typeof p,typeof secretMarker]" })),
      ).toBe('["undefined","undefined"]');
      expect((await gateway.call("computer", { code: 'await phone("Pixel 8")' })).isError).toBe(
        true,
      );
    } finally {
      await world.close();
    }
  });

  it("computer REPL Macs bind exact windows, share snapshots across aliases, act without observing and project current windows", async () => {
    const world = await createWorld(database);
    try {
      const run = await world.startRun("Use Notes code");
      const gateway = await world.gateway(run);
      await gateway.call("integration_request", {
        kind: "computer-app",
        runnerId: world.macId,
        app: "Notes",
        access: "read-write",
        reason: "Write Notes",
      });
      const [setup] = await world.persistence.listComputerAppSetupRequests(world.owner.userId);
      if (!setup) throw new Error("Missing Mac approval");
      await world.approveOnMac(setup);
      world.imageGate.on = true;
      const result = await gateway.call("computer", {
        code: 'const a=await app("Notes"); print(await apps()); print(await a.windows()); const w=await a.window(8); const alias=await a.window(8); await Promise.all([w.observe({screenshot:true}),alias.click(1)]); await w.type("milk"); return "finished"',
      });
      expect(result.isError, JSON.stringify(result)).toBeUndefined();
      const frames = world.fakeMac.frames.filter((frame) =>
        ["windows", "bind", "observe", "act"].includes(frame.operation),
      );
      expect(frames.map((frame) => frame.operation)).toEqual([
        "windows",
        "bind",
        "bind",
        "observe",
        "act",
        "act",
      ]);
      expect(
        frames.filter((frame) => frame.operation === "act").map((frame) => frame.params.snapshot),
      ).toEqual(["obs-1", "obs-1"]);
      expect(result.content.map((row) => row.type)).toEqual([
        "text",
        "text",
        "text",
        "image",
        "text",
        "text",
        "text",
      ]);
      expect(world.computerUse.sessionsForRunner(world.macId)[0]?.windows).toEqual([
        { appKey: apps.notes.bundleId.toLowerCase(), id: 8, title: "Work" },
      ]);
      const search = json(await gateway.call("integration_search", { runnerId: world.macId }));
      expect(JSON.stringify(search)).not.toContain("toolRef");
      const artifactDirectory = process.env.OPENSTEER_SHARED_SURFACES_ARTIFACT_DIR;
      if (artifactDirectory) {
        await mkdir(artifactDirectory, { recursive: true });
        await writeFile(
          path.join(artifactDirectory, "computer-repl-mac.json"),
          JSON.stringify(
            { result, frames, sessions: world.computerUse.sessionsForRunner(world.macId) },
            null,
            2,
          ),
        );
      }
    } finally {
      await world.close();
    }
  });

  it("computer REPL phone observations inherit the call deadline and abort signal", async () => {
    let serviceNow = Date.now();
    const world = await createWorld(database, { phone: true, now: () => serviceNow });
    const cancellation = new AbortController();
    let resume = () => {};
    let pending: Promise<ToolResult> | undefined;
    try {
      const run = await world.startRun("Deadline-bound phone observation");
      const gateway = await world.gateway(run);
      const fake = await replPhone(world, gateway);
      // Move only the dispatch clock near the existing REPL deadline, without waiting 99 seconds.
      serviceNow = Date.now() + 99_000;
      fake.gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      pending = gateway.call(
        "computer",
        { code: 'await (await phone("Pixel 8")).observe()' },
        cancellation.signal,
      );
      await fake.reached("observe");
      expect(fake.received("observe")).toBe(1);
      const frame = fake.frames.find((frame) => frame.operation === "observe");
      expect(frame?.timeoutMs).toBeGreaterThan(0);
      expect(frame?.timeoutMs).toBeLessThanOrEqual(Date.now() + 100_000 - serviceNow);
      cancellation.abort();
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("cancelled");
      expect(fake.received("observe")).toBe(1);
    } finally {
      cancellation.abort();
      resume();
      await pending;
      await world.close();
    }
  });

  it("computer REPL Mac actions return only receipts, throw typed stops and preserve unsupported window sentences", async () => {
    const world = await createWorld(database);
    try {
      const run = await world.startRun("Mac guest result contract");
      const gateway = await world.gateway(run);
      await gateway.call("integration_request", {
        kind: "computer-app",
        runnerId: world.macId,
        app: "Notes",
        access: "read-write",
        reason: "Check action results",
      });
      const [setup] = await world.persistence.listComputerAppSetupRequests(world.owner.userId);
      if (!setup) throw new Error("Missing approval");
      await world.approveOnMac(setup);
      const result = await gateway.call("computer", {
        code: 'globalThis.w=await (await app("Notes")).window(); await w.observe(); return [await w.click(1),await w.type("milk"),await w.key("cmd+s"),await w.setValue(1,"saved"),await w.scroll(1,"down"),await w.act([{type:"key",keys:"escape"}])]',
      });
      expect(result.isError, JSON.stringify(result)).toBeUndefined();
      const returned = result.content.at(-1);
      if (returned?.type !== "text") throw new Error("Missing returned JSON");
      expect(JSON.parse(returned.text)).toEqual([
        { performed: ["Clicked element 1"] },
        { performed: ['Typed "milk"'] },
        { performed: ["Performed key"] },
        { performed: ["Performed setValue"] },
        { performed: ["Performed scroll"] },
        { performed: ["Performed key"] },
      ]);
      world.fakeMac.actFailure = {
        code: "failed",
        message: "The button became unavailable.",
        performed: ["Clicked element 1"],
      };
      const stopped = await gateway.call("computer", {
        code: 'try {await w.act([{type:"click",target:{index:1}},{type:"key",keys:"cmd+s"}])} catch(error) {return {isComputerError:error instanceof ComputerError,code:error.code,message:error.message,performed:error.performed,leaked:["kind","observation","value","content","error"].filter(key=>key in error)}}',
      });
      const stoppedReturn = stopped.content.at(-1);
      if (stoppedReturn?.type !== "text") throw new Error("Missing typed error");
      expect(JSON.parse(stoppedReturn.text)).toEqual({
        isComputerError: true,
        code: "failed",
        message: "The button became unavailable.",
        performed: ["Clicked element 1"],
        leaked: [],
      });
      expect(world.fakeMac.actReceivedCount).toBe(7);
      world.fakeMac.windowGroupsSupported = false;
      const unsupported = await gateway.call("computer", {
        code: 'await (await app("Notes")).windows()',
      });
      expect(unsupported).toEqual(
        refusal("unsupported: This version of macOS cannot identify window groups."),
      );
    } finally {
      await world.close();
    }
  });

  it("computer REPL mixed Mac versions refuse before dispatch with the update sentence", async () => {
    const world = await createWorld(database);
    try {
      const run = await world.startRun("Mixed Mac version");
      const gateway = await world.gateway(run);
      await gateway.call("integration_request", {
        kind: "computer-app",
        runnerId: world.macId,
        app: "Notes",
        access: "read",
        reason: "Read Notes",
      });
      const [setup] = await world.persistence.listComputerAppSetupRequests(world.owner.userId);
      if (!setup) throw new Error("Missing approval");
      await world.approveOnMac(setup);
      world.macVersion.value = 1;
      const result = await gateway.call("computer", {
        code: 'const a=await app("Notes"); await a.windows()',
      });
      expect(result.isError).toBe(true);
      expect(
        result.content
          .filter((row) => row.type === "text")
          .map((row) => row.text)
          .join("\n"),
      ).toContain(`incompatible-version: Update Opensteer on ${mac} to let agents use its apps.`);
      expect(world.fakeMac.frames.filter((frame) => frame.operation === "windows")).toEqual([]);
      const search = json(await gateway.call("integration_search", { query: "Computer use" }));
      expect(macRow(search).computers[0]).toMatchObject({ computerUseVersion: 1 });
      expect(search).toMatchObject({ results: [], total: 0, nextOffset: null });
      expect(search.guidance.computers).toContain(
        "computerUseVersion other than 2: update Opensteer on that Mac",
      );
    } finally {
      await world.close();
    }
  });

  it("computer REPL owner window transport is fenced, session-free and rejects offline or old computers", async () => {
    const world = await createWorld(database, { ownerViews: true });
    try {
      expect(await world.hub.ownerWindows(world.macId, apps.notes, { timeoutMs: 1000 })).toEqual([
        { id: 7, title: "Groceries", focused: true, main: true, minimized: false, onScreen: true },
      ]);
      expect(world.fakeMac.openSessions()).toEqual([]);
      const cancellation = new AbortController();
      cancellation.abort();
      await expect(
        world.hub.ownerWindows(world.macId, apps.notes, {
          timeoutMs: 1000,
          signal: cancellation.signal,
        }),
      ).rejects.toMatchObject({ code: "failed" });
      world.fakeMac.detach();
      await expect(
        world.hub.ownerWindows(world.macId, apps.notes, { timeoutMs: 1000 }),
      ).rejects.toMatchObject({ code: "offline" });
      const old = new FakeMac(world.hub, world.macId);
      await old.attach();
      await vi.waitFor(() => expect(old.lists.length).toBeGreaterThan(0));
      await expect(
        world.hub.ownerWindows(world.macId, apps.notes, { timeoutMs: 1000 }),
      ).rejects.toMatchObject({ code: "incompatible-version" });
    } finally {
      await world.close();
    }
  });

  it("recovers accepted native latest place after immediate end and a real Host restart", async () => {
    const host = await startMachineAccessHost(isolated.url);
    let restarted: Awaited<ReturnType<typeof createHostRuntime>> | null = null;
    const activity: { ended: boolean; at: number }[] = [];
    const world = await createWorld(database, {
      ownerUserId: host.ownerId,
      onPlaceActivity: (input) => {
        activity.push(input);
        host.runtime.browser.noteNativeActivity(input);
      },
    });
    try {
      const run = await world.startRun("Remember Notes after finishing");
      const gateway = await world.gateway(run);
      await gateway.call("integration_request", {
        kind: "computer-app",
        runnerId: world.macId,
        app: "Notes",
        access: "read-write",
        reason: "Read Notes",
      });
      const [setup] = await world.persistence.listComputerAppSetupRequests(world.owner.userId);
      if (!setup) throw new Error("Missing app approval");
      await world.approveOnMac(setup);
      expect(
        (
          await gateway.call("computer", {
            code: 'globalThis.w=await (await app("Notes")).window(); await w.observe()',
          })
        ).isError,
      ).toBeUndefined();
      const store = new OpensteerStore(database);
      const started: PendingAgentEvent = {
        bindingGeneration: run.claims.bindingGeneration,
        environmentId: run.environmentId,
        threadId: run.threadId,
        runId: run.runId,
        workspaceId: run.workspaceId,
        ordinal: 1,
        emittedAt: new Date().toISOString(),
        type: "tool.started",
        data: {
          callId: "native-latest-act",
          arguments: { code: "await w.click(1)" },
          tool: { namespace: "opensteer.integrations", name: "computer" },
        },
      };
      const acted = await gateway.call("computer", { code: "await w.click(1)" });
      expect(acted.isError).toBeUndefined();
      // End before the live-activity coalescer fires, before any history reads.
      world.computerUse.closeForRun(run.runId);
      const persisted = await store.eventsAfter(run.workspaceId, SequenceSchema.parse("0"));
      const operationStarted = persisted.find(
        (event) => event.type === "tool.started" && event.data.tool.name === "computer.click",
      );
      if (operationStarted?.type !== "tool.started") throw new Error("Missing Host click");
      const subject = operationStarted.data.integration;
      expect(subject?.computerApp?.bundleId).toBe(apps.notes.bundleId);
      const completedAction = persisted.find(
        (event) =>
          event.type === "tool.completed" && event.data.callId === operationStarted.data.callId,
      );
      if (completedAction?.type !== "tool.completed")
        throw new Error("Missing Host click completion");
      // Delivery can put Host operations before the Runner's outer computer start.
      const delivered = await store.commitRunnerEvent({
        environmentId: run.environmentId,
        runnerBootId: run.runnerBootId,
        runnerId: run.agentRunnerId,
        event: started,
      });
      expect(BigInt(delivered.event.sequence)).toBeGreaterThan(BigInt(completedAction.sequence));
      const endedAt = activity.findLast((entry) => entry.ended)?.at;
      const actedAt = activity.findLast((entry) => !entry.ended)?.at;
      expect(endedAt! - actedAt!).toBeLessThan(100);
      const before = (await host.runtime.browser.latestPlaces(host.ownerId)).find(
        (reference) => reference.threadId === run.threadId,
      );
      expect(before).toMatchObject({
        runId: run.runId,
        place: { kind: "app", machineId: world.macId, appKey: "com.apple.notes" },
        title: "Notes",
      });
      await store.commitRunnerEvent({
        environmentId: run.environmentId,
        runnerBootId: run.runnerBootId,
        runnerId: run.agentRunnerId,
        event: {
          ...started,
          ordinal: 2,
          type: "tool.completed",
          data: { callId: "native-latest-act", isError: false, output: { text: text(acted) } },
        },
      });
      const described = await gateway.call("integration_search", { runnerId: world.macId });
      await store.commitRunnerEvent({
        environmentId: run.environmentId,
        runnerBootId: run.runnerBootId,
        runnerId: run.agentRunnerId,
        event: {
          ...started,
          ordinal: 3,
          type: "tool.started",
          data: {
            ...started.data,
            callId: "native-describe",
            tool: { namespace: "opensteer.integrations", name: "integration_search" },
          },
        },
      });
      await store.commitRunnerEvent({
        environmentId: run.environmentId,
        runnerBootId: run.runnerBootId,
        runnerId: run.agentRunnerId,
        event: {
          ...started,
          ordinal: 4,
          type: "tool.completed",
          data: { callId: "native-describe", isError: false, output: { text: text(described) } },
        },
      });
      await store.commitRunnerEvent({
        environmentId: run.environmentId,
        runnerBootId: run.runnerBootId,
        runnerId: run.agentRunnerId,
        event: { ...started, ordinal: 5, type: "run.completed", data: { status: "completed" } },
      });
      await host.runtime.close();
      restarted = await createHostRuntime(host.config, { logger: { level: "error" } });
      await restarted.listen();
      expect(await restarted.browser.latestPlaces(host.ownerId)).toEqual(
        expect.arrayContaining([expect.objectContaining({ title: "Notes" })]),
      );
      const bootstrap = await testRpcData(
        host.origin,
        "bootstrap.get",
        {},
        { headers: host.ownerHeaders },
      );
      const recovered = bootstrap.latestPlaces?.find(
        (reference) => reference.threadId === run.threadId,
      );
      // Rebuilt from the durable tool events, the reference still names the Run that acted.
      expect(recovered).toMatchObject({
        runId: run.runId,
        place: before!.place,
        title: "Notes",
        at: completedAction.createdAt,
      });
      const directory = process.env.OPENSTEER_SHARED_SURFACES_ARTIFACT_DIR;
      if (directory) {
        await mkdir(directory, { recursive: true });
        await writeFile(
          path.join(directory, "native-latest-restart.json"),
          JSON.stringify(
            {
              runId: run.runId,
              activity,
              endedWithinMs: endedAt! - actedAt!,
              before,
              recovered,
              subject,
            },
            null,
            2,
          ),
        );
      }
    } finally {
      await world.close();
      await restarted?.close();
      await host.close();
    }
  }, 90_000);

  it("admits native references through Host authority and PostgreSQL without granting or stealing", async () => {
    const world = await createWorld(database, { phone: true });
    let closeHost: (() => Promise<void>) | null = null;
    try {
      const run = await world.startRun("Included places");
      const gateway = await world.gateway(run);
      await gateway.call("integration_request", {
        kind: "computer-app",
        runnerId: world.macId,
        app: "Notes",
        access: "read",
        reason: "Read included Notes",
      });
      let [setup] = await world.persistence.listComputerAppSetupRequests(world.owner.userId);
      if (!setup) throw new Error("Missing app approval");
      await world.approveOnMac(setup);
      await gateway.call("integration_request", {
        kind: "computer-app",
        runnerId: world.phoneId,
        access: "read",
        reason: "Read included phone",
      });
      [setup] = await world.persistence.listComputerAppSetupRequests(world.owner.userId);
      if (!setup) throw new Error("Missing phone approval");
      await world.allowPhoneFromClient(setup);
      const places = new PlaceContextService({
        browser: {
          assertPagesUsable: async () => {
            throw new Error("Unexpected browser reference");
          },
        },
        computerUse: world.computerUse,
        connections: world.connections,
        integrations: world.platform,
        store: new OpensteerStore(database),
      });
      const content: ContentPart[] = [
        { type: "computer-app", machineId: world.macId, app: apps.notes, name: mac },
        { type: "phone", machineId: world.phoneId!, display: "main", name: phone },
      ];
      const scope = {
        ownerId: world.owner.userId,
        threadId: run.threadId,
        workspaceId: run.workspaceId,
      };
      const approvalsBefore = world.fakeMac.waiting();
      await places.assertUsable({ ...scope, parts: content });
      const store = new OpensteerStore(database);
      const commands = new CommandService({
        store,
        admission: new KeyedAdmissionQueue({
          maxInFlight: 4,
          maxQueuedBytes: 4_000_000,
          maxQueuedCommands: 64,
        }),
        onExecutionQueued: () => undefined,
        onWorkspaceEvent: () => undefined,
      });
      let capabilities = ["native-place-input-v1", "browser-page-input-v1"];
      const host = await createHostServer(
        hostServerTestDependencies({
          store,
          commands,
          placeContext: places,
          discovery: signHostDiscovery(generateKeyPairSync("ed25519"), {
            canonicalOrigin: "https://native-place.test",
            deploymentId: createId("deployment"),
            hostInstanceId: createId("hostInstance"),
            hostKey: { algorithm: "Ed25519" },
            deploymentShape: { defaultWorkspaceBacking: "local-directory", kind: "server" },
          }),
          authenticator: {
            authenticateSessionContext: async () => ({
              credentialKind: "header",
              surface: "canonical",
              session: {
                id: createId("authSession"),
                user: {
                  id: world.owner.userId,
                  disabledAt: null,
                  displayName: "Owner",
                  email: "owner@example.test",
                  emailVerified: true,
                  image: null,
                  instanceRole: "administrator",
                },
                createdAt: new Date().toISOString(),
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                absoluteExpiresAt: new Date(Date.now() + 60_000).toISOString(),
              },
            }),
          } as never,
          runners: {
            attachmentInputFailure: ({ content }: { content: readonly ContentPart[] }) =>
              placeInputFailure(content, capabilities),
          } as never,
        }),
      );
      closeHost = () => host.close();
      const send = (threadId: ThreadId, parts: ContentPart[], idempotencyKey: string) =>
        injectRpcRequest(host, "commands.dispatch", {
          type: "thread.sendMessage",
          content: parts,
          idempotencyKey,
          threadId,
        });
      const submission = {
        type: "thread.sendMessage",
        content,
        idempotencyKey: "native-place-message",
        threadId: run.threadId,
      };
      capabilities = [];
      const older = await injectRpcRequest(host, "commands.dispatch", submission);
      expect(older.statusCode, older.body).toBe(409);
      capabilities = ["native-place-input-v1", "browser-page-input-v1"];
      const response = await injectRpcRequest(host, "commands.dispatch", submission);
      expect(response.statusCode, response.body).toBe(200);
      const sent = response.json().data as Awaited<
        ReturnType<OpensteerStore["enqueueThreadInput"]>
      >;
      // A committed retry is acknowledged even if its Runner or target is now unavailable.
      capabilities = [];
      const replay = await injectRpcRequest(host, "commands.dispatch", submission);
      expect(replay.statusCode, replay.body).toBe(200);
      expect(replay.json().data).toMatchObject({
        wasDuplicate: true,
        message: { id: sent.message.id },
      });
      capabilities = ["native-place-input-v1", "browser-page-input-v1"];

      expect(sent.message.content).toEqual(content);
      expect(world.computerUse.sessionsForRunner(world.macId)).toEqual([]);
      expect(world.computerUse.sessionsForRunner(world.phoneId!)).toEqual([]);
      expect(world.fakeMac.waiting()).toEqual(approvalsBefore);
      const projected = resolvedInputParts(
        {
          author: sent.message.author,
          content: sent.message.content,
          createdAt: sent.message.createdAt,
          kind: "input",
          messageId: sent.message.id,
        },
        undefined,
      );
      expect(projected.body).toContain("com.apple.Notes");
      expect(projected.body).toContain(world.phoneId);
      for (const part of content) {
        await expect(
          places.assertUsable({ ...scope, ownerId: createId("user"), parts: [part] }),
        ).rejects.toMatchObject({ code: "forbidden" });
      }
      await expect(
        places.assertUsable({
          ...scope,
          parts: [{ type: "phone", machineId: world.phoneId!, name: phone, display: "other" }],
        }),
      ).rejects.toMatchObject({ code: "bad_request" });
      const specialist = await world.createWorkspace("Unrelated specialist");
      const other = await world.startRun("Other task", specialist);
      await expect(
        places.assertUsable({
          ...scope,
          workspaceId: specialist.id,
          threadId: other.threadId,
          parts: content,
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      const phoneLease = await world.computerUse.prepare(
        { ownerUserId: world.owner.userId, runnerId: world.phoneId!, runnerName: phone },
        run.claims,
      );
      await (
        await world.computerUse.sendObserve(
          phoneLease,
          { kind: "display", definitionId: "android-phone", access: "read" },
          false,
        )
      ).settle();
      await expect(
        places.assertUsable({ ...scope, threadId: other.threadId, parts: [content[1]!] }),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(world.computerUse.sessionsForRunner(world.phoneId!)[0]?.runId).toBe(run.runId);
      await places.assertUsable({ ...scope, parts: content });
      // Those are what forwarding a place must prove. A person's message only names places:
      // its sender must own them, and the agent finds out at use whether it may use them.
      const unapproved: ContentPart = {
        type: "computer-app",
        machineId: world.macId,
        app: apps.calendar,
        name: mac,
      };
      const elsewhere = await send(
        other.threadId,
        [...content, unapproved],
        "native-place-specialist-busy-unapproved",
      );
      expect(elsewhere.statusCode, elsewhere.body).toBe(200);
      expect(elsewhere.json().data).toMatchObject({
        message: { content: [...content, unapproved] },
      });
      expect(world.computerUse.sessionsForRunner(world.phoneId!).map((held) => held.runId)).toEqual(
        [run.runId],
      );
      expect(world.computerUse.sessionsForRunner(world.macId)).toEqual([]);
      expect(world.fakeMac.waiting()).toEqual(approvalsBefore);
      const stranger = await send(
        run.threadId,
        [{ type: "computer-app", machineId: createId("runner"), app: apps.notes, name: mac }],
        "native-place-stranger",
      );
      expect(stranger.statusCode, stranger.body).toBe(403);
      const wrongDisplay = await send(
        run.threadId,
        [{ type: "phone", machineId: world.phoneId!, name: phone, display: "other" }],
        "native-place-wrong-display",
      );
      expect(wrongDisplay.statusCode, wrongDisplay.body).toBe(400);
      // Forward the included Mac app to a real child; its scope is checked before it exists.
      const control = new AgentControlService({
        browserSources: {} as never,
        machineFullDiskAccess: {} as never,
        browser: {} as never,
        canRunHarness: () => true,
        commands,
        defaultWorkspaceBacking: "portablefs",
        environmentWorkspaceBackings: () => ["portablefs"],
        isEnvironmentConnected: () => true,
        onWorkspaceEvent: () => undefined,
        store,
        placeContext: places,
        tokens: {
          authenticate: async () => ({ ...run.claims, aud: "opensteer-agent-control" }),
        } as never,
        workspaceMounts: {} as never,
        workspaces: {} as never,
      });
      const appPart = content.find((part) => part.type === "computer-app")!;
      const delegated = await control.handle("test-token", {
        type: "thread.delegate",
        requestId: randomUUID(),
        task: "Read the included Notes app",
        title: "Read Notes",
        workspaceId: run.workspaceId,
        places: [appPart],
      });
      if (delegated.type !== "thread.delegate.result") throw new Error("Missing delegated child");
      expect(delegated.result.message.content).toEqual([
        { type: "text", text: "Read the included Notes app" },
        { type: "text", text: appPart.name },
      ]);
      const storedChild = await database
        .selectFrom("messages")
        .select("content")
        .where("id", "=", delegated.result.message.id)
        .executeTakeFirstOrThrow();
      expect(storedChild.content).toEqual([
        { type: "text", text: "Read the included Notes app" },
        appPart,
      ]);
      await database
        .updateTable("threadInputs")
        .set({ state: "delivered", deliveredAt: new Date(), runId: run.runId })
        .where("messageId", "=", sent.message.id)
        .execute();
      const olderRead = await control.handle("test-token", {
        type: "thread.read",
        requestId: randomUUID(),
        threadId: run.threadId,
        maxMessages: 100,
      });
      if (olderRead.type !== "thread.read.result") throw new Error("Missing thread read");
      expect(
        olderRead.messages
          .flatMap((message) => message.content)
          .some((part) => part.type === "computer-app" || part.type === "phone"),
      ).toBe(false);
      await database
        .updateTable("runners")
        .set({
          capabilities: sql`${JSON.stringify(["filesystem", "native-place-input-v1"])}::jsonb`,
        })
        .where("id", "=", run.agentRunnerId)
        .execute();
      const capableRead = await control.handle("test-token", {
        type: "thread.read",
        requestId: randomUUID(),
        threadId: run.threadId,
        maxMessages: 100,
      });
      if (capableRead.type !== "thread.read.result") throw new Error("Missing capable thread read");
      expect(capableRead.messages.flatMap((message) => message.content)).toEqual(
        expect.arrayContaining(content),
      );
      expect(await store.hasHumanIncludedPlace(run.threadId, appPart)).toBe(true);
      await expect(
        store.commitRunnerEvent({
          environmentId: run.environmentId,
          runnerBootId: run.claims.runnerBootId,
          runnerId: run.agentRunnerId,
          event: {
            type: "assistant.message",
            bindingGeneration: run.claims.bindingGeneration,
            emittedAt: new Date().toISOString(),
            environmentId: run.environmentId,
            ordinal: 1,
            runId: run.runId,
            threadId: run.threadId,
            workspaceId: run.workspaceId,
            data: { messageId: createId("message"), content: [appPart] },
          },
        }),
      ).rejects.toMatchObject({ code: "bad_request" });

      await expect(
        control.handle("test-token", {
          type: "thread.delegate",
          requestId: randomUUID(),
          task: "Read unrelated Calendar",
          workspaceId: run.workspaceId,
          places: [{ type: "computer-app", machineId: world.macId, app: apps.calendar, name: mac }],
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      // Now the person includes Calendar here, which nothing can use yet: that proves where
      // the reference came from, never that the child may use it.
      expect(await store.hasHumanIncludedPlace(run.threadId, unapproved)).toBe(false);
      const unapprovedHere = await send(run.threadId, [unapproved], "native-place-unapproved");
      expect(unapprovedHere.statusCode, unapprovedHere.body).toBe(200);
      expect(await store.hasHumanIncludedPlace(run.threadId, unapproved)).toBe(true);
      await expect(
        control.handle("test-token", {
          type: "thread.delegate",
          requestId: randomUUID(),
          task: "Read the Calendar the person included",
          workspaceId: run.workspaceId,
          places: [unapproved],
        }),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        control.handle("test-token", {
          type: "thread.message",
          requestId: randomUUID(),
          delivery: "queue",
          threadId: delegated.result.thread.id,
          content: [appPart],
        }),
      ).rejects.toMatchObject({ code: "bad_request" });
      // An offline Mac is the agent's to report, not a reason to refuse what the person said.
      world.fakeMac.detach();
      const offline = await send(run.threadId, [appPart], "native-place-offline-mac");
      expect(offline.statusCode, offline.body).toBe(200);
      await expect(places.assertUsable({ ...scope, parts: [appPart] })).rejects.toMatchObject({
        code: "conflict",
      });
      const directory = process.env.OPENSTEER_SHARED_SURFACES_ARTIFACT_DIR;
      if (directory) {
        await mkdir(directory, { recursive: true });
        await writeFile(
          path.join(directory, "native-place-input.json"),
          JSON.stringify(
            {
              submitted: content,
              stored: sent.message.content,
              projected,
              personMessage: {
                admitted: ["specialist-scope", "busy-phone", "unapproved-app", "offline-mac"],
                refused: ["not-owned", "wrong-display", "older-runner"],
              },
              forwarding: {
                refused: [
                  "invisible",
                  "wrong-display",
                  "specialist-scope",
                  "busy-phone",
                  "unrelated-app",
                  "included-but-unusable-app",
                  "offline-mac",
                ],
              },
              createdSessionsAtAdmission: 0,
              olderRunner: {
                delegatedContent: delegated.result.message.content,
                readContent: olderRead.messages.map((message) => message.content),
              },
              capableRunnerRead: capableRead.messages.map((message) => message.content),
            },
            null,
            2,
          ),
        );
      }
    } finally {
      await closeHost?.();
      await world.close();
    }
  });

  it("refuses new access from delegated gateway requests and proposals", async () => {
    const world = await createWorld(database);
    const run = await world.startRun("Delegated task");
    const gateway = await world.gateway({
      ...run,
      claims: { ...run.claims, capabilityProfileId: "delegated" },
    });
    try {
      for (const [name, args] of [
        ["integration_request", { catalog: "macos-app", access: "read", reason: "Use an app" }],
        [
          "integration_request",
          { integration: "cloud-account", access: "read-write", reason: "Send a message" },
        ],
        [
          "integration_propose",
          {
            source: "https://example.test/openapi.json",
            description: "An example API.",
            access: "read",
            reason: "Use an API",
          },
        ],
      ] as const) {
        const response = await gateway.call(name, args);
        expect(response.isError).toBe(true);
        expect(JSON.stringify(response.content)).toContain(
          "This capability profile cannot request integration access.",
        );
      }
      expect(world.fakeMac.waiting()).toEqual([]);
    } finally {
      await world.close();
    }
  });

  it("bounds durable tab-open replay while retaining each owner's successful identity placement", async () => {
    const world = await createWorld(database);
    try {
      const owner = world.owner.userId;
      const other = await world.store.createUser("Other replay owner");
      const runner = world.macId;
      const otherRunner = createId("runner");
      const tabId = BrowserSurfaceIdSchema.parse("surface-1");
      const bind = async (
        key: string,
        identityKey: string | null,
        opened = true,
        caller = owner,
        runnerId = runner,
      ) => {
        const binding: BrowserTabOpenBinding = {
          callerUserId: caller,
          idempotencyKey: key,
          requestFingerprint: "a".repeat(64),
          chosenSessionId: createBrowserSessionId(),
          browserStarted: false,
          initialPageOperationKey: key,
          outcome: opened ? { kind: "opened", tabId } : { kind: "pending" },
        };
        await world.store.bindBrowserTabOpen({ binding, identityKey, runnerId });
        return binding;
      };
      await bind("guest-old", "guest");
      await bind("guest-latest", "guest", true, owner, otherRunner);
      await bind("profile-latest", "profile-1");
      await bind("pending-old", "guest", false);
      await bind("session-old", null);
      await bind("other-owner", null, true, other);
      await sql`update browser_tab_opens set created_at = now() - interval '25 hours'`.execute(
        world.database,
      );
      // Explicit ordering makes the remembered preference deterministic even with equal DB timestamps.
      await sql`update browser_tab_opens set created_at = now() - interval '26 hours' where idempotency_key = 'guest-old'`.execute(
        world.database,
      );
      const recent = await bind("recent-pending", null, false);
      const rows = await world.database
        .selectFrom("browserTabOpens")
        .selectAll()
        .where("ownerId", "=", owner)
        .orderBy("idempotencyKey")
        .execute();
      expect(rows.map((row) => row.idempotencyKey)).toEqual([
        "guest-latest",
        "profile-latest",
        "recent-pending",
      ]);
      expect(await world.store.getBrowserTabOpen(owner, "guest-old")).toBeNull();
      expect(await world.store.getBrowserTabOpen(owner, "recent-pending")).toEqual(recent);
      expect(await world.store.getBrowserTabOpen(other, "other-owner")).not.toBeNull();
      expect(await world.store.rememberedBrowserPlacement(owner, "guest")).toBe(otherRunner);
      expect(await world.store.rememberedBrowserPlacement(owner, "profile-1")).toBe(runner);
      const directory =
        process.env.OPENSTEER_SHARED_SURFACES_ARTIFACT_DIR ??
        path.join(tmpdir(), "opensteer-owner-view-e2e");
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, "tab-open-retention.json"),
        JSON.stringify(
          { replayWindowHours: 24, rows, otherOwnerPreserved: true, preference: otherRunner },
          null,
          2,
        ),
      );
    } finally {
      await world.close();
    }
  });

  it("projects durable browser openers for two readers and redacts historical task IDs after access changes", async () => {
    const world = await createWorld(database);
    const reader = await world.store.createUser("Second reader");
    const keys = generateKeyPairSync("ed25519");
    const browser = new BrowserService({
      repository: world.store,
      signer: new BrowserAttachTicketSigner({ keyId: "test", privateKey: keys.privateKey }),
      profileStateBaseUrl: new URL("https://test-host.invalid"),
      profileVault: new BrowserProfileVault({ key: Buffer.alloc(32, 7), repository: world.store }),
      onSessionsChanged: () => undefined,
      onWorkspaceEvent: () => undefined,
    });
    try {
      await world.database
        .insertInto("workspaceMemberships")
        .values({
          id: createId("workspaceMembership"),
          workspaceId: world.workspace.id,
          userId: reader,
          role: "collaborator",
          state: "active",
          generation: 1,
          invitedBy: world.owner.userId,
          joinedAt: new Date(),
          revokedAt: null,
          revokedBy: null,
          updatedAt: new Date(),
        })
        .execute();
      const openerWorkspace = await world.createWorkspace("Opener workspace");
      await world.database
        .insertInto("workspaceMemberships")
        .values({
          id: createId("workspaceMembership"),
          workspaceId: openerWorkspace.id,
          userId: reader,
          role: "collaborator",
          state: "active",
          generation: 1,
          invitedBy: world.owner.userId,
          joinedAt: new Date(),
          revokedAt: null,
          revokedBy: null,
          updatedAt: new Date(),
        })
        .execute();
      const run = await world.startRun("Visible task opener", openerWorkspace);
      const taskOpener = await world.store.browserSessionOpenerForBinding(
        `run:${run.runId}`,
        world.owner.userId,
      );
      expect(taskOpener).toEqual({ kind: "task", threadId: run.threadId, runId: run.runId });
      const homeThread = await world.store.getThreadForOwner(run.threadId, world.owner.userId);
      if (!homeThread) throw new Error("Missing task");
      const openers: readonly (BrowserSessionOpenerRecord | null)[] = [
        { kind: "person", userId: world.owner.userId },
        taskOpener,
        { kind: "opensteer", threadId: run.threadId },
        { kind: "automation" },
        null,
      ];
      const ids: BrowserSessionId[] = [];
      for (const opener of openers) {
        const id = createBrowserSessionId();
        ids.push(id);
        await world.store.createBrowserSession({
          id,
          opener,
          leaseGeneration: 1,
          leaseTokenHash: null,
          placementKey: `runner:${world.macId}:privacy`,
          runnerId: world.macId,
          origin:
            opener?.kind === "person" || !opener
              ? "workspace"
              : opener.kind === "automation"
                ? "trigger"
                : "agent",
          profileId: null,
          runtimeId: "privacy",
          workspaceId: world.workspace.id,
        });
        await world.store.transitionBrowserSession({
          from: ["starting"],
          sessionId: id,
          state: "ready",
        });
      }
      const first = await browser.bootstrap(world.owner.userId);
      const second = await browser.bootstrap(reader);
      const byId = (bootstrap: typeof first) =>
        ids.map((id) => bootstrap.sessions.find((session) => session.id === id)?.opener);
      expect(byId(first)).toEqual([
        { kind: "you" },
        { kind: "task", threadId: run.threadId },
        { kind: "opensteer" },
        { kind: "automation" },
        { kind: "unknown" },
      ]);
      expect(byId(second)).toEqual([
        { kind: "unknown" },
        { kind: "task", threadId: run.threadId },
        { kind: "opensteer" },
        { kind: "automation" },
        { kind: "unknown" },
      ]);
      expect(JSON.stringify(second.sessions)).not.toContain(world.owner.userId);
      await world.database
        .updateTable("runs")
        .set({ status: "completed" })
        .where("id", "=", run.runId)
        .execute();
      expect(
        await world.store.browserSessionOpenerForBinding(`run:${run.runId}`, world.owner.userId),
      ).toEqual(taskOpener);
      await world.database
        .updateTable("threads")
        .set({ title: "Renamed after completion" })
        .where("id", "=", run.threadId)
        .execute();
      expect(byId(await browser.bootstrap(reader))[1]).toEqual({
        kind: "task",
        threadId: run.threadId,
      });
      // Keep the browser in shared work while its opener conversation moves behind a separate membership boundary.
      await world.store.changeWorkspaceMembership({
        actorId: world.owner.userId,
        targetUserId: reader,
        workspaceId: openerWorkspace.id,
        state: "revoked",
      });
      const redacted = await browser.bootstrap(reader);
      expect(byId(redacted)).toEqual([
        { kind: "unknown" },
        { kind: "unknown" },
        { kind: "unknown" },
        { kind: "automation" },
        { kind: "unknown" },
      ]);
      expect(JSON.stringify(redacted.sessions)).not.toContain(run.threadId);
      expect(JSON.stringify(redacted.sessions)).not.toContain("Renamed after completion");
      const directory =
        process.env.OPENSTEER_SHARED_SURFACES_ARTIFACT_DIR ??
        path.join(tmpdir(), "opensteer-owner-view-e2e");
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, "opener-privacy.json"),
        JSON.stringify(
          { ids, first, second, redacted, authoritativeAfterCompletion: taskOpener },
          null,
          2,
        ),
      );
    } finally {
      await browser.close();
      await world.close();
    }
  });

  it("tells only the Mac's owner which apps an agent is acting in, and when it stops", async () => {
    const actingWindowMs = 600;
    const store = new OpensteerStore(database);
    const realtime = new RealtimeHub({ store });
    const received = new Map<string, Record<string, unknown>[]>();
    const sink = (name: string): RealtimeSink => {
      received.set(name, []);
      return {
        close: () => undefined,
        id: name,
        send: async (message) => {
          received.get(name)?.push(message as unknown as Record<string, unknown>);
        },
      };
    };
    const world = await createWorld(database, { actingWindowMs, realtime });
    const stranger = await store.createUser("Not the Mac's owner");
    realtime.registerConnection(world.owner.userId, createId("authSession"), sink("owner-web"));
    realtime.registerConnection(world.owner.userId, createId("authSession"), sink("owner-phone"));
    realtime.registerConnection(stranger, createId("authSession"), sink("stranger"));
    const run = await world.startRun("Plan the week");
    const context = run.claims;
    const presence = (name: string) =>
      (received.get(name) ?? []).filter((message) => message.type === "host.computer-presence");
    try {
      let sessionId;
      const actedAt: Record<string, number> = {};
      for (const app of [apps.notes, apps.calendar]) {
        const sent = await observeMacWindow(world, context, app);
        actedAt[app.bundleId] = Date.now();
        sessionId = sent.sessionId;
      }
      if (!sessionId) throw new Error("No app session opened");
      await vi.waitFor(() =>
        expect(presence("owner-web").at(-1)).toEqual({
          sessions: [{ actingAppKeys: ["com.apple.ical", "com.apple.notes"], sessionId }],
          type: "host.computer-presence",
        }),
      );
      // The machines list says the same, so a client that rereads it agrees.
      expect(world.computerUse.sessionsForRunner(world.macId)).toEqual([
        expect.objectContaining({ actingAppKeys: ["com.apple.ical", "com.apple.notes"] }),
      ]);
      await vi.waitFor(
        () =>
          expect(presence("owner-web").at(-1)).toEqual({
            sessions: [{ actingAppKeys: [], sessionId }],
            type: "host.computer-presence",
          }),
        { timeout: actingWindowMs * 4 },
      );
      const quietAfterMs = Date.now() - actedAt[apps.calendar.bundleId]!;
      expect(quietAfterMs).toBeGreaterThanOrEqual(actingWindowMs);
      expect(presence("owner-phone")).toEqual(presence("owner-web"));
      expect(received.get("stranger")).toEqual([]);
      const artifactDirectory = process.env.OPENSTEER_SHARED_SURFACES_ARTIFACT_DIR;
      if (artifactDirectory) {
        await mkdir(artifactDirectory, { recursive: true });
        await writeFile(
          path.join(artifactDirectory, "computer-acting-presence.json"),
          JSON.stringify(
            {
              runId: run.runId,
              sessionId,
              actingWindowMs,
              quietAfterMs,
              ownerWeb: presence("owner-web"),
              ownerPhone: presence("owner-phone"),
              stranger: received.get("stranger"),
            },
            null,
            2,
          ),
        );
      }
    } finally {
      await world.close();
    }
  });

  it.each(["failed", "no-session"] as const)(
    "stops at once and for good, whatever the Mac answers (%s)",
    async (closeFailureCode) => {
      const world = await createWorld(database);
      const run = await world.startRun("Stop acknowledgement");
      const mac_ = { ownerUserId: world.owner.userId, runnerId: world.macId, runnerName: mac };
      const context = run.claims;
      const observe = await observeMacWindow(world, context);
      let release: () => void = () => undefined;
      world.fakeMac.closeGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      world.fakeMac.closeFailureCode = closeFailureCode;
      try {
        await expect(
          world.computerUse.stop(observe.sessionId, createId("user")),
        ).rejects.toMatchObject({ code: "unsupported" });
        // Stop completes before the Mac answers: the Host has taken the Run's
        // authority on the Mac back, and the session has left the list.
        await world.computerUse.stop(observe.sessionId, world.owner.userId);
        expect(world.computerUse.sessionsForRunner(world.macId)).toEqual([]);
        await vi.waitFor(() => expect(world.fakeMac.closeReceivedCount).toBe(1));
        await expect(world.computerUse.prepare(mac_, context)).rejects.toMatchObject({
          code: "stopped-by-user",
        });
        // Pressing Stop again, from anywhere, is harmless and sends nothing.
        await world.computerUse.stop(observe.sessionId, world.owner.userId);
        await world.platform.computerAppApprovals.stopComputerUseSession({
          actorUserId: world.owner.userId,
          sessionId: observe.sessionId,
        });
        release();
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(world.fakeMac.closeReceivedCount).toBe(1);
        await expect(world.computerUse.prepare(mac_, context)).rejects.toMatchObject({
          code: "stopped-by-user",
        });
        // A close the Mac did not take is told again on the minute sweep until
        // it answers; one it answered, even as already gone, is not repeated.
        world.fakeMac.closeFailureCode = null;
        world.computerUse.sweep();
        const expected = closeFailureCode === "failed" ? 2 : 1;
        await vi.waitFor(() => expect(world.fakeMac.closeReceivedCount).toBe(expected));
        world.computerUse.sweep();
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(world.fakeMac.closeReceivedCount).toBe(expected);
      } finally {
        release();
        world.fakeMac.closeGate = null;
        await world.close();
      }
    },
  );

  it("has nothing to stop when this Host has no computer-use service", async () => {
    const world = await createWorld(database, { withoutComputerUse: true });
    try {
      await expect(
        world.platform.computerAppApprovals.stopComputerUseSession({
          actorUserId: world.owner.userId,
          sessionId: ComputerUseSessionIdSchema.parse(`cus_${randomUUID()}`),
        }),
      ).resolves.toBeUndefined();
    } finally {
      await world.close();
    }
  });

  it("asks on the Mac, continues into computer code, observes, acts, meets busy and Stop", async () => {
    const world = await createWorld(database);
    const runA = await world.startRun("Shopping list");
    const a = await world.gateway(runA);

    // Initialization carries no duplicate instructions; discovery carries shared guidance.
    expect(mcp.instructions).toBeUndefined();

    // 1. Search without runnerId: the catalog row names the Mac and the next step.
    const catalog = json(await a.call("integration_search", { query: "Computer use" }));
    const row = catalog.catalog.find(({ definitionId }: { definitionId: string }) => {
      return definitionId === "macos-app";
    });
    expect(row).toMatchObject({
      integration: "Computer use",
      computers: [
        { runnerId: world.macId, name: mac, state: "ready", appApproval: "ask", apps: [] },
      ],
    });

    // 2. Search with runnerId: installed apps, each with its own next step.
    const installed = json(await a.call("integration_search", { runnerId: world.macId }));
    expect(installed).toMatchObject({ total: 4, nextOffset: null });
    expect(installed.apps).toContainEqual({
      name: "Notes",
      bundleId: "com.apple.Notes",
      status: "not-approved",
      callable: false,
    });
    expect(installed.guidance.computers).toContain("Search with runnerId to list installed apps");
    const filtered = json(
      await a.call("integration_search", { runnerId: world.macId, query: "note", limit: 1 }),
    );
    expect(filtered).toMatchObject({ total: 1, nextOffset: null, apps: [{ name: "Notes" }] });

    // 3. Request under ask: pending, and the Mac is told to review it now.
    const pending = await a.call("integration_request", {
      kind: "computer-app",
      runnerId: world.macId,
      app: "Notes",
      access: "read-write",
      reason: "Add the groceries to the shared list.",
    });
    expect(pending.isError).toBeUndefined();
    const pendingBody = json(pending);
    expect(pendingBody).toMatchObject({
      kind: "computer.app.access",
      status: "pending",
      replayed: false,
      nextAction: `Approval is pending on ${mac}. Continue other work or end this turn; Opensteer continues this thread when it is resolved. Do not repeat the request.`,
    });
    const [setup] = await world.persistence.listComputerAppSetupRequests(world.owner.userId);
    expect(setup).toMatchObject({
      app: apps.notes,
      reason: "Add the groceries to the shared list.",
      threadTitle: "Shopping list",
    });
    await vi.waitFor(() => expect(world.fakeMac.reviews).toEqual([setup!.id]));

    // Searching again while it waits must not invite a second request.
    const waiting = json(await a.call("integration_search", { runnerId: world.macId }));
    expect(waiting.apps.find(({ name }: { name: string }) => name === "Notes")).toEqual({
      name: "Notes",
      bundleId: "com.apple.Notes",
      status: "not-approved",
      pending: "mac",
      callable: false,
    });

    // 4. The person allows it on the Mac, which signs and consumes the request.
    await world.approveOnMac(setup!);
    const fulfilled = await world.requestById(pendingBody.requestId);
    expect(fulfilled.status).toBe("fulfilled");

    // 5. The continuation names the app selector the model will use.
    const approved = json(await a.call("integration_search", { runnerId: world.macId }));
    const notes = approved.apps.find(({ name }: { name: string }) => name === "Notes");
    expect(notes).toEqual({
      name: "Notes",
      bundleId: "com.apple.Notes",
      status: "approved",
      access: "read-write",
      callable: true,
    });
    expect(await continuationMessage(fulfilled, inventorySource(world.platform))).toBe(
      `Request ${fulfilled.id} was fulfilled. Notes on ${mac} is ready. Use app("Notes", {computer: "Alex's Mac"}) in the computer tool. Continue.`,
    );

    expect(notes).not.toHaveProperty("toolRefs");
    expect(notes).not.toHaveProperty("nextAction");
    expect(approved.guidance.computers).toContain(
      "With callable:true, use app() in the computer tool",
    );
    expect(approved.guidance.computers).toContain("Do not repeat pending requests");
    const [legacy] = await world.platform.listCallableTools({
      ownerUserId: world.owner.userId,
      workspaceId: runA.workspaceId,
      threadId: runA.threadId,
    });
    if (!legacy) throw new Error("Missing internal authority row");
    expect(
      await a.call("integration_call", {
        toolRef: `${legacy.grant.id}.${legacy.tool.id}.${legacy.tool.schemaDigest}`,
      }),
    ).toEqual(refusal("Use the computer tool to see and operate apps and phones."));

    // 6. Observe the bound window, without an image-capable engine and then with one.
    const observed = await a.call("computer", {
      code: 'globalThis.w=await (await app("Notes", {computer:"Alex\'s Mac"})).window(); await w.observe({screenshot:true})',
    });
    expect(observed.structuredContent).toBeUndefined();
    expect(observed.isError).toBeUndefined();
    const firstText = `Looked at Notes\nObservation obs-1 of Notes (Groceries) — 2 elements. Screenshot 1200×900 px; all coordinates are screenshot pixels.\n${tree}\nWindows: [{"id":7,"title":"Groceries","current":true},{"id":8,"title":"Work","current":false}]\nScreenshot unavailable in this engine.`;
    expect(observed.content).toEqual([{ type: "text", text: firstText }]);
    world.imageGate.on = true;
    const pictured = await a.call("computer", { code: "await w.observe({screenshot:true})" });
    expect(pictured.content).toEqual([
      {
        type: "text",
        text: firstText
          .replace("obs-1", "obs-2")
          .replace("\nScreenshot unavailable in this engine.", ""),
      },
      {
        _meta: { "codex/imageDetail": "original" },
        type: "image",
        data: Buffer.from("image-2").toString("base64"),
        mimeType: "image/jpeg",
      },
    ]);

    // 7. A batch uses the latest per-window snapshot and does not observe after acting.
    const acted = await a.call("computer", {
      code: 'await w.act([{type:"click",target:{index:1}},{type:"type",text:"Milk"}])',
    });
    expect(acted.isError).toBeUndefined();
    expect(text(acted)).toBe('Clicked element 1\nTyped "Milk"');
    expect(
      world.fakeMac.frames
        .filter((frame) => ["bind", "observe", "act"].includes(frame.operation))
        .map((frame) => frame.operation),
    ).toEqual(["bind", "observe", "observe", "act"]);
    expect(world.fakeMac.frames.at(-1)?.params).toMatchObject({ snapshot: "obs-2" });
    world.fakeMac.invalidateSnapshots();
    expect(await a.call("computer", { code: 'await w.key("cmd+s")' })).toEqual(
      refusal("stale-observation: Observe this window again."),
    );
    expect(
      await a.call("computer", {
        code: 'const unseen=await (await app("Notes")).window(8); await unseen.key("cmd+s")',
      }),
    ).toEqual(refusal("stale-observation: Observe this window first."));
    expect(
      text(await a.call("computer", { code: "await w.observe({screenshot:true})" })),
    ).toContain("Observation obs-3");

    // 8. A second task finds the app held, by name, in search and in the call.
    const runB = await world.startRun("Weekly review");
    const b = await world.gateway(runB);
    const held = json(await b.call("integration_search", { runnerId: world.macId }));
    expect(held.apps.find(({ name }: { name: string }) => name === "Notes")).toMatchObject({
      status: "approved",
      inUse: true,
      callable: false,
      heldByThread: "Shopping list",
    });
    expect(await b.call("computer", { code: 'await (await app("Notes")).window()' })).toEqual(
      refusal(
        `busy: This app is already being used by another task. (Thread: Shopping list) ${computerUseBusyNextStep}`,
      ),
    );

    // 9. Stop on the Mac ends every session there; the next call says so.
    world.fakeMac.stopFromPill();
    await vi.waitFor(() => expect(world.computerUse.sessionsForRunner(world.macId)).toEqual([]));
    expect(await a.call("computer", { code: "await w.observe()" })).toEqual(
      refusal(`stopped-by-user: Computer use was stopped for this task on ${mac}.`),
    );
    expect(world.fakeMac.openSessions()).toEqual([]);
    await world.close();
  });

  it("keeps every Thread waiting on one approval per app, widening it rather than declining anyone", async () => {
    const world = await createWorld(database);
    const runA = await world.startRun("Shopping list");
    const runB = await world.startRun("Weekly review");
    const a = await world.gateway(runA);
    const b = await world.gateway(runB);
    const ask = async (
      gateway: typeof a,
      app: string,
      access: "read" | "read-write",
    ): Promise<string> => {
      const body = json(
        await gateway.call("integration_request", {
          kind: "computer-app",
          app,
          access,
          reason: `Use ${app}.`,
        }),
      );
      expect(body).toMatchObject({ kind: "computer.app.access", status: "pending" });
      return body.requestId;
    };
    const approvalFor = async (app: string) => {
      const rows = (
        await world.persistence.listComputerAppSetupRequests(world.owner.userId)
      ).filter((row) => row.app?.displayName === app);
      expect(rows).toHaveLength(1);
      return rows[0]!;
    };
    const linkedTo = async (requestId: string) => {
      const request = await world.requestById(requestId);
      if (request.payload.kind !== "computer.app.access") throw new Error("Not an app Request");
      return { status: request.status, setupRequestId: request.payload.setupRequestId };
    };

    // A wider ask first: the narrower one joins it, and nobody is declined.
    const notesA = await ask(a, "Notes", "read-write");
    const notesApproval = await approvalFor("Notes");
    const notesB = await ask(b, "Notes", "read");
    expect(await approvalFor("Notes")).toEqual(notesApproval);
    expect(await linkedTo(notesA)).toEqual({ status: "pending", setupRequestId: notesApproval.id });
    expect(await linkedTo(notesB)).toEqual({ status: "pending", setupRequestId: notesApproval.id });

    // A narrower ask first: the approval widens under a new id, still naming the first task.
    const calendarA = await ask(a, "Calendar", "read");
    const narrow = await approvalFor("Calendar");
    const calendarB = await ask(b, "Calendar", "read-write");
    const widened = await approvalFor("Calendar");
    expect(widened).toMatchObject({
      access: "read-write",
      threadId: runA.threadId,
      threadTitle: "Shopping list",
      reason: "Use Calendar.",
    });
    expect(widened.id).not.toBe(narrow.id);
    expect(await linkedTo(calendarA)).toEqual({ status: "pending", setupRequestId: widened.id });
    expect(await linkedTo(calendarB)).toEqual({ status: "pending", setupRequestId: widened.id });
    await vi.waitFor(() => expect(world.fakeMac.reviews).toContain(widened.id));
    // The narrow approval is gone, so a signature taken over it consumes nothing.
    await expect(world.approveOnMac(narrow)).rejects.toThrow();

    // One Allow each fulfils every Thread waiting on it, with a usable app selector.
    await world.approveOnMac(notesApproval);
    await world.approveOnMac(widened);
    for (const [requestId, app] of [
      [notesA, "Notes"],
      [notesB, "Notes"],
      [calendarA, "Calendar"],
      [calendarB, "Calendar"],
    ] as const) {
      const request = await world.requestById(requestId);
      expect(request.status).toBe("fulfilled");
      expect(await continuationMessage(request, inventorySource(world.platform))).toBe(
        `Request ${requestId} was fulfilled. ${app} on ${mac} is ready. Use app(${JSON.stringify(app)}, {computer: ${JSON.stringify(mac)}}) in the computer tool. Continue.`,
      );
    }
    // Both Threads share the wider Workspace grant, independent of ask order.
    const callable = await world.platform.listCallableTools({
      ownerUserId: world.owner.userId,
      workspaceId: runA.workspaceId,
      threadId: runA.threadId,
    });
    for (const app of ["Notes", "Calendar"]) {
      const connection = await world.connectionFor(app);
      expect(
        callable
          .filter((row) => row.grant.connectionId === connection.id)
          .map((row) => row.tool.name),
      ).toContain("act");
    }

    // One Don't allow on the Mac declines every Thread waiting on it.
    const textEditA = await ask(a, "TextEdit", "read");
    const textEditB = await ask(b, "TextEdit", "read");
    await world.platform.computerAppApprovals.cancelComputerAppSetup({
      requestId: (await approvalFor("TextEdit")).id,
      ownerUserId: world.owner.userId,
    });
    for (const requestId of [textEditA, textEditB]) {
      const request = await world.requestById(requestId);
      expect(request.status).toBe("declined");
      expect(await continuationMessage(request, inventorySource(world.platform))).toBe(
        `Request ${requestId} was declined by the user. Continue the task without TextEdit on ${mac} and do not request it again unless the user asks.`,
      );
    }
    await world.close();
  });

  it("carries approvals on the Mac's own stream: sent again on reconnect, withdrawn when they end, and signed only by the desktop's key", async () => {
    const world = await createWorld(database);
    const a = await world.gateway(await world.startRun("Shopping list"));
    const ask = async (app: string) =>
      json(
        await a.call("integration_request", {
          kind: "computer-app",
          app,
          access: "read",
          reason: `Use ${app}.`,
        }),
      );
    const notesAsk = await ask("Notes");
    const calendarAsk = await ask("Calendar");
    const setups = await world.persistence.listComputerAppSetupRequests(world.owner.userId);
    const notes = setups.find(({ app }) => app?.displayName === "Notes")!;
    const calendar = setups.find(({ app }) => app?.displayName === "Calendar")!;
    // Each list carries everything a panel shows and the key answers are taken with.
    await vi.waitFor(() =>
      expect(world.fakeMac.lists.at(-1)).toEqual({
        approvalKeyId: expect.stringMatching(/^sha256:/u),
        approvals: [
          { request: expect.objectContaining({ ...notes, workspaceName: expect.any(String) }) },
          { request: expect.objectContaining({ ...calendar, workspaceName: expect.any(String) }) },
        ],
      }),
    );

    // The Mac's stream drops — a lapsed session, a sleeping Mac, a Host
    // release; nothing here depends on how the person signed in — and while it
    // is away Calendar is declined from the phone.
    world.fakeMac.detach();
    await world.platform.computerAppApprovals.declineComputerAppAccess({
      requestId: calendarAsk.requestId,
      resolvedBy: world.owner.userId,
      response: { kind: "external", value: { decision: "declined" } },
    });
    const sentWhileAway = world.fakeMac.lists.length;
    await world.fakeMac.attach();
    // Back: the whole list arrives at once, and Calendar is not in it.
    await vi.waitFor(() => expect(world.fakeMac.lists.length).toBeGreaterThan(sentWhileAway));
    expect(world.fakeMac.waiting()).toEqual([notes.id]);

    // A signature by the Runner's own key — which any process running as the
    // person can read — is refused, and nothing changes.
    await expect(world.approveWithRunnerKey(notes)).rejects.toThrow(
      "Approve this access in Opensteer on the computer that provides the app.",
    );
    expect((await world.requestById(notesAsk.requestId)).status).toBe("pending");
    expect(await world.appAccess()).toEqual({});
    expect(world.fakeMac.waiting()).toEqual([notes.id]);

    // The desktop's key is.
    await world.approveOnMac(notes);
    expect((await world.requestById(notesAsk.requestId)).status).toBe("fulfilled");
    await vi.waitFor(() => expect(world.fakeMac.waiting()).toEqual([]));
    await world.close();
  });

  it("settles every linked task on a signed Mac refusal and rejects a forged or replayed refusal", async () => {
    const world = await createWorld(database);
    const a = await world.gateway(await world.startRun("First note"));
    const b = await world.gateway(await world.startRun("Second note"));
    const ask = async (gateway: typeof a, reason: string) =>
      json(
        await gateway.call("integration_request", {
          access: "read",
          app: "Notes",
          kind: "computer-app",
          reason,
        }),
      );
    const first = await ask(a, "Read the first note.");
    const second = await ask(b, "Read the second note.");
    expect(first.requestId).not.toBe(second.requestId);
    const [setup] = await world.persistence.listComputerAppSetupRequests(world.owner.userId);
    if (!setup) throw new Error("Missing Notes approval");
    await vi.waitFor(() => expect(world.fakeMac.waiting()).toEqual([setup.id]));

    const forged = await world.denyOnMac(setup, generateKeyPairSync("ed25519").privateKey);
    expect(forged).toMatchObject({ kind: "refused" });
    const allowPresentedAsDeny = await world.fakeMac.answer(setup.id, {
      approval: world.signApproval(setup, "allow"),
      kind: "deny",
    });
    expect(allowPresentedAsDeny).toMatchObject({ kind: "refused" });
    expect((await world.requestById(first.requestId)).status).toBe("pending");
    expect((await world.requestById(second.requestId)).status).toBe("pending");
    expect(world.fakeMac.waiting()).toEqual([setup.id]);

    expect(await world.denyOnMac(setup)).toEqual({ kind: "declined" });
    for (const id of [first.requestId, second.requestId]) {
      const request = await world.requestById(id);
      expect(request.status).toBe("declined");
      expect(await continuationMessage(request, inventorySource(world.platform))).toContain(
        `Request ${id} was declined by the user.`,
      );
    }
    await vi.waitFor(() => expect(world.fakeMac.waiting()).toEqual([]));
    expect(await world.appAccess()).toEqual({});

    const c = await world.gateway(await world.startRun("Third note"));
    const third = await ask(c, "Read the third note.");
    const [replacement] = await world.persistence.listComputerAppSetupRequests(world.owner.userId);
    if (!replacement) throw new Error("Missing replacement approval");
    expect(replacement.id).not.toBe(setup.id);
    expect(await world.denyOnMac(setup)).toMatchObject({ kind: "refused" });
    expect((await world.requestById(third.requestId)).status).toBe("pending");
    expect(world.fakeMac.waiting()).toEqual([replacement.id]);
    await world.approveOnMac(replacement);
    expect((await world.requestById(third.requestId)).status).toBe("fulfilled");
    await world.close();
  });

  it("lets a Main Workspace task use an app it asked for through inherited access", async () => {
    const world = await createWorld(database);
    const main = await world.createWorkspace("Main", "main");
    const m = await world.gateway(await world.startRun("Main task", main));
    const pending = json(
      await m.call("integration_request", {
        kind: "computer-app",
        app: "Notes",
        access: "read-write",
        reason: "Add the groceries.",
      }),
    );
    const [setup] = await world.persistence.listComputerAppSetupRequests(world.owner.userId);
    await world.approveOnMac(setup!);
    const listed = json(await m.call("integration_search", { runnerId: world.macId })).apps[0];
    expect(listed).toMatchObject({
      status: "approved",
      callable: true,
    });
    const fulfilled = await world.requestById(pending.requestId);
    expect(await continuationMessage(fulfilled, inventorySource(world.platform))).toBe(
      `Request ${fulfilled.id} was fulfilled. Notes on ${mac} is ready. Use app("Notes", {computer: "Alex's Mac"}) in the computer tool. Continue.`,
    );
    expect(
      text(
        await m.call("computer", { code: 'await (await (await app("Notes")).window()).observe()' }),
      ),
    ).toMatch(/^Looked at Notes\nObservation obs-1 of Notes /u);
    await world.close();
  });

  it("approves automatically, never widens, blocks, keeps connections, grants other Workspaces, and refuses offline and Trigger calls", async () => {
    const world = await createWorld(database);
    const runA = await world.startRun("Shopping list");
    const a = await world.gateway(runA);
    await a.call("integration_request", {
      kind: "computer-app",
      app: "Notes",
      access: "read-write",
      reason: "Add the groceries.",
    });
    const [notesSetup] = await world.persistence.listComputerAppSetupRequests(world.owner.userId);
    await world.approveOnMac(notesSetup!);

    // The Mac's owner turns on automatic approval there.
    await world.automaticOnMac();
    const catalog = json(await a.call("integration_search", { query: "Computer use" }));
    expect(macRow(catalog)).toMatchObject({
      computers: [{ appApproval: "automatic", computerToolEnabled: true, computerUseVersion: 2 }],
    });

    // A new app is fulfilled in the same result and its handle works at once.
    const calendar = json(
      await a.call("integration_request", {
        kind: "computer-app",
        runnerId: world.macId,
        app: "Calendar",
        access: "read-write",
        reason: "Add the dentist appointment.",
      }),
    );
    expect(calendar).toEqual({
      status: "fulfilled",
      nextAction: "Use the computer tool to see and operate approved apps and phones.",
    });
    expect(
      text(
        await a.call("computer", {
          code: 'await (await (await app("Calendar")).window()).observe()',
        }),
      ),
    ).toMatch(/^Looked at Calendar\nObservation obs-\d+ of Calendar \(Groceries\) — 2 elements\./u);

    // More access than an approval holds is a prompt on the Mac, even now.
    const textEdit = json(
      await a.call("integration_request", {
        kind: "computer-app",
        app: "TextEdit",
        access: "read",
        reason: "Read the draft.",
      }),
    );
    expect(textEdit).toEqual({
      status: "fulfilled",
      nextAction: "Use the computer tool to see and operate approved apps and phones.",
    });
    const reviews = world.fakeMac.reviews.length;
    const widen = json(
      await a.call("integration_request", {
        kind: "computer-app",
        app: "TextEdit",
        access: "read-write",
        reason: "Fix the typo in the draft.",
      }),
    );
    expect(widen).toMatchObject({
      kind: "computer.app.access",
      status: "pending",
      nextAction: `Approval is pending on ${mac}. Continue other work or end this turn; Opensteer continues this thread when it is resolved. Do not repeat the request.`,
    });
    await vi.waitFor(() => expect(world.fakeMac.reviews).toHaveLength(reviews + 1));
    expect(await world.appAccess()).toMatchObject({ TextEdit: "read" });
    // The person declines it from anywhere; the thread is told to carry on without it.
    const { request: declined } =
      await world.platform.computerAppApprovals.declineComputerAppAccess({
        requestId: widen.requestId,
        resolvedBy: world.owner.userId,
        response: { kind: "external", value: { decision: "declined" } },
      });
    expect(await continuationMessage(declined, inventorySource(world.platform))).toBe(
      `Request ${declined.id} was declined by the user. Continue the task without TextEdit on ${mac} and do not request it again unless the user asks.`,
    );
    expect(await world.appAccess()).toMatchObject({ TextEdit: "read" });
    // Declined elsewhere, so the Mac's panel for it closes: its next list no
    // longer holds it.
    const widenSetup = world.fakeMac.reviews.at(-1);
    await vi.waitFor(() => expect(world.fakeMac.waiting()).not.toContain(widenSetup));

    // The deny list and an unknown app answer in the Mac's own words.
    expect(
      await a.call("integration_request", {
        kind: "computer-app",
        app: "1Password",
        access: "read",
        reason: "Find the Wi-Fi password.",
      }),
    ).toEqual(refusal("Opensteer does not operate password managers."));
    expect(
      await a.call("integration_request", {
        kind: "computer-app",
        app: "Photoshop",
        access: "read",
        reason: "Crop the photo.",
      }),
    ).toEqual(refusal('No app on this Mac is called "Photoshop".'));

    // The ordinary integration forms name no app, so they are sent to the one that does.
    const oneAppAtATime = refusal(
      'Computer use is requested one app at a time: call integration_request {kind: "computer-app", runnerId, app, access, reason}.',
    );
    expect(
      await a.call("integration_request", {
        integration: "macos-app",
        access: "read-write",
        reason: "Use Calendar.",
      }),
    ).toEqual(oneAppAtATime);
    expect(
      await a.call("integration_request", {
        catalog: "macos-app",
        access: "read-write",
        reason: "Use Calendar.",
      }),
    ).toEqual(oneAppAtATime);
    const readyCatalog = macRow(
      json(await a.call("integration_search", { query: "Computer use" })),
    );
    expect(readyCatalog.computers[0]!.apps).toContainEqual(
      expect.objectContaining({
        name: "Notes",
        status: "approved",
        callable: true,
      }),
    );

    // Blocking keeps the connection, removes the tools, and refuses a new ask.
    await world.platform.computerAppApprovals.blockComputerApp({
      connectionId: (await world.connectionFor("Calendar")).id,
      ownerUserId: world.owner.userId,
      requestId: "block-calendar",
    });
    expect(
      await a.call("integration_request", {
        kind: "computer-app",
        app: "Calendar",
        access: "read",
        reason: "Look at the week.",
      }),
    ).toEqual(refusal(`Calendar is blocked on ${mac}. The person can unblock it on that Mac.`));
    expect(await a.call("computer", { code: 'await app("Calendar")' })).toEqual(
      refusal("app-not-allowed: No approved app matches Calendar. Search integrations for access."),
    );
    const listing = json(await a.call("integration_search", { runnerId: world.macId }));
    expect(listing.apps).toEqual([
      expect.objectContaining({
        name: "Notes",
        callable: true,
      }),
      {
        name: "Calendar",
        bundleId: "com.apple.iCal",
        status: "blocked",
        callable: false,
      },
      expect.objectContaining({
        name: "TextEdit",
        access: "read",
        callable: true,
      }),
      {
        name: "1Password",
        bundleId: "com.1password.1password",
        status: "not-approved",
        callable: false,
      },
    ]);

    // Turning automatic off keeps every connection, block included.
    const before = await world.appAccess();
    await world.platform.computerAppApprovals.setComputerUsePolicy({
      runnerId: world.macId,
      ownerUserId: world.owner.userId,
      appApproval: "ask",
      requestId: "policy-ask",
    });
    expect(await world.appAccess()).toEqual(before);
    expect(
      macRow(json(await a.call("integration_search", { query: "Computer use" }))).computers[0],
    ).toMatchObject({ appApproval: "ask" });

    // Another Workspace asks for an approved app: an ordinary Request, approvable anywhere.
    const sideProject = await world.createWorkspace("Side project");
    const runD = await world.startRun("Side notes", sideProject);
    const d = await world.gateway(runD);
    const sideListing = json(await d.call("integration_search", { runnerId: world.macId }));
    expect(sideListing.apps[0]).toEqual({
      name: "Notes",
      bundleId: "com.apple.Notes",
      status: "approved",
      access: "read-write",
      callable: false,
    });
    const sideResults = json(await d.call("integration_search", { query: "Computer use" }));
    expect(macRow(sideResults).computers[0]!.apps).toContainEqual(
      expect.objectContaining({
        name: "Notes",
        status: "approved",
        callable: false,
      }),
    );
    expect(sideResults.guidance.computers).toContain(
      "An approved app with callable:false needs Workspace access, approved from anywhere",
    );
    const grantAsk = await d.call("integration_request", {
      kind: "computer-app",
      app: "Notes",
      access: "read",
      reason: "Read the side notes.",
    });
    const grantBody = JSON.parse(text(grantAsk).split("\n")[0]!);
    expect(grantBody).toMatchObject({ kind: "integration.access", status: "pending" });
    expect(text(grantAsk)).toContain("The user has been asked in Opensteer.");
    expect(
      json(await d.call("integration_search", { runnerId: world.macId })).apps[0],
    ).toMatchObject({
      pending: "workspace",
    });
    const notesConnection = await world.connectionFor("Notes");
    const { request: granted } = await world.platform.resolveRequest({
      requestId: grantBody.requestId,
      resolvedBy: world.owner.userId,
      response: {
        kind: "external",
        value: {
          alias: "Notes on Alex's Mac",
          access: "read",
          connectionId: notesConnection.id,
          decision: "fulfilled",
          isDefault: true,
        },
      },
    });
    const sideNotes = json(await d.call("integration_search", { runnerId: world.macId })).apps[0];
    expect(sideNotes).toMatchObject({
      callable: true,
    });
    expect(sideNotes).not.toHaveProperty("toolRefs");
    // Discovery names the owner's approval; the Workspace grant remains read-only.
    expect(sideNotes.access).toBe("read-write");
    const sideTools = await world.platform.listCallableTools({
      ownerUserId: world.owner.userId,
      workspaceId: runD.workspaceId,
      threadId: runD.threadId,
    });
    expect(
      sideTools
        .filter((row) => row.grant.connectionId === notesConnection.id)
        .map((row) => row.tool.name),
    ).toEqual(["observe"]);
    expect(await continuationMessage(granted, inventorySource(world.platform))).toBe(
      `Request ${granted.id} was fulfilled. Notes on ${mac} is ready. Use app("Notes", {computer: "Alex's Mac"}) in the computer tool. Continue.`,
    );

    // Several Macs and no runnerId: the refusal names each with its id.
    const studio = await world.addMac("Studio Mac");
    const d2 = await world.gateway(runD);
    expect(
      await d2.call("integration_request", {
        kind: "computer-app",
        app: "Notes",
        access: "read",
        reason: "Read the notes.",
      }),
    ).toEqual(
      refusal(
        `This task is not running on a Mac set up for computer use, so name one with runnerId. These are set up: ${mac} (${world.macId}), Studio Mac (${studio}).`,
      ),
    );

    // An offline Mac is named, and nothing is created.
    world.fakeMac.detach();
    const setupRequests = await world.persistence.listComputerAppSetupRequests(world.owner.userId);
    expect(
      await a.call("integration_request", {
        kind: "computer-app",
        runnerId: world.macId,
        app: "Mail",
        access: "read",
        reason: "Find the invoice.",
      }),
    ).toEqual(refusal(`${mac} is offline.`));
    expect(await world.persistence.listComputerAppSetupRequests(world.owner.userId)).toEqual(
      setupRequests,
    );
    expect(await a.call("integration_search", { runnerId: world.macId })).toEqual(
      refusal(`${mac} is offline.`),
    );
    const offlineCatalog = json(await a.call("integration_search", { query: "Computer use" }));
    expect(macRow(offlineCatalog).computers[0]).toMatchObject({ state: "offline" });
    expect(offlineCatalog.guidance.computers).toContain("state offline: wait for it to return");
    expect(JSON.stringify(offlineCatalog)).not.toContain("toolRef");
    expect(await a.call("computer", { code: 'await (await app("Notes")).windows()' })).toEqual(
      refusal(`offline: ${mac} is offline. Notes will work again when it is back.`),
    );

    // A Trigger occurrence has no Run for a session to belong to.
    await world.fakeMac.attach();
    const trigger = await world.gateway(runA, true);
    expect(
      await trigger.call("integration_request", {
        kind: "computer-app",
        app: "Notes",
        access: "read",
        reason: "Look.",
      }),
    ).toEqual(
      refusal("A session on a computer belongs to a running task, so only a task can ask for one."),
    );
    expect(await trigger.call("computer", { code: "return 1" })).toEqual(
      refusal(
        "The computer tool is not available to this execution. Update this task's Runner to use it.",
      ),
    );
    await world.close();
  });
});

/*
 * The same journey for an Android phone, held whole by one task at a time.
 * Every way it can go wrong for a model, written before the code:
 * - a second task's call reaches the phone, or is refused without naming
 *       whose task holds it;
 * - a task's hold outlives its Run, a person's Stop, or three idle minutes;
 * - a revoked grant, lowered access, a disconnected phone or an uninstalled
 *       definition leaves a live session operating the phone;
 * - a task that may only look gets an act through, or cannot let go;
 * - releasing a phone the task does not hold is an error;
 * - an act whose answer was lost reads as failed (and is retried), or an
 *       observe whose answer was lost reads as unknown;
 * - a stale observation lets actions run;
 * - a task resolves somebody else's phone, an unknown id, or a Mac without
 *       an app, or asks an offline phone;
 * - a phone key or a Runner-originated signed answer can mutate owner access;
 * - automatic approval reaches a phone, by asking for it or consuming it;
 * - a person's Stop on the phone leaves the task able to carry on;
 * - an agent ask creates/widens a connection, or owner Allow fails to settle it;
 * - a phone ask waits for approval traffic the phone no longer handles.
 */
integration.sequential("An Android phone, end to end as a model sees it", () => {
  let isolated: Awaited<ReturnType<typeof createMachineAccessDatabase>>;
  let database: ReturnType<typeof createDatabase>;
  beforeAll(async () => {
    isolated = await createMachineAccessDatabase(baseDatabaseUrl!);
    database = createDatabase({
      applicationName: "host-agent-phone-journey-test",
      connectionString: isolated.url,
      maxConnections: 4,
    });
  }, 120_000);
  beforeEach(async () => {
    mcp.callHandler = undefined;
    mcp.listHandler = undefined;
    mcp.registrations = 0;
    await resetMachineAccessDatabase(isolated.url);
  });
  afterAll(async () => {
    await database?.destroy();
    await isolated?.drop();
  });

  type World = Awaited<ReturnType<typeof createWorld>>;
  type Gateway = Awaited<ReturnType<World["gateway"]>>;

  function phoneOf(world: World) {
    if (!world.phoneId || !world.fakePhone) throw new Error("This world has no phone.");
    return { fakePhone: world.fakePhone, phoneId: world.phoneId };
  }

  function phoneCode(gateway: Gateway, code: string) {
    return gateway.call("computer", {
      code: `const p=await phone(${JSON.stringify(phone)});\n${code}`,
    });
  }

  /** The phone's row in the catalog's `phones` block, as a model reads it. */
  async function phoneRow(gateway: Gateway) {
    const search = json(await gateway.call("integration_search", { query: "Android phone" }));
    const row = search.catalog.find(
      ({ definitionId }: { definitionId: string }) => definitionId === "android-phone",
    );
    if (!row) throw new Error("The catalog has no Android phone entry");
    return row as {
      readonly phones: readonly Record<string, unknown>[];
    };
  }

  /** A task asks for the phone, its owner allows it from a client, and tools become callable. */
  async function grantedPhone(
    world: World,
    gateway: Gateway,
    access: "read" | "read-write",
  ): Promise<void> {
    const { fakePhone, phoneId } = phoneOf(world);
    const asked = json(
      await gateway.call("integration_request", {
        access,
        kind: "computer-app",
        reason: "Text the driver the gate code.",
        runnerId: phoneId,
      }),
    );
    expect(asked).toMatchObject({ kind: "computer.app.access", status: "pending" });
    const setup = (await world.persistence.listComputerAppSetupRequests(world.owner.userId)).find(
      ({ definitionId }) => definitionId === "android-phone",
    );
    if (!setup) throw new Error("The phone was not asked");
    expect(fakePhone.lists).toEqual([]);
    await world.allowPhoneFromClient(setup);
    const row = await phoneRow(gateway);
    expect(row.phones[0]).toMatchObject({ approval: "approved", access });
    expect(row.phones[0]).not.toHaveProperty("toolRefs");
  }

  it("reasserts each call's authenticated executing Runner when reusing an attempt", async () => {
    const world = await createWorld(database, { phone: true });
    const { phoneId, fakePhone } = phoneOf(world);
    const run = await world.startRun("Reuse authority");
    const target = { ownerUserId: world.owner.userId, runnerId: phoneId, runnerName: phone };
    const lease = await world.computerUse.prepare(target, run.claims);
    await (
      await world.hub.withRunnerAdmission(phoneId, () =>
        world.computerUse.sendObserve(
          lease,
          { kind: "display", definitionId: "android-phone", access: "read" },
          false,
        ),
      )
    ).settle();
    await expect(
      world.computerUse.prepare(target, { ...run.claims, runnerBootId: "a different boot" }),
    ).rejects.toMatchObject({ code: "failed" });
    expect(fakePhone.received("observe")).toBe(1);
    await world.close();
  });

  it("withdraws a stopped attempt during a held phone batch before any later action", async () => {
    const world = await createWorld(database, { phone: true });
    const { fakePhone, phoneId } = phoneOf(world);
    const run = await world.startRun("Held phone batch");
    const gateway = await world.gateway(run);
    await grantedPhone(world, gateway, "read-write");
    await phoneCode(gateway, "await p.observe()");
    let resume!: () => void;
    fakePhone.gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const act = phoneCode(
      gateway,
      'await p.act([\n          { type: "wait", ms: 5000 },\n          { type: "tap", target: { index: 1 } },\n        ])',
    );
    await fakePhone.reached("act");
    expect(fakePhone.received("act")).toBe(1);
    await world.store.enqueueRunnerControl({
      type: "run.interrupt",
      runId: run.runId,
      threadId: run.threadId,
      requestedBy: world.owner.userId,
      idempotencyKey: "stop-held-phone",
    });
    await fakePhone.reached("close");
    expect(fakePhone.received("close")).toBe(1);
    expect(world.computerUse.sessionsForRunner(phoneId)).toEqual([]);
    resume();
    expect((await act).isError).toBe(true);
    expect(fakePhone.completedActions).toBe(0);
    expect(await world.store.activeComputerUseStops()).toEqual([]);
    await world.close();
  });

  it("withdraws a stopped attempt during a held Mac batch", async () => {
    const world = await createWorld(database, { phone: true });
    const run = await world.startRun("Held Mac batch");
    const target = { ownerUserId: world.owner.userId, runnerId: world.macId, runnerName: mac };
    const observed = await observeMacWindow(world, run.claims, apps.notes, "read-write");
    let resume!: () => void;
    world.fakeMac.actGate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const next = await world.computerUse.prepare(target, run.claims);
    const sent = await world.hub.withRunnerAdmission(world.macId, () =>
      world.computerUse.sendAct(
        next,
        { kind: "app", app: apps.notes, access: "read-write" },
        {
          actions: [{ type: "key", keys: "cmd+s" }],
          window: observed.observation.window.ref,
          snapshot: observed.observation.snapshot,
        },
        false,
      ),
    );
    await vi.waitFor(() => expect(world.fakeMac.actReceivedCount).toBe(1));
    expect(world.fakeMac.frames[0]).toMatchObject({
      app: apps.notes,
      access: "read-write",
      operation: "bind",
    });
    expect(world.fakeMac.frames[0]).not.toHaveProperty("definitionId");
    await world.store.enqueueRunnerControl({
      type: "run.interrupt",
      runId: run.runId,
      threadId: run.threadId,
      requestedBy: world.owner.userId,
      idempotencyKey: "stop-held-mac",
    });
    await vi.waitFor(() => expect(world.fakeMac.closeReceivedCount).toBe(1));
    resume();
    await expect(sent.settle()).rejects.toMatchObject({
      code: "outcome-unknown",
      retryable: false,
    });
    expect(world.fakeMac.completedActions).toBe(0);
    await world.close();
  });

  it.each(["revoked", "expired lease", "lost membership"] as const)(
    "never sends admitted phone work with %s authority",
    async (invalidation) => {
      const world = await createWorld(database, { phone: true });
      const { fakePhone, phoneId } = phoneOf(world);
      const holder = await world.startRun("Busy display holder");
      const holderLease = await world.computerUse.prepare(
        { ownerUserId: world.owner.userId, runnerId: phoneId, runnerName: phone },
        holder.claims,
      );
      await (
        await world.hub.withRunnerAdmission(phoneId, () =>
          world.computerUse.sendObserve(
            holderLease,
            { kind: "display", definitionId: "android-phone", access: "read" },
            false,
          ),
        )
      ).settle();
      const run = await world.startRun("Queued phone work");
      const target = { ownerUserId: world.owner.userId, runnerId: phoneId, runnerName: phone };
      const lease = await world.computerUse.prepare(target, run.claims);
      let resume!: () => void;
      let entered!: () => void;
      const enteredPromise = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const blocker = world.hub.withRunnerAdmission(phoneId, async () => {
        entered();
        await new Promise<void>((resolve) => {
          resume = resolve;
        });
      });
      await enteredPromise;
      const queued = world.hub.withRunnerAdmission(phoneId, () =>
        world.computerUse.sendObserve(
          lease,
          { kind: "display", definitionId: "android-phone", access: "read-write" },
          false,
        ),
      );
      if (invalidation === "revoked")
        await world.store.enqueueRunnerControl({
          type: "run.interrupt",
          runId: run.runId,
          threadId: run.threadId,
          requestedBy: world.owner.userId,
          idempotencyKey: "stop-queued",
        });
      if (invalidation === "expired lease")
        await database
          .updateTable("providerSessions")
          .set({ leaseExpiresAt: new Date(0) })
          .where("threadId", "=", run.threadId)
          .execute();
      if (invalidation === "lost membership") {
        const otherOwner = await world.store.createUser("Remaining owner");
        await database
          .insertInto("workspaceMemberships")
          .values({
            generation: 1,
            id: createId("workspaceMembership"),
            invitedBy: world.owner.userId,
            joinedAt: new Date(),
            revokedAt: null,
            revokedBy: null,
            role: "owner",
            state: "active",
            updatedAt: new Date(),
            userId: otherOwner,
            workspaceId: run.workspaceId,
          })
          .execute();
        await world.store.changeWorkspaceMembership({
          actorId: otherOwner,
          state: "revoked",
          targetUserId: world.owner.userId,
          workspaceId: run.workspaceId,
        });
      }
      world.computerUse.closeForConnection(phoneId, {
        kind: "display",
        definitionId: "android-phone",
      });
      resume();
      await blocker;
      await expect(queued).rejects.toMatchObject({ code: "failed" });
      expect(fakePhone.received("observe")).toBe(1);
      await world.close();
    },
  );

  it("preserves a replacement attempt and keeps owner Stop across generations", async () => {
    const world = await createWorld(database, { phone: true });
    const { fakePhone, phoneId } = phoneOf(world);
    const run = await world.startRun("Replacement phone attempt");
    const target = { ownerUserId: world.owner.userId, runnerId: phoneId, runnerName: phone };
    const scope = {
      kind: "display" as const,
      definitionId: "android-phone" as const,
      access: "read-write" as const,
    };
    const open = async (claims: typeof run.claims) => {
      const lease = await world.computerUse.prepare(target, claims);
      const sent = await world.hub.withRunnerAdmission(phoneId, () =>
        world.computerUse.sendObserve(lease, scope, false),
      );
      await sent.settle();
      return sent.sessionId;
    };
    const oldId = await open(run.claims);
    await database
      .updateTable("runs")
      .set({ status: "starting" })
      .where("id", "=", run.runId)
      .execute();
    await database
      .updateTable("providerSessions")
      .set({ leaseExpiresAt: new Date(0), status: "stopped" })
      .where("threadId", "=", run.threadId)
      .execute();
    await world.store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: {
        continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
        driverKind: HarnessIdSchema.parse("native"),
      },
      harnessInstanceId: world.owner.harnessInstanceId,
      leaseTokenHash: randomUUID(),
      membershipGeneration: 1,
      runnerBootId: "replacement-boot",
      runnerId: run.agentRunnerId,
      runId: run.runId,
      threadId: run.threadId,
    });
    const live = await world.store.runCapabilityScope(run.runId);
    if (!live) throw new Error("No replacement grant");
    const replacement = { ...run.claims, ...live };
    await fakePhone.reached("close");
    expect(fakePhone.received("close")).toBe(1);
    const newId = await open(replacement);
    expect(newId).not.toBe(oldId);
    world.computerUse.endGrantSessions([
      { runId: run.runId, bindingGeneration: run.claims.bindingGeneration },
    ]);
    await expect(world.computerUse.releaseSession(run.claims, phoneId)).rejects.toMatchObject({
      code: "failed",
    });
    expect(world.computerUse.sessionsForRunner(phoneId).map((s) => s.sessionId)).toEqual([newId]);
    await world.computerUse.stop(newId, world.owner.userId);
    world.computerUse.endGrantSessions([
      { runId: run.runId, bindingGeneration: replacement.bindingGeneration },
    ]);
    expect(await world.store.activeComputerUseStops()).toEqual([
      { runId: run.runId, runnerId: phoneId },
    ]);
    await expect(world.computerUse.prepare(target, replacement)).rejects.toMatchObject({
      code: "stopped-by-user",
    });
    const restarted = new ComputerUseService({
      hub: world.hub,
      authorizer: world.store,
      listMachines: async () => [],
      machineOwners: (ids) => world.store.effectiveMachineOwners(ids),
      onSessionsChanged: () => undefined,
      threadTitle: async () => "Replacement",
      stops: {
        initial: await world.store.activeComputerUseStops(),
        clear: (id) => world.store.clearComputerUseStops(id),
        record: (runId, runnerId) => world.store.recordComputerUseStop({ runId, runnerId }),
      },
    });
    await expect(restarted.prepare(target, replacement)).rejects.toMatchObject({
      code: "stopped-by-user",
    });
    await restarted.shutdown();
    world.computerUse.closeForRun(run.runId);
    await vi.waitFor(async () => expect(await world.store.activeComputerUseStops()).toEqual([]));
    await world.close();
  });

  /*
   * A phone keeps reporting its owner's Stop until the Host says it is
   * recorded. Failure modes:
   * - the Host acknowledges before the Stop is durable, or never does;
   * - a Stop for a Run that no longer exists (deleted with its Thread) fails
   *   the ledger's foreign key on every sweep, is retried forever and never
   *   acknowledged, so the phone reports it on every stream forever.
   */
  it("acknowledges a phone owner's Stop once recorded, and settles one whose Run no longer exists", async () => {
    const world = await createWorld(database, { phone: true });
    const { fakePhone, phoneId } = phoneOf(world);
    const run = await world.startRun("Stop me on the phone");
    const gateway = await world.gateway(run);
    await grantedPhone(world, gateway, "read");
    await phoneCode(gateway, "await p.observe()");

    const stopped = fakePhone.stopFromPhone();
    expect(stopped.runId).toBe(run.runId);
    await vi.waitFor(() => expect(fakePhone.stopsRecorded).toEqual([stopped]));
    expect(await world.store.activeComputerUseStops()).toEqual([
      { runId: run.runId, runnerId: phoneId },
    ]);
    // Reported again after a lost acknowledgement: recorded once, acknowledged again.
    fakePhone.reportStop(stopped);
    await vi.waitFor(() => expect(fakePhone.stopsRecorded).toEqual([stopped, stopped]));

    const record = vi.spyOn(world.store, "recordComputerUseStop");
    const gone = {
      runId: createId("run"),
      sessionId: ComputerUseSessionIdSchema.parse(`cus_${randomUUID()}`),
    };
    fakePhone.reportStop(gone);
    await vi.waitFor(() => expect(fakePhone.stopsRecorded).toContainEqual(gone));
    world.computerUse.sweep();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(record).toHaveBeenCalledTimes(1);
    const rows = await database
      .selectFrom("computerUseStops")
      .select("runId")
      .where("runId", "=", gone.runId)
      .execute();
    expect(rows).toEqual([]);
    record.mockRestore();
    await world.close();
  });

  it("lists packages while paused without taking the display, and reports an offline phone", async () => {
    const world = await createWorld(database, { phone: true });
    const { fakePhone, phoneId } = phoneOf(world);
    fakePhone.state = "unavailable";
    await fakePhone.attach();
    const run = await world.startRun("List phone apps");
    const gateway = await world.gateway(run);
    const result = json(
      await gateway.call("integration_search", { runnerId: phoneId, query: "Messages" }),
    );
    expect(result.apps).toEqual([
      { label: "Messages", packageName: "com.google.android.apps.messaging" },
    ]);
    expect(fakePhone.frames.at(-1)).toMatchObject({
      definitionId: "android-phone",
      operation: "installed_apps",
      app: null,
      access: null,
    });
    expect(world.computerUse.sessionsForRunner(phoneId)).toEqual([]);
    expect(world.computerUse.holders(phoneId).size).toBe(0);
    fakePhone.detach();
    expect(await gateway.call("integration_search", { runnerId: phoneId })).toEqual(
      refusal(`${phone} is offline.`),
    );
    await world.close();
  });

  it("shows phone update instructions for a mismatched descriptor in the machine list", async () => {
    const world = await createWorld(database, { phone: true });
    const { phoneId } = phoneOf(world);
    const row = await database
      .selectFrom("runners")
      .selectAll()
      .where("id", "=", phoneId)
      .executeTakeFirstOrThrow();
    const machines = projectMachines({
      access: new Map(),
      apps: new Map(),
      deploymentKind: "self-hosted",
      localWorkspaces: [],
      pendingRunners: [],
      threadsByEnvironment: new Map(),
      runners: [
        {
          deviceProfile: row.deviceProfile,
          allowedModules: row.allowedModules,
          connected: true,
          device: row.device,
          enrollmentId: "phone",
          id: row.id,
          kind: row.kind,
          lastSeenAt: null,
          modules: {
            integrations: { computerAppApprovals: true, platform: "android", protocolVersion: 1 },
          },
          name: phone,
          ownerKind: "user",
          ownerName: "Owner",
          readiness: new Map(),
          revokedAt: null,
          runtimeVersion: "old",
        },
      ],
    });
    expect(machines[0]?.modules.integrations?.detail).toBe(
      "This phone's Opensteer app is out of date. Plug the phone into a computer and add it again to update it.",
    );
    await world.close();
  });

  it("fetches the shared Mac and phone inventory once for discovery", async () => {
    const world = await createWorld(database, { phone: true });
    const run = await world.startRun("Discover computers");
    const gateway = await world.gateway(run);
    const inventory = vi.spyOn(world.computerUse, "eligibleInventory");
    const policy = vi.spyOn(world.persistence, "getComputerUsePolicy");
    await gateway.call("integration_search", { query: "Computer use" });
    expect(inventory).toHaveBeenCalledTimes(1);
    expect(policy).toHaveBeenCalledTimes(1);
    expect(policy).toHaveBeenCalledWith({ runnerId: world.macId, ownerUserId: world.owner.userId });
    inventory.mockClear();
    policy.mockClear();
    const invalidApp = await gateway.call("integration_request", {
      kind: "computer-app",
      runnerId: world.phoneId!,
      app: "Messages",
      access: "read",
      reason: "List messages",
    });
    expect(invalidApp.isError).toBe(true);
    expect(inventory).toHaveBeenCalledTimes(1);
    expect(policy).toHaveBeenCalledTimes(1);
    expect(policy).toHaveBeenCalledWith({ runnerId: world.macId, ownerUserId: world.owner.userId });
    inventory.mockClear();
    policy.mockClear();
    const invalidPhone = await gateway.call("integration_request", {
      kind: "computer-app",
      runnerId: world.macId,
      access: "read",
      reason: "See the screen",
    });
    expect(invalidPhone.isError).toBe(true);
    expect(inventory).toHaveBeenCalledTimes(1);
    expect(policy).toHaveBeenCalledTimes(1);
    expect(policy).toHaveBeenCalledWith({ runnerId: world.macId, ownerUserId: world.owner.userId });
    await world.close();
  });

  it.each([
    [
      "unavailable",
      "unavailable: tell the person it is not taking agent work (it may be paused)",
      "Pixel 8 is paused on the phone. The person can resume it there.",
    ],
    [
      "permission-required",
      "permission-required: ask the person to enable its Opensteer accessibility service in phone settings",
      "Pixel 8 needs its Opensteer accessibility service turned back on in the phone's settings.",
    ],
    [
      "offline",
      "state offline: wait for it to return",
      "Pixel 8 is offline. It will work again when it is back.",
    ],
  ] as const)(
    "shows %s phone readiness through the gateway",
    async (state, sentence, readiness) => {
      const world = await createWorld(database, { phone: true });
      const { fakePhone } = phoneOf(world);
      const run = await world.startRun("Readiness");
      const gateway = await world.gateway(run);
      await grantedPhone(world, gateway, "read");
      if (state === "offline") fakePhone.detach();
      else {
        fakePhone.state = state;
        await fakePhone.attach();
      }
      const result = json(await gateway.call("integration_search", { query: "Android phone" }));
      expect(result.guidance.phones).toContain(sentence);
      expect((await phoneRow(gateway)).phones[0]).toMatchObject({ state, callable: false });
      const entries = await world.platform.listDiscoveryInventory({
        ownerUserId: world.owner.userId,
        threadId: run.threadId,
        workspaceId: run.workspaceId,
      });
      const entry = entries.find(
        (entry) => entry.installation.provenance.definitionId === "android-phone",
      );
      expect(entry?.readiness.servers[0]).toMatchObject({
        code: "INTEGRATION_UNAVAILABLE",
        detail: readiness,
      });
      expect(
        entry?.readiness.tools.every(
          (tool) =>
            tool.readiness.code === "INTEGRATION_UNAVAILABLE" &&
            tool.readiness.detail === readiness,
        ),
      ).toBe(true);
      expect((await phoneRow(gateway)).phones[0]).not.toHaveProperty("toolRefs");
      expect(fakePhone.received("observe")).toBe(0);
      await world.close();
    },
  );

  it.each(["screen-off", "opensteer-app"] as const)(
    "renders a %s phone observation with no pixels or tree",
    async (mode) => {
      const world = await createWorld(database, { phone: true });
      const { fakePhone } = phoneOf(world);
      const run = await world.startRun("Hidden screen");
      const gateway = await world.gateway(run);
      await grantedPhone(world, gateway, "read");
      world.imageGate.on = true;
      fakePhone.hiddenScreen = mode;
      const result = await phoneCode(gateway, "await p.observe()");
      expect(result.content.map((block) => block.type)).toEqual(["text"]);
      expect(text(result).split("\n").slice(2)).toEqual(
        mode === "screen-off"
          ? [
              "Screen: off",
              "Locked: no",
              "Secure lock: no",
              "Foreground app: none",
              'The screen is off, so there is nothing to see. Act with {"type":"wake"} to turn it on.',
            ]
          : [
              "Screen: on",
              "Locked: no",
              "Secure lock: no",
              "Foreground app: Opensteer Agent Phone (com.opensteer.agentphone)",
              'The Opensteer Agent Phone app is in front. Agents may not see or operate it, so nothing of the screen is shared. Act with {"type":"navigate","to":"home"}, or launch another app, to continue.',
            ],
      );
      await world.close();
    },
  );

  it("reserves the phone before its first answer and refuses another task without sending", async () => {
    const world = await createWorld(database, { phone: true });
    const { fakePhone, phoneId } = phoneOf(world);
    const runA = await world.startRun("First display holder");
    const gatewayA = await world.gateway(runA);
    await grantedPhone(world, gatewayA, "read-write");
    // Begin the reservation probe after this task's persistent REPL is ready.
    expect(text(await gatewayA.call("computer", { code: "return 1" }))).toBe("1");
    let resume!: () => void;
    fakePhone.gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const pending = phoneCode(gatewayA, "await p.observe()");
    await fakePhone.reached("observe");
    expect(fakePhone.received("observe")).toBe(1);
    expect(world.computerUse.sessionsForRunner(phoneId)).toEqual([]);
    const runB = await world.startRun("Competing display holder");
    const gatewayB = await world.gateway(runB);
    const request = json(
      await gatewayB.call("integration_request", {
        kind: "computer-app",
        runnerId: phoneId,
        access: "read",
        reason: "Check the phone",
      }),
    );
    expect(request.status).toBe("already-available");
    const refused = await phoneCode(gatewayB, "await p.observe()");
    expect(refused).toEqual(
      refusal(
        `busy: ${phone} is already being used by another task. (Thread: First display holder) ${computerUseBusyNextStep}`,
      ),
    );
    expect(fakePhone.received("observe")).toBe(1);
    resume();
    expect((await pending).isError).toBeUndefined();
    await world.close();
  });

  it("asks for a phone, continues into computer code, reindexes, refuses stale input and a second task, releases and stops", async () => {
    const world = await createWorld(database, { phone: true });
    const { fakePhone, phoneId } = phoneOf(world);
    const runA = await world.startRun("Text the driver");
    const a = await world.gateway(runA);

    expect(mcp.instructions).toBeUndefined();

    // 1. Search: the phone, and the one way to ask for it.
    expect(await phoneRow(a)).toEqual({
      ...(await phoneRow(a)),
      phones: [
        {
          approval: "not-approved",
          callable: false,
          computerToolEnabled: true,
          name: phone,
          runnerId: phoneId,
          state: "ready",
        },
      ],
    });
    expect(json(await a.call("integration_search", { runnerId: phoneId }))).toMatchObject({
      apps: [{ label: "Messages", packageName: "com.google.android.apps.messaging" }],
      total: 1,
    });
    expect(
      await a.call("integration_request", {
        access: "read",
        app: "Messages",
        kind: "computer-app",
        reason: "Read the messages.",
        runnerId: phoneId,
      }),
    ).toEqual(
      refusal(
        `${phone} is an Android phone, which is asked for whole: call integration_request {kind: "computer-app", runnerId, access, reason} without app.`,
      ),
    );

    // 2. Ask for the whole phone: a durable Request, with no phone relay.
    const pending = json(
      await a.call("integration_request", {
        access: "read-write",
        kind: "computer-app",
        reason: "Text the driver the gate code.",
        runnerId: phoneId,
      }),
    );
    expect(pending).toMatchObject({
      kind: "computer.app.access",
      nextAction: `Approval is pending; the owner can allow or decline from any Opensteer app. Continue other work or end this turn; Opensteer continues this thread when it is resolved. Do not repeat the request.`,
      replayed: false,
      status: "pending",
    });
    const [setup] = await world.persistence.listComputerAppSetupRequests(world.owner.userId);
    expect(setup).toMatchObject({
      access: "read-write",
      app: null,
      definitionId: "android-phone",
      reason: "Text the driver the gate code.",
      threadTitle: "Text the driver",
    });
    expect(fakePhone.lists).toEqual([]);
    expect(
      (await world.connections.listConnections(world.owner.userId)).filter(
        ({ definitionId }) => definitionId === "android-phone",
      ),
    ).toEqual([]);
    expect((await phoneRow(a)).phones[0]).toMatchObject({
      approval: "pending",
    });

    // 3. The owner allows it from a client; the continuation names the phone() handle.
    await world.allowPhoneFromClient(setup!);
    const fulfilled = await world.requestById(pending.requestId);
    expect(fulfilled.status).toBe("fulfilled");
    const granted = (await phoneRow(a)).phones[0]!;
    expect(granted).toEqual({
      access: "read-write",
      approval: "approved",
      name: phone,
      callable: true,
      computerToolEnabled: true,
      runnerId: phoneId,
      state: "ready",
    });
    expect(granted).not.toHaveProperty("toolRefs");
    expect(await continuationMessage(fulfilled, inventorySource(world.platform))).toBe(
      `Request ${fulfilled.id} was fulfilled. ${phone} is ready. Use phone(${JSON.stringify(phone)}) in the computer tool. Release it when you are done so another task can use it. Continue.`,
    );

    const [row] = await world.platform.listCallableTools({
      ownerUserId: world.owner.userId,
      threadId: runA.threadId,
      workspaceId: runA.workspaceId,
    });
    if (!row) throw new Error("Missing callable authority row");
    expect(
      await a.call("integration_call", {
        toolRef: `${row.grant.id}.${row.tool.id}.${row.tool.schemaDigest}`,
      }),
    ).toEqual(refusal("Use the computer tool to see and operate apps and phones."));

    // 4. Observe: the header a client titles the step with, the phone's
    // state line by line, then the tree.
    const observed = await phoneCode(a, "await p.observe()");
    expect(observed.isError).toBeUndefined();
    const observedText = text(observed);
    expect(observedText).toBe(
      [
        `Looked at ${phone}`,
        `Observation phone-obs-1 of ${phone} — 2 elements. Screenshot 540×1200 px; all coordinates are screenshot pixels.`,
        phoneTree,
        "Screen: on",
        "Locked: no",
        "Secure lock: no",
        "Foreground app: Messages (com.google.android.apps.messaging)",
        "Screenshot unavailable in this engine.",
      ].join("\n"),
    );
    expect(readComputerUseResultHeadline(observedText)).toBe(`Looked at ${phone}`);
    world.imageGate.on = true;
    const pictured = await phoneCode(a, "await p.observe()");
    expect(pictured.content[1]).toEqual({
      _meta: { "codex/imageDetail": "original" },
      data: "/9j/phone2",
      mimeType: "image/jpeg",
      type: "image",
    });
    expect(fakePhone.frames.at(-1)).toMatchObject({
      access: "read-write",
      app: null,
      definitionId: "android-phone",
      operation: "observe",
      params: { includeScreenshot: true },
    });

    expect(world.computerUse.sessionsForRunner(phoneId)[0]).toMatchObject({ actingDisplay: false });
    const summary = world.computerUse.sessionsForRunner(phoneId)[0]!;
    const phonePart: ContentPart = {
      type: "phone",
      machineId: phoneId,
      display: "main",
      name: phone,
    };
    expect(summary.display).toBe(true);
    const livePlace = placeList({
      browserSessions: [],
      machines: [{ id: phoneId, name: phone, computerUse: { sessions: [summary] } }],
      browserProfiles: [],
      browserPlacements: [],
    } as unknown as Pick<
      HostSnapshot,
      "browserSessions" | "browserProfiles" | "browserPlacements" | "machines"
    >).find((place) => place.kind === "phone")!;
    if (livePlace.destination.kind !== "phone") throw new Error("Expected phone");
    phonePart.display = livePlace.destination.display!;
    if (process.env.OPENSTEER_SHARED_SURFACES_ARTIFACT_DIR) {
      await mkdir(process.env.OPENSTEER_SHARED_SURFACES_ARTIFACT_DIR, { recursive: true });
      await writeFile(
        path.join(
          process.env.OPENSTEER_SHARED_SURFACES_ARTIFACT_DIR,
          "phone-place-from-summary.json",
        ),
        JSON.stringify({ summary, place: livePlace, part: phonePart }, null, 2),
      );
    }
    await new PlaceContextService({
      browser: { assertPagesUsable: async () => undefined },
      computerUse: world.computerUse,
      connections: world.connections,
      integrations: world.platform,
      store: new OpensteerStore(database),
    }).assertUsable({
      ownerId: world.owner.userId,
      threadId: runA.threadId,
      workspaceId: runA.workspaceId,
      parts: [phonePart],
    });

    // 5. Act on the latest observation; a stale one runs nothing.
    const acted = await phoneCode(a, 'await p.act([{type:"wake"},{target:{index:1},type:"tap"}])');
    expect(acted.isError).toBeUndefined();
    expect(world.computerUse.sessionsForRunner(phoneId)[0]).toMatchObject({ actingDisplay: true });
    expect(acted.content.map((block) => block.type)).toEqual(["text", "text", "text", "image"]);
    expect(text(acted).split("\n").slice(0, 4)).toEqual([
      "Woke the screen",
      "Tapped element 1",
      `Looked at ${phone}`,
      `Observation phone-obs-3 of ${phone} — 2 elements. Screenshot 540×1200 px; all coordinates are screenshot pixels.`,
    ]);
    expect(
      fakePhone.frames.filter((frame) => frame.operation === "act").at(-1)?.params.observationId,
    ).toBe("phone-obs-2");
    const actsBefore = fakePhone.received("act");
    fakePhone.invalidateObservation();
    expect(await phoneCode(a, "await p.wake()")).toEqual(
      refusal(
        "stale-observation: That observation is no longer the latest one on this phone; observe again.",
      ),
    );
    expect((await phoneCode(a, "await p.observe()")).isError).toBeUndefined();
    const macAction = await phoneCode(a, 'await p.act([{target:{index:1},type:"click"}])');
    expect(macAction.isError).toBe(true);
    expect(fakePhone.received("act")).toBe(actsBefore + 1);

    // 6. A second task finds the phone held, by Thread, and nothing it does reaches it.
    const runB = await world.startRun("Order lunch");
    const b = await world.gateway(runB);
    await (async () => {
      const asked = json(
        await b.call("integration_request", {
          access: "read",
          kind: "computer-app",
          reason: "Check the lunch order.",
          runnerId: phoneId,
        }),
      );
      // The phone already covers this Workspace's ask, so it comes straight back.
      expect(asked).toMatchObject({ status: "already-available" });
      expect(asked).not.toHaveProperty("toolRefs");
    })();
    expect((await phoneRow(b)).phones[0]).toMatchObject({
      inUse: true,
      callable: false,
      heldByThread: "Text the driver",
    });
    const framesBefore = fakePhone.frames.length;
    expect(await phoneCode(b, "await p.observe()")).toEqual(
      refusal(
        `busy: ${phone} is already being used by another task. (Thread: Text the driver) ${computerUseBusyNextStep}`,
      ),
    );
    expect(fakePhone.frames).toHaveLength(framesBefore);

    // 7. Release twice: the first closes the session, the second is idempotent.
    expect(json(await phoneCode(a, "return await p.release()"))).toEqual({ released: true });
    expect(json(await phoneCode(a, "return await p.release()"))).toEqual({ released: false });
    expect(text(await phoneCode(b, "await p.observe()"))).toContain(`Looked at ${phone}`);
    expect(fakePhone.frames.slice(framesBefore).map((frame) => frame.operation)).toEqual([
      "close",
      "observe",
    ]);

    // 8. The person stops it on the phone: that task cannot use it again.
    fakePhone.stopFromPhone();
    await vi.waitFor(() => expect(world.computerUse.sessionsForRunner(phoneId)).toEqual([]));
    expect(await phoneCode(b, "await p.observe()")).toEqual(
      refusal(`stopped-by-user: Computer use was stopped for this task on ${phone}.`),
    );
    await world.close();
  });

  it("ends the hold when the Run ends, when its owner stops it from anywhere, and after three idle minutes while a Mac keeps ten", async () => {
    let now = Date.now();
    const world = await createWorld(database, { now: () => now, phone: true });
    const { fakePhone, phoneId } = phoneOf(world);
    const run = await world.startRun("Text the driver");
    const gateway = await world.gateway(run);
    await grantedPhone(world, gateway, "read-write");
    const observeOnce = async () => {
      expect(text(await phoneCode(gateway, "await p.observe()"))).toContain(`Looked at ${phone}`);
      expect(world.computerUse.sessionsForRunner(phoneId)).toEqual([
        expect.objectContaining({ apps: [], display: true, runId: run.runId }),
      ]);
    };

    await observeOnce();
    await observeMacWindow(world, run.claims);
    now += 2 * 60 * 1_000;
    world.computerUse.sweepIdle();
    expect(world.computerUse.sessionsForRunner(phoneId)).toHaveLength(1);
    now += 90 * 1_000;
    world.computerUse.sweepIdle();
    await fakePhone.reached("close");
    expect(fakePhone.received("close")).toBe(1);
    expect(world.computerUse.sessionsForRunner(phoneId)).toEqual([]);
    expect(world.computerUse.sessionsForRunner(world.macId)).toHaveLength(1);
    now += 7 * 60 * 1_000;
    world.computerUse.sweepIdle();
    await vi.waitFor(() => expect(world.fakeMac.closeReceivedCount).toBe(1));
    expect(world.computerUse.sessionsForRunner(world.macId)).toEqual([]);

    // Idle expiry is verified; subsequent calls use the REPL's current clock.
    now = Date.now();
    await observeOnce();
    world.computerUse.closeForRun(run.runId);
    await fakePhone.reached("close", 2);
    expect(fakePhone.received("close")).toBe(2);
    expect(world.computerUse.sessionsForRunner(phoneId)).toEqual([]);

    const second = await world.startRun("Order lunch");
    const other = await world.gateway(second);
    await (async () => {
      const asked = json(
        await other.call("integration_request", {
          access: "read",
          kind: "computer-app",
          reason: "Check the lunch order.",
          runnerId: phoneId,
        }),
      );
      expect(asked).not.toHaveProperty("toolRefs");
    })();
    await phoneCode(other, "await p.observe()");
    const [session] = world.computerUse.sessionsForRunner(phoneId);
    await world.platform.computerAppApprovals.stopComputerUseSession({
      actorUserId: world.owner.userId,
      sessionId: session!.sessionId,
    });
    await fakePhone.reached("close", 3);
    expect(fakePhone.received("close")).toBe(3);
    expect(await phoneCode(other, "await p.observe()")).toEqual(
      refusal(`stopped-by-user: Computer use was stopped for this task on ${phone}.`),
    );
    await world.close();
  });

  it.each([
    "revoking the grant",
    "lowering the access",
    "turning the phone off",
    "uninstalling",
  ] as const)("ends the live session on %s", async (change) => {
    const world = await createWorld(database, { phone: true });
    const { fakePhone, phoneId } = phoneOf(world);
    const run = await world.startRun("Text the driver");
    const gateway = await world.gateway(run);
    await grantedPhone(world, gateway, "read-write");
    await phoneCode(gateway, "await p.observe()");
    expect(world.computerUse.sessionsForRunner(phoneId)).toHaveLength(1);
    const connection = await world.phoneConnection();

    switch (change) {
      case "revoking the grant": {
        const grant = (
          await world.persistence.listGrants({
            ownerUserId: world.owner.userId,
            workspaceId: run.workspaceId,
          })
        ).find(({ connectionId }) => connectionId === connection.id);
        await world.platform.revokeGrant({
          grantId: grant!.id,
          ownerUserId: world.owner.userId,
          requestId: "revoke-phone-grant",
          workspaceId: run.workspaceId,
        });
        break;
      }
      case "lowering the access":
        await world.platform.computerAppApprovals.setComputerConnection({
          access: "read",
          actorUserId: world.owner.userId,
          app: null,
          definitionId: "android-phone",
          isAdministrator: true,
          kind: "app",
          requestId: "lower-phone",
          runnerId: phoneId,
        });
        break;
      case "turning the phone off":
        await world.platform.computerAppApprovals.disconnectComputerConnection({
          connectionId: connection.id,
          ownerUserId: world.owner.userId,
          requestId: "phone-off",
        });
        break;
      case "uninstalling": {
        const installation = (await world.persistence.listInstallations()).find(
          ({ provenance }) => provenance.definitionId === "android-phone",
        );
        await world.platform.uninstallIntegration({
          actorUserId: world.owner.userId,
          installationId: installation!.id,
          requestId: "uninstall-phone",
        });
        break;
      }
    }

    expect(world.computerUse.sessionsForRunner(phoneId)).toEqual([]);
    await fakePhone.reached("close");
    expect(fakePhone.received("close")).toBe(1);
    await world.close();
  });

  it("refuses an act once the phone may only be looked at, and still lets the task let go", async () => {
    const world = await createWorld(database, { phone: true });
    const { fakePhone, phoneId } = phoneOf(world);
    const run = await world.startRun("Text the driver");
    const gateway = await world.gateway(run);
    await grantedPhone(world, gateway, "read-write");
    const actRow = (
      await world.platform.listCallableTools({
        ownerUserId: world.owner.userId,
        workspaceId: run.workspaceId,
        threadId: run.threadId,
      })
    ).find((row) => row.tool.name === "act");
    if (!actRow) throw new Error("Missing internal act authority");
    const retiredActRef = `${actRow.grant.id}.${actRow.tool.id}.${actRow.tool.schemaDigest}`;
    await world.platform.computerAppApprovals.setComputerConnection({
      access: "read",
      actorUserId: world.owner.userId,
      app: null,
      definitionId: "android-phone",
      isAdministrator: true,
      kind: "app",
      requestId: "lower-phone",
      runnerId: phoneId,
    });

    const lowered = (await phoneRow(gateway)).phones[0]!;
    expect(lowered).toMatchObject({ access: "read", approval: "approved" });
    expect(lowered).not.toHaveProperty("toolRefs");
    expect(text(await phoneCode(gateway, "await p.observe()"))).toContain(`Looked at ${phone}`);
    expect(await phoneCode(gateway, 'await p.act([{ type: "wake" }])')).toEqual(
      refusal(
        `failed: ${phone} allows seeing only. Ask for read-write access to act: call integration_request {kind: "computer-app", runnerId, access, reason} with access "read-write"; do not retry this call until it is fulfilled.`,
      ),
    );
    expect(
      await gateway.call("integration_call", {
        toolRef: retiredActRef,
        arguments: { observationId: "retired", actions: [{ type: "wake" }] },
      }),
    ).toEqual(refusal("Use the computer tool to see and operate apps and phones."));
    expect(fakePhone.received("act")).toBe(0);
    expect(json(await phoneCode(gateway, "return await p.release()"))).toEqual({ released: true });
    await world.close();
  });

  it("reports an act the phone's stream dropped as unknown, an observe as a failure to try again, and an offline phone as offline", async () => {
    const world = await createWorld(database, { phone: true });
    const { fakePhone } = phoneOf(world);
    const run = await world.startRun("Text the driver");
    const gateway = await world.gateway(run);
    await grantedPhone(world, gateway, "read-write");
    await phoneCode(gateway, "await p.observe()");

    let release!: () => void;
    fakePhone.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acting = phoneCode(gateway, 'await p.act([{ target: { index: 1 }, type: "tap" }])');
    await fakePhone.reached("act");
    expect(fakePhone.received("act")).toBe(1);
    fakePhone.detach();
    expect(await acting).toEqual(
      refusal(
        "outcome-unknown: That computer went offline. The actions may already have taken effect. Do not repeat them. Observe the phone before deciding the next action.",
      ),
    );
    release();
    fakePhone.gate = null;

    expect(await phoneCode(gateway, "await p.observe()")).toEqual(
      refusal(`offline: ${phone} is offline. It will work again when it is back.`),
    );

    await fakePhone.attach();
    fakePhone.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observing = phoneCode(gateway, "await p.observe()");
    await fakePhone.reached("observe", 2);
    expect(fakePhone.received("observe")).toBe(2);
    fakePhone.detach();
    expect(await observing).toEqual(refusal("failed: That computer went offline."));
    release();
    fakePhone.gate = null;
    await fakePhone.attach();
    expect(text(await phoneCode(gateway, "await p.observe()"))).toContain(`Looked at ${phone}`);
    await world.close();
  });

  it("never asks somebody else's phone, an unknown one, a Mac without its app, or an offline phone", async () => {
    const world = await createWorld(database, { phone: true });
    const { fakePhone, phoneId } = phoneOf(world);
    const strangers = await world.addStrangersPhone("Someone else's Pixel");
    const gateway = await world.gateway(await world.startRun("Text the driver"));
    const ask = (runnerId: string) =>
      gateway.call("integration_request", {
        access: "read",
        kind: "computer-app",
        reason: "Look at it.",
        runnerId,
      });
    const unknown = (runnerId: string) =>
      `No Android phone set up for agents has runnerId ${runnerId}. Search "Android phone" with integration_search to list your phones and their runnerIds.`;

    expect(await ask(strangers)).toEqual(refusal(unknown(strangers)));
    const nobody = createId("runner");
    expect(await ask(nobody)).toEqual(refusal(unknown(nobody)));
    expect(await ask(world.macId)).toEqual(
      refusal(
        `${mac} is a Mac, whose apps are asked for one at a time: call integration_request {kind: "computer-app", runnerId, app, access, reason}.`,
      ),
    );
    fakePhone.detach();
    expect(await ask(phoneId)).toEqual(refusal(`${phone} is offline.`));
    expect(await world.persistence.listComputerAppSetupRequests(world.owner.userId)).toEqual([]);
    await world.close();
  });

  it("refuses phone key nomination and Runner-originated signed answers without mutating access", async () => {
    const world = await createWorld(database, { phone: true });
    const { fakePhone, phoneId } = phoneOf(world);
    const gateway = await world.gateway(await world.startRun("Text the driver"));
    const asked = json(
      await gateway.call("integration_request", {
        access: "read",
        kind: "computer-app",
        reason: "Read the delivery text.",
        runnerId: phoneId,
      }),
    );
    const [setup] = await world.persistence.listComputerAppSetupRequests(world.owner.userId);
    const keys = generateKeyPairSync("ed25519");
    await expect(
      world.platform.computerAppApprovals.registerComputerUseApprovalKey({
        ownerUserId: world.owner.userId,
        publicKey: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
        requestId: "register-phone-key",
        runnerId: phoneId,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const answer = {
      kind: "allow" as const,
      approval: createComputerAppApproval(keys.privateKey, setup!),
    };
    // Both the authenticated stream and the shared handler refuse phone answers.
    await world.hub.handleMessage(fakePhone.peer, fakePhone.stream, {
      ...fakePhone.stream.fence,
      answer,
      module: "integrations",
      setupRequestId: setup!.id,
      type: "runner.integrations.computer-app-approval-answer",
    });
    await world.platform.computerAppApprovals.answerComputerAppApproval(phoneId, {
      answer,
      setupRequestId: setup!.id,
    });
    expect((await world.requestById(asked.requestId)).status).toBe("pending");
    expect(
      (await world.connections.listConnections(world.owner.userId)).filter(
        ({ definitionId }) => definitionId === "android-phone",
      ),
    ).toEqual([]);
    expect(fakePhone.lists).toEqual([]);
    await world.allowPhoneFromClient(setup!);
    expect((await world.requestById(asked.requestId)).status).toBe("fulfilled");
    await world.close();
  });

  it("lets the owner turn phone access on, widen and lower it from any client, while automatic approval stays Mac-only", async () => {
    const world = await createWorld(database, { phone: true });
    const { fakePhone, phoneId } = phoneOf(world);
    const set = (access: "read" | "read-write") =>
      world.platform.computerAppApprovals.setComputerConnection({
        access,
        actorUserId: world.owner.userId,
        app: null,
        definitionId: "android-phone",
        isAdministrator: true,
        kind: "app",
        requestId: `owner-phone-${access}`,
        runnerId: phoneId,
      });
    await set("read");
    expect(await world.phoneConnection()).toMatchObject({
      computer: { access: "read", app: null, runnerId: phoneId },
    });
    await set("read-write");
    expect(await world.phoneConnection()).toMatchObject({ computer: { access: "read-write" } });
    await set("read");
    expect(await world.phoneConnection()).toMatchObject({ computer: { access: "read" } });
    expect(fakePhone.lists).toEqual([]);
    await expect(
      world.platform.computerAppApprovals.requestComputerAppSetup({
        actorUserId: world.owner.userId,
        appApproval: "automatic",
        kind: "policy",
        runnerId: phoneId,
      }),
    ).rejects.toThrow(
      "Automatic approval is only for apps on a Mac. The owner allows phone access from any Opensteer app.",
    );
    await world.close();
  });
});

const tree = '[0] window "Groceries" (0,0 1200×900)\n  [1] button "New Note" (20,10 80×40)';

/** What the continuation outbox reads, served by the platform under test. */
function inventorySource(platform: IntegrationPlatformService): IntegrationInventorySource {
  return {
    computerUseMachines: (ownerUserId) =>
      platform.computerAppApprovals.computerUseMachines(ownerUserId),
    computerUsePhones: (ownerUserId) =>
      platform.computerAppApprovals.computerUsePhones(ownerUserId),
    listCallableTools: (input) => platform.listCallableTools(input),
    listDiscoveryInventory: (input) => platform.listDiscoveryInventory(input),
  };
}

function refusal(message: string) {
  return { content: [{ type: "text", text: message }], isError: true };
}

interface CatalogRow {
  readonly computers: readonly {
    readonly appApproval: string;
    readonly apps: readonly {
      readonly name: string;
      readonly status: string;
      readonly callable: boolean;
    }[];
  }[];
  readonly definitionId: string;
}

function macRow(search: { readonly catalog: readonly CatalogRow[] }): CatalogRow {
  const row = search.catalog.find(({ definitionId }) => definitionId === "macos-app");
  if (!row) throw new Error("The catalog has no Computer use entry");
  return row;
}

/** The JSON a model reads from a successful result's text block. */
function json(result: ToolResult) {
  const value = JSON.parse(text(result));
  if (
    value.computer ||
    value.catalog?.some((row: { computers?: readonly unknown[] }) => row.computers?.length)
  ) {
    for (const rule of [
      'integration_request {kind: "computer-app", runnerId, app, access, reason}',
      "blocked: only the person can unblock it on that Mac",
      "pending:mac waits on that Mac",
      "pending:workspace waits on a Workspace grant",
      "Do not repeat pending requests",
      "Opensteer continues this thread when resolved",
      "do not retry in a loop",
      "permission-required",
      "appApproval:automatic",
    ])
      expect(value.guidance.computers).toContain(rule);
  }
  if (value.catalog?.some((row: { phones?: readonly unknown[] }) => row.phones?.length)) {
    for (const rule of [
      'integration_request {kind: "computer-app", runnerId, access, reason}',
      "owner approves from any Opensteer app",
      "approval:pending",
      "do not repeat the request",
      "do not retry in a loop",
      "permission-required",
      "release when done",
      "request read-write",
    ])
      expect(value.guidance.phones).toContain(rule);
  }
  return value;
}

function text(result: ToolResult): string {
  if (result.isError) throw new Error(`Unexpected tool error: ${JSON.stringify(result)}`);
  const blocks = result.content.filter(
    (block): block is Extract<ToolResult["content"][number], { type: "text" }> =>
      block.type === "text",
  );
  if (!blocks.length) throw new Error(`Expected text: ${JSON.stringify(result)}`);
  return blocks.map((block) => block.text).join("\n");
}

/** One Mac as the helper answers through the Runner, with just enough of its rules. */
class FakeMac {
  readonly #outcomes = new Map<string, (outcome: ComputerAppApprovalOutcome) => void>();
  /** Every approval list the Host sent this Mac, in order. */
  readonly lists: ComputerAppApprovalList[] = [];
  /** Each approval this Mac was ever told about, in the order it first appeared. */
  readonly reviews: string[] = [];
  readonly frames: HostIntegrationsComputerUse[] = [];
  readonly peer: ComputerAppControlPeer;
  readonly stream: RunnerAuxiliaryStream;
  readonly #hub: ComputerAppHub;
  readonly #installed: readonly ComputerAppIdentity[] = [
    apps.notes,
    apps.calendar,
    apps.textEdit,
    apps.onePassword,
  ];
  readonly #sessions = new Map<string, Map<string, string>>();
  readonly #owners = new Map<string, string>();
  #observations = 0;
  readonly ownerFrames: HostIntegrationsComputerView[] = [];
  readonly captureStarts: number[] = [];
  readonly ownerTargets = new Map<string, number>();
  captureReceivedCount = 0;
  captureCount = 0;
  ownerRenewGate: Promise<void> | null = null;
  captureGate: Promise<void> | null = null;
  actReceivedCount = 0;
  completedActions = 0;
  actGate: Promise<void> | null = null;
  partialActGate: Promise<void> | null = null;
  partialReceipt = "Clicked element 1";
  actFailure: { code: ComputerUseErrorCode; message: string; performed: string[] } | null = null;
  windowGroupsSupported = true;
  closeReceivedCount = 0;
  closeGate: Promise<void> | null = null;
  closeFailureCode: ComputerUseErrorCode | null = null;

  ownerNative: ((frame: HostIntegrationsComputerView) => Promise<ComputerViewNativeResult>) | null =
    null;
  ownerCaptureReason: "window-unreadable" | "accessibility-error" | "capture-failed" | null = null;
  ownerRenewFailure: "unavailable" | "ended" | "stale-generation" | null = null;
  constructor(hub: ComputerAppHub, runnerId: RunnerId, macWindowVideo = true, ownerViews = false) {
    this.#hub = hub;
    const auxiliaryStreamId = RunnerAuxiliaryStreamIdSchema.parse(`rax_${randomUUID()}`);
    const fence: RunnerAuxiliaryFrameFence = {
      auxiliaryStreamId,
      bootId: RunnerBootIdSchema.parse(`rbt_${randomUUID()}`),
      connectionGeneration: 1,
      connectionId: RunnerConnectionIdSchema.parse(`rcn_${randomUUID()}`),
      connectionLeaseId: RunnerConnectionLeaseIdSchema.parse(`rls_${randomUUID()}`),
      module: "integrations",
      runnerId,
    };
    this.stream = {
      auxiliaryStreamId,
      fence,
      // A desktop supervises this Runner, so it relays approvals.
      identity: {
        modules: {
          integrations: {
            computerAppApprovals: true,
            ...(ownerViews ? { ownerViewVersion: 3 } : {}),
            computerUseVersion: 2,
            ...(macWindowVideo ? { macWindowVideoVersion: 1 } : {}),
            platform: "darwin",
            protocolVersion: 5,
          },
        },
        name: mac,
        runnerId,
      } as RunnerAuxiliaryStream["identity"],
      streamLeaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    this.peer = {
      close: () => undefined,
      id: `peer:${randomUUID()}`,
      send: async (message) => {
        setImmediate(() => void this.#answer(message));
      },
    };
  }

  async attach(): Promise<void> {
    this.#hub.attach(this.peer, this.stream);
    await this.#hub.handleMessage(this.peer, this.stream, {
      ...this.stream.fence,
      apps: [
        {
          definitionId: "macos-app",
          operations: [
            { operation: "observe", state: "ready", detail: null, remedy: null },
            { operation: "act", state: "ready", detail: null, remedy: null },
          ],
        },
      ],
      captureSupported: true,
      ...(this.stream.identity.modules.integrations?.ownerViewVersion === 3
        ? { ownerViewVersion: 3 }
        : {}),
      module: "integrations",
      type: "runner.integrations.status",
    });
  }

  detach(): void {
    this.#hub.detach(this.peer, "transport-disconnected");
  }

  /** The approvals the Host last said wait on this Mac. */
  waiting(): readonly string[] {
    return this.lists.at(-1)?.approvals.map(({ request }) => request.id) ?? [];
  }

  /** The person's answer on this Mac, carried on its own stream; resolves with the Host's outcome. */
  async answer(
    setupRequestId: string,
    answer: ComputerAppApprovalAnswer,
  ): Promise<ComputerAppApprovalOutcome> {
    const outcome = new Promise<ComputerAppApprovalOutcome>((resolve) =>
      this.#outcomes.set(setupRequestId, resolve),
    );
    await this.#hub.handleMessage(this.peer, this.stream, {
      ...this.stream.fence,
      answer,
      module: "integrations",
      setupRequestId,
      type: "runner.integrations.computer-app-approval-answer",
    });
    return outcome;
  }

  invalidateSnapshots(): void {
    for (const session of this.#sessions.values())
      for (const [ref] of session)
        if (!ref.startsWith("current:")) session.set(ref, "external-change");
  }

  openSessions(): string[] {
    return [...this.#sessions.keys()];
  }

  /** The pill's Stop: every session closes and each is reported. */
  stopFromPill(): void {
    for (const sessionId of this.#sessions.keys()) {
      void this.#hub.handleMessage(this.peer, this.stream, {
        ...this.stream.fence,
        event: {
          event: "session.stopped",
          params: { reason: "user", sessionId: sessionId as never },
        },
        module: "integrations",
        type: "runner.integrations.computer-use-event",
      });
    }
    this.#sessions.clear();
    this.#owners.clear();
  }

  async #answer(message: HostIntegrationsOperation): Promise<void> {
    if (message.type === "host.integrations.computer-app-approvals") {
      this.lists.push({ approvalKeyId: message.approvalKeyId, approvals: message.approvals });
      for (const { request } of message.approvals) {
        if (!this.reviews.includes(request.id)) this.reviews.push(request.id);
      }
      return;
    }
    if (message.type === "host.integrations.computer-app-approval-outcome") {
      this.#outcomes.get(message.setupRequestId)?.(message.outcome);
      this.#outcomes.delete(message.setupRequestId);
      return;
    }
    if (message.type === "host.integrations.computer-app-windows") {
      await this.#hub.handleMessage(this.peer, this.stream, {
        ...this.stream.fence,
        type: "runner.integrations.computer-app-windows-result",
        module: "integrations",
        requestId: message.requestId,
        result: {
          kind: "ok",
          value: {
            windows: [
              {
                id: 7,
                title: "Groceries",
                focused: true,
                main: true,
                minimized: false,
                onScreen: true,
              },
            ],
          },
        },
      });
      return;
    }
    if (message.type === "host.integrations.computer-view") {
      this.ownerFrames.push(message);
      if (this.ownerNative) {
        let result:
          | { kind: "ok"; value: ComputerViewNativeResult }
          | { kind: "error"; code: "unavailable"; message: string };
        try {
          result = { kind: "ok" as const, value: await this.ownerNative(message) };
        } catch (error) {
          result = { kind: "error" as const, code: "unavailable" as const, message: String(error) };
        }
        if (!this.#hub.attached(this.stream.identity.runnerId)) return;
        await this.#hub.handleMessage(this.peer, this.stream, {
          ...this.stream.fence,
          type: "runner.integrations.computer-view-result",
          module: "integrations",
          requestId: message.requestId,
          result,
        });
        return;
      }
      if (message.operation === "renew") await this.ownerRenewGate;
      if (message.operation === "renew" && this.ownerRenewFailure) {
        await this.#hub.handleMessage(this.peer, this.stream, {
          ...this.stream.fence,
          type: "runner.integrations.computer-view-result",
          module: "integrations",
          requestId: message.requestId,
          result: {
            kind: "error",
            code: this.ownerRenewFailure,
            message: "Injected native renewal failure",
          },
        });
        return;
      }

      if (message.operation === "open") this.ownerTargets.set(message.viewId, message.generation);
      if (
        message.operation === "close" &&
        this.ownerTargets.get(message.viewId) === message.generation
      )
        this.ownerTargets.delete(message.viewId);
      const ref = { viewId: message.viewId, generation: message.generation };
      const value = {
        ...ref,
        state: message.operation === "close" ? ("closed" as const) : ("ready" as const),
        captureTargetId:
          message.operation === "close" ? null : `window:${message.viewId}:${message.generation}`,
      };
      if (!this.#hub.attached(this.stream.identity.runnerId)) return;
      await this.#hub.handleMessage(this.peer, this.stream, {
        ...this.stream.fence,
        type: "runner.integrations.computer-view-result",
        module: "integrations",
        requestId: message.requestId,
        result: { kind: "ok", value },
      });
      return;
    }
    if (message.type !== "host.integrations.computer-use") return;
    this.frames.push(message);
    let result:
      | { readonly kind: "ok"; readonly value: unknown }
      | { readonly kind: "error"; readonly code: ComputerUseErrorCode; readonly message: string };
    try {
      if (message.operation === "close") {
        this.closeReceivedCount += 1;
        await this.closeGate;
        if (this.closeFailureCode)
          throw new MacError(this.closeFailureCode, "The Mac did not confirm Stop.");
      }
      if (message.operation === "act" && this.partialActGate) {
        this.actReceivedCount++;
        this.completedActions++;
        await this.partialActGate;
        result = {
          kind: "ok",
          value: {
            performed: [this.partialReceipt],
            error: { code: "no-session", message: "The second action stopped." },
          },
        };
      } else {
        if (message.operation === "act") {
          this.actReceivedCount += 1;
          await this.actGate;
          if (!this.#sessions.has(message.sessionId))
            throw new MacError("no-session", "The session ended before the batch ran.");
          this.completedActions += (message.params.actions as unknown[]).length;
        }
        result = { kind: "ok", value: this.#perform(message) };
      }
    } catch (error) {
      if (!(error instanceof MacError)) throw error;
      result = { kind: "error", code: error.code, message: error.message };
    }
    if (!this.#hub.attached(this.stream.identity.runnerId)) return;
    await this.#hub.handleMessage(this.peer, this.stream, {
      ...this.stream.fence,
      module: "integrations",
      requestId: message.requestId,
      result: result as never,
      type: "runner.integrations.computer-use-result",
    });
  }

  #perform(frame: HostIntegrationsComputerUse): unknown {
    const params = frame.params as Record<string, unknown>;
    switch (frame.operation) {
      case "installed_apps": {
        const query = String(params.query ?? "").toLowerCase();
        const matching = this.#installed.filter(
          (app) =>
            app.displayName.toLowerCase().includes(query) ||
            app.bundleId.toLowerCase().includes(query),
        );
        const offset = Number(params.offset ?? 0);
        const limit = Number(params.limit ?? 50);
        return {
          apps: matching
            .slice(offset, offset + limit)
            .map((identity) => ({ identity, running: false })),
          total: matching.length,
        };
      }
      case "resolve_app": {
        const wanted = String(params.app).toLowerCase();
        const identity = this.#installed.find(
          (app) =>
            app.displayName.toLowerCase() === wanted || app.bundleId.toLowerCase() === wanted,
        );
        if (!identity)
          throw new MacError("app-not-found", `No app on this Mac is called "${params.app}".`);
        const denied = identity === apps.onePassword;
        return {
          app: {
            allowed: !denied,
            identity,
            path: `/Applications/${identity.displayName}.app`,
            reason: denied ? "Opensteer does not operate password managers." : null,
            risk: denied ? "elevated" : "standard",
            running: false,
          },
        };
      }
      case "close":
        this.#release(frame.sessionId);
        return {};
      case "windows":
      case "bind":
      case "observe":
      case "act": {
        if (!this.windowGroupsSupported)
          throw new MacError("unsupported", "This version of macOS cannot identify window groups.");
        const app = frame.app!;
        const key = app.bundleId.toLowerCase();
        const owner = this.#owners.get(key);
        if (owner && owner !== frame.sessionId)
          throw new MacError("busy", "This app is already being used by another task.");
        const session = this.#sessions.get(frame.sessionId) ?? new Map<string, string>();
        this.#sessions.set(frame.sessionId, session);
        this.#owners.set(key, frame.sessionId);
        const current = Number(session.get(`current:${key}`) ?? 7);
        const windows = [7, 8].map((id) => ({
          ref: `${frame.sessionId}:${key}:${id}`,
          id,
          title: id === 7 ? "Groceries" : "Work",
          focused: id === 7,
          main: id === 7,
          minimized: false,
          onScreen: true,
          modal: false,
          current: id === current,
          frame: { x: 0, y: 0, width: 800, height: 600 },
        }));
        if (frame.operation === "windows") return { windows };
        if (frame.operation === "bind") {
          const window = windows.find((window) => window.id === (params.window ?? current));
          if (!window) throw new MacError("stale-observation", "That window is closed.");
          session.set(`current:${key}`, String(window.id));
          return { window: { ...window, current: true } };
        }
        const window = windows.find((window) => window.ref === params.window);
        if (!window) throw new MacError("stale-observation", "That window is closed.");
        if (frame.operation === "act") {
          if (params.snapshot === null)
            throw new MacError("stale-observation", "Observe this window first.");
          if (params.snapshot !== session.get(window.ref))
            throw new MacError("stale-observation", "Observe this window again.");
          session.set(`current:${key}`, String(window.id));
          if (this.actFailure)
            return {
              performed: this.actFailure.performed,
              error: { code: this.actFailure.code, message: this.actFailure.message },
            };
          return { error: null, performed: (params.actions as unknown[]).map(describeFakeAction) };
        }
        if (typeof params.includeScreenshot !== "boolean")
          throw new MacError("failed", "The Host must choose whether to capture a screenshot.");
        this.#observations++;
        const snapshot = `obs-${this.#observations}`;
        session.set(window.ref, snapshot);
        return {
          observation: {
            app,
            capturedAt: new Date().toISOString(),
            elementCount: 2,
            focusChanged: false,
            geometry: { width: 1200, height: 900 },
            snapshot,
            windows,
            blockedBy: [],
            alone: false,
            screenshot: params.includeScreenshot
              ? {
                  base64: Buffer.from(`image-${this.#observations}`).toString("base64"),
                  height: 900,
                  mime: "image/jpeg",
                  width: 1200,
                }
              : null,
            tree,
            truncated: false,
            window: {
              ref: window.ref,
              id: window.id,
              frame: window.frame,
              scale: 2,
              title: window.title,
            },
          },
        };
      }
      case "permissions":
        return { accessibility: "granted", screenRecording: "granted" };
    }
  }

  #release(sessionId: string): void {
    this.#sessions.delete(sessionId);
    for (const [app, owner] of this.#owners) if (owner === sessionId) this.#owners.delete(app);
  }
}

/**
 * One Android phone as the Agent Phone app answers on its `integrations`
 * stream, with the phone's own rules: one session holds the whole screen and
 * any other session is told it is busy, an act cites the latest observation
 * or is refused before anything runs, `close` lets go, and the owner can Stop.
 */
class FakePhone {
  /** Every approval list the Host sent this phone, in order. */
  readonly lists: ComputerAppApprovalList[] = [];
  /** Every computer-use frame that reached the phone, in order. */
  readonly frames: HostIntegrationsComputerUse[] = [];
  /** Every Stop the Host said it recorded, in order. */
  readonly stopsRecorded: { readonly runId: string; readonly sessionId: string }[] = [];
  readonly peer: ComputerAppControlPeer;
  readonly stream: RunnerAuxiliaryStream;
  readonly #hub: ComputerAppHub;
  #attached = false;
  #latest: string | null = null;
  #observations = 0;
  #session: string | null = null;
  #sessionRunId: string | null = null;
  readonly #arrivals = new Set<() => void>();
  /** Holds every observe and act until it settles, so a call can be caught in flight. */
  gate: Promise<void> | null = null;
  completedActions = 0;
  hiddenScreen: "screen-off" | "opensteer-app" | null = null;
  state: "ready" | "unavailable" | "permission-required" = "ready";

  constructor(hub: ComputerAppHub, runnerId: RunnerId) {
    this.#hub = hub;
    const auxiliaryStreamId = RunnerAuxiliaryStreamIdSchema.parse(`rax_${randomUUID()}`);
    const fence: RunnerAuxiliaryFrameFence = {
      auxiliaryStreamId,
      bootId: RunnerBootIdSchema.parse(`rbt_${randomUUID()}`),
      connectionGeneration: 1,
      connectionId: RunnerConnectionIdSchema.parse(`rcn_${randomUUID()}`),
      connectionLeaseId: RunnerConnectionLeaseIdSchema.parse(`rls_${randomUUID()}`),
      module: "integrations",
      runnerId,
    };
    this.stream = {
      auxiliaryStreamId,
      fence,
      identity: {
        modules: {
          integrations: {
            platform: "android",
            protocolVersion: 4,
          },
        },
        name: phone,
        runnerId,
      } as RunnerAuxiliaryStream["identity"],
      streamLeaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    this.peer = {
      close: () => undefined,
      id: `peer:${randomUUID()}`,
      send: async (message) => {
        setImmediate(() => void this.#receive(message));
      },
    };
  }

  invalidateObservation(): void {
    this.#latest = "phone-external-change";
  }

  async attach(): Promise<void> {
    this.#hub.attach(this.peer, this.stream);
    this.#attached = true;
    await this.#hub.handleMessage(this.peer, this.stream, {
      ...this.stream.fence,
      apps: [
        {
          definitionId: "android-phone",
          operations: ["observe", "act", "release"].map((operation) => ({
            operation,
            remedy: null,
            state: this.state,
            detail: this.state === "unavailable" ? "Paused on the phone" : null,
          })),
        },
      ],
      captureSupported: false,
      displayAvailable: true,
      module: "integrations",
      type: "runner.integrations.status",
    });
  }

  /** The stream drops, which takes the phone's session with it. */
  detach(): void {
    this.#attached = false;
    this.#session = null;
    this.#sessionRunId = null;
    this.#latest = null;
    this.#hub.detach(this.peer, "transport-disconnected");
  }

  /** What the phone does with the computer-use frames it was sent, by operation. */
  received(operation: HostIntegrationsComputerUse["operation"]): number {
    return this.frames.filter((frame) => frame.operation === operation).length;
  }

  /**
   * Waits until `count` frames of `operation` have reached the phone. The way
   * there crosses the REPL worker, the database and the hub, which took 2 s at
   * load 129, past `vi.waitFor`'s one second; the test timeout bounds a frame
   * that never comes.
   */
  async reached(operation: HostIntegrationsComputerUse["operation"], count = 1): Promise<void> {
    while (this.received(operation) < count)
      await new Promise<void>((resolve) => this.#arrivals.add(resolve));
  }

  /**
   * The person presses Stop on the phone's notification: the session ends and
   * is reported, naming its Run, as the phone does.
   */
  stopFromPhone(): { readonly runId: string; readonly sessionId: string } {
    const sessionId = this.#session;
    const runId = this.#sessionRunId;
    if (!sessionId || !runId) throw new Error("The phone holds no session to stop.");
    this.#session = null;
    this.#sessionRunId = null;
    this.#latest = null;
    this.reportStop({ runId, sessionId });
    return { runId, sessionId };
  }

  /** Reports a Stop again, as the phone does on every stream until the Host says it is recorded. */
  reportStop(stop: { readonly runId: string; readonly sessionId: string }): void {
    void this.#hub.handleMessage(this.peer, this.stream, {
      ...this.stream.fence,
      event: {
        event: "session.stopped",
        params: { reason: "user", runId: stop.runId as never, sessionId: stop.sessionId as never },
      },
      module: "integrations",
      type: "runner.integrations.computer-use-event",
    });
  }

  async #receive(message: HostIntegrationsOperation): Promise<void> {
    if (!this.#attached || !this.#hub.attached(this.stream.identity.runnerId)) return;

    if (message.type === "host.integrations.computer-use-stop-recorded") {
      this.stopsRecorded.push({ runId: message.runId, sessionId: message.sessionId });
      return;
    }
    if (message.type === "host.integrations.computer-app-approvals") {
      this.lists.push({ approvalKeyId: message.approvalKeyId, approvals: message.approvals });
      return;
    }
    if (message.type === "host.integrations.computer-view") {
      const ref = { viewId: message.viewId, generation: message.generation };
      const value = {
        ...ref,
        state: message.operation === "close" ? ("closed" as const) : ("ready" as const),
        captureTargetId: null,
      };
      if (!this.#hub.attached(this.stream.identity.runnerId)) return;
      await this.#hub.handleMessage(this.peer, this.stream, {
        ...this.stream.fence,
        type: "runner.integrations.computer-view-result",
        module: "integrations",
        requestId: message.requestId,
        result: { kind: "ok", value },
      });
      return;
    }
    if (message.type !== "host.integrations.computer-use") return;
    this.frames.push(message);
    for (const arrived of this.#arrivals) arrived();
    this.#arrivals.clear();
    let result:
      | { readonly kind: "ok"; readonly value: unknown }
      | { readonly kind: "error"; readonly code: ComputerUseErrorCode; readonly message: string };
    try {
      result = { kind: "ok", value: await this.#perform(message) };
    } catch (error) {
      if (!(error instanceof MacError)) throw error;
      result = { code: error.code, kind: "error", message: error.message };
    }
    // An answer to a stream that is gone, or a Host that stopped, has nowhere to go.
    if (!this.#attached || !this.#hub.attached(this.stream.identity.runnerId)) return;
    await this.#hub.handleMessage(this.peer, this.stream, {
      ...this.stream.fence,
      module: "integrations",
      requestId: message.requestId,
      result: result as never,
      type: "runner.integrations.computer-use-result",
    });
  }

  async #perform(frame: HostIntegrationsComputerUse): Promise<unknown> {
    // The Host addresses a phone by its definition and never names an app.
    if (frame.definitionId !== "android-phone" || frame.app !== null) {
      throw new MacError("failed", "That frame is not addressed to a phone.");
    }
    const params = frame.params as Record<string, unknown>;
    switch (frame.operation) {
      case "close":
        if (this.#session === frame.sessionId) {
          this.#session = null;
          this.#sessionRunId = null;
          this.#latest = null;
        }
        return {};
      case "observe":
      case "act": {
        if (typeof params.includeScreenshot !== "boolean") {
          throw new MacError("failed", "The Host must choose whether to capture a screenshot.");
        }
        if (this.#session !== null && this.#session !== frame.sessionId) {
          throw new MacError("busy", "This phone is already being used by another task.");
        }
        this.#session = frame.sessionId;
        this.#sessionRunId = frame.runId;
        if (frame.operation === "act" && params.observationId !== this.#latest) {
          throw new MacError(
            "stale-observation",
            "That observation is no longer the latest one on this phone; observe again.",
          );
        }
        await this.gate;
        if (this.#session !== frame.sessionId)
          throw new MacError("no-session", "The session ended before the batch ran.");
        this.completedActions +=
          frame.operation === "act" ? (params.actions as unknown[]).length : 0;
        this.#observations += 1;
        const observationId = `phone-obs-${this.#observations}`;
        this.#latest = observationId;
        const base = phoneScreen(observationId, params.includeScreenshot, this.#observations);
        const observation = this.hiddenScreen
          ? {
              ...base,
              screen: this.hiddenScreen === "screen-off" ? "off" : "on",
              tree: "",
              elementCount: 0,
              screenshot: null,
              screenshotUnavailable: this.hiddenScreen,
              foreground:
                this.hiddenScreen === "opensteer-app"
                  ? { label: "Opensteer Agent Phone", packageName: "com.opensteer.agentphone" }
                  : null,
            }
          : base;
        return frame.operation === "act"
          ? {
              error: null,
              observation,
              performed: (params.actions as unknown[]).map(describePhoneAction),
            }
          : { observation };
      }
      case "installed_apps": {
        const apps = [
          { label: "Messages", packageName: "com.google.android.apps.messaging" },
        ].filter((app) =>
          `${app.label} ${app.packageName}`
            .toLowerCase()
            .includes(String(params.query ?? "").toLowerCase()),
        );
        return {
          apps: apps.slice(
            Number(params.offset ?? 0),
            Number(params.offset ?? 0) + Number(params.limit ?? 50),
          ),
          total: apps.length,
        };
      }
      case "permissions":
      case "resolve_app":
        throw new MacError("unsupported", "A phone has no such operation.");
      default:
        throw new MacError("unsupported", "Phones use live display for viewing.");
    }
  }
}

const phoneTree = '[0] window "Messages" (0,0 540×1200)\n  [1] button "Send" (440,1100 80×60)';

/** The phone's screen, on and unlocked, with Messages in front. */
function phoneScreen(observationId: string, includeScreenshot: boolean, frame: number) {
  return {
    capturedAt: new Date().toISOString(),
    elementCount: 2,
    foreground: { label: "Messages", packageName: "com.google.android.apps.messaging" },
    geometry: { height: 1200, width: 540 },
    locked: false,
    observationId,
    rotation: 0,
    screen: "on",
    screenshot: includeScreenshot
      ? { base64: `/9j/phone${frame}`, height: 1200, mime: "image/jpeg", width: 540 }
      : null,
    screenshotUnavailable: includeScreenshot ? null : "not-requested",
    secureLock: false,
    tree: phoneTree,
    truncated: false,
  };
}

/** What the fake phone says each action did, as the Agent Phone app words it. */
function describePhoneAction(action: unknown): string {
  const { target, text, type } = action as {
    readonly target?: { readonly index?: number };
    readonly text?: string;
    readonly type: string;
  };
  if (type === "wake") return "Woke the screen";
  if (type === "tap") return `Tapped element ${target?.index ?? "?"}`;
  if (type === "type") return `Typed "${text ?? ""}"`;
  return `Performed ${type}`;
}

class MacError extends Error {
  readonly code: ComputerUseErrorCode;
  constructor(code: ComputerUseErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

async function observeMacWindow(
  world: Awaited<ReturnType<typeof createWorld>>,
  claims: RunCapabilityClaims<string>,
  app = apps.notes,
  access: "read" | "read-write" = "read",
) {
  const computer = { ownerUserId: world.owner.userId, runnerId: world.macId, runnerName: mac };
  const target = { kind: "app" as const, app, access };
  const bindLease = await world.computerUse.prepare(computer, claims);
  const bind = await world.hub.withRunnerAdmission(world.macId, () =>
    world.computerUse.sendWindowOperation(bindLease, target, "bind", { window: null }),
  );
  const bound = WindowInfoSchema.parse((await bind.settle()).window);
  const observeLease = await world.computerUse.prepare(computer, claims);
  const observe = await world.hub.withRunnerAdmission(world.macId, () =>
    world.computerUse.sendWindowOperation(observeLease, target, "observe", {
      window: bound.ref,
      includeScreenshot: false,
    }),
  );
  return {
    sessionId: observe.sessionId,
    observation: ComputerUseObservationSchema.parse((await observe.settle()).observation),
  };
}

async function createWorld(
  database: ReturnType<typeof createDatabase>,
  options: {
    readonly ownerUserId?: UserId;
    readonly onPlaceActivity?: ConstructorParameters<
      typeof ComputerUseService
    >[0]["onPlaceActivity"];
    readonly actingWindowMs?: number;
    readonly now?: () => number;
    /** Where acting apps are announced, exactly as the runtime wires it. */
    readonly realtime?: Pick<RealtimeHub, "sendToUsers">;
    /**
     * Adds the owner's Android phone, attached, and the phone definition to
     * the catalog. Phone access is allowed by the owner from any client.
     */
    readonly phone?: boolean;
    readonly withoutComputerUse?: boolean;
    readonly releasedMacRunner?: boolean;
    readonly ownerViews?: boolean;
    readonly passwords?: ConstructorParameters<typeof ComputerUseService>[0]["passwords"];
    readonly computerReplTime?: ConstructorParameters<
      typeof IntegrationPlatformService
    >[0]["computerReplTime"];
  } = {},
) {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), "opensteer-computer-use-journey-"));
  const store = new OpensteerStore(database);
  const persistence = new IntegrationPlatformStore(database);
  const connections = new IntegrationStore(database);
  const owner = await createOwner(store, randomUUID(), options.ownerUserId);
  const workspace = await createWorkspace(store, owner.userId, randomUUID(), "specialized");
  // The Runner authenticates with its own key; the person's approvals are
  // signed with the desktop's, which is a different key entirely.
  const keys = generateKeyPairSync("ed25519");
  const approvalKeys = generateKeyPairSync("ed25519");
  const insertComputer = async (
    name: string,
    computer: "mac" | "phone",
    ownerUserId: UserId = owner.userId,
  ) => {
    const runnerId = createId("runner");
    await database
      .insertInto("runners")
      .values({
        accessPolicy: sql`'{"commands":false,"forwarding":false,"reach":"nobody","shares":[]}'::jsonb`,
        accessPolicyRevision: 1,
        allowedModules: sql`'["integrations"]'::jsonb`,
        capabilities: sql`'[]'::jsonb`,
        connectionGeneration: 0,
        enrolledAt: new Date(),
        enrollmentTokenHash: `sha256:${runnerId}`,
        id: runnerId,
        kind: "local",
        lastSeenAt: null,
        maxConcurrentRuns: null,
        moduleDescriptors:
          computer === "mac"
            ? sql`'{"integrations":{"platform":"darwin"}}'::jsonb`
            : sql`'{"integrations":{"platform":"android","protocolVersion":4}}'::jsonb`,
        ...(computer === "phone"
          ? { device: sql`'{"form":"phone","platform":"android"}'::jsonb` }
          : {}),
        name,
        ownerKind: "user",
        ownerUserId,
        publicKeyFingerprint: `sha256:${runnerId}`,
        publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
        revokedAt: null,
      })
      .execute();
    if (options.ownerUserId)
      await database
        .insertInto("runnerEnrollments")
        .values({
          id: `ren_${randomUUID()}`,
          name,
          tokenHash: `enrollment:${runnerId}`,
          allowedModules: sql`'["integrations"]'::jsonb`,
          createdBy: ownerUserId,
          ownerKind: "user",
          ownerUserId,
          idempotencyKey: `enrollment:${runnerId}`,
          requestFingerprint: "native-journey",
          runnerKind: "local",
          expiresAt: new Date(Date.now() + 60_000),
          consumedAt: new Date(),
          runnerId,
          createdAt: new Date(),
        })
        .execute();
    return runnerId;
  };
  const insertMac = (name: string) => insertComputer(name, "mac");
  const macId = await insertMac(mac);
  const phoneId = options.phone ? await insertComputer(phone, "phone") : null;
  // The Mac's owner also administers this Deployment, so their first Allow
  // adds Computer use to it; an answer on the Mac's stream carries no session
  // to say so, and the Host reads the role.
  await database
    .updateTable("users")
    .set({ instanceRole: "administrator" })
    .where("id", "=", owner.userId)
    .execute();
  // The owner opened this Mac's page on the Mac, which registered its key.
  await persistence.registerComputerUseApprovalKey({
    ownerUserId: owner.userId,
    publicKey: approvalKeys.publicKey.export({ format: "pem", type: "spki" }).toString(),
    requestId: "register-approval-key",
    runnerId: macId,
  });
  const definitions = options.phone ? [definition, phoneDefinition] : [definition];
  let computerUse!: ComputerUseService;
  let approvals: IntegrationPlatformService["computerAppApprovals"] | undefined;
  const hub = new ComputerAppHub({
    knownDefinitionIds: () => new Set(computerAppIntegrations.map(({ id }) => id)),
    onChanged: () => undefined,
    onComputerUseEvent: (runnerId, event) => computerUse.handleHelperEvent(runnerId, event),
    onRunnerDetached: (runnerId) => computerUse.forgetRunner(runnerId),
    // Exactly as the runtime wires it.
    onRunnerAttached: (runnerId) => approvals?.pushComputerAppApprovals(runnerId),
    onComputerAppApprovalsSync: (runnerId) => approvals?.pushComputerAppApprovals(runnerId),
    onComputerAppApprovalAnswer: (runnerId, answer) =>
      void approvals?.answerComputerAppApproval(runnerId, answer),
  });
  computerUse = new ComputerUseService({
    hub,
    ...(options.passwords
      ? {
          passwords: options.passwords,
          loginReceiver: () => ({
            version: 1 as const,
            connectionId: "receiver-1",
            connectionGeneration: 1,
            publicKey: "B" + "A".repeat(86),
          }),
        }
      : {}),
    ...(options.now ? { now: options.now } : {}),
    // The runtime pages the Runner inventory; the computer rows here have no
    // enrollment record, so the computers lending apps or their screen are
    // read straight from the table, with the platform each reports.
    listMachines: async (ownerId) =>
      (
        await database
          .selectFrom("runners")
          .select(["id", "moduleDescriptors", "name"])
          .where("ownerUserId", "=", ownerId)
          .where("revokedAt", "is", null)
          .orderBy("name")
          .execute()
      ).flatMap(({ id, moduleDescriptors, name }) => {
        const platform = moduleDescriptors.integrations?.platform;
        return platform ? [{ name, platform, runnerId: id }] : [];
      }),
    machineOwners: (runnerIds) => store.effectiveMachineOwners(runnerIds),
    onSessionsChanged: () => undefined,
    onAuthorityRevoked: ({ runId, bindingGeneration }) =>
      platform.resetComputerGeneration(runId, bindingGeneration),
    ...(options.onPlaceActivity
      ? {
          onPlaceActivity: options.onPlaceActivity,
          resolveActor: (runId: RunId, ownerId: UserId) =>
            store.resolvePlaceActor({ agentBindingId: `run:${runId}`, ownerId }),
        }
      : {}),
    ...(options.actingWindowMs ? { actingWindowMs: options.actingWindowMs } : {}),
    ...(options.realtime
      ? {
          onPresenceChanged: (
            ownerUserId: UserId,
            sessions: readonly {
              readonly actingAppKeys: readonly string[];
              readonly sessionId: ComputerUseSessionId;
            }[],
          ) => notifyComputerPresence(options.realtime!, ownerUserId, sessions),
        }
      : {}),
    authorizer: store,
    stops: {
      clear: (runId) => store.clearComputerUseStops(runId),
      initial: await store.activeComputerUseStops(),
      record: (runId, runnerId) => store.recordComputerUseStop({ runId, runnerId }),
    },
    sweepIntervalMs: 3_600_000,
    threadTitle: async (threadId, ownerUserId) =>
      (await store.getThreadForOwner(threadId, ownerUserId))?.title ?? null,
  });
  store.onRunGrantsRevoked((grants) => computerUse.endGrantSessions(grants));
  const fakeMac = new FakeMac(hub, macId, !options.releasedMacRunner, options.ownerViews);
  const fakePhone = phoneId ? new FakePhone(hub, phoneId) : null;
  /** Whether the Thread's engine and model both show MCP images. */
  const imageGate = { on: false };
  const executionCapability = { on: true };
  const macVersion = { value: 2 };
  const platform = new IntegrationPlatformService({
    adapters: [],
    authorizationSource: { providerAuthorizations: async () => ({}) },
    listConnections: (ownerUserId) => connections.listConnections(ownerUserId),
    computerApps: hub,
    computerUse: options.withoutComputerUse ? null : computerUse,
    credentialMaterializer: {
      materializeForAdapter: vi.fn(),
      markAdapterAuthorizationRequired: vi.fn(),
    },
    dataDirectory,
    definitions,
    // Only the Mac and the phone here have streams; the agents' own Runner
    // is connected throughout.
    isRunnerConnected: (runnerId) =>
      (runnerId !== macId && runnerId !== phoneId) || hub.attached(runnerId),
    computerToolEnabled: async () => executionCapability.on,
    computerUseVersion: () => macVersion.value,
    ...(options.computerReplTime ? { computerReplTime: options.computerReplTime } : {}),
    mcpImageContent: async () => imageGate.on,
    mcpOauth: { providerFor: vi.fn() },
    onWorkspaceEvent: () => undefined,
    onConnectionsChanged: () => undefined,
    onRequestsChanged: () => undefined,
    store: persistence,
  });
  approvals = platform.computerAppApprovals;
  await fakeMac.attach();
  await fakePhone?.attach();
  /** The person on the Mac allows one approval; throws with the Host's refusal. */
  const allowOnMac = async (
    setup: Parameters<typeof createComputerAppApproval>[1],
    signingKey = approvalKeys.privateKey,
  ) => {
    const outcome = await fakeMac.answer(setup.id, {
      approval: createComputerAppApproval(signingKey, setup),
      kind: "allow",
    });
    if (outcome.kind !== "allowed") {
      throw new Error(outcome.kind === "refused" ? outcome.message : outcome.kind);
    }
  };
  const world = {
    database,
    store,
    imageGate,
    executionCapability,
    macVersion,
    macId,
    phoneId,
    fakePhone,
    /** Another person's phone on this Deployment, which nobody else may use. */
    async addStrangersPhone(name: string) {
      const stranger = await store.createUser(`Stranger ${randomUUID()}`);
      return insertComputer(name, "phone", stranger);
    },
    owner,
    workspace,
    persistence,
    connections,
    computerUse,
    hub,
    fakeMac,
    platform,
    async startRun(title: string, target = workspace) {
      return startRun(store, owner, target, title);
    },
    /** Another Mac of the same owner, enrolled but not connected. */
    addMac: insertMac,
    /** The owner answers from an Opensteer client. */
    async allowPhoneFromClient(setup: Parameters<typeof createComputerAppApproval>[1]) {
      if (!fakePhone || setup.kind !== "app") throw new Error("Expected phone access Request.");
      await platform.computerAppApprovals.setComputerConnection({
        access: setup.access,
        actorUserId: owner.userId,
        app: null,
        definitionId: "android-phone",
        isAdministrator: true,
        kind: "app",
        requestId: `owner-allow:${setup.id}`,
        runnerId: setup.runnerId,
      });
    },
    /** The phone's connection, once its owner allowed it. */
    async phoneConnection() {
      const found = (await connections.listConnections(owner.userId)).find(
        ({ definitionId, status }) => definitionId === "android-phone" && status !== "revoked",
      );
      if (!found) throw new Error("The phone has no connection");
      return found;
    },
    async connectionFor(app: string) {
      const found = (await connections.listConnections(owner.userId)).find(
        ({ displayName }) => displayName === `${app} on ${mac}`,
      );
      if (!found) throw new Error(`${app} has no connection`);
      return found;
    },
    /** Each app's approved access, and whether it is blocked. */
    async appAccess() {
      return Object.fromEntries(
        (await connections.listConnections(owner.userId)).map((connection) => [
          connection.computer?.app?.displayName,
          connection.computer?.blockedAt ? "blocked" : connection.computer?.access,
        ]),
      );
    },
    async createWorkspace(name: string, kind: "main" | "specialized" = "specialized") {
      return createWorkspace(store, owner.userId, randomUUID(), kind, name);
    },
    async requestById(id: string) {
      const request = await persistence.requests.get(id as never);
      if (!request) throw new Error(`Request ${id} is missing`);
      return request;
    },
    approveOnMac: allowOnMac,
    signApproval: (
      setup: Parameters<typeof createComputerAppApproval>[1],
      decision: "allow" | "deny",
    ) => createComputerAppApproval(approvalKeys.privateKey, setup, Date.now(), decision),
    denyOnMac: async (
      setup: Parameters<typeof createComputerAppApproval>[1],
      signingKey = approvalKeys.privateKey,
    ) =>
      fakeMac.answer(setup.id, {
        approval: createComputerAppApproval(signingKey, setup, Date.now(), "deny"),
        kind: "deny",
      }),
    /** The same answer, signed with the Runner's own key, which any process can read. */
    async approveWithRunnerKey(setup: Parameters<typeof createComputerAppApproval>[1]) {
      return allowOnMac(setup, keys.privateKey);
    },
    async automaticOnMac() {
      const request = await platform.computerAppApprovals.requestComputerAppSetup({
        kind: "policy",
        appApproval: "automatic",
        actorUserId: owner.userId,
        runnerId: macId,
      });
      await vi.waitFor(() => expect(fakeMac.waiting()).toContain(request.id));
      await allowOnMac(request);
    },
    async gateway(run: Awaited<ReturnType<typeof startRun>>, trigger = false) {
      return openGateway(platform, owner.userId, run, trigger, definitions);
    },
    async close() {
      await platform.close();
      await computerUse.shutdown();
      hub.close();
      await rm(dataDirectory, { recursive: true, force: true });
    },
  };
  return world;
}

let mcpRequestId = 0;

async function openGateway(
  platform: IntegrationPlatformService,
  userId: UserId,
  run: Awaited<ReturnType<typeof startRun>>,
  trigger: boolean,
  definitions: readonly IntegrationDefinition[],
) {
  const runScope = run.claims;
  const triggerScope = {
    aud: "opensteer-trigger-integration-tools" as const,
    environmentId: run.environmentId,
    executionGeneration: 1,
    exp: 2_000_000_000,
    iat: 1_900_000_000,
    iss: "opensteer-host" as const,
    jti: randomUUID(),
    occurrenceId: createId("triggerOccurrence"),
    requestedBy: userId,
    runnerBootId: "boot",
    runnerId: run.agentRunnerId,
    threadId: run.threadId,
    toolContractVersion: 2,
    workspaceId: run.workspaceId,
  };
  const service = new IntegrationToolsMcpService({
    definitions,
    getWorkspaceForOwner: async (workspaceId) => ({ id: workspaceId }),
    onWorkspaceEvent: () => undefined,
    platform,
    publicUrl: new URL("https://opensteer.example.test"),
    runTokens: {
      authenticate: async () => {
        if (trigger) throw new Error("not a Run token");
        return runScope;
      },
    } as never,
    triggerTokens: { authenticate: async () => triggerScope } as never,
  });
  await service.handle(
    {
      headers: { host: "opensteer.example.test", origin: "https://opensteer.example.test" },
      method: "POST",
    } as never,
    { end: () => undefined, headersSent: false, setHeader: () => undefined } as never,
    {
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
        protocolVersion: "2025-06-18",
      },
    },
    "token",
  );
  const listHandler = mcp.listHandler;
  const handler = mcp.callHandler;
  if (!handler) throw new Error("MCP handlers were not registered");
  return {
    list() {
      if (!listHandler) throw new Error("Missing tools/list");
      return listHandler(
        {},
        {
          authInfo: {
            clientId: "journey",
            extra: { scope: trigger ? triggerScope : runScope },
            scopes: [],
            token: "token",
          },
          requestId: ++mcpRequestId,
          signal: new AbortController().signal,
        },
      );
    },
    call(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
      mcpRequestId += 1;
      return handler(
        { params: { arguments: args, name } },
        {
          // The transport hands each call the scope its request's token proved.
          authInfo: {
            clientId: "journey",
            extra: { scope: trigger ? triggerScope : runScope },
            scopes: [],
            token: "token",
          },
          requestId: mcpRequestId,
          sessionId: "journey",
          signal: signal ?? new AbortController().signal,
        },
      );
    },
  };
}

async function createWorkspace(
  store: OpensteerStore,
  createdBy: UserId,
  suffix: string,
  kind: "main" | "specialized",
  name = `Workspace ${suffix}`,
) {
  return store.createWorkspace({
    backing: {
      generation: 1,
      kind: "portablefs",
      serviceId: "test-portablefs",
      volumeId: `wsp_${suffix.replaceAll("-", "_")}`,
    },
    capacityPolicy: { blockHardLimitBytes: 10_000_000, inodeHardLimit: 10_000, kind: "hard-quota" },
    createdBy,
    idempotencyKey: `workspace-${suffix}`,
    kind,
    name,
    status: "ready",
  });
}

interface Owner {
  readonly agentRunnerId: RunnerId;
  readonly environmentId: EnvironmentId;
  readonly harnessInstanceId: HarnessInstanceId;
  readonly userId: UserId;
}

/** The person, and the Runner their agents run on (not the Mac lending apps). */
async function createOwner(
  store: OpensteerStore,
  suffix: string,
  existingUserId?: UserId,
): Promise<Owner> {
  const userId = existingUserId ?? (await store.createUser(`Owner ${suffix}`));
  const agentRunnerId = createId("runner");
  const environmentId = createId("environment");
  if (!(await store.getDeployment())) {
    await store.ensureDeployment({
      canonicalOrigin: "https://test-host.invalid",
      deploymentShape: { defaultWorkspaceBacking: "portablefs", kind: "server" as const },
      hostInstanceId: createId("hostInstance"),
    });
  }
  const pair = generateKeyPairSync("ed25519");
  const publicKeyDer = pair.publicKey.export({ format: "der", type: "spki" });
  const enrollmentTokenHash = `sha256:${createHash("sha256")
    .update(`test-enrollment-${suffix}`, "utf8")
    .digest("base64url")}`;
  await store.createRunnerEnrollment({
    allowedModules: ["agents"],
    createdBy: userId,
    expiresAt: new Date(Date.now() + 60_000),
    id: `ren_${randomUUID()}`,
    idempotencyKey: `test-runner-${suffix}`,
    mainEnrollmentPurpose: "initial",
    name: `Test runner ${suffix}`,
    requestFingerprint: `sha256:test-runner-${suffix}`,
    runnerKind: "main",
    tokenHash: enrollmentTokenHash,
  });
  const descriptor: RunnerDescriptor = {
    bootId: `rbt_${randomUUID()}` as RunnerDescriptor["bootId"],
    capabilities: ["filesystem"],
    modules: {
      agents: {
        computerTool: 1,
        environmentIds: [environmentId],
        harnessDrivers: [
          {
            accessModes: ThreadAccessModeSchema.options,
            driverKind: HarnessIdSchema.parse("native"),
            readiness: "configured",
            sources: [
              {
                fields: [],
                kind: "first-party",
                label: "Native",
                quota: "none",
                sourceId: "native",
                stateKinds: ["isolated"],
              },
            ],
          },
        ],
        localStorage: null,
        maxConcurrentRuns: 4,
        providerStateModes: ["isolated"],
        workspaceBackings: ["portablefs"],
        workspaceMounts: [],
      },
    },
    name: `Runner ${suffix}`,
    runnerId: agentRunnerId,
    runnerKind: "main",
    runtimeVersion: "test",
  };
  await store.enrollRunnerConnection({
    descriptor,
    enrollmentTokenHash,
    publicKeyFingerprint: `sha256:${createHash("sha256").update(publicKeyDer).digest("base64url")}`,
    publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
  });
  const harnessInstance = await store.createHarnessInstance({
    config: { model: "test" },
    driverKind: HarnessIdSchema.parse("native"),
    environmentId,
    name: "Native",
    sourceId: "native",
    stateKind: "isolated",
  });
  return { agentRunnerId, environmentId, harnessInstanceId: harnessInstance.id, userId };
}

/** One Thread with a running Run, which is what a Request and a session belong to. */
async function startRun(
  store: OpensteerStore,
  owner: Owner,
  workspace: { readonly id: WorkspaceId },
  title: string,
  existingThreadId?: ThreadId,
) {
  const suffix = randomUUID();
  const { thread } = existingThreadId
    ? { thread: { id: existingThreadId } }
    : await store.createThread({
        createdBy: owner.userId,
        environmentId: owner.environmentId,
        harnessInstanceId: owner.harnessInstanceId,
        idempotencyKey: `thread-${suffix}`,
        modelSelection: ModelSelectionSchema.parse({
          modelId: "gpt-5.6-sol",
          options: { effort: "low" },
          providerId: "openai",
        }),
        title,
        workspaceId: workspace.id,
      });
  const admitted = await store.enqueueThreadInput({
    content: [{ text: "Start the work", type: "text" }],
    idempotencyKey: `${suffix}-initial-turn`,
    policy: "queue",
    requestedBy: owner.userId,
    source: { kind: "human" },
    threadId: thread.id,
  });
  if (!admitted.command || !admitted.run) throw new Error("Expected the input to queue a Run");
  await store.claimCommand(admitted.command.id, `${suffix}-dispatcher`);
  const runnerBootId = `boot-${suffix}`;
  const binding = await store.acquireExecutionBinding({
    bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
    continuationIdentity: {
      continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
      driverKind: HarnessIdSchema.parse("native"),
    },
    harnessInstanceId: owner.harnessInstanceId,
    leaseTokenHash: `${suffix}-lease`,
    membershipGeneration: 1,
    runnerBootId,
    runnerId: owner.agentRunnerId,
    runId: admitted.run.id,
    threadId: thread.id,
  });
  const started: PendingAgentEvent = {
    bindingGeneration: binding.bindingGeneration,
    data: { status: "running" },
    emittedAt: new Date().toISOString(),
    environmentId: owner.environmentId,
    ordinal: 0,
    runId: admitted.run.id,
    threadId: thread.id,
    type: "run.started",
    workspaceId: workspace.id,
  };
  await store.commitRunnerEvent({
    environmentId: owner.environmentId,
    event: started,
    runnerBootId,
    runnerId: owner.agentRunnerId,
  });
  const scope = await store.runCapabilityScope(admitted.run.id);
  if (!scope) throw new Error("The Run has no live grant");
  const claims: RunCapabilityClaims<"opensteer-integration-tools"> = {
    ...scope,
    aud: "opensteer-integration-tools",
    exp: 2_000_000_000,
    iat: 1_900_000_000,
    iss: "opensteer-host",
    jti: randomUUID(),
  };
  return {
    claims,
    runnerBootId,
    agentRunnerId: owner.agentRunnerId,
    environmentId: owner.environmentId,
    runId: admitted.run.id,
    threadId: thread.id,
    workspaceId: workspace.id,
  };
}

/** What the fake Mac says each action did, as the helper words it. */
function describeFakeAction(action: unknown): string {
  const { target, text, type } = action as {
    readonly target?: { readonly index?: number };
    readonly text?: string;
    readonly type: string;
  };
  if (type === "type") return `Typed "${text ?? ""}"`;
  if (type === "click") return `Clicked element ${target?.index ?? "?"}`;
  return `Performed ${type}`;
}
