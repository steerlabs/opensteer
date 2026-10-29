import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HttpHostClient } from "../packages/client/src/host/host-session-client.js";
import { verifyAccessEndpoint } from "../packages/client/src/connections/deployment-catalog.js";
import type { WebSocketClient } from "../packages/client/src/host/host-session-client.js";
import { zeroSequence } from "../packages/core/src/index.js";
import { hostApiVersion } from "../packages/deployment-authority/src/index.js";
import {
  hostApiVersionHeader,
  unsupportedVersionCloseCode,
} from "../packages/protocol/src/index.js";
import { WebSocket } from "../apps/host/src/browser/browser-watch-e2e.test-support.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  connectCallerMachine,
  createMachineAccessDatabase,
  dispatchCallerRun,
  enrollmentToken,
  startMachineAccessHost,
  waitForMessage,
} from "../apps/host/src/runtime/machine-access.test-support.js";
import { startBrowserRuntime } from "../apps/host/src/browser/browser-runtime.test-support.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const oldEpochs = [hostApiVersion - 1, hostApiVersion - 2];

integration("workspace epoch and producer negotiation", () => {
  const cleanup: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });

  it.each(oldEpochs)(
    "refuses epoch %i clients and untargeted producers",
    async (oldEpoch) => {
      const database = await createMachineAccessDatabase(databaseUrl!);
      cleanup.push(() => database.drop());
      const host = await startMachineAccessHost(database.url);
      cleanup.push(() => host.close());
      const matched = await verifyAccessEndpoint({ kind: "canonical", origin: host.origin });
      expect(matched.discovery.deploymentId).toBe(host.runtime.deployment.id);
      const oldClient = await fetch(new URL("/v1/rpc/bootstrap.get?input=%7B%7D", host.origin), {
        headers: { ...host.ownerHeaders, [hostApiVersionHeader]: String(oldEpoch) },
      });
      const oldClientRefusal: unknown = await oldClient.json();
      expect(oldClientRefusal).toMatchObject({
        ok: false,
        error: { reason: "unsupported-version", retryable: false },
      });
      let oldHostRefusal: unknown;
      try {
        await verifyAccessEndpoint({
          kind: "canonical",
          origin: host.origin,
          fetch: async (input, init) => {
            const response = await fetch(input, init);
            const descriptor = (await response.json()) as { apiVersion: number };
            // The old envelope deliberately cannot satisfy current identity schemas.
            return Response.json({
              ...descriptor,
              apiVersion: oldEpoch,
              authority: { legacy: true },
            });
          },
        });
        throw new Error(`An epoch-${hostApiVersion} client accepted Host ${oldEpoch}`);
      } catch (error) {
        oldHostRefusal = error;
        expect(error).toMatchObject({ code: "host-too-old" });
      }
      const caller = await connectCallerMachine(host, {
        name: "Negotiation caller",
        token: await enrollmentToken(host, {
          allowedModules: ["agents"],
          idempotencyKey: "negotiation-caller",
          name: "Negotiation caller",
        }),
      });
      cleanup.push(() => caller.close());
      const run = await dispatchCallerRun(host, caller, {
        key: "negotiation",
        title: "Version matrix",
      });
      const socket = new WebSocket(`ws://127.0.0.1:${host.hostPort}/v1/realtime`, {
        headers: host.ownerHeaders,
      });
      cleanup.push(async () => socket.terminate());
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      const refused = waitForMessage(socket, (message) => message.type === "host.error");
      const closed = new Promise<number>((resolve) => socket.once("close", resolve));
      socket.send(
        JSON.stringify({
          type: "client.subscribe",
          apiVersion: oldEpoch,
          afterSequence: zeroSequence,
          workspaceId: run.workspaceId,
          threadId: null,
        }),
      );
      const realtimeRefusal = await refused;
      expect(realtimeRefusal).toMatchObject({
        type: "host.error",
        error: { reason: "unsupported-version" },
      });
      expect(await closed).toBe(unsupportedVersionCloseCode);
      const producer = await startBrowserRuntime(
        host.hostPort,
        await enrollmentToken(host, {
          allowedModules: ["browser"],
          idempotencyKey: "old-producer",
          name: "Old producer",
        }),
        { agentReady: true, workspaceTabs: true },
      );
      cleanup.push(() => producer.close());
      const started = await host.runtime.browser.start({
        ownerId: host.ownerId,
        workspaceId: run.workspaceId,
        fresh: true,
        placement: { kind: "runner", runnerId: producer.runnerId },
      });
      const client = new HttpHostClient({
        baseUrl: new URL(host.origin),
        refreshIntervalMs: 0,
        fetch: (input, init) => {
          const request = new Request(input, init);
          for (const [key, value] of Object.entries(host.ownerHeaders))
            request.headers.set(key, value);
          return fetch(request);
        },
        webSocketFactory: (url) =>
          new WebSocket(url, { headers: host.ownerHeaders }) as unknown as WebSocketClient,
      });
      cleanup.push(async () => client.dispose());
      await client.load();
      client.activateWorkspace(run.workspaceId);
      await until(() => client.getSnapshot().connection === "connected");
      const release = client.retainBrowserWatch(started.session.id, "page-integration");
      cleanup.push(async () => release());
      await until(
        () => client.browserWatchState(started.session.id, "page-integration").error !== null,
      );
      const producerRefusal = client.browserWatchState(started.session.id, "page-integration");
      expect(producerRefusal).toMatchObject({
        status: "unavailable",
        error: "Update the Host and Browser Runtime for targeted viewing.",
        frame: null,
      });
      expect(
        producer.receivedCommands().some((command) => command.type === "stream.subscribe"),
      ).toBe(false);
      const directory = process.env.OPENSTEER_SHARED_SURFACES_ARTIFACT_DIR;
      if (directory) {
        await mkdir(directory, { recursive: true });
        await writeFile(
          join(directory, `workspace-version-matrix-${oldEpoch}.json`),
          JSON.stringify(
            {
              matchedEpoch: hostApiVersion,
              refusedEpoch: oldEpoch,
              oldClientStatus: oldClient.status,
              oldClientRefusal,
              oldHostRefusal:
                oldHostRefusal instanceof Error
                  ? { name: oldHostRefusal.name, message: oldHostRefusal.message }
                  : oldHostRefusal,
              realtimeRefusal,
              producerRefusal,
              parseError: false,
            },
            null,
            2,
          ),
        );
      }
    },
    60_000,
  );
});

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Negotiation state did not settle");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
