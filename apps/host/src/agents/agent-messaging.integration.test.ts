import { readToolRecords } from "../mcp/product-tools.test-support.js";
import { ProductToolsTestClient } from "../mcp/product-tools.test-support.js";
import { seedPersonalFixture } from "@opensteer/database/test-support/personal";
import { testReadyHarnessCatalog } from "@opensteer/database/test-support/store";
import { personalTestFolders } from "../mcp/personal-folder.test-support.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createId,
  HarnessIdSchema,
  ModelSelectionSchema,
  OpensteerError,
  provisionalThreadTitle,
  SequenceSchema,
  type AgentEvent,
  type Message,
  type Run,
  type Thread,
  type UserId,
} from "@opensteer/core";
import {
  BrowserTabGroupStore,
  createDatabase,
  migrateToLatest,
  OpensteerStore,
  PersonalTabStore,
} from "@opensteer/database";
import { CommandService, KeyedAdmissionQueue, RealtimeHub } from "@opensteer/orchestration";
import {
  BrowserSurfaceIdSchema,
  ComputerUseSessionSummarySchema,
  createBrowserSessionId,
  HarnessInputSchema,
  mintComputerUseSessionId,
} from "@opensteer/protocol";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserService } from "../browser/browser-service.js";
import { BrowserTabGroupService } from "../browser/browser-tab-group-service.js";
import { type RunToolScope, type RunToolTokenService } from "./run-tool-tokens.js";
import { OpensteerMcpService } from "../mcp/opensteer-mcp-service.js";
import { AgentCallerResolver } from "../mcp/agent-caller.js";
const evidenceRoot = join(tmpdir(), "opensteer-title-review", randomUUID());
const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const testModelSelection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: {
    effort: "low",
  },
  providerId: "openai",
});
integration("agent-to-agent messaging round trip", () => {
  const database = createDatabase({
    applicationName: "opensteer-agent-messaging-integration-test",
    connectionString: databaseUrl ?? "postgres://unconfigured",
    maxConnections: 4,
  });
  const store = new OpensteerStore(database);
  const realtime = new RealtimeHub({
    store,
  });
  const browserTabs = new BrowserTabGroupService({
    groups: new BrowserTabGroupStore(database),
    browser: {
      flushPendingTabDescriptors: async () => undefined,
      agentReachableSavedSession: BrowserService.prototype.agentReachableSavedSession,
      agentMayAccessSession: BrowserService.prototype.agentMayAccessSession,
      listAgentProfiles: async () => [],
      tabOccupants: () => [],
      tabStateOf: () => undefined,
    } as unknown as BrowserService,
    publish: vi.fn(),
  });
  const claimsByToken = new Map<string, RunToolScope>();
  const admission = new KeyedAdmissionQueue({
    maxInFlight: 4,
    maxQueuedBytes: 4_000_000,
    maxQueuedCommands: 64,
  });
  const commands = new CommandService({
    admission,
    onExecutionQueued: vi.fn(),
    onDeploymentEvent: vi.fn(),
    store,
  });
  const computerUse = {
    sessionsForRunner: vi.fn<
      import("../computer-use/computer-use-service.js").ComputerUseService["sessionsForRunner"]
    >(() => []),
    authorizeDisplay:
      vi.fn<
        import("../computer-use/computer-use-service.js").ComputerUseService["authorizeDisplay"]
      >(),
  };
  const drainRunPlaces = vi.fn(async (_runId: Run["id"]) => undefined);
  let folders: ReturnType<typeof personalTestFolders>;
  const service = new ProductToolsTestClient({
    computerUse,
    browserTabs,
    personShow: (userId, message) => realtime.showToPerson(userId, message),
    browserSources: {
      agentUseCard: async () => {
        throw new Error("Unexpected card use");
      },
      agentSignIn: async () => {
        throw new Error("Unexpected browser sign-in");
      },
    },
    machineFullDiskAccess: {
      request: async () => {
        throw new Error("Unexpected full access request");
      },
    },
    browser: {
      readablePlaces: async (_owner, references) => [...references],
      drainRunPlaces,
      createProfile: unexpected,
      closeAgentSession: unexpected,
      listAgentSessions: unexpected,
      listAgentProfiles: unexpected,
      openAgentSession: unexpected,
      requestAccess: unexpected,
    },
    canRunHarness: () => true,
    commands,
    isEnvironmentConnected: () => true,
    store,
    tokens: {
      authenticate: async (token: string) => {
        const claims = claimsByToken.get(token);
        if (!claims) throw new Error(`No test claims for ${token}`);
        return claims;
      },
    } as unknown as RunToolTokenService,
    folders: {
      resolve: (...args) => folders.resolve(...args),
      canExecute: (id) => folders.canExecute(id),
    },
  });
  beforeAll(async () => {
    await migrateToLatest(database);
  });
  beforeEach(async () => {
    claimsByToken.clear();
    await sql`truncate table deployments, users restart identity cascade`.execute(database);
    await sql`
      insert into principals(id, kind, user_id, display_name)
      values ('pri_00000000-0000-4000-8000-000000000001', 'system', null, 'Opensteer')
      on conflict (id) do nothing
    `.execute(database);
  });
  afterAll(async () => {
    await database.destroy();
  });
  it("authorizes person_show against saved-tab ownership and Thread visibility", async () => {
    const f = await createMessagingFixture();
    const strangerId = await store.createUser("Other person");
    const otherThreadId = createId("thread");
    const original = await database
      .selectFrom("threads")
      .selectAll()
      .where("id", "=", f.threadB.id)
      .executeTakeFirstOrThrow();
    await database
      .insertInto("threads")
      .values({
        ...original,
        id: otherThreadId,
        lineageRootThreadId: otherThreadId,
        createdBy: strangerId,
      })
      .execute();
    const sessionId = createBrowserSessionId();
    await store.createBrowserSession({
      id: sessionId,
      runnerId: f.runnerId,
      origin: "agent",
      ownerId: f.userId,
      placementKey: "test",
      profileId: null,
      runtimeId: "test",
    });
    const tabId = BrowserSurfaceIdSchema.parse("saved-gmail");
    const tabs = new PersonalTabStore(database);
    await tabs.recordChanges(
      sessionId,
      [
        {
          id: tabId,
          title: "Gmail",
          url: "https://mail.google.com/mail/u/0",
          order: 0,
          openerId: null,
        },
      ],
      [],
    );
    await tabs.suspend(sessionId);
    const show = (
      token: string,
      target:
        | {
            tabId: string;
          }
        | {
            threadId: string;
          }
        | {
            current: true;
          },
    ) =>
      service.handle(token, {
        type: "person.show",
        requestId: randomUUID(),
        target,
      });
    await expect(
      show(f.tokenA, {
        tabId,
      }),
    ).resolves.toMatchObject({
      type: "person.show.result",
      status: "no-device-connected",
      connectedDevices: 0,
    });
    const otherSession = createBrowserSessionId();
    await store.createBrowserSession({
      id: otherSession,
      runnerId: f.runnerId,
      origin: "agent",
      ownerId: strangerId,
      placementKey: "other",
      profileId: null,
      runtimeId: "test",
    });
    await tabs.recordChanges(
      otherSession,
      [
        {
          id: BrowserSurfaceIdSchema.parse("private-tab"),
          title: "Private",
          url: "https://private.test",
          order: 0,
          openerId: null,
        },
      ],
      [],
    );
    await expect(
      show(f.tokenA, {
        tabId: "private-tab",
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      show(f.tokenA, {
        threadId: otherThreadId,
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      show(f.tokenA, {
        threadId: f.threadB.id,
      }),
    ).resolves.toMatchObject({
      status: "no-device-connected",
    });
    const frames: import("@opensteer/protocol").HostToClientMessage[] = [];
    const legacyFrames: import("@opensteer/protocol").HostToClientMessage[] = [];
    const subscription = {
      afterSequence: SequenceSchema.parse("0"),
      deploymentId: f.deploymentId,
      userId: f.userId,
    };
    const opted = () =>
      realtime.subscribe({
        ...subscription,
        personShow: "accept",
        sink: {
          id: randomUUID(),
          send: async (message) => {
            frames.push(message);
          },
          close: vi.fn(),
        },
      });
    let release = await opted();
    const releaseLegacy = await realtime.subscribe({
      ...subscription,
      sink: {
        id: randomUUID(),
        send: async (message) => {
          legacyFrames.push(message);
        },
        close: vi.fn(),
      },
    });
    const request = {
      type: "person.show",
      requestId: randomUUID(),
      target: {
        tabId,
      },
    };
    try {
      await expect(service.handle(f.tokenA, request)).resolves.toMatchObject({
        status: "sent-unconfirmed",
        connectedDevices: 1,
      });
      expect(frames.filter((message) => message.type === "host.show")).toEqual([
        {
          type: "host.show",
          threadId: f.threadA.id,
          runId: f.runA.id,
          target: {
            tabId,
          },
        },
      ]);
      expect(legacyFrames.some((message) => message.type === "host.show")).toBe(false);
      await expect(service.handle(f.tokenA, request)).resolves.toMatchObject({
        status: "already-requested",
        connectedDevices: 0,
      });
      expect(frames.filter((message) => message.type === "host.show")).toHaveLength(1);
      await expect(
        show(f.tokenA, {
          current: true,
        }),
      ).rejects.toMatchObject({
        code: "bad_request",
        message: "This Run has not worked in a place yet.",
      });
      const place = {
        kind: "browser" as const,
        sessionId,
        surfaceId: tabId,
      };
      drainRunPlaces.mockImplementationOnce(async () => {
        await store.recordRunPlace({
          runId: f.runA.id,
          bindingGeneration: 1,
          data: {
            place,
            title: "Gmail",
            site: "https://mail.google.com",
          },
        });
      });
      await expect(
        show(f.tokenA, {
          current: true,
        }),
      ).resolves.toMatchObject({
        status: "sent-unconfirmed",
      });
      expect(frames.at(-1)).toMatchObject({
        type: "host.show",
        runId: f.runA.id,
        target: {
          place,
          runId: f.runA.id,
        },
      });
      release();
      frames.length = 0;
      release = await opted();
      expect(frames.some((message) => message.type === "host.show")).toBe(false);
    } finally {
      release();
      releaseLegacy();
    }
    await tabs.close(f.userId, tabId);
    await expect(service.handle(f.tokenA, request)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      show(f.tokenA, {
        tabId,
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      show(f.tokenA, {
        current: true,
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
  });
  it.each([
    ["app", false],
    ["phone", false],
    ["app", true],
    ["phone", true],
  ] as const)(
    "shows the Run's newest %s place through its authority (voice: %s)",
    async (kind, voice) => {
      const f = await createMessagingFixture(voice);
      const app = {
        bundleId: "com.apple.Notes",
        displayName: "Notes",
        teamId: null,
      };
      const session = ComputerUseSessionSummarySchema.parse({
        sessionId: mintComputerUseSessionId(),
        runId: f.runA.id,
        threadId: f.threadA.id,
        threadTitle: "Work",
        openedAt: new Date().toISOString(),
        actionCount: 1,
        apps: kind === "app" ? [app] : [],
        display: kind === "phone",
      });
      computerUse.sessionsForRunner.mockReturnValue([session]);
      computerUse.authorizeDisplay.mockResolvedValue(f.runnerId);
      const place =
        kind === "app"
          ? {
              kind,
              machineId: f.runnerId,
              appKey: "com.apple.notes",
            }
          : {
              kind,
              machineId: f.runnerId,
              display: "main",
            };
      await store.recordRunPlace({
        runId: f.runA.id,
        bindingGeneration: 1,
        data: {
          place: {
            kind: "app",
            machineId: f.runnerId,
            appKey: "earlier-app",
          },
          title: "Earlier",
          site: null,
        },
      });
      await store.recordRunPlace({
        runId: f.runA.id,
        bindingGeneration: 1,
        data: {
          place,
          title: kind,
          site: null,
        },
      });
      const frames: import("@opensteer/protocol").HostToClientMessage[] = [];
      const release = await realtime.subscribe({
        afterSequence: SequenceSchema.parse("0"),
        deploymentId: f.deploymentId,
        userId: f.userId,
        personShow: "accept",
        sink: {
          id: randomUUID(),
          send: async (message) => {
            frames.push(message);
          },
          close: vi.fn(),
        },
      });
      const show = () =>
        service.handle(f.tokenA, {
          type: "person.show",
          requestId: randomUUID(),
          target: {
            current: true,
          },
        });
      const ownedBy = (effectiveOwner: typeof f.userId) =>
        new Map([
          [
            f.runnerId,
            {
              effectiveOwner,
              ownerKind: "user" as const,
            },
          ],
        ]);
      const owners = vi.spyOn(store, "effectiveMachineOwners").mockResolvedValue(ownedBy(f.userId));
      try {
        await expect(show()).resolves.toMatchObject({
          status: "sent-unconfirmed",
          connectedDevices: 1,
        });
        expect(frames.filter((message) => message.type === "host.show")).toEqual([
          {
            type: "host.show",
            threadId: f.threadA.id,
            runId: f.runA.id,
            target: {
              place,
              runId: f.runA.id,
            },
          },
        ]);
        if (kind === "phone") {
          // Agents release a phone before they reply, and its tab stays.
          computerUse.sessionsForRunner.mockReturnValue([]);
          await expect(show()).resolves.toMatchObject({
            status: "sent-unconfirmed",
          });
          expect(frames.filter((message) => message.type === "host.show")).toHaveLength(2);
          owners.mockResolvedValue(ownedBy(createId("user")));
          await expect(show()).rejects.toMatchObject({
            code: "forbidden",
          });
          return;
        }
        expect(computerUse.authorizeDisplay).toHaveBeenLastCalledWith(
          session.sessionId,
          f.userId,
          "com.apple.notes",
        );
        computerUse.authorizeDisplay.mockRejectedValueOnce(
          new OpensteerError({
            code: "forbidden",
            message: "Access revoked",
          }),
        );
        await expect(show()).rejects.toMatchObject({
          code: "forbidden",
        });
        computerUse.sessionsForRunner.mockReturnValue([
          {
            ...session,
            runId: createId("run"),
          },
        ]);
        await expect(show()).rejects.toMatchObject({
          code: "forbidden",
        });
        expect(frames.filter((message) => message.type === "host.show")).toHaveLength(1);
      } finally {
        release();
        owners.mockRestore();
        computerUse.sessionsForRunner.mockReset();
        computerUse.authorizeDisplay.mockReset();
      }
    },
  );
  it("searches asleep saved tabs before pagination and reports matching fields", async () => {
    const f = await createMessagingFixture();
    const sessionId = createBrowserSessionId();
    await store.createBrowserSession({
      id: sessionId,
      runnerId: f.runnerId,
      origin: "agent",
      ownerId: f.userId,
      placementKey: "test",
      profileId: null,
      runtimeId: "test",
    });
    const tabs = new PersonalTabStore(database);
    const rows = Array.from(
      {
        length: 70,
      },
      (_, index) => ({
        id: BrowserSurfaceIdSchema.parse(`tab-${String(index).padStart(3, "0")}`),
        title: index < 65 ? "Recent" : "Gmail",
        url: index < 65 ? "https://example.com" : "https://mail.google.com",
        order: index,
        openerId: null,
      }),
    );
    await tabs.recordChanges(sessionId, rows.slice(64), []);
    await tabs.suspend(sessionId);
    const recentSessionId = createBrowserSessionId();
    await store.createBrowserSession({
      id: recentSessionId,
      runnerId: f.runnerId,
      origin: "agent",
      ownerId: f.userId,
      placementKey: "recent",
      profileId: null,
      runtimeId: "test",
    });
    await tabs.recordChanges(recentSessionId, rows.slice(0, 64), []);
    const read = async (input: Record<string, string>) => {
      const result = await service.handle(f.tokenA, {
        type: "browser.tab.read",
        requestId: randomUUID(),
        input,
      });
      if (result.type !== "browser.tab.read.result") throw new Error("Expected tab read");
      return result.result;
    };
    const first = await read({});
    expect(first.tabs).toHaveLength(64);
    expect(first.tabs.every((tab) => tab.title === "Recent")).toBe(true);
    const found = await read({
      query: "gmail",
    });
    expect(found.tabs).toHaveLength(5);
    expect(
      found.tabs.every((tab) => tab.state === "asleep" && tab.matchedFields?.includes("title")),
    ).toBe(true);
    expect(found.totalMatches).toBe(5);
    await new BrowserTabGroupStore(database).group(f.userId, {
      tabIds: [rows[69]!.id],
      title: "Archive",
      idempotencyKey: randomUUID(),
    });
    expect(
      (
        await read({
          query: "archive",
        })
      ).tabs,
    ).toMatchObject([
      {
        tabId: rows[69]!.id,
        matchedFields: ["group"],
      },
    ]);
    expect(
      (
        await read({
          query: "Guest",
        })
      ).tabs.every((tab) => tab.matchedFields?.includes("profile")),
    ).toBe(true);
    const paged = await read({
      query: "example",
    });
    expect(paged.tabs).toHaveLength(64);
    expect(paged.totalMatches).toBe(65);
    expect(paged.nextCursor).toBeTruthy();
    expect(
      (
        await read({
          query: "example",
          cursor: paged.nextCursor!,
        })
      ).tabs,
    ).toHaveLength(1);
    await expect(
      read({
        query: "gmail",
        cursor: paged.nextCursor!,
      }),
    ).rejects.toThrow("different search");
    await tabs.close(f.userId, rows[69]!.id);
    expect(
      (
        await read({
          query: "gmail",
        })
      ).totalMatches,
    ).toBe(4);
  });
  it("round-trips typed agent authorship across Threads", async () => {
    const fixture = await createMessagingFixture();
    const outbound = await service.handle(fixture.tokenA, {
      content: [
        {
          text: "Please summarize the signed contract.",
          type: "text",
        },
      ],
      delivery: "queue",
      requestId: randomUUID(),
      threadId: fixture.threadB.id,
      type: "thread.message",
    });
    if (outbound.type !== "thread.message.result") throw new Error("Expected a message result");
    expect(outbound.result.disposition).toBe("run-queued");
    expect((await readToolRecords(store, outbound.result)).thread.id).toBe(fixture.threadB.id);
    expect((await readToolRecords(store, outbound.result)).run!).toMatchObject({
      status: "queued",
      threadId: fixture.threadB.id,
    });
    expect((await readToolRecords(store, outbound.result)).message!).toMatchObject({
      author: {
        displayName: "Contract coordination",
        kind: "agent",
        runId: fixture.runA.id,
        threadId: fixture.threadA.id,
      },
      content: [
        {
          text: "Please summarize the signed contract.",
          type: "text",
        },
      ],
      kind: "input",
      threadId: fixture.threadB.id,
    });
    if (!(await readToolRecords(store, outbound.result)).run!)
      throw new Error("Expected the trigger to queue a Run");
    const inboundCommandId = await pendingCommandIdForRun(
      (await readToolRecords(store, outbound.result)).run!.id,
    );
    await store.claimCommand(inboundCommandId, "messaging-dispatcher");
    const inboundContext = await store.loadRunDispatchContext(inboundCommandId);
    expect(projectHarnessInputs(inboundContext.inputs)).toEqual([
      {
        author: (await readToolRecords(store, outbound.result)).message!.author,
        content: [
          {
            text: "Please summarize the signed contract.",
            type: "text",
          },
        ],
        createdAt: (await readToolRecords(store, outbound.result)).message!.createdAt,
        kind: "input",
        messageId: (await readToolRecords(store, outbound.result)).message!.id,
      },
    ]);
    await activateClaimedRun(
      fixture,
      (await readToolRecords(store, outbound.result)).run!,
      fixture.threadB,
    );
    claimsByToken.set(
      fixture.tokenB,
      testClaims({
        environmentId: fixture.environmentId,
        requestedBy: fixture.userId,
        runId: (await readToolRecords(store, outbound.result)).run!.id,
        runnerId: fixture.runnerId,
        threadId: fixture.threadB.id,
      }),
    );
    const reply = await service.handle(fixture.tokenB, {
      content: [
        {
          text: "Summarized: the counterparty signed on Tuesday.",
          type: "text",
        },
      ],
      delivery: "steer",
      requestId: randomUUID(),
      threadId: fixture.threadA.id,
      type: "thread.message",
    });
    if (reply.type !== "thread.message.result") throw new Error("Expected a message result");
    expect(reply.result.disposition).toBe("steering");
    expect((await readToolRecords(store, reply.result)).run?.id).toBe(fixture.runA.id);
    expect((await readToolRecords(store, reply.result)).message!).toMatchObject({
      author: {
        displayName: "Client research",
        kind: "agent",
        runId: (await readToolRecords(store, outbound.result)).run!.id,
        threadId: fixture.threadB.id,
      },
      kind: "input",
      threadId: fixture.threadA.id,
    });
    const replyCommand = await database
      .selectFrom("commands")
      .select("id")
      .where("runId", "=", fixture.runA.id)
      .where("type", "=", "run.steer")
      .executeTakeFirstOrThrow();
    await store.claimCommand(replyCommand.id, "messaging-dispatcher");
    const steered = await store.loadSteerDispatchInput(replyCommand.id);
    expect(projectHarnessInputs([steered.message])).toEqual([
      {
        author: (await readToolRecords(store, reply.result)).message!.author,
        content: [
          {
            text: "Summarized: the counterparty signed on Tuesday.",
            type: "text",
          },
        ],
        createdAt: (await readToolRecords(store, reply.result)).message!.createdAt,
        kind: "input",
        messageId: (await readToolRecords(store, reply.result)).message!.id,
      },
    ]);
  });
  it("steers an active Run exactly once on an exact retry", async () => {
    const fixture = await createMessagingFixture();
    const running = await startRun(fixture, fixture.threadB);
    const request = {
      content: [
        {
          text: "The contract is signed.",
          type: "text" as const,
        },
      ],
      delivery: "steer" as const,
      requestId: randomUUID(),
      threadId: fixture.threadB.id,
      type: "thread.message" as const,
    };
    const steered = await service.handle(fixture.tokenA, request);
    if (steered.type !== "thread.message.result") throw new Error("Expected a message result");
    expect(steered.result.disposition).toBe("steering");
    expect((await readToolRecords(store, steered.result)).run?.id).toBe(running.runId);
    expect((await readToolRecords(store, steered.result)).input!).toMatchObject({
      policy: "steer",
      runId: running.runId,
      state: "claimed",
    });
    expect((await readToolRecords(store, steered.result)).message!).toMatchObject({
      author: {
        kind: "agent",
        runId: fixture.runA.id,
        threadId: fixture.threadA.id,
      },
      runId: running.runId,
    });
    const steer = await database
      .selectFrom("commands")
      .select(["id", "runId", "type"])
      .where("type", "=", "run.steer")
      .execute();
    expect(steer).toHaveLength(1);
    expect(steer[0]).toMatchObject({
      runId: running.runId,
    });
    const retried = await service.handle(fixture.tokenA, request);
    if (retried.type !== "thread.message.result") throw new Error("Expected a message result");
    expect(retried.result).toMatchObject({
      disposition: "steering",
      assignmentId: null,
      messageId: steered.result.messageId,
      runId: running.runId,
    });
    await expect(
      database
        .selectFrom("commands")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("type", "=", "run.steer")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      count: "1",
    });
  });
  it("leaves a report pending on an idle Thread", async () => {
    const fixture = await createMessagingFixture();
    const queued = await service.handle(fixture.tokenA, {
      content: [
        {
          text: "The contract is signed.",
          type: "text",
        },
      ],
      delivery: "report",
      requestId: randomUUID(),
      threadId: fixture.threadB.id,
      type: "thread.message",
    });
    if (queued.type !== "thread.message.result") throw new Error("Expected a message result");
    expect(queued.result.disposition).toBe("pending");
    expect((await readToolRecords(store, queued.result)).run!).toBeNull();
    expect((await readToolRecords(store, queued.result)).input!).toMatchObject({
      messageId: (await readToolRecords(store, queued.result)).message!.id,
      policy: "report",
      runId: null,
      state: "pending",
    });
    await expect(
      database
        .selectFrom("commands")
        .select("id")
        .where("threadId", "=", fixture.threadB.id)
        .where("type", "in", ["run.execute", "run.steer"])
        .execute(),
    ).resolves.toEqual([]);
    const history = await store.threadMessagePageForOwner({
      ownerId: fixture.userId,
      threadId: fixture.threadB.id,
    });
    expect(history?.messages.find(({ id }) => id === queued.result.messageId)?.policy).toBe(
      "report",
    );
  });

  /*
   * Commands now run side by side across Threads. Failure modes against a real
   * database: concurrent transactions deadlock or lose a command; one Thread's
   * messages queue out of the order they were sent.
   */
  it("admits a burst of sends across Threads without losing one or reordering a Thread", async () => {
    const fixture = await createMessagingFixture();
    const threads = [fixture.threadA, fixture.threadB];
    for (let index = 0; index < 6; index += 1) {
      const { thread } = await store.createThread({
        createdBy: fixture.userId,
        environmentId: fixture.environmentId,
        harnessInstanceId: fixture.harnessInstanceId,
        idempotencyKey: `burst-thread-${index}-${randomUUID()}`,
        modelSelection: testModelSelection,
        title: `Burst ${index}`,
      });
      threads.push(thread);
    }
    const sends = threads.flatMap((thread) =>
      Array.from(
        {
          length: 5,
        },
        (_unused, order) =>
          commands.enqueueThreadInput({
            content: [
              {
                text: `${thread.id} ${order}`,
                type: "text",
              },
            ],
            idempotencyKey: `burst-${thread.id}-${order}`,
            policy: "queue",
            requestedBy: fixture.userId,
            source: {
              kind: "human",
            },
            threadId: thread.id,
          }),
      ),
    );
    const settled = await Promise.allSettled(sends);
    expect(settled.filter((result) => result.status === "rejected")).toEqual([]);
    for (const thread of threads) {
      const queued = await database
        .selectFrom("threadInputs")
        .innerJoin("messages", "messages.id", "threadInputs.messageId")
        .select("messages.content")
        .where("threadInputs.threadId", "=", thread.id)
        .where(
          "messages.content",
          "@>",
          sql<never>`${JSON.stringify([
            {
              type: "text",
            },
          ])}::jsonb`,
        )
        .orderBy("threadInputs.queueRank", "asc")
        .execute();
      const burst = queued
        .map(
          (row) =>
            (
              row.content as readonly {
                readonly text?: string;
              }[]
            )[0]?.text ?? "",
        )
        .filter((text) => text.startsWith(`${thread.id} `));
      expect(burst).toEqual([0, 1, 2, 3, 4].map((order) => `${thread.id} ${order}`));
    }
  });
  it.each([undefined, "Agent chose this"])(
    "delegates with title %s and reads the live worker title in summaries",
    async (title) => {
      const fixture = await createMessagingFixture();
      const task = "\n  Research  contract changes \nwith the full instructions";
      const response = await service.handle(fixture.tokenA, {
        requestId: randomUUID(),
        type: "thread.delegate",
        task,
        ...(title === undefined
          ? {}
          : {
              title,
            }),
      });
      if (response.type !== "thread.delegate.result") throw new Error("Expected delegation");
      if (!(await readToolRecords(store, response.result)).run!)
        throw new Error("Expected a delegated Run");
      const worker = (await readToolRecords(store, response.result)).thread;
      const summary = async () =>
        (
          await store.listThreadAssignmentsForOwner({
            ownerId: fixture.userId,
            threadId: fixture.threadA.id,
          })
        )?.assignments.find((assignment) => assignment.id === response.result.assignmentId);
      const row = await database
        .selectFrom("threads")
        .select(["title", "titleSource"])
        .where("id", "=", worker.id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({
        title: title ?? provisionalThreadTitle(task),
        titleSource: title === undefined ? "provisional" : "chosen",
      });
      const event = await store.applyGeneratedThreadName({
        threadId: worker.id,
        title: "Contract research",
      });
      expect(event === null).toBe(title !== undefined);
      expect((await summary())?.workerThread.title).toBe(title ?? "Contract research");
      await commands.renameThread({
        idempotencyKey: randomUUID(),
        requestedBy: fixture.userId,
        threadId: worker.id,
        title: "Reviewed contract",
      });
      expect((await summary())?.workerThread.title).toBe("Reviewed contract");
      const command = await database
        .selectFrom("commands")
        .select("id")
        .where("runId", "=", (await readToolRecords(store, response.result)).run!.id)
        .where("type", "=", "run.execute")
        .executeTakeFirstOrThrow();
      await store.claimCommand(command.id, "title-dispatcher");
      expect(await store.getThreadNamingInput(worker.id)).toMatchObject({
        request: task.trim(),
        icon: true,
      });
      await commands.cancelAssignment({
        assignmentId: response.result.assignmentId,
        idempotencyKey: randomUUID(),
        requestedBy: fixture.userId,
      });
      const reused = await service.handle(fixture.tokenA, {
        requestId: randomUUID(),
        type: "thread.delegate",
        task: "Another task",
        threadId: worker.id,
      });
      if (reused.type !== "thread.delegate.result") throw new Error("Expected reuse");
      expect(
        await database
          .selectFrom("threads")
          .select(["title", "titleSource"])
          .where("id", "=", worker.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({
        title: "Reviewed contract",
        titleSource: "chosen",
      });
    },
  );
  it("preserves the person's chosen marks when reusing a worker", async () => {
    const f = await createMessagingFixture();
    const response = await service.handle(f.tokenA, {
      type: "thread.delegate",
      requestId: randomUUID(),
      task: "Book a flight",
    });
    if (response.type !== "thread.delegate.result") throw new Error("Expected delegation");
    const worker = (await readToolRecords(store, response.result)).thread;
    await commands.setThreadIcon({
      threadId: worker.id,
      requestedBy: f.userId,
      icon: "plane",
      idempotencyKey: randomUUID(),
    });
    const before = await database
      .selectFrom("threads")
      .select(["icon", "iconSource", "color"])
      .where("id", "=", worker.id)
      .executeTakeFirstOrThrow();
    expect(before).toEqual({
      icon: "plane",
      iconSource: "chosen",
      color: worker.color,
    });
    await commands.cancelAssignment({
      assignmentId: response.result.assignmentId,
      idempotencyKey: randomUUID(),
      requestedBy: f.userId,
    });
    await expect(
      service.handle(f.tokenA, {
        type: "thread.delegate",
        requestId: randomUUID(),
        threadId: worker.id,
        task: "New task",
        icon: "hotel",
      }),
    ).rejects.toThrow("Unrecognized key");
    const reused = await service.handle(f.tokenA, {
      type: "thread.delegate",
      requestId: randomUUID(),
      threadId: worker.id,
      task: "New task",
    });
    if (reused.type !== "thread.delegate.result") throw new Error("Expected reuse");
    expect(
      await database
        .selectFrom("threads")
        .select(["icon", "iconSource", "color"])
        .where("id", "=", worker.id)
        .executeTakeFirstOrThrow(),
    ).toEqual(before);
  });

  it.each(["rename", "generated", "icon", "generated-icon"] as const)(
    "republishes completed assignment titles after %s",
    async (mode) => {
      const fixture = await createMessagingFixture();
      const response = await service.handle(fixture.tokenA, {
        requestId: randomUUID(),
        type: "thread.delegate",
        task: "Research the contract",
      });
      if (
        response.type !== "thread.delegate.result" ||
        !(await readToolRecords(store, response.result)).run!
      )
        throw new Error("Expected delegated Run");
      const worker = (await readToolRecords(store, response.result)).thread;
      const run = (await readToolRecords(store, response.result)).run!;
      await store.claimCommand(await pendingCommandIdForRun(run.id), "title-review-dispatcher");
      const binding = await activateClaimedRun(fixture, run, worker);
      await store.commitRunnerEvent({
        environmentId: fixture.environmentId,
        runnerBootId: "boot-1",
        runnerId: fixture.runnerId,
        event: {
          bindingGeneration: binding.bindingGeneration,
          data: {
            status: "completed",
          },
          emittedAt: new Date().toISOString(),
          environmentId: fixture.environmentId,
          ordinal: 1,
          runId: run.id,
          threadId: worker.id,
          type: "run.completed",
        },
      });
      await store.drainPendingAssignmentReturns();
      const before = await database
        .selectFrom("delegations")
        .selectAll()
        .where("id", "=", response.result.assignmentId)
        .executeTakeFirstOrThrow();
      expect(before.status).toBe("completed");
      const reused = await store.delegateThread({
        accessMode: worker.accessMode,
        createdBy: fixture.userId,
        environmentId: fixture.environmentId,
        harnessInstanceId: fixture.harnessInstanceId,
        idempotencyKey: randomUUID(),
        modelSelection: testModelSelection,
        origin: {
          kind: "run",
          parentRunId: fixture.runA.id,
          parentThreadId: fixture.threadA.id,
        },
        task: [
          {
            text: "Follow up on the contract",
            type: "text",
          },
        ],
        threadId: worker.id,
        title: "Follow-up seed",
        titleSource: "provisional",
      });
      expect(reused.assignment.status).toBe("open");
      const head = await database
        .selectFrom("deploymentEventState")
        .select("sequence")
        .where("deploymentId", "=", fixture.deploymentId)
        .executeTakeFirstOrThrow();
      const title =
        mode === "rename"
          ? "Reviewed contract"
          : mode === "generated"
            ? "Contract research"
            : worker.title;
      const icon = mode === "icon" || mode === "generated-icon" ? "plane" : null;
      const events: AgentEvent[] = [];
      if (mode === "rename" || mode === "icon") {
        const changed = new CommandService({
          admission,
          onExecutionQueued: () => undefined,
          onDeploymentEvent: (event) => events.push(event),
          store,
        });
        await (mode === "icon"
          ? changed.setThreadIcon({
              icon: "plane",
              requestedBy: fixture.userId,
              threadId: worker.id,
              idempotencyKey: randomUUID(),
            })
          : changed.renameThread({
              idempotencyKey: randomUUID(),
              requestedBy: fixture.userId,
              threadId: worker.id,
              title,
            }));
      } else {
        const result = await store.applyGeneratedThreadName({
          threadId: worker.id,
          ...(mode === "generated-icon"
            ? {
                icon: "plane" as const,
              }
            : {
                title,
              }),
        });
        if (result) events.push(...result.events);
      }
      const updates = await database
        .selectFrom("deploymentEvents")
        .selectAll()
        .where("sequence", ">", head.sequence)
        .where("type", "=", "assignment.updated")
        .execute();
      expect(updates).toHaveLength(2);
      for (const assignment of [before, reused.assignment]) {
        expect(updates).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              threadId: fixture.threadA.id,
              data: {
                assignment: expect.objectContaining({
                  id: assignment.id,
                  revision: assignment.revision + 1,
                  status: assignment.status,
                  workerThread: expect.objectContaining({
                    title,
                    icon,
                    color: worker.color,
                  }),
                }),
              },
            }),
          ]),
        );
      }
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            threadId: fixture.threadA.id,
            type: "assignment.updated",
          }),
          expect.objectContaining({
            threadId: worker.id,
            type: "assignment.updated",
          }),
        ]),
      );
      await titleEvidence(`completed-${mode}`, {
        before,
        updates,
        events,
      });
    },
  );
  async function titleEvidence(name: string, result: unknown) {
    await mkdir(evidenceRoot, {
      recursive: true,
    });
    await writeFile(join(evidenceRoot, `${name}.json`), JSON.stringify(result, null, 2));
    console.info(`Title review receipt: ${join(evidenceRoot, `${name}.json`)}`);
  }
  it("thread_update shares Done, freezes messages and delegation, and reopens through the same authority", async () => {
    const f = await createMessagingFixture();
    const write = (action: string, fields = {}) =>
      service.handle(f.tokenA, {
        type: "thread.update",
        requestId: randomUUID(),
        input: {
          threadId: f.threadB.id,
          action,
          ...fields,
        },
      });
    expect(
      await write("rename", {
        title: "Shared result",
      }),
    ).toMatchObject({
      type: "thread.update.result",
      doneWhenRunEnds: false,
      title: "Shared result",
      doneAt: null,
    });
    const done = await write("done");
    expect(done).toMatchObject({
      type: "thread.update.result",
      doneWhenRunEnds: false,
      title: "Shared result",
      doneAt: expect.any(String),
    });
    await expect(
      service.handle(f.tokenA, {
        type: "thread.message",
        requestId: randomUUID(),
        threadId: f.threadB.id,
        content: [
          {
            type: "text",
            text: "No new work",
          },
        ],
        delivery: "queue",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "This task is Done. Reopen it first.",
    });
    await expect(
      service.handle(f.tokenA, {
        type: "thread.delegate",
        requestId: randomUUID(),
        threadId: f.threadB.id,
        task: "No delegation",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "This task is Done. Reopen it first.",
    });
    expect(await write("reopen")).toMatchObject({
      doneAt: null,
    });
    const next = await service.handle(f.tokenA, {
      type: "thread.message",
      requestId: randomUUID(),
      threadId: f.threadB.id,
      content: [
        {
          type: "text",
          text: "Now run",
        },
      ],
      delivery: "queue",
    });
    expect(next).toMatchObject({
      type: "thread.message.result",
      result: {
        runId: expect.any(String),
      },
    });
    if (next.type !== "thread.message.result") throw new Error("Expected a message result");
    expect((await readToolRecords(store, next.result)).run).toMatchObject({
      status: "queued",
    });
    await mkdir("/tmp/opensteer-task-done", {
      recursive: true,
    });
    await writeFile(
      "/tmp/opensteer-task-done/agent-host.json",
      JSON.stringify(
        {
          done,
          next,
          threadId: f.threadB.id,
          runId: f.runA.id,
        },
        null,
        2,
      ),
    );
  });
  it("keeps one tool inventory through Runner reconnects and returns a compact Thread summary", async () => {
    const f = await createMessagingFixture();
    const claims = claimsByToken.get(f.tokenA)!;
    const mcp = new OpensteerMcpService({
      publicUrl: new URL("http://localhost"),
      store: store,
      handlers: service.service.options.handlers,
      callers: new AgentCallerResolver({
        store: store,
        runs: {
          authenticate: async () => claims,
        } as unknown as RunToolTokenService,
      }),
    });
    const inventories: string[][] = [];
    try {
      for (const modern of [true, false]) {
        if (!modern)
          await database
            .updateTable("runners")
            .set({
              capabilities: sql`${JSON.stringify(["filesystem"])}::jsonb`,
            })
            .where("id", "=", f.runnerId)
            .execute();
        const server = await mcp.createServer(await mcp.options.callers.authenticate("fixture"));
        const client = new Client({
          name: "task-done-test",
          version: "1",
        });
        const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
        try {
          await server.connect(serverTransport);
          const receive = serverTransport.onmessage!;
          serverTransport.onmessage = (message, extra) =>
            receive(message, {
              ...extra,
              authInfo: {
                token: f.tokenA,
                clientId: "task-done-test",
                scopes: [],
              },
            });
          await client.connect(clientTransport);
          const names = (await client.listTools()).tools.map(({ name }) => name);
          inventories.push(names);
          expect(names).toContain("thread_update");
          if (modern) {
            const result = await client.callTool({
              name: "thread_update",
              arguments: {
                threadId: f.threadB.id,
                action: "rename",
                title: "MCP write",
              },
            });
            expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
            expect(result.structuredContent).toMatchObject({
              title: "MCP write",
              doneAt: null,
              doneWhenRunEnds: false,
            });
          }
        } finally {
          await client.close();
          await server.close();
        }
      }
      await expect(
        service.handle(f.tokenA, {
          type: "thread.update",
          requestId: randomUUID(),
          input: {
            action: "done",
          },
        }),
      ).resolves.toMatchObject({
        type: "thread.update.result",
        doneWhenRunEnds: true,
      });
      await mkdir("/tmp/opensteer-task-done", {
        recursive: true,
      });
      await writeFile(
        "/tmp/opensteer-task-done/runner-capability.json",
        JSON.stringify(
          {
            runId: f.runA.id,
            inventories,
          },
          null,
          2,
        ),
      );
    } finally {
      await mcp.close();
    }
  });
  async function createMessagingFixture(voice = false) {
    const path = join(evidenceRoot, randomUUID());
    await mkdir(path, { recursive: true });
    const personal = await seedPersonalFixture(database, path);
    const { userId, runnerId, environmentId, agentHome } = personal;
    folders = personalTestFolders(store, personal);
    const harnessInstance = await store.createHarnessInstance({
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
      catalogs: [testReadyHarnessCatalog(harnessInstance.id)],
      expectedRevisions: new Map([[harnessInstance.id, harnessInstance.runtimeRevision]]),
    });
    const { thread: threadA } = await store.createThread({
      folder: agentHome,
      createdBy: userId,
      environmentId,
      harnessInstanceId: harnessInstance.id,
      idempotencyKey: `messaging-thread-a-${randomUUID()}`,
      modelSelection: testModelSelection,
      title: "Contract coordination",
    });
    const { thread: threadB } = await store.createThread({
      folder: agentHome,
      createdBy: userId,
      environmentId,
      harnessInstanceId: harnessInstance.id,
      idempotencyKey: `messaging-thread-b-${randomUUID()}`,
      modelSelection: testModelSelection,
      title: "Client research",
    });
    const humanTurn = await commands.enqueueThreadInput({
      content: [
        {
          text: "Coordinate the contract review",
          type: "text",
        },
      ],
      idempotencyKey: `messaging-human-${randomUUID()}`,
      policy: "queue",
      requestedBy: userId,
      source: {
        kind: "human",
      },
      threadId: threadA.id,
    });
    if (!humanTurn.command || !humanTurn.run) {
      throw new Error("Expected the initial human input to queue a Run");
    }
    await store.claimCommand(humanTurn.command.id, "messaging-dispatcher");
    await activateClaimedRun(
      {
        environmentId,
        harnessInstanceId: harnessInstance.id,
        runnerId,
      },
      humanTurn.run,
      threadA,
    );
    if (voice) {
      await database
        .updateTable("threads")
        .set({
          listed: false,
          title: "Voice",
        })
        .where("id", "=", threadA.id)
        .execute();
      await database
        .updateTable("runs")
        .set({
          voiceSessionId: randomUUID(),
        })
        .where("id", "=", humanTurn.run.id)
        .execute();
    }
    const tokenA = `token-a-${randomUUID()}`;
    claimsByToken.set(
      tokenA,
      testClaims({
        environmentId,
        requestedBy: userId,
        runId: humanTurn.run.id,
        runnerId,
        threadId: threadA.id,
      }),
    );
    return {
      ...personal,
      harnessInstanceId: harnessInstance.id,
      humanCommandId: humanTurn.command.id,
      runA: humanTurn.run,
      runnerId,
      threadA,
      threadB,
      tokenA,
      tokenB: `token-b-${randomUUID()}`,
      userId,
    };
  }

  /** Drives a Thread's head Run to `running` on a live execution binding. */
  async function startRun(
    fixture: Awaited<ReturnType<typeof createMessagingFixture>>,
    thread: Thread,
  ) {
    const turn = await commands.enqueueThreadInput({
      content: [
        {
          text: "Start the research",
          type: "text",
        },
      ],
      idempotencyKey: `messaging-start-${randomUUID()}`,
      policy: "queue",
      requestedBy: fixture.userId,
      source: {
        kind: "human",
      },
      threadId: thread.id,
    });
    if (!turn.command || !turn.run) throw new Error("Expected the input to queue a Run");
    const runnerBootId = "boot-1";
    await store.claimCommand(turn.command.id, "messaging-dispatcher");
    const binding = await activateClaimedRun(fixture, turn.run, thread, runnerBootId);
    return {
      bindingGeneration: binding.bindingGeneration,
      runId: turn.run.id,
      runnerBootId,
    };
  }
  async function activateClaimedRun(
    fixture: Pick<
      Awaited<ReturnType<typeof createMessagingFixture>>,
      "environmentId" | "harnessInstanceId" | "runnerId"
    >,
    run: Run,
    thread: Thread,
    runnerBootId = "boot-1",
  ) {
    const binding = await store.acquireExecutionBinding({
      bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
      continuationIdentity: {
        continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
        driverKind: HarnessIdSchema.parse("native"),
      },
      harnessInstanceId: fixture.harnessInstanceId,
      leaseTokenHash: `lease-${randomUUID()}`,
      runnerBootId,
      runnerId: fixture.runnerId,
      runId: run.id,
      threadId: thread.id,
    });
    await store.commitRunnerEvent({
      environmentId: fixture.environmentId,
      event: {
        bindingGeneration: binding.bindingGeneration,
        data: {
          status: "running",
        },
        emittedAt: new Date().toISOString(),
        environmentId: fixture.environmentId,
        ordinal: 0,
        runId: run.id,
        threadId: thread.id,
        type: "run.started",
      },
      runnerBootId,
      runnerId: fixture.runnerId,
    });
    return binding;
  }
  async function pendingCommandIdForRun(runId: ReturnType<typeof createId<"run">>) {
    const row = await database
      .selectFrom("commands")
      .select("id")
      .where("runId", "=", runId)
      .where("type", "=", "run.execute")
      .executeTakeFirstOrThrow();
    return row.id;
  }
});
function testClaims(input: {
  readonly environmentId: ReturnType<typeof createId<"environment">>;
  readonly requestedBy: UserId;
  readonly runId: ReturnType<typeof createId<"run">>;
  readonly runnerId: ReturnType<typeof createId<"runner">>;
  readonly threadId: Thread["id"];
}): RunToolScope {
  return {
    aud: "opensteer-run-tools",
    bindingGeneration: 1,
    exp: Math.floor(Date.now() / 1_000) + 60,
    iat: Math.floor(Date.now() / 1_000),
    iss: "opensteer-host",
    jti: randomUUID(),
    runnerBootId: "boot-1",
    ...input,
  };
}
function projectHarnessInputs(messages: readonly Message[]) {
  return messages.map((message) =>
    HarnessInputSchema.parse({
      author: message.author,
      content: message.content,
      createdAt: message.createdAt,
      kind: message.kind,
      messageId: message.id,
    }),
  );
}
async function unexpected(): Promise<never> {
  throw new Error("Unexpected agent control dependency call");
}
