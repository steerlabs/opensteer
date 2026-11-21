import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
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

function countDescendantRenderers(rootPid: number): number {
  const output = execFileSync("ps", ["-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const rows = output
    .trim()
    .split("\n")
    .map((line) => {
      const match = /^(\d+)\s+(\d+)\s+(.*)$/u.exec(line.trim());
      return match ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! } : null;
    })
    .filter((row): row is { pid: number; ppid: number; command: string } => row !== null);

  const byParent = new Map<number, typeof rows>();
  for (const row of rows) {
    const list = byParent.get(row.ppid) ?? [];
    list.push(row);
    byParent.set(row.ppid, list);
  }

  let renderers = 0;
  const visited = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of byParent.get(current) ?? []) {
      if (visited.has(child.pid)) continue;
      visited.add(child.pid);
      if (child.command.includes("--type=renderer")) renderers++;
      queue.push(child.pid);
    }
  }
  return renderers;
}

it("reaps renderer processes promptly after closing distinct-origin tabs in a native profile", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      "<!doctype html><html><body><p>Origin fixture</p><script>window.__payload = new Uint8Array(1024 * 1024).fill(1);</script></body></html>",
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server has no port.");

  const directory = await mkdtemp(path.join(tmpdir(), "os-renderer-leak-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));

  const launcher = new PlaywrightChromiumLauncher({
    executablePath,
    chromiumSandbox: false,
    headless: true,
  });
  const launched = await launcher.launch(nativeProfileRequest(directory));
  const playwrightContext = (
    launched as unknown as { playwrightContext: { process(): { pid: number } } }
  ).playwrightContext;
  const rootPid = playwrightContext.process().pid;

  const baselineRenderers = countDescendantRenderers(rootPid);
  const tabCount = 6;
  const pages = [];
  for (let i = 1; i <= tabCount; i++) {
    const page = await launched.context.createPage();
    const cdp = await page.cdp();
    await cdp.send("Page.navigate", { url: `http://site-${i}.localhost:${address.port}/page` });
    await vi.waitFor(
      async () => {
        const result = (await cdp.send("Runtime.evaluate", {
          expression: "document.readyState === 'complete' && window.__payload?.length === 1048576",
          returnByValue: true,
        })) as { result?: { value?: unknown } };
        expect(result.result?.value).toBe(true);
      },
      { timeout: 10_000 },
    );
    pages.push(page);
  }

  expect(countDescendantRenderers(rootPid)).toBeGreaterThanOrEqual(baselineRenderers + tabCount);

  for (const page of pages) await page.close();

  // Without --disable-field-trial-config, Chrome for Testing enables
  // TrackEmptyRendererProcessesForReuse and holds closed renderers alive past
  // TabSleeper's 3 s renderer settle window.
  await vi.waitFor(
    () => {
      expect(countDescendantRenderers(rootPid)).toBeLessThanOrEqual(baselineRenderers);
    },
    { timeout: 5_000, interval: 200 },
  );
});
