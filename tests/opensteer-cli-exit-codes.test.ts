import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { OperationOutcomeUnknown } from "../apps/host/src/agent-sessions/agent-session-service.js";
import { agentToolFailure } from "../apps/host/src/mcp/agent-tool-failure.js";
import { PluginServiceError } from "../apps/host/src/plugins/plugin-service.js";
import { AutomationScriptExecutor } from "../apps/runner/src/agent/script-executor.js";
import { agentToolFailureResult } from "../packages/agent-tools/src/results.js";
import { OpensteerError } from "../packages/core/src/errors.js";
import { createId } from "../packages/core/src/ids.js";

const execFileAsync = promisify(execFile);
const cliScriptPath = fileURLToPath(
  new URL("../apps/runner/cli/opensteer-cli.mjs", import.meta.url),
);
const nativeFsHelperBinary = fileURLToPath(
  new URL(
    `../apps/runner/native-fs-helper/opensteer-native-fs${process.platform === "win32" ? ".exe" : ""}`,
    import.meta.url,
  ),
);

async function runCliWithFailure(
  toolFailure: ReturnType<typeof agentToolFailureResult>,
): Promise<{ readonly exitCode: number; readonly stderr: string }> {
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
      };
      response.setHeader("content-type", "application/json");
      response.setHeader("mcp-session-id", "aa4-session");
      if (body.method === "initialize") {
        response.end(
          JSON.stringify({
            id: body.id,
            jsonrpc: "2.0",
            result: {
              capabilities: { tools: {} },
              protocolVersion: "2025-11-25",
              serverInfo: { name: "real-failure-host", version: "1" },
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
        response.end(JSON.stringify({ id: body.id, jsonrpc: "2.0", result: toolFailure }));
        return;
      }
      response.writeHead(404).end();
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  try {
    await execFileAsync(process.execPath, [cliScriptPath, "tool", "plugin_execute", "{}"], {
      env: {
        ...process.env,
        OPENSTEER_MCP_TOKEN: "tok",
        OPENSTEER_MCP_URL: `http://127.0.0.1:${address.port}/mcp`,
      },
    });
    return { exitCode: 0, stderr: "" };
  } catch (error) {
    const err = error as { code?: number; stderr?: string };
    return { exitCode: typeof err.code === "number" ? err.code : -1, stderr: err.stderr ?? "" };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("opensteer CLI exit codes against real Home failure payloads (AA4)", () => {
  it("exits 2 only for codes proving no effect, and exits 3 for plugin_unavailable, conflict, internal, and outcome_unknown", async () => {
    const zodFailure = (() => {
      try {
        z.object({ x: z.number() }).parse({});
        throw new Error("unreachable");
      } catch (error) {
        return agentToolFailureResult(agentToolFailure(error, "write"));
      }
    })();

    const provablyNoEffect = [
      agentToolFailureResult(
        agentToolFailure(new OpensteerError({ code: "forbidden", message: "Denied" }), "write"),
      ),
      agentToolFailureResult(
        agentToolFailure(new OpensteerError({ code: "not_found", message: "Missing" }), "write"),
      ),
      agentToolFailureResult(
        agentToolFailure(new OpensteerError({ code: "unauthorized", message: "No auth" }), "write"),
      ),
      zodFailure,
    ];
    for (const payload of provablyNoEffect) {
      const outcome = await runCliWithFailure(payload);
      expect(outcome.exitCode, outcome.stderr).toBe(2);
    }

    const uncertainOrPartial = [
      agentToolFailureResult(
        agentToolFailure(new OperationOutcomeUnknown("Lost contact mid-call"), "write"),
      ),
      agentToolFailureResult(
        agentToolFailure(new PluginServiceError("tool", "Half-done"), "write"),
      ),
      agentToolFailureResult(
        agentToolFailure(
          new OpensteerError({ code: "conflict", message: "Mid-write conflict" }),
          "write",
        ),
      ),
      agentToolFailureResult(agentToolFailure(new Error("Unexpected crash"), "write")),
    ];
    for (const payload of uncertainOrPartial) {
      const outcome = await runCliWithFailure(payload);
      expect(outcome.exitCode, outcome.stderr).toBe(3);
    }
  });

  it("maps script exit code 3 from a real set -e script to unknown and exit 2 to failed (AB2)", async () => {
    const runViaExecutor = async (toolFailure: ReturnType<typeof agentToolFailureResult>) => {
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
          };
          response.setHeader("content-type", "application/json");
          response.setHeader("mcp-session-id", "ab2-session");
          if (body.method === "initialize") {
            response.end(
              JSON.stringify({
                id: body.id,
                jsonrpc: "2.0",
                result: {
                  capabilities: { tools: {} },
                  protocolVersion: "2025-11-25",
                  serverInfo: { name: "ab2-host", version: "1" },
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
            response.end(JSON.stringify({ id: body.id, jsonrpc: "2.0", result: toolFailure }));
            return;
          }
          response.writeHead(404).end();
        })();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP address");
      const root = await mkdtemp(join(tmpdir(), "opensteer-ab2-"));
      try {
        const executor = new AutomationScriptExecutor({
          nativeFsHelperBinary,
          nodeExecutable: process.execPath,
          privateDirectory: join(root, "private"),
        });
        const automationId = createId("trigger");
        const firingId = createId("triggerOccurrence");
        const taskId = createId("thread");
        return await executor.execute({
          automationId,
          endpoints: {
            browserCdp: null,
            mcp: { token: "tok", url: `http://127.0.0.1:${address.port}/mcp` },
          },
          event: {
            automationId,
            firedAt: new Date().toISOString(),
            firingId,
            kind: "schedule",
            scheduledFor: new Date().toISOString(),
            taskId,
          },
          firingId,
          planLaunch: async () => (launch) => launch,
          script: {
            interpreter: ["bash"],
            text: "set -e\nopensteer tool plugin_execute '{}'\n",
          },
          signal: new AbortController().signal,
          workspace: {
            agentHome: { configuredPath: null, mode: "default", resolvedPath: root },
            path: root,
            release: async () => undefined,
          },
        });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { force: true, recursive: true });
      }
    };

    const unknownResult = await runViaExecutor(
      agentToolFailureResult(
        agentToolFailure(new OperationOutcomeUnknown("Lost contact mid-call"), "write"),
      ),
    );
    expect(unknownResult.exitCode).toBe(3);
    expect(unknownResult.status).toBe("unknown");

    const refusedResult = await runViaExecutor(
      agentToolFailureResult(
        agentToolFailure(new OpensteerError({ code: "forbidden", message: "Denied" }), "write"),
      ),
    );
    expect(refusedResult.exitCode).toBe(2);
    expect(refusedResult.status).toBe("failed");
  });
});
