import * as resources from "./engine-resources.js";
import { expect, it, vi } from "vitest";
import { pluginEngineEntry, pluginEngineUnavailableReason } from "./engine-resources.js";
import { PluginService } from "./plugin-service.js";

it.each(["ts", "js", "mjs"])("resolves the child beside a %s Host module", (extension) => {
  expect(pluginEngineEntry(`file:///runtime/services/host.${extension}`).href).toBe(
    `file:///runtime/services/plugin-engine.${extension}`,
  );
});

it("reports absent native targets and missing runtime files without launching the engine", async () => {
  expect(await pluginEngineUnavailableReason("win32", "arm64")).toContain(
    "no binary for win32/arm64",
  );
  expect(await pluginEngineUnavailableReason("linux", "x64", () => "/missing/workerd")).toContain(
    "missing",
  );
  const actual = process.arch;
  vi.spyOn(process, "arch", "get").mockReturnValue("arm");
  const service = new PluginService({
    deployment: "personal",
    databaseUrl: "postgres://unused.invalid/unused",
    dataDirectory: "/unused",
    owner: "fixture",
    origin: "https://fixture.invalid",
    credentialKey: new Uint8Array(32),
  });
  try {
    await expect(service.start()).resolves.toBeUndefined();
    expect(service.state()).toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("no binary"),
    });
    await expect(
      service.health({}, { caller: "fixture", mode: "automatic" }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(service.state().pid).toBeUndefined();
  } finally {
    await service.close();
    vi.restoreAllMocks();
  }
  expect(process.arch).toBe(actual);
});

it("reports an executable that the OS cannot load as unavailable", async () => {
  expect(await pluginEngineUnavailableReason("linux", "x64", () => "/")).toContain(
    "workerd cannot run",
  );
});

it("holds a first request behind the same pending runtime check as startup", async () => {
  const checked = Promise.withResolvers<string | undefined>();
  const check = vi
    .spyOn(resources, "pluginEngineUnavailableReason")
    .mockReturnValue(checked.promise);
  const service = new PluginService({
    deployment: "personal",
    databaseUrl: "postgres://unused.invalid/unused",
    dataDirectory: "/unused",
    owner: "fixture",
    origin: "https://fixture.invalid",
    credentialKey: new Uint8Array(32),
    processEntry: new URL("file:///missing/engine.mjs"),
  });
  const starting = service.start();
  const result = service
    .health({}, { caller: "fixture", mode: "automatic" })
    .catch((error: unknown) => error);
  try {
    await Promise.resolve();
    expect(check).toHaveBeenCalledTimes(1);
    expect(service.state().status).toBe("stopped");
    const abort = new AbortController();
    const reason = new Error("Cancelled fixture");
    const cancelled = service
      .health({}, { caller: "fixture", mode: "automatic" }, abort.signal)
      .catch((error: unknown) => error);
    abort.abort(reason);
    expect(await cancelled).toBe(reason);
    checked.resolve("Plugins are unavailable: workerd cannot run on this system");
    await starting;
    expect(await result).toMatchObject({ code: "unavailable" });
    expect(service.state().pid).toBeUndefined();
  } finally {
    checked.resolve("Plugins are unavailable: workerd cannot run on this system");
    await starting;
    await service.close();
    await result;
    check.mockRestore();
  }
});
