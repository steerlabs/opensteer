import { writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertDevelopmentListenersAvailable,
  assertDevelopmentWorkspaceEnvironment,
  DevelopmentStackAlreadyRunningError,
  DevelopmentStackLock,
  developmentListeners,
  developmentWorkspaceBacking,
  localFilesServiceUrl,
} from "../scripts/dev-supervisor.js";

describe("development supervisor", () => {
  it("owns one stack lock and removes it only on release", async () => {
    const path = join(tmpdir(), `opensteer-dev-lock-${randomUUID()}`, "dev.lock");
    const first = await DevelopmentStackLock.acquire(path, "http://localhost:43100");
    await expect(
      DevelopmentStackLock.acquire(path, "http://localhost:43100"),
    ).rejects.toBeInstanceOf(DevelopmentStackAlreadyRunningError);
    await first.release();
    const second = await DevelopmentStackLock.acquire(path, "http://localhost:43100");
    await second.release();
  });

  it("reclaims a well-formed stale lock without accepting an invalid one", async () => {
    const directory = join(tmpdir(), `opensteer-dev-stale-${randomUUID()}`);
    const path = join(directory, "dev.lock");
    const first = await DevelopmentStackLock.acquire(path, "http://localhost:43100");
    await first.release();
    await writeFile(
      path,
      `${JSON.stringify({ nonce: "stale", pid: 2_147_483_647, publicUrl: "http://localhost:43100" })}\n`,
      { mode: 0o600 },
    );
    const reclaimed = await DevelopmentStackLock.acquire(path, "http://localhost:43100");
    await reclaimed.release();

    await writeFile(path, "not-json\n", { mode: 0o600 });
    await expect(DevelopmentStackLock.acquire(path, "http://localhost:43100")).rejects.toThrow(
      /lock is invalid/,
    );
  });

  it("derives only the listeners selected for this run", () => {
    expect(developmentListeners(["host", "web"], {})).toEqual([
      { host: "127.0.0.1", label: "Host", port: 4310 },
      { host: "127.0.0.1", label: "Web", port: 43_100 },
    ]);
  });

  it("accepts only a plain HTTP origin for the native Files service", () => {
    expect(localFilesServiceUrl({ OPENSTEER_FILES_SERVICE_URL: "http://[::1]:4315" }).origin).toBe(
      "http://[::1]:4315",
    );
    expect(() =>
      localFilesServiceUrl({ OPENSTEER_FILES_SERVICE_URL: "https://files.example.test" }),
    ).toThrow(/HTTP origin/);
    expect(() =>
      localFilesServiceUrl({ OPENSTEER_FILES_SERVICE_URL: "http://127.0.0.1:4315/path" }),
    ).toThrow(/HTTP origin/);
  });

  it("defaults to local directories and accepts only explicit development backing", () => {
    expect(developmentWorkspaceBacking({})).toBe("local-directory");
    expect(
      developmentWorkspaceBacking({
        OPENSTEER_DEFAULT_WORKSPACE_BACKING: "portablefs",
        OPENSTEER_DEPLOYMENT_KIND: "server",
      }),
    ).toBe("portablefs");
    expect(() =>
      developmentWorkspaceBacking({ OPENSTEER_DEFAULT_WORKSPACE_BACKING: "invalid" }),
    ).toThrow(/requires OPENSTEER_DEFAULT_WORKSPACE_BACKING/);
  });

  it("rejects variables from the other storage backing", () => {
    expect(() =>
      assertDevelopmentWorkspaceEnvironment("local-directory", {
        OPENSTEER_PORTABLEFS_MANAGER_URL: "https://manager.example.test",
      }),
    ).toThrow(/local-directory.*OPENSTEER_PORTABLEFS_MANAGER_URL/);
    expect(() =>
      assertDevelopmentWorkspaceEnvironment("portablefs", {
        OPENSTEER_LOCAL_WORKSPACE_ROOT: "/tmp/workspaces",
      }),
    ).toThrow(/portablefs.*OPENSTEER_LOCAL_WORKSPACE_ROOT/);
  });

  it("fails before startup when a selected listener is occupied", async () => {
    const server = createServer();
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    await expect(
      assertDevelopmentListenersAvailable([
        { host: "127.0.0.1", label: "Test", port: address.port },
      ]),
    ).rejects.toThrow(/already in use/);
    await new Promise<void>((resolvePromise, rejectPromise) =>
      server.close((error) => (error ? rejectPromise(error) : resolvePromise())),
    );
  });
});
