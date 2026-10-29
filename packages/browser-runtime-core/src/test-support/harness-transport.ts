import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import type { CdpParameters } from "@opensteer/browser-core";
import type { BrowserServerMessage } from "@opensteer/protocol";

/** Standard CDP transport over the real controller, including virtual-session events. */
export async function startHarnessBridge(
  request: (method: string, parameters?: CdpParameters, sessionId?: string) => Promise<unknown>,
  subscribe?: (listener: (message: BrowserServerMessage) => void) => () => void,
): Promise<{ readonly url: string; close(): Promise<void> }> {
  const requestInTest = AsyncLocalStorage.bind(request);
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const unsubscribe = subscribe?.((message) => {
    if (message.type !== "cdp.event") return;
    const event = message.event;
    for (const socket of server.clients) {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(
          JSON.stringify({
            method: event.method,
            params: event.parameters,
            sessionId: event.sessionId,
          }),
        );
    }
  });
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const decoded = z
        .object({
          id: z.number().int(),
          method: z.string(),
          params: z.record(z.string(), z.unknown()).optional(),
          sessionId: z.string().optional(),
        })
        .safeParse(JSON.parse(raw.toString()));
      if (!decoded.success) {
        socket.close(1007, "Invalid test CDP request");
        return;
      }
      const message = decoded.data;
      const send = (reply: object) => {
        if (socket.readyState === WebSocket.OPEN)
          socket.send(
            JSON.stringify({
              ...reply,
              ...(message.sessionId ? { sessionId: message.sessionId } : {}),
            }),
          );
      };
      void requestInTest(message.method, message.params, message.sessionId).then(
        (result) => send({ id: message.id, result }),
        (error: unknown) =>
          send({
            id: message.id,
            error: {
              message: error instanceof Error ? error.message : String(error),
              ...(error instanceof Error ? error : {}),
            },
          }),
      );
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Harness bridge did not bind.");
  let closing: Promise<void> | undefined;
  return {
    close: () =>
      (closing ??= new Promise<void>((resolve, reject) => {
        unsubscribe?.();
        for (const client of server.clients) client.terminate();
        server.close((error) => (error ? reject(error) : resolve()));
      })),
    url: `ws://127.0.0.1:${address.port}/internal/v1/browser-cdp`,
  };
}

export interface HarnessOutput {
  readonly stderr: string;
  readonly stdout: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly elapsedMs: number;
}

export class HarnessRunError extends Error {
  readonly output: HarnessOutput;
  constructor(output: HarnessOutput) {
    super(`Browser Harness exited ${output.exitCode}: ${output.stderr}`);
    this.output = output;
  }
}

/** Kill and reap on abort/deadline, including a harness stuck behind a dialog. */
export function runHarnessExecutable(
  url: string,
  sessionId: string,
  targetId: string | undefined,
  program: string,
  options: {
    readonly executable: string;
    readonly args?: readonly string[];
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    /** Each stderr line as it arrives, for journeys that act on the harness's notices. */
    readonly onStderrLine?: (line: string) => void;
  },
): Promise<HarnessOutput> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(
      options.executable,
      [...(options.args ?? []), "--session", sessionId, ...(targetId ? ["--tab", targetId] : [])],
      {
        env: { ...process.env, OPENSTEER_BROWSER_CDP_WS: url },
        ...(options.signal ? { signal: options.signal } : {}),
        killSignal: "SIGKILL",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 40_000);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    let partial = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
      if (!options.onStderrLine) return;
      const lines = (partial + chunk.toString("utf8")).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) options.onStderrLine(line);
    });
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      const output = {
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
        exitCode,
        signal,
        elapsedMs: Math.round(performance.now() - started),
      };
      if (spawnError) reject(spawnError);
      else if (exitCode === 0) resolve(output);
      else reject(new HarnessRunError(output));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(program);
  });
}
