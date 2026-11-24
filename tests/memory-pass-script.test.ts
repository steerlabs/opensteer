import type { HarnessProcessLaunch } from "../packages/harness/src/index.js";
import { createId } from "../packages/core/src/ids.js";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { memoryPassScript } from "../apps/host/src/agents/memory-pass-script.js";
import { startProgramEndpoints } from "../apps/runner/src/agent/program-endpoints.js";
import { AutomationScriptExecutor } from "../apps/runner/src/agent/script-executor.js";
import { scriptEventFromTriggerEvent } from "../apps/runner/src/runtime/runtime.js";

const temporaryDirectories: string[] = [];
const nativeFsHelperBinary = fileURLToPath(
  new URL(
    `../apps/runner/native-fs-helper/opensteer-native-fs${process.platform === "win32" ? ".exe" : ""}`,
    import.meta.url,
  ),
);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function makeStandInMcpServer() {
  const calls: { readonly name?: string; readonly arguments?: unknown }[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      if (request.method === "DELETE") {
        response.writeHead(204).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        id?: number;
        method: string;
        params?: { name?: string; arguments?: unknown };
      };
      response.setHeader("content-type", "application/json");
      response.setHeader("mcp-session-id", "memory-pass-test-session");
      if (body.method === "initialize") {
        response.end(
          JSON.stringify({
            id: body.id,
            jsonrpc: "2.0",
            result: {
              capabilities: { tools: {} },
              protocolVersion: "2025-11-25",
              serverInfo: { name: "stand-in", version: "1" },
            },
          }),
        );
        return;
      }
      if (body.method === "notifications/initialized") {
        response.writeHead(202).end();
        return;
      }
      if (body.method === "tools/call") {
        calls.push({
          arguments: body.params?.arguments,
          ...(body.params?.name ? { name: body.params.name } : {}),
        });
        response.end(
          JSON.stringify({
            id: body.id,
            jsonrpc: "2.0",
            result: {
              content: [{ text: JSON.stringify({ disposition: "queued" }), type: "text" }],
              structuredContent: { disposition: "queued" },
            },
          }),
        );
        return;
      }
      response.writeHead(404).end();
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  return {
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    url: `http://127.0.0.1:${address.port}/mcp`,
  };
}

describe("memoryPassScript real execution (AA1)", () => {
  it("runs both memory-light and memory-nightly through AutomationScriptExecutor and opensteer CLI to wake their anchor task", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "opensteer-memory-pass-"));
    const privateDirectory = await mkdtemp(join(tmpdir(), "opensteer-memory-priv-"));
    temporaryDirectories.push(workspacePath, privateDirectory);
    await mkdir(join(workspacePath, ".opensteer"), { mode: 0o700, recursive: true });
    const mcp = await makeStandInMcpServer();
    const endpoints = await startProgramEndpoints({
      capabilities: () => ({
        browserCdp: null,
        mcp: {
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          token: "host-tok",
          url: mcp.url,
        },
      }),
      transport: { mode: "development" },
    });
    const executor = new AutomationScriptExecutor({
      nativeFsHelperBinary,
      nodeExecutable: process.execPath,
      privateDirectory,
    });
    const planLaunch = async () => (launch: HarnessProcessLaunch) => launch;
    try {
      const lightTaskId = createId("thread");
      const lightTriggerId = createId("trigger");
      const lightOccurrenceId = createId("triggerOccurrence");
      const lightScheduledFor = "2026-11-23T04:00:00.000Z";
      const lightEvent = scriptEventFromTriggerEvent({
        event: {
          id: lightOccurrenceId,
          payload: null,
          receivedAt: "2026-11-23T04:00:01.000Z",
          source: { kind: "schedule", scheduledFor: lightScheduledFor },
          trigger: {
            anchorThreadId: lightTaskId,
            id: lightTriggerId,
            revisionId: createId("triggerRevision"),
          },
        },
        occurrenceId: lightOccurrenceId,
        triggerId: lightTriggerId,
      } as Parameters<typeof scriptEventFromTriggerEvent>[0]);
      expect(lightEvent.taskId).toBe(lightTaskId);
      const lightResult = await executor.execute({
        automationId: lightTriggerId,
        endpoints: endpoints.endpoints,
        event: lightEvent,
        firingId: lightOccurrenceId,
        planLaunch,
        script: memoryPassScript("memory-light"),
        signal: new AbortController().signal,
        workspace: { instructions: undefined, path: workspacePath },
      });
      expect(lightResult.status, lightResult.stderr).toBe("succeeded");
      expect(lightResult.exitCode).toBe(0);

      const nightlyTaskId = createId("thread");
      const nightlyTriggerId = createId("trigger");
      const nightlyOccurrenceId = createId("triggerOccurrence");
      const nightlyFiredAt = "2026-11-23T07:00:00.000Z";
      const nightlyEvent = scriptEventFromTriggerEvent({
        event: {
          id: nightlyOccurrenceId,
          payload: null,
          receivedAt: nightlyFiredAt,
          source: { kind: "manual" },
          trigger: {
            anchorThreadId: nightlyTaskId,
            id: nightlyTriggerId,
            revisionId: createId("triggerRevision"),
          },
        },
        occurrenceId: nightlyOccurrenceId,
        triggerId: nightlyTriggerId,
      } as Parameters<typeof scriptEventFromTriggerEvent>[0]);
      expect(nightlyEvent.taskId).toBe(nightlyTaskId);
      const nightlyResult = await executor.execute({
        automationId: nightlyTriggerId,
        endpoints: endpoints.endpoints,
        event: nightlyEvent,
        firingId: nightlyOccurrenceId,
        planLaunch,
        script: memoryPassScript("memory-nightly"),
        signal: new AbortController().signal,
        workspace: { instructions: undefined, path: workspacePath },
      });
      expect(nightlyResult.status, nightlyResult.stderr).toBe("succeeded");
      expect(nightlyResult.exitCode).toBe(0);

      expect(mcp.calls).toEqual([
        {
          arguments: {
            delivery: "queue",
            message: `Light pass due (${lightScheduledFor}). Load opensteer:memory and follow its light-pass reference.`,
            taskId: lightTaskId,
          },
          name: "opensteer_task_send",
        },
        {
          arguments: {
            delivery: "queue",
            message: `Nightly pass due (${nightlyFiredAt}). Load opensteer:memory and follow its nightly reference.`,
            taskId: nightlyTaskId,
          },
          name: "opensteer_task_send",
        },
      ]);
    } finally {
      await endpoints.close();
      await mcp.close();
    }
  });
});
