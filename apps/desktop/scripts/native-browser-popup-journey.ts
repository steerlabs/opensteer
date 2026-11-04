import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { session, app } from "electron";
import { chromium, type Page } from "playwright-core";
import type { NativeBrowserE2EKit } from "./electron-native-browser-kit.js";

/** Real Personal Host and real web picker, in a separate viewer browser process. */
export async function browserPopupJourney(kit: NativeBrowserE2EKit): Promise<void> {
  assert.equal(
    process.versions.electron,
    "44.9.2",
    "Popup journey requires the qualified Electron",
  );
  const executable = process.env.OPENSTEER_POPUP_VIEWER_EXECUTABLE ?? chromium.executablePath();
  await access(executable).catch(() => {
    throw new Error(
      "Popup journey needs the pinned Playwright Chromium viewer installed in the VM.",
    );
  });
  const context = kit.context;
  const opened = await context.api["commands.dispatch"]({
    type: "browser.tab.open",
    sessionId: context.sessionId,
    idempotencyKey: randomUUID(),
    url: `${context.origin}/popups`,
  });
  assert(opened.ok && opened.data.type === "browser.tab.open");
  const surfaceId = opened.data.tabId;
  const producer = [...kit.pages.values()].find((p) => p.surfaceId === surfaceId);
  assert(producer, "Popup fixture has a production runtime page");
  const contents = (
    await import("../src/browser/electron-browser-launcher.js")
  ).electronPagePresentation(producer.page)!.view.webContents;
  assert("_createOpensteerInputOwner" in contents, "Private popup/input owner is missing");
  const server = await chromium.launchServer({ executablePath: executable, headless: false });
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
  try {
    // These are the journey's temporary owner cookies, held in live memory only.
    const cookies = await session
      .fromPartition(`persist:opensteer-host-${context.deploymentId}`)
      .cookies.get({ url: context.hostOrigin });
    const viewers = await Promise.all(
      [0, 1].map(async (index) => {
        const viewer = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
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
        page.on("websocket", (socket) => {
          socket.on("framereceived", ({ payload }) => {
            if (typeof payload !== "string") return;
            try {
              const m: unknown = JSON.parse(payload);
              if (m && typeof m === "object" && "type" in m && m.type === "browser.editing")
                editingContexts[index] = (editingContexts[index] ?? 0) + 1;
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
              if (m && typeof m === "object" && "type" in m && typeof m.type === "string")
                commands[m.type] = (commands[m.type] ?? 0) + 1;
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
        await page.locator("canvas").first().waitFor({ state: "visible" });
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
      const canvas = await page.locator("canvas").first().boundingBox();
      assert(canvas);
      await page.mouse.click(
        canvas.x + (point.x / point.w) * canvas.width,
        canvas.y + (point.y / point.h) * canvas.height,
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
    await read("window.replacePopup()");
    await a.getByRole("dialog").waitFor({ state: "hidden" });
    await tap(a, "multiple");
    const multiple = a.getByRole("listbox", { name: "Choose an option" });
    await multiple.selectOption([]);
    await a.getByRole("button", { name: "Done", exact: true }).click();
    await kit.until(
      async () => {
        const c = await counters("multiple");
        return c.input === 1 && c.change === 1;
      },
      "multiple clear commits exactly once",
      3000,
    );
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
      await a.getByRole("button", { name: "Done", exact: true }).click();
      await kit.until(
        async () => {
          const c = await counters(id);
          return c.change === 1;
        },
        `${id} native chooser commit`,
        3000,
      );
      await quiet();
    }
    // All page keys enter through the production proxy/private edit path.
    await tap(a, "datalist");
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
    await a.getByRole("option", { name: /漢字/ }).click();
    await tap(a, "successor");
    await tap(a, "single");
    await a.getByRole("dialog", { name: "Choose an option" }).waitFor();
    await a
      .getByRole("listbox", { name: "Choose an option" })
      .selectOption({ label: "Changed choice" });
    await a.getByRole("dialog", { name: "Choose a date" }).waitFor();
    await a.getByRole("button", { name: "Cancel", exact: true }).click();
    await tap(a, "single");
    await a.getByRole("dialog").waitFor();
    const old = counts[0];
    await b.getByRole("button", { name: "Take control", exact: true }).click();
    await a.getByRole("dialog").waitFor({ state: "hidden" });
    assert.equal(counts[1], 0, "Handoff transferred the previous picker");
    assert(counts[0] >= old);
    await kit.snapshot("popups", "handoff");
    await kit.until(
      async () => b.locator("canvas").first().isVisible(),
      "replacement viewer picture",
      4000,
    );
    await tap(b, "single");
    await b.getByRole("dialog").waitFor();
    await b.getByRole("button", { name: "Cancel", exact: true }).click();
    // Local input retains the stock route and interrupts a pre-existing remote draft.
    await kit.selectNativePage(context.sessionId, surfaceId);
    await kit.focusPage();
    await kit.pageMouse("#single", true);
    await kit.snapshot("popups", "local-native");
    const localMenu = await kit.popupInventory();
    assert(
      (localMenu.roles.AXMenu ?? 0) > (before.roles.AXMenu ?? 0) ||
        localMenu.windows.length > before.windows.length,
      "Local select did not create its stock native UI",
    );
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
    await kit.key(0);
    await kit.key(37);
    await kit.snapshot("popups", "local-datalist");
    await kit.key(53);
    counts[2] = await b.evaluate(() =>
      Number((window as Window & { popupWatch?: { popups: number } }).popupWatch?.popups ?? 0),
    );
    assert.equal(counts[2], 0, "Watch received a chooser during local takeover");
    await viewers[1]!.viewer.close();
    await tap(a, "single");
    await a.getByRole("dialog").waitFor();
    const catalog = await context.api["browser.tabs.get"]({ sessionId: context.sessionId });
    assert(catalog.ok);
    const closed = await context.api["commands.dispatch"]({
      type: "browser.tab.close",
      sessionId: context.sessionId,
      surfaceId,
      expectedGeneration: catalog.data.generation,
      expectedRevision: catalog.data.revision,
      idempotencyKey: randomUUID(),
    });
    assert(closed.ok);
    await a.getByRole("dialog").waitFor({ state: "hidden" });
    kit.artifacts.json("cases/popups/transport.json", {
      popupCounts: counts,
      commands,
      viewerPid: pid,
      producerPid: process.pid,
      electron: process.versions.electron,
      foreground: app.isHidden() ? "hidden" : "visible",
    });
  } finally {
    await browser.close();
    await server.close();
    kit.ownedPids.delete(pid);
  }
}
