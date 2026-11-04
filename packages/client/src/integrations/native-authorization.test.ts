import { createId } from "@opensteer/core";
import { createIntegrationId } from "@opensteer/integration-core";
import { describe, expect, it, vi } from "vitest";
import {
  buildNativeIntegrationAuthorizationCallback,
  opensteerMobileIntegrationAuthorizationCallback,
  parseNativeIntegrationAuthorizationCallback,
  waitForIntegrationAuthorization,
  IntegrationAuthorizationAttempts,
  integrationAuthorizationStatusReturned,
} from "./native-authorization.js";

describe("native integration authorization", () => {
  it.each(["oauthAttempt", "mcpOauthAttempt"] as const)(
    "round trips an opaque %s identifier",
    (kind) => {
      const value = {
        attemptId: createIntegrationId(kind),
        deploymentId: createId("deployment"),
      };
      const callback = buildNativeIntegrationAuthorizationCallback(value);
      expect(parseNativeIntegrationAuthorizationCallback(callback)).toEqual({
        ...value,
        returnProof: null,
      });
      expect(callback).toBe(
        `${opensteerMobileIntegrationAuthorizationCallback}?deployment_id=${value.deploymentId}&attempt_id=${value.attemptId}`,
      );
      expect(callback).not.toMatch(/ticket|code|token|host|success/iu);
    },
  );

  it.each([
    "https://example.test/oauth/integration-callback?deployment_id=dep_x&attempt_id=ioa_x",
    "com.opensteer.mobile://evil/oauth/integration-callback?deployment_id=dep_x&attempt_id=ioa_x",
    `${opensteerMobileIntegrationAuthorizationCallback}?deployment_id=dep_x&attempt_id=ioa_x&success=true`,
    `${opensteerMobileIntegrationAuthorizationCallback}?deployment_id=dep_x&deployment_id=dep_y&attempt_id=ioa_x`,
    `${opensteerMobileIntegrationAuthorizationCallback}#attempt_id=ioa_x`,
  ])("rejects an untrusted callback shape: %s", (callback) => {
    expect(parseNativeIntegrationAuthorizationCallback(callback)).toBeNull();
  });

  it("treats the durable Host status as the only success channel", async () => {
    const attemptId = createIntegrationId("oauthAttempt");
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        data: {
          connectionId: null,
          expiresAt: "2026-09-18T00:00:00.000Z",
          failureCode: null,
          status: "launched",
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          connectionId: createIntegrationId("connection"),
          expiresAt: "2026-09-18T00:00:00.000Z",
          failureCode: null,
          status: "completed",
        },
      });
    const result = await waitForIntegrationAuthorization({
      attemptId,
      client: { rpc: { "integration.authorization.get": rpc } },
      expiresAt: "2026-09-18T00:00:00.000Z",
      now: () => new Date("2026-09-17T00:00:00.000Z").getTime(),
      sleep: async () => undefined,
    });
    expect(result.status).toBe("completed");
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});

describe("app-started authorization attempts", () => {
  const entry = () => ({
    deploymentId: createId("deployment"),
    attemptId: createIntegrationId("oauthAttempt"),
    userId: createId("user"),
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  it("round trips a return proof and refuses duplicate, unknown and foreign parameters", () => {
    const value = { ...entry(), returnProof: "r".repeat(43) };
    const url = buildNativeIntegrationAuthorizationCallback(value);
    expect(parseNativeIntegrationAuthorizationCallback(url)).toEqual({
      deploymentId: value.deploymentId,
      attemptId: value.attemptId,
      returnProof: value.returnProof,
    });
    for (const extra of ["&return=" + "s".repeat(43), "&code=secret", "&unknown=true"])
      expect(parseNativeIntegrationAuthorizationCallback(url + extra)).toBeNull();
    expect(
      parseNativeIntegrationAuthorizationCallback(
        url.replace("com.opensteer.mobile:", "com.opensteer.opensteer:"),
      ),
    ).toBeNull();
  });
  it("checks deployment, attempt and owner, deduplicates delivery and erases terminal results", async () => {
    const attempts = new IntegrationAuthorizationAttempts();
    const started = entry();
    await attempts.register(started);
    expect(attempts.find({ ...started, deploymentId: createId("deployment") })).toBeNull();
    expect(
      attempts.find({ ...started, attemptId: createIntegrationId("oauthAttempt") }),
    ).toBeNull();
    expect(attempts.find({ ...started, userId: createId("user") })).toBeNull();
    const finish = vi.fn(async () => ({
      status: "completed" as const,
      connectionId: null,
      failureCode: null,
      expiresAt: started.expiresAt,
    }));
    const [first, second] = await Promise.all([
      attempts.deliver(started, finish),
      attempts.deliver(started, finish),
    ]);
    expect(first).toEqual(second);
    expect(finish).toHaveBeenCalledOnce();
    expect(attempts.find(started)).toBeNull();
  });
  it("persists before launch, retains transient failures, and expires or clears authority", async () => {
    let stored: unknown = null;
    const store = {
      read: async () => stored,
      write: vi.fn(async (entries: unknown) => {
        stored = entries;
      }),
    };
    const started = entry();
    let now = Date.parse("2098-01-01T00:00:00.000Z");
    const attempts = new IntegrationAuthorizationAttempts({ store, now: () => now });
    await attempts.register(started);
    const cold = new IntegrationAuthorizationAttempts({ store, now: () => now });
    await cold.load();
    expect(cold.find(started)).toEqual(started);
    await expect(
      cold.deliver(started, async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    expect(cold.find(started)).toEqual(started);
    now = Date.parse(started.expiresAt);
    expect(cold.find(started)).toBeNull();
    now -= 1000;
    await cold.register(started);
    await cold.clear(started.deploymentId);
    expect(cold.find(started)).toBeNull();
    const reloaded = new IntegrationAuthorizationAttempts({ store });
    await reloaded.load();
    expect(reloaded.find(started)).toBeNull();
  });
});

it("wakes an existing waiter immediately with the Host return result", async () => {
  const attemptId = createIntegrationId("oauthAttempt");
  const pending = {
    connectionId: null,
    failureCode: null,
    status: "launched" as const,
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  const client = {
    rpc: {
      "integration.authorization.get": vi.fn(async () => ({ ok: true as const, data: pending })),
    },
  };
  const sleep = vi.fn(
    (_milliseconds: number, signal?: AbortSignal) =>
      new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
      }),
  );
  let result: unknown;
  const waiting = waitForIntegrationAuthorization({ attemptId, client, sleep }).then((status) => {
    result = status;
  });
  await vi.waitFor(() => expect(sleep).toHaveBeenCalledOnce(), { timeout: 1000 });
  const completed = { ...pending, status: "completed" as const };
  integrationAuthorizationStatusReturned(client, attemptId, completed);
  await vi.waitFor(
    () =>
      expect(result, "Host return did not wake the existing authorization waiter").toEqual(
        completed,
      ),
    { timeout: 1000 },
  );
  await waiting;
  expect(client.rpc["integration.authorization.get"]).toHaveBeenCalledOnce();
});
