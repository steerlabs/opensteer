import { delay } from "@opensteer/shared/delay";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpensteerError } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import { CodexHarnessConfigSchema } from "./config.js";
import { CodexStdioClient } from "./process.js";

const fakeServer = fileURLToPath(
  new URL("./test-fixtures/fake-codex-app-server.mjs", import.meta.url),
);
const lifecycleServer = fileURLToPath(
  new URL("./test-fixtures/process-lifecycle.mjs", import.meta.url),
);

describe("Codex stdio process", () => {
  it("initializes explicitly configured Codex storage roots before starting app-server", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opensteer-codex-process-test-"));
    const providerHome = join(directory, "private", "harness-state", "codex");
    const sqliteHome = join(directory, "cache", "codex-sqlite");
    const lifetime = new AbortController();
    let client: CodexStdioClient | undefined;
    try {
      client = await CodexStdioClient.start({
        config: CodexHarnessConfigSchema.parse({}),
        cwd: directory,
        environment: stringEnvironment({
          ...process.env,
          CODEX_HOME: providerHome,
          CODEX_SQLITE_HOME: sqliteHome,
          FAKE_CODEX_SCENARIO: "normal",
        }),
        launch: { arguments: [fakeServer], executable: process.execPath },
        onFailure: () => undefined,
        onMethodMessage: () => undefined,
        signal: lifetime.signal,
      });

      expect((await stat(providerHome)).isDirectory()).toBe(true);
      expect((await stat(sqliteHome)).isDirectory()).toBe(true);
    } finally {
      lifetime.abort();
      await client?.close(0);
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("bounds retained stderr without exposing it in the public failure message", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opensteer-codex-process-test-"));
    const failure = deferred<OpensteerError>();
    const lifetime = new AbortController();
    const client = await CodexStdioClient.start({
      config: CodexHarnessConfigSchema.parse({
        maxStderrBytes: 1_024,
      }),
      cwd: directory,
      environment: stringEnvironment({ ...process.env, FAKE_CODEX_SCENARIO: "stderr-tail" }),
      launch: { arguments: [fakeServer], executable: process.execPath },
      onFailure: failure.resolve,
      onMethodMessage: () => undefined,
      signal: lifetime.signal,
    });
    try {
      await client.request("initialize", {
        capabilities: { experimentalApi: true, requestAttestation: false },
        clientInfo: { name: "opensteer_test", title: "Opensteer Test", version: "0.0.0" },
      });
      await client.notify("initialized", {});
      await client.request("thread/start", { cwd: directory });
      await client.request("turn/start", {
        input: [{ text: "Crash", text_elements: [], type: "text" }],
        threadId: "codex-thread-1",
      });
      const error = await withTimeout(failure.promise, 2_000, {
        timeoutError: () => new Error("Timed out waiting for process failure"),
      });
      const stderr = error.details?.stderr;
      expect(error.message).not.toContain("HEAD-");
      expect(error.message).not.toContain("-TAIL");
      expect(typeof stderr).toBe("string");
      expect(Buffer.byteLength(String(stderr), "utf8")).toBeLessThanOrEqual(1_024);
      expect(stderr).not.toContain("HEAD-");
      expect(stderr).toContain("-TAIL");
    } finally {
      lifetime.abort();
      await client.close(0);
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("attaches a bounded redacted stderr diagnostic to a timed-out request", async ({ signal }) => {
    const longSecret = "z".repeat(1_200);
    const fixture = await startLifecycleClient("timeout", longSecret);
    try {
      // First observe the diagnostic at the parent. Spawning the child does
      // not prove it ran, and stdout/stderr travel over independent pipes.
      await fixture.client.notify("test/diagnostic", {});
      while (!fixture.client.stderrText().endsWith("api key deployment-secret")) {
        await delay(0, signal);
      }
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const request = fixture.client.request("initialize", {}, 100);
      const rejected = expect(request).rejects.toMatchObject({
        code: "timeout",
        details: { method: "initialize", timeoutMs: 100 },
      });
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
      const error = await fixture.failure.promise;
      const stderr = String(error.details?.stderr);
      expect(stderr).toContain("Codex provider startup blocked");
      expect(stderr).toContain("Bearer [REDACTED]");
      expect(stderr).toContain("[OPAQUE_CREDENTIAL]");
      expect(stderr).not.toContain("deployment-secret");
      expect(stderr).not.toContain("bearer-secret");
      expect(stderr).not.toContain("os_secret_session");
      expect(stderr).not.toContain("z".repeat(20));
      expect(stderr).not.toContain("HEAD-");
      expect(Buffer.byteLength(stderr, "utf8")).toBeLessThanOrEqual(1_024);
      expect(fixture.client.failed).toBe(true);
    } finally {
      vi.useRealTimers();
      await fixture.close();
    }
  });

  it("rejects a request without its own deadline when the process lifetime is aborted", async () => {
    const fixture = await startLifecycleClient("timeout");
    try {
      const request = fixture.client.request("initialize", {}, null);
      fixture.lifetime.abort(new Error("test cancellation"));
      await expect(request).rejects.toMatchObject({
        code: "harness_error",
        message: "Codex app-server connection closed",
      });
      expect(fixture.client.failed).toBe(false);
    } finally {
      await fixture.close();
    }
  });

  it("rejects a request without its own deadline when the app-server exits", async () => {
    const fixture = await startLifecycleClient("exit");
    try {
      await expect(fixture.client.request("initialize", {}, null)).rejects.toMatchObject({
        code: "harness_error",
        details: { code: 23 },
        message: expect.stringContaining("code 23"),
      });
      expect(fixture.client.failed).toBe(true);
    } finally {
      await fixture.close();
    }
  });
});

async function startLifecycleClient(
  scenario: "exit" | "timeout",
  agentToolsToken = "agent-tools-secret",
): Promise<{
  readonly client: CodexStdioClient;
  readonly close: () => Promise<void>;
  readonly failure: ReturnType<typeof deferred<OpensteerError>>;
  readonly lifetime: AbortController;
}> {
  const directory = await mkdtemp(join(tmpdir(), "opensteer-codex-process-test-"));
  const failure = deferred<OpensteerError>();
  const lifetime = new AbortController();
  const client = await CodexStdioClient.start({
    config: CodexHarnessConfigSchema.parse({
      maxStderrBytes: 1_024,
    }),
    cwd: directory,
    environment: stringEnvironment({
      ...process.env,
      FAKE_CODEX_PROCESS_SCENARIO: scenario,
      OPENSTEER_AGENT_TOOLS_TOKEN: agentToolsToken,
      OPENSTEER_TEST_API_KEY: "deployment-secret",
    }),
    launch: { arguments: [lifecycleServer], executable: process.execPath },
    onFailure: failure.resolve,
    onMethodMessage: () => undefined,
    signal: lifetime.signal,
  });
  return {
    client,
    failure,
    lifetime,
    close: async () => {
      lifetime.abort();
      await client.close(0);
      await rm(directory, { force: true, recursive: true });
    },
  };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  if (!resolvePromise) throw new Error("Deferred failed to initialize");
  return { promise, resolve: resolvePromise };
}

function stringEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}
