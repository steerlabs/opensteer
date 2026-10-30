import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { describe, expect, it, vi } from "vitest";
import { HttpHostClient, type WebSocketClient } from "../packages/client/src/host/index.js";
import { MockHostClient } from "../packages/client/src/mock/index.js";
import { MemoryPrivateFilesystem } from "../packages/client/src/test-support/index.js";
import {
  opensteerMobileAccountOAuthCallback,
  opensteerMobileHostOAuthCallback,
  opensteerMobileOAuthClientId,
} from "../packages/core/src/index.js";
import { MobileClient } from "../apps/mobile/src/client/mobile-client.js";
import type { HostEpochAgreement, MobileHostPort } from "../apps/mobile/src/client/host-port.js";
import { createHostNetwork } from "../apps/mobile/src/platform/host-network.js";
import { MemorySecureStore } from "../apps/mobile/src/platform/memory-secure-store.js";
import { createSecureRecordStore } from "../apps/mobile/src/platform/secure-record-store.js";
import { testDeploymentConnection } from "../apps/mobile/test-support/deployment-fixtures.js";

describe("mobile retained attachment over HTTP and WebSocket", () => {
  it.each(["identity-mismatch", "client-too-old", "host-too-old"] as const)(
    "revokes %s, preserves repair and selection, and fences retained transports",
    async (verdict) => {
      const mock = new MockHostClient({ latencyMs: 0, places: "absent" });
      await mock.load();
      const traffic: string[] = [];
      const server = createServer((request, response) => {
        void (async () => {
          try {
            const url = new URL(request.url!, "http://localhost");
            traffic.push(url.pathname);
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const raw = url.searchParams.get("input") ?? (Buffer.concat(chunks).toString() || "{}");
            const handler = Reflect.get(mock.rpc, url.pathname.slice("/v1/rpc/".length)) as (
              input: unknown,
            ) => Promise<unknown>;
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify(await handler(JSON.parse(raw))));
          } catch {
            response.statusCode = 500;
            response.end();
          }
        })();
      });
      const sockets = new WebSocketServer({ server });
      const observed: { socket: WebSocket; closed: boolean }[] = [];
      sockets.on("connection", (socket) => {
        const observation = { socket, closed: false };
        observed.push(observation);
        socket.on("close", () => {
          observation.closed = true;
        });
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("No HTTP address");
      const origin = `http://127.0.0.1:${address.port}`;
      let agreement: HostEpochAgreement = { status: "compatible", capabilities: [] };
      let pending: Promise<HostEpochAgreement> | null = null;
      let read: Parameters<MobileHostPort["attach"]>[0]["capabilities"];
      let network: ReturnType<typeof createHostNetwork> | undefined;
      let disposed = 0;
      let credentialRead: Promise<string> | null = null;
      const client = new MobileClient({
        accountOrigin: null,
        catalogFilePath: "/private/catalog.json",
        doneShelfFilePath: "/private/done.json",
        draftsFilePath: "/private/drafts.json",
        selectionFilePath: "/private/selection.json",
        signedOutFilePath: "/private/signout.json",
        fetch: globalThis.fetch,
        hostPort: () => ({
          credentials: {
            authorization: async () => credentialRead ?? "Bearer retained-test",
            held: async () => true,
          },
          verifyEpoch: async () => pending ?? agreement,
          attach: ({ authorization, capabilities }) => {
            read = capabilities;
            network = createHostNetwork({
              authorization,
              origin,
              fetch: globalThis.fetch,
              openWebSocket: (url, headers) =>
                new WebSocket(url, { headers }) as unknown as WebSocketClient,
            });
            const host = new HttpHostClient({
              baseUrl: origin,
              capabilities,
              ...network,
              refreshIntervalMs: 60_000,
            });
            const dispose = host.dispose.bind(host);
            host.dispose = () => {
              disposed++;
              dispose();
            };
            return host;
          },
        }),
        oauthIdentity: {
          accountCallback: opensteerMobileAccountOAuthCallback,
          hostCallback: opensteerMobileHostOAuthCallback,
          clientId: opensteerMobileOAuthClientId,
          application: "mobile",
        },
        openAuthorization: async () => undefined,
        openIntegrationAuthorization: async () => "",
        privateFiles: new MemoryPrivateFilesystem(),
        randomBytes: (size) => new Uint8Array(size).fill(7),
        records: createSecureRecordStore({
          keyPrefix: "revocation",
          secureStore: new MemorySecureStore(),
        }),
      });
      try {
        const connection = testDeploymentConnection({});
        const id = connection.authority.document.deploymentId;
        const {
          createdAt: _createdAt,
          updatedAt: _updatedAt,
          lastUsedAt: _lastUsedAt,
          ...input
        } = connection;
        await client.catalog.upsertAndSelect(input);
        await client.initialize();
        await client.select(id);
        const retained = client.getSnapshot().selection.hostClient!;
        expect(retained).not.toBeNull();
        await retained.load();
        await vi.waitFor(() => expect(observed.length).toBeGreaterThan(0));
        if (typeof read! !== "function") throw new Error("No capability reader");
        const initialRead = read!;
        agreement = "unreachable";
        await expect(initialRead({ revalidate: true })).rejects.toThrow("unreachable");
        expect(disposed).toBe(0);
        expect(client.getSnapshot().selection.hostClient).toBe(retained);
        expect(client.getSnapshot().selection.row?.verification).toBeNull();

        let finishCredential!: (value: string) => void;
        credentialRead = new Promise((resolve) => {
          finishCredential = resolve;
        });
        const inFlight = network!.fetch(`${origin}/v1/rpc/bootstrap.get`);
        const inFlightResult = expect(inFlight).rejects.toThrow();
        agreement = verdict;
        await expect(initialRead({ revalidate: true })).rejects.toThrow();
        finishCredential("Bearer retained-test");
        credentialRead = null;
        await inFlightResult;
        expect(disposed).toBe(1);
        expect(client.getSnapshot().selection).toMatchObject({
          deploymentId: id,
          hostClient: null,
          row: { verification: verdict },
        });
        await vi.waitFor(() => expect(observed.every(({ closed }) => closed)).toBe(true));
        const afterRevocation = traffic.length;
        await expect(retained.rpc["bootstrap.get"]({})).resolves.toMatchObject({ ok: false });
        await expect(network!.fetch(`${origin}/v1/rpc/bootstrap.get`)).rejects.toThrow();
        expect(() => network!.webSocketFactory(origin.replace("http", "ws"))).toThrow();
        expect(traffic).toHaveLength(afterRevocation);
        await client.select(id);
        expect(client.getSnapshot().selection.hostClient).toBeNull();
        expect(traffic).toHaveLength(afterRevocation);

        agreement = { status: "compatible", capabilities: [] };
        await client.select(id);
        const replacement = client.getSnapshot().selection.hostClient;
        expect(replacement).not.toBeNull();
        expect(replacement).not.toBe(retained);
        const newerRead = read!;
        if (typeof newerRead !== "function") throw new Error("No new reader");
        let finish!: (value: HostEpochAgreement) => void;
        pending = new Promise((resolve) => {
          finish = resolve;
        });
        const late = newerRead({ revalidate: true });
        await client.deselect();
        pending = null;
        await client.select(id);
        const newest = client.getSnapshot().selection.hostClient;
        finish(verdict);
        await expect(late).rejects.toThrow();
        expect(client.getSnapshot().selection.hostClient).toBe(newest);
        expect(client.getSnapshot().selection.row?.verification).toBeNull();
        const directory = await mkdtemp(join(tmpdir(), "opensteer-mobile-revocation-"));
        await writeFile(
          join(directory, "revocation.json"),
          JSON.stringify(
            {
              verdict,
              disposed,
              observedClosed: observed.filter(({ closed }) => closed).length,
              blockedRequests: 2,
              blockedSocket: true,
              traffic,
              selected: id,
              lateResultFenced: true,
            },
            null,
            2,
          ),
        );
        console.info(`Mobile revocation evidence: ${directory}/revocation.json`);
      } finally {
        client.dispose();
        mock.dispose();
        for (const socket of sockets.clients) socket.terminate();
        await new Promise<void>((resolve) => sockets.close(() => resolve()));
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
