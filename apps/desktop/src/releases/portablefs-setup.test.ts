import { access, chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopLocalExecutionConfiguration } from "../config.js";
import { PortableFsSetupService } from "./portablefs-setup.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("PortableFsSetupService", () => {
  it("guides the one-time macOS approval and then admits first-mount verification", async () => {
    const directory = await temporaryDirectory();
    const binary = path.join(directory, "portablefs");
    await writeFakePortableFs(binary, "unverified");
    const service = new PortableFsSetupService(
      { ...configuration(directory), portableFsBinary: binary },
      { homeDirectory: directory, platform: "darwin" },
    );

    await expect(service.status()).resolves.toMatchObject({
      binaryPath: await realpath(binary),
      state: "needs-user-approval",
      version: "3.1.0",
    });
    await expect(service.acknowledgeApproval()).resolves.toMatchObject({
      state: "ready-to-mount",
    });
    await expect(service.requireReadyBinary()).resolves.toBe(await realpath(binary));
  });

  it("keeps a blocked host fail-closed", async () => {
    const directory = await temporaryDirectory();
    const binary = path.join(directory, "portablefs");
    await writeFakePortableFs(binary, "blocked");
    const service = new PortableFsSetupService(
      { ...configuration(directory), portableFsBinary: binary },
      { homeDirectory: directory, platform: "linux" },
    );

    await expect(service.status()).resolves.toMatchObject({
      detail: "FUSE is unavailable",
      issue: "fuse-device-missing",
      state: "failed",
    });
  });

  it("rejects an incompatible client before invoking commands it does not advertise", async () => {
    const directory = await temporaryDirectory();
    const binary = path.join(directory, "portablefs");
    const mountCheckMarker = path.join(directory, "mount-check-ran");
    await writeFile(
      binary,
      `#!/bin/sh\nif [ "$1" = "version" ]; then\n  printf '%s\\n' '{"version":"0.2.3","features":[]}'\nelif [ "$1" = "mount-check" ]; then\n  touch '${mountCheckMarker}'\n  exit 2\nfi\n`,
      { mode: 0o700 },
    );
    const service = new PortableFsSetupService(
      { ...configuration(directory), portableFsBinary: binary },
      { homeDirectory: directory, platform: "darwin" },
    );

    await expect(service.status()).resolves.toMatchObject({
      detail: "PortableFS 0.2.3 is incompatible with automatic Workspace mount renewal.",
      state: "failed",
      version: "0.2.3",
    });
    await expect(access(mountCheckMarker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("runs one pinned installer and rechecks the installed binary", async () => {
    const directory = await temporaryDirectory();
    const installer = path.join(directory, "install.sh");
    const binary = path.join(directory, "portablefs");
    await writeFile(installer, "#!/bin/sh\n", { mode: 0o600 });
    const runInstaller = vi.fn(async (_path: string, version: string) => {
      expect(version).toBe("3.1.0");
      await writeFakePortableFs(binary, "unverified");
    });
    const service = new PortableFsSetupService(
      {
        ...configuration(directory),
        portableFsBinary: binary,
        portableFsInstaller: { path: installer, version: "3.1.0" },
      },
      { homeDirectory: directory, platform: "linux", runInstaller },
    );

    await expect(service.install()).resolves.toMatchObject({ state: "ready-to-mount" });
    expect(runInstaller).toHaveBeenCalledTimes(1);
  });
});

function configuration(directory: string): DesktopLocalExecutionConfiguration {
  return {
    dataDirectory: path.join(directory, "runner"),
    enabled: true,
    nativeFsHelperBinary: path.join(directory, "opensteer-native-fs"),
    portableFsBinary: undefined,
    portableFsInstaller: undefined,
    runnerWorkerPath: path.join(directory, "runner-worker.js"),
  };
}

async function writeFakePortableFs(binary: string, state: "blocked" | "unverified"): Promise<void> {
  const mountCheck =
    state === "blocked"
      ? `printf '%s\\n' '{"schemaVersion":1,"error":{"kind":"blocked","code":"fuse-device-missing","message":"FUSE is unavailable"}}'; exit 1`
      : `printf '%s\\n' '{"schemaVersion":1,"facts":{"state":"unverified","summary":"No live mount yet","transport":"fuse"}}'`;
  await writeFile(
    binary,
    `#!/bin/sh\nif [ "$1" = "version" ]; then\n  printf '%s\\n' '{"version":"3.1.0","features":["hosted-automatic-mount-reauthorization-v2"]}'\nelif [ "$1" = "mount-check" ]; then\n  ${mountCheck}\nelse\n  exit 2\nfi\n`,
    { mode: 0o700 },
  );
  await chmod(binary, 0o700);
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "opensteer-portablefs-setup-"));
  temporaryDirectories.push(directory);
  return directory;
}
