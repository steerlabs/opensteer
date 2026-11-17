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
