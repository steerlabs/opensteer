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
  snapshot: { cookies: [], origins: [] },
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
