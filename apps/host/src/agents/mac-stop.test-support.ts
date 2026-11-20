import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import { createInterface } from "node:readline";
import {
  BrowserAttachTicketClaimsSchema,
  browserRuntimeWireVersion,
  ComputerUseBridgeRequestSchema,
  macWindowVideoParams,
  DisplayViewerServerMessageSchema,
} from "@opensteer/protocol";
import type { ComputerViewId } from "@opensteer/core";
import type { z } from "zod";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { createWebSocketStream, WebSocket, WebSocketServer } from "ws";

export async function startStopBrowser() {
  const runtimeId = "mac-stop-test-browser";
  const bridgeToken = randomUUID();
  const frames: string[] = [];
  const displayStarts: string[] = [];
  const nativeRequests: string[] = [];
  const bindingId = randomUUID();
  const sockets = new WebSocketServer({ noServer: true });
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ wireVersion: 2, runtimeId, state: "ready" }));
  });
  server.on("upgrade", (request, socket, head) => {
    if (request.headers.authorization === `Bearer ${bridgeToken}`) {
      if (request.url?.startsWith("/native/display/")) {
        sockets.handleUpgrade(request, socket, head, () => undefined);
        return;
      }
      if (request.url === "/native") {
        sockets.handleUpgrade(request, socket, head, (bridge) => {
          bridge.on("message", (raw) => {
            const request = ComputerUseBridgeRequestSchema.safeParse(JSON.parse(String(raw)));
            if (!request.success) return;
            const { id, method, params } = request.data;
            nativeRequests.push(method);
            let result;
            if (method === "permissions.get")
              result = {
                permissions: { accessibility: "granted", screenRecording: "granted" },
                computerUseVersion: 2,
                ownerViewVersion: 3,
                ownerInputVersion: 2,
                videoProfile: 1,
              };
            else if (method === "display.resolve")
              result = { target: { kind: "mac-window", bindingId } };
            else if (method === "display.start") {
              displayStarts.push(macWindowVideoParams["display.start"].parse(params).streamId);
              result = { attachmentToken: randomUUID() };
            } else if (method === "display.demand" || method === "display.stop") {
              result = {};
            }
            bridge.send(
              JSON.stringify(
                result === undefined
                  ? {
                      id,
                      kind: "response",
                      error: {
                        code: "unsupported",
                        message: "Fixture only serves owner displays.",
                      },
                    }
                  : { id, kind: "response", result },
              ),
            );
          });
        });
        return;
      }
    }
    if (
      request.url !== "/v1/browser" ||
      request.headers["x-opensteer-browser-bridge-token"] !== bridgeToken
    ) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (viewer) => {
      viewer.on("message", (frame) => frames.push(String(frame)));
      viewer.send(JSON.stringify({ type: "browser.attached" }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    config: {
      bridgeToken,
      runtimeId,
      url: new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    },
    displayStarts,
    nativeRequests,
    frames,
    computerUseUrl: new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/native`),
    close: async () => {
      for (const socket of sockets.clients) socket.terminate();
      await Promise.all([
        new Promise<void>((resolve) => sockets.close(() => resolve())),
        new Promise<void>((resolve) => server.close(() => resolve())),
      ]);
    },
  };
}

export function attachTicket(runtimeId: string, actor: "agent" | "person"): string {
  const now = new Date().toISOString();
  const claims = BrowserAttachTicketClaimsSchema.parse({
    access: "read-write",
    actor,
    audience: "opensteer-browser-runtime",
    creationOrigin: actor,
    expiresAt: now,
    identity: { kind: "fresh" },
    issuedAt: now,
    nonce: randomUUID(),
    operationExpiresAt: now,
    remainingBudgetMs: 1000,
    runtimeId,
    sessionId: `bsn_${randomUUID()}`,
    subject: actor,
    wireVersion: browserRuntimeWireVersion,
  });
  return `test.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.test`;
}

export function stopShellData() {
  const ticket = [randomUUID(), randomUUID(), randomUUID()].join(".");
  const connected = Promise.withResolvers<WebSocket>();
  let socket: WebSocket | undefined;
  return {
    ticket,
    accept(authorization: string | undefined, incoming: WebSocket) {
      if (socket || authorization !== `Bearer ${ticket}`) {
        incoming.terminate();
        return;
      }
      socket = incoming;
      connected.resolve(incoming);
    },
    async start() {
      const incoming = await withTimeout(connected.promise, 10_000, {
        timeoutError: () => new Error("The shell did not connect to its data socket"),
      });
      const proxy = createTcpServer((tcp) => {
        const wire = createWebSocketStream(incoming);
        tcp.on("error", () => wire.destroy());
        wire.on("error", () => tcp.destroy());
        tcp.once("close", () => wire.destroy());
        wire.once("close", () => tcp.destroy());
        tcp.pipe(wire).pipe(tcp);
      });
      proxy.listen(0, "127.0.0.1");
      await once(proxy, "listening");
      const client = spawn(
        "/usr/bin/ssh",
        [
          "-F",
          "/dev/null",
          "-o",
          "StrictHostKeyChecking=no",
          "-o",
          "UserKnownHostsFile=/dev/null",
          "-o",
          "GlobalKnownHostsFile=/dev/null",
          "-o",
          "IdentityFile=none",
          "-o",
          "IdentityAgent=none",
          "-o",
          "BatchMode=yes",
          "-l",
          "stop-fixture",
          "-o",
          "LogLevel=VERBOSE",
          "-p",
          String((proxy.address() as AddressInfo).port),
          "127.0.0.1",
          'printf "%s\\n" "$$"; exec /bin/sleep 60',
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      const ended = once(client, "close");
      void ended.catch(() => undefined);
      const lines = createInterface({ input: client.stdout });
      let stderr = "";
      client.stderr.on("data", (chunk) => {
        stderr += String(chunk).slice(0, 300);
      });
      try {
        const [chunk] = await withTimeout(
          Promise.race([
            once(lines, "line"),
            ended.then(([code, signal]) => {
              throw new Error(
                `SSH exited before starting its shell (${code ?? signal}): ${stderr}`,
              );
            }),
          ]),
          10_000,
          { timeoutError: () => new Error("SSH did not report its shell PID") },
        );
        const pid = Number(String(chunk).trim());
        if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("SSH did not return a PID");
        return { pid, ended };
      } catch (error) {
        client.kill("SIGKILL");
        await ended.catch(() => undefined);
        throw error;
      } finally {
        lines.close();
        proxy.close();
      }
    },
    close() {
      socket?.terminate();
    },
  };
}

export function fixtureOwnerView(origin: URL, cookie: string, viewId: ComputerViewId) {
  const url = new URL(`/v1/computer-use/views/${viewId}/1/display`, origin);
  url.protocol = "ws:";
  const socket = new WebSocket(url, { headers: { cookie, origin: origin.origin } });
  const frames: z.infer<typeof DisplayViewerServerMessageSchema>[] = [];
  socket.on("message", (raw, binary) => {
    if (!binary) frames.push(DisplayViewerServerMessageSchema.parse(JSON.parse(String(raw))));
  });
  const closed = once(socket, "close");
  void closed.catch(() => undefined);
  return { socket, frames, closed };
}
