import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { once } from "node:events";
import { it, expect } from "vitest";
import { createId } from "../packages/core/src/index.js";
import { unsupportedVersionCloseCode } from "../packages/protocol/src/index.js";
import {
  hostApiVersion,
  hostApiVersionHeader,
} from "../packages/deployment-authority/src/index.js";
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
} from "../packages/database/src/test-database.test-support.js";
import { verifyAccessEndpoint } from "../packages/client/src/connections/deployment-catalog.js";
import { startPersonalRuntime } from "../apps/host/src/runtime/personal-startup.test-support.js";
import { waitForRealtimeMessage } from "../apps/host/src/agents/vertical-stack.test-support.js";
import { withTimeout } from "@opensteer/shared/withTimeout";

it("refuses old Personal epochs before discovery parsing, RPC parsing and realtime dispatch", async () => {
  const database = await cloneTestDatabase("host"),
    directory = await mkdtemp(join(tmpdir(), "personal-negotiation-"));
  let runtime: Awaited<ReturnType<typeof startPersonalRuntime>> | undefined,
    socket: WebSocket | undefined;
  try {
    runtime = await ownTestDatabaseProducer(database.url, () =>
      startPersonalRuntime({
        databaseUrl: database.url,
        agentHome: { computerId: createId("runner"), path: directory },
      }),
    );
    const matched = await verifyAccessEndpoint({
      kind: "canonical",
      origin: runtime.hostOrigin.origin,
    });
    expect(matched.discovery.deploymentId).toBe(runtime.host.deployment.id);
    for (const version of [hostApiVersion - 1, hostApiVersion - 2]) {
      const refused = await runtime.host.app.inject({
        method: "POST",
        url: "/v1/rpc/commands.dispatch",
        headers: { [hostApiVersionHeader]: String(version), "content-type": "application/json" },
        payload: "{broken",
      });
      expect(refused.json()).toMatchObject({
        ok: false,
        error: { reason: "unsupported-version", retryable: false },
      });
      await expect(
        verifyAccessEndpoint({
          kind: "canonical",
          origin: runtime.hostOrigin.origin,
          fetch: async () =>
            Response.json({ kind: "personal", apiVersion: version, authority: { legacy: true } }),
        }),
      ).rejects.toMatchObject({ code: "host-too-old" });
    }
    socket = new WebSocket(
      `${runtime.hostOrigin.origin.replace(/^http/u, "ws")}/v1/realtime?opensteer_api_version=${hostApiVersion}`,
      { headers: { cookie: runtime.sessionCookie, origin: runtime.hostOrigin.origin } },
    );
    await withTimeout(once(socket, "open"), 3000, {
      timeoutError: () => new Error("Personal realtime never opened"),
    });
    const refused = waitForRealtimeMessage(socket, (frame) => frame.type === "host.error");
    const closed = once(socket, "close");
    socket.send(
      JSON.stringify({
        type: "client.subscribe",
        apiVersion: hostApiVersion - 1,
        cursor: {
          deploymentId: runtime.host.deployment.id,
          apiVersion: hostApiVersion - 1,
          afterSequence: "0",
        },
        threadId: null,
      }),
    );
    expect(await refused).toMatchObject({ error: { reason: "unsupported-version" } });
    expect(
      (
        await withTimeout(closed, 3000, {
          timeoutError: () => new Error("Refused Personal socket did not close"),
        })
      )[0],
    ).toBe(unsupportedVersionCloseCode);
  } finally {
    socket?.terminate();
    await runtime?.close();
    await database.drop();
    await rm(directory, { recursive: true, force: true });
  }
});
