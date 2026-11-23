import { normalizeToolError } from "@opensteer/agent-tools";
import {
  canonicalWorkAuditRecord,
  defaultWorkPolicy,
  OrganizationIdSchema,
  WorkAssignmentIdSchema,
  WorkAuditRecordSchema,
  workAuditGenesisHash,
  workAuditFlushPath,
  workPolicyChangedPath,
  workAuditSigningBytes,
  type WorkPolicy,
  type WorkPolicyDocument,
} from "@opensteer/control-plane-protocol";
import { createId, type AgentGrant } from "@opensteer/core";
import {
  admitCommand,
  AgentConnectionStore,
  beginAgentSession,
  commandAdmission,
  commandSubject,
  createDatabase,
  delegatingConnectionStanding,
  liveAgentConnection,
  OpensteerStore,
  TriggerStore,
  WorkHomeStore,
} from "@opensteer/database";
import { ownTestDatabaseProducer } from "@opensteer/database/test-support/database";
import { createStoreFixture, describeStore } from "@opensteer/database/test-support/store";
import { createHash, generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { expect, vi } from "vitest";
import Fastify from "fastify";
import { registerWorkHomeRoutes, WorkHomeService } from "./work-home.js";
import { AgentSessionService } from "../agent-sessions/agent-session-service.js";
import { agentToolFailure } from "../mcp/agent-tool-failure.js";
import { readableTabTasks } from "../tabs/tab-authority.js";
import { ConnectionOAuth } from "../mcp/connections/connection-oauth.js";

const marker = {
  organizationId: OrganizationIdSchema.parse(`org_${randomUUID()}`),
  organizationName: "Workshop",
  assignmentId: WorkAssignmentIdSchema.parse(`was_${randomUUID()}`),
};
const issuer = "https://account.test";
const origin = "https://home.test";
const permissive: WorkPolicy = {
  externalMaxMode: "full-access",
  allowEverything: true,
  allowTasks: true,
  devices: "assignee-may-enroll",
};
const selected: AgentGrant = { scope: "selected", tasks: false, resources: [] };

async function fixture(work = true) {
  const f = await createStoreFixture();
  const task = await f.startRunFixture("organization");
  const home = new WorkHomeStore(f.database);
  if (work) await home.initialize(marker, task.deploymentId);
  const connections = new AgentConnectionStore(f.database);
  const keys = generateKeyPairSync("ed25519");
  const document = (revision: number, policy: WorkPolicy): WorkPolicyDocument => ({
    assignmentId: marker.assignmentId,
    deploymentId: task.deploymentId,
    policy,
    revision,
    state: "active",
  });
  async function connect(grant: AgentGrant) {
    const connection = await connections.create({
      userId: task.userId,
      label: "Private label",
      clientName: "Private client",
      accessMode: "full-access",
      resource: origin,
      expiresAt: new Date(Date.now() + 60_000),
      grant,
    });
    await connections.activate(connection.id, randomUUID());
    return connection;
  }

  async function account() {
    const signer = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const jwk = { ...(await exportJWK(signer.publicKey)), alg: "EdDSA", kid: "account" };
    let current = document(1, permissive);
    const policy = vi.fn(async () => ({
      assertion: await new SignJWT({
        ...current,
        iss: issuer,
        aud: task.deploymentId,
        tokenUse: "opensteer-work-policy",
        iat: Math.floor(Date.now() / 1_000),
      })
        .setProtectedHeader({ alg: "EdDSA", kid: "account" })
        .sign(signer.privateKey),
    }));
    const reportWorkPolicy = vi.fn(async (_id: string, revision: number) => ({
      appliedRevision: revision,
    }));
    const pushWorkAudit = vi.fn(
      async (batch: import("@opensteer/control-plane-protocol").WorkAuditPush) => {
        expect(
          verify(
            null,
            workAuditSigningBytes(batch),
            keys.publicKey,
            Buffer.from(batch.signature, "base64url"),
          ),
        ).toBe(true);
        return { lastSequence: batch.records.at(-1)!.sequence };
      },
    );
    const errors: unknown[] = [];
    const service = new WorkHomeService({
      issuer: new URL(issuer),
      origin,
      assignmentId: marker.assignmentId,
      deploymentId: task.deploymentId,
      account: async () => ({ workPolicy: policy, reportWorkPolicy, pushWorkAudit }),
      key: keys.privateKey,
      store: home,
      jwksFetch: async () => Response.json({ keys: [jwk] }),
      onApplied: () => f.store.driveConnectionCleanups(),
      onError: (err) => errors.push(err),
    });
    return {
      service,
      signer,
      policy,
      reportWorkPolicy,
      pushWorkAudit,
      errors,
      serve: (next: WorkPolicyDocument) => {
        current = next;
      },
    };
  }
  return { ...f, task, home, connections, keys, document, connect, account };
}

describeStore("work Home", (it) => {
  it("policy revision never goes back", async () => {
    const f = await fixture();
    const a = await f.account();
    const shellResets = () =>
      f.database
        .selectFrom("clientChanges")
        .select("sequence")
        .where("scopeKey", "=", "shell")
        .where("operation", "=", "reset")
        .execute();
    const before = await shellResets();
    a.serve(f.document(3, defaultWorkPolicy));
    await a.service.refresh();
    a.serve(f.document(2, permissive));
    await a.service.refresh();
    a.serve(f.document(3, permissive));
    await a.service.refresh();
    expect(a.errors).toEqual([]);
    expect(await shellResets()).toHaveLength(before.length + 1);
    expect(await f.home.applied()).toMatchObject({ ...defaultWorkPolicy, appliedRevision: 3 });
    expect(a.reportWorkPolicy.mock.calls).toEqual([
      [marker.assignmentId, 3, expect.any(AbortSignal)],
    ]);
    a.service.close();
  });

  it("an unreachable Account leaves the last policy in force", async () => {
    const f = await fixture();
    expect(await f.home.applied()).toMatchObject({ ...defaultWorkPolicy, appliedRevision: 0 });
    const a = await f.account();
    a.serve(f.document(1, permissive));
    await a.service.refresh();
    a.policy.mockRejectedValueOnce(new Error("Account offline"));
    await a.service.refresh();
    expect(a.errors).toHaveLength(1);
    expect(await f.home.applied()).toMatchObject({ ...permissive, appliedRevision: 1 });
    expect(await f.connect({ scope: "everything" })).toMatchObject({ accessMode: "full-access" });
    a.service.close();
  });

  it("holds a connected agent's commands to the organization's ceiling, read with its grant", async () => {
    const f = await fixture();
    await f.home.apply(f.document(1, permissive));
    const connection = await f.connect({ scope: "everything" });
    const admit = async () =>
      (
        await admitCommand(f.database, {
          ownerUserId: f.task.userId,
          subject: commandSubject(`connection:${connection.id}`),
          command: {
            type: "harness.rename",
            idempotencyKey: randomUUID(),
            environmentId: createId("environment"),
            harnessInstanceId: createId("harnessInstance"),
            name: "Renamed",
          } as never,
        })
      ).answer;
    expect(await admit()).toBe("now");
    // The organization lowers what outside agents may do: the same command now asks the person.
    await f.home.apply(f.document(2, { ...permissive, externalMaxMode: "approval-required" }));
    expect(await admit()).toBe("ask");
  });

  it("refuses at commit a command the organization's policy narrowed after it was admitted", async () => {
    const f = await fixture();
    await f.home.apply(f.document(1, permissive));
    const connection = await f.connect({ scope: "everything" });
    const callerKey = `connection:${connection.id}`;
    const command = {
      type: "harness.rename",
      idempotencyKey: randomUUID(),
      environmentId: createId("environment"),
      harnessInstanceId: createId("harnessInstance"),
      name: "Renamed",
    } as never;
    expect(
      (
        await admitCommand(f.database, {
          ownerUserId: f.task.userId,
          subject: commandSubject(callerKey),
          command,
        })
      ).answer,
    ).toBe("now");
    // Between admission and commit the organization lowers outside agents' mode.
    await f.home.apply(f.document(2, { ...permissive, externalMaxMode: "approval-required" }));
    const identity = commandAdmission({ ownerUserId: f.task.userId, callerKey, command });
    await expect(
      f.database.transaction().execute((transaction) => identity.admit!(transaction)),
    ).rejects.toMatchObject({ code: "forbidden", reason: "authority-changed" });
  });

  it("reads one snapshot when a Work policy narrows immediately after the authority SELECT", async () => {
    const f = await fixture();
    await f.home.apply(f.document(1, permissive));
    const connection = await f.connect(selected);
    const statements: string[] = [];
    let armed = false;
    let narrowed = false;
    const observed = f.database.withPlugin({
      transformQuery({ node }) {
        if (armed) statements.push(JSON.stringify(node));
        return node;
      },
      async transformResult({ result }) {
        if (armed && !narrowed && statements.at(-1)?.includes("agent_connections")) {
          narrowed = true;
          await f.home.apply(
            f.document(2, { ...permissive, externalMaxMode: "approval-required" }),
          );
        }
        return result;
      },
    });
    await new WorkHomeStore(observed).initialize(marker, f.task.deploymentId);
    armed = true;
    expect(await liveAgentConnection(observed, f.task.userId, connection.id)).toMatchObject({
      grantRevision: 1,
      accessMode: "full-access",
    });
    expect(narrowed).toBe(true);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("work_home_policy");
    expect(await liveAgentConnection(observed, f.task.userId, connection.id)).toMatchObject({
      grantRevision: 2,
      accessMode: "approval-required",
    });
  });

  it("checks the target grant and Work policy from the same connection statement", async () => {
    const f = await fixture();
    await f.home.apply(f.document(1, permissive));
    const removed = { kind: "browser-profile", profileId: createId("browserProfile") } as const;
    const held = { kind: "browser-profile", profileId: createId("browserProfile") } as const;
    const connection = await f.connect({ ...selected, resources: [removed, held] });
    const statements: string[] = [];
    let cutAfterRead = false;
    const observed = f.database.withPlugin({
      transformQuery({ node }) {
        statements.push(JSON.stringify(node));
        return node;
      },
      async transformResult({ result }) {
        if (cutAfterRead && statements.at(-1)?.includes('"name":"agent_connections"')) {
          cutAfterRead = false;
          await f.connections.update(f.task.userId, {
            connectionId: connection.id,
            expectedRevision: 1,
            grant: { ...selected, resources: [held] },
          });
          await f.home.offboard();
        }
        return result;
      },
    });
    await new WorkHomeStore(observed).initialize(marker, f.task.deploymentId);
    const read = (grantTarget: typeof removed) => {
      statements.length = 0;
      return liveAgentConnection(observed, f.task.userId, connection.id, { grantTarget });
    };
    const expectOneStatement = () => {
      expect(statements).toEqual([expect.stringContaining('"name":"work_home_policy"')]);
      expect(statements[0]).toContain('"name":"agent_connections"');
    };

    cutAfterRead = true;
    await expect(read(removed)).resolves.toMatchObject({
      grantRevision: 1,
      accessMode: "full-access",
    });
    expect(cutAfterRead).toBe(false);
    expectOneStatement();
    await expect(read(removed)).rejects.toMatchObject({
      code: "not_found",
      message: "That item is unavailable.",
      next: undefined,
    });
    expectOneStatement();
    await expect(read(held)).rejects.toMatchObject({ code: "forbidden", reason: "work-policy" });
    expectOneStatement();
  });

  /** Observes every statement a reader runs, by the tables it names. */
  function observe(database: Parameters<typeof delegatingConnectionStanding>[0]) {
    const statements: string[] = [];
    const observed = database.withPlugin({
      transformQuery({ node }) {
        statements.push(JSON.stringify(node));
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    });
    return { observed, statements };
  }
  /** The state the policy writer never leaves: a grant the Work policy no longer allows. */
  async function forbidTasks(f: Awaited<ReturnType<typeof fixture>>) {
    await f.database
      .updateTable("workHomePolicy")
      .set({ policy: JSON.stringify({ ...permissive, allowTasks: false }) as never })
      .execute();
  }
  const everyMinute = {
    program: { toolContractVersion: 5, language: "javascript", source: "export default () => {}" },
    source: {
      kind: "schedule",
      schedule: { expression: "* * * * *", kind: "cron", timezone: "UTC" },
    },
  } as const;

  it("reads a connection's grant with the Work policy in one statement: a grant it no longer allows is ended, and its automation pauses", async () => {
    const f = await fixture();
    await f.home.apply(f.document(1, permissive));
    const connection = await f.connect({ ...selected, tasks: true });
    await f.database
      .updateTable("threads")
      .set({ originConnectionId: connection.id })
      .where("id", "=", f.task.threadId)
      .execute();
    const triggers = new TriggerStore(f.database);
    const { trigger } = await triggers.create({
      actorThreadId: null,
      anchorThreadId: f.task.threadId,
      createdBy: f.task.userId,
      idempotencyKey: "work-policy-standing",
      // Defined by the connection: it works for that connection.
      actorConnectionId: connection.id,
      name: "Every minute",
      ...everyMinute,
    });
    await forbidTasks(f);
    const { observed, statements } = observe(f.database);
    await new WorkHomeStore(observed).initialize(marker, f.task.deploymentId);
    statements.length = 0;
    expect(await delegatingConnectionStanding(observed, f.task.userId, connection.id)).toBe(
      "ended",
    );
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('"name":"agent_connections"');
    expect(statements[0]).toContain('"name":"work_home_policy"');
    await f.database
      .updateTable("triggers")
      .set({ nextFireAt: new Date(Date.now() - 60_000) })
      .where("id", "=", trigger.id)
      .execute();
    const claimed = await triggers.claimDueSchedules(new Date());
    expect(claimed.occurrences).toEqual([]);
    expect(
      await f.database
        .selectFrom("triggers")
        .select(["status", "nextFireAt"])
        .where("id", "=", trigger.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "paused", nextFireAt: null });
  });

  it("reads a paused chat whose grant the Work policy no longer allows as ended, not held", async () => {
    const f = await fixture();
    await f.home.apply(f.document(1, permissive));
    const bridge = await f.createBridgeFixture("work-paused");
    await bridge.channels.setConnectionStatus(
      bridge.configured.connection.id,
      bridge.fixture.userId,
      "paused",
    );
    expect(
      await delegatingConnectionStanding(f.database, bridge.fixture.userId, bridge.bridge.id),
    ).toBe("waiting");
    await forbidTasks(f);
    expect(
      await delegatingConnectionStanding(f.database, bridge.fixture.userId, bridge.bridge.id),
    ).toBe("ended");
  });

  it("on a personal Home reads a connection's standing without naming the Work policy", async () => {
    const f = await fixture(false);
    const connection = await f.connect({ ...selected, tasks: true });
    const { observed, statements } = observe(f.database);
    expect(await delegatingConnectionStanding(observed, f.task.userId, connection.id)).toBe("live");
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.some((statement) => statement.includes("work_home_policy"))).toBe(false);
  });

  it("lists for a connection no task once the Work policy no longer allows its grant", async () => {
    const f = await fixture();
    await f.home.apply(f.document(1, permissive));
    const connection = await f.connect({ scope: "everything" });
    const theirs = await f.createRunFixture("work-tabs-lineage");
    await f.database
      .updateTable("threads")
      .set({ originConnectionId: connection.id })
      .where("id", "=", theirs.threadId)
      .execute();
    const actor = {
      kind: "connection",
      caller: { connectionId: connection.id, userId: f.task.userId },
    } as never;
    const ids = [f.task.threadId, theirs.threadId];
    // Everything, allowed: the person's own task too.
    expect(await readableTabTasks(actor, ids, f.database)).toEqual(new Set(ids));
    // The policy no longer allows Everything, while the grant row still says it: no standing.
    await f.database
      .updateTable("workHomePolicy")
      .set({ policy: JSON.stringify({ ...permissive, allowEverything: false }) as never })
      .execute();
    expect(await readableTabTasks(actor, ids, f.database)).toEqual(new Set());
  });

  it("hides a target removed after resolution even when Work policy refuses admission", async () => {
    const f = await fixture();
    await f.home.apply(f.document(1, permissive));
    const resolved = { kind: "browser-profile", profileId: createId("browserProfile") } as const;
    const held = { kind: "browser-profile", profileId: createId("browserProfile") } as const;
    const connection = await f.connect({ ...selected, resources: [resolved, held] });
    const caller = await liveAgentConnection(f.database, f.task.userId, connection.id);
    expect(caller.grant).toMatchObject({ resources: expect.arrayContaining([resolved, held]) });
    await f.connections.update(f.task.userId, {
      connectionId: connection.id,
      expectedRevision: caller.grantRevision,
      grant: { ...selected, resources: [held] },
    });
    await f.home.offboard();

    const sessions = new AgentSessionService({ store: f.store });
    const execute = vi.fn(async () => undefined);
    const admit = (grant: typeof resolved) =>
      sessions.run({
        ownerUserId: f.task.userId,
        agentConnectionId: connection.id,
        operationKey: "direct-after-cut",
        tool: "tab_open",
        input: {},
        target: { grant, name: "Private profile", device: null },
        effect: "write",
        calls: "Open a tab",
        execute,
      });
    const refusal = async (target: typeof resolved) => {
      const error: unknown = await admit(target).then(
        () => {
          throw new Error("Expected direct admission to be refused");
        },
        (error: unknown) => error,
      );
      return normalizeToolError(agentToolFailure(error, "write", undefined, true), {
        tools: new Set(),
      });
    };
    try {
      expect(await refusal(resolved)).toEqual({
        code: "not_found",
        message: "That item is unavailable.",
        next: null,
      });
      expect(await refusal(held)).toEqual({
        code: "organization_not_allowed",
        message: "Your organization doesn't allow this",
        next: null,
      });
      expect(execute).not.toHaveBeenCalled();
      expect(
        await f.database
          .selectFrom("agentSessions")
          .select("id")
          .where("connectionId", "=", connection.id)
          .execute(),
      ).toEqual([]);
    } finally {
      sessions.stop();
    }
  });

  it("checks an own Run’s Work assignment in the existing binding round trips", async () => {
    const f = await fixture();
    const statements: string[] = [];
    const observed = f.database.withPlugin({
      transformQuery({ node }) {
        statements.push(JSON.stringify(node));
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    });
    await new WorkHomeStore(observed).initialize(marker, f.task.deploymentId);
    statements.length = 0;
    const store = new OpensteerStore(observed);
    const { bindingGeneration, environmentId, runId, runnerBootId, runnerId, threadId, userId } =
      f.task;
    const binding = {
      bindingGeneration,
      environmentId,
      requestedBy: userId,
      runId,
      runnerBootId,
      runnerId,
      threadId,
    };
    await expect(store.assertActiveExecutionBinding(binding)).resolves.toBeUndefined();
    expect(statements).toHaveLength(3);
    expect(
      statements.filter((statement) => statement.includes('"name":"work_home_policy"')),
    ).toEqual([expect.stringContaining('"name":"threads"')]);

    await f.home.apply({ ...f.document(1, permissive), state: "offboarding" });
    await expect(store.assertActiveExecutionBinding(binding)).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("externalMaxMode caps a connection's Run and its direct operation but not the person's own agent", async () => {
    const f = await fixture();
    await f.home.apply(f.document(1, { ...permissive, externalMaxMode: "approval-required" }));
    const task = f.task;
    const binding = (bindingId: string) =>
      f.store.admitExecution({
        ownerUserId: task.userId,
        subject: { kind: "binding", bindingId },
      });
    expect(await binding(`run:${task.run.id}`)).toMatchObject({
      actor: "native",
      mode: "full-access",
    });
    const connected = await f.connect({ ...selected, tasks: true });
    expect(connected.accessMode).toBe("approval-required");
    await f.database
      .updateTable("agentConnections")
      .set({ accessMode: "full-access" })
      .where("id", "=", connected.id)
      .execute();
    await f.database
      .updateTable("runs")
      .set({ connectionId: connected.id })
      .where("id", "=", task.run.id)
      .execute();
    expect(await binding(`run:${task.run.id}`)).toMatchObject({
      actor: "agent",
      mode: "approval-required",
    });
    const sessions = new AgentSessionService({ store: f.store });
    const operation = await sessions.run({
      ownerUserId: task.userId,
      agentConnectionId: connected.id,
      operationKey: "read",
      tool: "tab_list",
      input: { url: "https://private.example" },
      target: null,
      effect: "read",
      calls: "Private script",
      execute: async ({ mode }) => {
        const committed = await f.database.selectFrom("workAuditOutbox").select("record").execute();
        expect(
          committed.map(({ record }) => record).filter(({ kind }) => kind === "operation.direct"),
        ).toMatchObject([
          { effectiveMode: "approval-required", policyRevision: 1, outcome: "allowed" },
        ]);
        return mode;
      },
      summarize: () => ({ title: "Private title" }),
    });
    expect(operation).toMatchObject({ status: "completed", result: "approval-required" });
    const audit = await f.home.prepareAuditBatch();
    expect(audit?.records.filter(({ kind }) => kind === "operation.direct")).toMatchObject([
      { effectiveMode: "approval-required", policyRevision: 1, outcome: "allowed" },
      { effectiveMode: "approval-required", policyRevision: 1, outcome: "completed" },
    ]);
    expect(JSON.stringify(audit)).not.toMatch(/private\.example|Private script|Private title/u);
    sessions.stop();
  });

  it("a forbidden grant is refused at consent and at edit", async () => {
    const f = await fixture();
    const oauth = new ConnectionOAuth({
      deploymentId: f.task.deploymentId,
      store: f.connections,
      signingKey: f.keys.privateKey,
      verificationKey: f.keys.publicKey,
    });
    const redirect = "https://agent.test/callback";
    const registration = oauth.register(origin, {
      client_name: "private",
      redirect_uris: [redirect],
    });
    const link = await oauth.authorize(origin, {
      client_id: registration.client_id,
      redirect_uri: redirect,
      response_type: "code",
      code_challenge: "x".repeat(43),
      code_challenge_method: "S256",
    });
    const requestId = new URL(link, origin).searchParams.get("request")!;
    const connected = await f.connect(selected);
    expect(connected.grantRevision).toBe(1);
    for (const grant of [
      { scope: "everything" },
      { ...selected, tasks: true },
    ] satisfies AgentGrant[]) {
      await expect(
        oauth.decide(
          {
            type: "connection.authorize",
            requestId,
            idempotencyKey: "consent",
            decision: { kind: "approve", label: "private", accessMode: "full-access", grant },
          },
          f.task.userId,
          createId("authSession"),
        ),
      ).rejects.toMatchObject({
        message: "Your organization doesn't allow this",
      });
      await expect(
        f.connections.update(f.task.userId, {
          connectionId: connected.id,
          expectedRevision: 1,
          grant,
        }),
      ).rejects.toMatchObject({ message: "Your organization doesn't allow this" });
    }
  });

  it("a narrowed policy narrows or disconnects a live connection and stops its work", async () => {
    const f = await fixture();
    await f.home.apply(f.document(1, permissive));
    const scoped = await f.connect({ ...selected, tasks: true });
    const broad = await f.connect({ scope: "everything" });
    const direct = await beginAgentSession(f.database, {
      userId: f.task.userId,
      agentConnectionId: broad.id,
    });
    const run = f.task.run;
    await f.database
      .updateTable("runs")
      .set({
        connectionId: scoped.id,
        admittedGrantRevision: scoped.grantRevision,
        admittedAccessMode: "full-access",
      })
      .where("id", "=", run.id)
      .execute();
    await f.database
      .updateTable("runAttempts")
      .set({
        connectionId: scoped.id,
        admittedGrantRevision: scoped.grantRevision,
        admittedAccessMode: "full-access",
      })
      .where("runId", "=", run.id)
      .execute();
    await f.home.apply(f.document(2, defaultWorkPolicy));
    expect(
      await f.database
        .selectFrom("agentConnections")
        .selectAll()
        .where("id", "=", scoped.id)
        .executeTakeFirst(),
    ).toMatchObject({
      grant: { scope: "selected", tasks: false },
      accessMode: "approval-required",
      cleanupReason: "narrowed",
    });
    expect(
      await f.database
        .selectFrom("agentConnections")
        .selectAll()
        .where("id", "=", broad.id)
        .executeTakeFirst(),
    ).toMatchObject({ revokedAt: expect.any(Date), tokenHash: null, cleanupReason: "revoked" });
    const stop = vi.fn(async () => "ended" as const);
    const stopped = await f.store.driveConnectionCleanups({ stopper: { stop } });
    expect(stopped.failures).toEqual([]);
    expect(stop).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "run-attempt", runId: run.id }),
      expect.objectContaining({ connectionId: scoped.id, reason: "narrowed" }),
    );
    expect(
      await f.database
        .selectFrom("agentSessions")
        .select("status")
        .where("id", "=", direct.session.id)
        .executeTakeFirst(),
    ).toMatchObject({ status: "ended" });
    await f.home.apply(f.document(3, permissive));
    expect(
      await f.database
        .selectFrom("agentConnections")
        .select(["grant", "accessMode"])
        .where("id", "=", scoped.id)
        .executeTakeFirst(),
    ).toMatchObject({ grant: { tasks: false }, accessMode: "approval-required" });
  });

  it("narrows two connections and closes their pending direct Requests in one policy cut", async () => {
    const f = await fixture();
    await f.home.apply(f.document(1, permissive));
    const connections = [await f.connect(selected), await f.connect(selected)].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    const sessions = new AgentSessionService({ store: f.store, holdMs: 0 });
    const execute = vi.fn(async () => undefined);
    try {
      const requests = [];
      for (const connection of connections) {
        expect(connection.grantRevision).toBe(1);
        const pending = await sessions.run({
          ownerUserId: f.task.userId,
          agentConnectionId: connection.id,
          operationKey: "ask-before-cut",
          tool: "ask_person",
          input: {},
          target: null,
          effect: "read",
          calls: "Confirm the page is ready",
          question: async () => ({
            kind: "form",
            title: "Is the page ready?",
            fields: [
              {
                id: "ready",
                prompt: "Ready?",
                choices: [{ label: "Yes", value: "yes" }],
                custom: false,
                multiSelect: false,
                secret: false,
              },
            ],
          }),
          execute,
        });
        if (pending.status !== "pending" || pending.requestId === null)
          throw new Error("Expected a pending direct-operation Request");
        expect(await f.store.requests.get(pending.requestId)).toMatchObject({ status: "pending" });
        requests.push({
          connection,
          requestId: pending.requestId,
          operationId: pending.operationId,
        });
      }

      await expect(f.home.apply(f.document(2, defaultWorkPolicy))).resolves.toEqual({
        revision: 2,
        changed: true,
      });
      expect(await f.home.applied()).toMatchObject({ appliedRevision: 2 });
      for (const { connection, requestId, operationId } of requests) {
        expect(
          await f.database
            .selectFrom("agentConnections")
            .selectAll()
            .where("id", "=", connection.id)
            .executeTakeFirstOrThrow(),
        ).toMatchObject({
          grantRevision: 2,
          accessMode: "approval-required",
          cleanupReason: "narrowed",
          revokedAt: null,
        });
        expect(await f.store.requests.get(requestId)).toMatchObject({
          status: "cancelled",
          cancellationReason: "authority-revoked",
        });
        expect(
          await f.database
            .selectFrom("agentOperations")
            .select(["state", "terminalEvidenceAt"])
            .where("id", "=", operationId)
            .executeTakeFirstOrThrow(),
        ).toMatchObject({ state: "refused", terminalEvidenceAt: expect.any(Date) });
      }
      expect(
        await f.database
          .selectFrom("personalAttention")
          .select("id")
          .where(
            "requestId",
            "in",
            requests.map(({ requestId }) => requestId),
          )
          .execute(),
      ).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      sessions.stop();
    }
  });

  it("an owner Stop is audited once when the command is retried", async () => {
    const f = await fixture();
    const stop = {
      type: "run.interrupt" as const,
      idempotencyKey: "owner-stop",
      requestedBy: f.task.userId,
      threadId: f.task.threadId,
      runId: f.task.run.id,
      auditOwnerStop: true as const,
    };
    await f.store.enqueueRunnerControl(stop);
    await f.store.enqueueRunnerControl(stop);
    expect((await f.home.prepareAuditBatch())?.records).toEqual([
      { sequence: 1, at: expect.any(String), kind: "stop", ownerId: f.task.userId },
    ]);
  });

  it("the outbox is gapless and hash-chained across a restart", async () => {
    const f = await fixture();
    await f.home.apply(f.document(1, defaultWorkPolicy));
    const connection = await f.connect(selected);
    await expect(
      f.database.transaction().execute(async (tx) => {
        await tx
          .updateTable("agentConnections")
          .set({ accessMode: "auto" })
          .where("id", "=", connection.id)
          .execute();
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");
    const first = await f.home.prepareAuditBatch();
    expect(first?.records.map(({ kind }) => kind)).toEqual([
      "policy.applied",
      "connection.consent",
    ]);
    const { database } = await ownTestDatabaseProducer(f.databaseUrl, async () => {
      const database = createDatabase({ connectionString: f.databaseUrl });
      return { database, close: () => database.destroy() };
    });
    const restarted = new WorkHomeStore(database);
    await restarted.initialize(marker, f.task.deploymentId);
    await f.connections.revoke(f.task.userId, connection.id);
    expect(await restarted.prepareAuditBatch()).toEqual(first);
    await restarted.acknowledgeAuditBatch(first!.through);
    const later = await restarted.prepareAuditBatch();
    const records = [...first!.records, ...later!.records];
    expect(records.map(({ sequence }) => sequence)).toEqual([1, 2, 3]);
    expect(WorkAuditRecordSchema.array().parse(records)).toEqual(records);
    let hash = workAuditGenesisHash;
    for (const record of records)
      hash = createHash("sha256")
        .update(Buffer.from(hash, "hex"))
        .update(canonicalWorkAuditRecord(record))
        .digest("hex");
    expect(later!.headHash).toBe(hash);
    expect(JSON.stringify(records)).not.toContain("Private");
    const a = await f.account();
    expect(await a.service.flush(new AbortController().signal)).toBe("sent");
    expect(a.pushWorkAudit).toHaveBeenCalledOnce();
    expect(await restarted.prepareAuditBatch()).toBeNull();
    a.service.close();
  });

  it("signed Account notices refresh policy and flush the audit before offboarding", async () => {
    const f = await fixture();
    const a = await f.account();
    const app = Fastify();
    try {
      registerWorkHomeRoutes(app, a.service);
      const signed = async (
        tokenUse: "opensteer-work-policy-changed" | "opensteer-work-audit-flush",
      ) => {
        const iat = Math.floor(Date.now() / 1000);
        return {
          assertion: await new SignJWT({
            tokenUse,
            iss: issuer,
            aud: origin,
            assignmentId: marker.assignmentId,
            deploymentId: f.task.deploymentId,
            iat,
            exp: iat + 30,
          })
            .setProtectedHeader({ alg: "EdDSA", kid: "account" })
            .sign(a.signer.privateKey),
        };
      };
      const notice = await app.inject({
        method: "POST",
        url: workPolicyChangedPath,
        payload: await signed("opensteer-work-policy-changed"),
      });
      expect(notice.statusCode, notice.body).toBe(204);
      await a.service.refresh();
      expect(await f.home.applied()).toMatchObject({ appliedRevision: 1 });
      await f.connect(selected);
      const flush = await app.inject({
        method: "POST",
        url: workAuditFlushPath,
        payload: await signed("opensteer-work-audit-flush"),
      });
      expect(flush.statusCode, flush.body).toBe(204);
      expect(a.pushWorkAudit).toHaveBeenCalledOnce();
      expect(await f.home.prepareAuditBatch()).toBeNull();
      await expect(f.connect(selected)).rejects.toMatchObject({ reason: "work-policy" });
    } finally {
      a.service.close();
      await app.close();
    }
  });

  it("the hosting Device can remain and only an opted-in work Home enrolls another Device", async () => {
    const f = await fixture();
    const hosting = await f.database.selectFrom("devices").selectAll().executeTakeFirstOrThrow();
    const insert = () =>
      f.database
        .insertInto("devices")
        .values({
          id: createId("device"),
          deploymentId: f.task.deploymentId,
          ownerKind: "user",
          ownerUserId: f.task.userId,
          name: "Private phone name",
          kind: hosting.kind,
          platform: hosting.platform,
          form: hosting.form,
          accessPolicy: hosting.accessPolicy,
        })
        .executeTakeFirstOrThrow();
    await expect(insert()).rejects.toMatchObject({ code: "42501" });
    await f.home.apply(f.document(1, permissive));
    await insert();
    expect(await f.database.selectFrom("devices").select("id").execute()).toHaveLength(2);
    expect((await f.home.prepareAuditBatch())?.records.map(({ kind }) => kind)).toEqual([
      "policy.applied",
      "device.enrolled",
    ]);
  });

  it("a personal Home writes nothing", async () => {
    const f = await fixture(false);
    const connection = await f.connect({ scope: "everything" });
    expect(connection.accessMode).toBe("full-access");
    const queries: string[] = [];
    const observed = new OpensteerStore(
      f.database.withPlugin({
        transformQuery({ node }) {
          queries.push(JSON.stringify(node));
          return node;
        },
        async transformResult({ result }) {
          return result;
        },
      }),
    );
    expect(
      await observed.admitExecution({
        ownerUserId: f.task.userId,
        subject: { kind: "connection", agentConnectionId: connection.id },
      }),
    ).toMatchObject({ mode: "full-access" });
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.join(" ")).not.toMatch(/work(HomePolicy|Audit)|work_(home_policy|audit)/u);
    await beginAgentSession(f.database, {
      userId: f.task.userId,
      agentConnectionId: connection.id,
    });
    await f.connections.revoke(f.task.userId, connection.id);
    expect(await f.database.selectFrom("workAuditOutbox").selectAll().execute()).toEqual([]);
    expect(await f.database.selectFrom("workAuditHead").selectAll().execute()).toEqual([]);
    expect(await f.database.selectFrom("workHomePolicy").selectAll().execute()).toEqual([]);
  });
});
