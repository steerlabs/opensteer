import { expect, test, vi } from "vitest";
import {
  HostMessageSchema,
  EngineMessageSchema,
  operations,
  checkPluginOutputSize,
  parseIpcMessage,
} from "./engine-protocol.js";
import { catalogPage } from "./catalog-page.js";

test("parses every envelope at the IPC boundary and refuses malformed requests", () => {
  expect(
    EngineMessageSchema.safeParse({ type: "diagnostic", phase: "x".repeat(2 * 1024 * 1024) })
      .success,
  ).toBe(false);
  expect(
    HostMessageSchema.safeParse({
      type: "callbackResult",
      id: "large",
      result: "x".repeat(2 * 1024 * 1024),
    }).success,
  ).toBe(false);
  expect(
    EngineMessageSchema.safeParse({
      type: "execution",
      execution: {
        id: "large",
        caller: "task",
        state: "completed",
        interaction: null,
        result: { status: "completed", logs: ["字".repeat(30000)] },
      },
    }).success,
  ).toBe(false);
  expect(
    HostMessageSchema.safeParse({
      type: "request",
      id: "one",
      operation: "execute",
      context: { caller: "owner:task", mode: "ask" },
      input: { code: "return 1;" },
    }).success,
  ).toBe(true);
  for (const value of [
    { type: "cancel" },
    {
      type: "request",
      id: "one",
      operation: "execute",
      context: { caller: "owner", mode: "ask" },
      input: { code: 3 },
    },
    { type: "request", id: "one", operation: "unknown", input: {} },
  ])
    expect(HostMessageSchema.safeParse(value).success).toBe(false);
  expect(
    EngineMessageSchema.safeParse({
      type: "error",
      id: "one",
      error: { code: "interrupted", message: "Engine exited" },
    }).success,
  ).toBe(true);
  expect(
    EngineMessageSchema.safeParse({
      type: "execution",
      execution: { id: "one", caller: "owner", state: "waiting", interaction: null },
    }).success,
  ).toBe(true);
  expect(
    EngineMessageSchema.safeParse({
      type: "error",
      id: "one",
      error: { code: "anything", message: "bad" },
    }).success,
  ).toBe(false);
  expect(
    operations.install.output.safeParse({ status: "build-error", error: { reason: "Syntax" } })
      .success,
  ).toBe(true);
});
test("source and HTTP payloads keep their own limits instead of the agent result limit", () => {
  expect(() =>
    parseIpcMessage(HostMessageSchema, {
      type: "callbackResult",
      id: "large",
      result: "x".repeat(2 * 1024 * 1024),
    }),
  ).toThrow(/Earlier calls may have taken effect/u);
  const files = [{ path: "index.ts", content: "x".repeat(3 * 1024 * 1024) }];
  expect(
    HostMessageSchema.safeParse({
      type: "request",
      id: "source",
      operation: "install",
      context: { caller: "personal", mode: "automatic" },
      input: { kind: "files", files },
    }).success,
  ).toBe(true);
  expect(
    EngineMessageSchema.safeParse({
      type: "result",
      id: "source",
      operation: "export",
      result: files,
    }).success,
  ).toBe(true);
  expect(() => checkPluginOutputSize("export", files)).not.toThrow();
  expect(() => checkPluginOutputSize("describe", files)).toThrow(/result too large/iu);
  expect(
    HostMessageSchema.safeParse({
      type: "request",
      id: "page",
      operation: "page",
      context: { caller: "personal", mode: "automatic" },
      input: {
        plugin: "app_test",
        request: {
          url: "https://example.com",
          method: "POST",
          headers: {},
          body: Buffer.alloc(1024 * 1024).toString("base64"),
        },
      },
    }).success,
  ).toBe(true);
});

test.each(["cancelled", "expired", "interrupted", "failed"] as const)(
  "does not return a pending form as a %s execution result",
  async (state) => {
    const { PluginExecutions } = await import("./plugin-executions.js");
    const executions = new PluginExecutions(
      {} as ConstructorParameters<typeof PluginExecutions>[0],
    );
    const row = {
      id: "ended",
      state,
      requestId: null,
      result: {
        status: "input-required",
        elicitation: { requestedSchema: { enum: ["private choice"] } },
      },
    } as unknown as import("@opensteer/database").PluginExecutionRecord;
    expect(executions.result(row)).not.toHaveProperty("result");
  },
);

test("catalog cursors retain order and search and refuse changed listings and foreign cursors", () => {
  const entries = ["alpha", "beta", "gamma"].map((id) => ({ id, name: id, package: id }));
  const first = catalogPage(entries, { limit: 1 });
  expect(first.items[0]?.id).toBe("alpha");
  const second = catalogPage(entries, { cursor: first.cursor!, limit: 2 });
  expect(second.items.map((item) => item.id)).toEqual(["beta", "gamma"]);
  expect(second.cursor).toBeNull();
  expect(catalogPage(entries, { search: " BETA " }).items.map((item) => item.id)).toEqual(["beta"]);
  expect(() => catalogPage(entries, { search: "beta", cursor: first.cursor! })).toThrow(/cursor/u);
  expect(() => catalogPage(entries.slice(1), { cursor: first.cursor! })).toThrow(/cursor/u);
  expect(() => catalogPage(entries, { cursor: "garbage" })).toThrow(/cursor/u);
});

test("stops restarting after consecutive losses even when failed starts are far apart", async () => {
  const { PluginService } = await import("./plugin-service.js");
  const { withTimeout } = await import("@opensteer/shared/withTimeout");
  let now = 0;
  const time = vi.spyOn(Date, "now").mockImplementation(() => now);
  let unavailable!: () => void;
  const stopped = new Promise<void>((resolve) => {
    unavailable = resolve;
  });
  const service = new PluginService({
    databaseUrl: "postgres://unused",
    dataDirectory: "/tmp/unused-plugin-test",
    owner: "owner",
    credentialKey: new Uint8Array(32),
    origin: "https://fixture.invalid",
    processEntry: new URL("./absent-plugin-engine.mjs", import.meta.url),
    onState: (state) => {
      if (state.status === "starting") now += 31_000;
      if (state.status === "unavailable") unavailable();
    },
  });
  try {
    await expect(service.start()).rejects.toMatchObject({ code: "interrupted" });
    await withTimeout(stopped, 5_000, {
      timeoutError: () => new Error("Repeated engine loss did not make the subsystem unavailable"),
    });
    expect(service.state()).toMatchObject({ status: "unavailable", generation: 3 });
  } finally {
    await service.close();
    time.mockRestore();
  }
});
