import {
  ignoreForeignTestRequest,
  probeTestServer,
} from "@opensteer/shared/test-support/serverProbes";
import { createId } from "@opensteer/core";
import {
  CorrelationIdSchema,
  type RunnerCommand,
  type RunnerOperationalReport,
} from "@opensteer/protocol";
import { WATCH_CRASH_NOTICE_THRESHOLD } from "@opensteer/triggers";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunnerMessageSink } from "../runtime/runtime.js";
import type { AgentHomeAccess } from "../folders/agent-home.js";
import { WatchSupervisor, watchRestartBackoffMs } from "./watch-supervisor.js";

describe("WatchSupervisor", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it("starts past stale artifacts, renews and expires, and evicts dropped revision cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "opensteer-watch-test-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const script = {
      interpreter: null,
      // The script prints the proxy token it holds and keeps calling its MCP endpoint with it;
      // the Host side records what reached it.
      text: 'console.log("holds:" + process.env.OPENSTEER_MCP_TOKEN); setInterval(() => { void fetch(process.env.OPENSTEER_MCP_URL, { body: "{}", headers: { accept: "application/json, text/event-stream", authorization: "Bearer " + process.env.OPENSTEER_MCP_TOKEN, "content-type": "application/json" }, method: "POST" }).catch(() => undefined); }, 30);',
    } as const;
    let fetchCount = 0;
    const toolAuthorizations: string[] = [];
    const server = createServer((request, response) => {
      if (
        ignoreForeignTestRequest(
          request,
          response,
          (path) => path === "/mcp" || path.startsWith("/internal/v1/triggers/revisions/"),
        )
      )
        return;
      response.setHeader("content-type", "application/json");
      if (request.url === "/mcp") {
        toolAuthorizations.push(request.headers.authorization ?? "");
        request.resume();
        response.end("{}");
        return;
      }
      fetchCount += 1;
      expect(request.url).toMatch(/^\/internal\/v1\/triggers\/revisions\/trv_[^/]+\/script$/u);
      expect(request.headers.authorization).toBe("Bearer control-token");
      response.end(JSON.stringify({ script, secrets: {} }));
    });
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP test server");
    await probeTestServer(server);
    const baseUrl = `http://127.0.0.1:${address.port}/mcp`;
    const messages: RunnerOperationalReport[] = [];
    const sink: RunnerMessageSink = {
      async send(message) {
        messages.push(message);
      },
    };
    const agentHome: AgentHomeAccess = {
      async prepare() {
        await mkdir(workspace, { recursive: true });
        return { instructions: undefined, path: workspace };
      },
      folder: async ({ path }) => path,
    };
    const environmentId = createId("environment");
    const activationId = createId("triggerWatchActivation");
    const anchorThreadId = createId("thread");
    const revisionId = createId("triggerRevision");
    const triggerId = createId("trigger");
    await mkdir(workspace, { recursive: true });
    const staleWorkspaceProgram = join(workspace, `.opensteer-watch-${activationId}.mjs`);
    await writeFile(staleWorkspaceProgram, "stale program from a killed Runner", { mode: 0o600 });
    const staleExecutionRoot = join(root, "private", "watches", "executions", "stale-boot");
    await mkdir(staleExecutionRoot, { recursive: true });
    await writeFile(join(staleExecutionRoot, "program.mjs"), "stale private program", {
      mode: 0o600,
    });
    const legacyCachePath = join(root, "private", "watches", "program-cache", `${revisionId}.json`);
    await mkdir(dirname(legacyCachePath), { mode: 0o700, recursive: true });
    await writeFile(
      legacyCachePath,
      JSON.stringify({ language: "javascript", source: "stale unversioned source" }),
      { mode: 0o600 },
    );
    const supervisor = new WatchSupervisor({
      environmentId,
      nodeExecutable: process.execPath,
      planLaunch: async () => (launch) => launch,
      privateStateDirectory: join(root, "private"),
      terminate: async () => "proven",
      transport: { mode: "development" },
      agentHome,
    });
    const command = (
      reconcileGeneration: number,
      desired: boolean,
      expiresAt: string,
      controlToken = "control-token",
      executionGeneration = 1,
    ): Extract<RunnerCommand, { readonly type: "watch.reconcile" }> => ({
      commandId: createId("command"),
      correlationId: CorrelationIdSchema.parse(`watch-test:${crypto.randomUUID()}`),
      desired: desired
        ? [
            {
              agentHome: { computerId: createId("runner"), path: workspace },
              activationId,
              anchorThreadId,
              capabilities: {
                browserCdp: null,
                mcp: { expiresAt, token: controlToken, url: baseUrl },
              },
              executionGeneration,
              revisionId,
              triggerId,
            },
          ]
        : [],
      environmentId,
      reconcileGeneration,
      type: "watch.reconcile",
    });

    try {
      await supervisor.reconcile(
        command(1, true, new Date(Date.now() + 60_000).toISOString()),
        sink,
      );
      await vi.waitFor(() => {
        expect(
          messages.some(
            (message) => message.type === "runner.watch-status" && message.observed === "running",
          ),
        ).toBe(true);
      });
      expect(supervisor.activeActivationIds()).toEqual([activationId]);
      await expect(access(staleWorkspaceProgram)).resolves.toBeUndefined();
      await expect(access(staleExecutionRoot)).rejects.toMatchObject({ code: "ENOENT" });
      const cachePath = join(root, "private", "watches", "script-cache-v1", `${revisionId}.json`);
      await expect(access(legacyCachePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(cachePath)).resolves.toBeUndefined();
      await expect(readFile(cachePath, "utf8")).resolves.toBe(
        JSON.stringify({ hasSecrets: false, script }),
      );

      // Expiry is tested only after the watch has proved it is running.
      await supervisor.reconcile(command(2, true, new Date(Date.now() + 350).toISOString()), sink);
      await vi.waitFor(
        () => {
          expect(
            messages.some(
              (message) => message.type === "runner.watch-status" && message.observed === "expired",
            ),
          ).toBe(true);
        },
        { timeout: 3_000 },
      );
      const runningBeforeRestart = messages.filter(
        (message) => message.type === "runner.watch-status" && message.observed === "running",
      ).length;
      await supervisor.reconcile(
        command(3, true, new Date(Date.now() + 60_000).toISOString(), "control-token-2", 2),
        sink,
      );
      await vi.waitFor(() => {
        expect(
          messages.filter(
            (message) => message.type === "runner.watch-status" && message.observed === "running",
          ),
        ).toHaveLength(runningBeforeRestart + 1);
      });
      expect(fetchCount).toBe(1);

      let renewalGeneration = 4;
      await vi.waitFor(async () => {
        await supervisor.reconcile(
          command(
            renewalGeneration++,
            true,
            new Date(Date.now() + 60_000).toISOString(),
            "control-token-2",
            2,
          ),
          sink,
        );
        // The renewed Host token reaches the Host behind the script's back.
        expect(toolAuthorizations.at(-1)).toBe("Bearer control-token-2");
      });
      const status = messages.findLast(
        (message) => message.type === "runner.watch-status" && message.observed === "running",
      );
      const held = /holds:(\S+)/u.exec(
        status?.type === "runner.watch-status" ? status.stdoutTail : "",
      )?.[1];
      expect(held).toBeTruthy();
      expect(held).not.toContain("control-token");

      await supervisor.reconcile(
        command(3, false, new Date(Date.now() + 60_000).toISOString()),
        sink,
      );
      expect(supervisor.activeActivationIds()).toEqual([activationId]);
      await supervisor.reconcile(
        command(renewalGeneration, false, new Date(Date.now() + 60_000).toISOString()),
        sink,
      );
      expect(supervisor.activeActivationIds()).toEqual([]);
      expect(messages.at(-1)).toMatchObject({ activationId, observed: "stopped" });
      await expect(access(cachePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await supervisor.close();
      await new Promise<void>((resolvePromise, reject) =>
        server.close((error) => (error ? reject(error) : resolvePromise())),
      );
    }
  });

  it("injects watch secrets as OPENSTEER_SECRET_* without ever writing them to disk cache (Y1/Z10)", async () => {
    const fixture = await watchHarness(
      'console.log("secret:" + process.env.OPENSTEER_SECRET_IMAP_PASS); setInterval(() => {}, 1000);',
      undefined,
      undefined,
      { IMAP_PASS: "s3cr3t-value" },
    );
    try {
      await fixture.supervisor.reconcile(fixture.command(1), fixture.sink);
      let gen = 2;
      await vi.waitFor(async () => {
        await fixture.supervisor.reconcile(fixture.command(gen++), fixture.sink);
        expect(
          fixture.messages.findLast(
            (message) => message.type === "runner.watch-status" && message.observed === "running",
          ),
        ).toMatchObject({ stdoutTail: expect.stringContaining("secret:s3cr3t-value") });
      });
      const cached = await readFile(fixture.cachePath, "utf8");
      expect(cached).not.toContain("s3cr3t-value");
      expect(JSON.parse(cached)).toMatchObject({ hasSecrets: true });
    } finally {
      await fixture.close();
    }
  });

  it("renews an expiring watch token on demand via sink.renewProxyToken without expiring the watch", async () => {
    const root = await mkdtemp(join(tmpdir(), "opensteer-watch-renew-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const toolAuthorizations: string[] = [];
    const script = {
      interpreter: null,
      text: 'setInterval(() => { void fetch(process.env.OPENSTEER_MCP_URL, { body: "{}", headers: { accept: "application/json, text/event-stream", authorization: "Bearer " + process.env.OPENSTEER_MCP_TOKEN, "content-type": "application/json" }, method: "POST" }).catch(() => undefined); }, 30);',
    } as const;
    const server = createServer((request, response) => {
      if (
        ignoreForeignTestRequest(
          request,
          response,
          (path) => path === "/mcp" || path.startsWith("/internal/v1/triggers/revisions/"),
        )
      )
        return;
      response.setHeader("content-type", "application/json");
      if (request.url === "/mcp") {
        toolAuthorizations.push(String(request.headers.authorization ?? ""));
        request.resume();
        response.end("{}");
        return;
      }
      response.end(JSON.stringify({ script, secrets: {} }));
    });
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server");
    const mcpUrl = `http://127.0.0.1:${address.port}/mcp`;
    const environmentId = createId("environment");
    const activationId = createId("triggerWatchActivation");
    const anchorThreadId = createId("thread");
    const revisionId = createId("triggerRevision");
    const triggerId = createId("trigger");
    const messages: RunnerOperationalReport[] = [];
    const renewCalls: unknown[] = [];
    const sink: RunnerMessageSink = {
      async send(message) {
        messages.push(message);
      },
      async renewProxyToken(target) {
        renewCalls.push(target);
        return {
          browserCdp: null,
          mcp: {
            expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
            token: "renewed-watch-token",
            url: mcpUrl,
          },
        };
      },
    };
    const supervisor = new WatchSupervisor({
      agentHome: {
        folder: async ({ path }) => path,
        prepare: async () => ({ instructions: undefined, path: workspace }),
      },
      environmentId,
      nodeExecutable: process.execPath,
      planLaunch: async () => (launch) => launch,
      privateStateDirectory: join(root, "private"),
      terminate: async () => "proven",
      transport: { mode: "development" },
    });
    try {
      await supervisor.reconcile(
        {
          commandId: createId("command"),
          correlationId: CorrelationIdSchema.parse(`watch-renew:${crypto.randomUUID()}`),
          desired: [
            {
              activationId,
              agentHome: { computerId: createId("runner"), path: workspace },
              anchorThreadId,
              capabilities: {
                browserCdp: null,
                // Already within the 60s on-demand refresh window
                mcp: {
                  expiresAt: new Date(Date.now() + 1_500).toISOString(),
                  token: "initial-expiring-token",
                  url: mcpUrl,
                },
              },
              executionGeneration: 1,
              revisionId,
              triggerId,
            },
          ],
          environmentId,
          reconcileGeneration: 1,
          type: "watch.reconcile",
        },
        sink,
      );
      await vi.waitFor(
        () => {
          expect(toolAuthorizations).toContain("Bearer renewed-watch-token");
        },
        { timeout: 5_000 },
      );
      expect(renewCalls).toEqual([
        {
          activationId,
          executionGeneration: 1,
          kind: "watch",
        },
      ]);
      expect(
        messages.some(
          (message) => message.type === "runner.watch-status" && message.observed === "expired",
        ),
      ).toBe(false);
    } finally {
      await supervisor.close();
      await new Promise<void>((resolvePromise, reject) =>
        server.close((error) => (error ? reject(error) : resolvePromise())),
      );
    }
  });

  it("withholds the stop receipt when containment cannot be verified", async () => {
    let proved = false;
    const fixture = await watchHarness("setInterval(() => {}, 1000);", undefined, async () =>
      proved ? "proven" : "unverifiable",
    );
    try {
      await fixture.supervisor.reconcile(fixture.command(1), fixture.sink);
      await expect(
        fixture.supervisor.stopAttempt(fixture.activationId, 1, fixture.sink),
      ).resolves.toBe("still-ending");
      expect(fixture.messages).not.toContainEqual(expect.objectContaining({ observed: "stopped" }));
      proved = true;
      await expect(
        fixture.supervisor.stopAttempt(fixture.activationId, 1, fixture.sink),
      ).resolves.toBe("ended");
      expect(fixture.messages.at(-1)).toMatchObject({ observed: "stopped" });
    } finally {
      await fixture.close();
    }
  });

  it("keeps a running watch alive across connectionLost and refreshes its sink on reconnect (AA11)", async () => {
    const fixture = await watchHarness('setInterval(() => console.log("tick"), 20);');
    try {
      await fixture.supervisor.reconcile(fixture.command(1), fixture.sink);
      await vi.waitFor(() => expect(fixture.runningReports()).toHaveLength(1));

      await fixture.supervisor.connectionLost(fixture.sink);

      // Watch keeps running across Home disconnect / restart without stopping or restarting.
      expect(fixture.supervisor.activeActivationIds()).toEqual([fixture.activationId]);
      expect(
        fixture.messages.some(
          (message) => message.type === "runner.watch-status" && message.observed === "stopped",
        ),
      ).toBe(false);

      const reconnectedMessages: RunnerOperationalReport[] = [];
      const reconnectedSink: RunnerMessageSink = {
        async send(message) {
          reconnectedMessages.push(message);
        },
      };
      await fixture.supervisor.reconcile(fixture.command(2), reconnectedSink);
      expect(fixture.supervisor.activeActivationIds()).toEqual([fixture.activationId]);
      expect(
        reconnectedMessages.some(
          (message) => message.type === "runner.watch-status" && message.observed === "running",
        ),
      ).toBe(true);
    } finally {
      await fixture.close();
    }
  });

  it("refuses to spawn a duplicate watch restart when containment between restarts is not proven (AA11)", async () => {
    let terminateCalls = 0;
    let runCount = 0;
    const fixture = await watchHarness(
      'console.log("started"); process.exit(1);',
      async () => {
        runCount += 1;
        await mkdir(fixtureWorkspace, { recursive: true });
        return { instructions: undefined, path: fixtureWorkspace };
      },
      async () => {
        terminateCalls += 1;
        return "unverifiable";
      },
    );
    const fixtureWorkspace = fixture.workspace;
    try {
      await fixture.supervisor.reconcile(fixture.command(1), fixture.sink);
      await vi.waitFor(() => {
        expect(
          fixture.messages.some(
            (message) => message.type === "runner.watch-status" && message.observed === "halted",
          ),
        ).toBe(true);
      });
      await fixture.supervisor.reconcile(fixture.command(1), fixture.sink);
      expect(terminateCalls).toBe(1);
      expect(runCount).toBe(1);
    } finally {
      // Allow close() to terminate cleanly.
      await fixture.close().catch(() => undefined);
    }
  });

  it("never writes capabilities.json to disk or sets OPENSTEER_CAPABILITIES_PATH (AA11)", async () => {
    const fixture = await watchHarness(
      'console.log("capEnv:" + String(process.env.OPENSTEER_CAPABILITIES_PATH ?? "unset")); setInterval(() => {}, 1000);',
    );
    try {
      await fixture.supervisor.reconcile(fixture.command(1), fixture.sink);
      let gen = 2;
      await vi.waitFor(async () => {
        await fixture.supervisor.reconcile(fixture.command(gen++), fixture.sink);
        expect(
          fixture.messages.findLast(
            (message) => message.type === "runner.watch-status" && message.observed === "running",
          ),
        ).toMatchObject({ stdoutTail: expect.stringContaining("capEnv:unset") });
      });
    } finally {
      await fixture.close();
    }
  });

  it("answers never seen for a stamped Watch whose reconcile did not arrive", async () => {
    const fixture = await watchHarness("setInterval(() => {}, 1000);");
    try {
      await expect(
        fixture.supervisor.stopAttempt(fixture.activationId, 1, fixture.sink),
      ).resolves.toBe("never-seen");
      await fixture.supervisor.reconcile(fixture.command(1), fixture.sink);
      expect(fixture.supervisor.activeActivationIds()).toEqual([]);
      await expect(
        fixture.supervisor.stopAttempt(fixture.activationId, 1, fixture.sink),
      ).resolves.toBe("never-seen");
    } finally {
      await fixture.close();
    }
  });

  it("grows restart backoff monotonically without downward jitter (AA11)", () => {
    const samples = [1, 2, 3, 4, 5, 10, 20].map((count) => watchRestartBackoffMs(count));
    expect(samples).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 300_000, 300_000]);
    for (let i = 1; i < samples.length; i += 1) {
      expect(samples[i]!).toBeGreaterThanOrEqual(samples[i - 1]!);
    }
  });

  it.each([
    ["exits cleanly", "process.exit(0);"],
    ["throws", 'throw new Error("watch failed");'],
  ])("restarts a watch that %s and counts restarts", async (_name, source) => {
    const fixture = await watchHarness(source, undefined, undefined, {}, (count) =>
      Math.min(50, 5 * 2 ** (count - 1)),
    );
    try {
      await fixture.supervisor.reconcile(fixture.command(1), fixture.sink);
      await vi.waitFor(
        () => {
          expect(
            fixture.messages.some(
              (message) =>
                message.type === "runner.watch-status" &&
                message.observed === "backoff" &&
                message.restartCount >= WATCH_CRASH_NOTICE_THRESHOLD,
            ),
          ).toBe(true);
        },
        { timeout: 5_000 },
      );
    } finally {
      await fixture.close();
    }
  });

  it("waits for a missing Agent home without counting it as a crash", async () => {
    const fixture = await watchHarness("setInterval(() => {}, 1000);", async () => {
      throw new Error("Agent home /missing is missing");
    });
    try {
      await fixture.supervisor.reconcile(fixture.command(1), fixture.sink);
      await vi.waitFor(
        () =>
          expect(
            fixture.messages.findLast((message) => message.type === "runner.watch-status"),
          ).toMatchObject({
            observed: "backoff",
            restartCount: 0,
            lastError: expect.stringContaining("Agent home /missing is missing"),
          }),
        { timeout: 5_000 },
      );
    } finally {
      await fixture.close();
    }
  });

  it("runs with cwd set to Agent home and can read files there", async () => {
    const fixture = await watchHarness(`
      import { readFileSync } from "node:fs";
      console.log(readFileSync("watch-marker.txt", "utf8").trim());
      setInterval(() => {}, 1_000);
    `);
    await writeFile(join(fixture.workspace, "watch-marker.txt"), "from-agent-home\n");
    try {
      await fixture.supervisor.reconcile(fixture.command(1), fixture.sink);
      let reconcileGeneration = 2;
      await vi.waitFor(async () => {
        await fixture.supervisor.reconcile(fixture.command(reconcileGeneration++), fixture.sink);
        expect(
          fixture.messages.findLast(
            (message) => message.type === "runner.watch-status" && message.observed === "running",
          ),
        ).toMatchObject({ stdoutTail: expect.stringContaining("from-agent-home") });
      });
    } finally {
      await fixture.close();
    }
  });

  it("terminates orphaned processes between restarts when a watch process exits (Y5)", async () => {
    const terminated: string[] = [];
    const fixture = await watchHarness("process.exit(1);", undefined, async (activationId) => {
      terminated.push(activationId);
      return "proven";
    });
    try {
      await fixture.supervisor.reconcile(fixture.command(1), fixture.sink);
      await vi.waitFor(() => {
        expect(
          fixture.messages.some(
            (message) =>
              message.type === "runner.watch-status" &&
              message.observed === "backoff" &&
              message.restartCount >= 1,
          ),
        ).toBe(true);
      });
      // Containment must have run after the first crash, before the supervisor even stops.
      expect(terminated).toContain(fixture.activationId);
    } finally {
      await fixture.close();
    }
  });

  it("sets only OPENSTEER_EVENT and not OPENSTEER_EVENT_PATH in watch environment (AB7)", async () => {
    const fixture = await watchHarness(
      'console.log(JSON.stringify({ event: Boolean(process.env.OPENSTEER_EVENT), legacyPath: "OPENSTEER_EVENT_PATH" in process.env })); setInterval(() => {}, 1_000);',
    );
    try {
      await fixture.supervisor.reconcile(fixture.command(1), fixture.sink);
      let reconcileGeneration = 2;
      await vi.waitFor(async () => {
        await fixture.supervisor.reconcile(fixture.command(reconcileGeneration++), fixture.sink);
        expect(
          fixture.messages.findLast(
            (message) => message.type === "runner.watch-status" && message.observed === "running",
          ),
        ).toMatchObject({
          stdoutTail: expect.stringContaining('{"event":true,"legacyPath":false}'),
        });
      });
    } finally {
      await fixture.close();
    }
  });
});

async function watchHarness(
  text: string,
  prepare?: AgentHomeAccess["prepare"],
  terminate: import("./watch-supervisor.js").WatchSupervisorOptions["terminate"] = async () =>
    "proven",
  secrets: Readonly<Record<string, string>> = {},
  restartBackoffMs?: (restartCount: number) => number,
): Promise<{
  readonly activationId: ReturnType<typeof createId<"triggerWatchActivation">>;
  readonly cachePath: string;
  readonly close: () => Promise<void>;
  readonly command: (
    reconcileGeneration: number,
    executionGeneration?: number,
  ) => Extract<RunnerCommand, { readonly type: "watch.reconcile" }>;
  readonly messages: RunnerOperationalReport[];
  readonly runningReports: () => RunnerOperationalReport[];
  readonly sink: RunnerMessageSink;
  readonly supervisor: WatchSupervisor;
  readonly workspace: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "opensteer-watch-harness-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const script = { interpreter: null, text } as const;
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ script, secrets }));
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP test server");
  const environmentId = createId("environment");
  const activationId = createId("triggerWatchActivation");
  const anchorThreadId = createId("thread");
  const revisionId = createId("triggerRevision");
  const triggerId = createId("trigger");
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const baseUrl = `http://127.0.0.1:${address.port}/mcp`;
  const messages: RunnerOperationalReport[] = [];
  const sink: RunnerMessageSink = {
    async send(message) {
      messages.push(message);
    },
  };
  const agentHome: AgentHomeAccess = {
    prepare: prepare ?? (async () => ({ instructions: undefined, path: workspace })),
    folder: async ({ path }) => path,
  };
  const supervisor = new WatchSupervisor({
    environmentId,
    nodeExecutable: process.execPath,
    planLaunch: async () => (launch) => launch,
    privateStateDirectory: join(root, "private"),
    ...(restartBackoffMs ? { restartBackoffMs } : {}),
    terminate,
    transport: { mode: "development" },
    agentHome,
  });
  const command = (
    reconcileGeneration: number,
    executionGeneration = 1,
  ): Extract<RunnerCommand, { readonly type: "watch.reconcile" }> => ({
    commandId: createId("command"),
    correlationId: CorrelationIdSchema.parse(`watch-harness:${crypto.randomUUID()}`),
    desired: [
      {
        agentHome: { computerId: createId("runner"), path: workspace },
        activationId,
        anchorThreadId,
        capabilities: {
          browserCdp: null,
          mcp: { expiresAt, token: "control-token", url: baseUrl },
        },
        executionGeneration,
        revisionId,
        triggerId,
      },
    ],
    environmentId,
    reconcileGeneration,
    type: "watch.reconcile",
  });
  return {
    activationId,
    cachePath: join(root, "private", "watches", "script-cache-v1", `${revisionId}.json`),
    close: async () => {
      await supervisor.close();
      await new Promise<void>((resolvePromise, reject) =>
        server.close((error) => (error ? reject(error) : resolvePromise())),
      );
      await rm(root, { force: true, recursive: true });
    },
    command,
    messages,
    runningReports: () =>
      messages.filter(
        (message) => message.type === "runner.watch-status" && message.observed === "running",
      ),
    sink,
    supervisor,
    workspace,
  };
}
