import { testResourceData } from "../server/test-host-api-request.js";
import { slackChannelProviderManifest } from "@opensteer/channel-core";
import { createId } from "@opensteer/core";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  HostDescriptorSchema,
  hostApiVersion,
  hostApiVersionHeader,
  minimumHostApiVersion,
  verifyHostDiscoveryEnvelope,
} from "@opensteer/deployment-authority";
import { sessionExchangePath } from "@opensteer/protocol";
import { testRpcData } from "../server/test-host-api-request.js";
import {
  configurePersonalRemoteAccess,
  createMachineAccessDatabase,
  dispatchCallerRun,
  connectCallerMachine,
  connectPrimary,
  closed as waitForClose,
  startMachineAccessWireHost,
  type MachineAccessWireHost,
  type CallerMachine,
} from "./machine-access-protocol.test-support.js";
import { RunnerDescriptorSchema, RunnerBootIdSchema } from "@opensteer/protocol";

const integration = process.env.OPENSTEER_TEST_DATABASE_URL ? describe : describe.skip;

integration("Personal configuration conformance", () => {
  let clone: Awaited<ReturnType<typeof createMachineAccessDatabase>>;
  let host: MachineAccessWireHost;
  let caller: CallerMachine;
  const messagingToken = randomUUID().repeat(2);
  beforeAll(async () => {
    clone = await createMachineAccessDatabase(process.env.OPENSTEER_TEST_DATABASE_URL!);
    host = await startMachineAccessWireHost(clone.url, {
      manualRunner: true,
      messagingEnrollmentToken: messagingToken,
    });
    expect(await host.store.database.selectFrom("runners").select("id").execute()).toEqual([]);
    caller = await connectCallerMachine(host, {
      name: "Hosting computer",
      token: host.hostingRunnerEnrollmentToken,
    });
  }, 60_000);
  afterAll(async () => {
    await caller?.close();
    await host?.close();
    await clone?.drop();
  });

  it("advertises its signed identity and Personal epoch without a removed backing axis", async () => {
    const response = await host.runtime.app.inject({ url: "/.well-known/opensteer" });
    const descriptor = HostDescriptorSchema.parse(response.json());
    expect(verifyHostDiscoveryEnvelope(descriptor.authority)).toBeDefined();
    // The oldest version it serves, and the one it speaks.
    expect(descriptor.apiVersion).toBe(minimumHostApiVersion);
    expect(descriptor.currentApiVersion).toBe(hostApiVersion);
    expect(descriptor.authority.document.deploymentShape).toEqual({ kind: "personal" });
    expect(descriptor.authority.document.deploymentId).toBe(host.runtime.deployment.id);
  });

  it("refuses malformed requests at the shared boundary", async () => {
    await expectSharedHttpBoundary(host.runtime.app, {
      [hostApiVersionHeader]: String(hostApiVersion),
    });
  });

  it("requires a session and projects one owner, hosting computer, folder and current session", async () => {
    const anonymous = await host.runtime.app.inject({
      url: "/v1/rpc/personal.shell.get?input=%7B%7D",
      headers: { [hostApiVersionHeader]: String(hostApiVersion) },
    });
    expect(anonymous.statusCode).toBe(401);
    const auth = { headers: host.ownerHeaders };
    const shell = await testRpcData(host.origin, "personal.shell.get", {}, auth);
    const { settings } = await testResourceData(host.origin, "settings", auth);
    const { environments } = await testResourceData(host.origin, "environment", auth);
    expect(shell.session.user.id).toBe(host.ownerId);
    expect(settings).toMatchObject({ ownerId: host.ownerId, agentHome: host.agentHome });
    expect(environments).toContainEqual(
      expect.objectContaining({ id: host.ownerEnvironmentId, connected: true }),
    );
    const sessions = await testRpcData(
      host.origin,
      "sessions.list",
      {},
      { headers: host.ownerHeaders },
    );
    expect(sessions.sessions.filter((row) => row.current)).toHaveLength(1);
    expect(JSON.stringify({ shell, settings, environments })).not.toContain(host.config.authSecret);
    expect(JSON.stringify(sessions)).not.toContain(host.config.identity.localOwnerClaimToken);
  });

  it("registers the Personal routes and keeps local setup bound to its supervisor proof", async () => {
    for (const url of [
      "/v1/local-bootstrap",
      "/v1/personal-remote-access",
      "/.well-known/opensteer/personal-access-route",
    ])
      expect(host.runtime.app.hasRoute({ method: "GET", url })).toBe(true);
    for (const headers of [{}, { authorization: `Bearer ${"x".repeat(43)}` }]) {
      const response = await host.runtime.app.inject({ url: "/v1/local-bootstrap", headers });
      expect(response.statusCode).toBe(headers.authorization ? 403 : 404);
    }
  });

  it("runs a task through a real Runner turn and durable completion", async () => {
    const run = await dispatchCallerRun(host, caller, {
      key: "conformance",
      title: "Conformance task",
    });
    await run.complete();
    expect(
      await host.store.database
        .selectFrom("runs")
        .select("status")
        .where("id", "=", run.runId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "completed" });
  });

  it("reconnects the supervised Messaging service with its enrolled identity and original grant", async () => {
    const descriptor = RunnerDescriptorSchema.parse({
      bootId: RunnerBootIdSchema.parse(`rbt_${randomUUID()}`),
      capabilities: [],
      modules: {
        integrations: { platform: "darwin" },
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
      name: "Messaging service",
      runnerId: createId("runner"),
      runnerKind: "managed",
      runtimeVersion: "integration",
    });
    let primary = await connectPrimary(host.hostPort, descriptor, { token: messagingToken });
    try {
      const record = await host.store.runnerForAuthentication(descriptor.runnerId);
      expect(record).toMatchObject({
        allowedModules: ["integrations", "messaging"],
        runnerKind: "managed",
        environmentIds: [],
      });
      const privateKey = primary.privateKey;
      const closed = waitForClose(primary.socket);
      primary.socket.close();
      await closed;
      primary = await connectPrimary(
        host.hostPort,
        { ...descriptor, bootId: RunnerBootIdSchema.parse(`rbt_${randomUUID()}`) },
        { privateKey },
      );
      expect(await host.store.runnerForAuthentication(descriptor.runnerId)).toMatchObject({
        allowedModules: record!.allowedModules,
        publicKeyFingerprint: record!.publicKeyFingerprint,
        connectionGeneration: record!.connectionGeneration + 1,
      });
      expect((await host.store.listEnvironmentsForUser(host.ownerId)).map(({ id }) => id)).toEqual([
        host.ownerEnvironmentId,
      ]);
    } finally {
      const closed = waitForClose(primary.socket);
      primary.socket.close();
      await closed;
    }
  });

  it("admits the pairing-code arm only on the current route and consumes the proof once", async () => {
    const routeOrigin = "https://personal.conformance.test";
    await configurePersonalRemoteAccess(host, { schemaVersion: 1, mode: "private", routeOrigin });
    const route = (
      await host.runtime.app.inject({ url: "/.well-known/opensteer/personal-access-route" })
    ).json();
    const minted = await host.runtime.app.inject({
      url: "/v1/personal-remote-access/pairing-codes",
      method: "POST",
      headers: host.ownerHeaders,
      payload: {},
    });
    expect(minted.statusCode).toBe(200);
    const request = {
      method: "POST" as const,
      url: sessionExchangePath,
      headers: {
        [hostApiVersionHeader]: String(hostApiVersion),
        host: new URL(routeOrigin).host,
        "x-forwarded-proto": "https",
      },
      payload: {
        schemaVersion: 2,
        credentialDelivery: "cookie",
        credential: {
          kind: "personal-pairing-code",
          code: minted.json().code,
          expectedRoute: route.document,
        },
      },
    };
    const paired = await host.runtime.app.inject(request);
    expect(paired.statusCode, paired.body).toBe(200);
    expect(paired.cookies.length).toBeGreaterThan(0);
    expect((await host.runtime.app.inject(request)).statusCode).toBe(403);
  });
});

/** Both Host kinds answer a caller's malformed request as one, never as their own fault. */
async function expectSharedHttpBoundary(app: FastifyInstance, version: Record<string, string>) {
  const consume = `/v1/auth/account-adoption/proofs/${createId("authAdmission")}/consume`;
  for (const [contentType, payload, status] of [
    ["application/xml", "<proof/>", 415],
    ["application/json", "{", 400],
  ] as const) {
    const response = await app.inject({
      method: "POST",
      url: consume,
      headers: { ...version, "content-type": contentType },
      payload,
    });
    expect(response.statusCode, response.body).toBe(status);
    expect(response.json()).toEqual({
      error: { code: "bad_request", message: expect.any(String), retryable: false },
    });
  }
  const rpc = await app.inject({
    method: "POST",
    url: "/v1/rpc/commands.dispatch",
    headers: { ...version, "content-type": "application/json" },
    payload: "{",
  });
  expect(rpc.statusCode, rpc.body).toBe(400);
  expect(rpc.json()).toMatchObject({ ok: false, error: { code: "bad_request" } });
}
