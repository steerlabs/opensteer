import { readToolRecords } from "../mcp/product-tools.test-support.js";
import { TriggerOutputSchema } from "@opensteer/agent-tools/outputs";
import { type ProductToolResult } from "../mcp/product-tools.test-support.js";
import { TriggerToolsTestClient } from "../mcp/product-tools.test-support.js";
import { ProductToolsTestClient } from "../mcp/product-tools.test-support.js";
import { seedPersonalFixture } from "@opensteer/database/test-support/personal";
import { testReadyHarnessCatalog } from "@opensteer/database/test-support/store";
import { personalTestFolders } from "../mcp/personal-folder.test-support.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { toolsFor } from "@opensteer/agent-tools";
import {
  HarnessIdSchema,
  ThreadAccessModeSchema,
  ModelSelectionSchema,
  OpensteerError,
  type Run,
  type Thread,
  type ThreadId,
  type TriggerId,
} from "@opensteer/core";
import { createDatabase, migrateToLatest, OpensteerStore, TriggerStore } from "@opensteer/database";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { withPersonalTransaction } from "@opensteer/database";
import { recordedTransactionConflicts } from "@opensteer/database/test-support/lock-order";
import {
  CommandService,
  ExecutionCoordinator,
  KeyedAdmissionQueue,
  type RunnerIdentity,
  type RunnerRegistry,
} from "@opensteer/orchestration";
import { hostApi, type HostApiServerContext, type RunnerDescriptor } from "@opensteer/protocol";
import {
  TriggerControlInputSchema,
  TriggerRevisionSchema,
  TriggerSchema,
  type TriggerOccurrence,
  type TriggerProgram,
  type TriggerSource,
} from "@opensteer/triggers";
import { sql } from "kysely";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type RunToolScope, type RunToolTokenService } from "../agents/run-tool-tokens.js";
import { OpensteerMcpService } from "../mcp/opensteer-mcp-service.js";
import { AgentCallerResolver } from "../mcp/agent-caller.js";
import { HostCommandDispatcher } from "../agents/dispatcher.js";
import {
  type TriggerControlScope,
  type TriggerControlTokenService,
} from "./trigger-control-service.js";
import { createTriggerRpcHandlers, handleTriggerCommand } from "./trigger-routes.js";
import { TriggerService } from "./trigger-service.js";
import type { WatchControlScope, WatchControlTokenService } from "./watch-capability.js";
import { WatchToolsTestClient } from "../mcp/product-tools.test-support.js";
import { WatchService, type WatchServiceOptions } from "./watch-service.js";
const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const evidenceRoot = join(tmpdir(), "opensteer-trigger-authority", randomUUID());
const applicationName = "opensteer-trigger-authority-integration-test";
const now = new Date("2040-01-02T08:00:00.000Z");
const plusThirty = "2040-01-02T08:30:00.000Z";
const nextHour = "2040-01-02T09:00:00.000Z";
const program: TriggerProgram = {
  language: "javascript",
  source: "export default async () => ({ verified: true })",
  toolContractVersion: 3,
};
const cron: TriggerSource = {
  kind: "schedule",
  schedule: {
    expression: "0 * * * *",
    kind: "cron",
    timezone: "UTC",
  },
};
const modelSelection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: {
    effort: "low",
  },
  providerId: "openai",
});
const createdSchema = z.object({
  trigger: z.object(
    TriggerSchema.omit({
      webhookRouteKey: true,
    }).shape,
  ),
  revision: TriggerRevisionSchema,
});
type Created = z.infer<typeof createdSchema>;
type Evidence = {
  scenario: string;
  actor: string;
  operation: string;
  expected: unknown;
  observed: unknown;
};
const evidence: Evidence[] = [];
integration.sequential("Trigger authority through real Host services and PostgreSQL", () => {
  const database = createDatabase({
    applicationName,
    connectionString: databaseUrl ?? "postgres://unconfigured",
    maxConnections: 6,
  });
  const store = new OpensteerStore(database);
  const triggerStore = new TriggerStore(database);
  const runClaims = new Map<string, RunToolScope>();
  const occurrenceClaims = new Map<string, TriggerControlScope>();
  const watchClaims = new Map<string, WatchControlScope>();
  let folders: ReturnType<typeof personalTestFolders>;
  const commands = new CommandService({
    admission: new KeyedAdmissionQueue({
      maxInFlight: 8,
      maxQueuedBytes: 4_000_000,
      maxQueuedCommands: 64,
    }),
    onExecutionQueued: vi.fn(),
    onDeploymentEvent: vi.fn(),
    store,
  });
  const tokens = {
    authenticate: async (token: string) => claimsFor(runClaims, token),
  } as unknown as RunToolTokenService;
  const triggerTokens = {
    authenticate: async (token: string) => {
      const claims = claimsFor(occurrenceClaims, token);
      await triggerStore.assertActiveExecutionBinding(claims);
      return claims;
    },
  } as unknown as TriggerControlTokenService;
  const watchTokens = {
    authenticate: async (token: string) => {
      const claims = claimsFor(watchClaims, token);
      await triggerStore.assertActiveWatchBinding(claims);
      return claims;
    },
  } as unknown as WatchControlTokenService;
  const services = {
    canRunHarness: () => true,
    commands,
    isEnvironmentConnected: () => true,
    store,
    folders: {
      resolve: (...args: Parameters<typeof folders.resolve>) => folders.resolve(...args),
      canExecute: (id: Parameters<typeof folders.canExecute>[0]) => folders.canExecute(id),
    },
  };
  function triggerService(backing = triggerStore) {
    return new TriggerService({
      runnerStore: store,
      onOccurrenceQueued: vi.fn(),
      publicUrl: new URL("https://trigger-authority.opensteer.test"),
      store: backing,
      threads: store,
      tokens: {
        deriveSecret: (_purpose, key) => createHash("sha256").update(key).digest("hex"),
      },
    });
  }
  const triggers = triggerService();
  const agents = new ProductToolsTestClient({
    ...services,
    browserSources: {
      agentSignIn: unexpected,
      agentUseCard: unexpected,
    },
    machineFullDiskAccess: {
      request: unexpected,
    },
    browser: {
      createProfile: unexpected,
      closeAgentSession: unexpected,
      readablePlaces: async (_owner, references) => [...references],
      drainRunPlaces: async () => undefined,
      listAgentSessions: unexpected,
      listAgentProfiles: unexpected,
      openAgentSession: unexpected,
      requestAccess: unexpected,
    },
    tokens,
    triggers,
  });
  const programs = new TriggerToolsTestClient({
    ...services,
    tokens: triggerTokens,
    triggers,
  });
  const watches = new WatchToolsTestClient({
    ...services,
    tokens: watchTokens,
    triggers,
  });
  const clients: Client[] = [];
  const mcpServices: OpensteerMcpService[] = [];
  const servers: Server[] = [];
  beforeAll(async () => {
    await migrateToLatest(database);
  });
  beforeEach(async () => {
    vi.useFakeTimers({
      toFake: ["Date"],
    });
    vi.setSystemTime(now);
    runClaims.clear();
    occurrenceClaims.clear();
    watchClaims.clear();
    await sql`truncate table deployments, users restart identity cascade`.execute(database);
    await sql`
      insert into principals(id, kind, user_id, display_name)
      values ('pri_00000000-0000-4000-8000-000000000001', 'system', null, 'Opensteer')
      on conflict (id) do nothing
    `.execute(database);
  });
  afterEach(async () => {
    try {
      const clientCleanup = await Promise.allSettled(
        clients.splice(0).map((client) => client.close()),
      );
      const serviceCleanup = await Promise.allSettled(
        mcpServices.splice(0).map((service) => service.close()),
      );
      const serverCleanup = await Promise.allSettled(
        servers.splice(0).map(
          (server) =>
            new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
              server.closeAllConnections();
            }),
        ),
      );
      const failures = [...clientCleanup, ...serviceCleanup, ...serverCleanup].filter(
        (result) => result.status === "rejected",
      );
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          "Trigger authority cleanup failed",
        );
    } finally {
      vi.useRealTimers();
      await mkdir(evidenceRoot, {
        recursive: true,
      });
      await writeFile(join(evidenceRoot, "evidence.json"), JSON.stringify(evidence, null, 2));
    }
  });
  afterAll(async () => {
    await database.destroy();
    console.log(`Trigger authority evidence: ${join(evidenceRoot, "evidence.json")}`);
  });
  it("filters anchored automations and refuses another owner", async () => {
    const f = await fixture();
    const root = await personCreate(f, f.root);
    await personCreate(f, f.specialist);
    const rpc = createTriggerRpcHandlers(triggers);
    const context: HostApiServerContext = {
      session: {
        user: {
          id: f.ownerId,
        },
      },
    } as unknown as HostApiServerContext;
    const result = await rpc["triggers.list"](
      {
        anchorThreadId: f.root.id,
      },
      context,
    );
    if (!result.ok) throw new Error(result.error.message);
    expect(result.data.triggers.map((t) => t.id)).toEqual([root.trigger.id]);
    await expect(
      triggerStore.listForOwner({
        ownerId: await store.createUser("Other automation reader"),
        anchorThreadId: f.root.id,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
  it("A1: lets a same-mode child read and control Root task's clock, but not its definition", async () => {
    const f = await fixture();
    const created = await personCreate(f, f.root);
    await check(
      "A1 list Root task Trigger",
      f.child.id,
      "trigger_read list",
      "visible",
      async () => {
        const result = hostApi["triggers.list"].success
          .extend({
            triggers: TriggerOutputSchema.shape.triggers.unwrap(),
          })
          .parse(
            await agentTrigger(f.childToken, {
              operation: "list",
              limit: 100,
            }),
          );
        expect(result.triggers.map(({ id }) => id)).toEqual([created.trigger.id]);
        return result;
      },
    );
    await check("A1 get Root task Trigger", f.child.id, "trigger_read get", "visible", async () => {
      const detail = await agentDetail(f.childToken, created.trigger.id);
      expect(detail.trigger.id).toBe(created.trigger.id);
      return detail.trigger;
    });
    await check(
      "A1/F19 defer and resume cadence",
      f.child.id,
      "set_next_fire; claimDueSchedules",
      {
        scheduledFor: plusThirty,
        nextFireAt: nextHour,
      },
      async () => {
        await agentTrigger(f.childToken, {
          operation: "set_next_fire",
          triggerId: created.trigger.id,
          nextFireAt: plusThirty,
        });
        expect((await personDetail(f, created.trigger.id)).trigger.nextFireAt).toBe(plusThirty);
        expect(
          (await triggerStore.claimDueSchedules(new Date("2040-01-02T08:29:59.999Z"))).occurrences,
        ).toEqual([]);
        const claimed = await triggerStore.claimDueSchedules(new Date(plusThirty));
        expect(claimed.occurrences).toHaveLength(1);
        expect(claimed.occurrences[0]?.event.source).toEqual({
          kind: "schedule",
          scheduledFor: plusThirty,
        });
        expect((await triggerStore.claimDueSchedules(new Date(plusThirty))).occurrences).toEqual(
          [],
        );
        const detail = await personDetail(f, created.trigger.id);
        expect(detail.trigger.nextFireAt).toBe(nextHour);
        return {
          occurrences: claimed.occurrences,
          nextFireAt: detail.trigger.nextFireAt,
        };
      },
    );
    for (const status of ["paused", "active"] as const) {
      await check(`A1 ${status}`, f.child.id, `set_status ${status}`, status, async () => {
        await agentTrigger(f.childToken, {
          operation: "set_status",
          status,
          triggerId: created.trigger.id,
        });
        const detail = await personDetail(f, created.trigger.id);
        expect(detail.trigger.status).toBe(status);
        expect(detail.trigger.nextFireAt).toBe(status === "paused" ? null : nextHour);
        return detail.trigger;
      });
    }
    await check(
      "A1 cancel pending",
      f.child.id,
      "cancel",
      "pending occurrence canceled",
      async () => {
        const result = await agentTrigger(f.childToken, {
          operation: "cancel",
          triggerId: created.trigger.id,
        });
        const detail = await personDetail(f, created.trigger.id);
        expect(detail.occurrences).toHaveLength(1);
        expect(detail.occurrences[0]?.status).toBe("canceled");
        expect(result).toEqual({
          canceledOccurrenceIds: [detail.occurrences[0]!.id],
        });
        return {
          result,
          occurrences: detail.occurrences,
        };
      },
    );
    for (const input of [
      {
        operation: "update",
        expectedRevisionId: created.revision.id,
        program: {
          ...program,
          source: "export default () => 'unauthorized'",
        },
        triggerId: created.trigger.id,
      },
      {
        operation: "run",
        payload: {
          execute: "injected",
        },
        triggerId: created.trigger.id,
      },
      {
        operation: "set_status",
        status: "archived",
        triggerId: created.trigger.id,
      },
    ] as const) {
      const failure = await denied(
        `A1/F5/F6/F7/F27 ${input.operation}`,
        f.child.id,
        input.operation,
        "forbidden",
        () => agentTrigger(f.childToken, input),
      );
      expect(failure.message).toMatch(/full.access/i);
      expect(failure.message).toMatch(/(pause|control|reschedul|resume)/i);
      const detail = await personDetail(f, created.trigger.id);
      expect(detail.trigger).toMatchObject({
        status: "active",
        currentRevisionId: created.revision.id,
      });
      expect(detail.revision.program).toEqual(program);
      expect(detail.occurrences).toHaveLength(1);
    }
  });

  it("A4/F4/F4b: lower modes may see but cannot control higher anchors or define programs", async () => {
    const f = await fixture();
    const target = await personCreate(f, f.fullChild);
    for (const accessMode of ThreadAccessModeSchema.options.filter(
      (mode) => mode !== "full-access",
    )) {
      await store.updateThreadAccessMode({
        accessMode,
        requestedBy: f.ownerId,
        threadId: f.child.id,
      });
      await check(`A4 see from ${accessMode}`, f.child.id, "get", "visible", async () => {
        const detail = await agentDetail(f.childToken, target.trigger.id);
        expect(detail.trigger.id).toBe(target.trigger.id);
        return detail.trigger;
      });
      for (const input of [
        {
          operation: "set_status",
          status: "paused",
          triggerId: target.trigger.id,
        },
        {
          operation: "set_status",
          status: "active",
          triggerId: target.trigger.id,
        },
        {
          operation: "set_next_fire",
          nextFireAt: plusThirty,
          triggerId: target.trigger.id,
        },
        {
          operation: "cancel",
          triggerId: target.trigger.id,
        },
      ] as const) {
        await denied(
          `A4 ${accessMode} ${input.operation}`,
          f.child.id,
          input.operation,
          "forbidden",
          () => agentTrigger(f.childToken, input),
        );
      }
      for (const actor of [
        {
          thread: f.child,
          token: f.childToken,
        },
        {
          thread: f.root,
          token: f.rootToken,
        },
      ]) {
        await store.updateThreadAccessMode({
          accessMode,
          requestedBy: f.ownerId,
          threadId: actor.thread.id,
        });
        await denied(
          `F4b ${actor.thread.title} ${accessMode}`,
          actor.thread.id,
          "create",
          "forbidden",
          () => agentCreate(actor.token, actor.thread.id),
        );
      }
    }
    expect((await personDetail(f, target.trigger.id)).trigger).toMatchObject({
      status: "active",
      nextFireAt: nextHour,
      currentRevisionId: target.revision.id,
    });
  });
  it.each(["Trigger", "Watch"] as const)(
    "A5: %s programs keep Thread operations with the anchor’s current access mode",
    async (kind) => {
      const f = await fixture();
      const own = await personCreate(f, f.isolatedChild);
      const triggerToken = await startProgram(f, own);
      const watch = await personCreate(f, f.isolatedChild, {
        kind: "watch",
      });
      const watchToken = await startWatch(f, watch);
      const control = kind === "Trigger" ? programs : watches;
      const token = kind === "Trigger" ? triggerToken : watchToken;
      await check(
        `A5 ${kind} delegates locally`,
        f.isolatedChild.id,
        "delegate_task",
        "same folder and current access mode",
        async () => {
          const response = await control.handle(token, {
            type: "thread.delegate",
            task: "Local authorized work",
            requestId: randomUUID(),
          });
          if (response.type !== "thread.delegate.result")
            throw new Error("Expected local delegation");
          expect((await readToolRecords(store, response.result)).thread).toMatchObject({
            lineageRootThreadId: f.specialist.id,
            accessMode: "auto",
          });
          expect((await readToolRecords(store, response.result)).message!.content).toEqual([
            {
              text: "Local authorized work",
              type: "text",
            },
          ]);
          expect((await readToolRecords(store, response.result)).message!.author).toMatchObject(
            kind === "Trigger"
              ? {
                  kind: "trigger",
                  occurrenceId: claimsFor(occurrenceClaims, triggerToken).occurrenceId,
                }
              : {
                  kind: "watch",
                  activationId: claimsFor(watchClaims, watchToken).activationId,
                },
          );
          return response.result;
        },
      );
      expect(
        await database
          .selectFrom("messages")
          .select("id")
          .where("threadId", "=", f.unrelated.id)
          .execute(),
      ).toEqual([]);
    },
  );
  it("A5: program Trigger controls use current anchor authority", async () => {
    const f = await fixture();
    const own = await personCreate(f, f.isolatedChild);
    const triggerToken = await startProgram(f, own);
    const watch = await personCreate(f, f.isolatedChild, {
      kind: "watch",
    });
    const watchToken = await startWatch(f, watch);
    const outside = await personCreate(f, f.unrelated);
    await check(
      "A5 Trigger controls own clock",
      f.isolatedChild.id,
      "set_next_fire",
      plusThirty,
      async () => {
        const before = await personDetail(f, own.trigger.id);
        expect(before.occurrences[0]?.status).toBe("running");
        await programTrigger(triggerToken, {
          operation: "set_next_fire",
          triggerId: own.trigger.id,
          nextFireAt: plusThirty,
        });
        const detail = await personDetail(f, own.trigger.id);
        expect(detail.trigger.nextFireAt).toBe(plusThirty);
        expect(detail.occurrences).toEqual(before.occurrences);
        return detail.trigger;
      },
    );
    await check(
      "F15 defined revision survives anchor mode change",
      f.isolatedChild.id,
      "downgrade anchor; delegate",
      "existing revision runs with current delegation mode",
      async () => {
        await store.updateThreadAccessMode({
          accessMode: "approval-required",
          requestedBy: f.ownerId,
          threadId: f.isolatedChild.id,
        });
        const response = await programs.handle(triggerToken, {
          type: "thread.delegate",
          task: "Work after mode change",
          requestId: randomUUID(),
        });
        if (response.type !== "thread.delegate.result")
          throw new Error("Expected delegation after mode change");
        expect((await readToolRecords(store, response.result)).thread.accessMode).toBe(
          "approval-required",
        );
        const detail = await personDetail(f, own.trigger.id);
        expect(detail.trigger.currentRevisionId).toBe(own.revision.id);
        expect(detail.occurrences[0]?.status).toBe("running");
        return {
          thread: (await readToolRecords(store, response.result)).thread,
          revisionId: detail.revision.id,
        };
      },
    );
    const watchRead = await watches.handle(watchToken, {
      type: "trigger.control",
      tool: "trigger.read",
      input: {
        operation: "list",
        limit: 50,
      },
      requestId: randomUUID(),
    });
    if (watchRead.type !== "trigger.control.result") throw new Error("Expected Watch Trigger read");
    const visible = TriggerOutputSchema.parse(watchRead.result).triggers ?? [];
    expect(visible.map(({ id }) => id).sort()).toEqual(
      [own.trigger.id, watch.trigger.id, outside.trigger.id].sort(),
    );
    expect(
      await database
        .selectFrom("messages")
        .select("id")
        .where("threadId", "=", f.unrelated.id)
        .execute(),
    ).toEqual([]);
  });
  it("A6/F14/F16: Root task programs keep owner authority and the person bypasses agent tiers", async () => {
    const f = await fixture();
    await store.updateThreadAccessMode({
      accessMode: "full-access",
      requestedBy: f.ownerId,
      threadId: f.root.id,
    });
    const own = await personCreate(f, f.root);
    const token = await startProgram(f, own);
    for (const request of [
      {
        type: "thread.read",
        threadId: f.specialist.id,
      },
      {
        type: "thread.delegate",
        task: "Owner-wide delegation",
      },
      {
        type: "thread.message",
        threadId: f.unrelated.id,
        delivery: "queue",
        content: [
          {
            type: "text",
            text: "Owner-wide work",
          },
        ],
      },
    ]) {
      await check(`A6 Root task ${request.type}`, f.root.id, request.type, "success", async () => {
        const response = await programs.handle(token, {
          ...request,
          requestId: randomUUID(),
        });
        expect(response.type).toBe(`${request.type}.result`);
        return response;
      });
    }
    await check(
      "A6 Root task defines in another task",
      f.root.id,
      "create",
      "specialist anchor",
      async () => {
        const created = createdSchema.parse(
          await programTrigger(token, createInput(f.specialist.id)),
        );
        expect(created.trigger).toMatchObject({
          anchorThreadId: f.specialist.id,
          createdByThreadId: f.root.id,
        });
        return created;
      },
    );
    const watch = await personCreate(f, f.root, {
      kind: "watch",
    });
    const watchToken = await startWatch(f, watch);
    await check(
      "A6 Root task Watch queues outside lineage",
      f.root.id,
      "thread_send queue",
      "run queued",
      async () => {
        const response = await watches.handle(watchToken, {
          type: "thread.message",
          threadId: f.specialist.id,
          delivery: "queue",
          content: [
            {
              type: "text",
              text: "Owner-wide Watch",
            },
          ],
          requestId: randomUUID(),
        });
        expect(response.type).toBe("thread.message.result");
        return response;
      },
    );
    await store.updateThreadAccessMode({
      accessMode: "approval-required",
      requestedBy: f.ownerId,
      threadId: f.root.id,
    });
    await check(
      "F16 person still updates runs and archives",
      "person",
      "manage update/run/cancel/archive",
      "success",
      async () => {
        const updated = createdSchema.parse(
          await manage(
            f,
            {
              operation: "update",
              triggerId: own.trigger.id,
              expectedRevisionId: own.revision.id,
              program: {
                ...program,
                source: "export default () => 'person'",
              },
            },
            null,
          ),
        );
        expect(updated.revision.createdByThreadId).toBeNull();
        await manage(
          f,
          {
            operation: "run",
            triggerId: own.trigger.id,
            payload: {
              human: true,
            },
          },
          null,
        );
        await manage(
          f,
          {
            operation: "cancel",
            triggerId: own.trigger.id,
          },
          null,
        );
        await manage(
          f,
          {
            operation: "set_status",
            triggerId: own.trigger.id,
            status: "archived",
          },
          null,
        );
        const detail = await personDetail(f, own.trigger.id);
        expect(detail.trigger.status).toBe("archived");
        expect(detail.revision.id).toBe(updated.revision.id);
        expect(
          detail.occurrences.some(
            ({ event }) =>
              JSON.stringify(event.payload) ===
              JSON.stringify({
                human: true,
              }),
          ),
        ).toBe(true);
        return detail;
      },
    );
  });
  it("F16: the person's Trigger routes act as the person on any anchor", async () => {
    const f = await fixture();
    await check(
      "F16 person routes act as the person",
      "person",
      "trigger.* commands and triggers.get/list RPC",
      "success with person attribution on an anchor no agent tier would allow",
      async () => {
        const context = {
          session: {
            user: {
              id: f.ownerId,
            },
          },
        } as unknown as HostApiServerContext;
        const rpc = createTriggerRpcHandlers(triggers);
        const created = createdSchema.parse(
          await handleTriggerCommand(
            triggers,
            {
              idempotencyKey: randomUUID(),
              input: {
                anchorThreadId: f.isolatedChild.id,
                name: "Person route Trigger",
                program,
                source: cron,
              },
              type: "trigger.create",
            },
            context,
          ),
        );
        expect(created.trigger.createdByThreadId).toBeNull();
        const updated = createdSchema.parse(
          await handleTriggerCommand(
            triggers,
            {
              idempotencyKey: randomUUID(),
              input: {
                expectedRevisionId: created.revision.id,
                program: {
                  ...program,
                  source: "export default () => 'person route'",
                },
              },
              triggerId: created.trigger.id,
              type: "trigger.update",
            },
            context,
          ),
        );
        expect(updated.revision.createdByThreadId).toBeNull();
        for (const status of ["paused", "active"] as const) {
          await handleTriggerCommand(
            triggers,
            {
              idempotencyKey: randomUUID(),
              status,
              triggerId: created.trigger.id,
              type: "trigger.status.set",
            },
            context,
          );
        }
        const runCommand = {
          idempotencyKey: randomUUID(),
          payload: {
            route: true,
          },
          triggerId: created.trigger.id,
          type: "trigger.run" as const,
        };
        const [firstRun, retriedRun] = await Promise.all([
          handleTriggerCommand(triggers, runCommand, context),
          handleTriggerCommand(triggers, runCommand, context),
        ]);
        expect(retriedRun).toEqual(firstRun);
        const runDetail = await triggers.get(f.ownerId, created.trigger.id, 25);
        expect(runDetail.occurrences).toHaveLength(1);
        await handleTriggerCommand(
          triggers,
          {
            idempotencyKey: randomUUID(),
            triggerId: created.trigger.id,
            type: "trigger.cancel",
          },
          context,
        );
        const listed = await rpc["triggers.list"]({}, context);
        if (!listed.ok) throw new Error(listed.error.message);
        expect(listed.data.triggers.map(({ id }) => id)).toContain(created.trigger.id);
        const detail = await rpc["triggers.get"](
          {
            triggerId: created.trigger.id,
          },
          context,
        );
        if (!detail.ok) throw new Error(detail.error.message);
        expect(detail.data.createdByThreadTitle).toBeNull();
        await handleTriggerCommand(
          triggers,
          {
            idempotencyKey: randomUUID(),
            status: "archived",
            triggerId: created.trigger.id,
            type: "trigger.status.set",
          },
          context,
        );
        const archived = await personDetail(f, created.trigger.id);
        expect(archived.trigger.status).toBe("archived");
        return archived.trigger;
      },
    );
  });
  it("A7/F13b: detail shows downstream Runs only to the personal owner", async () => {
    const f = await fixture();
    const created = await personCreate(f, f.root);
    const token = await startProgram(f, created);
    const response = await programs.handle(token, {
      type: "thread.delegate",
      threadId: f.unrelated.id,
      task: "Reuse this unrelated Thread",
      requestId: randomUUID(),
    });
    if (
      response.type !== "thread.delegate.result" ||
      !(await readToolRecords(store, response.result)).run!
    )
      throw new Error("Expected delegated Run");
    const runId = (await readToolRecords(store, response.result)).run!.id;
    await check(
      "A7 person sees unrelated reused downstream Run",
      "person",
      "get",
      {
        runId,
      },
      async () => {
        expect((await readToolRecords(store, response.result)).thread.accessMode).toBe(
          f.unrelated.accessMode,
        );
        const detail = await personDetail(f, created.trigger.id);
        expect(detail.downstreamRuns.map(({ run }) => run.id)).toContain(runId);
        return detail.downstreamRuns;
      },
    );
    // A child of Root task reaches what Root task reaches, including the reused Thread.
    await check(
      "A7 child detail shows downstream Run",
      f.child.id,
      "get",
      {
        runId,
      },
      async () => {
        const detail = await agentDetail(f.childToken, created.trigger.id);
        expect(detail.downstreamRuns.map(({ run }) => run.id)).toContain(runId);
        return detail;
      },
    );
  });
  it("A8/F17/F18: refuses invalid next-fire sources, states and instants without writing", async () => {
    const f = await fixture();
    const active = await personCreate(f, f.child);
    const paused = await personCreate(f, f.child);
    const archived = await personCreate(f, f.child);
    await manage(
      f,
      {
        operation: "set_status",
        triggerId: paused.trigger.id,
        status: "paused",
      },
      null,
    );
    await manage(
      f,
      {
        operation: "set_status",
        triggerId: archived.trigger.id,
        status: "archived",
      },
      null,
    );
    const oneShot = await personCreate(f, f.child, {
      kind: "schedule",
      schedule: {
        kind: "at",
        at: nextHour,
      },
    });
    const webhook = await personCreate(f, f.child, {
      kind: "webhook",
    });
    const watch = await personCreate(f, f.child, {
      kind: "watch",
    });
    for (const [label, created, code] of [
      ["paused", paused, "conflict"],
      ["archived", archived, "conflict"],
      ["one-shot", oneShot, "conflict"],
      ["webhook", webhook, "conflict"],
      ["watch", watch, "conflict"],
    ] as const) {
      const before = await personDetail(f, created.trigger.id);
      await denied(`A8/F18 ${label}`, f.child.id, "set_next_fire", code, () =>
        agentTrigger(f.childToken, {
          operation: "set_next_fire",
          triggerId: created.trigger.id,
          nextFireAt: plusThirty,
        }),
      );
      expect(await personDetail(f, created.trigger.id)).toEqual(before);
    }
    for (const instant of ["2040-01-02T07:59:59.999Z", now.toISOString()]) {
      await denied(`A8/F17 non-future ${instant}`, f.child.id, "set_next_fire", "bad_request", () =>
        agentTrigger(f.childToken, {
          operation: "set_next_fire",
          triggerId: active.trigger.id,
          nextFireAt: instant,
        }),
      );
    }
    expect((await personDetail(f, active.trigger.id)).trigger.nextFireAt).toBe(nextHour);
  });
  it("A9/F22: records agent/program/person authors and keeps attribution informational", async () => {
    const f = await fixture();
    const agent = await agentCreate(f.fullChildToken, f.sibling.id);
    const programParent = await personCreate(f, f.fullChild);
    const token = await startProgram(f, programParent);
    const authored = createdSchema.parse(await programTrigger(token, createInput(f.sibling.id)));
    const person = await personCreate(f, f.sibling);
    for (const [label, created, author, update] of [
      ["agent", agent, f.fullChild.id, (input: unknown) => agentTrigger(f.fullChildToken, input)],
      ["program", authored, f.fullChild.id, (input: unknown) => programTrigger(token, input)],
      ["person", person, null, (input: unknown) => manage(f, input, null)],
    ] as const) {
      await check(
        `A9 ${label} creation and revision`,
        author ?? "person",
        "create/update/get",
        {
          createdByThreadId: author,
        },
        async () => {
          expect(created.trigger.createdByThreadId).toBe(author);
          expect(created.revision.createdByThreadId).toBe(author);
          const updated = createdSchema.parse(
            await update({
              operation: "update",
              triggerId: created.trigger.id,
              expectedRevisionId: created.revision.id,
              program: {
                ...program,
                source: `export default () => '${label} revision'`,
              },
            }),
          );
          expect(updated.revision.createdByThreadId).toBe(author);
          const detail = await personDetail(f, created.trigger.id);
          expect(detail.createdByThreadTitle).toBe(author ? f.fullChild.title : null);
          const rows = await database
            .selectFrom("triggerRevisions")
            .select(["createdByThreadId", "ordinal"])
            .where("triggerId", "=", created.trigger.id)
            .orderBy("ordinal")
            .execute();
          expect(rows).toEqual([
            {
              createdByThreadId: author,
              ordinal: 1,
            },
            {
              createdByThreadId: author,
              ordinal: 2,
            },
          ]);
          return {
            trigger: detail.trigger,
            revision: detail.revision,
            createdByThreadTitle: detail.createdByThreadTitle,
            rows,
          };
        },
      );
    }
    await check(
      "F22 attribution does not grant control",
      f.sibling.id,
      "set_status",
      "anchor may control person-created Trigger",
      async () => {
        await agentTrigger(f.siblingToken, {
          operation: "set_status",
          status: "paused",
          triggerId: person.trigger.id,
        });
        const detail = await personDetail(f, person.trigger.id);
        expect(detail.trigger).toMatchObject({
          status: "paused",
          createdByThreadId: null,
        });
        return detail.trigger;
      },
    );
    await check(
      "F22 attribution references clear when an author Thread is deleted",
      "schema",
      "inspect foreign keys",
      "created_by_thread_id references threads(id) on delete set null",
      async () => {
        // Threads are never deleted in production; the column contract is what keeps a
        // deleted author from blocking or dangling, so assert it directly.
        const constraints = await sql<{
          readonly column: string;
          readonly onDelete: string;
          readonly table: string;
        }>`
          select cls.relname as table, att.attname as column, con.confdeltype as "onDelete"
          from pg_constraint con
          join pg_class cls on cls.oid = con.conrelid
          join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any(con.conkey)
          where con.contype = 'f'
            and con.confrelid = 'threads'::regclass
            and att.attname = 'created_by_thread_id'
            and cls.relname in ('triggers', 'trigger_revisions')
          order by cls.relname
        `.execute(database);
        expect(constraints.rows).toEqual([
          {
            column: "created_by_thread_id",
            onDelete: "n",
            table: "trigger_revisions",
          },
          {
            column: "created_by_thread_id",
            onDelete: "n",
            table: "triggers",
          },
        ]);
        return constraints.rows;
      },
    );
  });
  it("A10/F15: observes a committed actor downgrade or anchor upgrade before the shared Thread read", async () => {
    const f = await fixture();
    for (const change of ["actor-downgrade", "anchor-upgrade"] as const) {
      const created = await personCreate(f, f.sibling);
      const fence = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const service = triggerService(triggerStore);
      const actor = change === "actor-downgrade" ? f.fullChild : f.child;
      const input =
        change === "actor-downgrade"
          ? {
              operation: "update",
              triggerId: created.trigger.id,
              expectedRevisionId: created.revision.id,
              program: {
                ...program,
                source: "export default () => 'raced'",
              },
            }
          : {
              operation: "set_next_fire",
              triggerId: created.trigger.id,
              nextFireAt: plusThirty,
            };
      const downgrade = withPersonalTransaction(database, async (transaction) => {
        fence.resolve();
        await withTimeout(release.promise, 5_000, {
          timeoutError: () => new Error("Authority race did not release the personal event fence"),
        });
        await new OpensteerStore(transaction).updateThreadAccessMode({
          accessMode: change === "actor-downgrade" ? "auto" : "full-access",
          requestedBy: f.ownerId,
          threadId: change === "actor-downgrade" ? actor.id : f.sibling.id,
        });
      });
      await withTimeout(fence.promise, 5_000, {
        timeoutError: () => new Error("Authority change did not acquire the personal event fence"),
      });
      const mutation = service.manage(f.ownerId, TriggerControlInputSchema.parse(input), actor.id);
      void mutation.catch(() => undefined);
      try {
        await blockedQuery("deployment_event_state", mutation);
        release.resolve();
        await downgrade;
        await denied(`A10/F15 ${change}`, actor.id, input.operation, "forbidden", () => mutation);
        const detail = await personDetail(f, created.trigger.id);
        expect(detail.trigger.currentRevisionId).toBe(created.revision.id);
        expect(detail.trigger.nextFireAt).toBe(nextHour);
      } finally {
        release.resolve();
        await Promise.allSettled([mutation, downgrade]);
      }
    }
  });
  it("A10: overlapping Trigger delegation and mutation respect Thread-before-Trigger lock order", async () => {
    const f = await fixture();
    const created = await personCreate(f, f.child);
    const token = await startProgram(f, created);
    const barrier = holdQueryResult(
      database,
      (node) => node.includes('"name":"threads"') && node.includes("SelectModifierNode"),
    );
    const peer = new OpensteerStore(barrier.database);
    const peerCommands = new CommandService({
      admission: new KeyedAdmissionQueue({
        maxInFlight: 4,
        maxQueuedBytes: 4_000_000,
        maxQueuedCommands: 64,
      }),
      onExecutionQueued: vi.fn(),
      onDeploymentEvent: vi.fn(),
      store: peer,
    });
    const peerPrograms = new TriggerToolsTestClient({
      ...services,
      store: peer,
      commands: peerCommands,
      tokens: triggerTokens,
      triggers,
    });
    const delegated = peerPrograms.handle(token, {
      type: "thread.delegate",
      task: "Overlapping Trigger delegation",
      title: "Concurrent worker",
      requestId: randomUUID(),
    });
    void delegated.catch(() => undefined);
    let mutation: Promise<unknown> | undefined;
    try {
      await barrier.reached;
      mutation = manage(
        f,
        {
          operation: "set_next_fire",
          triggerId: created.trigger.id,
          nextFireAt: plusThirty,
        },
        f.child.id,
      );
      void mutation.catch(() => undefined);
      await blockedQuery("deployment_event_state", mutation);
      barrier.release();
      await check(
        "A10 delegation and mutation overlap",
        f.child.id,
        "delegate + set_next_fire",
        "both commit; no lock violation",
        async () => {
          const [worker] = await Promise.all([delegated, mutation]);
          if (worker.type !== "thread.delegate.result")
            throw new Error("Expected delegated result");
          expect((await readToolRecords(store, worker.result)).thread.parentThreadId).toBe(
            f.child.id,
          );
          const assignment = await database
            .selectFrom("delegations")
            .select("origin")
            .where("id", "=", worker.result.assignmentId)
            .executeTakeFirstOrThrow();
          expect(assignment.origin).toBe("trigger");
          expect((await personDetail(f, created.trigger.id)).trigger.nextFireAt).toBe(plusThirty);
          expect(barrier.conflicts).toEqual([]);
          return {
            workerThreadId: (await readToolRecords(store, worker.result)).thread.id,
            nextFireAt: plusThirty,
            lockViolations: barrier.conflicts,
          };
        },
      );
    } finally {
      barrier.release();
      await Promise.allSettled([delegated, mutation]);
    }
  });
  it("A11/F19/F20: preserves pending schedule work, suppresses the deferred enqueue and resumes cadence", async () => {
    const f = await fixture();
    const created = await personCreate(f, f.child);
    await agentTrigger(f.childToken, {
      operation: "set_next_fire",
      triggerId: created.trigger.id,
      nextFireAt: "2040-01-02T08:10:00.000Z",
    });
    const first = await triggerStore.claimDueSchedules(new Date("2040-01-02T08:10:00.000Z"));
    expect(first.occurrences).toHaveLength(1);
    await check(
      "A11 pending occurrence preserved",
      f.child.id,
      "set_next_fire + claimDueSchedules",
      "same pending occurrence; deferred enqueue suppressed",
      async () => {
        const pending = first.occurrences[0]!;
        await agentTrigger(f.childToken, {
          operation: "set_next_fire",
          triggerId: created.trigger.id,
          nextFireAt: plusThirty,
        });
        const beforeClaim = await personDetail(f, created.trigger.id);
        expect(beforeClaim.occurrences).toEqual([pending]);
        const deferred = await triggerStore.claimDueSchedules(new Date(plusThirty));
        expect(deferred.occurrences).toEqual([]);
        const detail = await personDetail(f, created.trigger.id);
        expect(detail.occurrences).toEqual([pending]);
        expect(detail.trigger.nextFireAt).toBe(nextHour);
        return {
          pending: detail.occurrences,
          nextFireAt: detail.trigger.nextFireAt,
          enqueued: deferred.occurrences,
        };
      },
    );
    await agentTrigger(f.childToken, {
      operation: "cancel",
      triggerId: created.trigger.id,
    });
    await check(
      "A11 cadence after deferred suppression",
      f.child.id,
      "claimDueSchedules next cron tick",
      nextHour,
      async () => {
        const claimed = await triggerStore.claimDueSchedules(new Date(nextHour));
        expect(claimed.occurrences).toHaveLength(1);
        expect(claimed.occurrences[0]?.event.source).toEqual({
          kind: "schedule",
          scheduledFor: nextHour,
        });
        expect((await personDetail(f, created.trigger.id)).trigger.nextFireAt).toBe(
          "2040-01-02T10:00:00.000Z",
        );
        return claimed;
      },
    );
  });
  it("A11/F20: a schedule claim that commits first keeps its occurrence while rescheduling the following tick", async () => {
    const f = await fixture();
    const created = await personCreate(f, f.child);
    const firstTick = "2040-01-02T08:10:00.000Z";
    await agentTrigger(f.childToken, {
      operation: "set_next_fire",
      triggerId: created.trigger.id,
      nextFireAt: firstTick,
    });
    const barrier = holdQueryResult(
      database,
      (node) => node.includes('"name":"triggers"') && node.includes('"kind":"UpdateQueryNode"'),
    );
    const claimed = new TriggerStore(barrier.database).claimDueSchedules(new Date(firstTick));
    void claimed.catch(() => undefined);
    let mutation: Promise<unknown> | undefined;
    try {
      await barrier.reached;
      mutation = manage(
        f,
        {
          operation: "set_next_fire",
          triggerId: created.trigger.id,
          nextFireAt: plusThirty,
        },
        f.child.id,
      );
      void mutation.catch(() => undefined);
      await blockedQuery("deployment_event_state", mutation);
      barrier.release();
      await check(
        "A11 claim commits before reschedule",
        f.child.id,
        "claim + set_next_fire",
        "claimed occurrence retained; following tick moved",
        async () => {
          const [claim] = await Promise.all([claimed, mutation]);
          expect(claim.occurrences).toHaveLength(1);
          expect(claim.occurrences[0]?.event.source).toEqual({
            kind: "schedule",
            scheduledFor: firstTick,
          });
          const detail = await personDetail(f, created.trigger.id);
          expect(detail.occurrences).toEqual(claim.occurrences);
          expect(detail.trigger.nextFireAt).toBe(plusThirty);
          expect(barrier.conflicts).toEqual([]);
          return {
            occurrences: detail.occurrences,
            nextFireAt: detail.trigger.nextFireAt,
          };
        },
      );
    } finally {
      barrier.release();
      await Promise.allSettled([claimed, mutation]);
    }
  });
  it("F21: earlier ticks, name/program edits, repeated active, source edits and real resume keep their clock contracts", async () => {
    const f = await fixture();
    const created = await agentCreate(f.fullChildToken, f.fullChild.id);
    await check("F21 move tick earlier", f.fullChild.id, "set_next_fire", plusThirty, async () => {
      await agentTrigger(f.fullChildToken, {
        operation: "set_next_fire",
        triggerId: created.trigger.id,
        nextFireAt: plusThirty,
      });
      const detail = await personDetail(f, created.trigger.id);
      expect(detail.trigger.nextFireAt).toBe(plusThirty);
      return detail.trigger;
    });
    let revisionId = created.revision.id;
    for (const patch of [
      {
        name: "Renamed",
      },
      {
        program: {
          ...program,
          source: "export default () => 'edited'",
        },
      },
    ]) {
      await check(
        "F21 name/program preserves tick",
        f.fullChild.id,
        "update",
        plusThirty,
        async () => {
          const updated = createdSchema.parse(
            await agentTrigger(f.fullChildToken, {
              operation: "update",
              expectedRevisionId: revisionId,
              triggerId: created.trigger.id,
              ...patch,
            }),
          );
          revisionId = updated.revision.id;
          expect(updated.trigger.nextFireAt).toBe(plusThirty);
          return updated;
        },
      );
    }
    await check(
      "F21 repeated active preserves tick",
      f.fullChild.id,
      "set_status active",
      plusThirty,
      async () => {
        await agentTrigger(f.fullChildToken, {
          operation: "set_status",
          status: "active",
          triggerId: created.trigger.id,
        });
        const detail = await personDetail(f, created.trigger.id);
        expect(detail.trigger.nextFireAt).toBe(plusThirty);
        return detail.trigger;
      },
    );
    await check(
      "F21 source edit resets tick",
      f.fullChild.id,
      "update source",
      "2040-01-02T08:15:00.000Z",
      async () => {
        const updated = createdSchema.parse(
          await agentTrigger(f.fullChildToken, {
            operation: "update",
            expectedRevisionId: revisionId,
            triggerId: created.trigger.id,
            source: {
              kind: "schedule",
              schedule: {
                kind: "cron",
                expression: "15 * * * *",
                timezone: "UTC",
              },
            },
          }),
        );
        expect(updated.trigger.nextFireAt).toBe("2040-01-02T08:15:00.000Z");
        return updated;
      },
    );
    await check(
      "F21 real resume resets deferred tick",
      f.fullChild.id,
      "set_next_fire; pause; resume",
      "2040-01-02T08:15:00.000Z",
      async () => {
        await agentTrigger(f.fullChildToken, {
          operation: "set_next_fire",
          triggerId: created.trigger.id,
          nextFireAt: "2040-01-02T12:30:00.000Z",
        });
        await agentTrigger(f.fullChildToken, {
          operation: "set_status",
          triggerId: created.trigger.id,
          status: "paused",
        });
        await agentTrigger(f.fullChildToken, {
          operation: "set_status",
          triggerId: created.trigger.id,
          status: "active",
        });
        const detail = await personDetail(f, created.trigger.id);
        expect(detail.trigger.nextFireAt).toBe("2040-01-02T08:15:00.000Z");
        return detail.trigger;
      },
    );
  });
  it("F16c/F17/F24: real MCP sessions filter program tools and reject stray flat Trigger fields", async () => {
    const f = await fixture();
    const childTrigger = await personCreate(f, f.fullChild);
    const childProgram = await startProgram(f, childTrigger);
    const chatTrigger = await personCreate(f, f.root);
    const chatProgram = await startProgram(f, chatTrigger);
    const watch = await personCreate(f, f.crossChild, {
      kind: "watch",
    });
    const watchToken = await startWatch(f, watch);
    const endpoint = await mcpEndpoint();
    const childClient = await connectMcp(endpoint, childProgram);
    const chatClient = await connectMcp(endpoint, chatProgram);
    const watchClient = await connectMcp(endpoint, watchToken);
    for (const [label, actor, client] of [
      ["delegated Trigger", f.fullChild, childClient],
      ["Root task Trigger", f.root, chatClient],
      ["delegated Watch", f.crossChild, watchClient],
    ] as const) {
      const expectedNames = toolsFor({
        kind: "program",
        accessMode: actor.accessMode,
      }).map((t) => t.name);
      await check(
        `F16c ${label} tools`,
        actor.id,
        "MCP tools/list",
        [...expectedNames].sort(),
        async () => {
          const names = (await client.listTools()).tools.map(({ name }) => name).sort();
          expect(names).toEqual([...expectedNames].sort());

          return names;
        },
      );
    }
    for (const args of [
      {
        action: "set_status",
        triggerId: childTrigger.trigger.id,
        status: "paused",
        nextFireAt: plusThirty,
      },
      {
        action: "set_next_fire",
        triggerId: childTrigger.trigger.id,
        nextFireAt: plusThirty,
        status: "paused",
      },
      {
        action: "set_next_fire",
        triggerId: childTrigger.trigger.id,
      },
      {
        action: "set_next_fire",
        triggerId: childTrigger.trigger.id,
        nextFireAt: plusThirty,
        name: "stray",
      },
      {
        action: "run",
        triggerId: childTrigger.trigger.id,
        nextFireAt: plusThirty,
      },
      {
        action: "cancel",
        triggerId: childTrigger.trigger.id,
        program,
      },
    ]) {
      await check(
        `F17 MCP stray/missing ${JSON.stringify(args)}`,
        f.fullChild.id,
        "MCP trigger_write",
        "tool error; no mutation",
        async () => {
          const before = await personDetail(f, childTrigger.trigger.id);
          const result = await childClient.callTool({
            name: "trigger_write",
            arguments: args,
          });
          expect(result.isError).toBe(true);
          expect(result.content).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "text",
                text: expect.stringMatching(
                  /(nextFireAt|status|name|program|accept|require|field)/i,
                ),
              }),
            ]),
          );
          expect(await personDetail(f, childTrigger.trigger.id)).toEqual(before);
          return result;
        },
      );
    }
    await check(
      "F17 MCP valid set_next_fire",
      f.fullChild.id,
      "MCP trigger_write",
      plusThirty,
      async () => {
        const result = await childClient.callTool({
          name: "trigger_write",
          arguments: {
            action: "set_next_fire",
            triggerId: childTrigger.trigger.id,
            nextFireAt: plusThirty,
          },
        });
        expect(result.isError).not.toBe(true);
        expect((await personDetail(f, childTrigger.trigger.id)).trigger.nextFireAt).toBe(
          plusThirty,
        );
        return result;
      },
    );
  });
  it.each([3] as const)(
    "dispatches only supported version %s after an anchor computer downgrade",
    async (version) => {
      const f = await fixture();
      const identity = {
        runnerId: f.runnerId,
        bootId: "authority-boot",
        connectionGeneration: 1,
        capabilities: ["execution-plane-v2", "agent-tools-plan-v1"],
        modules: {
          agents: {},
        },
      } as unknown as RunnerIdentity;
      const dispatch = vi.fn<RunnerRegistry["dispatch"]>(async (command) => ({
        type: "runner.command-accepted",
        commandId: command.commandId,
        correlationId: command.correlationId,
      }));
      const runnerRegistry = {
        identityForEnvironment: () => identity,
        dispatch,
      } as unknown as RunnerRegistry;
      const dispatcher = new HostCommandDispatcher({
        store,
        triggers: triggerStore,
        runners: runnerRegistry,
        executionLeaseMs: 90_000,
        publicUrl: new URL("https://host.test"),
        onDeploymentEvent: vi.fn(),
        requestResponseVault: {} as never,
        runToolTokens: {} as never,
        attachmentRunTokens: {} as never,
        attachments: {
          listForRun: async () => [],
        },
        browser: {
          hasBrowserProfiles: async () => false,
        },
        egress: {} as never,
        pluginVersions: async () => [],
        pluginsTokens: {} as never,
        triggerControlTokens: {
          issue: () => "control",
        } as never,
        folders: { assertAvailable: (folder) => folders.assertAvailable(folder) },
        teamRequestContext: async () => {
          throw new Error("Unexpected team request");
        },
      });
      for (const ingress of ["manual", "schedule", "webhook"] as const) {
        await database
          .updateTable("runners")
          .set({
            capabilities: sql<
              RunnerDescriptor["capabilities"]
            >`${JSON.stringify(["filesystem", "trigger-program-v3"])}::jsonb`,
          })
          .where("id", "=", f.runnerId)
          .execute();
        const saved = await personCreate(
          f,
          f.root,
          ingress === "webhook"
            ? {
                kind: "webhook",
              }
            : cron,
          {
            ...program,
            toolContractVersion: version,
          },
        );
        await database
          .updateTable("runners")
          .set({
            capabilities: sql<
              RunnerDescriptor["capabilities"]
            >`${JSON.stringify(["filesystem", "browser-profile-create-v1"])}::jsonb`,
          })
          .where("id", "=", f.runnerId)
          .execute();
        if (version === 3) {
          await expect(
            triggers.update(
              f.ownerId,
              {
                triggerId: saved.trigger.id,
                expectedRevisionId: saved.revision.id,
                name: "Unsupported retained v3",
              },
              null,
            ),
          ).rejects.toMatchObject({
            message:
              "This computer's Runner cannot run Trigger program version 3. Use version 2 or update that computer.",
          });
        }
        const occurrence =
          ingress === "manual"
            ? await triggers.run(
                f.ownerId,
                saved.trigger.id,
                {
                  ingress,
                },
                null,
              )
            : ingress === "webhook"
              ? (
                  await triggerStore.enqueueWebhook({
                    routeKey: (await personDetail(f, saved.trigger.id)).trigger.webhookRouteKey!,
                    method: "POST",
                    headers: {},
                    payload: {
                      ingress,
                    },
                  })
                ).occurrence
              : (await triggerStore.claimDueSchedules(new Date(nextHour))).occurrences.find(
                  ({ triggerId }) => triggerId === saved.trigger.id,
                )!;
        expect(occurrence).toBeDefined();
        const coordinator = new ExecutionCoordinator({
          dispatcher,
          dispatcherId: "trigger-compatibility",
          maxConcurrentRuns: 1,
          maxConcurrentTriggerPrograms: 1,
          maxQueuedBytes: 1_000_000,
          maxQueuedCommands: 8,
          store: {
            listPendingCommands: async () =>
              (await store.listPendingCommands()).filter(({ id }) => id === occurrence.commandId),
            claimCommand: store.claimCommand.bind(store),
            failCommand: store.failCommand.bind(store),
            retryCommand: store.retryCommand.bind(store),
            markSteerUnknown: store.markSteerUnknown.bind(store),
          },
        });
        // Only the occurrence lane is involved; no engine processes are started.
        vi.spyOn(dispatcher, "isAvailable").mockReturnValue(true);
        try {
          await check(
            "Runner downgrade dispatch",
            ingress,
            `version ${version}`,
            version === 3 ? "failed without send" : "unchanged send",
            async () => {
              dispatch.mockClear();
              coordinator.start();
              await vi.waitFor(async () => {
                const detail = await personDetail(f, saved.trigger.id);
                expect(detail.occurrences[0]?.status).toBe(version === 3 ? "failed" : "running");
              });
              const detail = await personDetail(f, saved.trigger.id);
              if (version === 3) {
                expect(dispatch).not.toHaveBeenCalled();
                expect(detail.occurrences[0]?.error).toEqual({
                  code: "dispatch_failed",
                  status: "failed",
                  retryable: false,
                  message:
                    "This computer's Runner cannot run Trigger program version 3. Use version 2 or update that computer.",
                });
              } else {
                expect(dispatch).toHaveBeenCalledOnce();
                expect(dispatch).toHaveBeenCalledWith(
                  expect.objectContaining({
                    type: "trigger.execute",
                    context: expect.objectContaining({
                      program: saved.revision.program,
                    }),
                  }),
                  expect.any(AbortSignal),
                );
              }
              return detail;
            },
          );
        } finally {
          await coordinator.stop();
        }
        await triggers.setStatus(
          f.ownerId,
          {
            triggerId: saved.trigger.id,
            status: "paused",
          },
          null,
        );
      }
    },
  );
  it.each([3] as const)(
    "reconciles Watch version %s against an old stored advertisement",
    async (version) => {
      const f = await fixture();
      const saved = await personCreate(
        f,
        f.fullChild,
        {
          kind: "watch",
        },
        {
          ...program,
          toolContractVersion: version,
        },
      );
      await database
        .updateTable("runners")
        .set({
          capabilities: sql<
            RunnerDescriptor["capabilities"]
          >`${JSON.stringify(["filesystem", "agent-tools-plan-v1"])}::jsonb`,
        })
        .where("id", "=", f.runnerId)
        .execute();
      const identity = {
        runnerId: f.runnerId,
        bootId: "authority-boot",
        connectionGeneration: 1,
        capabilities: ["agent-tools-plan-v1"],
        modules: {
          agents: {},
        },
      } as unknown as RunnerIdentity;
      const reconcileWatches = vi.fn<WatchServiceOptions["runners"]["reconcileWatches"]>(
        async () => undefined,
      );
      const service = new WatchService({
        runnerStore: store,
        store: triggerStore,
        runners: {
          identityForEnvironment: () => identity,
          reconcileWatches,
        },
        browser: {
          hasBrowserProfiles: async () => false,
        },
        folders: { assertAvailable: (folder) => folders.assertAvailable(folder) },
        browserCdpUrl: "wss://host.test",
        controlTokens: {
          issue: () => ({
            token: "control",
            expiresAt: nextHour,
          }),
        },
        watchBrowserTokens: {
          issue: () => ({
            token: "browser",
            expiresAt: nextHour,
          }),
        },
        mcpUrl: "https://host.test",
        onChanged: vi.fn(),
        onError: vi.fn(),
      });
      try {
        await check(
          "Runner downgrade Watch",
          "Host reconciliation",
          `version ${version}`,
          version === 3 ? "backoff without activation" : "activation sent",
          async () => {
            await service.reconcile(f.environmentId);
            const desired = reconcileWatches.mock.calls[0]?.[2];
            const detail = await personDetail(f, saved.trigger.id);
            if (version === 3) {
              expect(desired).toEqual([]);
              expect(detail.activation).toMatchObject({
                observed: "backoff",
                lastError:
                  "This computer's Runner cannot run Trigger program version 3. Use version 2 or update that computer.",
              });
            } else {
              expect(desired).toEqual([
                expect.objectContaining({
                  triggerId: saved.trigger.id,
                }),
              ]);
              expect(detail.activation?.lastError).toBeNull();
            }
            return {
              desired,
              detail,
            };
          },
        );
      } finally {
        await service.close();
      }
    },
  );
  it("admits v3 create/update through both current MCP and person commands", async () => {
    const f = await fixture(undefined, {
      rootAccessMode: "full-access",
    });
    const context = {
      session: {
        user: {
          id: f.ownerId,
        },
      },
    } as unknown as HostApiServerContext;
    const code = {
      ...program,
      toolContractVersion: 3 as const,
    };
    const client = await connectMcp(await mcpEndpoint(), f.rootToken);
    await check(
      "v3 current Runner admission",
      "person and agent",
      "create/update",
      "v3 retained",
      async () => {
        const person = createdSchema.parse(
          await handleTriggerCommand(
            triggers,
            {
              type: "trigger.create",
              idempotencyKey: randomUUID(),
              input: {
                anchorThreadId: f.root.id,
                name: "Current person v3",
                program: code,
                source: cron,
              },
            },
            context,
          ),
        );
        const updated = createdSchema.parse(
          await handleTriggerCommand(
            triggers,
            {
              type: "trigger.update",
              idempotencyKey: randomUUID(),
              triggerId: person.trigger.id,
              input: {
                expectedRevisionId: person.revision.id,
                program: {
                  ...code,
                  source: "export default () => 'current'",
                },
              },
            },
            context,
          ),
        );
        expect(updated.revision.program.toolContractVersion).toBe(3);
        const mcp = await client.callTool({
          name: "trigger_write",
          arguments: {
            action: "create",
            anchorThreadId: f.root.id,
            name: "Current agent v3",
            program: code,
            source: {
              kind: "schedule",
              cron: "0 * * * *",
              timezone: "UTC",
            },
          },
        });
        expect(mcp.isError).not.toBe(true);
        const saved = createdSchema.parse(mcp.structuredContent);
        const changed = await client.callTool({
          name: "trigger_write",
          arguments: {
            action: "update",
            triggerId: saved.trigger.id,
            expectedRevisionId: saved.revision.id,
            program: {
              ...code,
              source: "export default () => 'MCP current'",
            },
          },
        });
        expect(changed.isError).not.toBe(true);
        expect(
          createdSchema.parse(changed.structuredContent).revision.program.toolContractVersion,
        ).toBe(3);
        return {
          person: updated,
          agent: changed,
        };
      },
    );
  });
  it.each([
    {
      capabilities: [],
    },
    {
      capabilities: ["browser-profile-create-v1"],
    },
  ] as const)(
    "refuses v3 admission for old stored advertisements %j through commands and MCP",
    async ({ capabilities }) => {
      const f = await fixture([...capabilities], {
        rootAccessMode: "full-access",
      });
      const context = {
        session: {
          user: {
            id: f.ownerId,
          },
        },
      } as unknown as HostApiServerContext;
      const code = {
        ...program,
        toolContractVersion: 3 as const,
      };
      const reason =
        "This computer's Runner cannot run Trigger program version 3. Use version 2 or update that computer.";
      const endpoint = await mcpEndpoint();
      const client = await connectMcp(endpoint, f.rootToken);
      await check(
        "v3 old Runner admission",
        "person and agent",
        "create/update",
        reason,
        async () => {
          await expect(
            handleTriggerCommand(
              triggers,
              {
                type: "trigger.create",
                idempotencyKey: randomUUID(),
                input: {
                  anchorThreadId: f.root.id,
                  name: "Unsupported v3",
                  program: code,
                  source: cron,
                },
              },
              context,
            ),
          ).rejects.toMatchObject({
            message: reason,
          });
          // Current session can target an old computer: the domain must refuse it even
          // when the authoring session itself advertises the current input schema.
          const currentClient = await connectMcp(await mcpEndpoint(false), f.rootToken);
          const refused = await currentClient.callTool({
            name: "trigger_write",
            arguments: {
              action: "create",
              anchorThreadId: f.root.id,
              name: "Unsupported MCP v3",
              program: code,
              source: {
                kind: "schedule",
                cron: "0 * * * *",
                timezone: "UTC",
              },
            },
          });
          expect(refused.isError).toBe(true);
          expect(JSON.stringify(refused)).toContain(reason);
          await database
            .updateTable("runners")
            .set({
              capabilities: sql<
                RunnerDescriptor["capabilities"]
              >`${JSON.stringify(["trigger-program-v3"])}::jsonb`,
            })
            .where("id", "=", f.runnerId)
            .execute();
          const saved = await personCreate(f, f.root, cron, program);
          await database
            .updateTable("runners")
            .set({
              capabilities: sql<
                RunnerDescriptor["capabilities"]
              >`${JSON.stringify(capabilities)}::jsonb`,
            })
            .where("id", "=", f.runnerId)
            .execute();
          const before = await personDetail(f, saved.trigger.id);
          await expect(
            handleTriggerCommand(
              triggers,
              {
                type: "trigger.update",
                idempotencyKey: randomUUID(),
                triggerId: saved.trigger.id,
                input: {
                  expectedRevisionId: saved.revision.id,
                  program: code,
                },
              },
              context,
            ),
          ).rejects.toMatchObject({
            message: reason,
          });
          const refusedUpdate = await currentClient.callTool({
            name: "trigger_write",
            arguments: {
              action: "update",
              triggerId: saved.trigger.id,
              expectedRevisionId: saved.revision.id,
              program: code,
            },
          });
          expect(refusedUpdate.isError).toBe(true);
          expect(JSON.stringify(refusedUpdate)).toContain(reason);
          expect(await personDetail(f, saved.trigger.id)).toEqual(before);
          const legacyTool = (await client.listTools()).tools.find(
            ({ name }) => name === "trigger_write",
          );
          expect(legacyTool?.description).toContain("load opensteer:triggers");
          return {
            refused,
            capabilities,
          };
        },
      );
    },
  );

  async function fixture(
    capabilities: RunnerDescriptor["capabilities"] = [
      "filesystem",
      "environment-list-v1",
      "trigger-program-v3",
    ],
    options: { readonly rootAccessMode?: Thread["accessMode"] } = {},
  ) {
    const directory = join(evidenceRoot, randomUUID());
    await mkdir(directory, { recursive: true });
    const personal = await seedPersonalFixture(database, await realpath(directory));
    const { userId: ownerId, runnerId, environmentId, agentHome } = personal;
    folders = personalTestFolders(store, personal);
    await database
      .updateTable("runners")
      .set({
        capabilities: sql<RunnerDescriptor["capabilities"]>`${JSON.stringify(capabilities)}::jsonb`,
        maxConcurrentRuns: 16,
      })
      .where("id", "=", runnerId)
      .execute();
    const harness = await store.createHarnessInstance({
      config: {
        model: "test",
      },
      driverKind: HarnessIdSchema.parse("native"),
      environmentId,
      name: "Native",
      sourceId: "native",
      stateKind: "isolated",
    });
    await store.recordHarnessCatalogs({
      environmentId,
      catalogs: [testReadyHarnessCatalog(harness.id)],
      expectedRevisions: new Map([[harness.id, harness.runtimeRevision]]),
    });
    const base = {
      ...personal,
      ownerId,
      environmentId,
      runnerId,
      harnessInstanceId: harness.id,
    };
    const { thread: root } = await store.createThread({
      accessMode: options.rootAccessMode ?? "auto",
      createdBy: ownerId,
      folder: agentHome,
      environmentId,
      harnessInstanceId: harness.id,
      idempotencyKey: randomUUID(),
      modelSelection,
      title: "Root task",
    });
    const rootExecution = await activate(base, root);
    async function child(
      title: string,
      accessMode: Thread["accessMode"],
      parent = root,
      parentRunId = rootExecution.run.id,
    ) {
      const result = await store.delegateThread({
        accessMode,
        folder: agentHome,
        createdBy: ownerId,
        environmentId,
        harnessInstanceId: harness.id,
        idempotencyKey: randomUUID(),
        modelSelection,
        origin: {
          kind: "run",
          parentThreadId: parent.id,
          parentRunId,
        },
        task: [
          {
            type: "text",
            text: title,
          },
        ],
        title,
        titleSource: "chosen",
      });
      return result.thread;
    }
    const delegated = await child("Delegated worker", "auto");
    const sibling = await child("Sibling sibling", "auto");
    const crossChild = await child("Independent sibling", "auto");
    const { thread: specialist } = await store.createThread({
      accessMode: "full-access",
      createdBy: ownerId,
      folder: agentHome,
      environmentId,
      harnessInstanceId: harness.id,
      idempotencyKey: randomUUID(),
      modelSelection,
      title: "Specialist root",
    });
    const { thread: unrelated } = await store.createThread({
      accessMode: "approval-required",
      createdBy: ownerId,
      folder: agentHome,
      environmentId,
      harnessInstanceId: harness.id,
      idempotencyKey: randomUUID(),
      modelSelection,
      title: "Unrelated work Thread",
    });
    const childExecution = await activate(base, delegated);
    const siblingExecution = await activate(base, sibling);
    const specialistExecution = await activate(base, specialist);
    const fullChild = await child(
      "Full-access author",
      "full-access",
      specialist,
      specialistExecution.run.id,
    );
    const fullExecution = await activate(base, fullChild);
    const { thread: isolatedChild } = await store.delegateThread({
      accessMode: "auto",
      createdBy: ownerId,
      folder: agentHome,
      environmentId,
      harnessInstanceId: harness.id,
      idempotencyKey: randomUUID(),
      modelSelection,
      origin: {
        kind: "run",
        parentThreadId: specialist.id,
        parentRunId: specialistExecution.run.id,
      },
      task: [
        {
          type: "text",
          text: "Work outside Root task's delegation lineage",
        },
      ],
      title: "Specialist's delegated worker",
      titleSource: "chosen",
    });
    expect(crossChild.lineageRootThreadId).toBe(root.id);
    expect(isolatedChild.lineageRootThreadId).toBe(specialist.id);
    expect(unrelated.lineageRootThreadId).not.toBe(root.id);
    return {
      ...base,
      root,
      child: delegated,
      fullChild,
      sibling,
      crossChild,
      isolatedChild,
      specialist,
      unrelated,
      rootToken: rootExecution.token,
      childToken: childExecution.token,
      fullChildToken: fullExecution.token,
      siblingToken: siblingExecution.token,
      specialistToken: specialistExecution.token,
    };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function activate(
    f: Pick<Fixture, "ownerId" | "environmentId" | "runnerId" | "harnessInstanceId">,
    thread: Thread,
  ) {
    let run = await database
      .selectFrom("runs")
      .select("id")
      .where("threadId", "=", thread.id)
      .where("status", "=", "queued")
      .executeTakeFirst();
    if (!run) {
      const queued = await commands.enqueueThreadInput({
        content: [
          {
            type: "text",
            text: "Exercise Trigger authority",
          },
        ],
        idempotencyKey: randomUUID(),
        policy: "queue",
        requestedBy: f.ownerId,
        source: {
          kind: "human",
        },
        threadId: thread.id,
      });
      if (!queued.run) throw new Error("Expected fixture Run");
      run = queued.run;
    }
    const command = await database
      .selectFrom("commands")
      .select("id")
      .where("runId", "=", run.id)
      .where("type", "=", "run.execute")
      .executeTakeFirstOrThrow();
    await store.claimCommand(command.id, "trigger-authority-dispatcher");
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date("2040-01-02T12:00:00.000Z"),
      continuationIdentity: {
        continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
        driverKind: HarnessIdSchema.parse("native"),
      },
      harnessInstanceId: f.harnessInstanceId,
      leaseTokenHash: `lease-${randomUUID()}`,
      runnerBootId: "authority-boot",
      runnerId: f.runnerId,
      runId: run.id,
      threadId: thread.id,
    });
    await store.commitRunnerEvent({
      environmentId: f.environmentId,
      event: {
        bindingGeneration: binding.bindingGeneration,
        data: {
          status: "running",
        },
        emittedAt: now.toISOString(),
        environmentId: f.environmentId,
        ordinal: 0,
        runId: run.id,
        threadId: thread.id,
        type: "run.started",
      },
      runnerBootId: "authority-boot",
      runnerId: f.runnerId,
    });
    const token = `run-${randomUUID()}`;
    runClaims.set(token, {
      ...signedClaims(),
      aud: "opensteer-run-tools",
      bindingGeneration: binding.bindingGeneration,
      environmentId: f.environmentId,
      requestedBy: f.ownerId,
      runId: run.id,
      runnerBootId: "authority-boot",
      runnerId: f.runnerId,
      threadId: thread.id,
    });
    return {
      run: run as Pick<Run, "id">,
      token,
    };
  }
  function manage(f: Fixture, input: unknown, actorThreadId: ThreadId | null) {
    return triggers.manage(f.ownerId, TriggerControlInputSchema.parse(input), actorThreadId);
  }
  async function personCreate(
    f: Fixture,
    anchor: Thread,
    source: TriggerSource = cron,
    code: TriggerProgram = program,
  ) {
    return createdSchema.parse(
      await manage(
        f,
        {
          ...createInput(anchor.id),
          source,
          program: code,
        },
        null,
      ),
    );
  }
  async function agentCreate(token: string, anchor: string) {
    return createdSchema.parse(await agentTrigger(token, createInput(anchor)));
  }
  function createInput(anchorThreadId: string) {
    return {
      anchorThreadId,
      idempotencyKey: randomUUID(),
      name: "Authority acceptance Trigger",
      operation: "create",
      program,
      source: cron,
    };
  }
  async function agentTrigger(token: string, input: unknown) {
    return controlTrigger(agents, token, input);
  }
  async function programTrigger(token: string, input: unknown) {
    return controlTrigger(programs, token, input);
  }
  async function controlTrigger(
    control: {
      handle(token: string, input: unknown): Promise<ProductToolResult>;
    },
    token: string,
    input: unknown,
  ) {
    const parsed = TriggerControlInputSchema.parse(input);
    const response = await control.handle(token, {
      input: parsed,
      requestId: randomUUID(),
      tool:
        parsed.operation === "get" || parsed.operation === "list"
          ? "trigger.read"
          : "trigger.write",
      type: "trigger.control",
    });
    if (response.type !== "trigger.control.result")
      throw new Error("Expected Trigger control result");
    return response.result;
  }
  async function agentDetail(token: string, triggerId: TriggerId) {
    return hostApi["triggers.get"].success
      .extend({
        trigger: z.object(
          TriggerSchema.omit({
            webhookRouteKey: true,
          }).shape,
        ),
      })
      .parse(
        await agentTrigger(token, {
          operation: "get",
          triggerId,
          occurrenceLimit: 100,
        }),
      );
  }
  async function personDetail(f: Fixture, triggerId: TriggerId) {
    return hostApi["triggers.get"].success.parse(
      await manage(
        f,
        {
          operation: "get",
          triggerId,
          occurrenceLimit: 100,
        },
        null,
      ),
    );
  }
  async function startProgram(f: Fixture, created: Created) {
    const result = z
      .object({
        occurrence: z.object({
          id: z.string(),
        }),
      })
      .parse(
        await manage(
          f,
          {
            operation: "run",
            triggerId: created.trigger.id,
          },
          null,
        ),
      );
    const occurrence = await database
      .selectFrom("triggerOccurrences")
      .selectAll()
      .where("id", "=", result.occurrence.id as TriggerOccurrence["id"])
      .executeTakeFirstOrThrow();
    await store.claimCommand(occurrence.commandId, "trigger-authority-program-dispatcher");
    const started = await triggerStore.startExecution({
      commandId: occurrence.commandId,
      runnerBootId: "authority-boot",
      runnerId: f.runnerId,
    });
    const anchor = await store.getThreadForOwner(created.trigger.anchorThreadId, f.ownerId);
    if (!anchor) throw new Error("Missing program anchor");
    const token = `program-${randomUUID()}`;
    occurrenceClaims.set(token, {
      ...signedClaims(),
      aud: "opensteer-trigger-control",
      environmentId: f.environmentId,
      executionGeneration: started.executionGeneration,
      occurrenceId: occurrence.id,
      requestedBy: f.ownerId,
      runnerBootId: "authority-boot",
      runnerId: f.runnerId,
      threadId: anchor.id,
      toolContractVersion: created.revision.program.toolContractVersion,
    });
    return token;
  }
  async function startWatch(f: Fixture, created: Created) {
    const reconciled = await triggerStore.reconcileWatchesForRunner({
      environmentId: f.environmentId,
      leaseExpiresAt: new Date("2040-01-02T12:00:00.000Z"),
      runnerBootId: "authority-boot",
      runnerConnectionGeneration: 1,
      runnerId: f.runnerId,
    });
    const active = reconciled.activations.find(
      ({ activation }) => activation.triggerId === created.trigger.id,
    )?.activation;
    if (!active) throw new Error("Expected active Watch fixture");
    const token = `watch-${randomUUID()}`;
    watchClaims.set(token, {
      ...signedClaims(),
      aud: "opensteer-watch-control",
      activationId: active.id,
      anchorThreadId: created.trigger.anchorThreadId,
      createdBy: f.ownerId,
      environmentId: f.environmentId,
      executionGeneration: active.executionGeneration,
      revisionId: created.revision.id,
      triggerId: created.trigger.id,
      toolContractVersion: created.revision.program.toolContractVersion,
    });
    return token;
  }

  // The database's lock-race helper is private to its package. This barrier
  // observes query completion without replacing a store or a SQL operation.
  function holdQueryResult(connection: typeof database, matches: (query: string) => boolean) {
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const conflictStart = recordedTransactionConflicts.length;
    let heldQuery: object | undefined;
    let held = false;
    return {
      reached: reached.promise,
      release: () => release.resolve(),
      get conflicts() {
        return recordedTransactionConflicts.slice(conflictStart);
      },
      database: connection.withPlugin({
        transformQuery(args) {
          if (!held && heldQuery === undefined && matches(JSON.stringify(args.node)))
            heldQuery = args.queryId;
          return args.node;
        },
        async transformResult(args) {
          if (!held && args.queryId === heldQuery) {
            held = true;
            reached.resolve();
            await release.promise;
          }
          return args.result;
        },
      }),
    };
  }

  // Observe PostgreSQL's actual wait graph; ordering never depends on a timer.
  async function blockedQuery(
    table: "threads" | "triggers" | "deployment_event_state",
    mutation: Promise<unknown>,
  ) {
    const observed = vi.waitFor(
      async () => {
        const blocked = await sql<{
          query: string;
        }>`select query from pg_stat_activity where datname=current_database() and application_name=${applicationName} and wait_event_type='Lock' and cardinality(pg_blocking_pids(pid))>0`.execute(
          database,
        );
        expect(
          blocked.rows.some(({ query }) => query.includes(table)),
          `Mutation never waited for the held ${table} lock`,
        ).toBe(true);
      },
      { timeout: 5_000 },
    );
    await Promise.race([
      observed,
      mutation.then(() => {
        throw new Error(`Mutation committed before the held ${table} lock was released`);
      }),
    ]);
  }
  async function mcpEndpoint(_legacyOverride?: boolean) {
    let service: OpensteerMcpService;
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body: unknown = chunks.length
          ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
          : undefined;
        const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
        await service.handle(request, response, body, token);
      })().catch((error: unknown) =>
        response.destroy(error instanceof Error ? error : new Error("MCP request failed")),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("MCP server did not bind");
    const url = new URL(`http://127.0.0.1:${address.port}/internal/v1/mcp`);
    service = new OpensteerMcpService({
      publicUrl: url,
      store: store,
      handlers: agents.service.options.handlers,
      callers: new AgentCallerResolver({
        store: store,
        runs: tokens,
        triggers: triggerTokens,
        watches: watchTokens,
      }),
    });
    mcpServices.push(service);
    return url;
  }
  async function connectMcp(url: URL, token: string) {
    const client = new Client({
      name: "trigger-authority-acceptance",
      version: "1.0.0",
    });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      }) as unknown as Transport,
    );
    return client;
  }
});
function signedClaims() {
  return {
    exp: Math.floor(now.getTime() / 1_000) + 14_400,
    iat: Math.floor(now.getTime() / 1_000),
    iss: "opensteer-host" as const,
    jti: randomUUID(),
  };
}
function claimsFor<Claims>(claims: Map<string, Claims>, token: string): Claims {
  const result = claims.get(token);
  if (!result) throw new Error("Unknown test capability token");
  return result;
}
async function unexpected(): Promise<never> {
  throw new Error("Unexpected service call in Trigger authority journey");
}
async function check<Result>(
  scenario: string,
  actor: string,
  operation: string,
  expected: unknown,
  run: () => Promise<Result>,
): Promise<Result> {
  const item: Evidence = {
    scenario,
    actor,
    operation,
    expected,
    observed: null,
  };
  evidence.push(item);
  try {
    const observed = await run();
    item.observed = observed;
    return observed;
  } catch (error) {
    item.observed =
      error instanceof Error
        ? {
            name: error.name,
            message: error.message,
            ...(error instanceof OpensteerError
              ? {
                  code: error.code,
                }
              : {}),
          }
        : error;
    throw error;
  }
}
async function denied(
  scenario: string,
  actor: string,
  operation: string,
  code: "forbidden" | "not_found" | "conflict" | "bad_request",
  run: () => Promise<unknown>,
) {
  return check(
    scenario,
    actor,
    operation,
    {
      code,
    },
    async () => {
      let caught: unknown;
      try {
        await run();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(OpensteerError);
      if (!(caught instanceof OpensteerError)) throw new Error("Expected an Opensteer error");
      expect(caught.code).toBe(code);
      expect(caught.message.trim().length).toBeGreaterThan(0);
      if (code === "not_found") expect(caught.message).toBe("Trigger not found");
      return {
        code: caught.code,
        message: caught.message,
      };
    },
  );
}
