import { createId } from "@opensteer/core";
import {
  RunnerAuxiliaryStreamIdSchema,
  RunnerBootIdSchema,
  RunnerConnectionIdSchema,
  RunnerConnectionLeaseIdSchema,
  ShellSessionIdSchema,
  ShellModuleToHostMessageSchema,
  shellDataMessageMaxBytes,
  type RunnerAuxiliaryFrameFence,
  type ShellModuleEvent,
} from "@opensteer/protocol";
import type { RunnerModuleStream } from "@opensteer/runner-client";
import { EventEmitter, once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ShellModuleHandler,
  pumpReadableToWebSocket,
  pumpWebSocketToWritable,
  shellHelperEnvironment,
} from "./shell-module-handler.js";

const directories: string[] = [];
const handlers: ShellModuleHandler[] = [];
const cleanups: Array<() => void> = [];
const servers: Array<{
  readonly http: ReturnType<typeof createServer>;
  readonly webSockets: WebSocketServer;
}> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  await Promise.all(handlers.splice(0).map((handler) => handler.detach()));
  for (const server of servers.splice(0)) {
    for (const client of server.webSockets.clients) client.terminate();
    await new Promise<void>((resolve) => server.webSockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.http.close(() => resolve()));
  }
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("ShellModuleHandler", () => {
  it("passes the target account environment except Opensteer variables", () => {
    expect(
      shellHelperEnvironment({
        DOCKER_HOST: "unix:///Users/test/.docker/run/docker.sock",
        HOME: "/Users/test",
        LANG: "en_US.UTF-8",
        OPENSTEER_SECRET: "never",
        PATH: "/usr/bin",
        SHELL: "/bin/zsh",
        SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
        TMPDIR: "/tmp",
        USER: "test",
        XDG_CONFIG_HOME: "/Users/test/.config",
      }),
    ).toEqual({
      DOCKER_HOST: "unix:///Users/test/.docker/run/docker.sock",
      HOME: "/Users/test",
      LANG: "en_US.UTF-8",
      PATH: "/usr/bin",
      SHELL: "/bin/zsh",
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      TMPDIR: "/tmp",
      USER: "test",
      XDG_CONFIG_HOME: "/Users/test/.config",
    });
  });

  it("bounds a stalled output pump at 1 MiB without blocking a sibling pump", async () => {
    const stalledSource = new PassThrough();
    const stalledCallbacks: Array<(error?: Error) => void> = [];
    let stalledQueuedBytes = 0;
    pumpReadableToWebSocket(
      stalledSource,
      {
        send: (chunk, _options, callback) => {
          stalledQueuedBytes += chunk.byteLength;
          stalledCallbacks.push(callback);
        },
      },
      (error) => {
        throw error;
      },
    );
    stalledSource.write(Buffer.alloc(1024 * 1024));
    expect(stalledQueuedBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(stalledSource.isPaused()).toBe(true);

    const siblingSource = new PassThrough();
    const siblingSent = Promise.withResolvers<void>();
    let siblingBytes = 0;
    pumpReadableToWebSocket(
      siblingSource,
      {
        send: (chunk, _options, callback) => {
          siblingBytes += chunk.byteLength;
          callback();
          siblingSent.resolve();
        },
      },
      (error) => {
        throw error;
      },
    );
    siblingSource.write(Buffer.from("sibling"));
    await siblingSent.promise;
    expect(siblingBytes).toBe(Buffer.byteLength("sibling"));
    expect(stalledCallbacks).toHaveLength(1);
  });

  it("stops an in-flight backpressured pump without resuming or sending again", () => {
    const source = new PassThrough();
    const callbacks: Array<(error?: Error) => void> = [];
    let sends = 0;
    const pump = pumpReadableToWebSocket(
      source,
      {
        send: (_chunk, _options, callback) => {
          sends += 1;
          callbacks.push(callback);
        },
      },
      (error) => {
        throw error;
      },
    );
    source.write(Buffer.from("first"));
    expect(source.isPaused()).toBe(true);

    pump.stop();
    callbacks[0]?.(new Error("late EPIPE"));
    source.write(Buffer.from("second"));

    expect(sends).toBe(1);
    expect(source.isPaused()).toBe(true);
  });

  it("pauses input only for writable backpressure or the queue cap", async () => {
    const host = await fakeDataHost();
    const connect = async (): Promise<{
      readonly client: WebSocket;
      readonly source: WebSocket;
    }> => {
      const connected = new Promise<WebSocket>((resolve) =>
        host.webSockets.once("connection", resolve),
      );
      const url = new URL(host.url);
      url.protocol = "ws:";
      url.pathname = "/internal/v1/shell/data";
      const client = new WebSocket(url);
      await new Promise<void>((resolve, reject) => {
        client.once("open", resolve);
        client.once("error", reject);
      });
      return { client, source: await connected };
    };

    const healthy = await connect();
    const healthyPause = vi.spyOn(healthy.source, "pause");
    const healthyWritten = Promise.withResolvers<void>();
    let healthyBytes = 0;
    const healthyPump = pumpWebSocketToWritable(
      healthy.source,
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          healthyBytes += chunk.byteLength;
          callback();
          healthyWritten.resolve();
        },
      }),
      (error) => {
        throw error;
      },
    );
    healthy.client.send(Buffer.from("healthy"));
    await healthyWritten.promise;
    expect(healthyBytes).toBe(Buffer.byteLength("healthy"));
    expect(healthyPause).not.toHaveBeenCalled();
    healthyPump.stop();
    healthy.client.terminate();

    const congested = await connect();
    const congestedPause = vi.spyOn(congested.source, "pause");
    const congestedWritten = Promise.withResolvers<void>();
    let releaseCongested: (() => void) | undefined;
    const congestedDestination = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        releaseCongested = callback;
        congestedWritten.resolve();
      },
    });
    const congestedPump = pumpWebSocketToWritable(
      congested.source,
      congestedDestination,
      (error) => {
        throw error;
      },
    );
    congested.client.send(Buffer.from("blocked"));
    await congestedWritten.promise;
    expect(congestedPause).toHaveBeenCalled();
    expect(congestedDestination.writableNeedDrain).toBe(true);
    releaseCongested?.();
    congestedPump.stop();
    congested.client.terminate();

    const capped = await connect();
    const cappedPause = vi.spyOn(capped.source, "pause");
    let releaseCapped: (() => void) | undefined;
    const cappedDestination = new Writable({
      highWaterMark: 2 * 1024 * 1024,
      write(_chunk, _encoding, callback) {
        releaseCapped = callback;
      },
    });
    const cappedPump = pumpWebSocketToWritable(capped.source, cappedDestination, (error) => {
      throw error;
    });
    const cappedReceived = Promise.withResolvers<void>();
    let cappedMessages = 0;
    capped.source.on("message", () => {
      cappedMessages += 1;
      if (cappedMessages === 4) cappedReceived.resolve();
    });
    for (let index = 0; index < 4; index += 1) {
      capped.client.send(Buffer.alloc(shellDataMessageMaxBytes));
    }
    await cappedReceived.promise;
    expect(cappedPause).toHaveBeenCalled();
    expect(cappedDestination.writableNeedDrain).toBe(false);
    releaseCapped?.();
    cappedPump.stop();
    capped.client.terminate();
  });

  it("writes one init frame before pumping bytes and opens only after ready plus data attach", async () => {
    const directory = await temporaryDirectory();
    const initPath = join(directory, "init.json");
    const helper = await helperScript(directory, initPath, `fd.write('{"kind":"ready"}\\n');`);
    const host = await fakeDataHost();
    let echoed = "";
    const inputEchoed = Promise.withResolvers<void>();
    host.webSockets.on("connection", (socket) => {
      socket.on("message", (raw) => {
        echoed += raw.toString();
        if (echoed.includes("ssh-input")) inputEchoed.resolve();
      });
      socket.send(Buffer.from("ssh-input"));
    });
    const { handler, reports, reported } = handlerFor(helper, host.url);
    const message = openMessage();
    await handler.handleFrame(Buffer.from(JSON.stringify(message)), false);

    await reported("runner.shell.session.opened");
    await inputEchoed.promise;
    const init = JSON.parse(await readFile(initPath, "utf8")) as Record<string, unknown>;
    expect(init).toEqual({
      authority: message.authority,
      hostKeyPath: "/runner/shell_host_ed25519",
      machineName: message.machineName,
      policy: message.policy,
    });
    expect(reports.map((report) => report.type)).toEqual(["runner.shell.session.opened"]);
    await handler.handleFrame(
      Buffer.from(
        JSON.stringify({
          ...fence(),
          reason: "stopped-by-owner",
          sessionId: message.sessionId,
          type: "host.shell.session.close",
        }),
      ),
      false,
    );
    await reported("runner.shell.session.closed");
    expect(reports.at(-1)).toMatchObject({
      reason: "stopped-by-owner",
      type: "runner.shell.session.closed",
    });
    expect(reports.at(-1)).not.toHaveProperty("auditDropped");
    await handler.detach();
  });

  it("delivers Runner environment markers to the helper without Opensteer variables", async () => {
    const directory = await temporaryDirectory();
    const environmentPath = join(directory, "environment.json");
    const helper = await helperScript(
      directory,
      join(directory, "init.json"),
      `const target = ${JSON.stringify(environmentPath)}; fs.writeFileSync(target + '.tmp', JSON.stringify({ marker: process.env.RUNNER_ACCOUNT_MARKER, opensteer: process.env.OPENSTEER_TEST_MARKER })); fs.renameSync(target + '.tmp', target); fd.write('{"kind":"ready"}\\n');`,
    );
    const host = await fakeDataHost();
    const previousMarker = process.env.RUNNER_ACCOUNT_MARKER;
    const previousOpensteerMarker = process.env.OPENSTEER_TEST_MARKER;
    process.env.RUNNER_ACCOUNT_MARKER = "account-configured";
    process.env.OPENSTEER_TEST_MARKER = "must-not-leak";
    try {
      const { handler, reported } = handlerFor(helper, host.url);
      await handler.handleFrame(Buffer.from(JSON.stringify(openMessage())), false);
      await reported("runner.shell.session.opened");
      expect(JSON.parse(await readFile(environmentPath, "utf8"))).toEqual({
        marker: "account-configured",
      });
      await handler.detach();
    } finally {
      restoreEnvironment("RUNNER_ACCOUNT_MARKER", previousMarker);
      restoreEnvironment("OPENSTEER_TEST_MARKER", previousOpensteerMarker);
    }
  });

  it("rejects a helper that exits before ready", async () => {
    const directory = await temporaryDirectory();
    const helper = await helperScript(directory, join(directory, "init.json"), "process.exit(2);");
    const host = await fakeDataHost();
    const { handler, reports, reported } = handlerFor(helper, host.url);
    await handler.handleFrame(Buffer.from(JSON.stringify(openMessage())), false);
    await reported("runner.shell.session.rejected");
    expect(reports.some((report) => report.type === "runner.shell.session.opened")).toBe(false);
    expect(reports[0]).toMatchObject({
      error: { code: "open-failed", message: expect.stringMatching(/\.$/u) },
      type: "runner.shell.session.rejected",
    });
    await reported("runner.shell.session.closed");
    expect(reports.at(-1)).toMatchObject({
      reason: "open-failed",
      type: "runner.shell.session.closed",
    });
    expect(reports.at(-1)).not.toHaveProperty("auditDropped");
    await handler.detach();
  });

  it.each(["before ready", "after ready"] as const)(
    "forwards audit records but consumes lifecycle records locally (%s)",
    async (ordering) => {
      const directory = await temporaryDirectory();
      const records = [
        { kind: "process.started", channel: 7, processGroupId: 12345 },
        { kind: "exec", channel: 7, command: "whoami" },
        { kind: "process.exited", channel: 7, processGroupId: 12345 },
      ];
      const ready = { kind: "ready" };
      const ordered = ordering === "before ready" ? [...records, ready] : [ready, ...records];
      const helper = await helperScript(
        directory,
        join(directory, "init.json"),
        `for (const record of ${JSON.stringify(ordered)}) fd.write(JSON.stringify(record) + '\\n');`,
      );
      const host = await fakeDataHost();
      const { handler, reports, reported } = handlerFor(helper, host.url);
      await handler.handleFrame(Buffer.from(JSON.stringify(openMessage())), false);
      await reported("runner.shell.event");
      await reported("runner.shell.session.opened");
      await handler.detach();
      expect(reports.filter((report) => report.type === "runner.shell.event")).toEqual([
        expect.objectContaining({ event: { channel: 7, command: "whoami", kind: "exec" } }),
      ]);
      expect(JSON.stringify(reports)).not.toContain("process.started");
      expect(JSON.stringify(reports)).not.toContain("process.exited");
    },
  );

  it("drops the newest audit record when the per-session queue is full", async () => {
    const directory = await temporaryDirectory();
    const helper = await helperScript(
      directory,
      join(directory, "init.json"),
      `for (let index = 0; index < 1002; index += 1) fd.write(JSON.stringify({kind:'exec',channel:7,command:'command-'+index})+'\\n'); fd.write('{"kind":"ready"}\\n'); setInterval(() => {}, 1000);`,
    );
    const host = await fakeDataHost();
    let firstAudit = true;
    const firstAuditBlocked = Promise.withResolvers<void>();
    cleanups.push(firstAuditBlocked.resolve);
    const { handler, reports, reported } = handlerFor(
      helper,
      host.url,
      25,
      undefined,
      async (report) => {
        if (report.type === "runner.shell.event" && firstAudit) {
          firstAudit = false;
          await firstAuditBlocked.promise;
        }
      },
    );
    const message = openMessage();
    await handler.handleFrame(Buffer.from(JSON.stringify(message)), false);
    await reported("runner.shell.session.opened");
    firstAuditBlocked.resolve();
    await reported("runner.shell.event", 1001);
    const commands = reports
      .filter((report) => report.type === "runner.shell.event")
      .map((report) => (report.event.kind === "exec" ? report.event.command : undefined));
    expect(commands.at(-1)).toBe("command-1000");
    expect(commands).not.toContain("command-1001");

    await handler.handleFrame(
      Buffer.from(
        JSON.stringify({
          ...fence(),
          reason: "stopped-by-owner",
          sessionId: message.sessionId,
          type: "host.shell.session.close",
        }),
      ),
      false,
    );
    await reported("runner.shell.session.closed");
    expect(reports.at(-1)).toMatchObject({
      auditDropped: 1,
      reason: "stopped-by-owner",
      type: "runner.shell.session.closed",
    });
    await handler.detach();
  });

  it("totals helper loss, Runner overflow, and a failed audit send", async () => {
    const directory = await temporaryDirectory();
    const helper = await helperScript(
      directory,
      join(directory, "init.json"),
      `for (let index = 0; index < 1002; index += 1) fd.write(JSON.stringify({kind:'exec',channel:7,command:'command-'+index})+'\\n'); fd.write('{"kind":"audit.dropped","count":3}\\n'); fd.write('{"kind":"ready"}\\n'); fd.write('{"kind":"session.end","reason":"idle-timeout"}\\n');`,
    );
    const host = await fakeDataHost();
    const { handler, reports, reported } = handlerFor(helper, host.url, 25, undefined, (report) => {
      if (report.type === "runner.shell.event") throw new Error("control stream closed");
      return Promise.resolve();
    });
    await handler.handleFrame(Buffer.from(JSON.stringify(openMessage())), false);
    await reported("runner.shell.session.closed");
    const closed = reports.find((report) => report.type === "runner.shell.session.closed");
    expect(closed).toMatchObject({
      auditDropped: 1005,
      reason: "idle-timeout",
      type: "runner.shell.session.closed",
    });
    expect(closed).not.toHaveProperty("detail");
    await handler.detach();
  });

  it("propagates helper idle-timeout to both the data close and control close", async () => {
    const directory = await temporaryDirectory();
    const helper = await helperScript(
      directory,
      join(directory, "init.json"),
      `process.stdin.once('data', () => fd.write('{"kind":"session.end","reason":"idle-timeout"}\\n')); fd.write('{"kind":"ready"}\\n');`,
    );
    const host = await fakeDataHost();
    const connected = new Promise<WebSocket>((resolve) => {
      host.webSockets.once("connection", resolve);
    });
    const dataClosed = Promise.withResolvers<string>();
    host.webSockets.once("connection", (socket) => {
      socket.once("close", (_code, reason) => {
        dataClosed.resolve(reason.toString("utf8"));
      });
    });
    const { handler, reports, reported } = handlerFor(helper, host.url, 25);
    await handler.handleFrame(Buffer.from(JSON.stringify(openMessage())), false);
    await reported("runner.shell.session.opened");
    (await connected).send(Buffer.from("end-session"));
    await reported("runner.shell.session.closed");
    expect(await dataClosed.promise).toBe("idle-timeout");
    expect(reports.at(-1)).toMatchObject({
      reason: "idle-timeout",
      type: "runner.shell.session.closed",
    });
    await handler.detach();
  });

  it("drains the lifecycle pipe before claiming a child exit as target-closed", async () => {
    const directory = await temporaryDirectory();
    const helper = await helperScript(
      directory,
      join(directory, "init.json"),
      `require('node:fs').writeSync(3, '{"kind":"ready"}\\n{"kind":"session.end","reason":"idle-timeout"}\\n'); process.exit(0);`,
    );
    const host = await fakeDataHost();
    const { handler, reports, reported } = handlerFor(helper, host.url, 25);
    await handler.handleFrame(Buffer.from(JSON.stringify(openMessage())), false);
    await reported("runner.shell.session.closed");
    expect(reports.at(-1)).toMatchObject({
      reason: "idle-timeout",
      type: "runner.shell.session.closed",
    });
    await handler.detach();
  });

  it.each(["close", "detach"] as const)(
    "cancels setup before a delayed data transport can create a socket (%s)",
    async (cancellation) => {
      const directory = await temporaryDirectory();
      const pidPath = join(directory, "helper.pid");
      const helper = await helperScript(
        directory,
        join(directory, "init.json"),
        `fs.writeFileSync(${JSON.stringify(pidPath + ".tmp")}, String(process.pid)); fs.renameSync(${JSON.stringify(pidPath + ".tmp")}, ${JSON.stringify(pidPath)}); setInterval(() => {}, 1000);`,
      );
      const helperInitialized = Promise.withResolvers<void>();
      const watcher = watch(directory, (_event, name) => {
        if (name === "helper.pid") helperInitialized.resolve();
      });
      watcher.once("error", helperInitialized.reject);
      cleanups.push(() => watcher.close());
      const host = await fakeDataHost();
      let dataConnections = 0;
      host.webSockets.on("connection", () => {
        dataConnections += 1;
      });
      const transportStarted = Promise.withResolvers<void>();
      const transportBlocked =
        Promise.withResolvers<
          Awaited<ReturnType<typeof import("@opensteer/runner-client").runnerWebSocketTransport>>
        >();
      const url = new URL(host.url);
      url.protocol = "ws:";
      url.pathname = "/internal/v1/shell/data";
      const transportUrl = vi.fn(() => url);
      const transport = {
        ca: undefined,
        get url() {
          return transportUrl();
        },
      };
      cleanups.push(() => transportBlocked.resolve(transport));
      const { handler, reports } = handlerFor(helper, host.url, 25, () => {
        transportStarted.resolve();
        return transportBlocked.promise;
      });
      const message = openMessage();
      await handler.handleFrame(Buffer.from(JSON.stringify(message)), false);
      await Promise.all([helperInitialized.promise, transportStarted.promise]);
      expect(reports).toEqual([]);
      if (cancellation === "close") {
        await handler.handleFrame(
          Buffer.from(
            JSON.stringify({
              ...fence(),
              reason: "stopped-by-owner",
              sessionId: message.sessionId,
              type: "host.shell.session.close",
            }),
          ),
          false,
        );
      }
      await handler.detach();

      const pid = Number(await readFile(pidPath, "utf8"));
      expect(processExists(pid)).toBe(false);
      expect(reports).toEqual([
        expect.objectContaining({
          reason: cancellation === "close" ? "stopped-by-owner" : "machine-disconnected",
          type: "runner.shell.session.closed",
        }),
      ]);
      transportBlocked.resolve(transport);
      // abortable registered its continuation before this await, so late resolution
      // has been consumed before checking that no socket construction read the URL.
      await transportBlocked.promise;
      expect(transportUrl).not.toHaveBeenCalled();
      expect(dataConnections).toBe(0);
    },
  );
});

function handlerFor(
  helperBinary: string,
  hostUrl: URL,
  cleanupWaitMs = 100,
  resolveDataTransport?: typeof import("@opensteer/runner-client").runnerWebSocketTransport,
  sendReport?: (report: ShellModuleEvent) => Promise<void>,
) {
  const reports: ShellModuleEvent[] = [];
  const received = new EventEmitter();
  const reported = async (type: ShellModuleEvent["type"], count = 1): Promise<ShellModuleEvent> => {
    for (;;) {
      const report = reports.filter((report) => report.type === type)[count - 1];
      if (report) return report;
      await once(received, type);
    }
  };
  const handler = new ShellModuleHandler({
    cleanupWaitMs,
    helperBinary,
    hostKeyPath: "/runner/shell_host_ed25519",
    logger: { error: () => undefined, info: () => undefined },
    ...(resolveDataTransport ? { resolveDataTransport } : {}),
    transport: { controlCaPath: undefined, hostUrl, mode: "development" },
  });
  const stream: RunnerModuleStream = {
    browserAttachPublicKeys: undefined,
    fence: fence(),
    send: async (frame, binary) => {
      expect(binary).toBe(false);
      const report = ShellModuleToHostMessageSchema.parse(JSON.parse(frame.toString()));
      if (report.type === "runner.auxiliary.heartbeat") throw new Error("Unexpected heartbeat");
      reports.push(report);
      received.emit(report.type);
      await sendReport?.(report);
    },
  };
  handler.attach(stream);
  handlers.push(handler);
  return { handler, reports, reported };
}

function openMessage() {
  const sessionId = ShellSessionIdSchema.parse(`shs_${crypto.randomUUID()}`);
  return {
    ...fence(),
    authority: {
      callerMachineName: "caller",
      policyRevision: 1,
      requestedBy: createId("user"),
      runId: createId("run"),
      sessionId,
      startedAt: new Date().toISOString(),
      threadId: createId("thread"),
      threadTitle: "Test shell",
      workspaceId: createId("workspace"),
    },
    dataTicket: "aaaa.bbbb.cccc",
    machineName: "Target machine",
    policy: { commands: true, forwarding: true, reach: "deployment", shares: [] },
    sessionId,
    type: "host.shell.session.open" as const,
  };
}

function fence(): RunnerAuxiliaryFrameFence {
  return {
    auxiliaryStreamId: RunnerAuxiliaryStreamIdSchema.parse(`rax_${crypto.randomUUID()}`),
    bootId: RunnerBootIdSchema.parse(`rbt_${crypto.randomUUID()}`),
    connectionGeneration: 1,
    connectionId: RunnerConnectionIdSchema.parse(`rcn_${crypto.randomUUID()}`),
    connectionLeaseId: RunnerConnectionLeaseIdSchema.parse(`rls_${crypto.randomUUID()}`),
    module: "shell",
    runnerId: createId("runner"),
  };
}

async function helperScript(
  directory: string,
  initPath: string,
  behavior: string,
): Promise<string> {
  const path = join(directory, "fake-helper");
  const source = `#!${process.execPath}
const fs = require('node:fs');
const fd = fs.createWriteStream(null, { fd: 3 });
let pending = Buffer.alloc(0);
function receive(chunk) {
  pending = Buffer.concat([pending, chunk]);
  if (pending.length < 4) return;
  const length = pending.readUInt32BE(0);
  if (pending.length < length + 4) return;
  const init = JSON.parse(pending.subarray(4, length + 4).toString('utf8'));
  fs.writeFileSync(${JSON.stringify(initPath)}, JSON.stringify(init));
  const remainder = pending.subarray(length + 4);
  process.stdin.off('data', receive);
  ${behavior}
  if (remainder.length) process.stdout.write(remainder);
  process.stdin.pipe(process.stdout);
}
process.stdin.on('data', receive);
`;
  await writeFile(path, source, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

async function fakeDataHost(): Promise<{
  readonly url: URL;
  readonly webSockets: WebSocketServer;
}> {
  const http = createServer();
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address() as AddressInfo;
  const webSockets = new WebSocketServer({
    maxPayload: 256 * 1024,
    perMessageDeflate: false,
    server: http,
    path: "/internal/v1/shell/data",
  });
  servers.push({ http, webSockets });
  return { url: new URL(`http://127.0.0.1:${address.port}`), webSockets };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "opensteer-shell-handler-test-"));
  directories.push(directory);
  return directory;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
