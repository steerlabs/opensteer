import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createId } from "@opensteer/core";
import { TriggerExecutionContextSchema } from "@opensteer/protocol";
import { MANAGED_MEMORY_WAKE_SKIPPED } from "@opensteer/triggers";
import { expect, it } from "vitest";
import { TriggerProgramExecutor } from "@opensteer/runner";
import { memoryPassProgram } from "./memory-pass-program.js";
it.each(["memory-light", "memory-nightly"] as const)(
  "queues %s directly through MCP, treats only the exact managed refusal as success",
  async (role) => {
    const calls: unknown[] = [];
    let errorText: string | null = null;
    const server = createServer((request, response) => {
      void (async () => {
        if (request.method === "DELETE") {
          response.writeHead(204).end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const message = JSON.parse(Buffer.concat(chunks).toString()) as {
          id?: number;
          method: string;
          params?: unknown;
        };
        response.setHeader("content-type", "application/json");
        response.setHeader("mcp-session-id", "memory-program-test");
        if (message.method === "notifications/initialized") {
          response.writeHead(202).end();
          return;
        }
        if (message.method === "tools/call") calls.push(message.params);
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result:
              message.method === "initialize"
                ? {
                    capabilities: {
                      tools: {},
                    },
                    protocolVersion: "2025-11-25",
                    serverInfo: {
                      name: "memory-test",
                      version: "1",
                    },
                  }
                : {
                    content: [
                      {
                        type: "text",
                        text: errorText ?? "{}",
                      },
                    ],
                    ...(errorText
                      ? {
                          isError: true,
                        }
                      : {
                          structuredContent: {},
                        }),
                  },
          }),
        );
      })().catch((error: unknown) =>
        response.destroy(error instanceof Error ? error : new Error("MCP fixture failed")),
      );
    });
    const directory = await mkdtemp(join(tmpdir(), "memory-program-"));
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("MCP fixture failed to bind");
      const endpoint = {
        token: "test",
        url: `http://127.0.0.1:${address.port}/mcp`,
      };
      const threadId = createId("thread");
      const triggerId = createId("trigger");
      const revisionId = createId("triggerRevision");
      for (const refusal of [
        null,
        MANAGED_MEMORY_WAKE_SKIPPED,
        "Only the execution owner can send input to this Thread",
        `${MANAGED_MEMORY_WAKE_SKIPPED} extra`,
      ]) {
        errorText = refusal;
        const occurrenceId = createId("triggerOccurrence");
        const context = TriggerExecutionContextSchema.parse({
          anchorThreadId: threadId,
          browserCdp: null,
          event: {
            id: occurrenceId,
            receivedAt: "2026-11-03T09:30:00Z",
            source: {
              kind: "schedule",
              scheduledFor: "2026-11-03T09:30:00Z",
            },
            payload: null,
            trigger: {
              anchorThreadId: threadId,
              id: triggerId,
              revisionId,
            },
          },
          executionGeneration: 1,
          mcp: endpoint,
          occurrenceId,
          program: memoryPassProgram(role),
          revisionId,
          triggerId,
        });
        const output = await new TriggerProgramExecutor({
          nodeExecutable: process.execPath,
          privateDirectory: join(directory, "private"),
        }).execute({
          context,
          endpoints: {
            mcp: endpoint,
          },
          planLaunch: async () => (launch) => launch,
          signal: AbortSignal.timeout(5_000),
          workspace: {
            instructions: undefined,
            path: directory,
          },
        });
        expect(output.status).toBe(
          refusal === null || refusal === MANAGED_MEMORY_WAKE_SKIPPED ? "succeeded" : "failed",
        );
      }
      expect(calls).toHaveLength(4);
      expect(calls[0]).toEqual({
        name: "thread_send",
        arguments: {
          delivery: "queue",
          threadId,
          message: `${role === "memory-light" ? "Light" : "Nightly"} pass due (2026-11-03T09:30:00Z). Load opensteer:memory and follow its ${role === "memory-light" ? "light-pass" : "nightly"} reference.`,
        },
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, {
        recursive: true,
        force: true,
      });
    }
  },
);
