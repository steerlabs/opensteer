import { createId } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import { testDiscoveryEnvelope } from "../test-support/host-authority.js";
import { DeploymentCatalogSchema } from "./deployment-catalog.js";
import { hostResponseStallTimeoutMs } from "./host-response-deadline.js";
import { HostTransport } from "./host-transport.js";

function fixture(response: Response) {
  const deploymentId = createId("deployment");
  const origin = "https://home.example";
  const now = new Date().toISOString();
  const catalog = DeploymentCatalogSchema.parse({
    revision: 1,
    schemaVersion: DeploymentCatalogSchema.shape.schemaVersion.value,
    updatedAt: now,
    selectedDeploymentId: deploymentId,
    deployments: [
      {
        authority: testDiscoveryEnvelope({
          deploymentId,
          hostInstanceId: createId("hostInstance"),
          canonicalOrigin: origin,
          deploymentShape: { kind: "personal" },
          hostKey: { algorithm: "Ed25519" },
        }),
        bootstrapMethods: ["password"],
        createdAt: now,
        endpoints: [{ kind: "canonical", origin, verifiedAt: now }],
        kind: "personal",
        lastUsedAt: null,
        name: "Home",
        preferredEndpointOrigin: null,
        reachability: "canonical",
        source: { kind: "manual" },
        updatedAt: now,
      },
    ],
  });
  const sessions = {
    sessionEnded: vi.fn(),
    recoverUnauthorized: vi.fn(async () => "blocked" as const),
  };
  const transport = new HostTransport({
    catalog: { load: async () => catalog, subscribe: () => () => undefined },
    localRuntime: { current: async () => null },
    network: {
      request: async () => response,
      openWebSocket: () => {
        throw new Error("Unexpected WebSocket");
      },
    },
    sessions,
  });
  return {
    transport,
    sessions,
    exchange: <Result>(read: (response: Response) => Promise<Result>) =>
      transport.exchange({ method: "GET", path: "/auth.config", headers: {} }, read),
  };
}

describe("Host transport handling of a 401 response", () => {
  it.each(["chunked", "declared content length"] as const)(
    "reports an oversized 401 with %s as response-too-large",
    async (bodyType) => {
      const limit = 64 * 1024;
      const cancel = vi.fn();
      const chunks = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(limit));
          controller.enqueue(Uint8Array.of(1));
        },
        cancel,
      });
      const response = new Response(chunks, {
        status: 401,
        ...(bodyType === "declared content length"
          ? { headers: { "content-length": String(limit + 1) } }
          : {}),
      });
      const { exchange, sessions } = fixture(response);
      const read = vi.fn((response: Response) => response.text());

      await expect(exchange(read)).rejects.toMatchObject({
        code: "response-too-large",
        failure: { kind: "protocol", retryable: false },
      });
      expect(sessions.sessionEnded).toHaveBeenCalledOnce();
      expect(sessions.recoverUnauthorized).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("returns a normal 401 after blocked recovery", async () => {
    const body = { ok: false, error: { code: "unauthorized", message: "Sign in" } };
    const { exchange, sessions } = fixture(Response.json(body, { status: 401 }));

    await expect(
      exchange(async (response) => ({ status: response.status, body: await response.json() })),
    ).resolves.toEqual({ status: 401, body });
    expect(sessions.sessionEnded).toHaveBeenCalledOnce();
    expect(sessions.recoverUnauthorized).toHaveBeenCalledOnce();
  });

  it("keeps sign-in-required when an ordinary 401 body fails to finish", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error("Connection ended before the whole body arrived"));
        },
      }),
      { status: 401 },
    );
    const { exchange, sessions } = fixture(response);

    await expect(exchange((response) => response.text())).rejects.toMatchObject({
      code: "unreachable",
      failure: {
        code: "unauthorized",
        reason: "sign-in-required",
        kind: "session",
        provenance: "host",
        retryable: false,
      },
    });
    expect(sessions.sessionEnded).toHaveBeenCalledOnce();
    expect(sessions.recoverUnauthorized).not.toHaveBeenCalled();
  });

  it("keeps deployment-changed when the attachment is invalidated after a 401", async () => {
    const { exchange, sessions, transport } = fixture(
      new Response(new ReadableStream<Uint8Array>({}), { status: 401 }),
    );
    const observed = Promise.withResolvers<void>();
    sessions.sessionEnded.mockImplementation(() => observed.resolve());

    const failure = expect(exchange((response) => response.text())).rejects.toMatchObject({
      code: "deployment-changed",
    });
    await observed.promise;
    transport.invalidateSession();

    await failure;
    expect(sessions.sessionEnded).toHaveBeenCalledOnce();
    expect(sessions.recoverUnauthorized).not.toHaveBeenCalled();
  });

  it("reports a stalled 401 body as timed-out instead of unreachable", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
          },
          cancel,
        }),
        { status: 401 },
      );
      const { exchange, sessions } = fixture(response);
      const read = vi.fn((response: Response) => response.text());

      const outcome = exchange(read).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await vi.advanceTimersByTimeAsync(hostResponseStallTimeoutMs);

      const settled = await outcome;
      expect(settled.ok).toBe(false);
      if (!settled.ok) {
        expect(settled.error).toMatchObject({
          code: "timed-out",
          failure: {
            code: "unauthorized",
            reason: "sign-in-required",
            kind: "session",
            provenance: "host",
            retryable: false,
          },
        });
      }
      expect(sessions.sessionEnded).toHaveBeenCalledOnce();
      expect(sessions.recoverUnauthorized).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
