import {
  ignoreForeignTestRequest,
  probeTestServer,
} from "@opensteer/shared/test-support/serverProbes";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseRunnerConfig } from "../packages/config/src/index.js";
import { createId } from "../packages/core/src/index.js";
import { RunnerBootIdSchema } from "../packages/protocol/src/index.js";
import { ReconnectingHostConnection } from "../apps/runner/src/host/host-connection.js";
import { expect, it } from "vitest";

// A stop from a promise continuation can outrun ws's nextTick handshake error.
// The connection must own its error listeners until that socket has closed,
// and it must neither leave a live handshake nor reconnect after cancellation.
it("drains a cancelled Runner handshake before releasing its socket listeners", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "opensteer-runner-handshake-"));
  const accepted = Promise.withResolvers<Socket>();
  const server = createServer((request, response) => {
    if (ignoreForeignTestRequest(request, response, (path) => path === "/internal/v1/runners"))
      return;
    expect.fail(`Expected a WebSocket upgrade on ${request.url}`);
  });
  server.on("upgrade", (request, transport) => {
    expect(request.url).toBe("/internal/v1/runners");
    const socket = transport as Socket;
    // The raw fixture ended both halves when its client ended; HTTP upgrades default to half-open.
    socket.allowHalfOpen = false;
    socket.on("error", () => socket.destroy());
    socket.resume();
    accepted.resolve(socket);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  await probeTestServer(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const environmentId = createId("environment");
  const runnerId = createId("runner");
  const pair = generateKeyPairSync("ed25519");
  const identity = {
    createdAt: new Date().toISOString(),
    environmentId,
    lastConnectionGeneration: 0,
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
    runnerId,
    version: 3 as const,
  };
  const connection = new ReconnectingHostConnection({
    bootId: RunnerBootIdSchema.parse(`rbt_${randomUUID()}`),
    config: parseRunnerConfig({
      OPENSTEER_HOST_URL: `http://127.0.0.1:${address.port}`,
      OPENSTEER_MODE: "development",
      OPENSTEER_RUNNER_DATA_DIR: root,
      OPENSTEER_RUNNER_ENROLLMENT_TOKEN: "h".repeat(32),
      OPENSTEER_RUNNER_MODULES: "shell",
    }),
    identity,
    identityStore: { acceptHostConnection: async () => identity },
    logger: { error: () => undefined, info: () => undefined },
    runtimeVersion: "handshake-shutdown-e2e",
    shellModule: {
      descriptor: {
        hostPublicKey:
          "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH",
        platform: "darwin",
      },
      helperBinary: process.execPath,
      hostKeyPath: path.join(root, "shell_host_ed25519"),
    },
  });
  const stop = new AbortController();
  const running = connection.run(stop.signal);
  let peer: Socket | undefined;
  try {
    // Accept TCP but withhold the HTTP Upgrade response, as a reconnecting
    // Runner can encounter while the deployment's network path changes.
    peer = await accepted.promise;
    const closed = once(peer, "close");
    const started = performance.now();
    stop.abort(new Error("Deployment shutting down during reconnect"));
    connection.close();
    await running;
    await closed;
    expect(peer.destroyed).toBe(true);
    const directory = process.env.OPENSTEER_RUNNER_SHUTDOWN_E2E_ARTIFACT_DIR ?? root;
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "handshake-shutdown.json"),
      JSON.stringify(
        { stopped: true, peerClosed: peer.destroyed, elapsedMs: performance.now() - started },
        null,
        2,
      ) + "\n",
    );
  } finally {
    stop.abort();
    connection.close();
    peer?.destroy();
    server.closeAllConnections();
    await running;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (process.env.OPENSTEER_RUNNER_SHUTDOWN_E2E_ARTIFACT_DIR) {
      await rm(root, { recursive: true, force: true });
    }
  }
});
