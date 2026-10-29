import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { expect } from "vitest";

import {
  defaultBrowserViewport,
  SessionCdpRouter,
  type CdpParameters,
} from "@opensteer/browser-core";

import { type BrowserServerMessage, type BrowserSurfaceId } from "@opensteer/protocol";
import {
  BrowserController,
  HostSignIns,
  rasterShowsSize,
  SessionFiles,
  SurfaceLedger,
  type BrowserContext,
  type BrowserFrame,
  type BrowserPage,
  type CdpSession,
} from "@opensteer/browser-runtime-core";
import { FakeSink, validProfileClaims } from "@opensteer/browser-runtime-core/test-support";

import {
  TestChromiumLauncher as PlaywrightChromiumLauncher,
  findChromium,
  cleanup,
  waitForBrowserState,
} from "./browser-test-lifecycle.js";
import { runHarness, sendAsAgent, startHarnessBridge } from "./browser-harness.test-support.js";

const executablePath = findChromium();

interface PageSizeRequest {
  readonly height: number;
  readonly width: number;
}

interface PageState {
  readonly clientWidth: number;
  readonly dpr: number;
  readonly height: number;
  readonly screenHeight: number;
  readonly screenWidth: number;
  readonly width: number;
}

interface PointerEntry {
  readonly buttons: number;
  readonly height: number;
  readonly target: string;
  readonly type: string;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

interface CdpLogEntry {
  readonly at: number;
  readonly method: string;
  readonly parameters: Record<string, unknown> | undefined;
  readonly targetId: string;
}

interface TimedFrame extends BrowserFrame {
  readonly at: number;
}

/** A screencast frame that reached a page's channel, and what became of it. */
interface FrameTraceEntry {
  readonly at: number;
  /** Kept from the page's listeners; the fixture acknowledged it to Chromium itself. */
  readonly withheld: boolean;
  readonly parameters: Record<string, unknown>;
  /** Chromium sent it, or the fixture handed over again a frame Chromium sent earlier. */
  readonly source: "chromium" | "fixture";
}

/** Decides, for one page, which of Chromium's frames its listeners see and when. */
interface FrameGate {
  /** Whether Chromium's next frame is kept from the page's listeners. */
  withhold(): boolean;
  /** A command just went out on the page's channel; `reply` settles with Chromium's answer. */
  sent(method: string, reply: Promise<unknown>): void;
}

/**
 * Every screencast frame of one page passes here before the page's listeners,
 * so a test can record them all and, through a gate, hold Chromium's frames
 * back and hand the listeners a genuine frame at a moment of its choosing.
 */
class FrameTap {
  gate: FrameGate | null = null;
  readonly listeners = new Set<(parameters: unknown) => void>();
  readonly trace: FrameTraceEntry[] = [];
  #session: CdpSession | null = null;

  attach(session: CdpSession): void {
    if (this.#session) return;
    this.#session = session;
    session.on("Page.screencastFrame", (parameters) => {
      const frame = asRecord(parameters);
      const withheld = this.gate?.withhold() ?? false;
      this.trace.push({ at: performance.now(), parameters: frame, source: "chromium", withheld });
      if (!withheld) {
        this.#deliver(frame);
        return;
      }
      void session
        .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
        .catch(() => undefined);
    });
  }

  deliver(parameters: Record<string, unknown>): void {
    this.trace.push({ at: performance.now(), parameters, source: "fixture", withheld: false });
    this.#deliver(parameters);
  }

  #deliver(parameters: Record<string, unknown>): void {
    for (const listener of this.listeners) listener(parameters);
  }
}

/**
 * One Browser Session wired as the Browser Runtime wires it, on a fixture
 * site. The ledger's page channels are observed, so each test can count the
 * size writes and casts a step caused, and see every frame each page sent.
 */
async function startFollowSession(options: { readonly path?: string } = {}) {
  const site = await serveFollowFixture();
  cleanup.push(() => site.close());
  const claims = validProfileClaims();
  const browser = await new PlaywrightChromiumLauncher({
    chromiumSandbox: false,
    executablePath,
    headless: true,
  }).launch({
    initialViewport: { devicePixelRatio: 1, ...defaultBrowserViewport },
    partitionKey: `profile:${claims.identity.profileId}`,
    sessionId: claims.sessionId,
    snapshot: { cookies: [], origins: [] },
  });
  cleanup.push(() => browser.close());
  const cdpLog: CdpLogEntry[] = [];
  const frameTaps = new Map<string, FrameTap>();
  const context = observeContext(browser.context, cdpLog, frameTaps);
  const root = context.pages()[0];
  if (!root) throw new Error("Missing root page");
  const rootTargetId = await root.targetId();
  const files = new SessionFiles(join(tmpdir(), `opensteer-follow-files-${randomUUID()}`));
  const cdpRouter = new SessionCdpRouter(
    browser.cdp,
    undefined,
    browser.clipboard?.machineClipboardShared !== false,
  );
  cleanup.push(() => cdpRouter.close());
  const ledger = new SurfaceLedger(context, {
    claimTarget: (targetId) => cdpRouter.claimTarget(claims.sessionId, targetId),
    rootPages: [root],
  });
  cdpRouter.registerSession(
    claims.sessionId,
    rootTargetId,
    (targetId) => ledger.resolveTarget(targetId),
    files.root,
  );
  await ledger.start();
  cleanup.push(() => ledger.close());
  const sink = new FakeSink();
  const frames: TimedFrame[] = [];
  sink.sendFrameImplementation = async (frame) => {
    frames.push({ ...frame, at: performance.now() });
  };
  const controller = new BrowserController({
    cdpRouter,
    claims,
    exportSnapshot: () => browser.exportSnapshot(),
    files,
    ledger,
    replaceSiteCookies: (target, cookies, deadline) =>
      browser.replaceSiteCookies(target, cookies, deadline),
    signIns: testSignIns(),
    sink,
  });
  await controller.start();
  cleanup.push(() => controller.close());
  const rootSurfaceId = ledger.surfaceIdForTarget(rootTargetId);
  if (!rootSurfaceId) throw new Error("Missing root surface");
  const targetOf = (surfaceId: BrowserSurfaceId) => {
    const binding = ledger.binding(surfaceId);
    if (!binding) throw new Error(`Surface ${surfaceId} is gone.`);
    return binding.targetId;
  };
  const sent = (surfaceId: BrowserSurfaceId, method: string) => {
    const targetId = targetOf(surfaceId);
    return cdpLog
      .filter((entry) => entry.targetId === targetId && entry.method === method)
      .map((entry) => entry.parameters ?? {});
  };
  const frameTap = (surfaceId: BrowserSurfaceId) => {
    const tap = frameTaps.get(targetOf(surfaceId));
    if (!tap) throw new Error(`Surface ${surfaceId} has no observed channel.`);
    return tap;
  };
  const read = async (surfaceId: BrowserSurfaceId, expression: string): Promise<unknown> => {
    const binding = ledger.binding(surfaceId);
    if (!binding) throw new Error(`Surface ${surfaceId} is gone.`);
    // The platform's own channel: reading a page is not an agent command.
    const result = await binding.cdp.send<{
      exceptionDetails?: unknown;
      result?: { value?: unknown };
    }>("Runtime.evaluate", {
      awaitPromise: true,
      expression,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(`Page evaluation failed: ${expression}`);
    return result.result?.value;
  };
  const origin = site.origin;
  const session = {
    agent: (method: string, parameters?: CdpParameters, sessionId?: string) =>
      sendAsAgent(
        (message) => controller.handle(message),
        sink.messages,
        method,
        parameters,
        sessionId,
      ),
    claims,
    /** Every command the platform sent the page, in order. */
    commands: (surfaceId: BrowserSurfaceId) => {
      const targetId = targetOf(surfaceId);
      return cdpLog.filter((entry) => entry.targetId === targetId);
    },
    controller,
    /** Hands the page's listeners a frame Chromium sent earlier, as if it arrived now. */
    deliverFrame: (surfaceId: BrowserSurfaceId, parameters: Record<string, unknown>) =>
      frameTap(surfaceId).deliver(parameters),
    errors: () => sink.messages.filter((message) => message.type === "browser.error"),
    fit: (surfaceId: BrowserSurfaceId, size: PageSizeRequest) =>
      controller.handle({ ...size, surfaceId, type: "viewport.set" }),
    follow: (surfaceId: BrowserSurfaceId, size: PageSizeRequest) =>
      controller.handle({ ...size, surfaceId, type: "viewport.follow" }),
    /** Every screencast frame that reached the page's channel. */
    frameTrace: (surfaceId: BrowserSurfaceId) => frameTap(surfaceId).trace,
    frames,
    gateFrames: (surfaceId: BrowserSurfaceId, gate: FrameGate) => {
      frameTap(surfaceId).gate = gate;
    },
    /** The first frame of a page at `size` delivered at or after `since`. */
    frameAt: async (
      surfaceId: BrowserSurfaceId,
      size: PageSizeRequest,
      since = Number.NEGATIVE_INFINITY,
    ): Promise<TimedFrame> => {
      const matches = (frame: TimedFrame) =>
        frame.at >= since &&
        frame.header.surfaceId === surfaceId &&
        frame.header.viewportWidth === size.width &&
        frame.header.viewportHeight === size.height;
      await waitFor(() => frames.some(matches));
      return frames.find(matches)!;
    },
    ledger,
    loaded: (surfaceId: BrowserSurfaceId) =>
      waitForAsync(async () => {
        const state = asRecord(
          await read(surfaceId, "({ ready: document.readyState, href: location.href })").catch(
            () => ({}),
          ),
        );
        return state.ready === "complete" && String(state.href).startsWith(origin);
      }),
    metricsWrites: (surfaceId: BrowserSurfaceId) =>
      sent(surfaceId, "Emulation.setDeviceMetricsOverride"),
    /** Opens a popup from the agent's page and answers its surface once registered. */
    openPopup: async (agentSessionId: string): Promise<BrowserSurfaceId> => {
      const before = new Set(ledger.snapshot().map((surface) => surface.id));
      await sendAsAgent(
        (message) => controller.handle(message),
        sink.messages,
        "Runtime.evaluate",
        {
          expression: `window.open(${JSON.stringify(`${origin}/plain?popup`)}, "_blank") !== null`,
        },
        agentSessionId,
      );
      let popup: BrowserSurfaceId | undefined;
      await waitFor(() => {
        popup = ledger
          .snapshot()
          .find((surface) => surface.openerId != null && !before.has(surface.id))?.id;
        return popup !== undefined;
      });
      await waitForAsync(async () => {
        const state = asRecord(
          await read(popup!, "({ ready: document.readyState })").catch(() => ({})),
        );
        return state.ready === "complete";
      });
      return popup!;
    },
    origin,
    pageState: async (surfaceId: BrowserSurfaceId) =>
      (await read(
        surfaceId,
        "({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, screenWidth: screen.width, screenHeight: screen.height, clientWidth: document.documentElement.clientWidth })",
      )) as PageState,
    read,
    rootSurfaceId,
    rootTargetId,
    screencastStarts: (surfaceId: BrowserSurfaceId) => sent(surfaceId, "Page.startScreencast"),
    sink,
  };
  if (options.path) {
    await rootCdpNavigate(ledger, rootSurfaceId, `${origin}${options.path}`);
    await session.loaded(rootSurfaceId);
  }
  return session;
}

/**
 * An agent opens a tab and closes it while the root, which follows the
 * person's panel, stays in view; headless Chrome then shows the root at its
 * window's size again. The page draws nothing between the close and the
 * person's click on a landmark only a picture at the followed size shows, so
 * a picture of it in between comes from the stream repairing the view.
 *
 * With `stalePictures`, Chromium's pictures of the root are held from the
 * close on, and the stream sees genuine pictures Chromium made earlier at the
 * window's size instead: three while the first repair waits for its start to
 * be answered, then one labelled with the followed size just after the second
 * repair's start was, then that one again before the third's start is
 * answered. Chromium's own pictures return with the fourth repair, so the
 * root is shown again only if every mismatch can ask for a repair.
 */
async function closeBackgroundTab(name: string, options: { readonly stalePictures: boolean }) {
  const directory = join(
    process.env.OPENSTEER_BROWSER_FOLLOW_E2E_ARTIFACT_DIR ??
      join(tmpdir(), "opensteer-browser-follow-e2e"),
    name,
  );
  await mkdir(directory, { recursive: true });
  const session = await startFollowSession({ path: "/press" });
  const root = session.rootSurfaceId;
  const binding = session.ledger.binding(root)!;
  // Chrome shows the tab that remains at its window's content size when
  // another closes. Read that size as the root lays out without emulation,
  // before any picture is cast; the ledger's next write sizes it again.
  await binding.cdp.send("Emulation.clearDeviceMetricsOverride");
  const windowContent = (await session.read(
    root,
    "({ width: innerWidth, height: innerHeight })",
  )) as PageSizeRequest;
  const size = { width: 1_000, height: 700 };
  // Outside the window's content, so only a picture at the followed size shows it.
  const landmark = { height: 80, left: 820, top: 560, width: 120 };
  await session.read(
    root,
    `(() => {
      document.getElementById("pad").style.cssText = "position:fixed;inset:0;background:repeating-linear-gradient(45deg,#e8f2ff,#e8f2ff 40px,#cfe2fa 40px,#cfe2fa 80px)";
      const landmark = document.createElement("button");
      landmark.id = "landmark";
      landmark.textContent = "Landmark";
      landmark.style.cssText = "position:fixed;left:${landmark.left}px;top:${landmark.top}px;width:${landmark.width}px;height:${landmark.height}px;margin:0;border:0;background:#c00;color:#fff";
      document.body.append(landmark);
    })()`,
  );
  await session.controller.handle({ type: "stream.subscribe" });

  // The root follows the window's size first, then the person's panel.
  await session.follow(root, windowContent);
  await session.frameAt(root, windowContent);
  const windowPicture = session.frameTrace(root).findLast((entry) => {
    const metadata = asRecord(entry.parameters.metadata);
    return (
      metadata.deviceWidth === windowContent.width && metadata.deviceHeight === windowContent.height
    );
  });
  if (!windowPicture) throw new Error("Chromium sent no picture at the window's size.");
  const followedAt = performance.now();
  await session.follow(root, size);
  const before = await session.frameAt(root, size, followedAt);
  await writeFile(join(directory, "chromium-before-close.jpeg"), before.data);

  // An agent opens a tab and closes it; the root stays in view throughout.
  const created = asRecord(
    await session.agent("Target.createTarget", {
      url: `${session.origin}/plain`,
    }),
  );
  const tab = session.ledger.surfaceIdForTarget(String(created.targetId));
  if (!tab) throw new Error("Missing the agent's tab");
  await session.loaded(tab);
  const rootInView = session.ledger.active()?.surface.id === root;
  const rootWrites = session.metricsWrites(root).length;
  if (options.stalePictures) {
    const stale = windowPicture.parameters;
    await writeFile(
      join(directory, "chromium-stale-picture.jpeg"),
      Buffer.from(String(stale.data), "base64"),
    );
    // Chromium can label a picture it made before a resize with the new size.
    const relabelled = {
      ...stale,
      metadata: { ...asRecord(stale.metadata), deviceHeight: size.height, deviceWidth: size.width },
    };
    let starts = 0;
    let holding = true;
    session.gateFrames(root, {
      withhold: () => holding,
      sent: (method, reply) => {
        if (method !== "Page.startScreencast") return;
        starts += 1;
        if (starts === 1) {
          queueMicrotask(() => {
            for (let copy = 0; copy < 3; copy += 1) session.deliverFrame(root, stale);
          });
        } else if (starts === 2) {
          void reply.then(
            () => setImmediate(() => session.deliverFrame(root, relabelled)),
            () => undefined,
          );
        } else if (starts === 3) {
          queueMicrotask(() => session.deliverFrame(root, relabelled));
        } else {
          holding = false;
        }
      },
    });
  }
  const closingAt = performance.now();
  await session.agent("Target.closeTarget", { targetId: created.targetId });
  const atSize = (since: number) => (frame: TimedFrame) =>
    frame.at >= since &&
    frame.header.surfaceId === root &&
    frame.header.viewportWidth === size.width &&
    frame.header.viewportHeight === size.height &&
    sameShape(frame.header);
  // The page draws nothing until the click below, so a picture now can only
  // come from a repair the close or a mismatching picture asked for; a time
  // limit would measure the machine's load instead.
  await waitFor(() => session.frames.some(atSize(closingAt))).catch(() => undefined);
  const resumed = session.frames.find(atSize(closingAt)) ?? null;
  if (resumed) await writeFile(join(directory, "chromium-after-close.jpeg"), resumed.data);

  // The person clicks the landmark in that picture, and the page repaints.
  const pointersBefore = (await session.read(root, "window.pointerLog.length")) as number;
  for (const action of ["down", "up"] as const) {
    await session.controller.handle({
      action,
      button: "left",
      clickCount: 1,
      surfaceId: root,
      type: "input.pointer",
      viewportHeight: size.height,
      viewportWidth: size.width,
      x: (landmark.left + landmark.width / 2) / size.width,
      y: (landmark.top + landmark.height / 2) / size.height,
    });
  }
  const presses = (await session.read(
    root,
    `window.pointerLog.slice(${pointersBefore}).filter((entry) => entry.type === "mousedown")`,
  )) as PointerEntry[];
  const repaintAt = performance.now();
  await session.read(root, `document.getElementById("landmark").textContent = "Clicked"`);
  await waitFor(() => session.frames.some(atSize(repaintAt))).catch(() => undefined);
  const repainted = session.frames.find(atSize(repaintAt)) ?? null;
  if (repainted) {
    await writeFile(join(directory, "chromium-repainted-after-close.jpeg"), repainted.data);
  }

  const since = (at: number) => Math.round(at - closingAt);
  const frames = session
    .frameTrace(root)
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.at >= closingAt)
    .map(({ entry, index }) => {
      const metadata = asRecord(entry.parameters.metadata);
      const device = { width: Number(metadata.deviceWidth), height: Number(metadata.deviceHeight) };
      const raster = jpegSize(Buffer.from(String(entry.parameters.data), "base64"));
      return {
        index,
        at: entry.at,
        afterMs: since(entry.at),
        source: entry.source,
        acknowledgedBy: entry.withheld ? "fixture" : "stream",
        sessionId: entry.parameters.sessionId,
        device,
        pageScale: metadata.pageScaleFactor,
        raster,
        // As the stream judges a picture: its labelled size, then its shape.
        fitsPage:
          Math.abs(device.width - size.width) <= 1 &&
          Math.abs(device.height - size.height) <= 1 &&
          rasterShowsSize(raster, size),
      };
    });
  const commands = session.commands(root).filter((entry) => entry.at >= closingAt);
  const stops = commands.filter((entry) => entry.method === "Page.stopScreencast");
  const mismatches = frames.filter((frame) => frame.acknowledgedBy === "stream" && !frame.fitsPage);
  // A repair consumes its request before it stops the cast, so a mismatch
  // the stream saw after one stop asks for the next.
  const restarts = stops.map((stop, index) => {
    const after = index === 0 ? closingAt : stops[index - 1]!.at;
    return {
      afterMs: since(stop.at),
      causes:
        index === 0
          ? ["tab closed"]
          : mismatches
              .filter((frame) => frame.at > after && frame.at < stop.at)
              .map((frame) => frame.index),
    };
  });
  const acknowledgements = commands
    .filter((entry) => entry.method === "Page.screencastFrameAck")
    .map((entry) => ({ at: entry.at, sessionId: entry.parameters?.sessionId, matched: false }));
  const unacknowledged = frames.filter((frame) => {
    if (frame.acknowledgedBy !== "stream") return false;
    const ack = acknowledgements.find(
      (candidate) =>
        !candidate.matched && candidate.sessionId === frame.sessionId && candidate.at >= frame.at,
    );
    if (ack) ack.matched = true;
    return !ack;
  });
  const outcome = {
    variant: options.stalePictures ? "stale pictures held and handed over" : "as Chromium sends",
    windowContent,
    followed: size,
    rootInView,
    stillFollowed: session.ledger.active()?.surface.id === root,
    resumed: resumed?.header ?? null,
    resumeMs: resumed ? since(resumed.at) : null,
    frames,
    commands: commands
      .filter((entry) =>
        [
          "Emulation.setDeviceMetricsOverride",
          "Emulation.setVisibleSize",
          "Page.screencastFrameAck",
          "Page.startScreencast",
          "Page.stopScreencast",
        ].includes(entry.method),
      )
      .map((entry) => ({
        afterMs: since(entry.at),
        method: entry.method,
        parameters: entry.parameters ?? {},
      })),
    restarts,
    starts: commands.filter((entry) => entry.method === "Page.startScreencast").length,
    visibleSizes: commands
      .filter((entry) => entry.method === "Emulation.setVisibleSize")
      .map((entry) => entry.parameters ?? {}),
    unacknowledged,
    accepted: session.frames
      .filter((frame) => frame.at >= closingAt && frame.header.surfaceId === root)
      .map((frame) => ({ afterMs: since(frame.at), header: frame.header })),
    streamedOtherSizes: session.frames
      .filter(
        (frame) =>
          frame.at >= closingAt && frame.header.surfaceId === root && !atSize(closingAt)(frame),
      )
      .map((frame) => frame.header),
    presses,
    repainted: repainted?.header ?? null,
    repaintMs: repainted ? Math.round(repainted.at - repaintAt) : null,
    layout: await session.pageState(root),
    layoutWritesAfterClose: session.metricsWrites(root).length - rootWrites,
    errors: session.errors(),
  };
  await writeFile(
    join(directory, "chromium-background-close.json"),
    `${JSON.stringify({ executablePath, ...outcome }, null, 2)}\n`,
  );
  return outcome;
}

/**
 * The root's picture came back at its followed size, and only through
 * repairs the close or a mismatching picture asked for: never a picture of
 * another size, a size write, another tab, or an unacknowledged frame.
 */
function expectPictureRepaired(outcome: Awaited<ReturnType<typeof closeBackgroundTab>>): void {
  expect(outcome.windowContent).not.toEqual(outcome.followed);
  expect(outcome.rootInView).toBe(true);
  expect(outcome.stillFollowed).toBe(true);
  expect(outcome.resumed).toMatchObject({
    rasterHeight: 700,
    rasterWidth: 1_000,
    viewportHeight: 700,
    viewportWidth: 1_000,
  });
  expect(outcome.restarts.length).toBeGreaterThanOrEqual(1);
  expect(outcome.restarts.filter((restart) => restart.causes.length === 0)).toEqual([]);
  expect(outcome.starts).toBe(outcome.restarts.length);
  expect(outcome.visibleSizes).toEqual(
    Array.from({ length: outcome.starts }, () => outcome.followed),
  );
  expect(outcome.unacknowledged).toEqual([]);
  expect(outcome.streamedOtherSizes).toEqual([]);
  expect(outcome.presses).toMatchObject([{ target: "landmark" }]);
  expect(outcome.repainted).not.toBeNull();
  expect(outcome.layout).toMatchObject(outcome.followed);
  expect(outcome.layoutWritesAfterClose).toBe(0);
  expect(outcome.errors).toEqual([]);
}

async function rootCdpNavigate(
  ledger: SurfaceLedger,
  surfaceId: BrowserSurfaceId,
  url: string,
): Promise<void> {
  const binding = ledger.binding(surfaceId);
  if (!binding) throw new Error("Missing the page to navigate");
  await binding.cdp.send("Page.navigate", { url });
}

/** The fixture pages: each records its size at first layout and every trusted pointer event. */
async function serveFollowFixture(): Promise<{
  readonly origin: string;
  close(): Promise<void>;
}> {
  const page = (title: string, head: string, body: string) =>
    `<!doctype html><meta charset="utf-8"><title>${title}</title>${head}<style>html,body{margin:0}</style>
<script>
window.loadSize = { width: innerWidth, height: innerHeight };
window.resizes = [];
addEventListener("resize", () => resizes.push({ width: innerWidth, height: innerHeight }));
window.pointerLog = [];
for (const type of ["mousedown", "mouseup", "mousemove"]) {
  addEventListener(type, (event) => {
    if (event.isTrusted) pointerLog.push({ type, buttons: event.buttons, x: event.clientX, y: event.clientY, width: innerWidth, height: innerHeight, target: event.target.id || event.target.tagName });
  }, true);
}
</script>${body}`;
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture").pathname;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (path === "/press") {
      response.end(page("Press", "", '<div id="pad" style="position:fixed;inset:0"></div>'));
      return;
    }
    if (path === "/mobile") {
      response.end(
        page(
          "Phone layout",
          '<meta name="viewport" content="width=device-width,initial-scale=1">',
          "<p>Phone layout</p>",
        ),
      );
      return;
    }
    if (path === "/scrollbar") {
      response.end(
        page(
          "Styled scrollbar",
          "<style>::-webkit-scrollbar{width:17px;height:17px;background:#ccc}::-webkit-scrollbar-thumb{background:#888}#tall{height:5000px}#edge{position:fixed;top:40px;right:0;width:12px;height:40px;padding:0;border:0;background:#c00}</style>",
          '<div id="tall"><p id="state">styled scrollbar</p></div><button id="edge" aria-label="Edge"></button>',
        ),
      );
      return;
    }
    response.end(page("Plain", "", '<p id="state">static</p>'));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  return {
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
    origin: `http://127.0.0.1:${address.port}`,
  };
}

/**
 * The engine's context as the ledger sees it, with every command the ledger's
 * page channels send recorded against the page's target, and every
 * screencast frame passing through that page's tap.
 */
function observeContext(
  context: BrowserContext,
  log: CdpLogEntry[],
  taps: Map<string, FrameTap>,
): BrowserContext {
  const wrapped = new WeakMap<BrowserPage, BrowserPage>();
  const listeners = new Map<(page: BrowserPage) => void, (page: BrowserPage) => void>();
  const wrap = (page: BrowserPage): BrowserPage => {
    const existing = wrapped.get(page);
    if (existing) return existing;
    const observed: BrowserPage = {
      agentCdp: () => page.agentCdp(),
      cdp: async () => {
        const targetId = await page.targetId();
        let tap = taps.get(targetId);
        if (!tap) {
          tap = new FrameTap();
          taps.set(targetId, tap);
        }
        return observeCdp(await page.cdp(), targetId, log, tap);
      },
      close: () => page.close(),
      isClosed: () => page.isClosed(),
      offClose: (listener) => page.offClose(listener),
      offMetadataChanged: (listener) => page.offMetadataChanged(listener),
      onClose: (listener) => page.onClose(listener),
      onMetadataChanged: (listener) => page.onMetadataChanged(listener),
      opener: async () => {
        const opener = await page.opener();
        return opener ? wrap(opener) : null;
      },
      targetId: () => page.targetId(),
      title: () => page.title(),
      url: () => page.url(),
    };
    wrapped.set(page, observed);
    return observed;
  };
  return {
    createPage: async () => wrap(await context.createPage()),
    offPage: (listener) => {
      const observed = listeners.get(listener);
      if (!observed) return;
      listeners.delete(listener);
      context.offPage(observed);
    },
    onPage: (listener) => {
      const observed = (page: BrowserPage) => listener(wrap(page));
      listeners.set(listener, observed);
      context.onPage(observed);
    },
    pages: () => context.pages().map(wrap),
  };
}

function observeCdp(
  session: CdpSession,
  targetId: string,
  log: CdpLogEntry[],
  tap: FrameTap,
): CdpSession {
  tap.attach(session);
  return {
    close: () => session.close(),
    detach: () => session.detach(),
    off: (event, listener) => {
      if (event === "Page.screencastFrame") tap.listeners.delete(listener);
      else session.off(event, listener);
    },
    on: (event, listener) => {
      if (event === "Page.screencastFrame") tap.listeners.add(listener);
      else session.on(event, listener);
    },
    onEvent: (listener) => session.onEvent(listener),
    send: <Result = unknown>(method: string, parameters?: Record<string, unknown>) => {
      log.push({ at: performance.now(), method, parameters, targetId });
      const reply = session.send<Result>(method, parameters);
      tap.gate?.sent(method, reply);
      return reply;
    },
  };
}

/**
 * The picture has its page's shape. Scaling rounds each side by under a
 * pixel, which moves the cross product by at most the sum of the page's sides.
 */
function sameShape(header: BrowserFrame["header"]): boolean {
  const error = Math.abs(
    header.rasterWidth * header.viewportHeight - header.rasterHeight * header.viewportWidth,
  );
  return error <= header.viewportWidth + header.viewportHeight;
}

/** A JPEG's pixel size, read from its start-of-frame marker. */
function jpegSize(data: Buffer): {
  readonly height: number;
  readonly width: number;
} {
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = data[offset + 1]!;
    const length = data.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return {
        height: data.readUInt16BE(offset + 5),
        width: data.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  throw new Error("The frame is not a JPEG with a frame header.");
}

/** A box of a frame's pixels, and the frame's own pixel size. */
interface PictureBox {
  readonly bottom: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly width: number;
}

/**
 * Where a frame pictures pure red, in its pixels, or null if nowhere. A page
 * decodes the JPEG, as a viewer's image element does; JPEG and colour
 * conversion move the exact value, never the hue.
 */
async function redBoxInFrame(
  read: (expression: string) => Promise<unknown>,
  frame: BrowserFrame,
): Promise<PictureBox | null> {
  const box = await read(`(async () => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(frame.data.toString("base64"))}), (character) => character.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
    const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d");
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let left = bitmap.width, top = bitmap.height, right = 0, bottom = 0;
    for (let y = 0; y < bitmap.height; y += 1) {
      for (let x = 0; x < bitmap.width; x += 1) {
        const offset = (y * bitmap.width + x) * 4;
        const red = pixels[offset], green = pixels[offset + 1], blue = pixels[offset + 2];
        if (red > 150 && red - green > 100 && red - blue > 100) {
          left = Math.min(left, x);
          top = Math.min(top, y);
          right = Math.max(right, x + 1);
          bottom = Math.max(bottom, y + 1);
        }
      }
    }
    return right === 0 ? null : { bottom, height: bitmap.height, left, right, top, width: bitmap.width };
  })()`);
  return box ? (box as PictureBox) : null;
}

function testSignIns(): HostSignIns {
  return new HostSignIns({ authority: undefined, runtimeId: "test" });
}

function boundarySecrets() {
  return {
    corsHeader: `fake-acao-${randomBytes(16).toString("hex")}`,
    privateWorld: `fake-private-world-${randomBytes(16).toString("hex")}`,
    rotatedSessionA: `fake-rotated-a-${randomBytes(16).toString("hex")}`,
    sessionA: `fake-session-a-${randomBytes(16).toString("hex")}`,
    sessionB: `fake-session-b-${randomBytes(16).toString("hex")}`,
    storageB: `fake-storage-b-${randomBytes(16).toString("hex")}`,
  };
}

/**
 * Two sites the person is signed in to. Site A's page says whether its
 * session cookie arrived, never what it was, and rotates it on every load.
 */
function serveBoundaryFixture(
  secrets: ReturnType<typeof boundarySecrets>,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const host = request.headers.host?.split(":", 1)[0];
  const sessionCookie = (name: string, value: string) =>
    `${name}=${value}; HttpOnly; Path=/; SameSite=Lax`;
  const html = (title: string, body = "") =>
    `<!doctype html><meta charset="utf-8"><title>${title}</title>${body}`;
  if (host === "site-b.test" && request.url === "/login") {
    response
      .writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": sessionCookie("session_b", secrets.sessionB),
      })
      .end(
        html(
          "Site B login",
          `<script>localStorage.setItem("token_b", ${JSON.stringify(secrets.storageB)})</script>`,
        ),
      );
    return;
  }
  if (host === "site-a.test" && request.url === "/login") {
    response
      .writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": [
          sessionCookie("session_a", secrets.sessionA),
          "visible_a=page-visible; Path=/; SameSite=Lax",
        ],
      })
      .end(html("Site A login"));
    return;
  }
  if (host === "site-b.test" && request.url === "/cors") {
    // Not the requesting origin: the page's fetch fails without seeing it.
    response
      .writeHead(200, {
        "access-control-allow-origin": secrets.corsHeader,
        "content-type": "text/plain; charset=utf-8",
      })
      .end("cross-origin body");
    return;
  }
  if (host === "site-a.test" && request.url === "/app") {
    const cookie = request.headers.cookie ?? "";
    const signedIn =
      cookie.includes(`session_a=${secrets.sessionA}`) ||
      cookie.includes(`session_a=${secrets.rotatedSessionA}`);
    response
      .writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": sessionCookie("session_a", secrets.rotatedSessionA),
      })
      .end(
        html(
          "Site A app",
          `<body data-signed-in="${signedIn ? "yes" : "no"}">
<button id="count" style="position:fixed;left:20px;top:20px;width:160px;height:40px">Count</button>
<input id="name" style="position:fixed;left:20px;top:80px;width:200px;height:30px">
<input id="file" type="file" style="position:fixed;left:20px;top:130px">
<input id="hidden" type="file" style="display:none">
<button id="choose" style="position:fixed;left:20px;top:180px;width:160px;height:40px">Add file</button>
<script>
window.clicks = 0;
window.keys = [];
document.getElementById("name").addEventListener("keydown", (event) => { if (event.isTrusted) window.keys.push(event.key); });
document.getElementById("count").addEventListener("click", () => { window.clicks += 1; });
document.getElementById("choose").addEventListener("click", () => document.getElementById("hidden").click());
console.log("site-a page ready");
</script>`,
        ),
      );
    return;
  }
  response.writeHead(404, { "content-type": "text/plain" }).end("not found");
}

function foundSecrets(secrets: Record<string, string>, value: unknown): string[] {
  const serialized = JSON.stringify(value);
  return Object.entries(secrets)
    .filter(([, secret]) => serialized.includes(secret))
    .map(([label]) => label)
    .sort();
}

function evaluationValue(value: unknown): unknown {
  return asRecord(asRecord(value).result).value;
}

/** The dialog the person sees now, as the latest `browser.dialog.changed` named it. */
function shownDialog(messages: readonly BrowserServerMessage[]) {
  const latest = messages.findLast((message) => message.type === "browser.dialog.changed");
  if (latest?.type !== "browser.dialog.changed" || !latest.dialog) {
    throw new Error("No browser dialog is shown.");
  }
  return latest.dialog;
}

function asJsonRecord(line: string): Record<string, unknown> {
  return asRecord(JSON.parse(line));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const waitForAsync = waitForBrowserState;
const waitFor = waitForBrowserState;

export {
  executablePath,
  type PageSizeRequest,
  type PageState,
  type PointerEntry,
  type TimedFrame,
  startFollowSession,
  closeBackgroundTab,
  expectPictureRepaired,
  rootCdpNavigate,
  serveFollowFixture,
  sameShape,
  jpegSize,
  type PictureBox,
  redBoxInFrame,
  startHarnessBridge,
  runHarness,
  testSignIns,
  boundarySecrets,
  serveBoundaryFixture,
  sendAsAgent,
  foundSecrets,
  evaluationValue,
  shownDialog,
  asJsonRecord,
  asRecord,
  waitForAsync,
  waitFor,
};
