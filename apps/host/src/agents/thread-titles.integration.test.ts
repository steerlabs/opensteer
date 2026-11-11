import { readToolRecords } from "../mcp/product-tools.test-support.js";
import { TriggerToolsTestClient } from "../mcp/product-tools.test-support.js";
import { createTestWorkspace } from "@opensteer/database/test-support/workspace";
import {
  AgentEventSchema,
  createId,
  HarnessIdSchema,
  markColorAllocationOrder,
  ModelSelectionSchema,
  nextMarkColor,
  provisionalThreadTitle,
  ThreadAccessModeSchema,
  threadTitleRequestMaxLength,
  zeroSequence,
  type AgentEvent,
  type ContentPart,
  type ThreadId,
} from "@opensteer/core";
import {
  AttachmentStore,
  createDatabase,
  mayNotify,
  migrateToLatest,
  OpensteerStore,
  taskMarksMigration,
  threadTitleSourceMigration,
  TriggerStore,
} from "@opensteer/database";
import { CommandService, KeyedAdmissionQueue } from "@opensteer/orchestration";
import { hostApi, PendingAgentEventSchema, type RunnerDescriptor } from "@opensteer/protocol";
import { sql } from "kysely";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Design failures 1–5, 14–16, 19–21 and 23: real committed rows and events,
// including retries, concurrent CAS, authorization and a first input outside history.
import {
  type TriggerControlScope,
  type TriggerControlTokenService,
} from "../triggers/trigger-control-service.js";
import type { WatchControlScope } from "../triggers/watch-capability.js";
import { WatchToolsTestClient } from "../mcp/product-tools.test-support.js";
const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const evidenceRoot = join(
  process.env.OPENSTEER_TASK_MARKS_EVIDENCE_DIR ?? join(tmpdir(), "opensteer-task-marks"),
  "thread-titles",
  randomUUID(),
);
const modelSelection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: {},
  providerId: "openai",
});
const continuationIdentity = {
  continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
  driverKind: HarnessIdSchema.parse("native"),
};
integration.sequential("Thread title lifecycle", () => {
  const database = createDatabase({
    connectionString: databaseUrl ?? "postgres://unconfigured",
    maxConnections: 6,
  });
  const store = new OpensteerStore(database);
  const published: AgentEvent[] = [];
  const commands = new CommandService({
    admission: new KeyedAdmissionQueue({
      maxInFlight: 6,
      maxQueuedBytes: 4_000_000,
      maxQueuedCommands: 64,
    }),
    onExecutionQueued: () => undefined,
    onWorkspaceEvent: (event) => published.push(event),
    store,
  });
  beforeAll(async () => {
    await migrateToLatest(database);
    await mkdir(evidenceRoot, {
      recursive: true,
    });
    console.info(`Thread title receipts: ${evidenceRoot}`);
  });
  beforeEach(async () => {
    published.length = 0;
    await sql`truncate table deployments, users restart identity cascade`.execute(database);
    await sql`insert into principals(id, kind, user_id, display_name)
      values ('pri_00000000-0000-4000-8000-000000000001', 'system', null, 'Opensteer')
      on conflict (id) do nothing`.execute(database);
  });
  afterEach(async (context) => {
    await writeFile(
      join(evidenceRoot, `${context.task.name.replaceAll(/[^a-z0-9]+/giu, "-")}.json`),
      JSON.stringify(
        {
          test: context.task.name,
          threads: await database
            .selectFrom("threads")
            .select(["id", "title", "titleSource", "icon", "iconSource", "color"])
            .execute(),
          events: await database
            .selectFrom("deploymentEvents")
            .select(["sequence", "threadId", "type", "data"])
            .orderBy("sequence")
            .execute(),
          commands: await database
            .selectFrom("commands")
            .select(["type", "idempotencyKey", "payload", "status"])
            .execute(),
          published,
        },
        null,
        2,
      ),
    );
  });
  afterAll(async () => database.destroy());
  const hostInstanceId = createId("hostInstance");
  async function fixture() {
    await store.ensureDeployment({
      canonicalOrigin: "https://titles.test",
      hostInstanceId,
      deploymentShape: {
        kind: "server",
        defaultWorkspaceBacking: "local-directory",
      },
    });
    const userId = await store.createUser("Title owner");
    const runnerId = createId("runner");
    const environmentId = createId("environment");
    const pair = generateKeyPairSync("ed25519");
    const descriptor: RunnerDescriptor = {
      bootId: `rbt_${randomUUID()}` as RunnerDescriptor["bootId"],
      capabilities: ["filesystem"],
      modules: {
        agents: {
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

          maxConcurrentRuns: 4,
          providerStateModes: ["isolated"],
        },
      },
      name: "Title computer",
      runnerId,
      runnerKind: "local",
      runtimeVersion: "test",
    };
    const enrollmentTokenHash = `sha256:${createHash("sha256").update(randomUUID()).digest("base64url")}`;
    await store.createRunnerEnrollment({
      allowedModules: ["agents"],
      createdBy: userId,
      expiresAt: new Date(Date.now() + 60_000),
      id: `ren_${randomUUID()}`,
      idempotencyKey: randomUUID(),
      name: descriptor.name,
      requestFingerprint: `sha256:${randomUUID()}`,
      runnerKind: "local",
      tokenHash: enrollmentTokenHash,
    });
    await store.enrollRunnerConnection({
      descriptor,
      enrollmentTokenHash,
      publicKeyFingerprint: `sha256:${createHash("sha256")
        .update(
          pair.publicKey.export({
            format: "der",
            type: "spki",
          }),
        )
        .digest("base64url")}`,
      publicKeyPem: pair.publicKey
        .export({
          format: "pem",
          type: "spki",
        })
        .toString(),
    });
    const workspace = await createTestWorkspace(store, {
      backing: {
        kind: "local-directory",
        generation: 1,
        bindingId: createId("workspaceBinding"),
        ownerEnvironmentId: environmentId,
        storageAuthorityId: createId("storageAuthority"),
      },
      createdBy: userId,
      idempotencyKey: randomUUID(),
      name: "Title workspace",
      status: "ready",
    });
    const harness = await store.createHarnessInstance({
      config: {},
      driverKind: HarnessIdSchema.parse("native"),
      environmentId,
      name: "Native",
      sourceId: "native",
      stateKind: "isolated",
    });
    const create = (
      options: {
        generateTitle?: true;
        home?: boolean;
        title?: string;
      } = {},
    ) =>
      store.createThread({
        createdBy: userId,
        environmentId,
        harnessInstanceId: harness.id,
        idempotencyKey: randomUUID(),
        modelSelection,
        title: "Seed title",
        ...options,
      });
    return {
      userId,
      runnerId,
      environmentId,
      workspace,
      harness,
      create,
      descriptor,
    };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const row = (threadId: ThreadId) =>
    database.selectFrom("threads").selectAll().where("id", "=", threadId).executeTakeFirstOrThrow();
  const send = (f: Fixture, threadId: ThreadId, content: ContentPart[]) =>
    store.enqueueThreadInput({
      content,
      idempotencyKey: randomUUID(),
      policy: "queue",
      requestedBy: f.userId,
      source: {
        kind: "human",
      },
      threadId,
    });
  const rename = (f: Fixture, threadId: ThreadId, title: string, idempotencyKey = randomUUID()) =>
    commands.renameThread({
      idempotencyKey,
      requestedBy: f.userId,
      threadId,
      title,
    });
  it("opts in only explicit new tasks, fixes Chat, and preserves old command inputs", async () => {
    const f = await fixture();
    const chosen = await f.create();
    const provisional = await f.create({
      generateTitle: true,
    });
    const home = await f.create({
      generateTitle: true,
      home: true,
      title: "Wrong Chat label",
    });
    expect(await row(chosen.thread.id)).toMatchObject({
      titleSource: "chosen",
    });
    expect(await row(provisional.thread.id)).toMatchObject({
      titleSource: "provisional",
    });
    expect(await row(home.thread.id)).toMatchObject({
      title: "Chat",
      titleSource: "chosen",
    });
    expect(chosen.thread).not.toHaveProperty("titleSource");
    const oldInput = {
      type: "thread.create",
      environmentId: f.environmentId,
      harnessInstanceId: f.harness.id,
      idempotencyKey: randomUUID(),
      modelSelection,
      title: "API chosen",
    };
    expect(hostApi["commands.dispatch"].payload.parse(oldInput)).toMatchObject(oldInput);
    expect(
      await store.applyGeneratedThreadName({
        threadId: chosen.thread.id,
        title: "Unwanted",
      }),
    ).toBeNull();
  });
  it("migrates existing Threads to chosen and constrains all provenance values", async () => {
    const f = await fixture();
    const { thread } = await f.create();
    await database.transaction().execute(async (transaction) => {
      await sql`alter table threads drop column title_source`.execute(transaction);
      await threadTitleSourceMigration.up(transaction);
      expect(
        await transaction
          .selectFrom("threads")
          .select("titleSource")
          .where("id", "=", thread.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({
        titleSource: "chosen",
      });
    });
    await expect(
      sql`update threads set title_source='unknown' where id=${thread.id}`.execute(database),
    ).rejects.toMatchObject({
      code: "23514",
    });
    await expect(
      sql`update threads set title_source=null where id=${thread.id}`.execute(database),
    ).rejects.toMatchObject({
      code: "23502",
    });
    expect(
      await store.applyGeneratedThreadName({
        threadId: thread.id,
        title: "Unwanted",
      }),
    ).toBeNull();
  });
  it("renames once with absolute state, records the command, and replays without undoing newer names", async () => {
    const f = await fixture();
    const { thread } = await f.create({
      generateTitle: true,
    });
    const key = randomUUID();
    const result = await rename(f, thread.id, "  Chosen name  ", key);
    expect(result.thread.title).toBe("Chosen name");
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      type: "thread.state-changed",
      sequence: result.asOfSequence,
      data: {
        title: "Chosen name",
        status: "idle",
        inputQueuePaused: false,
        pendingRequests: 0,
      },
    });
    await rename(f, thread.id, "Later name");
    expect((await rename(f, thread.id, "Chosen name", key)).thread.title).toBe("Later name");
    expect(published).toHaveLength(2);
    await expect(rename(f, thread.id, "Different", key)).rejects.toMatchObject({
      code: "conflict",
    });
    expect(await row(thread.id)).toMatchObject({
      title: "Later name",
      titleSource: "chosen",
    });
    expect(
      await store.applyGeneratedThreadName({
        threadId: thread.id,
        title: "Late engine",
      }),
    ).toBeNull();
    const recorded = await database
      .selectFrom("commands")
      .select(["type", "status"])
      .where("idempotencyKey", "=", key)
      .executeTakeFirstOrThrow();
    expect(recorded).toEqual({
      type: "thread.rename",
      status: "succeeded",
    });
  });
  it("marks an unchanged rename chosen without an event, so a late candidate loses", async () => {
    const f = await fixture();
    const { thread } = await f.create({
      generateTitle: true,
    });
    const head = (
      await database
        .selectFrom("workspaces")
        .select("eventSequence")
        .where("id", "=", f.workspace.id)
        .executeTakeFirstOrThrow()
    ).eventSequence;
    const result = await rename(f, thread.id, thread.title);
    expect(result.asOfSequence).toBe(head);
    expect(published).toEqual([]);
    expect(await row(thread.id)).toMatchObject({
      titleSource: "chosen",
    });
    expect(
      await store.applyGeneratedThreadName({
        threadId: thread.id,
        title: "Late engine",
      }),
    ).toBeNull();
  });
  it("validates rename text and refuses home Chat", async () => {
    const f = await fixture();
    const { thread } = await f.create();
    for (const title of ["  ", "a".repeat(241)]) {
      await expect(rename(f, thread.id, title)).rejects.toThrow();
      expect(
        hostApi["commands.dispatch"].payload.safeParse({
          type: "thread.rename",
          threadId: thread.id,
          title,
          idempotencyKey: randomUUID(),
        }).success,
      ).toBe(false);
    }
    const home = await f.create({
      home: true,
    });
    await expect(rename(f, home.thread.id, "Renamed Chat")).rejects.toMatchObject({
      code: "bad_request",
    });
    expect(await row(home.thread.id)).toMatchObject({
      title: "Chat",
      titleSource: "chosen",
    });
  });
  it("lets active collaborators rename without owning execution and refuses revoked or absent members", async () => {
    const f = await fixture();
    const { thread } = await f.create({
      generateTitle: true,
    });
    const collaborator = await store.createUser("Collaborator");
    const tokenHash = `sha256:${randomUUID()}`;
    const invitation = await store.createWorkspaceInvitation({
      createdBy: f.userId,
      expiresAt: new Date(Date.now() + 60_000),
      idempotencyKey: randomUUID(),
      intendedEmail: null,
      requestFingerprint: `sha256:${randomUUID()}`,
      role: "collaborator",
      selector: randomUUID(),
      tokenHash,
      type: "link",
    });
    await store.acceptWorkspaceInvitation({
      selector: invitation.selector,
      tokenHash,
      userEmail: "collaborator@titles.test",
      userEmailVerified: true,
      userId: collaborator,
    });
    expect(await store.environmentIsAvailableToUser(f.environmentId, collaborator)).toBe(false);
    expect(
      (
        await commands.renameThread({
          requestedBy: collaborator,
          threadId: thread.id,
          title: "Shared task",
          idempotencyKey: randomUUID(),
        })
      ).thread.title,
    ).toBe("Shared task");
    await commands.setThreadIcon({
      requestedBy: collaborator,
      threadId: thread.id,
      icon: "plane",
      idempotencyKey: randomUUID(),
    });
    expect((await row(thread.id)).icon).toBe("plane");
    await expect(
      store.setWorkspaceColor({
        requestedBy: collaborator,
        color: "teal",
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    const outsider = await store.createUser("Outsider");
    await expect(
      commands.renameThread({
        requestedBy: outsider,
        threadId: thread.id,
        title: "No",
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    await database
      .updateTable("workspaceMemberships")
      .set({
        state: "revoked",
        revokedAt: new Date(),
        revokedBy: f.userId,
      })
      .where("userId", "=", collaborator)
      .execute();
    await expect(
      commands.setThreadIcon({
        requestedBy: collaborator,
        threadId: thread.id,
        icon: "plane",
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      commands.renameThread({
        requestedBy: collaborator,
        threadId: thread.id,
        title: "No",
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
  });
  it("accepts exactly one candidate across duplicates and concurrent reports; gone Threads are harmless", async () => {
    const f = await fixture();
    const { thread } = await f.create({
      generateTitle: true,
    });
    const results = await Promise.all(
      ["First candidate", "Other candidate"].map((title) =>
        store.applyGeneratedThreadName({
          threadId: thread.id,
          title,
        }),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const event = results.find((value) => value !== null)!.event;
    if (event.type !== "thread.state-changed") throw new Error("Expected a state event");
    expect(await row(thread.id)).toMatchObject({
      titleSource: "generated",
      title: event.data.title,
    });
    expect(
      await store.applyGeneratedThreadName({
        threadId: thread.id,
        title: "Duplicate",
      }),
    ).toBeNull();
    await database.deleteFrom("threads").where("id", "=", thread.id).execute();
    expect(
      await store.applyGeneratedThreadName({
        threadId: thread.id,
        title: "Gone",
      }),
    ).toBeNull();
    expect(
      await store.applyGeneratedThreadName({
        threadId: createId("thread"),
        title: "Never existed",
      }),
    ).toBeNull();
  });
  it("paginates provisional naming work with an immutable id cursor", async () => {
    const f = await fixture();
    const ids: ThreadId[] = [];
    for (let index = 0; index < 3; index++) {
      const { thread } = await f.create({
        generateTitle: true,
      });
      await send(f, thread.id, [
        {
          type: "text",
          text: `Work ${index}`,
        },
      ]);
      ids.push(thread.id);
    }
    ids.sort();
    const first = await store.listThreadNamingCandidates(2);
    expect(first.map((row) => row.id)).toEqual(ids.slice(0, 2));
    const next = await store.listThreadNamingCandidates(2, first.at(-1)!.id);
    expect(next.map((row) => row.id)).toEqual(ids.slice(2));
  });
  it("fences naming apply by source, expiry, account revision and live membership", async () => {
    const f = await fixture();
    const { thread } = await f.create({
      generateTitle: true,
    });
    await send(f, thread.id, [
      {
        type: "text",
        text: "Name this work",
      },
    ]);
    const input = await store.getThreadNamingInput(thread.id);
    if (!input) throw new Error("Expected naming input");
    const account = await store.getHarnessInstance(input.harnessInstanceId);
    if (!account) throw new Error("Expected account");
    const authority = {
      ...input,
      harnessRevision: account.runtimeRevision,
      expiresAt: Date.now() + 60_000,
    };
    const apply = (namingAuthority = authority) =>
      store.applyGeneratedThreadName({
        threadId: thread.id,
        title: "Generated title",
        icon: "plane",
        namingAuthority,
      });
    expect(
      await apply({
        ...authority,
        expiresAt: Date.now() - 1,
      }),
    ).toBeNull();
    expect(
      await apply({
        ...authority,
        sourceMessageId: createId("message"),
      }),
    ).toBeNull();
    expect(
      await apply({
        ...authority,
        harnessRevision: account.runtimeRevision + 1,
      }),
    ).toBeNull();
    await database
      .updateTable("harnessInstances")
      .set({
        enabled: false,
        isDefault: false,
      })
      .where("id", "=", account.id)
      .execute();
    expect(await apply()).toBeNull();
    await database
      .updateTable("harnessInstances")
      .set({
        enabled: true,
      })
      .where("id", "=", account.id)
      .execute();
    const otherOwner = await store.createUser("Other owner");
    const membership = await database
      .selectFrom("workspaceMemberships")
      .selectAll()
      .where("userId", "=", input.requestedBy)
      .executeTakeFirstOrThrow();
    await database
      .insertInto("workspaceMemberships")
      .values({
        ...membership,
        id: createId("workspaceMembership"),
        userId: otherOwner,
      })
      .execute();
    await database
      .updateTable("workspaceMemberships")
      .set({
        state: "revoked",
        revokedAt: new Date(),
        revokedBy: otherOwner,
      })
      .where("userId", "=", input.requestedBy)
      .execute();
    expect(await apply()).toBeNull();
    await database
      .updateTable("workspaceMemberships")
      .set({
        state: "active",
        revokedAt: null,
        revokedBy: null,
      })
      .where("userId", "=", input.requestedBy)
      .execute();
    await rename(f, thread.id, "Person's title");
    const result = await apply();
    expect(result?.event.type).toBe("thread.state-changed");
    expect(await row(thread.id)).toMatchObject({
      title: "Person's title",
      titleSource: "chosen",
      icon: "plane",
      iconSource: "generated",
    });
    expect(await apply()).toBeNull();
  });
  it("excludes actual homeThreadId even if its fields are provisional", async () => {
    const f = await fixture();
    const { thread } = await f.create({
      home: true,
    });
    await send(f, thread.id, [
      {
        type: "text",
        text: "Do not name Chat",
      },
    ]);
    await database
      .updateTable("threads")
      .set({
        titleSource: "provisional",
        iconSource: "provisional",
      })
      .where("id", "=", thread.id)
      .execute();
    expect(await store.getThreadNamingInput(thread.id)).toBeNull();
  });
  it("a concurrent rename always survives generation", async () => {
    const f = await fixture();
    const { thread } = await f.create({
      generateTitle: true,
    });
    await Promise.all([
      store.applyGeneratedThreadName({
        threadId: thread.id,
        title: "Engine",
      }),
      rename(f, thread.id, "Person"),
    ]);
    expect(await row(thread.id)).toMatchObject({
      title: "Person",
      titleSource: "chosen",
    });
  });
  it.each(["run.failed", "run.interrupted"] as const)(
    "excludes withdrawn input after %s, independent of the next Run's history",
    async (type) => {
      const f = await fixture();
      const { thread } = await f.create({
        generateTitle: true,
      });
      const text = "a".repeat(threadTitleRequestMaxLength - 1) + "😀 tail";
      const first = await send(f, thread.id, [
        {
          type: "text",
          text,
        },
      ]);
      if (!first.command || !first.run) throw new Error("No queued Run");
      await store.claimCommand(first.command.id, "title-dispatcher");
      expect(await store.getThreadNamingInput(thread.id)).toMatchObject({
        request: "a".repeat(threadTitleRequestMaxLength - 1),
        icon: true,
      });
      const binding = await store.acquireExecutionBinding({
        bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
        continuationIdentity,
        harnessInstanceId: f.harness.id,
        leaseTokenHash: randomUUID(),
        runnerBootId: "title-boot",
        runnerId: f.runnerId,
        runId: first.run.id,
        threadId: thread.id,
      });
      await store.commitRunnerEvent({
        environmentId: f.environmentId,
        runnerBootId: "title-boot",
        runnerId: f.runnerId,
        event: PendingAgentEventSchema.parse({
          bindingGeneration: binding.bindingGeneration,
          emittedAt: new Date().toISOString(),
          environmentId: f.environmentId,
          ordinal: 0,
          runId: first.run.id,
          threadId: thread.id,
          type,
          data:
            type === "run.failed"
              ? {
                  code: "test",
                  message: "Failed startup",
                  retryable: false,
                  status: "failed",
                }
              : {
                  status: "interrupted",
                },
        }),
      });
      const next = await send(f, thread.id, [
        {
          type: "text",
          text: "Retry this work",
        },
      ]);
      if (!next.command || !next.run) throw new Error("No retry Run");
      await store.claimCommand(next.command.id, "title-dispatcher");
      const context = await new OpensteerStore(database).loadRunDispatchContext(next.command.id, {
        maxBytes: 1,
        maxItems: 1,
      });
      expect(context.inputs[0]?.content).toEqual([
        {
          type: "text",
          text: "Retry this work",
        },
      ]);
      expect(context.history).toEqual([]);
      expect(await store.getThreadNamingInput(thread.id)).toMatchObject({
        request: "Retry this work",
        icon: true,
      });
      await store.applyGeneratedThreadName({
        threadId: thread.id,
        title: "Generated",
        icon: "plane",
      });
      expect(await store.getThreadNamingInput(thread.id)).toBeNull();
      await rename(f, thread.id, "Renamed");
      expect(await store.getThreadNamingInput(thread.id)).toBeNull();
    },
  );
  it("keeps attachment-only first messages provisional, even when later messages contain text", async () => {
    const f = await fixture();
    const { thread } = await f.create({
      generateTitle: true,
    });
    const attachments = new AttachmentStore(database);
    const reserved = await attachments.reserve({
      idempotencyKey: randomUUID(),
      mediaType: "image/png",
      name: "picture.png",
      sizeBytes: 4,
      uploaderId: f.userId,
    });
    await attachments.complete({
      attachmentId: reserved.id,
      install: async () => undefined,
      kind: "image",
      sha256: createHash("sha256").update("image").digest("hex"),
      uploaderId: f.userId,
    });
    const first = await send(f, thread.id, [
      {
        type: "artifact",
        artifactId: reserved.id,
        mediaType: "image/png",
        name: "picture.png",
        sizeBytes: 4,
      },
    ]);
    if (!first.command) throw new Error("No attachment Run");
    await send(f, thread.id, [
      {
        type: "text",
        text: "Later text is not the first message",
      },
    ]);
    await store.claimCommand(first.command.id, "title-dispatcher");
    expect(await store.getThreadNamingInput(thread.id)).toBeNull();
  });
  it.each(["trigger", "watch"] as const)(
    "marks %s delegation fallbacks provisional and explicit names chosen",
    async (kind) => {
      const f = await fixture();
      const { thread: anchor } = await f.create();
      const triggers = new TriggerStore(database);
      const created = await triggers.create({
        actorThreadId: null,
        anchorThreadId: anchor.id,
        createdBy: f.userId,
        idempotencyKey: randomUUID(),
        name: "Title automation",
        program: {
          language: "javascript",
          toolContractVersion: 3,
          source: "export default async () => null",
        },
        source:
          kind === "trigger"
            ? {
                kind: "schedule",
                schedule: {
                  kind: "cron",
                  expression: "0 9 * * *",
                  timezone: "UTC",
                },
              }
            : {
                kind: "watch",
              },
      });
      const common = {
        exp: Math.floor(Date.now() / 1_000) + 60,
        iat: Math.floor(Date.now() / 1_000),
        iss: "opensteer-host" as const,
        jti: randomUUID(),
        environmentId: f.environmentId,
        toolContractVersion: 2 as const,
        triggerId: created.trigger.id,
      };
      let handle: (value: unknown) => ReturnType<TriggerToolsTestClient["handle"]>;
      if (kind === "trigger") {
        const occurrence = await triggers.enqueueManual({
          actorThreadId: null,
          ownerId: f.userId,
          triggerId: created.trigger.id,
        });
        await store.claimCommand(occurrence.commandId, "title-trigger");
        const started = await triggers.startExecution({
          commandId: occurrence.commandId,
          runnerBootId: "title-boot",
          runnerId: f.runnerId,
        });
        const claims: TriggerControlScope = {
          ...common,
          aud: "opensteer-trigger-control",
          occurrenceId: occurrence.id,
          executionGeneration: started.executionGeneration,
          requestedBy: f.userId,
          runnerBootId: "title-boot",
          runnerId: f.runnerId,
          threadId: anchor.id,
        };
        const service = new TriggerToolsTestClient({
          canRunHarness: () => true,
          commands,
          defaultWorkspaceBacking: "local-directory",
          environmentWorkspaceBackings: () => ["local-directory"],
          isEnvironmentConnected: () => true,
          store,
          tokens: {
            authenticate: async () => claims,
          } as unknown as TriggerControlTokenService,
          triggers: {
            manage: async () => {
              throw new Error("Unexpected manage");
            },
          },
          workspaces: {
            projectPath: async (workspace) => `/Main/Projects/${workspace.slug}`,
            create: async (input) =>
              createTestWorkspace(store, {
                ...input,
                backing: {
                  kind: "local-directory",
                  generation: 1,
                  bindingId: createId("workspaceBinding"),
                  ownerEnvironmentId: f.environmentId,
                  storageAuthorityId: createId("storageAuthority"),
                },
                status: "ready",
              }),
          },
        });
        handle = (value) => service.handle("test-token", value);
        const response = await handle({
          type: "project.create",
          requestId: randomUUID(),
          name: "Travel",
          icon: "plane",
          color: "teal",
        });
        if (response.type !== "project.create.result") throw new Error("Expected Workspace");
        expect(await store.getWorkspaceForOwner(response.workspace.id, f.userId)).toMatchObject({
          icon: "plane",
          color: "teal",
        });
      } else {
        const snapshot = await triggers.reconcileWatchesForRunner({
          environmentId: f.environmentId,
          leaseExpiresAt: new Date(Date.now() + 60_000),
          runnerBootId: "title-boot",
          runnerConnectionGeneration: 1,
          runnerId: f.runnerId,
        });
        const activation = snapshot.activations[0]!.activation;
        const claims: WatchControlScope = {
          ...common,
          aud: "opensteer-watch-control",
          activationId: activation.id,
          anchorThreadId: anchor.id,
          createdBy: f.userId,
          executionGeneration: activation.executionGeneration,
          revisionId: activation.revisionId,
        };
        const service = new WatchToolsTestClient({
          environmentWorkspaceBackings: () => ["local-directory"],
          canRunHarness: () => true,
          commands,
          isEnvironmentConnected: () => true,
          store,
          tokens: {
            authenticate: async () => claims,
          },
        });
        handle = (value) => service.handle("test-token", value);
      }
      for (const title of [undefined, "Automation chosen title"]) {
        const task = "Check   inventory " + "with detailed instructions ".repeat(14);
        const request = {
          requestId: randomUUID(),
          ...(kind === "watch"
            ? {
                observationId: randomUUID(),
              }
            : {}),
          type: "thread.delegate",
          task,
          ...(title === undefined
            ? {}
            : {
                title,
              }),
        };
        const response = await handle(request);
        if (response.type !== "thread.delegate.result")
          throw new Error("Expected a delegated Thread");
        if (!(await readToolRecords(store, response.result)).run!)
          throw new Error("Expected a delegated Run");
        const worker = (await readToolRecords(store, response.result)).thread;
        expect(await row(worker.id)).toMatchObject({
          title: title ?? provisionalThreadTitle(task),
          titleSource: title === undefined ? "provisional" : "chosen",
          icon: null,
          iconSource: "provisional",
        });
        const retry =
          kind === "watch"
            ? {
                ...request,
                requestId: randomUUID(),
              }
            : request;
        expect(await handle(retry)).toMatchObject({
          type: "thread.delegate.result",
          result: {
            threadId: worker.id,
            assignmentId: response.result.assignmentId,
          },
        });
        for (const changed of [
          {
            task: task + " changed",
          },
          {
            title: "Changed explicit name",
          },
        ]) {
          await expect(
            handle({
              ...retry,
              ...changed,
            }),
          ).rejects.toMatchObject({
            code: "conflict",
          });
        }
        // Recreate the canonical receipt written before title provenance existed.
        await sql`update commands set payload = (payload - 'titleSource' - 'callerIntent') ||
          jsonb_build_object('title', ${title ?? task.slice(0, 240)}::text)
          where payload->>'type' = 'thread.delegate' and thread_id = ${worker.id}`.execute(
          database,
        );
        expect(await handle(retry)).toMatchObject({
          type: "thread.delegate.result",
          result: {
            threadId: worker.id,
            assignmentId: response.result.assignmentId,
          },
        });
        for (const changed of [
          {
            task: task + " changed",
          },
          {
            title: "Changed explicit name",
          },
        ]) {
          await expect(
            handle({
              ...request,
              ...changed,
            }),
          ).rejects.toMatchObject({
            code: "conflict",
          });
        }
        const command = await database
          .selectFrom("commands")
          .select("id")
          .where("runId", "=", (await readToolRecords(store, response.result)).run!.id)
          .where("type", "=", "run.execute")
          .executeTakeFirstOrThrow();
        await store.claimCommand(command.id, "title-dispatcher");
        expect(
          (await store.getThreadNamingInput(worker.id))?.request.includes("Check   inventory"),
        ).toBe(true);
        expect(
          (await store.applyGeneratedThreadName({
            threadId: worker.id,
            title: "Inventory review",
          })) === null,
        ).toBe(title !== undefined);
      }
    },
  );
  it("takes the first input's text and place labels, excluding assistant messages", async () => {
    const f = await fixture();
    const { thread } = await f.create({
      generateTitle: true,
    });
    const first = await send(f, thread.id, [
      {
        type: "text",
        text: "  Research",
      },
      {
        type: "text",
        text: "the site  ",
      },
    ]);
    if (!first.command) throw new Error("No command");
    // Assistant content can precede imported/authored input and must never name it.
    const principal = await database
      .selectFrom("principals")
      .select("id")
      .where("userId", "=", f.userId)
      .executeTakeFirstOrThrow();
    const content = [
      ...first.message.content,
      {
        type: "artifact",
        artifactId: "file-evidence",
        name: "report.pdf",
        mediaType: "application/pdf",
      },
      {
        type: "phone",
        machineId: f.runnerId,
        name: "Test phone",
        display: "screen",
      },
    ];
    await sql`update messages set sequence=2, content=${JSON.stringify(content)}::jsonb where id=${first.message.id}`.execute(
      database,
    );
    await database
      .insertInto("messages")
      .values({
        id: createId("message"),
        threadId: thread.id,
        runId: null,
        sequence: 1,
        kind: "assistant",
        actorPrincipalId: principal.id,
        author: {
          kind: "agent",
          displayName: "Assistant",
          runId: createId("run"),
          threadId: thread.id,
          workspaceName: f.workspace.name,
        },
        content: sql`${JSON.stringify([
          {
            type: "text",
            text: "Wrong title source",
          },
        ])}::jsonb`,
      })
      .execute();
    await store.claimCommand(first.command.id, "title-dispatcher");
    expect(await store.getThreadNamingInput(thread.id)).toMatchObject({
      request: "Research\nthe site  \nreport.pdf\nTest phone",
      icon: true,
    });
    expect((await row(thread.id)).titleSource).toBe("provisional");
  });
  it("backfills marks in creator creation order and distinguishes actual Chat from conversations", async () => {
    const f = await fixture();
    const home = await f.create({
      home: true,
    });
    const created = [home];
    for (let index = 0; index < 8; index++) {
      created.push(await f.create());
      await createTestWorkspace(store, {
        createdBy: f.userId,
        idempotencyKey: randomUUID(),
        kind: "project",
        name: `Specialist ${index}`,
        status: "ready",
        backing: {
          kind: "local-directory",
          generation: 1,
          bindingId: createId("workspaceBinding"),
          ownerEnvironmentId: createId("environment"),
          storageAuthorityId: createId("storageAuthority"),
        },
      });
    }
    const other = await fixture();
    await other.create();
    await database
      .updateTable("workspaces")
      .set({
        createdAt: new Date("2026-01-01T00:00:00Z"),
      })
      .execute();
    await database
      .updateTable("threads")
      .set({
        createdAt: new Date("2026-01-01T00:00:00Z"),
        purpose: "voice",
      })
      .execute();
    await database.transaction().execute(async (transaction) => {
      await sql`drop index threads_creator_created; drop index workspaces_creator_created;
        alter table threads drop column icon, drop column icon_source, drop column color;
        alter table workspaces drop column color`.execute(transaction);
      await taskMarksMigration.up(transaction);
    });
    const rows = await database
      .selectFrom("threads")
      .selectAll()
      .orderBy("createdAt")
      .orderBy("id")
      .execute();
    const counts = new Map<string, number>();
    for (const value of rows) {
      const index = counts.get(value.createdBy) ?? 0;
      counts.set(value.createdBy, index + 1);
      expect(value).toMatchObject({
        icon: null,
        color: markColorAllocationOrder[index % 7],
        iconSource: value.id === home.thread.id ? "chosen" : "provisional",
      });
    }
    const workspaces = await database
      .selectFrom("workspaces")
      .selectAll()
      .orderBy("createdAt")
      .orderBy("id")
      .execute();
    counts.clear();
    for (const value of workspaces) {
      const index = counts.get(value.createdBy) ?? 0;
      counts.set(value.createdBy, index + 1);
      expect(value.color).toBe(markColorAllocationOrder[index % 7]);
    }
    expect((await store.getWorkspaceForOwner(f.workspace.id, f.userId))?.color).toBe(
      workspaces.find((value) => value.id === f.workspace.id)?.color,
    );
    for (const [column, value] of [
      ["icon", "invented"],
      ["icon_source", "invented"],
      ["color", "red"],
    ]) {
      await expect(
        sql`update threads set ${sql.ref(column!)}=${value} where id=${home.thread.id}`.execute(
          database,
        ),
      ).rejects.toMatchObject({
        code: "23514",
      });
    }
    await expect(sql`update workspaces set color='red'`.execute(database)).rejects.toMatchObject({
      code: "23514",
    });
  });
  it("allocates seven serial colours, isolates creators, orders ties, and preserves replay", async () => {
    const f = await fixture();
    const created = [];
    for (let index = 0; index < 7; index++) created.push((await f.create()).thread);
    expect(created.map((thread) => thread.color)).toEqual(markColorAllocationOrder);
    const key = randomUUID();
    const input = {
      createdBy: f.userId,
      environmentId: f.environmentId,
      harnessInstanceId: f.harness.id,
      idempotencyKey: key,
      modelSelection,
      title: "Replay",
    };
    const first = await store.createThread(input);
    await f.create();
    expect((await store.createThread(input)).thread.color).toBe(first.thread.color);
    await database
      .updateTable("threads")
      .set({
        createdAt: new Date("2026-01-01T00:00:00Z"),
      })
      .execute();
    const recent = await database
      .selectFrom("threads")
      .select("color")
      .where("createdBy", "=", f.userId)
      .orderBy("createdAt", "desc")
      .orderBy("id", "desc")
      .limit(6)
      .execute();
    expect((await f.create()).thread.color).toBe(nextMarkColor(recent.map((row) => row.color)));
    const other = await fixture();
    expect((await other.create()).thread.color).toBe("blue");
    for (const table of ["threads", "workspaces"] as const) {
      // Small fixtures favour a sequential scan; this proves the exact ordered read has an index path.
      await sql`analyze ${sql.table(table)}`.execute(database);
      const plan = await database.transaction().execute(async (transaction) => {
        await sql`set local enable_seqscan=off`.execute(transaction);
        return sql`explain (analyze, buffers) select color from ${sql.table(table)} where created_by=${f.userId} order by created_at desc, id desc limit 6`.execute(
          transaction,
        );
      });
      await writeFile(
        join(evidenceRoot, `${table}-colour-read-plan.json`),
        JSON.stringify(plan.rows, null, 2),
      );
      expect(JSON.stringify(plan.rows)).toContain(`${table}_creator_created`);
    }
  });
  it("sets icons with membership, replay conflicts, Chat refusal and a silent same-value lock", async () => {
    const f = await fixture();
    const { thread } = await f.create({
      generateTitle: true,
    });
    const outsider = await store.createUser("Outsider");
    const input = {
      threadId: thread.id,
      requestedBy: f.userId,
      idempotencyKey: randomUUID(),
      icon: "plane" as const,
    };
    await expect(
      commands.setThreadIcon({
        ...input,
        requestedBy: outsider,
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    await commands.setThreadIcon(input);
    expect(await row(thread.id)).toMatchObject({
      icon: "plane",
      iconSource: "chosen",
      titleSource: "provisional",
    });
    expect(published.filter((e) => e.type === "thread.state-changed")).toMatchObject([
      {
        data: {
          icon: "plane",
          title: thread.title,
        },
      },
    ]);
    await commands.setThreadIcon({
      ...input,
      idempotencyKey: randomUUID(),
      icon: "hotel",
    });
    await commands.setThreadIcon(input);
    expect((await row(thread.id)).icon).toBe("hotel");
    await expect(
      commands.setThreadIcon({
        ...input,
        icon: "house",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    await store.applyGeneratedThreadName({
      threadId: thread.id,
      title: "Generated name",
      icon: "plane",
    });
    expect(await row(thread.id)).toMatchObject({
      title: "Generated name",
      icon: "hotel",
      iconSource: "chosen",
    });
    const home = await f.create({
      home: true,
    });
    await expect(
      commands.setThreadIcon({
        ...input,
        idempotencyKey: randomUUID(),
        threadId: home.thread.id,
      }),
    ).rejects.toMatchObject({
      code: "bad_request",
    });
    const pending = await f.create();
    await store.applyGeneratedThreadName({
      threadId: pending.thread.id,
      icon: "plane",
    });
    published.length = 0;
    await commands.setThreadIcon({
      ...input,
      threadId: pending.thread.id,
      idempotencyKey: randomUUID(),
    });
    expect(published).toEqual([]);
    expect((await row(pending.thread.id)).iconSource).toBe("chosen");
    expect(
      await store.applyGeneratedThreadName({
        threadId: pending.thread.id,
        icon: "hotel",
      }),
    ).toBeNull();
  });
  it("settles title and icon independently, honours Use default and ignores empty reports", async () => {
    const f = await fixture();
    const chosen = await f.create();
    const generated = await store.applyGeneratedThreadName({
      threadId: chosen.thread.id,
      title: "Ignore",
      icon: "plane",
    });
    expect(generated?.event).toMatchObject({
      type: "thread.state-changed",
      data: {
        title: chosen.thread.title,
        icon: "plane",
      },
    });
    const pending = await f.create({
      generateTitle: true,
    });
    await commands.setThreadIcon({
      threadId: pending.thread.id,
      requestedBy: f.userId,
      icon: null,
      idempotencyKey: randomUUID(),
    });
    const result = await store.applyGeneratedThreadName({
      threadId: pending.thread.id,
      title: "New name",
      icon: "hotel",
    });
    expect(result?.event).toMatchObject({
      data: {
        title: "New name",
        icon: "document",
      },
    });
    expect(await row(pending.thread.id)).toMatchObject({
      titleSource: "generated",
      iconSource: "chosen",
      icon: "document",
    });
    expect(
      await store.applyGeneratedThreadName({
        threadId: pending.thread.id,
      }),
    ).toBeNull();
    const both = await f.create({
      generateTitle: true,
    });
    const before = published.length;
    const combined = await store.applyGeneratedThreadName({
      threadId: both.thread.id,
      title: "Combined",
      icon: "plane",
    });
    expect(combined?.events).toHaveLength(1);
    expect(combined?.event).toMatchObject({
      data: {
        title: "Combined",
        icon: "plane",
      },
    });
    expect(published).toHaveLength(before);
    await rename(f, both.thread.id, "Person");
    expect((await row(both.thread.id)).icon).toBe("plane");
  });
  it("allocates Workspace colours, fingerprints explicit picks, and enforces owner edit rules", async () => {
    const f = await fixture();
    const input = {
      backing: {
        kind: "local-directory" as const,
        generation: 1,
        bindingId: createId("workspaceBinding"),
        ownerEnvironmentId: createId("environment"),
        storageAuthorityId: createId("storageAuthority"),
      },
      createdBy: f.userId,
      idempotencyKey: randomUUID(),
      kind: "project" as const,
      name: "Specialist",
      status: "ready" as const,
    };
    const created = [f.workspace];
    for (let index = 0; index < 6; index++)
      created.push(
        await createTestWorkspace(store, {
          ...input,
          backing: {
            ...input.backing,
            bindingId: createId("workspaceBinding"),
          },
          idempotencyKey: randomUUID(),
        }),
      );
    expect(created.map((workspace) => workspace.color)).toEqual(markColorAllocationOrder);
    const allocatedInput = {
      ...input,
      backing: {
        ...input.backing,
        bindingId: createId("workspaceBinding"),
      },
      idempotencyKey: randomUUID(),
    };
    const allocated = await createTestWorkspace(store, allocatedInput);
    expect((await createTestWorkspace(store, allocatedInput)).color).toBe(allocated.color);
    const receipt = await database
      .selectFrom("commands")
      .select("payload")
      .where("idempotencyKey", "=", allocatedInput.idempotencyKey)
      .executeTakeFirstOrThrow();
    expect(receipt.payload).toHaveProperty("request");
    expect(receipt.payload).not.toHaveProperty("request.color");
    const workspace = await createTestWorkspace(store, {
      ...input,
      color: "teal",
    });
    expect(workspace.color).toBe("teal");
    const edit = {
      requestedBy: f.userId,
      idempotencyKey: randomUUID(),
      color: "sky" as const,
    };
    const task = await store.createThread({
      createdBy: f.userId,
      environmentId: f.environmentId,
      harnessInstanceId: f.harness.id,
      idempotencyKey: randomUUID(),
      modelSelection,
      title: "Specialist task",
    });
    await commands.setWorkspaceColor(edit);
    expect((await row(task.thread.id)).color).toBe(task.thread.color);
    await store.setWorkspaceColor({
      ...edit,
      color: "purple",
      idempotencyKey: randomUUID(),
    });
    expect((await store.setWorkspaceColor(edit)).color).toBe("purple");
    expect(
      (
        await createTestWorkspace(store, {
          ...input,
          color: "teal",
        })
      ).color,
    ).toBe("purple");
    await expect(
      createTestWorkspace(store, {
        ...input,
        color: "sky",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      store.setWorkspaceColor({
        ...edit,
        color: "lime",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(
      store.setWorkspaceColor({
        ...edit,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: "bad_request",
    });
    const outsider = await store.createUser("Other");
    await expect(
      store.setWorkspaceColor({
        ...edit,
        requestedBy: outsider,
      }),
    ).rejects.toMatchObject({
      code: "not_found",
    });
    for (const status of ["deleting", "deleted"] as const) {
      await database
        .updateTable("workspaces")
        .set({
          status,
          deletionRequestedAt: new Date(),
          deletionRequestedBy: f.userId,
          purgeAfter: new Date(),
          deletedAt: status === "deleted" ? new Date() : null,
        })
        .where("id", "=", workspace.id)
        .execute();
      await expect(
        store.setWorkspaceColor({
          ...edit,
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toMatchObject({
        code: "conflict",
      });
    }
  });
  it("carries marks through snapshots, task pages, catalog and history without unread or notifications", async () => {
    const f = await fixture();
    const { thread } = await f.create({
      generateTitle: true,
    });
    const before = await store.workspaceSnapshot(f.workspace.id, {
      viewerId: f.userId,
    });
    const result = await commands.setThreadIcon({
      threadId: thread.id,
      requestedBy: f.userId,
      icon: "plane",
      idempotencyKey: randomUUID(),
    });
    expect(result.thread).toMatchObject({
      icon: "plane",
      color: thread.color,
    });
    const snapshot = await store.workspaceSnapshot(f.workspace.id, {
      viewerId: f.userId,
    });
    expect(snapshot.threads.find((value) => value.id === thread.id)).toMatchObject({
      icon: "plane",
      color: thread.color,
    });
    expect(snapshot.workspace.color).toBe(f.workspace.color);
    const unread = (value: typeof snapshot) =>
      value.readStates.map(({ threadId, readSequence, unreadSequence }) => ({
        threadId,
        readSequence,
        unreadSequence,
      }));
    expect(unread(snapshot)).toEqual(unread(before));
    expect(snapshot.messages).toEqual(before.messages);
    const markEvent = await database
      .selectFrom("deploymentEvents")
      .selectAll()
      .where("sequence", "=", result.asOfSequence)
      .executeTakeFirstOrThrow();
    expect(
      mayNotify(
        AgentEventSchema.parse({
          ...markEvent,
          createdAt: markEvent.createdAt.toISOString(),
        }),
      ),
    ).toBe(false);
    expect(
      (
        await store.taskPageForUser({
          userId: f.userId,
        })
      ).tasks.find((value) => value.thread.id === thread.id)?.thread,
    ).toMatchObject({
      icon: "plane",
      color: thread.color,
    });
    expect(
      (
        await store.workspacePageForOwner({
          ownerId: f.userId,
        })
      ).workspaces.find((value) => value.id === f.workspace.id)?.color,
    ).toBe(f.workspace.color);
    const history = await store.threadEventPageForOwner({
      ownerId: f.userId,
      threadId: thread.id,
    });
    expect(history?.thread).toMatchObject({
      icon: "plane",
      color: thread.color,
    });
    const events = await database
      .selectFrom("deploymentEvents")
      .select(["type", "data"])
      .where("threadId", "=", thread.id)
      .execute();
    for (const event of events.filter((value) => value.type === "thread.state-changed"))
      expect(event.data).toHaveProperty("icon", "plane");
  });
  it("replays all legacy Thread-bearing events with absent marks and keeps the current snapshot", async () => {
    const f = await fixture();
    const { thread } = await f.create();
    const { icon: _icon, color: _color, ...legacy } = thread;
    const created = await database
      .selectFrom("deploymentEvents")
      .selectAll()
      .where("threadId", "=", thread.id)
      .where("type", "=", "thread.created")
      .executeTakeFirstOrThrow();
    const data = sql`${JSON.stringify({
      thread: legacy,
    })}::jsonb`;
    await database
      .updateTable("deploymentEvents")
      .set({
        data,
      })
      .where("eventId", "=", created.eventId)
      .execute();
    let sequence = BigInt(created.sequence);
    for (const type of ["thread.execution-updated", "thread.listed"] as const) {
      sequence += 1n;
      await database
        .insertInto("deploymentEvents")
        .values({
          ...created,
          eventId: createId("event"),
          sequence: sequence.toString(),
          type,
          data,
        })
        .execute();
    }
    await database
      .updateTable("workspaces")
      .set({
        eventSequence: sequence.toString(),
      })
      .where("id", "=", f.workspace.id)
      .execute();
    const events = await store.eventsAfter(f.workspace.id, zeroSequence);
    expect(events).toHaveLength(3);
    for (const event of events) {
      if (
        event.type !== "thread.created" &&
        event.type !== "thread.execution-updated" &&
        event.type !== "thread.listed"
      )
        throw new Error("Expected Thread-bearing event");
      expect(event.data.thread.icon).toBeNull();
      expect(event.data.thread.color).toBeUndefined();
    }
    expect(
      (
        await store.workspaceSnapshot(f.workspace.id, {
          viewerId: f.userId,
        })
      ).threads[0],
    ).toMatchObject({
      icon: null,
      color: thread.color,
    });
  });
});
