import childProcess, { execFileSync } from "node:child_process";
import { connect, createServer, type Socket } from "node:net";
import { once } from "node:events";

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { afterAll, describe, expect, it, vi } from "vitest";
import { withTimeout } from "@opensteer/shared/withTimeout";
import type { BrowserLaunchRequest } from "@opensteer/browser-runtime-core";
import { validClaims } from "@opensteer/browser-runtime-core/test-support";
import {
  TestChromiumLauncher as PlaywrightChromiumLauncher,
  findChromium,
  withBrowserTestSignal,
} from "./browser-test-lifecycle.js";

const executablePath = findChromium();
const evidence: Record<string, unknown>[] = [];
const request: BrowserLaunchRequest = {
  initialViewport: { devicePixelRatio: 1, height: 600, width: 800 },
  partitionKey: `session:${validClaims().sessionId}`,
  sessionId: validClaims().sessionId,
  storage: { kind: "guest" },
};

afterAll(async () => {
  const directory =
    process.env.OPENSTEER_CHROMIUM_TEARDOWN_E2E_ARTIFACT_DIR ??
    join(tmpdir(), "opensteer-chromium-teardown-e2e");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `teardown-${process.pid}.json`),
    `${JSON.stringify({ executablePath, evidence }, null, 2)}\n`,
  );
});

describe.skipIf(process.platform === "win32")("owned Chromium teardown", () => {
  it("ends a stopped process and its children before resolving concurrent close calls", async () => {
    const browser = await new PlaywrightChromiumLauncher({
      chromiumSandbox: false,
      executablePath,
      headless: true,
    }).launch(request);
    const inventory = await browser.cdp.send("SystemInfo.getProcessInfo");
    const processes = processInventory(inventory);
    const pid = processes.find((entry) => entry.type === "browser")!.id;
    process.kill(pid, "SIGSTOP");
    const started = performance.now();
    try {
      const first = browser.close();
      expect(browser.close()).toBe(first);
      await withTimeout(first, 2_000, {
        timeoutError: () => new Error("Owner close waited for a stopped Chromium."),
      });
      const surviving = processes.filter((entry) => alive(entry.id));
      evidence.push({
        scenario: "stopped-process",
        pid,
        closeMs: performance.now() - started,
        surviving,
      });
      expect(surviving).toEqual([]);
      await browser.close();
    } finally {
      killOwnedGroup(pid);
    }
  }, 30_000);

  it("retires a page CDP channel before LIFO cleanup closes its unresponsive owner", async () => {
    const browser = await new PlaywrightChromiumLauncher({
      chromiumSandbox: false,
      executablePath,
      headless: true,
    }).launch(request);
    const pid = processInventory(await browser.cdp.send("SystemInfo.getProcessInfo")).find(
      (entry) => entry.type === "browser",
    )!.id;
    const page = browser.context.pages()[0]!;
    const raw = await page.cdp();
    process.kill(pid, "SIGSTOP");
    const started = performance.now();
    try {
      await withTimeout(raw.close(), 1_000, {
        timeoutError: () => new Error("A subsidiary detach blocked its owner."),
      });
      await expect(raw.send("Runtime.evaluate", { expression: "1" })).rejects.toThrow(
        /closed|detached/i,
      );
      await withTimeout(browser.close(), 2_000, {
        timeoutError: () => new Error("Owner close waited for its browser CDP detach."),
      });
      expect(alive(pid)).toBe(false);
      evidence.push({
        scenario: "lifo-detach",
        pid,
        closeMs: performance.now() - started,
        alive: alive(pid),
      });
    } finally {
      killOwnedGroup(pid);
    }
  }, 30_000);

  it("ends Chromium with a dialog and an unanswered page command", async () => {
    const browser = await new PlaywrightChromiumLauncher({
      chromiumSandbox: false,
      executablePath,
      headless: true,
    }).launch(request);
    const pid = processInventory(await browser.cdp.send("SystemInfo.getProcessInfo")).find(
      (entry) => entry.type === "browser",
    )!.id;
    const page = await browser.context.pages()[0]!.cdp();
    await page.send("Page.enable");
    const opened = new Promise<void>((resolve) => {
      page.on("Page.javascriptDialogOpening", () => resolve());
    });
    const command = page
      .send("Runtime.evaluate", { expression: "confirm('Still open?')" })
      .catch(() => undefined);
    await withBrowserTestSignal(opened);
    const started = performance.now();
    try {
      await withTimeout(browser.close(), 2_000, {
        timeoutError: () => new Error("Owner close waited for a page dialog."),
      });
      await command;
      expect(alive(pid)).toBe(false);
      evidence.push({
        scenario: "dialog-and-command",
        pid,
        closeMs: performance.now() - started,
        alive: alive(pid),
      });
    } finally {
      killOwnedGroup(pid);
    }
  }, 30_000);

  it("reaps Chromium when its server listener fails after launch", async () => {
    const listener = createServer();
    const accepted = new Set<Socket>();
    listener.on("connection", (socket) => {
      accepted.add(socket);
      socket.on("error", () => socket.destroy());
      socket.once("close", () => accepted.delete(socket));
      // This listener only occupies a port; no accepted peer has work to finish.
      socket.destroy();
    });
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Missing listener port");
    const spawns = vi.spyOn(childProcess, "spawn");
    const probe = connect(address.port, "127.0.0.1");
    const probeClosed = new Promise<void>((resolve) => probe.once("close", () => resolve()));
    probe.on("error", () => probe.destroy());
    let pid: number | undefined;
    try {
      await withBrowserTestSignal(once(probe, "connect"));
      probe.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
      await expect(
        chromium.launchServer({
          executablePath,
          headless: true,
          host: "127.0.0.1",
          port: address.port,
        }),
      ).rejects.toThrow(/EADDRINUSE/);
      const index = spawns.mock.calls.findIndex(([command]) => command === executablePath);
      const result = spawns.mock.results[index];
      if (result?.type === "return") pid = result.value.pid;
      expect(pid).toBeDefined();
      expect(alive(pid!)).toBe(false);
      evidence.push({ scenario: "listener-failure", pid, alive: alive(pid!) });
    } finally {
      if (pid) killOwnedGroup(pid);
      const closed = new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      );
      try {
        await withTimeout(closed, 1_000, {
          timeoutError: () => new Error("Port-occupancy fixture waited for a foreign peer."),
        });
      } finally {
        probe.destroy();
        for (const socket of accepted) socket.destroy();
        await Promise.all([probeClosed, closed]);
      }
    }
  }, 30_000);

  it("reaps a launched process when connecting to it fails", async () => {
    const original = chromium.launchServer.bind(chromium);
    let pid: number | undefined;
    vi.spyOn(chromium, "launchServer").mockImplementation(async (options) => {
      const server = await original(options);
      pid = server.process().pid;
      return server;
    });
    vi.spyOn(chromium, "connect").mockRejectedValue(new Error("Injected connection failure"));
    try {
      await expect(
        new PlaywrightChromiumLauncher({
          chromiumSandbox: false,
          executablePath,
          headless: true,
        }).launch(request),
      ).rejects.toThrow("Injected connection failure");
      expect(pid).toBeDefined();
      expect(alive(pid!)).toBe(false);
      evidence.push({ scenario: "startup-failure", pid, alive: alive(pid!) });
    } finally {
      if (pid) killOwnedGroup(pid);
    }
  }, 30_000);
});

function processInventory(value: unknown): Array<{ id: number; type: string }> {
  return (value as { processInfo: Array<{ id: number; type: string }> }).processInfo;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // A killed child can briefly remain as a zombie until its parent reaps it.
    return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" })
      .trim()
      .startsWith("Z");
  } catch {
    return false;
  }
}

function killOwnedGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The successful owner close already reaped the process group.
  }
}

describe.skipIf(process.platform === "win32")("the browser service's stop (TS17)", () => {
  it("exits 0 within seconds of SIGTERM half a second to a second after a cold profile open, every time", async () => {
    const { nativeRuntimeProfile } = await import("./native-profile.test-support.js");
    const { generateKeyPairSync, randomUUID, sign } = await import("node:crypto");
    const { fileURLToPath } = await import("node:url");
    const { WebSocket } = await import("ws");
    const main = fileURLToPath(new URL("../main.ts", import.meta.url));
    const signing = generateKeyPairSync("ed25519");
    const publicPem = signing.publicKey.export({ type: "spki", format: "pem" }).toString();
    const outcomes: { delayMs: number; exit: number | null; signal: string | null; ms: number }[] =
      [];
    const stopped: (string | null)[] = [];
    // oxlint-disable-next-line opensteer/no-polling-loop-in-tests -- Ten independent stops of a race; each waits for its own process's events.
    for (let round = 0; round < 10; round++) {
      const profile = await nativeRuntimeProfile();
      try {
        const runtimeId = `runtime_ts17_${round}`;
        const child = childProcess.spawn(process.execPath, ["--import", "tsx", main], {
          env: {
            ...process.env,
            OPENSTEER_BROWSER_ATTACH_PUBLIC_KEYS: JSON.stringify({ test: publicPem }),
            OPENSTEER_BROWSER_PROFILE_ROOT: profile.localProfiles.root,
            OPENSTEER_CHROMIUM_EXECUTABLE: executablePath,
            OPENSTEER_CHROMIUM_SANDBOX: "false",
            OPENSTEER_BROWSER_PORT: "0",
            OPENSTEER_BROWSER_RUNTIME_ID: runtimeId,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
        const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
          child.once("exit", (code, signal) => resolve({ code, signal })),
        );
        try {
          await vi.waitFor(() => expect(output).toContain('"browser-runtime.ready"'), {
            timeout: 30_000,
          });
          const ready = JSON.parse(
            output.split("\n").find((line) => line.includes('"browser-runtime.ready"'))!,
          ) as { host: string; port: number };
          const claims = validClaims({ identity: profile.identity, runtimeId });
          const header = Buffer.from(
            JSON.stringify({ alg: "EdDSA", kid: "test", typ: "opensteer-browser-attach+jwt" }),
          ).toString("base64url");
          const now = Date.now();
          const payload = Buffer.from(
            JSON.stringify({
              ...claims,
              nonce: randomUUID(),
              issuedAt: new Date(now).toISOString(),
              expiresAt: new Date(now + 60_000).toISOString(),
              operationExpiresAt: new Date(now + 18_000).toISOString(),
            }),
          ).toString("base64url");
          const content = `${header}.${payload}`;
          const ticket = `${content}.${sign(null, Buffer.from(content), signing.privateKey).toString("base64url")}`;
          // A cold open of the profile: its Chromium launches now.
          const socket = new WebSocket(`ws://${ready.host}:${ready.port}/v1/browser`, {
            headers: { authorization: `Bearer ${ticket}` },
          });
          socket.on("error", () => undefined);
          await vi.waitFor(() => expect(output).toContain('"stage":"chromium-launch"'), {
            timeout: 30_000,
          });
          const delayMs = 500 + Math.round(Math.random() * 500);
          // oxlint-disable-next-line opensteer/no-real-time-wait-in-tests -- The signal lands at a real moment of another process's Chromium launch; no fake clock reaches it.
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
          const signalled = performance.now();
          child.kill("SIGTERM");
          const end = await withTimeout(exited, 10_000, {
            timeoutError: () => new Error("The service did not exit."),
          }).catch(() => null);
          outcomes.push({
            delayMs,
            exit: end?.code ?? null,
            signal: end?.signal ?? null,
            ms: Math.round(performance.now() - signalled),
          });
          // The stop says it ended, and what it could not confirm.
          stopped.push(
            output.split("\n").find((line) => line.includes('"browser-runtime.stopped"')) ?? null,
          );
          socket.terminate();
        } finally {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
            await exited;
          }
        }
      } finally {
        await profile.close();
      }
    }
    process.stdout.write(`${JSON.stringify({ event: "ts17.service-stop", outcomes, stopped })}\n`);
    expect(stopped.filter((line) => line === null)).toEqual([]);
    // Every stop ended in a clean exit, within a few seconds of the signal.
    expect(outcomes.filter((outcome) => outcome.exit !== 0 || outcome.ms > 5_000)).toEqual([]);
  }, 600_000);
});
