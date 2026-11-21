import { SessionCdpRouter } from "@opensteer/browser-core";
import { SurfaceLedger } from "@opensteer/browser-runtime-core";
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
import type { ChromiumTabLifecycleBridge } from "./tab-lifecycle-extension.js";

const executablePath = findChromium();

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
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
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
  const launched = await launcher.launch(nativeProfileRequest(directory));
  cleanup.push(() => launched.close());
  const internal = launched as unknown as {
    playwrightContext: { process(): { pid: number } };
    contextHandle: { lifecycle: ChromiumTabLifecycleBridge };
  };
  const rootPid = internal.playwrightContext.process().pid;
  const lifecycle = internal.contextHandle.lifecycle;

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
  const launched = await launcher.launch(nativeProfileRequest(directory));
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
    contextHandle: { lifecycle: ChromiumTabLifecycleBridge };
  };

  // Ensure the helper extension worker is loaded and running in Chromium.
  const initialInventory = await internal.contextHandle.lifecycle.inventory();
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
  const launched = await launcher.launch(request);
  cleanup.push(() => launched.close());
  const internal = launched as unknown as {
    contextHandle: { lifecycle: ChromiumTabLifecycleBridge };
  };
  const lifecycle = internal.contextHandle.lifecycle;

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

  // If removal fails once, confirmed session end must refuse and keep the restore handle for retry.
  const origRemove = lifecycle.removeByTabId.bind(lifecycle);
  let failOnce = true;
  const spy = vi.spyOn(lifecycle, "removeByTabId").mockImplementation(async (tabId) => {
    if (failOnce) {
      failOnce = false;
      return false;
    }
    return origRemove(tabId);
  });
  await expect(ledger.closeOwnedPages("session-ended", true)).rejects.toThrow(
    /Pages are still closing/,
  );
  spy.mockRestore();

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
    contextHandle: { lifecycle: ChromiumTabLifecycleBridge };
  };
  const invAfterRestart = await internal2.contextHandle.lifecycle.inventory();
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
  const launched = await launcher.launch(nativeProfileRequest(directory));
  cleanup.push(() => launched.close());
  const internal = launched as unknown as {
    contextHandle: { lifecycle: ChromiumTabLifecycleBridge };
  };
  const lifecycle = internal.contextHandle.lifecycle;

  const ledger = new SurfaceLedger(launched.context);
  await ledger.start();
  cleanup.push(() => ledger.close());

  // Tab 1: helper inventory / tabIdForTargetId throws during sleep -> must STILL sleep and wake by address!
  const url1 = `${server.originForSite(1)}/article`;
  const s1 = await ledger.openSurface();
  const live1 = ledger.binding(s1.id)!;
  await live1.cdp.send("Page.navigate", { url: url1 });
  await waitLoaded(live1.cdp, "/article");

  const invSpy = vi
    .spyOn(lifecycle, "inventory")
    .mockRejectedValue(new Error("Helper worker crashed"));
  const tabIdSpy = vi
    .spyOn(lifecycle, "tabIdForTargetId")
    .mockRejectedValue(new Error("Helper worker crashed"));
  expect(await ledger.sleep(s1.id, () => null)).toBe(true);
  expect(ledger.stateOf(s1.id)).toBe("suspended");
  const rec1 = [...ledger.policyRecords()].find((r) => r.id === s1.id)!;
  expect(rec1.unrestorable).toBe(false);
  invSpy.mockRestore();
  tabIdSpy.mockRestore();

  const woken1 = await ledger.wake(s1.id);
  await waitLoaded(woken1.cdp, "/article");

  // Tab 2: discardByTabId fails -> closes cleanly and wakes by address!
  const url2 = `${server.originForSite(2)}/article`;
  const s2 = await ledger.openSurface();
  const live2 = ledger.binding(s2.id)!;
  await live2.cdp.send("Page.navigate", { url: url2 });
  await waitLoaded(live2.cdp, "/article");

  const discardSpy = vi.spyOn(lifecycle, "discardByTabId").mockResolvedValue(null);
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
  const launched = await launcher.launch(nativeProfileRequest(directory));
  cleanup.push(() => launched.close());
  const internal = launched as unknown as {
    contextHandle: { lifecycle: ChromiumTabLifecycleBridge };
  };
  const lifecycle = internal.contextHandle.lifecycle;

  const ledger = new SurfaceLedger(launched.context);
  await ledger.start();
  cleanup.push(() => ledger.close());

  // Case A: wake starts while discardByTabId reply is still in flight after Chromium discarded the tab.
  const urlA = `${server.originForSite(1)}/article`;
  const sA = await ledger.openSurface();
  const liveA = ledger.binding(sA.id)!;
  await liveA.cdp.send("Page.navigate", { url: urlA });
  await waitLoaded(liveA.cdp, "/article");
  await evalValue(liveA.cdp, "window.scrollTo(0, 1750)");

  const origDiscard = lifecycle.discardByTabId.bind(lifecycle);
  const releaseReply = Promise.withResolvers<void>();
  const discardSpyA = vi.spyOn(lifecycle, "discardByTabId").mockImplementation(async (tabId) => {
    const newId = await origDiscard(tabId);
    await releaseReply.promise;
    return newId;
  });

  // ledger.sleep returns as soon as Chromium closes the WebContents during discard,
  // while discardByTabId's reply is still held!
  expect(await ledger.sleep(sA.id, () => null)).toBe(true);
  const wakePromise = ledger.wake(sA.id);
  // Release the discard reply after wake has already entered createPage.
  await new Promise((resolve) => setTimeout(resolve, 60));
  releaseReply.resolve();
  const wokenA = await wakePromise;
  discardSpyA.mockRestore();

  await waitLoaded(wokenA.cdp, "/article");
  await vi.waitFor(
    async () => expect(await evalValue<number>(wokenA.cdp, "window.scrollY")).toBe(1750),
    { timeout: 3_000, interval: 50 },
  );
  const invA = await lifecycle.inventory();
  expect(invA.filter((tab) => tab.url === urlA)).toHaveLength(1);

  // Case B: discardByTabId throws/times out AFTER Chromium already discarded the tab!
  const urlB = `${server.originForSite(2)}/article`;
  const sB = await ledger.openSurface();
  const liveB = ledger.binding(sB.id)!;
  await liveB.cdp.send("Page.navigate", { url: urlB });
  await waitLoaded(liveB.cdp, "/article");
  await evalValue(liveB.cdp, "window.scrollTo(0, 2350)");

  const discardSpyB = vi.spyOn(lifecycle, "discardByTabId").mockImplementation(async (tabId) => {
    await origDiscard(tabId);
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

it("hands off new popups synchronously even while restored tabs are parked, without dropping short-lived popups", async () => {
  const server = await startFixtureServer();
  const directory = await mkdtemp(path.join(tmpdir(), "os-tab-sleep-f6-handoff-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));

  const launcher = new PlaywrightChromiumLauncher({
    executablePath,
    chromiumSandbox: false,
    headless: true,
  });
  const request = nativeProfileRequest(directory);

  // Seed one saved tab so the next launch has a parked unclaimed restored tab.
  const b1 = await launcher.launch(request);
  const ledger1 = new SurfaceLedger(b1.context, { savedLineageId: "profile-f6" });
  await ledger1.start();
  const saved = await ledger1.openSurface();
  const savedLive = ledger1.binding(saved.id)!;
  await savedLive.cdp.send("Page.navigate", { url: `${server.originForSite(1)}/article` });
  await waitLoaded(savedLive.cdp, "/article");
  await b1.context.sessionRestore!.flush!();
  await vi.waitFor(
    async () => {
      const { readdir, stat } = await import("node:fs/promises");
      const files = await readdir(path.join(directory, "Default", "Sessions")).catch(() => []);
      const sf = files.filter((n) => n.startsWith("Session_"));
      expect(sf.length).toBeGreaterThan(0);
      const sizes = await Promise.all(
        sf.map((n) => stat(path.join(directory, "Default", "Sessions", n)).then((s) => s.size)),
      );
      expect(Math.max(...sizes)).toBeGreaterThan(0);
    },
    { timeout: 10_000, interval: 100 },
  );
  await ledger1.close();
  await b1.close();

  // Relaunch: restored tab is now parked (unclaimedRestoredTabs.size > 0).
  const b2 = await launcher.launch(request);
  cleanup.push(() => b2.close());
  const internal2 = b2 as unknown as {
    playwrightContext: { on(event: string, listener: (p: unknown) => void): void };
    contextHandle: { lifecycle: ChromiumTabLifecycleBridge };
  };

  // Open an ordinary page (without claiming the parked restored tab).
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
