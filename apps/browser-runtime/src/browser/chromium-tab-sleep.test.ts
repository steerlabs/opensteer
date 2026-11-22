import { SessionCdpRouter } from "@opensteer/browser-core";
import {
  BrowserRuntimeServer,
  PageOwnership,
  SurfaceLedger,
  TabSleeper,
  standardCdpPath,
  type BrowserRuntime,
  type StandardCdpAttachment,
} from "@opensteer/browser-runtime-core";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  cleanup,
  findChromium,
  TestChromiumLauncher as PlaywrightChromiumLauncher,
} from "./browser-test-lifecycle.js";
import { nativeProfileRequest } from "./native-profile.test-support.js";
import type { ChromiumTabLifecycleBridge } from "./tab-lifecycle-extension.js";

const executablePath = findChromium();

/**
 * Launches and waits for the look for the tab helper to end, as the sleeper's next pass would: no
 * tab sleeps before it has (R1).
 */
async function launchReady(
  launcher: PlaywrightChromiumLauncher,
  request: Parameters<PlaywrightChromiumLauncher["launch"]>[0],
) {
  const launched = await launcher.launch(request);
  await (launched as unknown as { contextHandle: { lifecycleSettled: Promise<void> } })
    .contextHandle.lifecycleSettled;
  return launched;
}

function buildLoopingWavBuffer(): Buffer {
  const sampleRate = 8000;
  const numSamples = sampleRate * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + numSamples, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write("data", 36);
  header.writeUInt32LE(numSamples, 40);
  const data = Buffer.alloc(numSamples, 128);
  for (let i = 0; i < numSamples; i++) {
    data[i] = Math.round(128 + 30 * Math.sin((2 * Math.PI * 440 * i) / sampleRate));
  }
  return Buffer.concat([header, data]);
}

const wavBuffer = buildLoopingWavBuffer();

async function startFixtureServer() {
  let postCount = 0;
  const hits = new Map<string, number>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    hits.set(url.pathname + url.search, (hits.get(url.pathname + url.search) ?? 0) + 1);
    if (url.pathname === "/tone.wav") {
      response.writeHead(200, {
        "content-type": "audio/wav",
        "content-length": wavBuffer.length,
        "cache-control": "no-store",
      });
      response.end(wavBuffer);
      return;
    }
    if (url.pathname === "/article") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(
        `<!doctype html><html><head><title>Article</title></head><body style="height:8000px">
          <h1>Long Article</h1>
          <div style="height:7000px">Content</div>
          <script>window.__payload = new Uint8Array(1024 * 1024).fill(1);</script>
        </body></html>`,
      );
      return;
    }
    if (url.pathname === "/draft") {
      // A long page with a draft field: scroll, typed form state and session storage together.
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(
        `<!doctype html><html><head><title>Draft</title></head><body style="height:8000px">
          <input id="draft" name="draft" type="text" value="" />
          <div style="height:7000px">Content</div>
        </body></html>`,
      );
      return;
    }
    if (url.pathname === "/form") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(
        `<!doctype html><html><head><title>Form</title></head><body>
          <input id="text-input" name="title" type="text" value="" />
          <textarea id="notes" name="notes"></textarea>
          <select id="priority" name="priority">
            <option value="low">Low</option>
            <option value="high">High</option>
          </select>
          <input id="agree" name="agree" type="checkbox" />
          <input id="secret" name="secret" type="password" value="" />
        </body></html>`,
      );
      return;
    }
    if (url.pathname === "/spa" || url.pathname.startsWith("/spa/")) {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(
        `<!doctype html><html><head><title>SPA</title></head><body>
          <div id="route"></div>
          <script>
            document.getElementById("route").textContent = location.pathname;
            window.addEventListener("popstate", () => {
              document.getElementById("route").textContent = location.pathname;
            });
          </script>
        </body></html>`,
      );
      return;
    }
    if (url.pathname === "/session-storage") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(
        `<!doctype html><html><head><title>SessionStorage</title></head><body>
          <script>window.__readAtLoad = sessionStorage.getItem("wizard_step");</script>
        </body></html>`,
      );
      return;
    }
    if (url.pathname === "/post-form") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(
        `<!doctype html><html><body>
          <form method="POST" action="/post-result">
            <input name="order" value="ORD-9981" />
            <button id="submit" type="submit">Send</button>
          </form>
        </body></html>`,
      );
      return;
    }
    if (url.pathname === "/post-result") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const nonce = ++postCount;
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(
          `<!doctype html><html><body>
            <pre id="meta">${JSON.stringify({ method: request.method, body, nonce })}</pre>
          </body></html>`,
        );
      });
      return;
    }
    if (url.pathname === "/media") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(
        `<!doctype html><html><body>
          <audio id="player" src="/tone.wav" loop></audio>
        </body></html>`,
      );
      return;
    }
    response.writeHead(404);
    response.end("not found");
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
  if (!address || typeof address === "string") throw new Error("Fixture server has no address.");
  return {
    originForSite: (index: number) => `http://site-${index}.localhost:${address.port}`,
    /** Loads of one address (path and query), so a tab that loaded by itself is counted. */
    hits: (pathAndQuery: string) => hits.get(pathAndQuery) ?? 0,
  };
}

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

async function evalValue<T>(
  cdp: { send<R = unknown>(method: string, params?: Record<string, unknown>): Promise<R> },
  expression: string,
): Promise<T> {
  const response = (await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })) as { result?: { value?: T }; exceptionDetails?: { text?: string } };
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text ?? "Runtime.evaluate failed");
  }
  return response.result?.value as T;
}

async function waitLoaded(
  cdp: { send<R = unknown>(method: string, params?: Record<string, unknown>): Promise<R> },
  expectedPath?: string,
): Promise<void> {
  await vi.waitFor(
    async () => {
      const state = await evalValue<{ ready: boolean; pathname: string }>(
        cdp,
        "({ ready: document.readyState === 'complete', pathname: location.pathname })",
      );
      expect(state.ready).toBe(true);
      if (expectedPath) expect(state.pathname).toBe(expectedPath);
    },
    { timeout: 10_000, interval: 50 },
  );
}

it("sleeps native Chromium tabs by discarding, restores scroll/forms/SPA/sessionStorage, reaps renderers, and removes tabs closed while asleep", async () => {
  const server = await startFixtureServer();
  const directory = await mkdtemp(path.join(tmpdir(), "os-tab-sleep-fidelity-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));

  const launcher = new PlaywrightChromiumLauncher({
    executablePath,
    chromiumSandbox: false,
    headless: true,
  });
  const launched = await launchReady(launcher, nativeProfileRequest(directory));
  cleanup.push(() => launched.close());
  const internal = launched as unknown as {
    playwrightContext: { process(): { pid: number } };
    contextHandle: { lifecycleCandidate: ChromiumTabLifecycleBridge };
  };
  const rootPid = internal.playwrightContext.process().pid;
  const lifecycle = internal.contextHandle.lifecycleCandidate;

  const ledger = new SurfaceLedger(launched.context);
  await ledger.start();
  cleanup.push(() => ledger.close());

  const baselineRenderers = countDescendantRenderers(rootPid);

  // 1. Long article scrolled halfway
  const articleSurface = await ledger.openSurface();
  const articleLive = ledger.binding(articleSurface.id)!;
  await articleLive.cdp.send("Page.navigate", { url: `${server.originForSite(1)}/article` });
  await waitLoaded(articleLive.cdp, "/article");
  await evalValue(articleLive.cdp, "window.scrollTo(0, 2600)");

  // 2. Half-filled form (text, textarea, select, checkbox, password)
  const formSurface = await ledger.openSurface();
  const formLive = ledger.binding(formSurface.id)!;
  await formLive.cdp.send("Page.navigate", { url: `${server.originForSite(2)}/form` });
  await waitLoaded(formLive.cdp, "/form");
  await evalValue(formLive.cdp, "document.getElementById('text-input').focus()");
  await formLive.cdp.send("Input.insertText", { text: "Quarterly review" });
  await evalValue(formLive.cdp, "document.getElementById('notes').focus()");
  await formLive.cdp.send("Input.insertText", { text: "Line one" });
  await evalValue(
    formLive.cdp,
    `(() => {
      document.getElementById('priority').value = 'high';
      document.getElementById('agree').checked = true;
      document.getElementById('secret').focus();
    })()`,
  );
  await formLive.cdp.send("Input.insertText", { text: "s3cr3t-pass" });
  await evalValue(formLive.cdp, "document.activeElement.blur()");

  // 3. SPA with 3 pushState entries
  const spaSurface = await ledger.openSurface();
  const spaLive = ledger.binding(spaSurface.id)!;
  await spaLive.cdp.send("Page.navigate", { url: `${server.originForSite(3)}/spa` });
  await waitLoaded(spaLive.cdp, "/spa");
  await evalValue(
    spaLive.cdp,
    `(() => {
      history.pushState({ step: 1 }, "", "/spa/step-1");
      history.pushState({ step: 2 }, "", "/spa/step-2");
      history.pushState({ step: 3 }, "", "/spa/step-3");
      document.getElementById("route").textContent = location.pathname;
    })()`,
  );

  // 4. sessionStorage page
  const ssSurface = await ledger.openSurface();
  const ssLive = ledger.binding(ssSurface.id)!;
  await ssLive.cdp.send("Page.navigate", { url: `${server.originForSite(4)}/session-storage` });
  await waitLoaded(ssLive.cdp, "/session-storage");
  await evalValue(ssLive.cdp, `sessionStorage.setItem("wizard_step", "step-4-confirmed")`);

  // 5. Extra tab to close while asleep
  const closeAsleepSurface = await ledger.openSurface();
  const closeAsleepLive = ledger.binding(closeAsleepSurface.id)!;
  const closeAsleepUrl = `${server.originForSite(5)}/article`;
  await closeAsleepLive.cdp.send("Page.navigate", { url: closeAsleepUrl });
  await waitLoaded(closeAsleepLive.cdp, "/article");

  // All 5 distinct origins should have spawned renderer processes.
  expect(countDescendantRenderers(rootPid)).toBeGreaterThanOrEqual(baselineRenderers + 5);

  // Sleep all 5 tabs through SurfaceLedger.sleep()!
  for (const surface of [articleSurface, formSurface, spaSurface, ssSurface, closeAsleepSurface]) {
    expect(await ledger.sleep(surface.id, () => null)).toBe(true);
    expect(ledger.stateOf(surface.id)).toBe("suspended");
  }

  // Renderer processes of all 5 sleeping tabs must exit promptly.
  await vi.waitFor(
    () => {
      expect(countDescendantRenderers(rootPid)).toBeLessThanOrEqual(baselineRenderers);
    },
    { timeout: 5_000, interval: 200 },
  );

  // Verify the 5th tab is currently discarded in Chromium, then close it while asleep and verify it leaves Chromium.
  const inventoryWhileAsleep = await lifecycle.inventory();
  expect(inventoryWhileAsleep.some((tab) => tab.url === closeAsleepUrl && tab.discarded)).toBe(
    true,
  );
  await ledger.closeSurface(closeAsleepSurface.id);
  const inventoryAfterClose = await lifecycle.inventory();
  expect(inventoryAfterClose.some((tab) => tab.url === closeAsleepUrl)).toBe(false);

  // Wake each of the 4 remaining tabs and verify fidelity!
  const articleWoken = await ledger.wake(articleSurface.id);
  await waitLoaded(articleWoken.cdp, "/article");
  await vi.waitFor(
    async () => {
      expect(await evalValue<number>(articleWoken.cdp, "window.scrollY")).toBe(2600);
    },
    { timeout: 3_000, interval: 50 },
  );

  const formWoken = await ledger.wake(formSurface.id);
  await waitLoaded(formWoken.cdp, "/form");
  const formState = await evalValue<{
    text: string;
    notes: string;
    priority: string;
    agree: boolean;
    password: string;
  }>(
    formWoken.cdp,
    `({
      text: document.getElementById('text-input').value,
      notes: document.getElementById('notes').value,
      priority: document.getElementById('priority').value,
      agree: document.getElementById('agree').checked,
      password: document.getElementById('secret').value,
    })`,
  );
  expect(formState).toEqual({
    text: "Quarterly review",
    notes: "Line one",
    priority: "high",
    agree: true,
    password: "",
  });

  const spaWoken = await ledger.wake(spaSurface.id);
  await waitLoaded(spaWoken.cdp, "/spa/step-3");
  const spaBeforeBack = await evalValue<{ pathname: string; state: unknown; length: number }>(
    spaWoken.cdp,
    "({ pathname: location.pathname, state: history.state, length: history.length })",
  );
  expect(spaBeforeBack.pathname).toBe("/spa/step-3");
  expect(spaBeforeBack.state).toEqual({ step: 3 });
  expect(spaBeforeBack.length).toBeGreaterThanOrEqual(4);
  const history = (await spaWoken.cdp.send("Page.getNavigationHistory")) as {
    currentIndex: number;
    entries: readonly { id: number; url: string }[];
  };
  const backEntry = history.entries[history.currentIndex - 1]!;
  expect(backEntry.url).toContain("/spa/step-2");
  await spaWoken.cdp.send("Page.navigateToHistoryEntry", { entryId: backEntry.id });
  await waitLoaded(spaWoken.cdp, "/spa/step-2");
  expect(await evalValue<unknown>(spaWoken.cdp, "history.state")).toEqual({ step: 2 });

  const ssWoken = await ledger.wake(ssSurface.id);
  await waitLoaded(ssWoken.cdp, "/session-storage");
  const ssState = await evalValue<{ readAtLoad: string | null; live: string | null }>(
    ssWoken.cdp,
    `({ readAtLoad: window.__readAtLoad, live: sessionStorage.getItem("wizard_step") })`,
  );
  expect(ssState).toEqual({
    readAtLoad: "step-4-confirmed",
    live: "step-4-confirmed",
  });
});

it("keeps POST result and playing media tabs awake via existing blockers on native Chromium", async () => {
  const server = await startFixtureServer();
  const directory = await mkdtemp(path.join(tmpdir(), "os-tab-sleep-blockers-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));

  const launcher = new PlaywrightChromiumLauncher({
    executablePath,
    chromiumSandbox: false,
    headless: true,
  });
  const launched = await launchReady(launcher, nativeProfileRequest(directory));
  cleanup.push(() => launched.close());
  const ledger = new SurfaceLedger(launched.context);
  await ledger.start();
  cleanup.push(() => ledger.close());

  // POST result page must stay awake
  const postSurface = await ledger.openSurface();
  const postLive = ledger.binding(postSurface.id)!;
  await postLive.cdp.send("Page.navigate", { url: `${server.originForSite(1)}/post-form` });
  await waitLoaded(postLive.cdp, "/post-form");
  await evalValue(postLive.cdp, "setTimeout(() => document.getElementById('submit').click(), 0)");
  await waitLoaded(postLive.cdp, "/post-result");
  expect(await postLive.page.keepAwake?.()).toBe("post");
  expect(await ledger.sleep(postSurface.id, () => null)).toBe(false);
  expect(ledger.stateOf(postSurface.id)).toBe("live");
  const postMeta = JSON.parse(
    await evalValue<string>(postLive.cdp, "document.getElementById('meta').textContent"),
  ) as { method: string; body: string };
  expect(postMeta.method).toBe("POST");
  expect(postMeta.body).toContain("ORD-9981");

  // Playing media page must stay awake
  const mediaSurface = await ledger.openSurface();
  const mediaLive = ledger.binding(mediaSurface.id)!;
  await mediaLive.cdp.send("Page.navigate", { url: `${server.originForSite(2)}/media` });
  await waitLoaded(mediaLive.cdp, "/media");
  const playEval = (await mediaLive.cdp.send("Runtime.evaluate", {
    expression: `document.getElementById('player').play().then(() => true, () => false)`,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  })) as { result?: { value?: boolean } };
  expect(playEval.result?.value).toBe(true);
  expect(await mediaLive.page.keepAwake?.()).toBe("media");
  expect(await ledger.sleep(mediaSurface.id, () => null)).toBe(false);
  expect(ledger.stateOf(mediaSurface.id)).toBe("live");
});

it("hides the helper extension from tab lists, session CDP, and connected agents", async () => {
  const server = await startFixtureServer();
  const directory = await mkdtemp(path.join(tmpdir(), "os-tab-sleep-isolation-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));

  const launcher = new PlaywrightChromiumLauncher({
    executablePath,
    chromiumSandbox: false,
    headless: true,
  });
  const launched = await launcher.launch(nativeProfileRequest(directory));
  cleanup.push(() => launched.close());
  const internal = launched as unknown as {
    browserCdp: { send(method: string, params?: Record<string, unknown>): Promise<unknown> };
    contextHandle: { lifecycleCandidate: ChromiumTabLifecycleBridge };
  };

  // Ensure the helper extension worker is loaded and running in Chromium.
  const initialInventory = await internal.contextHandle.lifecycleCandidate.inventory();
  expect(initialInventory.length).toBeGreaterThanOrEqual(1);
  const rawTargets = (await internal.browserCdp.send("Target.getTargets")) as {
    targetInfos: readonly { targetId: string; type: string; url: string }[];
  };
  const swTarget = rawTargets.targetInfos.find(
    (target) => target.type === "service_worker" && target.url.startsWith("chrome-extension://"),
  );
  expect(swTarget).toBeDefined();

  const ledger = new SurfaceLedger(launched.context);
  await ledger.start();
  cleanup.push(() => ledger.close());

  const userSurface = await ledger.openSurface();
  const userLive = ledger.binding(userSurface.id)!;
  await userLive.cdp.send("Page.navigate", { url: `${server.originForSite(1)}/article` });
  await waitLoaded(userLive.cdp, "/article");

  // 1. Not visible in any tab list a person or agent reads
  expect(
    launched.context.pages().every((page) => !page.url().startsWith("chrome-extension://")),
  ).toBe(true);
  expect(ledger.snapshot().every((surface) => !surface.url.startsWith("chrome-extension://"))).toBe(
    true,
  );
  expect(ledger.snapshot().map((surface) => surface.id)).toEqual([userSurface.id]);

  // 2. Not visible in the launched browser's CDP backend (used by whole-context / session CDP)
  const filteredTargets = (await launched.cdp.send("Target.getTargets")) as {
    targetInfos: readonly { targetId: string; type: string; url: string }[];
  };
  expect(
    filteredTargets.targetInfos.some((target) => target.url.startsWith("chrome-extension://")),
  ).toBe(false);
  await expect(launched.cdp.attach(swTarget!.targetId)).rejects.toThrow(/not an attachable page/);
  await expect(
    launched.cdp.send("Target.attachToTarget", { targetId: swTarget!.targetId }),
  ).rejects.toThrow(/not an attachable page/);

  // 3. Not visible to a connected agent through SessionCdpRouter (both session-scoped and whole-context)
  const router = new SessionCdpRouter(launched.cdp);
  cleanup.push(() => router.close());
  router.registerSession("session-isolation", userLive.targetId, async () => false, directory);
  const agentClient = router.openStandardClient("session-isolation", { wholeContext: false });
  const agentTargets = (await agentClient.send({ method: "Target.getTargets" })) as {
    targetInfos: readonly { targetId: string; url: string }[];
  };
  expect(agentTargets.targetInfos.map((target) => target.targetId)).toEqual([userLive.targetId]);
  expect(
    agentTargets.targetInfos.some((target) => target.url.startsWith("chrome-extension://")),
  ).toBe(false);
  await expect(
    agentClient.send({
      method: "Target.attachToTarget",
      parameters: { targetId: swTarget!.targetId, flatten: true },
    }),
  ).rejects.toThrow();
  await agentClient.close();

  const wholeContextClient = router.openStandardClient("session-isolation", { wholeContext: true });
  const wholeTargets = (await wholeContextClient.send({ method: "Target.getTargets" })) as {
    targetInfos: readonly { targetId: string; url: string }[];
  };
  expect(
    wholeTargets.targetInfos.some((target) => target.url.startsWith("chrome-extension://")),
  ).toBe(false);
  await wholeContextClient.close();
});

it("removes sleeping tabs with evidence on session end and cold restart brings none back", async () => {
  const server = await startFixtureServer();
  const directory = await mkdtemp(path.join(tmpdir(), "os-tab-sleep-session-end-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));

  const launcher = new PlaywrightChromiumLauncher({
    executablePath,
    chromiumSandbox: false,
    headless: true,
  });
  const request = nativeProfileRequest(directory);
  const launched = await launchReady(launcher, request);
  cleanup.push(() => launched.close());
  const internal = launched as unknown as {
    contextHandle: { lifecycleCandidate: ChromiumTabLifecycleBridge };
  };
  const lifecycle = internal.contextHandle.lifecycleCandidate;

  const ledger = new SurfaceLedger(launched.context);
  await ledger.start();
  cleanup.push(() => ledger.close());

  const url = `${server.originForSite(1)}/article`;
  const surface = await ledger.openSurface({ origin: "agent" });
  const live = ledger.binding(surface.id)!;
  await live.cdp.send("Page.navigate", { url });
  await waitLoaded(live.cdp, "/article");

  expect(await ledger.sleep(surface.id, () => null)).toBe(true);
  expect(ledger.stateOf(surface.id)).toBe("suspended");

  // Confirm the sleeping tab is currently discarded in Chromium.
  const invWhileAsleep = await lifecycle.inventory();
  expect(invWhileAsleep.some((tab) => tab.url === url && tab.discarded)).toBe(true);

  // If the removal attempt fails (the helper and the target close both refuse), confirmed session
  // end must refuse and keep the restore handle for retry.
  const handle = (
    launched as unknown as {
      contextHandle: { closeTarget: ((id: string) => Promise<void>) | undefined };
    }
  ).contextHandle;
  const closeTarget = handle.closeTarget;
  handle.closeTarget = async () => {
    throw new Error("closeTarget refused");
  };
  const spy = vi.spyOn(lifecycle, "removeByTabId").mockResolvedValue(false);
  await expect(ledger.closeOwnedPages("session-ended", true)).rejects.toThrow(
    /Pages are still closing/,
  );
  spy.mockRestore();
  handle.closeTarget = closeTarget;

  // Retrying confirmed session end removes the sleeping tab from Chromium with evidence.
  await ledger.closeOwnedPages("session-ended", true);
  const invAfterEnd = await lifecycle.inventory();
  expect(invAfterEnd.some((tab) => tab.url === url)).toBe(false);

  // Cold restart must bring none of the ended session's sleeping tabs back.
  await ledger.close();
  await launched.close();
  const restarted = await launcher.launch(request);
  cleanup.push(() => restarted.close());
  const internal2 = restarted as unknown as {
    contextHandle: { lifecycleCandidate: ChromiumTabLifecycleBridge };
  };
  const invAfterRestart = await internal2.contextHandle.lifecycleCandidate.inventory();
  expect(invAfterRestart.some((tab) => tab.url === url)).toBe(false);
});

it("still sleeps and wakes by address without marking unrestorable when the helper fails during capture or discard", async () => {
  const server = await startFixtureServer();
  const directory = await mkdtemp(path.join(tmpdir(), "os-tab-sleep-helper-fallback-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));

  const launcher = new PlaywrightChromiumLauncher({
    executablePath,
    chromiumSandbox: false,
    headless: true,
  });
  const launched = await launchReady(launcher, nativeProfileRequest(directory));
  cleanup.push(() => launched.close());
  const internal = launched as unknown as {
    contextHandle: { lifecycleCandidate: ChromiumTabLifecycleBridge };
  };
  const lifecycle = internal.contextHandle.lifecycleCandidate;

  const ledger = new SurfaceLedger(launched.context);
  await ledger.start();
  cleanup.push(() => ledger.close());

  // Tab 1: helper inventory throws during sleep -> must STILL sleep and wake by address!
  const url1 = `${server.originForSite(1)}/article`;
  const s1 = await ledger.openSurface();
  const live1 = ledger.binding(s1.id)!;
  await live1.cdp.send("Page.navigate", { url: url1 });
  await waitLoaded(live1.cdp, "/article");

  const invSpy = vi
    .spyOn(lifecycle, "inventory")
    .mockRejectedValue(new Error("Helper worker crashed"));
  expect(await ledger.sleep(s1.id, () => null)).toBe(true);
  expect(ledger.stateOf(s1.id)).toBe("suspended");
  const rec1 = [...ledger.policyRecords()].find((r) => r.id === s1.id)!;
  expect(rec1.unrestorable).toBe(false);
  invSpy.mockRestore();

  const woken1 = await ledger.wake(s1.id);
  await waitLoaded(woken1.cdp, "/article");

  // Tab 2: the helper's discard fails -> closes cleanly and wakes by address!
  const url2 = `${server.originForSite(2)}/article`;
  const s2 = await ledger.openSurface();
  const live2 = ledger.binding(s2.id)!;
  await live2.cdp.send("Page.navigate", { url: url2 });
  await waitLoaded(live2.cdp, "/article");

  const discardSpy = vi.spyOn(lifecycle, "nameAndDiscard").mockResolvedValue(null);
  expect(await ledger.sleep(s2.id, () => null)).toBe(true);
  expect(ledger.stateOf(s2.id)).toBe("suspended");
  discardSpy.mockRestore();

  const woken2 = await ledger.wake(s2.id);
  await waitLoaded(woken2.cdp, "/article");
});

it("serializes immediate wake behind an in-flight discard and settles helper timeouts via inventory with zero orphan tabs", async () => {
  const server = await startFixtureServer();
  const directory = await mkdtemp(path.join(tmpdir(), "os-tab-sleep-f4-race-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));

  const launcher = new PlaywrightChromiumLauncher({
    executablePath,
    chromiumSandbox: false,
    headless: true,
  });
  const launched = await launchReady(launcher, nativeProfileRequest(directory));
  cleanup.push(() => launched.close());
  const internal = launched as unknown as {
    contextHandle: { lifecycleCandidate: ChromiumTabLifecycleBridge };
  };
  const lifecycle = internal.contextHandle.lifecycleCandidate;

  const ledger = new SurfaceLedger(launched.context);
  await ledger.start();
  cleanup.push(() => ledger.close());

  // Case A: wake starts while the discard's reply is still in flight after Chromium discarded the tab.
  const urlA = `${server.originForSite(1)}/article`;
  const sA = await ledger.openSurface();
  const liveA = ledger.binding(sA.id)!;
  await liveA.cdp.send("Page.navigate", { url: urlA });
  await waitLoaded(liveA.cdp, "/article");
  await evalValue(liveA.cdp, "window.scrollTo(0, 1750)");

  const origDiscard = lifecycle.nameAndDiscard.bind(lifecycle);
  const releaseReply = Promise.withResolvers<void>();
  const discardSpyA = vi
    .spyOn(lifecycle, "nameAndDiscard")
    .mockImplementation(async (tabId, name) => {
      const newId = await origDiscard(tabId, name);
      await releaseReply.promise;
      return newId;
    });

  // ledger.sleep returns as soon as Chromium closes the WebContents during discard,
  // while the discard's reply is still held!
  expect(await ledger.sleep(sA.id, () => null)).toBe(true);
  const createPageEntered = Promise.withResolvers<void>();
  const origCreatePage = launched.context.createPage.bind(launched.context);
  const createPageSpy = vi
    .spyOn(launched.context, "createPage")
    .mockImplementation(async (options) => {
      createPageEntered.resolve();
      return origCreatePage(options);
    });
  const wakePromise = ledger.wake(sA.id);
  // Release the discard reply after wake has already entered createPage.
  await createPageEntered.promise;
  releaseReply.resolve();
  const wokenA = await wakePromise;
  createPageSpy.mockRestore();
  discardSpyA.mockRestore();

  await waitLoaded(wokenA.cdp, "/article");
  await vi.waitFor(
    async () => expect(await evalValue<number>(wokenA.cdp, "window.scrollY")).toBe(1750),
    { timeout: 3_000, interval: 50 },
  );
  const invA = await lifecycle.inventory();
  expect(invA.filter((tab) => tab.url === urlA)).toHaveLength(1);

  // Case B: the discard's reply is lost (throws/times out) AFTER Chromium already discarded the tab!
  const urlB = `${server.originForSite(2)}/article`;
  const sB = await ledger.openSurface();
  const liveB = ledger.binding(sB.id)!;
  await liveB.cdp.send("Page.navigate", { url: urlB });
  await waitLoaded(liveB.cdp, "/article");
  await evalValue(liveB.cdp, "window.scrollTo(0, 2350)");

  const discardSpyB = vi
    .spyOn(lifecycle, "nameAndDiscard")
    .mockImplementation(async (tabId, name) => {
      await origDiscard(tabId, name);
      throw new Error("Opensteer tab lifecycle helper call timed out.");
    });
  expect(await ledger.sleep(sB.id, () => null)).toBe(true);
  discardSpyB.mockRestore();

  const wokenB = await ledger.wake(sB.id);
  await waitLoaded(wokenB.cdp, "/article");
  await vi.waitFor(
    async () => expect(await evalValue<number>(wokenB.cdp, "window.scrollY")).toBe(2350),
    { timeout: 3_000, interval: 50 },
  );
  const invB = await lifecycle.inventory();
  expect(invB.filter((tab) => tab.url === urlB)).toHaveLength(1);
});

it("hands off new popups synchronously, without dropping short-lived popups", async () => {
  const server = await startFixtureServer();
  const directory = await mkdtemp(path.join(tmpdir(), "os-tab-sleep-f6-handoff-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));

  const launcher = new PlaywrightChromiumLauncher({
    executablePath,
    chromiumSandbox: false,
    headless: true,
  });
  const request = nativeProfileRequest(directory);

  const b2 = await launcher.launch(request);
  cleanup.push(() => b2.close());
  const internal2 = b2 as unknown as {
    playwrightContext: { on(event: string, listener: (p: unknown) => void): void };
  };

  // Open an ordinary page: the runtime's own, so its popups are published by it (K3).
  const opener = await b2.context.createPage();
  const openerCdp = await opener.cdp();
  await openerCdp.send("Page.navigate", { url: `${server.originForSite(2)}/article` });
  await waitLoaded(openerCdp, "/article");

  // Track whether handOff fires synchronously on the same turn as Playwright's "page" event
  // (NOT deferred behind async CDP/inventory routing).
  let handOffCount = 0;
  let handOffOpenerMatched = false;
  let sawSyncHandOff = false;
  const unsubscribe = b2.context.handOff((page, pageOpener) => {
    if (page !== opener) {
      handOffCount++;
      handOffOpenerMatched = pageOpener === opener;
    }
  });
  cleanup.push(async () => unsubscribe());
  internal2.playwrightContext.on("page", () => {
    if (handOffCount > 0) sawSyncHandOff = true;
  });

  // Trigger a short-lived popup that closes itself immediately after opening!
  const openedPopup = (await openerCdp.send("Runtime.evaluate", {
    expression: `(() => {
      const w = window.open("${server.originForSite(2)}/form", "_blank");
      if (w) setTimeout(() => w.close(), 15);
      return Boolean(w);
    })()`,
    returnByValue: true,
    userGesture: true,
  })) as { result?: { value?: boolean } };
  expect(openedPopup.result?.value).toBe(true);

  await vi.waitFor(() => expect(handOffCount).toBe(1), { timeout: 5_000, interval: 25 });
  expect(sawSyncHandOff).toBe(true);
  expect(handOffOpenerMatched).toBe(true);
});

it("refuses closing a sleeping tab retryably until Chromium confirms removal, then succeeds on retry", async () => {
  const server = await startFixtureServer();
  const directory = await mkdtemp(path.join(tmpdir(), "os-tab-sleep-f7-close-proof-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));

  const launcher = new PlaywrightChromiumLauncher({
    executablePath,
    chromiumSandbox: false,
    headless: true,
  });
  const launched = await launchReady(launcher, nativeProfileRequest(directory));
  cleanup.push(() => launched.close());
  const internal = launched as unknown as {
    contextHandle: { lifecycleCandidate: ChromiumTabLifecycleBridge };
  };
  const lifecycle = internal.contextHandle.lifecycleCandidate;

  const ledger = new SurfaceLedger(launched.context);
  await ledger.start();
  cleanup.push(() => ledger.close());

  const closedEvents: string[] = [];
  ledger.subscribe((event) => {
    if (event.type === "changed" && event.change === "closed") closedEvents.push(event.surface.id);
  });

  const url = `${server.originForSite(1)}/article`;
  const surface = await ledger.openSurface();
  const live = ledger.binding(surface.id)!;
  await live.cdp.send("Page.navigate", { url });
  await waitLoaded(live.cdp, "/article");
  expect(await ledger.sleep(surface.id, () => null)).toBe(true);

  // Fail one removal attempt (helper and target close) -> closeSurface must reject retryably,
  // keep the tab listed, emit no closed event.
  const handle = (
    launched as unknown as {
      contextHandle: { closeTarget: ((id: string) => Promise<void>) | undefined };
    }
  ).contextHandle;
  const closeTarget = handle.closeTarget;
  handle.closeTarget = async () => {
    throw new Error("closeTarget refused");
  };
  const removeSpy = vi.spyOn(lifecycle, "removeByTabId").mockResolvedValue(false);
  await expect(ledger.closeSurface(surface.id)).rejects.toThrow(/This tab is still closing/);
  expect(ledger.snapshot().some((s) => s.id === surface.id)).toBe(true);
  expect(closedEvents).toEqual([]);
  removeSpy.mockRestore();
  handle.closeTarget = closeTarget;

  // Retry succeeds once Chromium confirms removal.
  await ledger.closeSurface(surface.id);
  expect(ledger.snapshot().some((s) => s.id === surface.id)).toBe(false);
  expect(closedEvents).toEqual([surface.id]);
  const invAfter = await lifecycle.inventory();
  expect(invAfter.some((tab) => tab.url === url)).toBe(false);

  // Same proof for closeDurableSurface!
  const url2 = `${server.originForSite(2)}/article`;
  const s2 = await ledger.openSurface();
  const live2 = ledger.binding(s2.id)!;
  await live2.cdp.send("Page.navigate", { url: url2 });
  await waitLoaded(live2.cdp, "/article");
  expect(await ledger.sleep(s2.id, () => null)).toBe(true);

  handle.closeTarget = async () => {
    throw new Error("closeTarget refused");
  };
  const removeSpy2 = vi.spyOn(lifecycle, "removeByTabId").mockResolvedValue(false);
  await expect(ledger.closeDurableSurface(s2.id)).rejects.toThrow(/This tab is still closing/);
  expect(ledger.snapshot().some((s) => s.id === s2.id)).toBe(true);
  removeSpy2.mockRestore();
  handle.closeTarget = closeTarget;

  await ledger.closeDurableSurface(s2.id);
  expect(ledger.snapshot().some((s) => s.id === s2.id)).toBe(false);
  const invAfter2 = await lifecycle.inventory();
  expect(invAfter2.some((tab) => tab.url === url2)).toBe(false);
});

it("wakes a stopped helper worker via ServiceWorker.startWorker without creating any visible page target", async () => {
  const server = await startFixtureServer();
  const directory = await mkdtemp(path.join(tmpdir(), "os-tab-sleep-f9-sw-wake-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));

  const launcher = new PlaywrightChromiumLauncher({
    executablePath,
    chromiumSandbox: false,
    headless: true,
  });
  const launched = await launchReady(launcher, nativeProfileRequest(directory));
  cleanup.push(() => launched.close());
  const internal = launched as unknown as {
    browserCdp: {
      send(method: string, params?: Record<string, unknown>): Promise<unknown>;
      on(event: string, listener: (p: unknown) => void): void;
      off(event: string, listener: (p: unknown) => void): void;
    };
    playwrightContext: {
      newCDPSession(
        page: unknown,
      ): Promise<{ send(m: string, p?: unknown): Promise<unknown>; detach(): Promise<void> }>;
    };
    persistencePage: { goto(url: string): Promise<unknown>; close(): Promise<void> };
    contextHandle: { lifecycleCandidate: ChromiumTabLifecycleBridge };
  };
  const lifecycle = internal.contextHandle.lifecycleCandidate;

  const ledger = new SurfaceLedger(launched.context);
  await ledger.start();
  cleanup.push(() => ledger.close());

  const url = `${server.originForSite(1)}/article`;
  const surface = await ledger.openSurface();
  const live = ledger.binding(surface.id)!;
  await live.cdp.send("Page.navigate", { url });
  await waitLoaded(live.cdp, "/article");

  // Confirm helper SW is running, then stop it via CDP ServiceWorker.stopWorker.
  const targetsBefore = (await internal.browserCdp.send("Target.getTargets")) as {
    targetInfos: readonly { targetId: string; type: string; url: string }[];
  };
  const swBefore = targetsBefore.targetInfos.find(
    (t) => t.type === "service_worker" && t.url.endsWith("/sw.js"),
  );
  expect(swBefore).toBeDefined();
  const extOrigin = /^(chrome-extension:\/\/[^/]+)/u.exec(swBefore!.url)?.[1];
  expect(extOrigin).toBeTruthy();

  await internal.persistencePage.goto(`${extOrigin}/manifest.json`);
  const stopSession = await internal.playwrightContext.newCDPSession(internal.persistencePage);
  try {
    let versionId: string | undefined;
    (
      stopSession as unknown as {
        on(
          e: string,
          fn: (p: { versions?: { versionId: string; status: string }[] }) => void,
        ): void;
      }
    ).on("ServiceWorker.workerVersionUpdated", (params) => {
      const running = params.versions?.find((v) => v.status === "activated");
      if (running) versionId = running.versionId;
    });
    await stopSession.send("ServiceWorker.enable");
    await vi.waitFor(() => expect(versionId).toBeTruthy(), { timeout: 3_000, interval: 25 });
    await stopSession.send("ServiceWorker.stopWorker", { versionId });
  } finally {
    await stopSession.detach().catch(() => undefined);
  }

  await vi.waitFor(
    async () => {
      const t = (await internal.browserCdp.send("Target.getTargets")) as {
        targetInfos: readonly { type: string; url: string }[];
      };
      expect(
        t.targetInfos.some((x) => x.type === "service_worker" && x.url.endsWith("/sw.js")),
      ).toBe(false);
    },
    { timeout: 5_000, interval: 50 },
  );

  // Watch for any created page target during wake -> must be ZERO!
  const createdPages: unknown[] = [];
  const onCreated = (params: unknown) => {
    const info = (params as { targetInfo?: { type?: string } })?.targetInfo;
    if (info?.type === "page") createdPages.push(info);
  };
  internal.browserCdp.on("Target.targetCreated", onCreated);
  const handedOff: unknown[] = [];
  const unsub = launched.context.handOff((p) => {
    if (p !== live.page) handedOff.push(p);
  });
  cleanup.push(async () => {
    internal.browserCdp.off("Target.targetCreated", onCreated);
    unsub();
  });

  // Calling inventory() must wake the stopped worker and return our live tab with zero created pages!
  const inv = await lifecycle.inventory();
  expect(inv.some((t) => t.url === url)).toBe(true);
  expect(createdPages).toEqual([]);
  expect(handedOff).toEqual([]);

  // Also prove wakeServiceWorker never falls back to Target.createTarget even if privatePage is closed!
  await internal.persistencePage.close();
  const createSpy = vi.spyOn(internal.browserCdp, "send");
  const wakeMethod = (
    lifecycle as unknown as { wakeServiceWorker(): Promise<void> }
  ).wakeServiceWorker.bind(lifecycle);
  await wakeMethod();
  expect(createSpy.mock.calls.some(([method]) => method === "Target.createTarget")).toBe(false);
  createSpy.mockRestore();
});

it("does not steal foreground visibility or pause screencasting when a background tab sleeps", async () => {
  const server = await startFixtureServer();
  const directory = await mkdtemp(path.join(tmpdir(), "os-tab-sleep-f11-visibility-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));

  const launcher = new PlaywrightChromiumLauncher({
    executablePath,
    chromiumSandbox: false,
    headless: true,
  });
  const launched = await launchReady(launcher, nativeProfileRequest(directory));
  cleanup.push(() => launched.close());
  const internal = launched as unknown as {
    contextHandle: {
      lifecycleCandidate: ChromiumTabLifecycleBridge;
      activatePrivateAnchor(): Promise<void>;
    };
  };
  const ledger = new SurfaceLedger(launched.context);
  await ledger.start();
  cleanup.push(() => ledger.close());

  // Background tab to sleep
  const bg = await ledger.openSurface();
  const bgLive = ledger.binding(bg.id)!;
  await bgLive.cdp.send("Page.navigate", { url: `${server.originForSite(1)}/article` });
  await waitLoaded(bgLive.cdp, "/article");
  await evalValue(bgLive.cdp, "window.scrollTo(0, 1900)");

  // Foreground active tab being watched via screencast
  const fgUrl = `${server.originForSite(2)}/article`;
  const fg = await ledger.openSurface();
  const fgLive = ledger.binding(fg.id)!;
  await fgLive.cdp.send("Page.navigate", { url: fgUrl });
  await waitLoaded(fgLive.cdp, "/article");
  await fgLive.cdp.send("Page.bringToFront");
  await evalValue(
    fgLive.cdp,
    `(() => {
      window.__hiddenCount = 0;
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") window.__hiddenCount++;
      });
      return document.visibilityState;
    })()`,
  );
  expect(await evalValue<string>(fgLive.cdp, "document.visibilityState")).toBe("visible");

  let frames = 0;
  const onFrame = (params: unknown) => {
    const sessionId = (params as { sessionId?: number })?.sessionId;
    frames++;
    if (typeof sessionId === "number") {
      void fgLive.cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
    }
  };
  fgLive.cdp.on("Page.screencastFrame", onFrame);
  await fgLive.cdp.send("Page.startScreencast", { format: "jpeg", quality: 60 });
  await vi.waitFor(() => expect(frames).toBeGreaterThanOrEqual(1), {
    timeout: 5_000,
    interval: 50,
  });

  // Sleep background tab -> foreground tab must stay Chromium's active tab and NEVER lose focus/visibility!
  const anchorSpy = vi.spyOn(internal.contextHandle, "activatePrivateAnchor");
  expect(await ledger.sleep(bg.id, () => null)).toBe(true);
  expect(ledger.stateOf(bg.id)).toBe("suspended");
  expect(anchorSpy).not.toHaveBeenCalled();
  anchorSpy.mockRestore();

  const invAfterSleep = await internal.contextHandle.lifecycleCandidate.inventory();
  expect(invAfterSleep.find((t) => t.url === fgUrl)?.active).toBe(true);
  expect(await evalValue<string>(fgLive.cdp, "document.visibilityState")).toBe("visible");
  expect(await evalValue<number>(fgLive.cdp, "window.__hiddenCount")).toBe(0);

  // Screencast must continue delivering frames on the foreground tab after background sleep.
  const framesAfterSleep = frames;
  await evalValue(fgLive.cdp, "document.body.style.background = '#d0f0d0'");
  await vi.waitFor(() => expect(frames).toBeGreaterThan(framesAfterSleep), {
    timeout: 5_000,
    interval: 50,
  });
  await fgLive.cdp.send("Page.stopScreencast").catch(() => undefined);
  fgLive.cdp.off("Page.screencastFrame", onFrame);

  // Background tab still wakes with its scroll state intact.
  const bgWoken = await ledger.wake(bg.id);
  await waitLoaded(bgWoken.cdp, "/article");
  await vi.waitFor(
    async () => expect(await evalValue<number>(bgWoken.cdp, "window.scrollY")).toBe(1900),
    { timeout: 3_000, interval: 50 },
  );
});

/** The surface of the session's ledger whose page is at an address containing `part`. */
function surfaceAt(ledger: SurfaceLedger, part: string) {
  return ledger.snapshot().find((surface) => ledger.binding(surface.id)?.page.url().includes(part));
}

async function selfClosingSetup(asleep: boolean) {
  const server = await startFixtureServer();
  const directory = await mkdtemp(path.join(tmpdir(), "os-tab-sleep-q1-self-closing-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const launcher = new PlaywrightChromiumLauncher({
    executablePath,
    chromiumSandbox: false,
    headless: true,
  });
  const launched = await launchReady(launcher, nativeProfileRequest(directory));
  cleanup.push(() => launched.close());
  // As the runtime builds a session: one ownership for the browser, a root page the session
  // created, and a ledger that takes only the pages ownership gives the session (its root's
  // popups, by their opener).
  const pages = new PageOwnership();
  pages.adopt(launched.context);
  const session = "session-q1";
  const root = await pages.create(session, null, "open-failed", (own, signal) =>
    launched.context.createPage({ own, signal }),
  ).page;
  const ledger = new SurfaceLedger(launched.context, {
    pages,
    sessionId: session,
    rootPages: [root],
  });
  await ledger.start();
  cleanup.push(() => ledger.close());
  // Which Chromium delivered first: an opener's close, or its child's page event.
  const order: string[] = [];
  const raw = (
    launched as unknown as {
      playwrightContext: {
        on(event: "page", fn: (page: import("playwright-core").Page) => void): void;
      };
    }
  ).playwrightContext;
  raw.on("page", (page) => {
    const recorded = (page as unknown as { _opener?: { isClosed(): boolean } | null })._opener;
    order.push(
      `page ${new URL(page.url() || "about:blank", "http://x").search || page.url()} opener=${recorded ? (recorded.isClosed() ? "closed" : "open") : "none"}`,
    );
    page.once("close", () => order.push(`close ${new URL(page.url(), "http://x").search}`));
  });
  if (asleep) {
    const other = await ledger.openSurface();
    const otherLive = ledger.binding(other.id)!;
    await otherLive.cdp.send("Page.navigate", { url: `${server.originForSite(3)}/article` });
    await waitLoaded(otherLive.cdp, "/article");
    expect(await ledger.sleep(other.id, () => null)).toBe(true);
  }
  const first = ledger.snapshot().find((surface) => ledger.binding(surface.id)?.page === root)!;
  const firstLive = ledger.binding(first.id)!;
  await firstLive.cdp.send("Page.navigate", { url: `${server.originForSite(1)}/article` });
  await waitLoaded(firstLive.cdp, "/article");
  /** `from` opens `url` by script, and closes itself in the same task when `closeAtOnce`. */
  const open = async (
    from: { send<R = unknown>(method: string, params?: Record<string, unknown>): Promise<R> },
    url: string,
    closeAtOnce: boolean,
  ) => {
    await from.send("Runtime.evaluate", {
      expression: `window.open(${JSON.stringify(url)}, "_blank");${closeAtOnce ? " window.close();" : ""}`,
      userGesture: true,
    });
    return vi
      .waitFor(
        () => {
          const surface = surfaceAt(ledger, new URL(url).search);
          expect(surface).toBeDefined();
          return surface!;
        },
        { timeout: 10_000, interval: 25 },
      )
      .catch((error: unknown) => {
        process.stdout.write(`${JSON.stringify({ event: "q1.missing", url, order })}\n`);
        throw error;
      });
  };
  return { server, ledger, firstLive, open, order };
}

it.each([
  ["before", "no tab asleep"],
  ["before", "a tab asleep"],
  ["after", "no tab asleep"],
  ["after", "a tab asleep"],
] as const)(
  "puts the tab a self-closing page opened in that page's session, usable there (Q1, the opener closes %s the tab is announced, %s)",
  async (order, state) => {
    const {
      server,
      ledger,
      firstLive,
      open,
      order: events,
    } = await selfClosingSetup(state === "a tab asleep");
    const second = await open(
      firstLive.cdp,
      `${server.originForSite(1)}/article?step=second`,
      false,
    );
    const secondLive = ledger.binding(second.id)!;
    await waitLoaded(secondLive.cdp, "/article");
    const thirdUrl = `${server.originForSite(2)}/form?step=third`;
    const third = await open(secondLive.cdp, thirdUrl, order === "before");
    if (order === "after")
      await secondLive.cdp.send("Runtime.evaluate", { expression: "window.close()" });
    await vi.waitFor(() => expect(ledger.binding(second.id) ?? null).toBeNull(), {
      timeout: 10_000,
      interval: 25,
    });
    // The successor is this session's tab, and usable there.
    const thirdLive = ledger.binding(third.id)!;
    await waitLoaded(thirdLive.cdp, "/form");
    expect(await evalValue<string>(thirdLive.cdp, "location.search")).toBe("?step=third");
    process.stdout.write(`${JSON.stringify({ event: "q1.order", order, state, events })}\n`);
  },
  60_000,
);

it("puts the last tab of a chain of self-closing pages in the first page's session (Q1, chain)", async () => {
  const { server, ledger, firstLive, open } = await selfClosingSetup(true);
  const second = await open(firstLive.cdp, `${server.originForSite(1)}/article?step=second`, false);
  const secondLive = ledger.binding(second.id)!;
  await waitLoaded(secondLive.cdp, "/article");
  const third = await open(secondLive.cdp, `${server.originForSite(2)}/article?step=third`, true);
  const thirdLive = ledger.binding(third.id)!;
  await waitLoaded(thirdLive.cdp, "/article");
  const fourth = await open(thirdLive.cdp, `${server.originForSite(3)}/form?step=fourth`, true);
  const fourthLive = ledger.binding(fourth.id)!;
  await waitLoaded(fourthLive.cdp, "/form");
  expect(await evalValue<string>(fourthLive.cdp, "location.search")).toBe("?step=fourth");
}, 60_000);

it("sleeps a tab another page opened and wakes it as itself, not as a new popup (M1)", async () => {
  const server = await startFixtureServer();
  const directory = await mkdtemp(path.join(tmpdir(), "os-tab-sleep-m1-popup-wakes-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const launcher = new PlaywrightChromiumLauncher({
    executablePath,
    chromiumSandbox: false,
    headless: true,
  });
  const launched = await launchReady(launcher, nativeProfileRequest(directory));
  cleanup.push(() => launched.close());
  const ledger = new SurfaceLedger(launched.context);
  await ledger.start();
  cleanup.push(() => ledger.close());
  const opener = await ledger.openSurface();
  const openerLive = ledger.binding(opener.id)!;
  await openerLive.cdp.send("Page.navigate", { url: `${server.originForSite(1)}/article` });
  await waitLoaded(openerLive.cdp, "/article");
  const popupUrl = `${server.originForSite(2)}/session-storage?popup=1`;
  // Opened with noopener: Chromium still records its opener, while its script cannot reach it,
  // so it may sleep (a tab that can reach its opener is kept awake).
  await openerLive.cdp.send("Runtime.evaluate", {
    expression: `void window.open(${JSON.stringify(popupUrl)}, "_blank", "noopener")`,
    userGesture: true,
  });
  const popupId = await vi.waitFor(
    () => {
      const surface = ledger.snapshot().find((s) => s.id !== opener.id);
      expect(surface).toBeDefined();
      return surface!.id;
    },
    { timeout: 10_000, interval: 25 },
  );
  const popupLive = ledger.binding(popupId)!;
  await waitLoaded(popupLive.cdp, "/session-storage");
  await evalValue(popupLive.cdp, `sessionStorage.setItem("wizard_step", "opened-by-another")`);
  expect(await ledger.sleep(popupId, () => null)).toBe(true);
  const woken = await ledger.wake(popupId);
  await waitLoaded(woken.cdp, "/session-storage");
  expect(await evalValue(woken.cdp, `sessionStorage.getItem("wizard_step")`)).toBe(
    "opened-by-another",
  );
  // Woken as itself: the same two tabs, no third surface for a "new popup".
  expect(
    ledger
      .snapshot()
      .map((s) => s.id)
      .sort(),
  ).toEqual([opener.id, popupId].sort());
}, 60_000);

it.each(["no tab asleep", "a tab asleep"] as const)(
  "puts 20 popups in a row from a live tab in their session, each opening a successor and closing itself (run 10's loop, %s)",
  async (state) => {
    const server = await startFixtureServer();
    const directory = await mkdtemp(path.join(tmpdir(), "os-tab-sleep-run10-loop-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const launcher = new PlaywrightChromiumLauncher({
      executablePath,
      chromiumSandbox: false,
      headless: true,
    });
    const launched = await launchReady(launcher, nativeProfileRequest(directory));
    cleanup.push(() => launched.close());
    const pages = new PageOwnership();
    pages.adopt(launched.context);
    const session = async (name: string) => {
      const root = await pages.create(name, null, "open-failed", (own, signal) =>
        launched.context.createPage({ own, signal }),
      ).page;
      const ledger = new SurfaceLedger(launched.context, {
        pages,
        sessionId: name,
        rootPages: [root],
      });
      await ledger.start();
      cleanup.push(() => ledger.close());
      const surface = ledger.snapshot().find((s) => ledger.binding(s.id)?.page === root)!;
      return { ledger, live: ledger.binding(surface.id)! };
    };
    const a = await session("session-originating");
    const b = await session("session-bystander");
    await a.live.cdp.send("Page.navigate", { url: `${server.originForSite(1)}/article?id=first` });
    await waitLoaded(a.live.cdp, "/article");
    await b.live.cdp.send("Page.navigate", {
      url: `${server.originForSite(2)}/article?id=bystander`,
    });
    await waitLoaded(b.live.cdp, "/article");
    let bgId: string | null = null;
    if (state === "a tab asleep") {
      const bg = await a.ledger.openSurface();
      bgId = bg.id;
      const bgLive = a.ledger.binding(bg.id)!;
      await bgLive.cdp.send("Page.navigate", {
        url: `${server.originForSite(3)}/article?id=bg-asleep`,
      });
      await waitLoaded(bgLive.cdp, "/article");
      await evalValue(bgLive.cdp, `sessionStorage.setItem("mark", "bg-asleep")`);
      expect(await a.ledger.sleep(bg.id, () => null)).toBe(true);
    }
    // S2's counts: loads of the sleeping tab Chromium made by itself, and tabs that joined its
    // group and were un-named as newcomers (run 11: 18 and 17 in 20 rounds).
    const lifecycle = (
      launched as unknown as { contextHandle: { lifecycleCandidate: ChromiumTabLifecycleBridge } }
    ).contextHandle.lifecycleCandidate;
    const loadsAsleep = server.hits("/article?id=bg-asleep");
    let unnamed = 0;
    const unname = lifecycle.unnameTab.bind(lifecycle);
    lifecycle.unnameTab = (tabId: number) => {
      unnamed++;
      return unname(tabId);
    };
    const inA = (part: string) =>
      a.ledger.snapshot().find((s) => a.ledger.binding(s.id)?.page.url().includes(part));
    for (let round = 1; round <= 20; round++) {
      const second = `${server.originForSite(4)}/article?id=second-r${round}`;
      const third = `${server.originForSite(5)}/form?id=third-r${round}`;
      await a.live.cdp.send("Runtime.evaluate", {
        expression: `void window.open(${JSON.stringify(second)}, "_blank")`,
        userGesture: true,
      });
      const secondSurface = await vi
        .waitFor(
          () => {
            const surface = inA(`second-r${round}`);
            expect(surface).toBeDefined();
            return surface!;
          },
          { timeout: 10_000, interval: 25 },
        )
        .catch((error: unknown) => {
          process.stdout.write(
            `${JSON.stringify({
              event: "run10.missing",
              round,
              which: "second",
              raw: launched.context.pages().map((p) => p.url()),
              ledgerA: a.ledger.snapshot().map((s) => a.ledger.binding(s.id)?.page.url() ?? null),
            })}\n`,
          );
          throw error;
        });
      const secondLive = a.ledger.binding(secondSurface.id)!;
      await waitLoaded(secondLive.cdp, "/article");
      await secondLive.cdp.send("Runtime.evaluate", {
        expression: `window.open(${JSON.stringify(third)}, "_blank"); window.close();`,
        userGesture: true,
      });
      const thirdSurface = await vi.waitFor(
        () => {
          const surface = inA(`third-r${round}`);
          expect(surface).toBeDefined();
          return surface!;
        },
        { timeout: 10_000, interval: 25 },
      );
      await waitLoaded(a.ledger.binding(thirdSurface.id)!.cdp, "/form");
      await a.ledger.closeSurface(thirdSurface.id);
    }
    const counts = {
      selfLoads: server.hits("/article?id=bg-asleep") - loadsAsleep,
      newcomers: unnamed,
    };
    process.stdout.write(`${JSON.stringify({ event: "run11.counts", state, ...counts })}\n`);
    expect(counts).toEqual({ selfLoads: 0, newcomers: 0 });
    if (bgId) {
      // One more popup stays open and carries the sleeping tab's name, as a tab that joined its
      // group does: the wake armed now takes its own tab, with its state, and the newcomer stays.
      const last = `${server.originForSite(6)}/article?id=last`;
      await a.live.cdp.send("Runtime.evaluate", {
        expression: `void window.open(${JSON.stringify(last)}, "_blank")`,
        userGesture: true,
      });
      await vi.waitFor(() => expect(inA("id=last")).toBeDefined(), { timeout: 10_000 });
      const rows = await lifecycle.inventory();
      const name = rows.find((tab) => tab.url.includes("bg-asleep"))!.identity!;
      expect(name).toMatch(/^opensteer-sleep:/);
      const newcomer = rows.find((tab) => tab.url.includes("id=last"))!;
      if (newcomer.identity !== name)
        expect(await lifecycle.nameTab(newcomer.tabId, name)).toBe(true);
      const woken = await a.ledger.wake(bgId as never);
      await waitLoaded(woken.cdp, "/article");
      expect(woken.page.url()).toContain("bg-asleep");
      expect(await evalValue(woken.cdp, `sessionStorage.getItem("mark")`)).toBe("bg-asleep");
      expect(inA("id=last")).toBeDefined();
    }
  },
  240_000,
);

it.each([
  ["Chromium activates it by itself", 1],
  ["it is left active and discarded", 1],
  ["Chromium activates it by itself, 20 times", 20],
] as const)(
  "wakes a sleeping tab as itself with its draft, scroll and session storage when %s (run 11 S1, run 12 1b/1c)",
  async (how, rounds) => {
    const server = await startFixtureServer();
    const directory = await mkdtemp(path.join(tmpdir(), "os-tab-sleep-active-discarded-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const launcher = new PlaywrightChromiumLauncher({
      executablePath,
      chromiumSandbox: false,
      headless: true,
    });
    const launched = await launchReady(launcher, nativeProfileRequest(directory));
    cleanup.push(() => launched.close());
    const lifecycle = (
      launched as unknown as { contextHandle: { lifecycleCandidate: ChromiumTabLifecycleBridge } }
    ).contextHandle.lifecycleCandidate;
    const ledger = new SurfaceLedger(launched.context);
    await ledger.start();
    cleanup.push(() => ledger.close());
    const live = await ledger.openSurface();
    await ledger.binding(live.id)!.cdp.send("Page.navigate", {
      url: `${server.originForSite(1)}/article?id=live`,
    });
    await waitLoaded(ledger.binding(live.id)!.cdp, "/article");
    const bg = await ledger.openSurface();
    const bgCdp = ledger.binding(bg.id)!.cdp;
    await bgCdp.send("Page.navigate", { url: `${server.originForSite(2)}/draft?id=bg` });
    await waitLoaded(bgCdp, "/draft");
    await evalValue(bgCdp, `sessionStorage.setItem("mark", "kept")`);
    await evalValue(bgCdp, "document.getElementById('draft').focus()");
    await bgCdp.send("Input.insertText", { text: "typed draft" });
    await evalValue(bgCdp, "document.activeElement.blur()");
    await evalValue(bgCdp, "window.scrollTo(0, 1750)");
    expect(await ledger.sleep(bg.id, () => null)).toBe(true);
    const bgRow = async () =>
      (await lifecycle.inventory()).find((tab) => tab.url.includes("id=bg"))!;
    expect(await bgRow()).toMatchObject({ discarded: true });
    const handle = (
      launched as unknown as { contextHandle: { activatePrivateAnchor(): Promise<void> } }
    ).contextHandle;
    const anchor = handle.activatePrivateAnchor.bind(handle);
    // As `e731a2dbe` put it back to sleep (no anchor first), or a tab that became active between
    // the read and the discard: the runtime's own discard leaves it active and discarded.
    if (how === "it is left active and discarded") handle.activatePrivateAnchor = async () => {};
    for (let round = 1; round <= rounds; round++) {
      // Chromium activates the sleeping tab, with no wake armed (as when the active tab beside it
      // closes): it loads, and the runtime settles it again.
      const activated = await lifecycle.activateByTabId((await bgRow()).tabId);
      expect(activated.ok).toBe(true);
      await vi.waitFor(async () => expect(await bgRow()).toMatchObject({ discarded: true }), {
        timeout: 10_000,
        interval: 50,
      });
      if (rounds > 1) await lifecycle.activateByTabId((await lifecycle.inventory())[0]!.tabId);
    }
    handle.activatePrivateAnchor = anchor;
    const before = await bgRow();
    process.stdout.write(`${JSON.stringify({ event: "s1.before-wake", how, row: before })}\n`);
    const woken = await ledger.wake(bg.id);
    await waitLoaded(woken.cdp, "/draft");
    expect(woken.page.url()).toContain("id=bg");
    const state = await evalValue<{ mark: string | null; draft: string; scroll: number }>(
      woken.cdp,
      `({ mark: sessionStorage.getItem("mark"), draft: document.getElementById("draft").value, scroll: window.scrollY })`,
    );
    process.stdout.write(`${JSON.stringify({ event: "s1.after-wake", how, state })}\n`);
    expect(state).toEqual({ mark: "kept", draft: "typed draft", scroll: 1750 });
  },
  180_000,
);

it("keeps sleeping tabs left of the private anchor and live tabs right of it through opens, popups, closes, sleeps and wakes (run 11, S2)", async () => {
  const server = await startFixtureServer();
  const directory = await mkdtemp(path.join(tmpdir(), "os-tab-sleep-order-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const launcher = new PlaywrightChromiumLauncher({
    executablePath,
    chromiumSandbox: false,
    headless: true,
  });
  const launched = await launchReady(launcher, nativeProfileRequest(directory));
  cleanup.push(() => launched.close());
  const internal = launched as unknown as {
    contextHandle: {
      lifecycleCandidate: ChromiumTabLifecycleBridge;
      privatePage: {
        _connection: { toImpl(page: unknown): { delegate: { _targetId: string } } };
      };
    };
  };
  const lifecycle = internal.contextHandle.lifecycleCandidate;
  // The private anchor's target, as the launcher knows it (without attaching to it).
  const privatePage = internal.contextHandle.privatePage;
  const anchorTarget = privatePage._connection.toImpl(privatePage).delegate._targetId;
  const ledger = new SurfaceLedger(launched.context);
  await ledger.start();
  cleanup.push(() => ledger.close());
  const open = async (id: string) => {
    const surface = await ledger.openSurface();
    const cdp = ledger.binding(surface.id)!.cdp;
    await cdp.send("Page.navigate", { url: `${server.originForSite(1)}/article?id=${id}` });
    await waitLoaded(cdp, "/article");
    await evalValue(cdp, `sessionStorage.setItem("mark", ${JSON.stringify(id)})`);
    return surface.id;
  };
  const steps: string[] = [];
  const order = (step: string) =>
    vi.waitFor(() => orderNow(step), { timeout: 2_000, interval: 50 });
  const orderNow = async (step: string) => {
    const rows = (await lifecycle.inventory()).filter(
      (tab) => !tab.url.startsWith("chrome-extension://"),
    );
    const strip = rows
      .map((tab) =>
        tab.targetId === anchorTarget
          ? "A"
          : `${new URL(tab.url || "about:blank").searchParams.get("id") ?? "blank"}${
              tab.identity?.startsWith("opensteer-sleep:") && tab.discarded ? "(z)" : ""
            }`,
      )
      .join(" ");
    if (steps.at(-1) !== `${step}: ${strip}`) steps.push(`${step}: ${strip}`);
    const anchor = rows.findIndex((tab) => tab.targetId === anchorTarget);
    const asleep = rows.map((tab) => Boolean(tab.identity?.startsWith("opensteer-sleep:")));
    expect({ step, strip, ok: asleep.every((named, i) => named === i < anchor) }).toEqual({
      step,
      strip,
      ok: true,
    });
  };
  const p1 = await open("p1");
  const p2 = await open("p2");
  const p3 = await open("p3");
  const p4 = await open("p4");
  await order("opened 4");
  expect(await ledger.sleep(p2, () => null)).toBe(true);
  await order("p2 asleep");
  expect(await ledger.sleep(p4, () => null)).toBe(true);
  await order("p4 asleep");
  // A popup from a live tab, which opens a successor and closes itself; the successor closes.
  const live1 = ledger.binding(p1)!;
  await live1.cdp.send("Runtime.evaluate", {
    expression: `void window.open(${JSON.stringify(`${server.originForSite(2)}/article?id=popup`)}, "_blank")`,
    userGesture: true,
  });
  const popupId = await vi.waitFor(
    () => {
      const found = ledger
        .snapshot()
        .find((s) => ledger.binding(s.id)?.page.url().includes("id=popup"));
      expect(found).toBeDefined();
      return found!.id;
    },
    { timeout: 10_000, interval: 25 },
  );
  await waitLoaded(ledger.binding(popupId)!.cdp, "/article");
  await order("popup open");
  await ledger.binding(popupId)!.cdp.send("Runtime.evaluate", {
    expression: `window.open(${JSON.stringify(`${server.originForSite(3)}/article?id=successor`)}, "_blank"); window.close();`,
    userGesture: true,
  });
  const successorId = await vi.waitFor(
    () => {
      const found = ledger
        .snapshot()
        .find((s) => ledger.binding(s.id)?.page.url().includes("id=successor"));
      expect(found).toBeDefined();
      return found!.id;
    },
    { timeout: 10_000, interval: 25 },
  );
  await waitLoaded(ledger.binding(successorId)!.cdp, "/article");
  await order("popup closed itself");
  await ledger.closeSurface(successorId);
  await order("successor closed");
  const woken = await ledger.wake(p2);
  await waitLoaded(woken.cdp, "/article");
  expect(await evalValue(woken.cdp, `sessionStorage.getItem("mark")`)).toBe("p2");
  await order("p2 woken");
  expect(await ledger.sleep(p3, () => null)).toBe(true);
  await order("p3 asleep");
  await ledger.closeSurface(p1);
  await order("p1 closed");
  await open("p5");
  await order("p5 opened");
  const p4Woken = await ledger.wake(p4);
  await waitLoaded(p4Woken.cdp, "/article");
  expect(await evalValue(p4Woken.cdp, `sessionStorage.getItem("mark")`)).toBe("p4");
  await order("p4 woken");
  process.stdout.write(`${JSON.stringify({ event: "s2.order", steps })}\n`);
}, 120_000);

it("sleeps and wakes a tab a connected agent works in as the runtime's own work, and holds the agent to its connection's commands before the sleep and after the wake", async () => {
  const server = await startFixtureServer();
  const directory = await mkdtemp(path.join(tmpdir(), "os-tab-sleep-connection-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const launcher = new PlaywrightChromiumLauncher({
    executablePath,
    chromiumSandbox: false,
    headless: true,
  });
  const launched = await launchReady(launcher, nativeProfileRequest(directory));
  cleanup.push(() => launched.close());
  const sessionId = "session-connection";
  const router = new SessionCdpRouter(launched.cdp);
  cleanup.push(() => router.close());
  const root = await launched.context.createPage();
  const ledger = new SurfaceLedger(launched.context, {
    claimTarget: (targetId, openerId) => router.claimTarget(sessionId, targetId, openerId),
    releaseTarget: (targetId) => router.releaseTarget(sessionId, targetId),
    rootPages: [root],
  });
  router.registerSession(
    sessionId,
    await root.targetId(),
    (targetId) => ledger.resolveTarget(targetId),
    directory,
  );
  await ledger.start();
  cleanup.push(() => ledger.close());
  const bg = await ledger.openSurface();
  await ledger.binding(bg.id)!.cdp.send("Page.navigate", {
    url: `${server.originForSite(1)}/article?id=connection`,
  });
  await waitLoaded(ledger.binding(bg.id)!.cdp, "/article");
  await evalValue(ledger.binding(bg.id)!.cdp, `sessionStorage.setItem("mark", "kept")`);

  // The connected agent's own client: the connection's list, decided when it was opened.
  const agent = router.openStandardClient(sessionId, { wholeContext: false, connection: true });
  cleanup.push(async () => agent.close());
  const heldTo = async (targetId: string) => {
    const { sessionId: cdpSessionId } = (await agent.send({
      method: "Target.attachToTarget",
      parameters: { targetId, flatten: true },
    })) as { sessionId: string };
    await expect(
      agent.send({
        method: "Storage.clearDataForOrigin",
        parameters: { origin: server.originForSite(1), storageTypes: "all" },
        sessionId: cdpSessionId,
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: expect.stringContaining("is not available to a connected agent"),
    });
    await expect(
      agent.send({
        method: "Browser.setPermission",
        parameters: { permission: { name: "geolocation" }, setting: "granted" },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    // Within the list, it works in the page.
    return (
      (await agent.send({
        method: "Runtime.evaluate",
        parameters: { expression: `sessionStorage.getItem("mark")`, returnByValue: true },
        sessionId: cdpSessionId,
      })) as { result: { value: unknown } }
    ).result.value;
  };
  expect(await heldTo(ledger.binding(bg.id)!.targetId)).toBe("kept");

  // The runtime's own sleep and wake: nothing of it goes through the connection's client, and
  // the connection's list does not hold it back.
  expect(await ledger.sleep(bg.id, () => null)).toBe(true);
  const woken = await ledger.wake(bg.id);
  await waitLoaded(woken.cdp, "/article");
  expect(await evalValue(woken.cdp, `sessionStorage.getItem("mark")`)).toBe("kept");

  // After the wake the same client reaches the woken tab and is held to the same list.
  expect(await heldTo(woken.targetId)).toBe("kept");
}, 90_000);

/** A session wired as the runtime wires it: its router learns of sleeps and wakes (run 12). */
async function lineageSetup(name: string) {
  const server = await startFixtureServer();
  const directory = await mkdtemp(path.join(tmpdir(), `os-tab-sleep-${name}-`));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const launcher = new PlaywrightChromiumLauncher({
    executablePath,
    chromiumSandbox: false,
    headless: true,
  });
  const launched = await launchReady(launcher, nativeProfileRequest(directory));
  cleanup.push(() => launched.close());
  const sessionId = `session-${name}`;
  const router = new SessionCdpRouter(launched.cdp);
  cleanup.push(() => router.close());
  const root = await launched.context.createPage();
  const ledger = new SurfaceLedger(launched.context, {
    claimTarget: (targetId, openerId, woke) =>
      router.claimTarget(sessionId, targetId, openerId, woke),
    releaseTarget: (targetId, asleep) => router.releaseTarget(sessionId, targetId, asleep),
    rootPages: [root],
  });
  router.registerSession(
    sessionId,
    await root.targetId(),
    (targetId) => ledger.resolveTarget(targetId),
    directory,
  );
  await ledger.start();
  cleanup.push(() => ledger.close());
  const lifecycle = (
    launched as unknown as { contextHandle: { lifecycleCandidate: ChromiumTabLifecycleBridge } }
  ).contextHandle.lifecycleCandidate;
  const open = async (id: string, site: number) => {
    const surface = await ledger.openSurface();
    const cdp = ledger.binding(surface.id)!.cdp;
    await cdp.send("Page.navigate", { url: `${server.originForSite(site)}/article?id=${id}` });
    await waitLoaded(cdp, "/article");
    await evalValue(cdp, `sessionStorage.setItem("mark", ${JSON.stringify(id)})`);
    return surface.id;
  };
  const target = (id: string) => ledger.binding(id as never)!.targetId;
  /** A connected agent's client granted one tab and what descends from it. */
  const agent = (attachmentId: string, seedTargetId: string) => {
    const client = router.openStandardClient(sessionId, {
      wholeContext: false,
      connection: true,
      lineage: { attachmentId, seedTargetId },
    });
    cleanup.push(async () => client.close());
    return {
      /** What this client is told exists. */
      targets: async () =>
        (
          (await client.send({ method: "Target.getTargets" })) as {
            targetInfos: { targetId: string }[];
          }
        ).targetInfos.map((info) => info.targetId),
      /** The page's mark, read through this client; throws when the tab is out of its reach. */
      reach: async (targetId: string) => {
        const { sessionId: cdpSessionId } = (await client.send({
          method: "Target.attachToTarget",
          parameters: { targetId, flatten: true },
        })) as { sessionId: string };
        return (
          (await client.send({
            method: "Runtime.evaluate",
            parameters: { expression: `sessionStorage.getItem("mark")`, returnByValue: true },
            sessionId: cdpSessionId,
          })) as { result: { value: unknown } }
        ).result.value;
      },
    };
  };
  const popup = async (fromId: string, id: string, site: number) => {
    await ledger.binding(fromId as never)!.cdp.send("Runtime.evaluate", {
      expression: `void window.open(${JSON.stringify(`${server.originForSite(site)}/article?id=${id}`)}, "_blank")`,
      userGesture: true,
    });
    const surfaceId = await vi.waitFor(
      () => {
        const found = ledger
          .snapshot()
          .find((s) => ledger.binding(s.id)?.page.url().includes(`id=${id}`));
        expect(found).toBeDefined();
        return found!.id;
      },
      { timeout: 10_000, interval: 25 },
    );
    await waitLoaded(ledger.binding(surfaceId)!.cdp, "/article");
    return surfaceId as string;
  };
  return { server, launched, router, ledger, lifecycle, open, target, agent, popup };
}

const outsideLineage = {
  code: "forbidden",
  message: "CDP target is outside this Browser Session.",
};

it("keeps a connected agent's lineage on its tab when the runtime puts the tab to sleep and wakes it, by the runtime's own record and nothing else (run 12)", async () => {
  const f = await lineageSetup("lineage");
  const a = await f.open("a", 1);
  const b = await f.open("b", 2);
  const c = await f.open("c", 3);
  const agentA = f.agent("agent-a", f.target(a));
  const agentB = f.agent("agent-b", f.target(b));
  expect(await agentA.reach(f.target(a))).toBe("a");
  await expect(agentA.reach(f.target(c))).rejects.toMatchObject(outsideLineage);
  await expect(agentA.reach(f.target(b))).rejects.toMatchObject(outsideLineage);
  expect(await agentB.reach(f.target(b))).toBe("b");
  const slept = f.target(a);

  expect(await f.ledger.sleep(a as never, () => null)).toBe(true);
  // While it sleeps: a tab another page opened carries its sleep name, as a tab that joined its
  // group does; and a tab opens at its address.
  const title = (await f.lifecycle.inventory()).find((tab) => tab.url.includes("id=a"))!.identity!;
  expect(title).toMatch(/^opensteer-sleep:/);
  const newcomer = await f.popup(c, "newcomer", 4);
  const newcomerTab = (await f.lifecycle.inventory()).find((tab) => tab.url.includes("newcomer"))!;
  expect(await f.lifecycle.nameTab(newcomerTab.tabId, title)).toBe(true);
  const sameAddress = await f.ledger.openSurface();
  await f.ledger.binding(sameAddress.id)!.cdp.send("Page.navigate", {
    url: `${f.server.originForSite(1)}/article?id=a`,
  });
  await waitLoaded(f.ledger.binding(sameAddress.id)!.cdp, "/article");

  const woken = await f.ledger.wake(a as never);
  await waitLoaded(woken.cdp, "/article");
  expect(woken.targetId).not.toBe(slept);
  // The same client reaches its tab again, with its state.
  expect(await agentA.reach(woken.targetId)).toBe("a");
  // Nothing else came into its lineage: not the newcomer, not the tab at its address, not a tab
  // another page opened; what the woken tab opens descends from it.
  await expect(agentA.reach(f.target(newcomer))).rejects.toMatchObject(outsideLineage);
  await expect(agentA.reach(f.target(sameAddress.id))).rejects.toMatchObject(outsideLineage);
  const fromC = await f.popup(c, "from-c", 5);
  await expect(agentA.reach(f.target(fromC))).rejects.toMatchObject(outsideLineage);
  const fromA = await f.popup(a, "from-a", 6);
  expect(await agentA.reach(f.target(fromA))).toBeNull();
  // The other agent's lineage is as it was, and stays apart through its own tab's sleep.
  await expect(agentA.reach(f.target(b))).rejects.toMatchObject(outsideLineage);
  expect(await agentB.reach(f.target(b))).toBe("b");
  await expect(agentB.reach(woken.targetId)).rejects.toMatchObject(outsideLineage);
  expect(await f.ledger.sleep(b as never, () => null)).toBe(true);
  const wokenB = await f.ledger.wake(b as never);
  await waitLoaded(wokenB.cdp, "/article");
  expect(await agentB.reach(wokenB.targetId)).toBe("b");
  await expect(agentA.reach(wokenB.targetId)).rejects.toMatchObject(outsideLineage);
}, 120_000);

it("gives a connected agent no page in its lineage when its tab's wake ends at its address (run 12)", async () => {
  const f = await lineageSetup("lineage-fresh");
  const a = await f.open("a", 1);
  const agentA = f.agent("agent-a", f.target(a));
  expect(await agentA.reach(f.target(a))).toBe("a");
  expect(await f.ledger.sleep(a as never, () => null)).toBe(true);
  // The wake cannot activate its tab: the tab is removed with evidence and a fresh page opens at
  // its address.
  const activate = f.lifecycle.activateByTabId.bind(f.lifecycle);
  f.lifecycle.activateByTabId = async () => ({ ok: false, tabId: null, discarded: false });
  const woken = await f.ledger.wake(a as never);
  f.lifecycle.activateByTabId = activate;
  await waitLoaded(woken.cdp, "/article");
  expect(woken.page.url()).toContain("id=a");
  expect(await evalValue(woken.cdp, `sessionStorage.getItem("mark")`)).toBeNull();
  // A new page, not the granted tab: outside the lineage, as any page it never had, and the
  // client is told of no page at all.
  await expect(agentA.reach(woken.targetId)).rejects.toMatchObject(outsideLineage);
  expect(await agentA.targets()).toEqual([]);
}, 90_000);

/**
 * Raw CDP clients at the runtime's own standard-CDP socket: the bytes an agent receives. The Home
 * forwards each runtime frame unchanged (`standard-cdp-route.ts`, `send(frame)`).
 */
async function standardCdpSockets(clients: StandardCdpAttachment[]) {
  const runtime = {
    pooled: false,
    prepare: async () => undefined,
    shutdown: async () => undefined,
    attachStandardCdp: async () => clients.shift()!,
  } as unknown as BrowserRuntime;
  const server = new BrowserRuntimeServer({ port: 0, runtime });
  const { host, port } = await server.start();
  cleanup.push(() => server.close());
  return async () => {
    const socket = new WebSocket(`ws://${host}:${port}${standardCdpPath}`, {
      headers: { authorization: "Bearer test" },
    });
    cleanup.push(async () => socket.terminate());
    await once(socket, "open");
    const frames: string[] = [];
    const waiting = new Map<number, (frame: string) => void>();
    socket.on("message", (raw) => {
      const frame = String(raw);
      frames.push(frame);
      const id = (JSON.parse(frame) as { id?: number }).id;
      if (id !== undefined) waiting.get(id)?.(frame);
    });
    let next = 1;
    /** One command; its reply frame exactly as the agent receives it. */
    const send = (method: string, params?: Record<string, unknown>, sessionId?: string) => {
      const id = next++;
      const reply = new Promise<string>((resolve) => waiting.set(id, resolve));
      socket.send(
        JSON.stringify({
          id,
          method,
          ...(params ? { params } : {}),
          ...(sessionId ? { sessionId } : {}),
        }),
      );
      return reply;
    };
    return { send, frames };
  };
}

it("tells a connected agent the same bytes for a tab that never existed, one outside its lineage, its tab after a wake by address and its tab after a close, and never shows it the others (run 12)", async () => {
  const f = await lineageSetup("lineage-answers");
  const a = await f.open("a", 1);
  const c = await f.open("c", 3);
  const lineageClient = f.router.openStandardClient("session-lineage-answers", {
    wholeContext: false,
    connection: true,
    lineage: { attachmentId: "agent-a", seedTargetId: f.target(a) },
  });
  const ownClient = f.router.openStandardClient("session-lineage-answers", {
    wholeContext: false,
  });
  const connect = await standardCdpSockets([lineageClient, ownClient]);
  const agent = await connect();
  const own = await connect();
  const attach = (client: typeof agent, targetId: string) =>
    client.send("Target.attachToTarget", { targetId, flatten: true });
  for (const client of [agent, own]) {
    await client.send("Target.setDiscoverTargets", { discover: true });
    await client.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
  }
  // A tab its own tab opened, which the person then closes.
  const descendant = await f.popup(a, "descendant", 2);
  const closedTarget = f.target(descendant);
  expect(JSON.parse(await attach(agent, closedTarget))).toHaveProperty("result.sessionId");
  await f.ledger.closeSurface(descendant as never);
  // Its own tab, after a wake that ended at its address.
  const sleptTarget = f.target(a);
  expect(await f.ledger.sleep(a as never, () => null)).toBe(true);
  const activate = f.lifecycle.activateByTabId.bind(f.lifecycle);
  f.lifecycle.activateByTabId = async () => ({ ok: false, tabId: null, discarded: false });
  const fresh = await f.ledger.wake(a as never);
  f.lifecycle.activateByTabId = activate;
  await waitLoaded(fresh.cdp, "/article");

  const outside = (id: number) =>
    JSON.stringify({
      id,
      error: { code: -32000, message: "CDP target is outside this Browser Session." },
    });
  const answers = {
    neverExisted: await attach(agent, "0123456789ABCDEF0123456789ABCDEF"),
    outsideLineage: await attach(agent, f.target(c)),
    sleptTargetAfterWakeByAddress: await attach(agent, sleptTarget),
    freshPageAtItsAddress: await attach(agent, fresh.targetId),
    closedByThePerson: await attach(agent, closedTarget),
  };
  process.stdout.write(`${JSON.stringify({ event: "lineage.answers", answers })}\n`);
  for (const frame of Object.values(answers))
    expect(frame).toBe(outside((JSON.parse(frame) as { id: number }).id));
  // The same for every command that names a target.
  for (const method of ["Target.getTargetInfo", "Target.activateTarget", "Target.closeTarget"])
    for (const targetId of ["0123456789ABCDEF0123456789ABCDEF", f.target(c), fresh.targetId]) {
      const frame = await agent.send(method, { targetId });
      expect(frame, `${method} ${targetId}`).toBe(
        outside((JSON.parse(frame) as { id: number }).id),
      );
    }
  // Nothing outside its lineage is listed, announced or auto-attached.
  const listed = JSON.parse(await agent.send("Target.getTargets")) as {
    result: { targetInfos: { targetId: string }[] };
  };
  expect(listed.result.targetInfos).toEqual([]);
  for (const targetId of [f.target(c), fresh.targetId, f.target(f.ledger.snapshot()[0]!.id)])
    expect(
      agent.frames.filter((frame) => frame.includes(targetId)),
      targetId,
    ).toEqual([]);

  // A person's own agent (no lineage) reaches the session's tabs; a tab that never existed and a
  // closed one get the same sentence as above.
  expect(JSON.parse(await attach(own, f.target(c)))).toHaveProperty("result.sessionId");
  expect(JSON.parse(await attach(own, fresh.targetId))).toHaveProperty("result.sessionId");
  for (const targetId of ["0123456789ABCDEF0123456789ABCDEF", closedTarget, sleptTarget]) {
    const frame = await attach(own, targetId);
    expect(frame).toBe(outside((JSON.parse(frame) as { id: number }).id));
  }
}, 120_000);

it("leaves no place a later claim can fill when a tab closes while it sleeps (run 12)", async () => {
  const f = await lineageSetup("lineage-closed");
  const a = await f.open("a", 1);
  const other = await f.open("other", 2);
  const agentA = f.agent("agent-a", f.target(a));
  const slept = f.target(a);
  expect(await f.ledger.sleep(a as never, () => null)).toBe(true);
  await f.ledger.closeSurface(a as never);
  // A claim that names the closed tab's slept target, as only the ledger's own wake would: the
  // place is gone, so the page gains nothing.
  f.router.claimTarget("session-lineage-closed", f.target(other), undefined, {
    from: slept,
    itself: true,
  });
  await expect(agentA.reach(f.target(other))).rejects.toMatchObject(outsideLineage);
  expect(await agentA.targets()).toEqual([]);
}, 90_000);

it("tells the client of a noopener tab's opener nothing of that tab's wake, and the tab's own client everything (run 12)", async () => {
  const f = await lineageSetup("lineage-noopener");
  const c = await f.open("c", 3);
  // `a` opened from `c` without an opener.
  await f.ledger.binding(c as never)!.cdp.send("Runtime.evaluate", {
    expression: `void window.open(${JSON.stringify(`${f.server.originForSite(1)}/article?id=a`)}, "_blank", "noopener")`,
    userGesture: true,
  });
  const a = await vi.waitFor(
    () => {
      const found = f.ledger
        .snapshot()
        .find((s) => f.ledger.binding(s.id)?.page.url().includes("id=a"));
      expect(found).toBeDefined();
      return found!.id as string;
    },
    { timeout: 10_000, interval: 25 },
  );
  await waitLoaded(f.ledger.binding(a as never)!.cdp, "/article");
  await evalValue(f.ledger.binding(a as never)!.cdp, `sessionStorage.setItem("mark", "a")`);
  // Each client is told of new targets and attaches to them as Chromium announces them.
  const events = (client: StandardCdpAttachment) => {
    const seen: string[] = [];
    client.onEvent(({ method, parameters }) => {
      const info = (parameters as { targetInfo?: { targetId?: string } }).targetInfo;
      if (info?.targetId) seen.push(`${method} ${info.targetId}`);
    });
    return seen;
  };
  const clientOf = async (attachmentId: string, seedTargetId: string) => {
    const client = f.router.openStandardClient("session-lineage-noopener", {
      wholeContext: false,
      connection: true,
      lineage: { attachmentId, seedTargetId },
    });
    cleanup.push(async () => client.close());
    const seen = events(client);
    await client.send({ method: "Target.setDiscoverTargets", parameters: { discover: true } });
    await client.send({
      method: "Target.setAutoAttach",
      parameters: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
    });
    return { client, seen };
  };
  const ofA = await clientOf("agent-a", f.target(a));
  const ofC = await clientOf("agent-c", f.target(c));
  const agentA = f.agent("agent-a-reach", f.target(a));
  const agentC = f.agent("agent-c-reach", f.target(c));
  // Before the sleep: `c`'s client reaches `a` only if Chromium named `c` as its opener.
  const cReachedA = await agentC.reach(f.target(a)).then(
    () => true,
    () => false,
  );
  process.stdout.write(`${JSON.stringify({ event: "noopener.before", cReachedA })}\n`);
  expect(cReachedA).toBe(false);

  expect(await f.ledger.sleep(a as never, () => null)).toBe(true);
  const woken = await f.ledger.wake(a as never);
  await waitLoaded(woken.cdp, "/article");
  process.stdout.write(
    `${JSON.stringify({ event: "noopener.after", woken: woken.targetId, ofA: ofA.seen, ofC: ofC.seen })}\n`,
  );
  // `a`'s client is told of the woken tab and reaches it with its state; `c`'s is told nothing
  // of it and cannot reach it.
  await vi.waitFor(() => expect(ofA.seen).toContain(`Target.targetCreated ${woken.targetId}`));
  expect(await agentA.reach(woken.targetId)).toBe("a");
  expect(ofC.seen.filter((entry) => entry.endsWith(woken.targetId))).toEqual([]);
  await expect(agentC.reach(woken.targetId)).rejects.toMatchObject(outsideLineage);
  expect(await agentC.targets()).toEqual([f.target(c)]);
}, 90_000);

it("sleeps a tab under memory pressure through the sleeper as soon as the helper answers late, by discard with its state, and holds opens meanwhile (R1, R4)", async () => {
  // The helper's first answer is held until the test lets it through (a slow first worker start).
  const { ChromiumTabLifecycleBridge: Bridge } = await import("./tab-lifecycle-extension.js");
  const inventory = Bridge.prototype.inventory;
  const firstAnswer = Promise.withResolvers<void>();
  let first = true;
  vi.spyOn(Bridge.prototype, "inventory").mockImplementation(async function (
    this: ChromiumTabLifecycleBridge,
    ...args: Parameters<ChromiumTabLifecycleBridge["inventory"]>
  ) {
    if (first) {
      first = false;
      await firstAnswer.promise;
    }
    return inventory.apply(this, args);
  });
  const server = await startFixtureServer();
  const directory = await mkdtemp(path.join(tmpdir(), "os-tab-sleep-late-helper-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const launcher = new PlaywrightChromiumLauncher({
    executablePath,
    chromiumSandbox: false,
    headless: true,
  });
  const launched = await launcher.launch(nativeProfileRequest(directory));
  cleanup.push(() => launched.close());
  const ledger = new SurfaceLedger(launched.context);
  await ledger.start();
  cleanup.push(() => ledger.close());
  const tab = await ledger.openSurface();
  const cdp = ledger.binding(tab.id)!.cdp;
  await cdp.send("Page.navigate", { url: `${server.originForSite(1)}/draft?id=late` });
  await waitLoaded(cdp, "/draft");
  await evalValue(cdp, `sessionStorage.setItem("mark", "kept")`);
  await evalValue(cdp, "document.getElementById('draft').focus()");
  await cdp.send("Input.insertText", { text: "typed early" });
  await evalValue(cdp, "document.activeElement.blur()");
  await evalValue(cdp, "window.scrollTo(0, 1750)");
  // The runtime's sleeper, over the start threshold, with this browser's look still running.
  const limit = 2 * 1024 ** 3;
  let samples = 0;
  const sleeper = new TabSleeper({
    memoryPressure: async () => {
      samples++;
      return { usedBytes: Math.round(limit * 0.8), limitBytes: limit };
    },
  });
  cleanup.push(async () => sleeper.close());
  sleeper.add("session", {
    ledger,
    restoreVersion: 1,
    blocked: () => null,
    sleepReady: () => launched.context.sleepReady?.() ?? null,
  });
  sleeper.setSessionState("session", { runs: 0, personUsed: [], viewed: [], pinned: [] });
  // Passes run (they sample the memory) and sleep nothing; opens over the threshold wait.
  await vi.waitFor(() => expect(samples).toBeGreaterThanOrEqual(2), { timeout: 10_000 });
  let opened = 0;
  void sleeper.beforePageOpen().then(() => opened++);
  void sleeper.beforePageOpen().then(() => opened++);
  const sampled = samples;
  await vi.waitFor(() => expect(samples).toBeGreaterThan(sampled), { timeout: 10_000 });
  expect(opened).toBe(0);
  expect(ledger.stateOf(tab.id)).not.toBe("suspended");
  // The helper answers: the tab sleeps at once, not a probe penalty later.
  const released = performance.now();
  firstAnswer.resolve();
  await vi.waitFor(() => expect(ledger.stateOf(tab.id)).toBe("suspended"), {
    timeout: 3_000,
    interval: 25,
  });
  const sleptAfterMs = performance.now() - released;
  process.stdout.write(`${JSON.stringify({ event: "r4.slept-after-release", sleptAfterMs })}\n`);
  await vi.waitFor(() => expect(opened).toBe(2), { timeout: 5_000 });
  sleeper.close();
  const woken = await ledger.wake(tab.id);
  await waitLoaded(woken.cdp, "/draft");
  expect((woken.page as unknown as { openedFresh?: boolean }).openedFresh).not.toBe(true);
  expect(
    await evalValue(
      woken.cdp,
      `({ mark: sessionStorage.getItem("mark"), draft: document.getElementById("draft").value, scroll: window.scrollY })`,
    ),
  ).toEqual({ mark: "kept", draft: "typed early", scroll: 1750 });
}, 60_000);

it("stops a look for the tab helper that ran out: no target poll and no navigation of the private page after it (R6)", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "os-tab-sleep-look-timeout-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  // The helper's worker is never found (as on a browser that does not load it): the real wait
  // polls for it and wakes it through the private page, until the look runs out.
  const { ChromiumTabLifecycleBridge: Bridge } = await import("./tab-lifecycle-extension.js");
  let polls = 0;
  vi.spyOn(
    Bridge.prototype as unknown as { runningServiceWorkerTarget(): Promise<string | null> },
    "runningServiceWorkerTarget",
  ).mockImplementation(async () => {
    polls++;
    return null;
  });
  const launcher = new PlaywrightChromiumLauncher({
    executablePath,
    chromiumSandbox: false,
    headless: true,
    tabLifecycleProbeMs: 1_500,
  });
  const launched = await launcher.launch(nativeProfileRequest(directory));
  cleanup.push(() => launched.close());
  const internal = launched as unknown as {
    contextHandle: {
      lifecycle: unknown;
      lifecycleSettled: Promise<void>;
      privatePage: { goto(url: string, options?: unknown): Promise<unknown> };
    };
  };
  let navigations = 0;
  const anchor = internal.contextHandle.privatePage;
  const goto = anchor.goto.bind(anchor);
  anchor.goto = (url, options) => {
    navigations++;
    return goto(url, options);
  };
  await internal.contextHandle.lifecycleSettled;
  expect(internal.contextHandle.lifecycle).toBeUndefined();
  expect(polls).toBeGreaterThan(0);
  const after = { polls, navigations };
  // Ordinary work for a while after the look ended (pages open, load and close).
  for (let i = 0; i < 6; i++) {
    const page = await launched.context.createPage();
    const cdp = await page.cdp();
    await cdp.send("Page.navigate", { url: "about:blank#" + i });
    await page.close();
  }
  expect({ polls, navigations }).toEqual(after);
}, 60_000);
