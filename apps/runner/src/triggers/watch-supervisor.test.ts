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
import { WATCH_AUTO_PAUSE_FAILURE_THRESHOLD } from "@opensteer/triggers";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunnerMessageSink } from "../runtime/runtime.js";
import type { WorkspaceAccessManager } from "../workspace/mount-manager.js";
import { WatchSupervisor } from "./watch-supervisor.js";

describe("WatchSupervisor", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it("starts past stale artifacts, renews and expires, and evicts dropped revision cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "opensteer-watch-test-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const program = {
      language: "javascript",
      // The program prints the token it holds and keeps calling its tools with
      // it; the Host side records what reached it.
      source:
        'export default async ({ opensteer }) => { console.log("holds:" + opensteer.capabilities().mcp.token); await new Promise(() => setInterval(() => { const { mcp } = opensteer.capabilities(); void fetch(mcp.url, { body: "{}", headers: { accept: "application/json, text/event-stream", authorization: "Bearer " + mcp.token, "content-type": "application/json" }, method: "POST" }).catch(() => undefined); }, 30)); }',
      toolContractVersion: 1,
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
      expect(request.url).toMatch(/^\/internal\/v1\/triggers\/revisions\/trv_/u);
      expect(request.headers.authorization).toBe("Bearer control-token");
      response.end(JSON.stringify(program));
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
    const workspaceManager: WorkspaceAccessManager = {
      async prepare() {
        await mkdir(workspace, { recursive: true });
        return { instructions: undefined, path: workspace };
      },
      writableRoots() {
        return [workspace];
      },
    };
    const environmentId = createId("environment");
    const activationId = createId("triggerWatchActivation");
    const anchorThreadId = createId("thread");
    const revisionId = createId("triggerRevision");
    const triggerId = createId("trigger");
    const workspaceId = createId("workspace");
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
      terminate: async () => undefined,
      transport: { mode: "development" },
      workspaceManager,
    });
    const command = (
      reconcileGeneration: number,
      desired: boolean,
      expiresAt: string,
      controlToken = "control-token",
    ): Extract<RunnerCommand, { readonly type: "watch.reconcile" }> => ({
      commandId: createId("command"),
      correlationId: CorrelationIdSchema.parse(`watch-test:${crypto.randomUUID()}`),
      desired: desired
        ? [
            {
              activationId,
              anchorThreadId,
              capabilities: {
                browserCdp: null,
                integrationMcp: { expiresAt, token: "integration-token", url: baseUrl },
                mcp: { expiresAt, token: controlToken, url: baseUrl },
              },
              executionGeneration: 1,
              revisionId,
              triggerId,
              workspaceAccess: {
                bindingId: createId("workspaceBinding"),
                generation: 1,
                kind: "local-directory",
                ownerEnvironmentId: environmentId,
                storageAuthorityId: createId("storageAuthority"),
                workspaceId,
              },
              workspaceId,
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
      const cachePath = join(root, "private", "watches", "program-cache-v2", `${revisionId}.json`);
      await expect(access(legacyCachePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(cachePath)).resolves.toBeUndefined();
      await expect(readFile(cachePath, "utf8")).resolves.toBe(JSON.stringify(program));

      // Expiry is tested only after the watch has proved it is running. A
      // short lease on the first reconcile can expire while a loaded machine
      // is still preparing the workspace and spawning Node.
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
        command(3, true, new Date(Date.now() + 60_000).toISOString(), "control-token-2"),
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
          ),
          sink,
        );
        // The renewed Host token reaches the Host behind the program's back.
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

  it("stops and drains a running watch when its Host connection is lost, then reconnects", async () => {
    const fixture = await watchHarness(
      'export default async () => { await new Promise(() => setInterval(() => console.log("tick"), 20)); }',
    );
    try {
      await fixture.supervisor.reconcile(fixture.command(1), fixture.sink);
      await vi.waitFor(() => expect(fixture.runningReports()).toHaveLength(1));

      await fixture.supervisor.connectionLost(fixture.sink);

      expect(fixture.supervisor.activeActivationIds()).toEqual([]);
      expect(fixture.messages.at(-1)).toMatchObject({
        activationId: fixture.activationId,
        observed: "stopped",
      });

      await fixture.supervisor.reconcile(fixture.command(2), fixture.sink);
      await vi.waitFor(() => expect(fixture.runningReports()).toHaveLength(2));
      expect(fixture.supervisor.activeActivationIds()).toEqual([fixture.activationId]);
    } finally {
      await fixture.close();
    }
  });

  it.each([
    ["resolves", "export default async () => undefined"],
    ["throws", 'export default async () => { throw new Error("watch failed"); }'],
  ])("restarts a watch that %s until it reaches the pause threshold", async (_name, source) => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const fixture = await watchHarness(source);
    try {
      await fixture.supervisor.reconcile(fixture.command(1), fixture.sink);
      await vi.waitFor(
        () => {
          expect(
            fixture.messages.some(
              (message) =>
                message.type === "runner.watch-status" &&
                message.observed === "backoff" &&
                message.restartCount >= WATCH_AUTO_PAUSE_FAILURE_THRESHOLD,
            ),
          ).toBe(true);
        },
        { timeout: 5_000 },
      );
    } finally {
      random.mockRestore();
      await fixture.close();
    }
  });

  it("resolves relative modules and packages from the Workspace", async () => {
    const fixture = await watchHarness(`
      import { helper } from "./helper.js";
      import packageValue from "watch-fixture-package";
      export default async () => {
        console.log(helper + ":" + packageValue);
        await new Promise(() => setInterval(() => {}, 1_000));
      }
    `);
    await mkdir(join(fixture.workspace, "node_modules", "watch-fixture-package"), {
      recursive: true,
    });
    await Promise.all([
      writeFile(join(fixture.workspace, "helper.js"), 'export const helper = "relative";\n'),
      writeFile(
        join(fixture.workspace, "node_modules", "watch-fixture-package", "package.json"),
        JSON.stringify({ exports: "./index.js", name: "watch-fixture-package", type: "module" }),
      ),
      writeFile(
        join(fixture.workspace, "node_modules", "watch-fixture-package", "index.js"),
        'export default "package";\n',
      ),
    ]);
    try {
      await fixture.supervisor.reconcile(fixture.command(1), fixture.sink);
      let reconcileGeneration = 2;
      await vi.waitFor(async () => {
        await fixture.supervisor.reconcile(fixture.command(reconcileGeneration++), fixture.sink);
        expect(
          fixture.messages.findLast(
            (message) => message.type === "runner.watch-status" && message.observed === "running",
          ),
        ).toMatchObject({ stdoutTail: expect.stringContaining("relative:package") });
      });
    } finally {
      await fixture.close();
    }
  });
});

async function watchHarness(source: string): Promise<{
  readonly activationId: ReturnType<typeof createId<"triggerWatchActivation">>;
  readonly close: () => Promise<void>;
  readonly command: (
    reconcileGeneration: number,
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
  const program = { language: "javascript", source, toolContractVersion: 1 } as const;
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(program));
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP test server");
  const environmentId = createId("environment");
  const activationId = createId("triggerWatchActivation");
  const anchorThreadId = createId("thread");
  const revisionId = createId("triggerRevision");
  const triggerId = createId("trigger");
  const workspaceId = createId("workspace");
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const baseUrl = `http://127.0.0.1:${address.port}/mcp`;
  const messages: RunnerOperationalReport[] = [];
  const sink: RunnerMessageSink = {
    async send(message) {
      messages.push(message);
    },
  };
  const workspaceManager: WorkspaceAccessManager = {
    async prepare() {
      return { instructions: undefined, path: workspace };
    },
    writableRoots() {
      return [workspace];
    },
  };
  const supervisor = new WatchSupervisor({
    environmentId,
    nodeExecutable: process.execPath,
    planLaunch: async () => (launch) => launch,
    privateStateDirectory: join(root, "private"),
    terminate: async () => undefined,
    transport: { mode: "development" },
    workspaceManager,
  });
  const command = (
    reconcileGeneration: number,
  ): Extract<RunnerCommand, { readonly type: "watch.reconcile" }> => ({
    commandId: createId("command"),
    correlationId: CorrelationIdSchema.parse(`watch-harness:${crypto.randomUUID()}`),
    desired: [
      {
        activationId,
        anchorThreadId,
        capabilities: {
          browserCdp: null,
          integrationMcp: { expiresAt, token: "integration-token", url: baseUrl },
          mcp: { expiresAt, token: "control-token", url: baseUrl },
        },
        executionGeneration: 1,
        revisionId,
        triggerId,
        workspaceAccess: {
          bindingId: createId("workspaceBinding"),
          generation: 1,
          kind: "local-directory",
          ownerEnvironmentId: environmentId,
          storageAuthorityId: createId("storageAuthority"),
          workspaceId,
        },
        workspaceId,
      },
    ],
    environmentId,
    reconcileGeneration,
    type: "watch.reconcile",
  });
  return {
    activationId,
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
