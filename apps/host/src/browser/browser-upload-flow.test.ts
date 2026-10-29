import { once } from "node:events";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createId, type AuthenticatedSession } from "@opensteer/core";
import { BrowserServerMessageSchema, createBrowserSessionId } from "@opensteer/protocol";
import WebSocket from "ws";
import { expect, it } from "vitest";
import { createHostServer, type HostServerDependencies } from "../server.js";
import { hostServerTestDependencies } from "../server/host-server-test-harness.js";
import { signHostDiscovery } from "../identity/host-keys.js";
import { BrowserConsumerAttachment, type BrowserConsumerPeer } from "./browser-service.js";
import { delay } from "@opensteer/shared/delay";

it("backpressures a bounded 10 MiB clipboard stream without ending the browser socket", async () => {
  const evidence =
    process.env.OPENSTEER_BROWSER_UPLOAD_EVIDENCE_DIR ??
    join(tmpdir(), "opensteer-browser-upload-flow");
  await mkdir(evidence, { recursive: true });
  const sessionId = createBrowserSessionId();
  const session: AuthenticatedSession = {
    id: createId("authSession"),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    absoluteExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    user: {
      id: createId("user"),
      disabledAt: null,
      displayName: "Fixture",
      email: "fixture@example.test",
      emailVerified: true,
      image: null,
      instanceRole: "administrator",
    },
  };
  const discovery = signHostDiscovery(generateKeyPairSync("ed25519"), {
    canonicalOrigin: "http://127.0.0.1:47821",
    deploymentId: createId("deployment"),
    hostInstanceId: createId("hostInstance"),
    hostKey: { algorithm: "Ed25519" },
    deploymentShape: { kind: "server", defaultWorkspaceBacking: "local-directory" },
  });
  let received = 0;
  let closed: { code: number; reason: string } | undefined;
  let failure: string | undefined;
  const server = await createHostServer(
    hostServerTestDependencies({
      discovery,
      authenticator: {
        authenticateSession: async () => session,
      } as unknown as HostServerDependencies["authenticator"],
      browser: {
        attach: async (_owner: unknown, _session: unknown, peer: BrowserConsumerPeer) => {
          await peer.send(
            JSON.stringify({
              type: "browser.snapshot",
              access: "full-control",
              dialog: null,
              sessionId,
              state: "ready",
              surfaces: [],
              editingVersion: 1,
            }),
            false,
          );
          return new BrowserConsumerAttachment(
            async (frame) => {
              // A relay write can wait for its peer; the input bound must apply
              // backpressure rather than discarding the rest of a valid upload.
              await delay(2);
              const message = JSON.parse(frame.toString()) as {
                type: string;
                part?: { data: string };
              };
              if (message.type === "clipboard.part")
                received += Buffer.from(message.part!.data, "base64").length;
              if (message.type === "navigation.reload")
                await peer.send(
                  JSON.stringify({ type: "browser.dialog.changed", dialog: null }),
                  false,
                );
            },
            () => {},
          );
        },
      } as unknown as HostServerDependencies["browser"],
    }),
  );
  let socket: WebSocket | undefined;
  try {
    await server.listen({ host: "127.0.0.1", port: 0 });
    const address = server.server.address();
    if (!address || typeof address === "string") throw new Error("No Host port.");
    socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/v1/browser-sessions/${sessionId}/connect?editing=1`,
    );
    const messages: ReturnType<typeof BrowserServerMessageSchema.parse>[] = [];
    socket.on("message", (raw) =>
      messages.push(BrowserServerMessageSchema.parse(JSON.parse(raw.toString()))),
    );
    socket.on("close", (code, reason) => {
      closed = { code, reason: reason.toString() };
    });
    await once(socket, "open");
    await expect.poll(() => messages.some((m) => m.type === "browser.snapshot")).toBe(true);
    const operationId = randomUUID(),
      part = Buffer.alloc(512 * 1024, 120).toString("base64");
    socket.send(
      JSON.stringify({
        type: "clipboard.paste-data",
        surfaceId: "page-upload",
        operationId,
        items: [{ type: "image/png", size: 10 * 1024 * 1024 }],
      }),
    );
    for (let index = 0; index < 20; index++)
      socket.send(
        JSON.stringify({ type: "clipboard.part", part: { operationId, index, data: part } }),
      );
    socket.send(JSON.stringify({ type: "navigation.reload" }));
    await expect
      .poll(() => closed ?? messages.find((m) => m.type === "browser.dialog.changed"))
      .toMatchObject({ type: "browser.dialog.changed", dialog: null });
    expect(received).toBe(10 * 1024 * 1024);
    expect(closed).toBeUndefined();
  } catch (error) {
    failure = String(error);
    throw error;
  } finally {
    socket?.terminate();
    await server.close();
    await writeFile(
      `${evidence}/report.json`,
      JSON.stringify({ passed: !failure, failure, received, closed }, null, 2),
    );
    console.info(`Host upload evidence: ${evidence}`);
  }
});
