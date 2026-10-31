import { EventEmitter } from "node:events";
import { createServer, type Socket } from "node:net";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { randomUUID } from "node:crypto";
import type { WebContents, WebFrameMain } from "electron";
import { afterEach, expect, it, vi } from "vitest";
import { AgentPhoneAdbServer, connectAgentPhoneAdbServer } from "./agent-phone-adb-server.js";

const device = { vendorId: 10864, productId: 20199, serialNumber: "oneplus" };
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function windowOwner() {
  return {
    frame: { send: vi.fn() } as unknown as WebFrameMain,
    contents: new EventEmitter() as WebContents,
  };
}
function sessionHarness() {
  const disconnected = Promise.withResolvers<void>();
  const adb = {
    getProp: vi.fn(async () => "11"),
    shell: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    install: vi.fn(async () => ({ ok: true as const })),
    readFile: vi.fn(async () => null),
  };
  const connection = {
    adb,
    close: vi.fn(async () => undefined),
    disconnected: disconnected.promise,
  };
  const granted = vi.fn(() => true);
  const connect = vi.fn(async () => connection);
  const service = new AgentPhoneAdbServer({ isGranted: granted, connect });
  cleanup.push(() => service.dispose());
  return { service, connect, granted, connection, disconnected, adb };
}

it("never contacts ADB for an unselected phone", async () => {
  const h = sessionHarness();
  h.granted.mockReturnValue(false);
  const owner = windowOwner();
  await expect(
    h.service.open({ sessionId: randomUUID(), device }, owner.frame, owner.contents),
  ).rejects.toThrow("Choose this phone");
  expect(h.connect).not.toHaveBeenCalled();
});

it("binds a session to its frame, serializes setup, and invalidates it on navigation", async () => {
  const h = sessionHarness();
  const owner = windowOwner();
  const sessionId = randomUUID();
  await h.service.open({ sessionId, device }, owner.frame, owner.contents);
  await expect(
    h.service.call(
      { sessionId, kind: "getProp", key: "ro.build.version.release" },
      windowOwner().frame,
    ),
  ).rejects.toThrow("closed");
  await expect(
    h.service.open(
      { sessionId: randomUUID(), device },
      windowOwner().frame,
      windowOwner().contents,
    ),
  ).rejects.toThrow("another window");
  const shell = Promise.withResolvers<{ stdout: string; stderr: string; exitCode: number }>();
  h.adb.shell.mockReturnValue(shell.promise);
  const running = h.service.call(
    { sessionId, kind: "shell", argv: ["pm", "list", "packages"] },
    owner.frame,
  );
  await expect(
    h.service.call({ sessionId, kind: "getProp", key: "ro.product.model" }, owner.frame),
  ).rejects.toThrow("already running");
  owner.contents.emit("did-start-navigation", { isSameDocument: false, isMainFrame: true });
  await expect(running).rejects.toThrow("closed");
  shell.resolve({ stdout: "late", stderr: "", exitCode: 0 });
  expect(h.connection.close).toHaveBeenCalledOnce();
  await expect(
    h.service.call({ sessionId, kind: "getProp", key: "ro.product.model" }, owner.frame),
  ).rejects.toThrow("closed");
});

it("closes a connection that arrives after cancellation and never retains it", async () => {
  const h = sessionHarness();
  const owner = windowOwner();
  const sessionId = randomUUID();
  const pending = Promise.withResolvers<typeof h.connection>();
  h.connect.mockReturnValue(pending.promise);
  const opening = h.service.open({ sessionId, device }, owner.frame, owner.contents);
  h.service.close(sessionId, owner.frame);
  pending.resolve(h.connection);
  await expect(opening).rejects.toThrow("closed");
  expect(h.connection.close).toHaveBeenCalledOnce();
});

it.each(["revoke", "disconnect", "destroy"])(
  "withdraws an existing session on %s",
  async (cause) => {
    const h = sessionHarness();
    const owner = windowOwner();
    const sessionId = randomUUID();
    await h.service.open({ sessionId, device }, owner.frame, owner.contents);
    if (cause === "revoke") h.service.revoke(device);
    else if (cause === "destroy") owner.contents.emit("destroyed");
    else {
      h.disconnected.resolve();
      await h.disconnected.promise;
    }
    await expect(
      h.service.call({ sessionId, kind: "getProp", key: "ro.product.model" }, owner.frame),
    ).rejects.toThrow("closed");
    expect(h.connection.close).toHaveBeenCalledOnce();
  },
);

async function smartSocket(list: string) {
  const sockets = new Set<Socket>();
  const requests: string[] = [];
  const installs: Buffer[] = [];
  const disconnect = Promise.withResolvers<Socket>();
  const authorize = Promise.withResolvers<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => sockets.delete(socket));
    let pending = Buffer.alloc(0);
    let installSize: number | null = null;
    socket.on("data", (bytes: Buffer) => {
      pending = Buffer.concat([pending, bytes]);
      if (installSize !== null) {
        if (pending.length === installSize) {
          installs.push(pending);
          socket.end("Success\n");
        }
        return;
      }
      while (pending.length >= 4) {
        const length = Number.parseInt(pending.subarray(0, 4).toString(), 16);
        if (pending.length < length + 4) return;
        const request = pending.subarray(4, length + 4).toString();
        pending = pending.subarray(length + 4);
        requests.push(request);
        const answer = (text: string) =>
          socket.write(`OKAY${Buffer.byteLength(text).toString(16).padStart(4, "0")}${text}`);
        if (request === "host:version") answer("0029");
        else if (request === "host:devices-l") answer(list);
        else if (request === "host:transport-id:7") socket.write("OKAY");
        else if (request === "host:features") answer("shell_v2,cmd,stat_v2");
        else if (request === "host-transport-id:7:wait-for-any-device") {
          socket.write("OKAY");
          authorize.resolve(socket);
        } else if (request === "host-transport-id:7:wait-for-any-disconnect") {
          socket.write("OKAY");
          disconnect.resolve(socket);
        } else if (request.startsWith("exec:cmd package install ")) {
          installSize = Number(/-S (\d+)$/u.exec(request)?.[1]);
          socket.write("OKAY");
        } else if (request.startsWith("exec:getprop ")) {
          socket.end("OKAYGM1915\n");
        } else {
          socket.end("FAIL000bunsupported");
        }
      }
    });
  });
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No smart-socket port");
  return {
    requests,
    installs,
    disconnect,
    authorize,
    reset: () => {
      for (const socket of sockets) socket.destroy();
    },
    port: address.port,
  };
}

it("uses the existing server for exactly the selected USB transport without host-wide commands", async () => {
  const server = await smartSocket(
    "oneplus device usb:1 product:OnePlus7Pro model:GM1915 transport_id:7\nother device usb:2 transport_id:8\n",
  );
  const abort = new AbortController();
  cleanup.push(() => abort.abort());
  const connection = await connectAgentPhoneAdbServer(device, abort.signal, vi.fn(), {
    owner: async () => "owned-server",
    port: server.port,
  });
  expect(connection).not.toBeNull();
  expect(await connection?.adb.getProp("ro.product.model")).toBe("GM1915");
  await expect(connection!.adb.install(new Uint8Array([1, 2, 3]))).resolves.toEqual({ ok: true });
  expect(server.installs).toEqual([Buffer.from([1, 2, 3])]);
  await vi.waitFor(
    () => expect(server.requests).toContain("host-transport-id:7:wait-for-any-disconnect"),
    { timeout: 1_000 },
  );
  (await server.disconnect.promise).end("OKAY");
  await withTimeout(connection!.disconnected, 1_000, {
    timeoutError: () => new Error("Phone disconnect was not observed"),
  });
  expect(
    server.requests.filter(
      (request) =>
        request.startsWith("host:") &&
        request !== "host:version" &&
        request !== "host:devices-l" &&
        request !== "host:features",
    ),
  ).toEqual(["host:transport-id:7", "host:transport-id:7", "host:transport-id:7"]);
  expect(
    server.requests.some((request) => /kill|reconnect|host-serial|transport-id:8/u.test(request)),
  ).toBe(false);
  await connection?.close();
});

it.each([
  "oneplus device transport_id:7\n",
  "oneplus device usb:1 transport_id:7\noneplus device usb:2 transport_id:8\n",
])("refuses ambiguous or non-USB server devices", async (list) => {
  const server = await smartSocket(list);
  await expect(
    connectAgentPhoneAdbServer(device, new AbortController().signal, vi.fn(), {
      owner: async () => "owned",
      port: server.port,
    }),
  ).rejects.toThrow("uniquely");
  expect(server.requests).toEqual(["host:version", "host:devices-l"]);
});

it("does not reach the server when none is owned and rejects a server replaced during opening", async () => {
  expect(
    await connectAgentPhoneAdbServer(device, new AbortController().signal, vi.fn(), {
      owner: async () => null,
    }),
  ).toBeNull();
  const server = await smartSocket("oneplus device usb:1 transport_id:7\n");
  const owner = vi.fn().mockResolvedValueOnce("original").mockResolvedValue("replacement");
  await expect(
    connectAgentPhoneAdbServer(device, new AbortController().signal, vi.fn(), {
      owner,
      port: server.port,
    }),
  ).rejects.toThrow("restarted");
  expect(server.requests).toEqual([]);
});

it("waits for the selected phone's authorization and cancels that wait without touching other devices", async () => {
  const server = await smartSocket("oneplus unauthorized usb:1 transport_id:7\n");
  const abort = new AbortController();
  const prompt = vi.fn();
  const opening = connectAgentPhoneAdbServer(device, abort.signal, prompt, {
    owner: async () => "owned",
    port: server.port,
  });
  await withTimeout(server.authorize.promise, 1_000, {
    timeoutError: () => new Error("ADB authorization wait did not start"),
  });
  expect(prompt).toHaveBeenCalledOnce();
  const rejected = expect(opening).rejects.toThrow("Setup cancelled");
  abort.abort(new Error("Setup cancelled"));
  await rejected;
  expect(server.requests).not.toContain("host:transport-id:7");
});

it("a dead server invalidates existing transport IDs before they can be used again", async () => {
  const server = await smartSocket("oneplus device usb:1 transport_id:7\n");
  const abort = new AbortController();
  cleanup.push(() => abort.abort());
  const connection = await connectAgentPhoneAdbServer(device, abort.signal, vi.fn(), {
    owner: async () => "owned",
    port: server.port,
  });
  await withTimeout(server.disconnect.promise, 1_000, {
    timeoutError: () => new Error("ADB disconnect monitor did not start"),
  });
  server.reset();
  await withTimeout(connection!.disconnected, 1_000, {
    timeoutError: () => new Error("ADB server loss did not invalidate the connection"),
  });
  const requests = [...server.requests];
  await expect(connection!.adb.getProp("ro.product.model")).rejects.toThrow("closed");
  expect(server.requests).toEqual(requests);
});

it.each(["connecting", "authorizing", "offline"])(
  "waits for a newly plugged-in %s phone",
  async (state) => {
    const server = await smartSocket(`oneplus ${state} usb:1 transport_id:7\n`);
    const abort = new AbortController();
    cleanup.push(() => abort.abort());
    const prompt = vi.fn();
    const opening = connectAgentPhoneAdbServer(device, abort.signal, prompt, {
      owner: async () => "owned",
      port: server.port,
    });
    const waiting = await withTimeout(server.authorize.promise, 1_000, {
      timeoutError: () => new Error("USB readiness wait did not start"),
    });
    waiting.end("OKAY");
    const connection = await opening;
    expect(prompt).toHaveBeenCalledTimes(state === "authorizing" ? 1 : 0);
    expect(await connection!.adb.getProp("ro.product.model")).toBe("GM1915");
    await connection!.close();
  },
);
