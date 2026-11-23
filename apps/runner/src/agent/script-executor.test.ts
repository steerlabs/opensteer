import type { HarnessProcessLaunch } from "@opensteer/harness";
import { createId } from "@opensteer/core";
import { MAX_OUTPUT_TAIL_BYTES } from "@opensteer/triggers";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startProgramEndpoints } from "./program-endpoints.js";
import { AutomationScriptExecutor } from "./script-executor.js";

const temporaryDirectories: string[] = [];
const nativeFsHelperBinary = fileURLToPath(
  new URL(
    `../../native-fs-helper/opensteer-native-fs${process.platform === "win32" ? ".exe" : ""}`,
    import.meta.url,
  ),
);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function temporaryWorkspace() {
  const path = await mkdtemp(join(tmpdir(), "opensteer-script-exec-"));
  temporaryDirectories.push(path);
  await mkdir(join(path, ".opensteer", "private"), { mode: 0o700, recursive: true });
  return { instructions: undefined, path };
}

function makeMcpTestServer() {
  const seen: {
    method: string;
    name?: string;
    args?: unknown;
    auth?: string | undefined;
  }[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      if (request.method === "DELETE") {
        seen.push({ auth: request.headers.authorization, method: "DELETE" });
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
      seen.push({
        args: body.params?.arguments,
        auth: request.headers.authorization,
        method: body.method,
        ...(body.params?.name ? { name: body.params.name } : {}),
      });
      response.setHeader("content-type", "application/json");
      response.setHeader("mcp-session-id", "script-test-session");
      if (body.method === "initialize") {
        response.end(
          JSON.stringify({
            id: body.id,
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
      if (body.method === "notifications/initialized") {
        response.writeHead(202).end();
        return;
      }
      if (body.method === "tools/list") {
        response.end(
          JSON.stringify({
            id: body.id,
            jsonrpc: "2.0",
            result: { tools: [{ description: "Send", name: "opensteer_task_send" }] },
          }),
        );
        return;
      }
      if (body.params?.name === "fail_tool") {
        response.end(
          JSON.stringify({
            id: body.id,
            jsonrpc: "2.0",
            result: {
              content: [{ text: "boom", type: "text" }],
              isError: true,
              structuredContent: { error: { code: "conflict", message: "boom" } },
            },
          }),
        );
        return;
      }
      response.end(
        JSON.stringify({
          id: body.id,
          jsonrpc: "2.0",
          result: {
            content: [{ text: "ok", type: "text" }],
            structuredContent: { delivered: true, echo: body.params?.arguments ?? {} },
          },
        }),
      );
    })();
  });
  return { seen, server };
}

describe("AutomationScriptExecutor", () => {
  it("runs a default Node script, calls opensteer CLI through CredentialProxy, and hides Host tokens", async () => {
    const { seen, server } = makeMcpTestServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server");
    const workspace = await temporaryWorkspace();
    const automationId = createId("trigger");
    const firingId = createId("triggerOccurrence");
    const endpoints = await startProgramEndpoints({
      capabilities: () => ({
        browserCdp: null,
        mcp: { token: "host-secret-token", url: `http://127.0.0.1:${address.port}/mcp` },
      }),
      transport: { mode: "development" },
    });
    try {
      const output = await new AutomationScriptExecutor({
        nativeFsHelperBinary,
        nodeExecutable: process.execPath,
        privateDirectory: join(workspace.path, ".opensteer", "private"),
      }).execute({
        automationId,
        endpoints: endpoints.endpoints,
        event: {
          automationId,
          firedAt: new Date().toISOString(),
          firingId,
          kind: "schedule",
          scheduledFor: new Date().toISOString(),
        },
        firingId,
        planLaunch: async () => (launch: HarnessProcessLaunch) => launch,
        script: {
          interpreter: null,
          text: `
            import { execFileSync } from "node:child_process";
            import { readFileSync } from "node:fs";
            const ev = JSON.parse(readFileSync(process.env.OPENSTEER_EVENT, "utf8"));
            const tools = JSON.parse(execFileSync("opensteer", ["tools"], { encoding: "utf8" }));
            const res = JSON.parse(execFileSync("opensteer", ["tool", "opensteer_task_send", JSON.stringify({ message: "hello" })], { encoding: "utf8" }));
            let failStatus = 0;
            try {
              execFileSync("opensteer", ["tool", "fail_tool", "{}"], { stdio: "pipe" });
            } catch (e) {
              failStatus = e.status ?? 99;
            }
            console.log(JSON.stringify({
              kind: ev.kind,
              hasCdp: "OPENSTEER_CDP_URL" in process.env,
              mcpTokenMatchesHost: process.env.OPENSTEER_MCP_TOKEN === "host-secret-token",
              tools: tools.map((t) => t.name),
              res,
              failStatus,
            }));
          `,
        },
        signal: new AbortController().signal,
        workspace,
      });

      expect(output.status).toBe("succeeded");
      expect(output.exitCode).toBe(0);
      expect(output.error).toBeNull();
      const printed = JSON.parse(output.stdout.trim());
      expect(printed).toEqual({
        failStatus: 1,
        hasCdp: false,
        kind: "schedule",
        mcpTokenMatchesHost: false,
        res: { delivered: true, echo: { message: "hello" } },
        tools: ["opensteer_task_send"],
      });
      // Host received the real Host token, never the loopback proxy secret.
      expect(
        seen.some((r) => r.method === "tools/call" && r.auth === "Bearer host-secret-token"),
      ).toBe(true);
      await expect(
        stat(join(workspace.path, ".opensteer", "private", firingId)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await endpoints.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("writes raw webhook bytes to bodyPath without bodyUtf8, injects secrets only into env, and runs /bin/sh with CRLF normalized", async () => {
    const workspace = await temporaryWorkspace();
    const automationId = createId("trigger");
    const firingId = createId("triggerOccurrence");
    const rawBody = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x41, 0x42]);
    let observedEventJson = "";
    let observedScriptMode = 0;
    const output = await new AutomationScriptExecutor({
      nativeFsHelperBinary,
      nodeExecutable: process.execPath,
      privateDirectory: join(workspace.path, ".opensteer", "private"),
    }).execute({
      automationId,
      endpoints: {
        browserCdp: { token: "cdp-proxy-tok", url: "ws://127.0.0.1:9999/cdp" },
        mcp: { token: "mcp-proxy-tok", url: "http://127.0.0.1:9999/mcp" },
      },
      event: {
        automationId,
        firedAt: new Date().toISOString(),
        firingId,
        kind: "webhook",
        request: {
          headers: { "x-hub-signature-256": "sha256=abc" },
          method: "POST",
          path: "/hooks/v1/redacted",
          query: { foo: "bar" },
        },
      },
      firingId,
      planLaunch: async (plan) => {
        observedEventJson = await readFile(join(plan.privateDirectory, "event.json"), "utf8");
        observedScriptMode = (await stat(join(plan.privateDirectory, "script.sh"))).mode & 0o777;
        return (launch: HarnessProcessLaunch) => launch;
      },
      script: {
        interpreter: ["/bin/sh"],
        text: [
          'printf "prefixed=%s\\n" "$OPENSTEER_SECRET_WEBHOOK_SECRET"',
          'printf "unprefixed=%s\\n" "${WEBHOOK_SECRET:-unset}"',
          'printf "zdotdir=%s\\n" "${ZDOTDIR:-unset}"',
          'printf "prefixed_zdotdir=%s\\n" "$OPENSTEER_SECRET_ZDOTDIR"',
          'printf "cdp=%s\\n" "$OPENSTEER_CDP_URL"',
          'printf "bytes=%s\\n" "$(wc -c < "$(node -e "console.log(JSON.parse(require(\'fs\').readFileSync(process.env.OPENSTEER_EVENT,\'utf8\')).request.bodyPath)")" | tr -d " ")"',
        ].join("\r\n"),
      },
      secrets: { WEBHOOK_SECRET: "whsec_top_secret", ZDOTDIR: "/tmp/evil" },
      signal: new AbortController().signal,
      webhookBody: rawBody,
      workspace,
    });

    expect(output.status).toBe("succeeded");
    expect(output.exitCode).toBe(0);
    expect(output.stdout).toContain("prefixed=whsec_top_secret");
    expect(output.stdout).toContain("unprefixed=unset");
    expect(output.stdout).toContain("zdotdir=unset");
    expect(output.stdout).toContain("prefixed_zdotdir=/tmp/evil");
    expect(output.stdout).toContain("cdp=ws://127.0.0.1:9999/cdp");
    expect(output.stdout).toContain(`bytes=${rawBody.byteLength}`);
    // Script file must never rely on +x (noexec safe).
    expect(observedScriptMode & 0o111).toBe(0);
    // Secrets never leak into event.json, and no bodyUtf8 copy exists (Y1, Y15).
    expect(observedEventJson).not.toContain("whsec_top_secret");
    const parsedEvent = JSON.parse(observedEventJson);
    expect(parsedEvent.request.bodyBytes).toBe(rawBody.byteLength);
    expect(parsedEvent.request.bodyPath).toMatch(/\/body$/u);
    expect(parsedEvent.request).not.toHaveProperty("bodyUtf8");
  });

  it("caps stdout/stderr at 64 KiB and reports non-zero exit code as failed", async () => {
    const workspace = await temporaryWorkspace();
    const automationId = createId("trigger");
    const firingId = createId("triggerOccurrence");
    const output = await new AutomationScriptExecutor({
      nativeFsHelperBinary,
      nodeExecutable: process.execPath,
      privateDirectory: join(workspace.path, ".opensteer", "private"),
    }).execute({
      automationId,
      endpoints: { mcp: { token: "t", url: "http://127.0.0.1:9/mcp" } },
      event: {
        automationId,
        firedAt: new Date().toISOString(),
        firingId,
        kind: "manual",
      },
      firingId,
      planLaunch: async () => (launch: HarnessProcessLaunch) => launch,
      script: {
        interpreter: null,
        text: `
          process.stdout.write("A".repeat(${MAX_OUTPUT_TAIL_BYTES * 2}) + "END_OUT");
          process.stderr.write("B".repeat(${MAX_OUTPUT_TAIL_BYTES * 2}) + "END_ERR");
          process.exitCode = 7;
        `,
      },
      signal: new AbortController().signal,
      workspace,
    });

    expect(output.status).toBe("failed");
    expect(output.exitCode).toBe(7);
    expect(Buffer.byteLength(output.stdout, "utf8")).toBeLessThanOrEqual(MAX_OUTPUT_TAIL_BYTES);
    expect(Buffer.byteLength(output.stderr, "utf8")).toBeLessThanOrEqual(MAX_OUTPUT_TAIL_BYTES);
    expect(output.stdout).toContain("END_OUT");
    expect(output.stderr).toContain("END_ERR");
  });
});
