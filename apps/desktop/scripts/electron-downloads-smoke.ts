import { SessionCdpRouter } from "@opensteer/browser-core";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { z } from "zod";
/**
 * Failure journeys declared before the owner implementation:
 * - attachment, same-origin anchor, blob, data and popup silently refused or corrupted;
 * - sequential/concurrent/case-folded names collide, existing files overwritten,
 *   compound extensions misplaced, hostile/hidden/empty/long names escape or overflow;
 * - cancellation, resumable interruption and terminal interruption leave partial files;
 * - tab close or same-partition close/relaunch kills a download;
 * - shutdown exits before cancellation completes or admits new work;
 * - completed files lack LaunchServices quarantine or lose an existing mark;
 * - agent clicks fail or the agent can override download behavior;
 * - history drops active items, exceeds finished bounds or reverses creation order;
 * - progress floods subscribers or start/finish updates are delayed;
 * - the 101st active item is admitted or disappears without a failed entry;
 * - the app-window session still refuses attachment blob anchors;
 * - open/show trust renderer paths, miss deleted files or hide shell failures;
 * - duplicate session acceptance registers twice; bridge authorization/parsing fails;
 * - partial files survive the actual Electron process exit (parent verifies);
 * - an unfinished file ever appears in Downloads, or a crash's staged files outlive the next start;
 * - Downloads on another volume gets an unmarked, partial or replacing copy, or a quit mid-copy
 *   leaves one behind;
 * - a valid long host name with a port overflows the list's bounds and stops its publication.
 */
import {
  SurfaceLedger,
  type BrowserLaunchRequest,
  type LaunchedBrowser,
} from "@opensteer/browser-runtime-core";
import { BrowserSessionIdSchema } from "@opensteer/core";
import {
  DesktopDownloadIdSchema,
  type DesktopDownload,
  type DesktopDownloadsSnapshot,
} from "@opensteer/protocol/desktop";
import { app, BrowserWindow, protocol, session } from "electron";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { configureDesktopSession } from "../src/app/electron-window.js";
import { DesktopAppOriginPolicy } from "../src/app/navigation-policy.js";
import {
  ElectronBrowserLauncher,
  electronBrowserPartition,
} from "../src/browser/electron-browser-launcher.js";
import { DesktopDownloads } from "../src/downloads/desktop-downloads.js";

const artifactDirectory =
  process.env.OPENSTEER_DOWNLOADS_E2E_ARTIFACT_DIR ??
  path.join(tmpdir(), "opensteer-downloads-e2e");
mkdirSync(artifactDirectory, { recursive: true });
const directory = path.join(artifactDirectory, "downloads");
mkdirSync(directory, { recursive: true });
const userData = mkdtempSync(path.join(tmpdir(), "opensteer-downloads-user-"));
app.setPath("userData", userData);
app.commandLine.appendSwitch("headless");
app.commandLine.appendSwitch("host-resolver-rules", "MAP *.downloads.test 127.0.0.1");
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
// Outside userData, which the child deletes: the parent checks it after exit.
const staging = path.join(artifactDirectory, "partial-downloads");
const crashLeftover = path.join(staging, "crash-leftover");
mkdirSync(crashLeftover, { recursive: true });
writeFileSync(path.join(crashLeftover, "partial.bin"), "left by a crash");
let downloadsDirectory = directory;
const downloads = new DesktopDownloads({ directory: () => downloadsDirectory, staging });
const otherVolumeImage = path.join(userData, "other-volume");
const otherVolume = path.join(userData, "other-volume-mount");
let otherVolumeAttached = false;
const bigChunk = Buffer.alloc(1024 * 1024, 7);
const bigChunks = 512;
const payload = Buffer.from("Opensteer download fixture.\n");
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const cases: { name: string; passed: boolean; elapsedMs: number; detail?: unknown }[] = [];
const observed = new Map<string, DesktopDownload>();
const broadcasts: { at: number; snapshot: DesktopDownloadsSnapshot }[] = [];
downloads.subscribe((snapshot) => {
  broadcasts.push({ at: performance.now(), snapshot });
  for (const item of snapshot.downloads) observed.set(item.id, item);
});
const timers = new Set<ReturnType<typeof setInterval>>();
const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname === "/") {
    response.end(
      '<!doctype html><body><a id="agent" href="/file?name=agent.txt" style="position:fixed;left:0;top:0;width:200px;height:100px">Download</a></body>',
    );
    return;
  }
  response.setHeader("Content-Type", "application/octet-stream");
  if (url.pathname !== "/inline")
    response.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(url.searchParams.get("name") ?? "server.txt")}`,
    );
  if (url.pathname === "/hold") {
    response.setHeader("Content-Length", 100_000_000);
    response.write(payload);
  } else if (url.pathname === "/slow" || url.pathname === "/abort") {
    response.setHeader("Content-Length", payload.length * 100);
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("ETag", '"fixture"');
    response.write(payload);
    let count = 1;
    const timer = setInterval(() => {
      if (url.pathname === "/abort") {
        response.destroy();
        return;
      }
      response.write(payload);
      if (++count === 100) response.end();
    }, 30);
    timers.add(timer);
    response.on("close", () => {
      clearInterval(timer);
      timers.delete(timer);
    });
  } else if (url.pathname === "/big") {
    response.setHeader("Content-Length", bigChunk.length * bigChunks);
    let sent = 0;
    const pump = () => {
      while (sent < bigChunks) {
        sent++;
        if (!response.write(bigChunk)) {
          response.once("drain", pump);
          return;
        }
      }
      response.end();
    };
    pump();
  } else response.end(payload);
});
let browser: LaunchedBrowser | undefined;
let agentLedger: SurfaceLedger | undefined;
let appWindow: BrowserWindow | undefined;
const liveness = setInterval(() => undefined, 1_000);
app.on("before-quit", (event) => {
  event.preventDefault();
});
app.on("window-all-closed", () => undefined);
void run().then(
  () => finish(),
  (error: unknown) => finish(error),
);

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const start = performance.now();
  while (!predicate()) {
    assert(performance.now() - start < 20_000, `Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function check(name: string, body: () => Promise<unknown>): Promise<void> {
  const start = performance.now();
  process.stdout.write(`${JSON.stringify({ case: name, started: true })}\n`);
  try {
    const detail = await withTimeout(body(), 20_000, {
      timeoutError: () => new Error(`Case timed out: ${name}`),
    });
    cases.push({ name, passed: true, elapsedMs: performance.now() - start, detail });
    process.stdout.write(`${JSON.stringify({ case: name, passed: true })}\n`);
  } catch (error) {
    writeFileSync(
      path.join(artifactDirectory, "failure.json"),
      JSON.stringify(
        {
          name,
          snapshot: downloads.snapshot(),
          observed: [...observed.values()],
          error: String(error),
        },
        null,
        2,
      ),
    );
    cases.push({
      name,
      passed: false,
      elapsedMs: performance.now() - start,
      detail: String(error),
    });
    throw error;
  }
}
async function run(): Promise<void> {
  await app.whenReady();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const request = {
    initialViewport: { devicePixelRatio: 1, height: 600, width: 800 },
    partitionKey: "profile:bpr_00000000-0000-4000-8000-000000000901",
    sessionId: BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000901"),
    storage: { kind: "guest" },
  } satisfies BrowserLaunchRequest;
  const launcher = new ElectronBrowserLauncher({
    downloads,
    pagePolicyPreloadPath: path.join(import.meta.dirname, "browser-page-preload.cjs"),
  });
  browser = await launcher.launch(request);
  let page = browser.context.pages()[0];
  assert(page);
  let cdp = await page.cdp();
  const evaluate = async (expression: string) => {
    const result = await cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    assert(
      result !== null && typeof result === "object" && !("exceptionDetails" in result),
      JSON.stringify(result),
    );
    return result;
  };
  await cdp.send("Page.navigate", { url: origin });
  await waitFor(() => page?.url() === `${origin}/`, "fixture navigation");
  const partition = session.fromPartition(electronBrowserPartition(request.partitionKey));
  downloads.accept(partition);
  const start = async (expression: string): Promise<DesktopDownload> => {
    const before = new Set(observed.keys());
    await evaluate(expression);
    await waitFor(() => [...observed.keys()].some((id) => !before.has(id)), "download admission");
    const entry = [...observed.values()].find((item) => !before.has(item.id));
    assert(entry);
    DesktopDownloadIdSchema.parse(entry.id);
    return entry;
  };
  const anchor = (url: string, name?: string) =>
    `(() => { const a=document.createElement('a'); a.href=${JSON.stringify(url)}; ${name === undefined ? "" : `a.download=${JSON.stringify(name)};`} document.body.append(a); a.click(); a.remove(); })()`;
  const ended = async (item: DesktopDownload, expected: DesktopDownload["state"] = "completed") => {
    await waitFor(
      () =>
        observed.get(item.id)?.state !== "progressing" &&
        (expected === "completed" || !existsSync(path.join(downloadsDirectory, item.filename))),
      `finish ${item.filename}`,
    );
    const final = observed.get(item.id);
    assert.equal(final?.state, expected);
    assert(!existsSync(path.join(staging, item.id)), `Staged file remains: ${item.filename}`);
    if (expected === "completed") {
      const bytes = readFileSync(path.join(downloadsDirectory, final.filename));
      assert.equal(hash(bytes), hash(payload));
    } else
      assert(
        !existsSync(path.join(downloadsDirectory, item.filename)),
        `Partial remains: ${item.filename}`,
      );
    return final;
  };
  await check("crash-leftovers-swept-at-start", async () => {
    assert(!existsSync(crashLeftover));
    assert(existsSync(staging));
  });
  await check("A01-attachment-name-and-hash", async () =>
    ended(await start(anchor(`${origin}/file?name=server.txt`))),
  );
  await check("A02-same-origin-download-anchor", async () => {
    const item = await ended(await start(anchor(`${origin}/inline`, "anchor.txt")));
    assert.equal(item?.filename, "anchor.txt");
  });
  const blobAnchor = (name: string) =>
    `(() => { const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([${JSON.stringify(payload.toString())}])); a.download=${JSON.stringify(name)}; document.body.append(a); a.click(); a.remove(); })()`;
  await check("A03-blob-origin", async () => {
    const item = await ended(await start(blobAnchor("blob.txt")));
    assert.equal(item?.site, new URL(origin).hostname);
  });
  await check("A04-data-null-site", async () => {
    for (const [url, name] of [
      [`data:text/plain;base64,${payload.toString("base64")}`, "data.txt"],
      [`data://example.test/,${encodeURIComponent(payload.toString())}`, "data-origin.txt"],
    ] as const) {
      const item = await ended(await start(anchor(url, name)));
      assert.equal(item?.site, null);
    }
  });
  await check("A05-popup-attachment", async () =>
    ended(await start(`void window.open(${JSON.stringify(`${origin}/file?name=popup.txt`)})`)),
  );
  await check("A06-sequential-concurrent-compound-existing-case", async () => {
    const names = [];
    for (let index = 0; index < 3; index++)
      names.push((await ended(await start(anchor(`${origin}/file?name=a.txt`))))?.filename);
    assert.deepEqual(names, ["a.txt", "a (1).txt", "a (2).txt"]);
    const before = new Set(observed.keys());
    partition.downloadURL(`${origin}/file?name=concurrent.txt`);
    partition.downloadURL(`${origin}/file?name=concurrent.txt`);
    await waitFor(
      () =>
        [...observed.values()].filter((item) => !before.has(item.id) && item.state === "completed")
          .length === 2,
      "concurrent downloads",
    );
    const concurrent = [...observed.values()].filter((item) => !before.has(item.id));
    assert.equal(new Set(concurrent.map((item) => item.filename)).size, 2);
    for (let i = 0; i < 2; i++)
      await ended(await start(anchor(`${origin}/file?name=archive.tar.gz`)));
    assert(existsSync(path.join(directory, "archive (1).tar.gz")));
    writeFileSync(path.join(directory, "existing.txt"), "keep me");
    const existing = await ended(await start(anchor(`${origin}/file?name=existing.txt`)));
    assert.equal(existing?.filename, "existing (1).txt");
    assert.equal(readFileSync(path.join(directory, "existing.txt"), "utf8"), "keep me");
    const beforeCase = new Set(observed.keys());
    partition.downloadURL(`${origin}/file?name=a.txt`);
    partition.downloadURL(`${origin}/file?name=A.txt`);
    await waitFor(
      () =>
        [...observed.values()].filter(
          (item) => !beforeCase.has(item.id) && item.state === "completed",
        ).length === 2,
      "case collision",
    );
    const folded = [...observed.values()].filter((item) => !beforeCase.has(item.id));
    assert.equal(new Set(folded.map((item) => item.filename.toLowerCase())).size, 2);
    return { names, concurrent, folded };
  });
  await check("A07-hostile-hidden-long-empty-names", async () => {
    const names = [];
    for (const name of [
      "../x",
      ".hidden",
      "é".repeat(150) + ".txt",
      "",
      ".",
      "..",
      "folder\\evil.txt",
      "control\u0001.txt",
    ]) {
      const item = await ended(
        await start(anchor(`${origin}/file?name=${encodeURIComponent(name)}`)),
      );
      assert(item);
      assert.equal(path.basename(item.filename), item.filename);
      assert(!item.filename.startsWith("."));
      assert(!/[\p{Cc}/\\]/u.test(item.filename));
      assert(Buffer.byteLength(item.filename) <= 255);
      names.push({ requested: name, saved: item.filename });
      // The VM's artifact export (rsync) cannot stage a temporary file beside a 255-byte name.
      if (Buffer.byteLength(item.filename) > 200) rmSync(path.join(directory, item.filename));
    }
    return names;
  });
  await check("A08-cancel-no-partial", async () => {
    const item = await start(anchor(`${origin}/slow?name=cancel.txt`));
    await waitFor(() => (observed.get(item.id)?.receivedBytes ?? 0) > 0, "partial bytes");
    assert(existsSync(path.join(staging, item.id, item.filename)), "Partial is not staged");
    assert(!existsSync(path.join(directory, item.filename)), "Partial entered Downloads");
    assert.equal(downloads.cancel(item.id).status, "done");
    return ended(item, "cancelled");
  });
  await check("A09-server-abort-no-partial", async () =>
    ended(await start(anchor(`${origin}/abort?name=abort.txt`)), "failed"),
  );
  await check("A10-tab-close-survives", async () => {
    const tab = await browser!.context.createPage();
    const tabCdp = await tab.cdp();
    await tabCdp.send("Page.navigate", { url: origin });
    await waitFor(() => tab.url() === `${origin}/`, "tab navigation");
    const before = new Set(observed.keys());
    await tabCdp.send("Runtime.evaluate", {
      expression: anchor(`${origin}/slow?name=tab-close.txt`),
      userGesture: true,
    });
    await waitFor(() => [...observed.keys()].some((id) => !before.has(id)), "tab download");
    const item = [...observed.values()].find((item) => !before.has(item.id));
    assert(item);
    await tab.close();
    await waitFor(() => observed.get(item.id)?.state === "completed", "download after tab close");
    assert.equal(
      hash(readFileSync(path.join(directory, observed.get(item.id)!.filename))),
      hash(Buffer.concat(Array.from({ length: 100 }, () => payload))),
    );
  });
  await check("review-runtime-close-relaunch-survives", async () => {
    const item = await start(anchor(`${origin}/slow?name=relaunch.txt`));
    await browser!.close();
    browser = await launcher.launch(request);
    page = browser.context.pages()[0];
    assert(page);
    cdp = await page.cdp();
    await cdp.send("Page.navigate", { url: origin });
    await waitFor(
      () => observed.get(item.id)?.state === "completed",
      "download after runtime close/relaunch",
    );
    assert.equal(
      hash(readFileSync(path.join(directory, observed.get(item.id)!.filename))),
      hash(Buffer.concat(Array.from({ length: 100 }, () => payload))),
    );
  });
  await check("A12-quarantine-xattr", async () => {
    assert.equal(process.platform, "darwin", "This smoke certifies macOS quarantine");
    const values = readdirSync(directory)
      .filter((name) => name !== "existing.txt")
      .map((name) => ({
        name,
        value: execFileSync(
          "/usr/bin/xattr",
          ["-p", "com.apple.quarantine", path.join(directory, name)],
          { encoding: "utf8" },
        ).trim(),
      }));
    for (const { value } of values)
      assert.match(value, /^[0-9a-f]{4};[0-9a-f]+;[^;]+;[A-Za-z0-9-]*$/iu);
    assert(values.some(({ value }) => value.includes(";Opensteer;")));
    return values;
  });
  await check("A13-agent-click-and-download-behavior-refused", async () => {
    await waitFor(() => page?.url() === `${origin}/`, "agent page");
    const router = new SessionCdpRouter(browser!.cdp);
    const targetId = await page!.targetId();
    const ledger = new SurfaceLedger(browser!.context, {
      claimTarget: (id) => router.claimTarget(request.sessionId, id),
      initialViewport: request.initialViewport,
    });
    agentLedger = ledger;
    router.registerSession(
      request.sessionId,
      targetId,
      (id) => ledger.resolveTarget(id),
      path.join(userData, "agent-files"),
    );
    try {
      await ledger.start();
      await assert.rejects(
        router.send(request.sessionId, {
          method: "Browser.setDownloadBehavior",
          parameters: { behavior: "allow", downloadPath: directory },
        }),
        { code: "forbidden" },
      );
      const attached = z.object({ sessionId: z.string() }).parse(
        await router.send(request.sessionId, {
          method: "Target.attachToTarget",
          parameters: { targetId, flatten: true },
        }),
      );
      const agent = {
        send: (method: string, parameters: Record<string, unknown>) =>
          router.send(request.sessionId, { method, parameters, sessionId: attached.sessionId }),
      };
      const before = new Set(observed.keys());
      await agent.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        button: "left",
        clickCount: 1,
        x: 30,
        y: 30,
      });
      await agent.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        button: "left",
        clickCount: 1,
        x: 30,
        y: 30,
      });
      await waitFor(
        () =>
          [...observed.values()].some((item) => !before.has(item.id) && item.state === "completed"),
        "agent click download",
      );
    } finally {
      await router.close();
    }
  });
  await check("A14-progress-coalescing", async () => {
    const before = broadcasts.length;
    const item = await start(anchor(`${origin}/slow?name=progress.txt`));
    await waitFor(() => observed.get(item.id)?.state === "completed", "progress finish");
    const changes = broadcasts.slice(before);
    const progress = changes.filter(
      ({ snapshot }) =>
        snapshot.downloads.find((entry) => entry.id === item.id)?.state === "progressing",
    );
    assert(progress.length >= 2);
    for (let i = 1; i < progress.length; i++)
      assert(progress[i]!.at - progress[i - 1]!.at >= 249, "Progress broadcast sooner than 250ms");
    return { timings: changes.map(({ at }) => at), progressCount: progress.length };
  });
  await check("A15-app-window-session-blob", async () => {
    const appSession = session.fromPartition("downloads-app-smoke");
    configureDesktopSession(appSession, new DesktopAppOriginPolicy(), null, downloads);
    appSession.protocol.handle(
      "app",
      () =>
        new Response("<!doctype html><body>Attachment fixture</body>", {
          headers: { "content-type": "text/html" },
        }),
    );
    appWindow = new BrowserWindow({
      show: false,
      webPreferences: { session: appSession, sandbox: true, contextIsolation: true },
    });
    await appWindow.loadURL("app://opensteer/");
    const before = new Set(observed.keys());
    await appWindow.webContents.executeJavaScript(blobAnchor("app-attachment.txt"), true);
    await waitFor(
      () =>
        [...observed.values()].some((item) => !before.has(item.id) && item.state === "completed"),
      "app blob download",
    );
    const item = [...observed.values()].find((item) => !before.has(item.id));
    assert(item);
    assert.equal(hash(readFileSync(path.join(directory, item.filename))), hash(payload));
    assert.equal(item.site, "opensteer");
    appWindow.destroy();
    appWindow = undefined;
  });
  await check("actions-missing-and-unknown", async () => {
    assert.equal((await downloads.open("unknown")).status, "missing");
    assert.equal(downloads.show("unknown").status, "missing");
    assert.equal(downloads.cancel("unknown").status, "missing");
    const item = await ended(await start(anchor(`${origin}/file?name=moved.txt`)));
    assert(item);
    rmSync(path.join(directory, item.filename));
    assert.equal(downloads.show(item.id).status, "missing");
    assert.equal((await downloads.open(item.id)).status, "missing");
  });
  await check("A14-history-order-bound-active-preservation", async () => {
    const active = await start(anchor(`${origin}/hold?name=history-active.txt`));
    for (let i = 0; i < 55; i++)
      await ended(await start(anchor(`${origin}/file?name=history-${i}.txt`)));
    const snapshot = downloads.snapshot().downloads;
    assert(snapshot.some((item) => item.id === active.id));
    assert.equal(snapshot.filter((item) => item.state !== "progressing").length, 50);
    assert.equal(snapshot[0]?.filename, "history-54.txt");
    downloads.cancel(active.id);
    return { count: snapshot.length, newest: snapshot[0] };
  });
  await check("review-admission-101st-refused-active-retained", async () => {
    const before = new Set(observed.keys());
    // Pause the response stream indefinitely to exercise admission, rather than a timing race.
    for (let i = 0; i < 101; i++)
      partition.downloadURL(
        `http://slot-${i}.downloads.test:${address.port}/hold?name=overflow-${i}.txt`,
      );
    await waitFor(
      () => [...observed.keys()].filter((id) => !before.has(id)).length === 101,
      "101 admissions",
    );
    const snapshot = downloads.snapshot().downloads;
    assert.equal(snapshot.filter((item) => item.state === "progressing").length, 100);
    const refused = [...observed.values()].filter(
      (item) => !before.has(item.id) && item.state === "failed",
    );
    assert.equal(refused.length, 1);
    assert(!existsSync(path.join(directory, refused[0]!.filename)));
    for (const item of snapshot) if (item.state === "progressing") downloads.cancel(item.id);
    return { active: 100, refused };
  });
  await check("review-site-is-a-bounded-host-name", async () => {
    const host = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(45)}.downloads.test`;
    assert.equal(host.length, 252);
    const before = new Set(observed.keys());
    partition.downloadURL(`http://${host}:${address.port}/file?name=long-host.txt`);
    await waitFor(
      () =>
        [...observed.values()].some((item) => !before.has(item.id) && item.state === "completed"),
      "long host download",
    );
    const item = [...observed.values()].find((item) => !before.has(item.id));
    assert.equal(item?.site, host);
    assert(downloads.snapshot().downloads.some((entry) => entry.id === item.id));
    return { site: item.site };
  });
  const listVolume = () =>
    readdirSync(downloadsDirectory).map((name) => {
      const file = path.join(downloadsDirectory, name);
      let quarantine: string | null = null;
      try {
        quarantine = execFileSync("/usr/bin/xattr", ["-p", "com.apple.quarantine", file], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {
        quarantine = null;
      }
      return { name, size: statSync(file).size, quarantine };
    });
  await check("review-other-volume-copy-marked-and-never-replacing", async () => {
    execFileSync("/usr/bin/hdiutil", [
      "create",
      "-quiet",
      "-size",
      "2g",
      "-type",
      "SPARSE",
      "-fs",
      "APFS",
      "-volname",
      "OpensteerDownloadsSmoke",
      otherVolumeImage,
    ]);
    mkdirSync(otherVolume, { recursive: true });
    execFileSync("/usr/bin/hdiutil", [
      "attach",
      "-quiet",
      "-nobrowse",
      "-mountpoint",
      otherVolume,
      `${otherVolumeImage}.sparseimage`,
    ]);
    otherVolumeAttached = true;
    assert.notEqual(statSync(otherVolume).dev, statSync(staging).dev, "Not another volume");
    downloadsDirectory = path.join(otherVolume, "Downloads");
    const names = [];
    for (let index = 0; index < 2; index++)
      names.push((await ended(await start(anchor(`${origin}/file?name=volume.txt`))))?.filename);
    assert.deepEqual(names, ["volume.txt", "volume (1).txt"]);
    const files = listVolume();
    assert.deepEqual(files.map(({ name }) => name).sort(), ["volume (1).txt", "volume.txt"]);
    for (const file of files)
      assert.match(file.quarantine ?? "", /^[0-9a-f]{4};[0-9a-f]+;Opensteer;[A-Za-z0-9-]*$/iu);
    return files;
  });
  await check("A11-shutdown-bounded-no-new-admission", async () => {
    const item = await start(anchor(`${origin}/hold?name=shutdown-partial.txt`));
    const staged = path.join(staging, item.id, item.filename);
    await waitFor(() => existsSync(staged), "staged partial");
    assert(!existsSync(path.join(downloadsDirectory, item.filename)), "Partial entered Downloads");
    writeFileSync(
      path.join(artifactDirectory, "exit-paths.json"),
      JSON.stringify({ staging, partial: path.join(directory, item.filename) }),
    );
    // Quit while a large file is being copied to the Downloads folder on the other volume.
    const big = await start(anchor(`${origin}/big?name=big.bin`));
    const copying = () =>
      readdirSync(downloadsDirectory).some((name) => name.endsWith(".opensteer-download"));
    await waitFor(
      () => copying() || observed.get(big.id)?.state !== "progressing",
      "copy to the other volume",
    );
    const copyObserved = copying();
    const before = observed.size;
    await downloads.close();
    partition.downloadURL(`${origin}/file?name=after-close.txt`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(observed.size, before);
    assert(!existsSync(staged), "Staged partial outlived close");
    assert(!existsSync(path.join(directory, item.filename)));
    assert(!existsSync(path.join(downloadsDirectory, item.filename)));
    // The large file is either whole and marked, or absent; never partial or hidden.
    const volume = listVolume();
    assert(!volume.some(({ name }) => name.endsWith(".opensteer-download")), "Copy outlived close");
    const bigFile = volume.find(({ name }) => name.startsWith("big"));
    if (bigFile) {
      assert.equal(bigFile.size, bigChunk.length * bigChunks);
      assert.match(bigFile.quarantine ?? "", /;Opensteer;/u);
    }
    return {
      partial: item.filename,
      copyObserved,
      bigOutcome: observed.get(big.id)?.state,
      volume,
    };
  });
}
async function finish(error?: unknown): Promise<void> {
  if (error) process.stderr.write(`${String(error instanceof Error ? error.stack : error)}\n`);
  try {
    await downloads.close();
    await browser?.close();
    await agentLedger?.close();
    appWindow?.destroy();
    for (const timer of timers) clearInterval(timer);
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    writeFileSync(
      path.join(artifactDirectory, "electron.json"),
      JSON.stringify(
        {
          cases,
          states: [...observed.values()],
          finalSnapshot: downloads.snapshot(),
          error: error instanceof Error ? error.stack : error ? String(error) : null,
        },
        null,
        2,
      ),
    );
    if (otherVolumeAttached)
      execFileSync("/usr/bin/hdiutil", ["detach", "-quiet", "-force", otherVolume]);
    rmSync(userData, { recursive: true, force: true });
  } catch (cleanupError) {
    error ??= cleanupError;
  }
  clearInterval(liveness);
  if (error) process.stderr.write(`${String(error instanceof Error ? error.stack : error)}\n`);
  app.exit(error ? 1 : 0);
}
