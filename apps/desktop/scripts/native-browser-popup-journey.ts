import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import {
  BrowserVideoClickResultSchema,
  BrowserPopupClientMessageSchema,
  BrowserPopupServerMessageSchema,
  BrowserVideoStateSchema,
} from "@opensteer/protocol";
import { session, app } from "electron";
import { chromium, type Page } from "playwright-core";
import type { NativeBrowserE2EKit } from "./electron-native-browser-kit.js";
import type { OpensteerInputOwner } from "../src/browser/electron-browser-presentation.js";

/** Real Personal Host and real web picker, in a separate viewer browser process. */
export async function browserPopupJourney(kit: NativeBrowserE2EKit): Promise<void> {
  assert.equal(
    process.versions["opensteer"],
    "1",
    "Popup journey requires private owner contract version 1",
  );
  const executable = process.env.OPENSTEER_POPUP_VIEWER_EXECUTABLE ?? chromium.executablePath();
  await access(executable).catch(() => {
    throw new Error(
      "Popup journey needs the pinned Playwright Chromium viewer installed in the VM.",
    );
  });
  const context = kit.context;
  const events: string[] = [];
  const record = (index: number, event: string) => {
    if (events.length >= 512) return;
    events.push(`${index}:${event}`);
    kit.artifacts.event("popup.event", { index, event });
  };
  const opened = await context.api["commands.dispatch"]({
    type: "browser.tab.open",
    sessionId: context.sessionId,
    idempotencyKey: randomUUID(),
    url: `${context.origin}/popups`,
  });
  assert(opened.ok && opened.data.type === "browser.tab.open");
  const surfaceId = opened.data.tabId;
  await kit.clickApp('button[aria-label="Hide the conversation"]');
  await kit.selectNativePage(context.sessionId, surfaceId);
  const producer = [...kit.pages.values()].find((p) => p.surfaceId === surfaceId);
  assert(producer, "Popup fixture has a production runtime page");
  const native = (
    await import("../src/browser/electron-browser-launcher.js")
  ).electronPagePresentation(producer.page)!.view;
  const contents = native.webContents;
  const viewerViewport = { width: 1200, height: Math.min(700, native.getBounds().height) };
  assert("_createOpensteerInputOwner" in contents, "Private popup/input owner is missing");
  // Observe the production owner, without creating a second owner or retaining payloads.
  const patched = contents as typeof contents & {
    _createOpensteerInputOwner(): OpensteerInputOwner;
  };
  const createOwner = patched._createOpensteerInputOwner;
  const nativeStops: string[] = [];
  const port = producer.page.presentation!;
  const start = port.start.bind(port);
  const stop = port.stop.bind(port);
  port.start = async (options) => {
    record(-1, "producer.start");
    try {
      const result = await start({
        ...options,
        onStopped: (reason) => {
          record(
            -1,
            `producer.ended:${["protocol", "source-ended", "capacity"].includes(reason) ? reason : "other"}`,
          );
          options.onStopped(reason);
        },
      });
      record(-1, "producer.started");
      return result;
    } catch (error) {
      record(-1, "producer.start-failed");
      throw error;
    }
  };
  port.stop = () => {
    const stack = new Error().stack ?? "";
    record(
      -1,
      `producer.stop:${stack.includes("onFrame") ? "frame" : stack.includes(".video") ? "control" : stack.includes(".start") ? "startup" : "other"}`,
    );
    return stop();
  };
  kit.cleanup.push(() => {
    port.start = start;
    port.stop = stop;
  });
  patched._createOpensteerInputOwner = () => {
    const owner = createOwner.call(contents);
    owner.on("detach", () => record(-1, "producer.detached"));
    owner.on("video-stopped", (...args) => {
      const reasons = [
        "stopped",
        "source changed",
        "capture stopped",
        "capture geometry changed; restart video",
        "presentation cannot be certified",
        "presentation fence failed",
        "picture authority changed before publication",
        "rate budget cannot sustain video",
        "encode failed",
        "rate update failed",
        "renderer_gone",
        "presentation_not_current",
        "recovery_deadline",
        "geometry_changed",
        "start_deadline",
        "ack_deadline",
        "gpu_lost",
        "hardware_unavailable",
        "encoder_capacity",
        "encoder_unavailable",
        "encoder_failure",
        "capture_identity",
        "capture_buffer",
        "capture_geometry",
        "empty_capture",
        "capture_stopped",
      ];
      const reason = args[2];
      if (nativeStops.length < 32)
        nativeStops.push(typeof reason === "string" && reasons.includes(reason) ? reason : "other");
      record(
        -1,
        `producer.native-stop:${typeof reason === "string" && reasons.includes(reason) ? reason : "other"}`,
      );
    });
    return owner;
  };
  kit.cleanup.push(() => {
    patched._createOpensteerInputOwner = createOwner;
  });
  // Viewers and the producer otherwise contend for the VM's one paravirtual GPU,
  // stalling every viewer frame for seconds with idle CPUs.
  const server = await chromium.launchServer({
    executablePath: executable,
    headless: false,
    args: ["--disable-gpu"],
  });
  const pid = server.process().pid;
  assert(pid);
  kit.ownedPids.add(pid);
  kit.cleanup.push(async () => {
    await server.close();
    kit.ownedPids.delete(pid);
  });
  const browser = await chromium.connect(server.wsEndpoint());
  const counts: [number, number, number] = [0, 0, 0];
  const commands: Record<string, number> = {};
  const editingContexts: [number, number] = [0, 0];
  const admissions: [number, number] = [0, 0];
  const sessionMatches = [false, false];
  const guardedResults: Record<string, number> = {};
  const tapStarted: (number | null)[] = [null, null];
  const answers = new Map<string, number>();
  const tapToPopupMs: number[] = [];
  const answerToAppliedMs: number[] = [];
  try {
    // These are the journey's temporary owner cookies, held in live memory only.
    const cookies = await session
      .fromPartition(`persist:opensteer-host-${context.deploymentId}`)
      .cookies.get({ url: context.hostOrigin });
    const viewers = await Promise.all(
      [0, 1].map(async (index) => {
        const viewer = await browser.newContext({ viewport: viewerViewport });
        await viewer.addCookies(
          cookies.map((c) => ({
            name: c.name,
            value: c.value,
            url: context.hostOrigin,
            httpOnly: c.httpOnly ?? false,
            secure: c.secure ?? false,
            sameSite: c.sameSite === "strict" ? ("Strict" as const) : ("Lax" as const),
          })),
        );
        const page = await viewer.newPage();
        page.setDefaultTimeout(4000);
        await page.addInitScript(() => {
          Object.assign(window, { popupPresented: 0, popupCorner: -1, popupPresentedAt: 0 });
          document.addEventListener("browser-picture-presented", (event) => {
            const canvas = event.target;
            const pixel =
              canvas instanceof HTMLCanvasElement
                ? canvas.getContext("2d")?.getImageData(0, 0, 1, 1).data
                : undefined;
            if (pixel?.[3])
              Object.assign(window, {
                popupPresented: Number(Reflect.get(window, "popupPresented")) + 1,
                popupCorner: pixel[0],
                popupPresentedAt: performance.now(),
              });
          });
        });
        page.on("websocket", (socket) => {
          socket.on("framereceived", ({ payload }) => {
            if (typeof payload !== "string") return;
            try {
              const m: unknown = JSON.parse(payload);
              const videoState = BrowserVideoStateSchema.safeParse(m);
              if (videoState.success)
                record(index, `video:${videoState.data.state}:${videoState.data.reason ?? "none"}`);
              const popup = BrowserPopupServerMessageSchema.safeParse(m);
              if (popup.success) {
                if (popup.data.type === "browser.popup.opened" && tapStarted[index] != null) {
                  tapToPopupMs.push(performance.now() - tapStarted[index]!);
                  tapStarted[index] = null;
                }
                if (popup.data.type === "browser.popup.result") {
                  const started = answers.get(popup.data.operationId);
                  if (started !== undefined && popup.data.outcome === "applied")
                    answerToAppliedMs.push(performance.now() - started);
                  answers.delete(popup.data.operationId);
                }
              }
              if (popup.success)
                record(
                  index,
                  `${popup.data.type}${"reason" in popup.data ? ":" + popup.data.reason : ""}${"state" in popup.data ? ":" + (typeof popup.data.state === "string" ? popup.data.state : popup.data.state.kind) : ""}`,
                );
              if (m && typeof m === "object" && "type" in m && m.type === "browser.snapshot")
                sessionMatches[index] = "sessionId" in m && m.sessionId === context.sessionId;
              const guarded = BrowserVideoClickResultSchema.safeParse(m);
              if (guarded.success) {
                const key = `${guarded.data.outcome}:${guarded.data.reason ?? guarded.data.hostReason ?? "none"}`;
                guardedResults[key] = (guardedResults[key] ?? 0) + 1;
                record(index, `result:${key}`);
              }
              if (m && typeof m === "object" && "type" in m && m.type === "browser.editing")
                editingContexts[index] = (editingContexts[index] ?? 0) + 1;
              if (m && typeof m === "object" && "type" in m && m.type === "browser.video.attached")
                admissions[index] = (admissions[index] ?? 0) + 1;
              if (
                m &&
                typeof m === "object" &&
                "type" in m &&
                typeof m.type === "string" &&
                m.type.startsWith("browser.popup.")
              )
                counts[index] = (counts[index] ?? 0) + 1;
            } catch {
              /* Binary media is observed only through presentation. */
            }
          });
          socket.on("framesent", ({ payload }) => {
            if (typeof payload !== "string") return;
            try {
              const m: unknown = JSON.parse(payload);
              const popup = BrowserPopupClientMessageSchema.safeParse(m);
              if (popup.success && popup.data.type === "popup.answer")
                answers.set(popup.data.operationId, performance.now());
              if (m && typeof m === "object" && "type" in m && typeof m.type === "string")
                commands[m.type] = (commands[m.type] ?? 0) + 1;
              if (
                m &&
                typeof m === "object" &&
                "type" in m &&
                (m.type === "input.cancel" ||
                  m.type === "input.control" ||
                  m.type === "input.guarded-click")
              )
                record(
                  index,
                  `send:${m.type}${"action" in m && (m.action === "acquire" || m.action === "release") ? ":" + m.action : ""}`,
                );
              if (
                m &&
                typeof m === "object" &&
                "type" in m &&
                m.type === "input.pointer" &&
                "action" in m &&
                ["move", "down", "up", "leave"].includes(String(m.action))
              ) {
                const action = `pointer.${String(m.action)}`;
                commands[action] = (commands[action] ?? 0) + 1;
              }
            } catch {
              /* No raw data enters evidence. */
            }
          });
        });
        await page.goto(context.hostOrigin);
        const sidebar = page.getByRole("button", { name: "Open sidebar", exact: true });
        if (await sidebar.isVisible()) await sidebar.click();
        await page
          .locator('.side-tab[data-group="web"] .side-tab__main')
          .filter({ hasText: "Browser popup fixture" })
          .click();
        await page.getByRole("button", { name: "Hide the conversation", exact: true }).click();
        await page.locator('canvas[aria-label="Live browser page"]').waitFor({ state: "visible" });
        await page.waitForFunction(
          () => Number(Reflect.get(window, "popupPresented")) > 0,
          undefined,
          { timeout: 4000 },
        );
        return { viewer, page };
      }),
    );
    const a = viewers[0]!.page,
      b = viewers[1]!.page;
    await b.evaluate(
      ({ sessionId, surfaceId }) => {
        const socket = new WebSocket(
          `${location.origin.replace(/^http/, "ws")}/v1/browser-sessions/${sessionId}/connect?mode=watch`,
        );
        const owner = { control: socket, media: null as WebSocket | null, popups: 0 };
        Object.assign(window, { popupWatch: owner });
        socket.onopen = () =>
          socket.send(
            JSON.stringify({
              type: "video.subscribe",
              surfaceId,
              budget: { maxWidth: 640, maxHeight: 480, maxFps: 15, maxBitrate: 500000 },
            }),
          );
        socket.onmessage = (event) => {
          const m = JSON.parse(String(event.data));
          if (typeof m.type === "string" && m.type.startsWith("browser.popup.")) owner.popups++;
          if (m.type === "browser.video.attached") {
            const media = new WebSocket(
              `${location.origin.replace(/^http/, "ws")}/v1/browser/video`,
              [`opensteer-video.${m.mediaToken}`],
            );
            media.binaryType = "arraybuffer";
            owner.media = media;
            media.onmessage = (event) => {
              if (!(event.data instanceof ArrayBuffer)) return;
              const data = new Uint8Array(event.data);
              const length = new DataView(event.data).getUint32(0);
              const h = JSON.parse(new TextDecoder().decode(data.subarray(4, 4 + length)));
              media.send(
                JSON.stringify({ type: "video.ack", streamId: h.streamId, sequence: h.sequence }),
              );
            };
          }
        };
      },
      { sessionId: context.sessionId, surfaceId },
    );
    const read = async (expression: string) => contents.executeJavaScript(expression, false);
    const counters = async (id: string) =>
      read(`window.popupResults[${JSON.stringify(id)}]`) as Promise<{
        input: number;
        change: number;
      }>;
    const tap = async (page: Page, id: string) => {
      const point = (await read(
        `(()=>{const r=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();return{x:r.x+(["date","time","datetime-local","month","week"].includes(document.getElementById(${JSON.stringify(id)}).type)?r.width-12:r.width/2),y:r.y+r.height/2,w:innerWidth,h:innerHeight}})()`,
      )) as { x: number; y: number; w: number; h: number };
      const canvas = await page.locator('canvas[aria-label="Live browser page"]').boundingBox();
      assert(canvas);
      tapStarted[page === a ? 0 : 1] = performance.now();
      await page.mouse.click(
        canvas.x + (point.x / point.w) * canvas.width,
        canvas.y + (point.y / point.h) * canvas.height,
      );
    };
    // A tap on a picture older than a hit-test change must refuse, and a person can't tap what they
    // haven't seen. A repaint ordered after the change, seen in the viewer's own pixels, proves the
    // picture is newer than it; the trailing frames of that page activity then need to finish.
    const pictureAfter = async (page: Page, change: () => Promise<unknown>) => {
      await change();
      const red = (await read(
        `(()=>{const s=document.body.style;const light=s.backgroundColor!=="rgb(255, 255, 255)";s.backgroundColor=light?"rgb(255, 255, 255)":"rgb(200, 200, 200)";return light?255:200})()`,
      )) as number;
      await page.waitForFunction(
        (expected) => Math.abs(Number(Reflect.get(window, "popupCorner")) - expected) < 24,
        red,
        { timeout: 4000 },
      );
      await page.waitForFunction(
        () => performance.now() - Number(Reflect.get(window, "popupPresentedAt")) > 300,
        undefined,
        { timeout: 4000 },
      );
    };
    const quiet = async () => {
      assert.equal(counts[1], 0, "Other control viewer received popup content");
      assert.equal(
        await b.evaluate(() =>
          Number((window as Window & { popupWatch?: { popups: number } }).popupWatch?.popups ?? 0),
        ),
        0,
        "Watch received popup content",
      );
    };
    await a.bringToFront();
    assert(sessionMatches.every(Boolean), "Viewers must attach to the original fixture session");
    let dimensions = (await contents.executeJavaScript(
      "({width:innerWidth,height:innerHeight})",
      false,
    )) as { width: number; height: number };
    const stage = await a.locator(".browser-stage").boundingBox();
    assert(stage);
    const expected = { width: Math.round(stage.width), height: Math.round(stage.height) };
    if (dimensions.width !== expected.width || dimensions.height !== expected.height) {
      const fitted = Promise.withResolvers<void>();
      void fitted.promise.catch(() => undefined);
      const checkGeometry = () => {
        const geometry = producer.geometry()?.geometry;
        const size = geometry?.agent ?? geometry?.person;
        if (size?.width === expected.width && size.height === expected.height) fitted.resolve();
      };
      const remove = producer.onEvent(checkGeometry);
      checkGeometry();
      const timer = setTimeout(
        () => fitted.reject(new Error("Foreground viewer geometry never applied")),
        4000,
      );
      try {
        await fitted.promise;
        await a.waitForFunction(
          ({ width, height }) => {
            const canvas = document.querySelector<HTMLCanvasElement>(
              'canvas[aria-label="Live browser page"]',
            );
            return (
              canvas &&
              canvas.height > 0 &&
              Math.abs(canvas.width / canvas.height - width / height) < 0.01 &&
              canvas.getContext("2d")?.getImageData(0, 0, 1, 1).data[3]
            );
          },
          expected,
          { timeout: 4000 },
        );
      } finally {
        clearTimeout(timer);
        remove();
      }
      dimensions = (await contents.executeJavaScript(
        "({width:innerWidth,height:innerHeight})",
        false,
      )) as { width: number; height: number };
    }
    const bounds = native.getBounds();
    kit.artifacts.json("cases/popups/producer-geometry.json", {
      dimensions,
      bounds,
      viewerViewport,
    });
    assert(
      dimensions.width <= bounds.width && dimensions.height <= bounds.height,
      "Positive popup qualification requires an uncropped, unemulated producer",
    );
    const before = await kit.popupInventory();
    await tap(a, "single");
    await a.getByRole("dialog", { name: "Choose an option" }).waitFor();
    await quiet();
    const after = await kit.popupInventory();
    assert.equal(after.frontPid, before.frontPid, "Remote chooser stole foreground focus");
    assert.equal(
      after.windows.length,
      before.windows.length,
      "Remote chooser created a producer window",
    );
    assert.equal(
      after.roles.AXMenu ?? 0,
      before.roles.AXMenu ?? 0,
      "Remote chooser created a producer native menu",
    );
    kit.artifacts.json("cases/popups/inventory.json", { before, after });
    await kit.snapshot("popups", "opened");
    const afterCapture = await kit.popupInventory();
    kit.artifacts.json("cases/popups/after-capture.json", afterCapture);
    assert.equal(
      afterCapture.frontPid,
      before.frontPid,
      "Owned-window capture changed foreground focus",
    );
    await a.getByRole("listbox", { name: "Choose an option" }).selectOption({ label: "Beta" });
    await kit.until(
      async () => {
        const c = await counters("single");
        return c.input === 1 && c.change === 1;
      },
      "select commits input/change exactly once",
      3000,
    );
    // Stock focused-select keys use the same production proxy as page typing.
    for (const key of ["Space", "Enter"]) {
      await a.getByLabel("Browser keyboard input", { exact: true }).focus();
      await a.keyboard.press(key);
      await a.getByRole("dialog", { name: "Choose an option" }).waitFor();
      await a.getByRole("button", { name: "Cancel", exact: true }).click();
    }
    await tap(a, "single");
    await a.getByRole("dialog").waitFor();
    const unchanged = await counters("single");
    await read("window.mutatePopup()");
    await a.getByText("Choices changed. Choose again.", { exact: true }).waitFor();
    assert.deepEqual(await counters("single"), unchanged, "Mutation applied a draft without Done");
    await kit.snapshot("popups", "updated");
    await a.getByRole("button", { name: "Cancel", exact: true }).click();
    await tap(a, "single");
    await a.getByRole("dialog").waitFor();
    await pictureAfter(a, async () => {
      await read("window.replacePopup()");
      await a.getByRole("dialog").waitFor({ state: "hidden" });
    });
    await tap(a, "multiple");
    const multiple = a.getByRole("listbox", { name: "Choose an option" });
    await multiple.selectOption([]);
    await pictureAfter(a, async () => {
      await a.getByRole("button", { name: "Done", exact: true }).click();
      await kit.until(
        async () => {
          const c = await counters("multiple");
          return c.input === 1 && c.change === 1;
        },
        "multiple clear commits exactly once",
        3000,
      );
    });
    for (const [id, value] of [
      ["date", "2024-03-11"],
      ["time", "02:00:00.123"],
      ["datetime-local", "2024-11-03T02:30:00.125"],
      ["month", "2025-01"],
      ["week", "2021-W01"],
      ["color", "color(display-p3 0.2 0.4 0.6 / 0.5)"],
    ] as const) {
      await tap(a, id);
      await a.getByRole("dialog").waitFor();
      await a.getByLabel(/Exact/).fill(value);
      await pictureAfter(a, async () => {
        await a.getByRole("button", { name: "Done", exact: true }).click();
        await kit.until(
          async () => {
            const c = await counters(id);
            return c.change === 1;
          },
          `${id} native chooser commit`,
          3000,
        );
      });
      await quiet();
    }
    // All page keys enter through the production proxy/private edit path.
    const beforeDatalist = editingContexts[0];
    await tap(a, "datalist");
    await kit.until(
      async () => editingContexts[0] > beforeDatalist,
      "datalist field context delivered to the viewer",
      3000,
    );
    await a.keyboard.type("Al");
    await a.getByRole("option", { name: /Alpha/ }).waitFor();
    await quiet();
    await a.getByRole("option", { name: /Alpha/ }).click();
    await kit.until(
      async () => {
        const c = await counters("datalist");
        return c.change >= 1;
      },
      "datalist answer updates the original input",
      3000,
    );
    await pictureAfter(a, async () => undefined);
    const beforeContext = editingContexts[0];
    await tap(a, "ime");
    await kit.until(
      async () => editingContexts[0] > beforeContext,
      "IME field context delivered to the viewer",
      3000,
    );
    const textBefore = commands["input.text"] ?? 0;
    await a.keyboard.insertText("漢字");
    await a.getByRole("option", { name: /漢字/ }).waitFor();
    assert.equal(
      (commands["input.text"] ?? 0) - textBefore,
      1,
      "IME commit was inserted more than once",
    );
    const ime = a.getByRole("option", { name: /漢字/ });
    await ime.click();
    // The typed text already equals this suggestion, so the native value doesn't change.
    await ime.waitFor({ state: "hidden" });
    await pictureAfter(a, async () => undefined);
    const dispatchedBefore = guardedResults["dispatched:none"] ?? 0;
    await pictureAfter(a, async () => {
      await tap(a, "successor");
      await kit.until(
        async () => (guardedResults["dispatched:none"] ?? 0) > dispatchedBefore,
        "successor tap dispatched",
        3000,
      );
    });
    await tap(a, "single");
    await a.getByRole("dialog", { name: "Choose an option" }).waitFor();
    await pictureAfter(a, async () => {
      await a.getByRole("listbox", { name: "Choose an option" }).selectOption({ label: "Beta" });
      await a.getByRole("dialog", { name: "Choose a date" }).waitFor();
      await a.getByRole("button", { name: "Cancel", exact: true }).click();
    });
    await tap(a, "single");
    await a.getByRole("dialog").waitFor();
    const old = counts[0];
    const beforeHandoff = admissions[1];
    const beforePicture = await b.evaluate(() => Number(Reflect.get(window, "popupPresented")));
    await b.getByRole("button", { name: "Take control", exact: true }).click();
    await a.getByRole("dialog").waitFor({ state: "hidden" });
    assert.equal(counts[1], 0, "Handoff transferred the previous picker");
    assert(counts[0] >= old);
    await kit.snapshot("popups", "handoff");
    await kit.until(async () => admissions[1] > beforeHandoff, "replacement media admission", 4000);
    await b.waitForFunction(
      (before) => Number(Reflect.get(window, "popupPresented")) > before,
      beforePicture,
      { timeout: 4000 },
    );
    await tap(b, "single");
    await b.getByRole("dialog").waitFor();
    // Local input retains the stock route and interrupts a pre-existing remote draft.
    await kit.selectNativePage(context.sessionId, surfaceId);
    await kit.focusPage();
    await kit.pageMouse("#single", true);
    await b.getByRole("dialog").waitFor({ state: "hidden" });
    await kit.snapshot("popups", "local-native");
    const localMenu = await kit.popupInventory();
    assert(
      (localMenu.roles.AXMenu ?? 0) > (before.roles.AXMenu ?? 0) ||
        localMenu.windows.length > before.windows.length,
      "Local select did not create its stock native UI",
    );
    // Selecting the native page can resize it, which restarts the stream.
    await pictureAfter(b, async () => undefined);
    const tapsBefore = commands["input.guarded-click"] ?? 0;
    await tap(b, "single");
    await b
      .getByText("Close the open picker or dialog, then tap again.", { exact: true })
      .waitFor();
    assert.equal(
      (commands["input.guarded-click"] ?? 0) - tapsBefore,
      1,
      "Refused tap was retried automatically",
    );
    await kit.key(53);
    for (const id of ["local-date", "local-color"]) {
      await kit.pageMouse(`#${id}`, true);
      await kit.snapshot("popups", id);
      await kit.key(53);
    }
    await kit.pageMouse("#datalist", true);
    await kit.key(0, 1 << 20);
    await kit.key(51);
    await kit.key(0);
    await kit.key(37);
    await kit.snapshot("popups", "local-datalist");
    await kit.key(53);
    counts[2] = await b.evaluate(() =>
      Number((window as Window & { popupWatch?: { popups: number } }).popupWatch?.popups ?? 0),
    );
    assert.equal(counts[2], 0, "Watch received a chooser during local takeover");
    const beforeDisconnect = admissions[0];
    await viewers[1]!.viewer.close();
    await kit.until(
      async () => admissions[0] > beforeDisconnect,
      "remaining viewer's replacement admission",
      4000,
    );
    await pictureAfter(a, async () => undefined);
    await tap(a, "single");
    await a.getByRole("dialog").waitFor();
    const catalog = await context.api["browser.tabs.get"]({ sessionId: context.sessionId });
    assert(catalog.ok);
    const closed = await context.api["commands.dispatch"]({
      type: "browser.tab.close",
      sessionId: context.sessionId,
      surfaceId,
      expectedGeneration: catalog.data.generation,
      expectedRevision: catalog.data.inventoryRevision ?? catalog.data.revision,
      idempotencyKey: randomUUID(),
    });
    assert(closed.ok, `Tab close failed: ${JSON.stringify(closed)}`);
    await a.getByRole("dialog").waitFor({ state: "hidden" });
  } finally {
    const producerResult = !contents.isDestroyed()
      ? await contents
          .executeJavaScript(
            "({dimensions:{width:innerWidth,height:innerHeight},selectFocused:document.activeElement===document.getElementById('single'),counters:window.popupResults.single,childFrames:frames.length})",
            false,
          )
          .catch(() => null)
      : null;
    kit.artifacts.json("cases/popups/transport.json", {
      popupCounts: counts,
      commands,
      guardedResults,
      tapToPopupMs,
      answerToAppliedMs,
      nativeStops,
      events,
      sessionMatches,
      admissions,
      producerResult,
      viewerPid: pid,
      producerPid: process.pid,
      electron: process.versions.electron,
      ownerContract: process.versions["opensteer"],
      foreground: app.isHidden() ? "hidden" : "visible",
    });
    let screenshot = 0;
    for (const viewer of browser.contexts())
      for (const page of viewer.pages())
        await page
          .screenshot({ path: path.join(kit.run, "cases/popups", `viewer-${screenshot++}.png`) })
          .catch(() => undefined);
    await browser.close();
    await server.close();
    kit.ownedPids.delete(pid);
  }
}
