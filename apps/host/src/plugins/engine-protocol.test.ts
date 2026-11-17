import { expect, test, vi } from "vitest";
import { HostMessageSchema, EngineMessageSchema, operations } from "./engine-protocol.js";
import { catalogPage } from "./catalog-page.js";

test("parses every envelope at the IPC boundary and refuses malformed requests", () => {
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
