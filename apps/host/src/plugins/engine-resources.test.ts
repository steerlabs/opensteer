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
  expect((await pluginEngineUnavailableReason("win32", "arm64"))?.detail).toContain(
    "no binary for win32/arm64",
  );
  expect(
    (await pluginEngineUnavailableReason("linux", "x64", () => "/missing/workerd"))?.detail,
  ).toContain("missing");
  const actual = process.arch;
  vi.spyOn(process, "arch", "get").mockReturnValue("arm");
  const service = new PluginService({
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
  expect((await pluginEngineUnavailableReason("linux", "x64", () => "/"))?.detail).toContain(
    "workerd cannot run",
  );
});

it("holds a first request behind the same pending runtime check as startup", async () => {
  const checked = Promise.withResolvers<resources.PluginEngineUnavailability | undefined>();
  const check = vi
    .spyOn(resources, "pluginEngineUnavailableReason")
    .mockReturnValue(checked.promise);
  const service = new PluginService({
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
    checked.resolve({
      code: "unsupported-system",
      detail: "Plugins are unavailable: workerd cannot run on this system",
    });
    await starting;
    expect(await result).toMatchObject({ code: "unavailable" });
    expect(service.state().pid).toBeUndefined();
  } finally {
    checked.resolve({
      code: "unsupported-system",
      detail: "Plugins are unavailable: workerd cannot run on this system",
    });
    await starting;
    await service.close();
    await result;
    check.mockRestore();
  }
});

it("reports the deployment floor declared by an unloadable Mach-O binary", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "plugin-binary-"));
  try {
    const binary = join(directory, "workerd");
    const bytes = Buffer.alloc(56);
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(1, 16);
    bytes.writeUInt32LE(0x32, 32);
    bytes.writeUInt32LE(24, 36);
    bytes.writeUInt32LE((13 << 16) | (5 << 8), 44);
    await writeFile(binary, bytes, { mode: 0o700 });
    expect(await pluginEngineUnavailableReason("darwin", "arm64", () => binary)).toMatchObject({
      code: "unsupported-system",
      minimumMacOS: "13.5.0",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
