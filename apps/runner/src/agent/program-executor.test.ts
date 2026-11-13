import type { HarnessProcessLaunch } from "@opensteer/harness";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createId } from "@opensteer/core";
import { TriggerExecutionContextSchema } from "@opensteer/protocol";
import { TriggerExecutionOutputSchema } from "@opensteer/triggers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startProgramEndpoints } from "./program-endpoints.js";
import { TriggerProgramExecutor } from "./program-executor.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("TriggerProgramExecutor", () => {
  it("runs ordinary TypeScript with event data, fetch, and the standard MCP transport", async () => {
    const requests: Array<{ readonly method: string; readonly name?: string }> = [];
    const toolRequests: { url: string | undefined; authorization: string | undefined }[] = [];
    const handleRequest = async (
      request: IncomingMessage,
      response: ServerResponse,
    ): Promise<void> => {
      if (request.method === "GET" && request.url === "/data") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ available: true }));
        return;
      }
      toolRequests.push({ url: request.url, authorization: request.headers.authorization });
      if (request.method === "DELETE") {
        requests.push({ method: "DELETE" });
        response.writeHead(204).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        id?: number;
        method: string;
        params?: { name?: string };
      };
      requests.push({
        method: message.method,
        ...(message.params?.name ? { name: message.params.name } : {}),
      });
      response.setHeader("content-type", "application/json");
      response.setHeader("mcp-session-id", "test-session");
      if (message.method === "initialize") {
        response.end(
          JSON.stringify({
            id: message.id,
            jsonrpc: "2.0",
            result: {
              capabilities: { tools: {} },
              protocolVersion: "2025-11-25",
              serverInfo: { name: "test", version: "1" },
            },
          }),
        );
        return;
      }
      if (message.method === "notifications/initialized") {
        response.writeHead(202).end();
        return;
      }
      response.end(
        JSON.stringify({
          id: message.id,
          jsonrpc: "2.0",
          result: {
            content: [{ text: "ok", type: "text" }],
            structuredContent: { delivered: true },
          },
        }),
      );
    };
    const server = createServer((request, response) => {
      void handleRequest(request, response).catch((error: unknown) =>
        response.destroy(error instanceof Error ? error : new Error("Program test server failed")),
      );
    });
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    const workspace = await temporaryWorkspace();
    const context = triggerContext({
      mcpUrl: `http://127.0.0.1:${address.port}/mcp`,
      source: `
        import { existsSync } from "node:fs";
        interface PriceEvent { id: string; payload: { price: number } }
        export default async function ({ capabilities, event, opensteer }: {
          capabilities: Record<string, unknown>;
          event: PriceEvent;
          opensteer: {
            callTool(name: string, input: unknown): Promise<unknown>;
          };
        }) {
          console.log("price", event.payload.price);
          const response = await fetch(${JSON.stringify(`http://127.0.0.1:${address.port}/data`)});
          if (!response.ok) throw new Error("fetch failed");
          const delivered = await opensteer.callTool("thread_send", { message: "done" });
          const integrationDelivered = await opensteer.callTool(
            "integration_tool",
            { value: 42 },
          );
          return {
            credentialsFile: existsSync(
              ".opensteer/private/" + event.id + "/credentials.json",
            ),
            credentialsEnv: process.env.OPENSTEER_CREDENTIALS_PATH ?? null,
            delivered,
            hasCredentials: Object.hasOwn(capabilities, "credentials"),
            integrationDelivered,
            price: event.payload.price,
          };
        }
      `,
    });
    expect(() =>
      TriggerExecutionContextSchema.parse({
        ...context,
        credentials: { EXAMPLE_TOKEN: "plaintext-must-not-cross-wire" },
      }),
    ).toThrow();
    const endpoints = await startProgramEndpoints({
      capabilities: () => context,
      transport: { mode: "development" },
    });
    try {
      const output = await new TriggerProgramExecutor({
        nodeExecutable: process.execPath,
        privateDirectory: join(workspace.path, ".opensteer", "private"),
      }).execute({
        context,
        ...direct(context),
        endpoints: endpoints.endpoints,
        signal: new AbortController().signal,
        workspace,
      });

      expect(output).toMatchObject({
        error: null,
        occurrenceId: context.occurrenceId,
        result: {
          credentialsEnv: null,
          credentialsFile: false,
          delivered: { delivered: true },
          hasCredentials: false,
          integrationDelivered: { delivered: true },
          price: 42,
        },
        status: "succeeded",
        stdout: "price 42\n",
      });
      expect(requests.filter(({ method }) => method === "tools/call")).toEqual([
        { method: "tools/call", name: "thread_send" },
        { method: "tools/call", name: "integration_tool" },
      ]);
      expect(requests.filter(({ method }) => method === "DELETE")).toHaveLength(2);
      expect(toolRequests.length).toBeGreaterThan(0);
      expect(
        toolRequests.every(
          ({ url, authorization }) =>
            url === "/mcp" && authorization === `Bearer ${context.mcp.token}`,
        ),
      ).toBe(true);
      await expect(
        stat(join(workspace.path, ".opensteer", ".trigger-executions", context.occurrenceId)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await endpoints.close();
      await new Promise<void>((resolvePromise, reject) =>
        server.close((error) => (error ? reject(error) : resolvePromise())),
      );
    }
  });

  it("returns a normalized failure without confusing program output with its control result", async () => {
    const workspace = await temporaryWorkspace();
    const context = triggerContext({
      source: `export default async function () {
        console.log(JSON.stringify({ ok: true, value: "fake" }));
        throw new Error("expected failure");
      }`,
    });

    const output = await new TriggerProgramExecutor({ nodeExecutable: process.execPath }).execute({
      context,
      ...direct(context),
      signal: new AbortController().signal,
      workspace,
    });

    expect(output.status).toBe("failed");
    expect(output.error).toContain("expected failure");
    expect(output.stdout).toContain('"value":"fake"');
    expect(output.result).toBeNull();
  });

  it.each([
    {
      name: "undefined as null",
      source: "export default function () {}",
      expected: { error: null, result: null, status: "succeeded" },
    },
    {
      name: "an exit before returning as no result",
      source: "export default function () { process.exit(0); }",
      expected: { error: "Trigger program returned no execution result", status: "failed" },
    },
    {
      name: "a deleted result file as no result",
      source: `import { rmSync } from "node:fs";
        export default function () { rmSync(process.env.OPENSTEER_RESULT_PATH); process.exit(0); }`,
      expected: { error: "Trigger program returned no execution result", status: "failed" },
    },
    {
      name: "a malformed result as invalid",
      source: `import { writeFileSync } from "node:fs";
        export default function () {
          writeFileSync(process.env.OPENSTEER_RESULT_PATH, "{not json");
          process.exit(0);
        }`,
      expected: { error: "Trigger program returned an invalid execution result", status: "failed" },
    },
    {
      name: "a result over 512 KiB as invalid",
      source: `export default function () { return "x".repeat(600 * 1024); }`,
      expected: { error: "Trigger program returned an invalid execution result", status: "failed" },
    },
    {
      name: "a result file replaced by a link as invalid",
      source: `import { rmSync, symlinkSync, writeFileSync } from "node:fs";
        export default function () {
          const forged = process.env.OPENSTEER_RESULT_PATH + ".forged";
          writeFileSync(forged, JSON.stringify({ ok: true, value: "forged" }));
          rmSync(process.env.OPENSTEER_RESULT_PATH);
          symlinkSync(forged, process.env.OPENSTEER_RESULT_PATH);
          process.exit(0);
        }`,
      expected: { error: "Trigger program returned an invalid execution result", status: "failed" },
    },
  ])("reads $name from the private result file", async ({ expected, source }) => {
    const workspace = await temporaryWorkspace();
    const privateDirectory = join(workspace.path, ".opensteer", "private");
    const context = triggerContext({ source });

    const output = await new TriggerProgramExecutor({
      nodeExecutable: process.execPath,
      privateDirectory,
    }).execute({ context, ...direct(context), signal: new AbortController().signal, workspace });

    expect(output).toMatchObject({ ...expected, result: expected.result ?? null });
    expect(TriggerExecutionOutputSchema.safeParse(output).success).toBe(true);
    await expect(stat(join(privateDirectory, context.occurrenceId))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("cancels a running program with everything it started, keeping its output", async () => {
    const workspace = await temporaryWorkspace();
    const childPidFile = join(workspace.path, "child.pid");
    const context = triggerContext({
      source: `import { spawn } from "node:child_process";
        import { writeFileSync } from "node:fs";
        export default async function () {
          const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
          console.log("started");
          writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));
          await new Promise(() => {});
        }`,
    });
    const abort = new AbortController();

    const running = new TriggerProgramExecutor({ nodeExecutable: process.execPath }).execute({
      context,
      ...direct(context),
      signal: abort.signal,
      workspace,
    });
    const childPid = await vi.waitFor(
      async () => {
        const pid = Number(await readFile(childPidFile, "utf8"));
        if (!(pid > 0)) throw new Error("The program never reported its child");
        return pid;
      },
      { interval: 25, timeout: 5_000 },
    );
    abort.abort();
    const output = await running;

    expect(output).toMatchObject({
      error: "Trigger program was canceled",
      result: null,
      status: "canceled",
      stdout: "started\n",
    });
    expect(() => process.kill(childPid, 0)).toThrow();
  });

  it("passes the Runner's additive CA bundle to the isolated trigger process", async () => {
    const workspace = await temporaryWorkspace();
    const certificatePath = join(workspace.path, "control-ca.pem");
    const previous = process.env.NODE_EXTRA_CA_CERTS;
    process.env.NODE_EXTRA_CA_CERTS = certificatePath;
    const context = triggerContext({
      source: `export default function () {
        return { extraCaPath: process.env.NODE_EXTRA_CA_CERTS };
      }`,
    });

    try {
      const output = await new TriggerProgramExecutor({ nodeExecutable: process.execPath }).execute(
        {
          context,
          ...direct(context),
          signal: new AbortController().signal,
          workspace,
        },
      );

      expect(output).toMatchObject({
        result: { extraCaPath: certificatePath },
        status: "succeeded",
      });
    } finally {
      if (previous === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
      else process.env.NODE_EXTRA_CA_CERTS = previous;
    }
  });

  it("resolves relative imports from the mounted Workspace root and removes its entry file", async () => {
    const workspace = await temporaryWorkspace();
    await writeFile(
      join(workspace.path, "trigger-helper.mjs"),
      "export const double = (value) => value * 2;\n",
    );
    const context = triggerContext({
      source: `
        import { double } from "./trigger-helper.mjs";
        export default async function ({ event }) {
          return { doubled: double(event.payload.price) };
        }
      `,
    });

    const output = await new TriggerProgramExecutor({ nodeExecutable: process.execPath }).execute({
      context,
      ...direct(context),
      signal: new AbortController().signal,
      workspace,
    });

    expect(output).toMatchObject({ result: { doubled: 84 }, status: "succeeded" });
    await expect(
      stat(join(workspace.path, `.opensteer-trigger-${context.occurrenceId}.ts`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps truncated output within the protocol bound", async () => {
    const workspace = await temporaryWorkspace();
    const context = triggerContext({
      source: `export default async function () {
        const line = "x".repeat(1023) + "\\n";
        for (let index = 0; index < 700; index += 1) process.stdout.write(line);
        return { wrote: 700 * 1024 };
      }`,
    });

    const output = await new TriggerProgramExecutor({ nodeExecutable: process.execPath }).execute({
      context,
      ...direct(context),
      signal: new AbortController().signal,
      workspace,
    });

    expect(output.status).toBe("succeeded");
    expect(output.stdout.startsWith("\n[Opensteer truncated earlier process output]\n")).toBe(true);
    expect(Buffer.byteLength(output.stdout, "utf8")).toBeLessThanOrEqual(512 * 1_024);
    expect(TriggerExecutionOutputSchema.safeParse(output).success).toBe(true);
  });

  it("runs TypeScript in the Workspace root with Node filesystem APIs", async () => {
    const workspace = await temporaryWorkspace();
    const context = triggerContext({
      source: `
        import { appendFile } from "node:fs/promises";
        export default async function () {
          await appendFile("relative-output.txt", "written from trigger\\n");
          return { cwd: process.cwd() };
        }
      `,
    });

    const output = await new TriggerProgramExecutor({ nodeExecutable: process.execPath }).execute({
      context,
      ...direct(context),
      signal: new AbortController().signal,
      workspace,
    });

    expect(output).toMatchObject({ result: { cwd: workspace.path }, status: "succeeded" });
    await expect(readFile(join(workspace.path, "relative-output.txt"), "utf8")).resolves.toBe(
      "written from trigger\n",
    );
  });

  it("enables Node's TypeScript transform for enums", async () => {
    const workspace = await temporaryWorkspace();
    const context = triggerContext({
      source: `
        enum Delivery { Ready = "ready" }
        export default function () { return { delivery: Delivery.Ready }; }
      `,
    });

    const output = await new TriggerProgramExecutor({ nodeExecutable: process.execPath }).execute({
      context,
      ...direct(context),
      signal: new AbortController().signal,
      workspace,
    });

    expect(output).toMatchObject({ result: { delivery: "ready" }, status: "succeeded" });
  });

  it("does not pass Electron process variables to the child", async () => {
    const workspace = await temporaryWorkspace();
    const previous = {
      ELECTRON_ENABLE_LOGGING: process.env.ELECTRON_ENABLE_LOGGING,
      ELECTRON_NO_ATTACH_CONSOLE: process.env.ELECTRON_NO_ATTACH_CONSOLE,
      ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE,
    };
    Object.assign(process.env, {
      ELECTRON_ENABLE_LOGGING: "1",
      ELECTRON_NO_ATTACH_CONSOLE: "1",
      ELECTRON_RUN_AS_NODE: "1",
    });
    const context = triggerContext({
      source: `export default function () {
        return {
          enableLogging: process.env.ELECTRON_ENABLE_LOGGING ?? null,
          noAttachConsole: process.env.ELECTRON_NO_ATTACH_CONSOLE ?? null,
          runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
        };
      }`,
    });

    try {
      const output = await new TriggerProgramExecutor({
        nodeExecutable: process.execPath,
      }).execute({
        context,
        ...direct(context),
        signal: new AbortController().signal,
        workspace,
      });
      expect(output).toMatchObject({
        result: { enableLogging: null, noAttachConsole: null, runAsNode: null },
        status: "succeeded",
      });
    } finally {
      restoreEnvironment(previous);
    }
  });

  it("spawns the configured Node executable", async () => {
    const workspace = await temporaryWorkspace();
    const invocationPath = join(workspace.path, "node-invocation.json");
    const wrapper = join(workspace.path, "node-wrapper");
    await writeFile(
      wrapper,
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(invocationPath)}\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
      { mode: 0o700 },
    );
    await chmod(wrapper, 0o700);
    const context = triggerContext({
      source: `export default function () { return { usedWrapper: true }; }`,
    });

    const output = await new TriggerProgramExecutor({ nodeExecutable: wrapper }).execute({
      context,
      ...direct(context),
      signal: new AbortController().signal,
      workspace,
    });

    expect(output).toMatchObject({ result: { usedWrapper: true }, status: "succeeded" });
    const invocation = (await readFile(invocationPath, "utf8")).trim().split("\n");
    expect(invocation).toContain("--experimental-transform-types");
    expect(invocation.at(-1)).toMatch(/runtime\.mjs$/u);
  });
});

/** The context's own endpoints, launched as they are: what the executor does with them. */
function direct(context: ReturnType<typeof triggerContext>) {
  return {
    endpoints: {
      ...(context.browserCdp ? { browserCdp: context.browserCdp } : {}),
      mcp: context.mcp,
    },
    planLaunch: async () => (launch: HarnessProcessLaunch) => launch,
  };
}

function restoreEnvironment(values: Readonly<Record<string, string | undefined>>): void {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

async function temporaryWorkspace() {
  const temporaryPath = await mkdtemp(join(tmpdir(), "opensteer-trigger-program-test-"));
  temporaryDirectories.push(temporaryPath);
  const path = await realpath(temporaryPath);
  await mkdir(join(path, ".opensteer"), { recursive: true });
  return { agentHomePath: path, instructions: undefined, path };
}

function triggerContext(input: { readonly mcpUrl?: string; readonly source: string }) {
  const occurrenceId = createId("triggerOccurrence");
  const triggerId = createId("trigger");
  const revisionId = createId("triggerRevision");
  const threadId = createId("thread");
  return TriggerExecutionContextSchema.parse({
    anchorThreadId: threadId,
    browserCdp: null,
    event: {
      id: occurrenceId,
      payload: { price: 42 },
      receivedAt: new Date().toISOString(),
      source: { kind: "manual" },
      trigger: { anchorThreadId: threadId, id: triggerId, revisionId },
    },
    executionGeneration: 1,

    mcp: { token: "test-token", url: input.mcpUrl ?? "http://127.0.0.1:1/mcp" },
    occurrenceId,
    program: { toolContractVersion: 3, language: "typescript", source: input.source },
    revisionId,
    triggerId,
  });
}
