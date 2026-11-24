import { nativeUserHarnessRuntimeBoundary } from "@opensteer/harness";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AntigravityHarnessDriver } from "./driver.js";
import * as runtime from "./runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function setupCodeLogin(behavior: "succeed" | "fail" | "hang") {
  const directory = await mkdtemp(join(tmpdir(), "opensteer-antigravity-login-"));
  temporaryDirectories.push(directory);
  const executable = join(directory, "fake-antigravity");
  const capturePath = join(directory, "capture.json");
  const authUrl =
    "https://accounts.google.com/o/oauth2/auth?response_type=code&state=state-chunk-1&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback";
  const splitIndex = Math.floor(authUrl.length / 2);
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs");
const capture = {
  args: process.argv.slice(2),
  display: process.env.DISPLAY ?? null,
  waylandDisplay: process.env.WAYLAND_DISPLAY ?? null,
  sshConnection: process.env.SSH_CONNECTION ?? null,
  stdin: "",
};
process.stdout.write("Open this URL to continue:\\n");
process.stdout.write(${JSON.stringify(authUrl.slice(0, splitIndex))});
setImmediate(() => {
  process.stdout.write(${JSON.stringify(`${authUrl.slice(splitIndex)}\n`)});
});
if (${JSON.stringify(behavior)} === "hang") {
  process.stdin.resume();
  return;
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  capture.stdin += chunk;
});
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(capture));
  process.exit(${JSON.stringify(behavior)} === "succeed" ? 0 : 1);
});
`,
    { mode: 0o700 },
  );
  vi.spyOn(runtime, "prepareAntigravityRuntime").mockResolvedValue({
    directory,
    executable,
    protocolVersion: 1,
    version: "1.5.16",
  });
  const driver = new AntigravityHarnessDriver({
    nodeExecutable: process.execPath,
    runtimeCacheDirectory: directory,
  });
  const context = {
    config: {},
    environment: {
      DISPLAY: ":0",
      PATH: process.env.PATH ?? "",
      WAYLAND_DISPLAY: "wayland-0",
    },
    providerState: {
      continuationKey: "test-login",
      kind: "isolated" as const,
      privateStateRoot: directory,
      providerHomeDirectory: join(directory, "profile"),
      store: { directory: join(directory, "store"), id: "test-login" },
    },
    runtimeBoundary: nativeUserHarnessRuntimeBoundary,
    signal: AbortSignal.timeout(5_000),
    sourceId: "google",
    workingDirectory: directory,
  };
  await driver.prepare(context);
  return { authUrl, capturePath, context, driver };
}

describe("Antigravity 1.5 --login code authentication process", () => {
  it("reads a chunked OAuth URL, strips display env, writes the submitted code, and settles ready", async () => {
    const { authUrl, capturePath, context, driver } = await setupCodeLogin("succeed");

    const started = await driver.authenticate(context, { methodId: "oauth-personal" });
    expect(started.status).toBe("pending");
    if (started.status !== "pending") return;
    expect(started.challenge).toMatchObject({
      authorizationUrl: authUrl,
      kind: "browser-code",
    });

    await started.submit!("4/0AbcDef_123");
    await expect(started.result).resolves.toEqual({ status: "ready" });

    const captured = JSON.parse(await readFile(capturePath, "utf8")) as {
      args: string[];
      display: string | null;
      sshConnection: string | null;
      stdin: string;
      waylandDisplay: string | null;
    };
    expect(captured.args).toContain("--login");
    expect(captured.display).toBeNull();
    expect(captured.waylandDisplay).toBeNull();
    expect(captured.sshConnection).toBe("127.0.0.1 0 127.0.0.1 0");
    expect(captured.stdin).toBe("4/0AbcDef_123\n");
  });

  it("reports failure when the --login process exits non-zero", async () => {
    const { context, driver } = await setupCodeLogin("fail");

    const started = await driver.authenticate(context, { methodId: "oauth-personal" });
    expect(started.status).toBe("pending");
    if (started.status !== "pending") return;

    await started.submit!("4/0AbcDef_123");
    await expect(started.result).resolves.toEqual({
      detail: "Google sign-in failed or was canceled",
      status: "failed",
    });
  });

  it("cancels a pending --login sign-in and terminates the child process", async () => {
    const { context, driver } = await setupCodeLogin("hang");

    const started = await driver.authenticate(context, { methodId: "oauth-personal" });
    expect(started.status).toBe("pending");
    if (started.status !== "pending") return;

    await started.cancel();
    await expect(started.result).resolves.toEqual({
      detail: "Google sign-in was canceled",
      status: "failed",
    });
  });
});
