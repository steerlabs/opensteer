import websocket from "@fastify/websocket";
import { createId, type RunnerId } from "@opensteer/core";
import { ShellSessionIdSchema, type ShellSessionId } from "@opensteer/protocol";
import Fastify from "fastify";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeHostError } from "../server/http-errors.js";
import { ShellConnectRejection } from "./shell-connect-error.js";
import type { ShellControlStreamHandler } from "./shell-control-stream.js";
import { registerShellRoutes } from "./shell-routes.js";

const applications: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.close()));
});

async function serve(shell: Partial<ShellControlStreamHandler>) {
  const app = Fastify();
  applications.push(app);
  // The Host's own error handler, so a refusal that is not a connect rejection
  // is answered exactly as it would be in the real server.
  app.setErrorHandler((error, _request, reply) => {
    const normalized = normalizeHostError(error);
    void reply.status(normalized.status).send({ error: normalized.error });
  });
  // Registered the way the Host does: one server sized for browser relay
  // frames, and the shell routes behind one of their own.
  await app.register(websocket, {
    options: { maxPayload: 8 * 1_024 * 1_024, perMessageDeflate: false },
  });
  // One of the Host's own WebSocket routes, which must keep working: the shell
  // paths take their upgrades over, and everything else is handed back.
  app.get("/echo", { websocket: true }, (socket) => {
    socket.on("message", (data: Buffer) => socket.send(data));
  });
  registerShellRoutes(app, { shell: shell as ShellControlStreamHandler });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  return { app, origin: `127.0.0.1:${address.port}` };
}

/** What the ssh proxy sees: an ordinary HTTP response, never an upgrade. */
async function upgradeRejection(
  origin: string,
  path: string,
  headers: Record<string, string>,
): Promise<{ readonly body: unknown; readonly status: number }> {
  const socket = new WebSocket(`ws://${origin}${path}`, { headers });
  return new Promise((resolve, reject) => {
    socket.once("open", () => {
      socket.close();
      reject(new Error("the socket was upgraded"));
    });
    socket.once("unexpected-response", (_request, response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
          status: response.statusCode ?? 0,
        }),
      );
    });
    socket.once("error", reject);
  });
}

describe("shell connect route", () => {
  it("answers every refusal with its status and the sentence the proxy prints", async () => {
    const target = createId("runner");
    const cases = [
      { code: "run_invalid", message: "This Run has ended.", status: 401 },
      {
        code: "target_unknown",
        message: `No computer ${target} is enrolled in this Deployment.`,
        status: 404,
      },
      {
        code: "target_offline",
        message: "example-mac is offline (last seen 2 hours ago).",
        status: 409,
      },
      {
        code: "module_unavailable",
        message:
          "example-mac cannot accept connections from other computers yet; update Opensteer on it.",
        status: 409,
      },
      {
        code: "reach_denied",
        message: "example-mac does not allow access from other computers.",
        status: 403,
      },
      {
        code: "too_many_sessions",
        message: "example-mac already has 64 open connections.",
        status: 429,
      },
    ] as const;
    for (const expected of cases) {
      const { origin } = await serve({
        connect: () => Promise.reject(new ShellConnectRejection(expected.code, expected.message)),
      });

      const rejected = await upgradeRejection(
        origin,
        `/internal/v1/shell/connect?target=${target}`,
        { authorization: "Bearer agent-control-token-1234567890" },
      );

      expect(rejected.status, expected.code).toBe(expected.status);
      expect(rejected.body).toEqual({
        error: { code: expected.code, message: expected.message },
      });
    }
  });

  it("refuses a caller with no bearer as a Run that has ended, before any admission", async () => {
    const connect = vi.fn();
    const { origin } = await serve({ connect });

    const rejected = await upgradeRejection(
      origin,
      `/internal/v1/shell/connect?target=${createId("runner")}`,
      {},
    );

    expect(rejected.status).toBe(401);
    expect(rejected.body).toEqual({
      error: { code: "run_invalid", message: "This Run has ended." },
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it("treats a malformed or missing target as a computer that is not enrolled", async () => {
    const connect = vi.fn();
    const { origin } = await serve({ connect });

    const malformed = await upgradeRejection(
      origin,
      "/internal/v1/shell/connect?target=not-a-runner",
      { authorization: "Bearer agent-control-token-1234567890" },
    );
    const missing = await upgradeRejection(origin, "/internal/v1/shell/connect", {
      authorization: "Bearer agent-control-token-1234567890",
    });

    expect(malformed.body).toEqual({
      error: {
        code: "target_unknown",
        message: "No computer not-a-runner is enrolled in this Deployment.",
      },
    });
    expect(missing.body).toEqual({
      error: {
        code: "target_unknown",
        message: "No computer of that name is enrolled in this Deployment.",
      },
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it("upgrades only after the session is active, and hands the socket to that session", async () => {
    const sessionId = ShellSessionIdSchema.parse(`shs_${globalThis.crypto.randomUUID()}`);
    const target: RunnerId = createId("runner");
    const attachCaller = vi.fn();
    const seen: { readonly target: RunnerId; readonly token: string }[] = [];
    let admitted!: (value: ShellSessionId) => void;
    const connect = vi.fn(async (input: { readonly target: RunnerId; readonly token: string }) => {
      seen.push(input);
      return new Promise<ShellSessionId>((resolve) => {
        admitted = resolve;
      });
    });
    const { origin } = await serve({ attachCaller, connect });
    const socket = new WebSocket(`ws://${origin}/internal/v1/shell/connect?target=${target}`, {
      headers: { authorization: "Bearer agent-control-token-1234567890" },
    });
    try {
      await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
      expect(attachCaller).not.toHaveBeenCalled();
      expect(socket.readyState).toBe(WebSocket.CONNECTING);

      admitted(sessionId);
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });

      expect(attachCaller).toHaveBeenCalledWith(sessionId, expect.anything());
      expect(seen).toMatchObject([{ target, token: "agent-control-token-1234567890" }]);
    } finally {
      socket.close();
    }
  });
});

describe("shell data route", () => {
  it("pairs a socket whose ticket claimed a session, and refuses one whose ticket did not", async () => {
    const sessionId = ShellSessionIdSchema.parse(`shs_${globalThis.crypto.randomUUID()}`);
    const attachDataSocket = vi.fn();
    const claimDataSocket = vi.fn(async (ticket: string) => {
      if (ticket !== "good-shell-data-ticket-0000") throw new Error("no such reservation");
      return sessionId;
    });
    const { origin } = await serve({ attachDataSocket, claimDataSocket });

    const socket = new WebSocket(`ws://${origin}/internal/v1/shell/data`, {
      headers: { authorization: "Bearer good-shell-data-ticket-0000" },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      expect(attachDataSocket).toHaveBeenCalledWith(sessionId, expect.anything());
    } finally {
      socket.close();
    }

    await expect(
      upgradeRejection(origin, "/internal/v1/shell/data", {
        authorization: "Bearer stale-shell-data-ticket-000",
      }),
    ).resolves.toMatchObject({ status: 500 });

    await expect(upgradeRejection(origin, "/internal/v1/shell/data", {})).resolves.toMatchObject({
      status: 401,
    });
    expect(attachDataSocket).toHaveBeenCalledOnce();
  });
});

describe("shell transport limits", () => {
  it("refuses a frame past 256 KiB on either socket, whatever the Host's own limit is", async () => {
    const sessionId = ShellSessionIdSchema.parse(`shs_${globalThis.crypto.randomUUID()}`);
    const { origin } = await serve({
      attachCaller: () => undefined,
      attachDataSocket: () => undefined,
      claimDataSocket: async () => sessionId,
      connect: async () => sessionId,
    });

    for (const [label, path] of [
      ["caller", `/internal/v1/shell/connect?target=${createId("runner")}`],
      ["data", "/internal/v1/shell/data"],
    ] as const) {
      const socket = new WebSocket(`ws://${origin}${path}`, {
        headers: { authorization: "Bearer agent-control-token-1234567890" },
      });
      const closed = new Promise<number>((resolve, reject) => {
        socket.once("close", (code) => resolve(code));
        socket.once("error", reject);
      });
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });

      // A quarter-megabyte message is inside the contract; anything past it is
      // refused by the receiver rather than buffered and measured after.
      socket.send(Buffer.alloc(256 * 1_024, 7));
      socket.send(Buffer.alloc(300 * 1_024, 7));

      expect(await closed, label).toBe(1009);
    }
  });
});

describe("shell upgrade handling", () => {
  it("leaves every other WebSocket route to the Host's own upgrade handling", async () => {
    const { origin } = await serve({ connect: async () => Promise.reject(new Error("unused")) });

    const socket = new WebSocket(`ws://${origin}/echo`);
    try {
      const echoed = new Promise<Buffer>((resolve, reject) => {
        socket.once("message", (data: Buffer) => resolve(data));
        socket.once("error", reject);
      });
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      socket.send(Buffer.from("still routed", "utf8"));
      expect((await echoed).toString("utf8")).toBe("still routed");

      // And it keeps the Host's own, larger limit: the shell server's 256 KiB
      // belongs to the shell paths alone.
      const large = new Promise<Buffer>((resolve, reject) => {
        socket.once("message", (data: Buffer) => resolve(data));
        socket.once("error", reject);
      });
      socket.send(Buffer.alloc(300 * 1_024, 7));
      expect((await large).byteLength).toBe(300 * 1_024);
    } finally {
      socket.close();
    }
  });

  it("refuses to serve shell sockets where the Host has no upgrade handling", () => {
    const app = Fastify();
    applications.push(app);

    expect(() =>
      registerShellRoutes(app, { shell: {} as unknown as ShellControlStreamHandler }),
    ).toThrow(/upgrade handling/u);
  });
});
