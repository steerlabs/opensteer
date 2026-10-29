import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { closeSync, openSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  RunnerChallengeIdSchema,
  RunnerToHostMessageSchema,
  type RunnerDescriptor,
} from "@opensteer/protocol";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { consumeRunnerConfig, machineAccessRuntimeOptions, runRunnerDaemon } from "./main.js";
import { harnessLaunchValidationHook } from "./shell/machine-access-setup.js";

const canonicalHostKey =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH";
/**
 * The helper this Runner would spawn, standing in for both verbs it calls at
 * startup. macOS asks it for the Full Disk Access answer as well as the host
 * key, so a stub that only knew one of them would fail there and nowhere else.
 */
const helperScript = `#!/bin/sh\nif [ "$1" = "full-disk-access" ]; then\n  echo denied\n  exit 0\nfi\necho "${canonicalHostKey}"\n`;
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("Runner machine access wiring", () => {
  // Setup refuses to hand a Run machine access it has not validated, so a
  // Runner started without the hook would silently omit access on every
  // sandboxed harness — the documented Claude cloud path.
  it("supplies the setup validation hook for every Runner kind", () => {
    const runners = [
      { controlCaPath: undefined, hostUrl: new URL("https://opensteer.example") },
      { controlCaPath: "/etc/opensteer/control-ca.pem", hostUrl: new URL("http://127.0.0.1:4400") },
    ] as const;

    for (const config of runners) {
      const options = machineAccessRuntimeOptions(config, "/opt/opensteer/opensteer-native-fs");

      expect(options.validationHook).toBe(harnessLaunchValidationHook);
      expect(options.helperBinary).toBe("/opt/opensteer/opensteer-native-fs");
      expect(options.hostUrl).toBe(config.hostUrl);
      expect(options.controlCaPath).toBe(config.controlCaPath);
    }
  });
});

describe("Runner configuration", () => {
  it("keeps every bridge token and the enrollment token only in memory once parsed", () => {
    const environment: NodeJS.ProcessEnv = {
      OPENSTEER_BROWSER_BRIDGE_TOKEN: "b".repeat(32),
      OPENSTEER_BROWSER_BRIDGE_URL: "ws://127.0.0.1:4401/v1/browser",
      OPENSTEER_BROWSER_RUNTIME_ID: "brt_local",
      OPENSTEER_COMPUTER_USE_BRIDGE_TOKEN: "c".repeat(32),
      OPENSTEER_COMPUTER_USE_BRIDGE_URL: "ws://127.0.0.1:4402/v1/computer-use",
      OPENSTEER_HOST_URL: "http://127.0.0.1:4400",
      OPENSTEER_LOCAL_WORKSPACE_REGISTRY_PATH: "/tmp/opensteer-runner/registry.json",
      OPENSTEER_LOCAL_WORKSPACE_ROOT: "/tmp/opensteer-runner/workspaces",
      OPENSTEER_RUNNER_DATA_DIR: "/tmp/opensteer-runner",
      OPENSTEER_RUNNER_ENROLLMENT_TOKEN: "s".repeat(32),
      OPENSTEER_RUNNER_KIND: "local",
      OPENSTEER_RUNNER_NAME: "Alex's Mac",
    };

    const config = consumeRunnerConfig(environment);

    expect(config.computerUseBridge?.token).toBe("c".repeat(32));
    expect(config.browserBridge?.bridgeToken).toBe("b".repeat(32));
    // A process that can read this one's environment — a child it spawns, a
    // debugger — finds no credential and no computer use endpoint in it.
    expect(Object.keys(environment).filter((name) => /TOKEN|COMPUTER_USE/u.test(name))).toEqual([]);
    expect(environment.OPENSTEER_HOST_URL).toBe("http://127.0.0.1:4400");
  });

  it("takes its credentials from the descriptor its supervisor names, never the environment", async () => {
    const directory = await temporaryDirectory();
    const secretsPath = join(directory, "secrets.json");
    await writeFile(
      secretsPath,
      JSON.stringify({
        OPENSTEER_COMPUTER_USE_BRIDGE_TOKEN: "c".repeat(32),
        OPENSTEER_RUNNER_ENROLLMENT_TOKEN: "s".repeat(32),
      }),
    );
    const descriptor = openSync(secretsPath, "r");
    const environment: NodeJS.ProcessEnv = {
      ...configEnvironment(),
      OPENSTEER_SECRETS_FD: String(descriptor),
    };

    try {
      const config = consumeRunnerConfig(environment);

      expect(config.computerUseBridge?.token).toBe("c".repeat(32));
      expect(config.enrollmentToken).toBe("s".repeat(32));
      expect(environment).not.toHaveProperty("OPENSTEER_SECRETS_FD");
    } finally {
      closeSync(descriptor);
    }
  });

  it("parses delivered credentials by the same rules as any other source", () => {
    // A bridge token delivered without its URL is refused as it would be in
    // the environment: a credential for nothing.
    expect(() =>
      consumeRunnerConfig(
        { ...configEnvironment(), OPENSTEER_COMPUTER_USE_BRIDGE_URL: undefined },
        { OPENSTEER_COMPUTER_USE_BRIDGE_TOKEN: "c".repeat(32) },
      ),
    ).toThrow(/URL and OPENSTEER_COMPUTER_USE_BRIDGE_TOKEN together/u);
    // A name the Runner does not take as a secret is not smuggled in beside them.
    expect(() =>
      consumeRunnerConfig(configEnvironment(), { OPENSTEER_HOST_URL: "http://127.0.0.1:1" }),
    ).toThrow();
  });

  it("removes the credentials even when the configuration is refused", () => {
    const environment: NodeJS.ProcessEnv = {
      OPENSTEER_COMPUTER_USE_BRIDGE_TOKEN: "c".repeat(32),
      OPENSTEER_RUNNER_ENROLLMENT_TOKEN: "s".repeat(32),
    };

    expect(() => consumeRunnerConfig(environment)).toThrow();
    expect(environment).toEqual({});
  });
});

describe("reach-only Runner startup", () => {
  // The shell module is deferred on Windows, so there is no reach-only Runner
  // to start there at all.
  it.skipIf(process.platform === "win32")(
    "starts nothing but shell and advertises exactly that",
    async () => {
      const directory = await temporaryDirectory();
      const helperBinary = join(directory, "opensteer-native-fs");
      await writeFile(helperBinary, helperScript, "utf8");
      await chmod(helperBinary, 0o700);
      const server = createServer();
      const webSockets = new WebSocketServer({
        path: "/internal/v1/runners",
        perMessageDeflate: false,
        server,
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address() as AddressInfo;
      const abort = new AbortController();
      let descriptor: RunnerDescriptor | undefined;
      webSockets.on("connection", (socket) => {
        socket.send(
          JSON.stringify({
            challengeId: RunnerChallengeIdSchema.parse(`rch_${randomUUID()}`),
            expiresAt: new Date(Date.now() + 30_000).toISOString(),
            hostSessionId: randomUUID(),
            nonce: randomUUID(),
            proofFormatVersion: 2,
            type: "host.challenge",
          }),
        );
        socket.once("message", (raw) => {
          const message = RunnerToHostMessageSchema.parse(JSON.parse(raw.toString("utf8")));
          if (message.type !== "runner.enroll" && message.type !== "runner.authenticate") return;
          descriptor = message.descriptor;
          abort.abort(new Error("descriptor captured"));
        });
      });

      try {
        // Every path an agents Runner would take is aimed at something that is
        // not there: verifying the Node executable, loading agent skills or
        // preparing a Workspace would all fail loudly. A reach-only Runner
        // starts none of them.
        await runRunnerDaemon(
          {
            OPENSTEER_AGENT_SKILLS_DIRECTORY: "/nonexistent/opensteer/agent-skills",
            OPENSTEER_BROWSER_HARNESS: "/nonexistent/opensteer/browser-harness.mjs",
            OPENSTEER_HOST_URL: `http://127.0.0.1:${address.port}`,
            OPENSTEER_LOCAL_WORKSPACE_REGISTRY_PATH: "/nonexistent/opensteer/registry.json",
            OPENSTEER_LOCAL_WORKSPACE_ROOT: "/nonexistent/opensteer/workspaces",
            OPENSTEER_NATIVE_FS_HELPER: helperBinary,
            OPENSTEER_NODE_EXECUTABLE: "/nonexistent/opensteer/node",
            OPENSTEER_RUNNER_DATA_DIR: directory,
            OPENSTEER_RUNNER_ENROLLMENT_TOKEN: "s".repeat(32),
            OPENSTEER_RUNNER_KIND: "local",
            OPENSTEER_RUNNER_MODULES: "shell",
            OPENSTEER_RUNNER_NAME: "Reachable Mac",
          },
          abort.signal,
        );

        expect(descriptor?.modules).toEqual({
          shell: {
            // Only macOS gates the filesystem on an app-level grant, so only a
            // Mac states the fact at all.
            ...(process.platform === "darwin" ? { fullDiskAccess: false } : {}),
            hostPublicKey: canonicalHostKey,
            platform: process.platform,
          },
        });
        // A reach-only computer names no work location, so the Host binds it to
        // no environment at all.
        expect(descriptor?.modules.agents).toBeUndefined();
      } finally {
        for (const client of webSockets.clients) client.terminate();
        await new Promise<void>((resolve) => webSockets.close(() => resolve()));
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    // Startup launches native subprocesses alongside the full suite.
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "shuts down instead of reconnecting once the Deployment revokes it",
    async () => {
      const directory = await temporaryDirectory();
      const helperBinary = join(directory, "opensteer-native-fs");
      await writeFile(helperBinary, helperScript, "utf8");
      await chmod(helperBinary, 0o700);
      const server = createServer();
      const webSockets = new WebSocketServer({
        path: "/internal/v1/runners",
        perMessageDeflate: false,
        server,
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address() as AddressInfo;
      let attempts = 0;
      webSockets.on("connection", (socket) => {
        attempts += 1;
        socket.close(4010, "Runner identity was revoked");
      });
      let revocations = 0;

      try {
        // Nothing stops this daemon: being removed from the Deployment is what
        // ends it, and the promise resolving is the clean shutdown.
        await runRunnerDaemon(
          {
            OPENSTEER_HOST_URL: `http://127.0.0.1:${address.port}`,
            OPENSTEER_NATIVE_FS_HELPER: helperBinary,
            OPENSTEER_RUNNER_DATA_DIR: directory,
            OPENSTEER_RUNNER_ENROLLMENT_TOKEN: "s".repeat(32),
            OPENSTEER_RUNNER_KIND: "local",
            OPENSTEER_RUNNER_MODULES: "shell",
            OPENSTEER_RUNNER_NAME: "Reachable Mac",
          },
          undefined,
          {
            onRevoked: () => {
              revocations += 1;
            },
          },
        );

        expect(revocations).toBe(1);
        expect(attempts).toBe(1);
      } finally {
        for (const client of webSockets.clients) client.terminate();
        await new Promise<void>((resolve) => webSockets.close(() => resolve()));
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    // Startup launches native subprocesses alongside the full suite.
    15_000,
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "opensteer-runner-main-"));
  directories.push(directory);
  return directory;
}

/** A local Runner's environment with a computer use bridge and no credential. */
function configEnvironment(): NodeJS.ProcessEnv {
  return {
    OPENSTEER_COMPUTER_USE_BRIDGE_URL: "ws://127.0.0.1:4402/v1/computer-use",
    OPENSTEER_HOST_URL: "http://127.0.0.1:4400",
    OPENSTEER_LOCAL_WORKSPACE_REGISTRY_PATH: "/tmp/opensteer-runner/registry.json",
    OPENSTEER_LOCAL_WORKSPACE_ROOT: "/tmp/opensteer-runner/workspaces",
    OPENSTEER_RUNNER_DATA_DIR: "/tmp/opensteer-runner",
    OPENSTEER_RUNNER_KIND: "local",
    OPENSTEER_RUNNER_NAME: "Alex's Mac",
  };
}
