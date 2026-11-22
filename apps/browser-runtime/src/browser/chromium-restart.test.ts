/**
 * L1: a Linux Home's browser never loads Chromium's last session. After a restart, clean or a
 * crash, the Home's tabs open fresh at their addresses; nothing of the last run comes back.
 */
import { SurfaceLedger } from "@opensteer/browser-runtime-core";
import { BrowserSurfaceIdSchema } from "@opensteer/protocol/browser";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  cleanup,
  findChromium,
  TestChromiumLauncher as PlaywrightChromiumLauncher,
} from "./browser-test-lifecycle.js";
import { nativeProfileRequest } from "./native-profile.test-support.js";

const executablePath = findChromium();
const surface = BrowserSurfaceIdSchema.parse("surface_00000000-0000-4000-8000-0000000l1001");

async function fixtureServer() {
  const hits = new Map<string, number>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html><body><h1>${url.pathname}</h1></body></html>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture address.");
  return {
    url: (pathname: string) => `http://site-1.localhost:${address.port}${pathname}`,
    hits: (pathname: string) => hits.get(pathname) ?? 0,
  };
}

type Cdp = { send<R = unknown>(method: string, params?: Record<string, unknown>): Promise<R> };

async function evaluate<T>(cdp: Cdp, expression: string): Promise<T> {
  const response = await cdp.send<{ result?: { value?: T } }>("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return response.result?.value as T;
}

const sessionsOf = (directory: string) =>
  readdir(path.join(directory, "Default", "Sessions")).catch(() => [] as string[]);

it.each(["clean exit", "SIGKILL"] as const)(
  "never loads Chromium's last session after a %s: nothing of the last run loads, and the Home's tab opens fresh at its address (L1)",
  async (ending) => {
    const server = await fixtureServer();
    const directory = await mkdtemp(path.join(tmpdir(), "os-chromium-restart-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const launcher = new PlaywrightChromiumLauncher({
      executablePath,
      chromiumSandbox: false,
      headless: true,
    });
    const request = nativeProfileRequest(directory);
    const first = await launcher.launch(request);
    const ledger1 = new SurfaceLedger(first.context);
    await ledger1.start();
    await ledger1.openSurface({ surfaceId: surface });
    const live = ledger1.binding(surface)!;
    await live.cdp.send("Page.navigate", { url: server.url("/article") });
    await vi.waitFor(
      async () => expect(await evaluate(live.cdp, "document.readyState")).toBe("complete"),
      { timeout: 10_000, interval: 50 },
    );
    await evaluate(live.cdp, `sessionStorage.setItem("mark", "first run")`);
    // Chromium wrote its session, with this tab in it, before the browser ends.
    await vi.waitFor(
      async () => {
        const files = (await sessionsOf(directory)).filter((name) => name.startsWith("Session_"));
        const bodies = await Promise.all(
          files.map((name) =>
            readFile(path.join(directory, "Default", "Sessions", name), "latin1"),
          ),
        );
        expect(bodies.some((body) => body.includes("/article"))).toBe(true);
      },
      { timeout: 15_000, interval: 250 },
    );
    if (ending === "SIGKILL") {
      const pid = (
        first as unknown as { playwrightContext: { process(): { pid: number } } }
      ).playwrightContext.process().pid;
      process.kill(-pid, "SIGKILL");
      await ledger1.close().catch(() => undefined);
      await first.close().catch(() => undefined);
    } else {
      await ledger1.close();
      await first.close();
    }
    const loads = server.hits("/article");

    const second = await launcher.launch(request);
    cleanup.push(() => second.close());
    expect(second.context.pages()).toEqual([]);
    const targets = (await second.cdp.send("Target.getTargets")) as {
      targetInfos: { type: string; url: string }[];
    };
    expect(targets.targetInfos.filter((target) => target.url.includes("/article"))).toEqual([]);
    expect(server.hits("/article")).toBe(loads);
    expect((await sessionsOf(directory)).filter((name) => name.startsWith("Session_"))).toEqual([]);
    const prefs = JSON.parse(
      await readFile(path.join(directory, "Default", "Preferences"), "utf8"),
    );
    expect(prefs.session.restore_on_startup).not.toBe(1);

    // The Home's tab comes back as a fresh page at its address, without the last run's state.
    const ledger2 = new SurfaceLedger(second.context);
    await ledger2.start();
    cleanup.push(() => ledger2.close());
    await ledger2.openSurface({ surfaceId: surface });
    const fresh = ledger2.binding(surface)!;
    expect(fresh.page.url()).toBe("about:blank");
    await fresh.cdp.send("Page.navigate", { url: server.url("/article") });
    await vi.waitFor(
      async () => expect(await evaluate(fresh.cdp, "document.readyState")).toBe("complete"),
      { timeout: 10_000, interval: 50 },
    );
    expect(await evaluate(fresh.cdp, `sessionStorage.getItem("mark")`)).toBeNull();
  },
  90_000,
);
