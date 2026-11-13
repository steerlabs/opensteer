import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import type { CdpParameters } from "@opensteer/browser-core";
import { createBrowserSessionId, type BrowserRuntimeServerMessage } from "@opensteer/protocol";

export interface HarnessBridgeOptions {
  readonly agent?: (
    path: string,
    input: Record<string, unknown>,
    query: URLSearchParams,
  ) => Promise<unknown>;
  readonly backend?: (sessionId: string) => "cdp" | "actions";
  readonly actions?: (input: Record<string, unknown>, sessionId: string) => Promise<unknown>;
}

/** Standard CDP transport over the real controller, including virtual-session events. */
export async function startHarnessBridge(
  request: (
    method: string,
    parameters?: CdpParameters,
    sessionId?: string,
    browserSessionId?: string,
  ) => Promise<unknown>,
  subscribe?: (listener: (message: BrowserRuntimeServerMessage) => void) => () => void,
  options: HarnessBridgeOptions = {},
): Promise<{ readonly url: string; close(): Promise<void> }> {
  const requestInTest = AsyncLocalStorage.bind(request);
  const fixtureSessionId = createBrowserSessionId();
  const defaultAgent = async (
    path: string,
    input: Record<string, unknown>,
    query: URLSearchParams,
  ) => {
    const inventory = (await requestInTest("Opensteer.listTabs")) as {
      tabs: Array<{
        surfaceId?: string;
        targetId: string;
        title?: string;
        url?: string;
        state?: string;
      }>;
    };
    const tabs = inventory.tabs.map((tab) => ({
      tabId: tab.surfaceId ?? tab.targetId,
      title: tab.title ?? "",
      url: tab.url ?? "",
      profile: null,
      computer: "Test computer",
      state: tab.state === "suspended" ? "asleep" : "open",
      usedByThisTask: true,
      usedByOtherTask: false,
      groupId: null,
    }));
    if (path === "tabs") {
      const matching = tabs.filter(
        (tab) =>
          (!query.get("query") || `${tab.title} ${tab.url}`.includes(query.get("query")!)) &&
          (!query.get("state") || tab.state === query.get("state")),
      );
      const offset = Number(query.get("cursor") ?? 0);
      const limit = Number(query.get("limit") ?? 50);
      return {
        tabs: matching.slice(offset, offset + limit),
        total: matching.length,
        nextCursor: offset + limit < matching.length ? String(offset + limit) : null,
      };
    }
    if (path === "tabs/use") {
      const tab = inventory.tabs.find(
        (tab) => tab.surfaceId === input.tabId || tab.targetId === input.tabId,
      );
      if (!tab) throw new Error("That tab is unavailable.");
      return {
        tabId: tab.surfaceId ?? tab.targetId,
        sessionId: fixtureSessionId,
        backend: "cdp",
        reloaded: false,
      };
    }
    if (path === "tabs/close") {
      const ids = input.tabIds as string[];
      for (const id of ids)
        await requestInTest("Target.closeTarget", {
          targetId:
            inventory.tabs.find((tab) => tab.surfaceId === id || tab.targetId === id)?.targetId ??
            id,
        });
      return { closed: ids, failed: [] };
    }
    throw new Error(`Unsupported test agent route: ${path}`);
  };
  const agentInTest = AsyncLocalStorage.bind(options.agent ?? defaultAgent);
  const actionsInTest = options.actions ? AsyncLocalStorage.bind(options.actions) : undefined;
  const http = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "", "http://fixture.invalid");
      const prefix = "/internal/v1/browser-cdp/agent/";
      let result;
      if (url.pathname.startsWith(prefix)) {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString();
        result = await agentInTest(
          url.pathname.slice(prefix.length),
          body ? JSON.parse(body) : {},
          url.searchParams,
        );
      } else {
        const sessionId = url.pathname.split("/").at(-1)!;
        result = { sessionId, backend: options.backend?.(sessionId) ?? "cdp", version: 1 };
      }
      response.writeHead(result instanceof Response ? result.status : 200, {
        "content-type": "application/json",
      });
      response.end(result instanceof Response ? await result.text() : JSON.stringify(result));
    })().catch((error: unknown) => {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: String(error) } }));
    });
  });
  const server = new WebSocketServer({ server: http });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
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
  server.on("connection", (socket, request) => {
    const browserSessionId = request.url!.split("/").at(-1)!;
    socket.on("message", (raw) => {
      if (request.url?.includes("/actions/")) {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (!actionsInTest) {
          socket.close(1008, "No browser actions fixture");
          return;
        }
        const send = (reply: object) => {
          if (socket.readyState === WebSocket.OPEN)
            socket.send(JSON.stringify({ id: message.id, ...reply }));
        };
        void actionsInTest(message, browserSessionId).then(
          (result) => send({ result }),
          (error: unknown) => send({ error: { code: "forbidden", message: String(error) } }),
        );
        return;
      }
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
      void requestInTest(message.method, message.params, message.sessionId, browserSessionId).then(
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
        server.close((error) => {
          http.close((httpError) => (error || httpError ? reject(error ?? httpError) : resolve()));
        });
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
  _sessionId: string,
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
      [...(options.args ?? []), ...(targetId ? ["--tab", targetId] : [])],
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
