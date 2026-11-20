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
  AgentConnectionStore,
  beginAgentSession,
  createDatabase,
  OpensteerStore,
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
    a.serve(f.document(3, defaultWorkPolicy));
    await a.service.refresh();
    a.serve(f.document(2, permissive));
    await a.service.refresh();
    a.serve(f.document(3, permissive));
    await a.service.refresh();
    expect(a.errors).toEqual([]);
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
      execute: async ({ mode }) => mode,
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
