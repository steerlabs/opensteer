import { mkdtemp } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { firecrackerApi } from "./api.js";
import { helperCall } from "./vsock.js";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

/** Firecracker's host side of vsock: "CONNECT <port>\n", "OK <n>\n", then the guest's bytes. */
async function fakeVsock(answer: (command: Buffer) => Buffer | null) {
  const path = join(await mkdtemp(join(tmpdir(), "osp-vsock-")), "v.sock");
  const received: Buffer[] = [];
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let connected = false;
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!connected) {
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        expect(buffer.subarray(0, end).toString()).toBe("CONNECT 1024");
        buffer = buffer.subarray(end + 1);
        connected = true;
        socket.write("OK 1073741824\n");
      }
      const need = buffer[0] === 0x54 ? 17 : 1;
      if (buffer.length < need) return;
      received.push(buffer.subarray(0, need));
      const reply = answer(buffer.subarray(0, need));
      if (reply) socket.end(reply);
      else socket.destroy();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return { path, received };
}

it("sends one command and accepts only the one-byte acknowledgement", async () => {
  const guest = await fakeVsock(() => Buffer.from("K"));
  await helperCall(guest.path, { kind: "ping" }, AbortSignal.timeout(2000));
  await helperCall(guest.path, { kind: "sync" }, AbortSignal.timeout(2000));
  const before = BigInt(Date.now()) / 1000n;
  await helperCall(guest.path, { kind: "time" }, AbortSignal.timeout(2000));
  const time = guest.received[2]!;
  expect(time.subarray(0, 1).toString()).toBe("T");
  const seconds = time.readBigInt64LE(1);
  expect(seconds >= before && seconds <= before + 2n).toBe(true);
  expect(time.readBigInt64LE(9) < 1_000_000_000n).toBe(true);
  expect(guest.received.map((command) => command.subarray(0, 1).toString())).toEqual([
    "P",
    "S",
    "T",
  ]);
});

it("treats anything but the acknowledgement as a failure, without reading more", async () => {
  for (const reply of [Buffer.from("X"), Buffer.from("KK"), null]) {
    const guest = await fakeVsock(() => reply);
    await expect(
      helperCall(guest.path, { kind: "ping" }, AbortSignal.timeout(2000)),
    ).rejects.toThrow();
  }
});

it("gives up at its deadline when the guest never answers", async () => {
  const guest = await fakeVsock(() => Buffer.alloc(0));
  const started = Date.now();
  await expect(
    helperCall(guest.path, { kind: "ping" }, AbortSignal.timeout(100)),
  ).rejects.toThrow();
  expect(Date.now() - started).toBeLessThan(2000);
});

it("speaks Firecracker's API over its Unix socket and reports its fault message", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "osp-api-")), "api.sock");
  const seen: string[] = [];
  const server = createHttpServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      seen.push(`${request.method} ${request.url} ${body}`);
      if (request.url === "/vm") response.writeHead(204).end();
      else if (request.url === "/")
        response.writeHead(200, { "content-type": "application/json" }).end('{"state":"Paused"}');
      else response.writeHead(400).end('{"fault_message":"Invalid snapshot"}');
    });
  });
  servers.push(server as unknown as Server);
  await new Promise<void>((resolve) => server.listen(path, resolve));
  await firecrackerApi(path, "PATCH", "/vm", { state: "Paused" });
  expect(await firecrackerApi(path, "GET", "/")).toEqual({ state: "Paused" });
  await expect(firecrackerApi(path, "PUT", "/snapshot/load", {})).rejects.toThrow(
    "Invalid snapshot",
  );
  expect(seen[0]).toBe('PATCH /vm {"state":"Paused"}');
});
