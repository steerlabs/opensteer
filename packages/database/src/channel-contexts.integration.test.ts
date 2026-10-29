import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import {
  createChannelId,
  ChannelConversationIdSchema,
  slackChannelProviderManifest,
  type ChannelAccessPolicy,
  type ChannelAccountId,
} from "@opensteer/channel-core";
import {
  HarnessIdSchema,
  ThreadAccessModeSchema,
  createId,
  type EnvironmentId,
  type HarnessInstanceId,
  type RunnerId,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import { HarnessInstanceCatalogSchema, type RunnerDescriptor } from "@opensteer/protocol";
import type { Kysely } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChannelStore, createDatabase, migrateToLatest, OpensteerStore } from "./index.js";
import type { DatabaseSchema } from "./schema.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

const notices = {
  approvalPending: "Your access request is waiting for approval.",
  linkByDirectMessage: "Send me a direct message to link your account.",
  linkCode: (code: string) => `Enter the code **${code}** to link your account.`,
  noRoute: "This conversation is not routed to an Opensteer Workspace.",
  notAMember: "You don't have access to the Workspace this conversation is routed to.",
} as const;

function accessPolicy(mode: "anyone" | "linked-members"): ChannelAccessPolicy {
  const sender: ChannelAccessPolicy["directMessages"] = { allowedExternalUserIds: [], mode };
  return {
    channels: { conversationIds: [], scope: "all", sender },
    directMessages: sender,
  };
}

integration("channel conversation authority contexts", () => {
  const databaseName = `opensteer_channel_contexts_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  let database: Kysely<DatabaseSchema>;
  let maintenance: Pool;
  let store: OpensteerStore;
  let channels: ChannelStore;
  let environmentId: EnvironmentId;
  let harnessInstanceId: HarnessInstanceId;
  let runnerId: RunnerId;

  function urlForDatabase(name: string): string {
    const url = new URL(databaseUrl ?? "postgres://unconfigured");
    url.pathname = `/${name}`;
    return url.toString();
  }

  beforeAll(async () => {
    maintenance = new Pool({ connectionString: urlForDatabase("postgres") });
    await maintenance.query(`drop database if exists ${databaseName}`);
    await maintenance.query(`create database ${databaseName}`);
    database = createDatabase({
      applicationName: "opensteer-channel-contexts-test",
      connectionString: urlForDatabase(databaseName),
      maxConnections: 4,
    });
    await migrateToLatest(database);
    store = new OpensteerStore(database);
    channels = new ChannelStore(database);

    await store.ensureDeployment({
      canonicalOrigin: "https://channel-contexts.test.invalid",
      hostInstanceId: createId("hostInstance"),
      deploymentShape: { defaultWorkspaceBacking: "portablefs", kind: "server" },
    });

    runnerId = createId("runner");
    environmentId = createId("environment");
    const enrollmentTokenHash = `sha256:${createHash("sha256")
      .update(`channel-contexts-${runnerId}`)
      .digest("base64url")}`;
    await store.createRunnerEnrollment({
      allowedModules: ["agents", "messaging"],
      createdBy: null,
      expiresAt: new Date(Date.now() + 60_000),
      id: `ren_${randomUUID()}`,
      idempotencyKey: "channel-contexts-runner",
      mainEnrollmentPurpose: "initial",
      name: "Channel contexts runner",
      requestFingerprint: "sha256:channel-contexts-runner",
      runnerKind: "main",
      tokenHash: enrollmentTokenHash,
    });
    const keys = generateKeyPairSync("ed25519");
    const publicKeyPem = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
    const publicKeyDer = keys.publicKey.export({ format: "der", type: "spki" });
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
          localStorage: null,
          maxConcurrentRuns: 4,
          providerStateModes: ["isolated"],
          workspaceBackings: ["portablefs"],
          workspaceMounts: [],
        },
        messaging: {
          capabilities: [
            {
              manifest: slackChannelProviderManifest,
              provider: "slack",
              transportKinds: ["socket"],
            },
          ],
        },
      },
      name: "Channel contexts runner",
      runnerId,
      runnerKind: "main",
      runtimeVersion: "test",
    };
    await store.enrollRunnerConnection({
      descriptor,
      enrollmentTokenHash,
      publicKeyFingerprint: `sha256:${createHash("sha256")
        .update(publicKeyDer)
        .digest("base64url")}`,
      publicKeyPem,
    });
    const harness = await store.createHarnessInstance({
      config: { model: "test" },
      driverKind: HarnessIdSchema.parse("native"),
      environmentId,
      name: "Native",
      stateKind: "isolated",
    });
    harnessInstanceId = harness.id;
    // A channel Thread takes its model from what the Runner reported for the
    // account, so the fixture has to have reported something.
    await store.recordHarnessCatalogs({
      catalogs: [
        HarnessInstanceCatalogSchema.parse({
          continuationIdentity: {
            continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
            driverKind: "native",
          },
          driverKind: "native",
          harnessInstanceId,
          models: [
            {
              displayName: "GPT-5.6 Sol",
              isDefault: true,
              modelId: "gpt-5.6-sol",
              options: [],
              providerId: "openai",
            },
          ],
          status: "ready",
        }),
      ],
      environmentId,
      expectedRevisions: new Map([[harness.id, harness.runtimeRevision]]),
    });
  });

  afterAll(async () => {
    await database?.destroy();
    if (maintenance) {
      await maintenance.query(`drop database if exists ${databaseName}`);
      await maintenance.end();
    }
  });

  async function createFixture(suffix: string, policy: ChannelAccessPolicy) {
    const ownerId = await store.createUser(`${suffix} owner`);
    const workspace = await store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: `vol_channel_context_${suffix}`,
      },
      capacityPolicy: {
        blockHardLimitBytes: 10_000_000,
        inodeHardLimit: 10_000,
        kind: "hard-quota",
      },
      createdBy: ownerId,
      idempotencyKey: `workspace-channel-context-${suffix}`,
      name: `Channel context ${suffix}`,
      status: "ready",
    });
    const configured = await channels.createConnection({
      accessPolicy: policy,
      account: {
        displayName: `Context ${suffix}`,
        externalAccountId: `T-CONTEXT-${suffix}`,
        routingMode: "dedicated",
      },
      connection: {
        connectionMethod: "bring-your-own",
        displayName: `Context ${suffix}`,
        externalIdentityId: `U-BOT-CONTEXT-${suffix}`,
        externalTenantId: `T-CONTEXT-${suffix}`,
        provider: "slack",
        runnerId,
        transportKind: "socket",
      },
      createdBy: ownerId,
      credential: {
        encryptedPayload: Buffer.from(`channel-context-${suffix}`),
        encryptionKeyVersion: 1,
        id: createId("credential"),
        name: `Context ${suffix}`,
        ownerId,
        provider: "channel:slack",
      },
      executionPolicy: { harness: "default", harnessInstanceId: null },
      selector: { conversationId: null, conversationType: null, scopeId: null, threadId: null },
      workspaceId: workspace.id,
    });
    await channels.setRuntimeConnectionHealth({
      connectionId: configured.connection.id,
      detail: null,
      reason: null,
      runnerId,
      status: "connected",
    });
    return { ...configured, ownerId, suffix, workspace };
  }

  async function addCollaborator(workspaceId: WorkspaceId, ownerId: UserId, userId: UserId) {
    await database
      .insertInto("workspaceMemberships")
      .values({
        generation: 1,
        id: createId("workspaceMembership"),
        invitedBy: ownerId,
        joinedAt: new Date(),
        revokedAt: null,
        revokedBy: null,
        role: "collaborator",
        state: "active",
        updatedAt: new Date(),
        userId,
        workspaceId,
      })
      .executeTakeFirstOrThrow();
  }

  async function addLinkedIdentity(
    accountId: ChannelAccountId,
    externalUserId: string,
    displayName: string,
    userId: UserId,
  ) {
    const now = new Date();
    const principalId = createChannelId("principal");
    await database
      .insertInto("principals")
      .values({
        displayName,
        id: principalId,
        kind: "channel-identity",
        updatedAt: now,
        userId: null,
      })
      .executeTakeFirstOrThrow();
    await database
      .insertInto("channelIdentities")
      .values({
        accountId,
        displayName,
        externalUserId,
        id: createChannelId("identity"),
        linkedUserId: userId,
        principalId,
        status: "linked",
        updatedAt: now,
      })
      .executeTakeFirstOrThrow();
  }

  function channelEvent(input: {
    readonly actorName: string;
    readonly eventId: string;
    readonly externalUserId: string;
    readonly suffix: string;
  }) {
    return {
      accountExternalId: `T-CONTEXT-${input.suffix}`,
      actor: { displayName: input.actorName, externalUserId: input.externalUserId },
      content: [{ text: `Message ${input.eventId}`, type: "text" as const }],
      conversation: {
        displayName: "shared-context",
        externalConversationId: `C-CONTEXT-${input.suffix}`,
        externalScopeId: `T-CONTEXT-${input.suffix}`,
        externalThreadId: "1786320000.000100",
        type: "channel" as const,
      },
      eventId: input.eventId,
      occurredAt: new Date().toISOString(),
      provider: "slack" as const,
      providerMessageId: input.eventId,
      trigger: "mention" as const,
    };
  }

  async function adoptEvent(
    fixture: Awaited<ReturnType<typeof createFixture>>,
    actor: { readonly displayName: string; readonly externalUserId: string },
    eventId: string,
  ) {
    const committed = await channels.commitIngress(
      fixture.connection.id,
      channelEvent({
        actorName: actor.displayName,
        eventId,
        externalUserId: actor.externalUserId,
        suffix: fixture.suffix,
      }),
    );
    const claimed = await channels.claimIngress(`context-worker-${eventId}`);
    expect(claimed?.id).toBe(committed.ingressId);
    if (!claimed) throw new Error("Expected committed channel ingress to be claimable");
    const adopted = await channels.adoptIngress({
      claimToken: claimed.claimToken,
      ingressId: claimed.id,
      notices,
      placementCandidates: [{ environmentId, harnessInstanceId }],
    });
    expect(adopted.kind).toBe("adopted");
    if (adopted.kind !== "adopted") throw new Error("Expected adopted channel ingress");
    const input = await database
      .selectFrom("channelIngressEvents")
      .innerJoin("threadInputs", "threadInputs.messageId", "channelIngressEvents.messageId")
      .select([
        "threadInputs.threadId",
        "threadInputs.requestedBy",
        "threadInputs.replyTarget",
        "threadInputs.policy",
        "threadInputs.state",
      ])
      .where("channelIngressEvents.id", "=", claimed.id)
      .executeTakeFirstOrThrow();
    expect(input).toMatchObject({ policy: "queue", state: "pending" });
    return { ...adopted, input };
  }

  it("keeps two linked users in distinct roots and returns each user to their own context", async () => {
    const fixture = await createFixture("linked", accessPolicy("linked-members"));
    const collaboratorId = await store.createUser("Linked collaborator");
    await addCollaborator(fixture.workspace.id, fixture.ownerId, collaboratorId);
    await addLinkedIdentity(fixture.account.id, "U-LINKED-OWNER", "Linked owner", fixture.ownerId);
    await addLinkedIdentity(
      fixture.account.id,
      "U-LINKED-COLLABORATOR",
      "Linked collaborator",
      collaboratorId,
    );

    const ownerFirst = await adoptEvent(
      fixture,
      { displayName: "Linked owner", externalUserId: "U-LINKED-OWNER" },
      "Ev-LINKED-OWNER-1",
    );
    const collaborator = await adoptEvent(
      fixture,
      { displayName: "Linked collaborator", externalUserId: "U-LINKED-COLLABORATOR" },
      "Ev-LINKED-COLLABORATOR-1",
    );
    const ownerReturn = await adoptEvent(
      fixture,
      { displayName: "Linked owner", externalUserId: "U-LINKED-OWNER" },
      "Ev-LINKED-OWNER-2",
    );

    expect(ownerFirst.input.threadId).not.toBe(collaborator.input.threadId);
    expect(ownerReturn.run).toBeNull(); // Waiting work does not borrow the first message's Run.
    expect(ownerReturn.input.threadId).toBe(ownerFirst.input.threadId);
    const contexts = await database
      .selectFrom("channelConversationContexts")
      .innerJoin("threads", "threads.id", "channelConversationContexts.activeThreadId")
      .select([
        "channelConversationContexts.authorityUserId",
        "channelConversationContexts.activeThreadId",
        "threads.parentThreadId",
        "threads.icon",
        "threads.iconSource",
        "threads.color",
      ])
      .where(
        "channelConversationContexts.conversationId",
        "=",
        ChannelConversationIdSchema.parse(ownerFirst.input.replyTarget?.conversationId),
      )
      .orderBy("channelConversationContexts.authorityUserId")
      .execute();
    expect(contexts).toHaveLength(2);
    expect(contexts.map(({ authorityUserId }) => authorityUserId).sort()).toEqual(
      [fixture.ownerId, collaboratorId].sort(),
    );
    expect(contexts.every(({ parentThreadId }) => parentThreadId === null)).toBe(true);
    expect(
      contexts.every(
        ({ icon, iconSource, color }) =>
          icon === null && iconSource === "provisional" && color === "blue",
      ),
    ).toBe(true);
  });

  it("shares an anyone context between linked and unlinked senders under fixed owner authority", async () => {
    const fixture = await createFixture("anyone", accessPolicy("anyone"));
    await addLinkedIdentity(fixture.account.id, "U-ANYONE-OWNER", "Anyone owner", fixture.ownerId);

    const owner = await adoptEvent(
      fixture,
      { displayName: "Anyone owner", externalUserId: "U-ANYONE-OWNER" },
      "Ev-ANYONE-OWNER",
    );
    const guest = await adoptEvent(
      fixture,
      { displayName: "Unlinked guest", externalUserId: "U-ANYONE-GUEST" },
      "Ev-ANYONE-GUEST",
    );

    expect(guest.run).toBeNull();
    expect(guest.input.requestedBy).toBe(fixture.ownerId);
    expect(guest.input.threadId).toBe(owner.input.threadId);
    await expect(
      database
        .selectFrom("threads")
        .select(["capabilityProfileId", "createdBy", "parentThreadId"])
        .where("id", "=", owner.input.threadId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      capabilityProfileId: "workspace",
      createdBy: fixture.ownerId,
      parentThreadId: null,
    });
    await expect(
      database
        .selectFrom("channelConversationContexts")
        .select(["activeThreadId", "authorityUserId"])
        .where(
          "conversationId",
          "=",
          ChannelConversationIdSchema.parse(owner.input.replyTarget?.conversationId),
        )
        .execute(),
    ).resolves.toEqual([
      { activeThreadId: owner.input.threadId, authorityUserId: fixture.ownerId },
    ]);
  });

  it("requires the pausing person or a Workspace owner to resume shared work", async () => {
    const fixture = await createFixture("resume-authority", accessPolicy("anyone"));
    const collaboratorId = await store.createUser("Queue collaborator");
    await addCollaborator(fixture.workspace.id, fixture.ownerId, collaboratorId);
    const first = await adoptEvent(
      fixture,
      { displayName: "Guest", externalUserId: "U-RESUME-GUEST" },
      "Ev-RESUME-GUEST",
    );
    if (!first.run) throw new Error("Expected first channel work to reserve a Run");
    await store.enqueueRunnerControl({
      idempotencyKey: "resume-authority-stop",
      requestedBy: fixture.ownerId,
      runId: first.run.id,
      threadId: first.run.threadId,
      type: "run.interrupt",
    });
    const waiting = await store.enqueueThreadInput({
      content: [{ type: "text", text: "Work queued while stopped" }],
      idempotencyKey: "resume-authority-waiting",
      policy: "queue",
      requestedBy: collaboratorId,
      source: { kind: "human" },
      threadId: first.run.threadId,
    });
    expect(waiting.run).toBeNull();
    await expect(
      store.resumeThreadInputQueue({
        idempotencyKey: "resume-authority-denied",
        requestedBy: collaboratorId,
        threadId: first.run.threadId,
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: expect.stringContaining("person who paused"),
    });
    const resumed = await store.resumeThreadInputQueue({
      idempotencyKey: "resume-authority-owner",
      requestedBy: fixture.ownerId,
      threadId: first.run.threadId,
    });
    expect(resumed.thread.inputQueuePaused).toBe(false);
    const run = await database
      .selectFrom("runs")
      .selectAll()
      .where("seedInputId", "=", waiting.message.id)
      .executeTakeFirstOrThrow();
    expect(run.requestedBy).toBe(collaboratorId);
    await store.enqueueRunnerControl({
      idempotencyKey: "resume-authority-collaborator-stop",
      requestedBy: collaboratorId,
      runId: run.id,
      threadId: run.threadId,
      type: "run.interrupt",
    });
    const selfResumed = await store.resumeThreadInputQueue({
      idempotencyKey: "resume-authority-self",
      requestedBy: collaboratorId,
      threadId: run.threadId,
    });
    expect(selfResumed.thread.inputQueuePaused).toBe(false);
  });

  it("refuses Done for an active channel Thread but permits a rotated historical task", async () => {
    const fixture = await createFixture("done-scope", accessPolicy("anyone"));
    await addLinkedIdentity(fixture.account.id, "U-DONE-OWNER", "Done owner", fixture.ownerId);
    const first = await adoptEvent(
      fixture,
      { displayName: "Done owner", externalUserId: "U-DONE-OWNER" },
      "Ev-DONE-1",
    );
    await expect(
      store.setThreadDone({
        done: true,
        threadId: first.input.threadId,
        requestedBy: fixture.ownerId,
        idempotencyKey: "active-channel-done",
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    await channels.updateBinding({
      accessPolicy: accessPolicy("linked-members"),
      bindingId: fixture.binding.id,
      expectedRevision: fixture.binding.revision,
      ownerUserId: fixture.ownerId,
    });
    const second = await adoptEvent(
      fixture,
      { displayName: "Done owner", externalUserId: "U-DONE-OWNER" },
      "Ev-DONE-2",
    );
    expect(second.input.threadId).not.toBe(first.input.threadId);
    expect(
      (
        await store.setThreadDone({
          done: true,
          threadId: first.input.threadId,
          requestedBy: fixture.ownerId,
          idempotencyKey: "historical-channel-done",
        })
      ).thread.doneAt,
    ).not.toBeNull();
  });

  it("rotates a policy revision to a fresh root instead of parenting it to the old context", async () => {
    const fixture = await createFixture("rotation", accessPolicy("anyone"));
    await addLinkedIdentity(
      fixture.account.id,
      "U-ROTATION-OWNER",
      "Rotation owner",
      fixture.ownerId,
    );
    const first = await adoptEvent(
      fixture,
      { displayName: "Rotation owner", externalUserId: "U-ROTATION-OWNER" },
      "Ev-ROTATION-1",
    );
    const updated = await channels.updateBinding({
      accessPolicy: accessPolicy("linked-members"),
      bindingId: fixture.binding.id,
      expectedRevision: fixture.binding.revision,
      ownerUserId: fixture.ownerId,
    });
    const second = await adoptEvent(
      fixture,
      { displayName: "Rotation owner", externalUserId: "U-ROTATION-OWNER" },
      "Ev-ROTATION-2",
    );

    expect(second.input.threadId).not.toBe(first.input.threadId);
    await expect(
      database
        .selectFrom("threads")
        .select(["capabilityProfileId", "lineageRootThreadId", "parentThreadId"])
        .where("id", "=", second.input.threadId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      capabilityProfileId: "workspace",
      lineageRootThreadId: second.input.threadId,
      parentThreadId: null,
    });
    await expect(
      database
        .selectFrom("channelConversationContexts")
        .select(["activeThreadId", "bindingRevision"])
        .where(
          "conversationId",
          "=",
          ChannelConversationIdSchema.parse(second.input.replyTarget?.conversationId),
        )
        .where("authorityUserId", "=", fixture.ownerId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      activeThreadId: second.input.threadId,
      bindingRevision: updated.revision,
    });
  });
});
