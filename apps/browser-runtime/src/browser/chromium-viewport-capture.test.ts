import { describe, expect, it } from "vitest";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { readImageDimensions } from "@opensteer/browser-runtime-core";
import { chromium } from "playwright-core";
import { asRecord, evaluationValue, startFollowSession } from "./chromium.test-support.js";
import { PlaywrightChromiumLauncher } from "./playwright-launcher.js";

const pngSize = (data: string) => readImageDimensions(Buffer.from(data, "base64"), "png");

function deadline<T>(promise: Promise<T>, message: string): Promise<T> {
  return withTimeout(promise, 3500, { timeoutError: () => new Error(message) });
}

async function fixture() {
  const session = await startFollowSession({ path: "/plain" });
  const attached = asRecord(
    await session.agent("Target.attachToTarget", {
      targetId: session.rootTargetId,
      flatten: true,
    }),
  );
  const id = String(attached.sessionId);
  const agent = (method: string, parameters?: Record<string, unknown>) =>
    deadline(session.agent(method, parameters, id), `${method} never settled`);
  const evaluate = async (expression: string) =>
    evaluationValue(
      await agent("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }),
    );
  const capture = async (parameters: Record<string, unknown> = {}) =>
    asRecord(await agent("Page.captureScreenshot", { format: "png", ...parameters }))
      .data as string;
  return { ...session, id, agent, evaluate, capture };
}

const recorder = `(async () => {
  document.body.innerHTML = '<input value="selected"><div id="marker" style="position:fixed;left:100px;top:120px;width:60px;height:60px;background:rgb(255,0,0)"></div><div style="height:5000px"></div>';
  document.querySelector('#marker').onclick = () => window.hits = (window.hits || 0) + 1;
  const input = document.querySelector('input'); input.focus(); input.setSelectionRange(1,4);
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  window.changes = [];
  const state = () => JSON.stringify([innerWidth, innerHeight, devicePixelRatio, scrollX, scrollY, document.activeElement.tagName, input.selectionStart, input.selectionEnd, document.hasFocus()]);
  window.initialState = state();
  for (const event of ['resize','scroll','focus','blur','selectionchange'])
    addEventListener(event, () => changes.push(event));
  new ResizeObserver(() => { if (window.observerReady) changes.push('observer'); window.observerReady = true; }).observe(document.documentElement);
  const sample = () => { if(state() !== initialState) changes.push(state()); requestAnimationFrame(sample); };
  requestAnimationFrame(sample);
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  changes.length = 0;
})()`;

async function marker(data: string, evaluate: (expression: string) => Promise<unknown>) {
  return (await evaluate(`(async () => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(${JSON.stringify(data)}), c => c.charCodeAt(0))]));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap,0,0);
    const pixels = ctx.getImageData(0,0,bitmap.width,bitmap.height).data;
    let left=bitmap.width, right=0, top=bitmap.height, bottom=0;
    for(let y=0;y<bitmap.height;y++) for(let x=0;x<bitmap.width;x++) {
      const i=(y*bitmap.width+x)*4;
      if(pixels[i]>200 && pixels[i+1]<30 && pixels[i+2]<30) {
        left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);
      }
    }
    bitmap.close(); return {x:(left+right)/2,y:(top+bottom)/2};
  })()`)) as { x: number; y: number };
}

describe("passive Chromium viewport capture", () => {
  it.each([1, 2, 3])(
    "leaves layout, focus, scroll and selection untouched at DSF %s",
    async (deviceScaleFactor) => {
      const f = await fixture();
      await f.agent("Emulation.setDeviceMetricsOverride", {
        width: 631,
        height: 759,
        deviceScaleFactor,
        mobile: false,
      });
      await f.evaluate(recorder);
      for (let i = 0; i < 3; i++) {
        expect(pngSize(await f.capture())).toEqual({ width: 631, height: 759 });
        expect(
          pngSize(await f.capture({ clip: { x: 20, y: 20, width: 200, height: 200, scale: 2 } })),
        ).toEqual({ width: 400, height: 400 });
      }
      await f.evaluate(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      expect(await f.evaluate("changes")).toEqual([]);
    },
  );

  it.each([
    { deviceScaleFactor: 1, mobile: false, meta: "device-width", scroll: 0 },
    { deviceScaleFactor: 2, mobile: false, meta: "device-width", scroll: 0 },
    { deviceScaleFactor: 2, mobile: true, meta: "device-width", scroll: 0 },
    { deviceScaleFactor: 2, mobile: true, meta: "980", scroll: 0 },
    { deviceScaleFactor: 1, mobile: false, meta: "device-width", scroll: 400 },
  ])("keeps image pixels in input coordinates: %j", async (mode) => {
    const f = await fixture();
    await f.agent("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 700,
      deviceScaleFactor: mode.deviceScaleFactor,
      mobile: mode.mobile,
    });
    await f.evaluate(
      `document.head.insertAdjacentHTML('beforeend','<meta name="viewport" content="width=${mode.meta}">')`,
    );
    await f.evaluate(recorder);
    await f.evaluate(
      `scrollTo(0,${mode.scroll});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`,
    );
    const data = await f.capture();
    const metrics = asRecord(await f.agent("Page.getLayoutMetrics"));
    const viewport = asRecord(metrics.cssVisualViewport);
    if (mode.meta === "980") {
      expect(Math.round(Number(viewport.clientWidth))).toBe(980);
      expect(Math.round(Number(viewport.clientHeight))).toBe(1759);
      expect(Number(viewport.scale)).toBeLessThan(1);
    }
    expect(pngSize(data)).toEqual({
      width: Math.round(Number(viewport.clientWidth)),
      height: Math.round(Number(viewport.clientHeight)),
    });
    const point = await marker(data, f.evaluate);
    for (const type of ["mousePressed", "mouseReleased"])
      await f.agent("Input.dispatchMouseEvent", {
        ...point,
        type,
        button: "left",
        clickCount: 1,
      });
    expect(await f.evaluate("hits")).toBe(1);
    const crop = await f.capture({
      clip: { x: 100, y: 120 + mode.scroll, width: 60, height: 60, scale: 2 },
    });
    expect(pngSize(crop)).toEqual({ width: 120, height: 120 });
    const center = await marker(crop, f.evaluate);
    expect(center.x).toBeCloseTo(59.5, 0);
    expect(center.y).toBeCloseTo(59.5, 0);
    await expect(
      f.capture({ clip: { x: 10000, y: 0, width: 10, height: 10, scale: 1 } }),
    ).rejects.toThrow(/outside/);
  });

  it("captures a background tab without activating it", async () => {
    const f = await fixture();
    await f.evaluate(recorder);
    const popup = await f.openPopup(f.id);
    const front = f.ledger.binding(popup)!;
    await f.ledger
      .binding(f.rootSurfaceId)!
      .cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
    await front.cdp.send("Page.bringToFront");
    expect(await f.read(popup, "document.hasFocus()")).toBe(true);
    expect(await f.evaluate("document.hasFocus()")).toBe(false);
    await f.evaluate("changes.length=0");
    await f.capture();
    await f.capture({ clip: { x: 0, y: 0, width: 200, height: 200, scale: 1 } });
    expect(await f.read(popup, "document.hasFocus()")).toBe(true);
    expect(await f.evaluate("document.hasFocus()")).toBe(false);
    expect(await f.evaluate("changes.filter(change=>change==='focus'||change==='blur')")).toEqual(
      [],
    );
  });

  it("encodes jpeg and webp quality on both paths and hides the helper", async () => {
    const f = await fixture();
    await f.evaluate(recorder);
    const before = await f.agent("Target.getTargets");
    for (const format of ["jpeg", "webp"] as const) {
      for (const clip of [undefined, { x: 0, y: 0, width: 300, height: 300, scale: 1 }]) {
        const low = await f.capture({ format, quality: 10, ...(clip ? { clip } : {}) });
        const high = await f.capture({ format, quality: 95, ...(clip ? { clip } : {}) });
        expect(low).not.toEqual(high);
        const bytes = Buffer.from(high, "base64");
        expect(
          format === "jpeg" ? bytes.subarray(0, 2).toString("hex") : bytes.toString("ascii", 8, 12),
        ).toBe(format === "jpeg" ? "ffd8" : "WEBP");
      }
    }
    expect(await f.agent("Target.getTargets")).toEqual(before);
  });

  it("bounds noisy images before they reach the agent", async () => {
    const f = await fixture();
    await f.evaluate(`{
      const c = document.createElement('canvas');c.width=1200;c.height=800;
      document.body.replaceChildren(c);document.body.style.margin='0';
      const ctx=c.getContext('2d'), pixels=ctx.createImageData(c.width,c.height);
      for(let i=0;i<pixels.data.length;i++) pixels.data[i]=i%4===3?255:Math.random()*256;
      ctx.putImageData(pixels,0,0);
    }`);
    await expect(f.capture()).rejects.toThrow(/bounded agent transport/);
  });

  it("keeps watcher frames flowing at their original size during captures", async () => {
    const f = await fixture();
    await f.evaluate(recorder);
    await f.controller.handle({ type: "stream.subscribe" });
    await f.evaluate(
      "window.paint=0;window.paintFrame=()=>{document.body.style.background=++paint%2?'#aaa':'#bbb';requestAnimationFrame(paintFrame)};requestAnimationFrame(paintFrame)",
    );
    await deadline(
      f.frameAt(
        f.rootSurfaceId,
        await f.pageState(f.rootSurfaceId).then((s) => ({ width: s.width, height: s.height })),
      ),
      "Watcher never received its first frame",
    );
    const at = performance.now();
    await Promise.all(
      Array.from({ length: 4 }, () =>
        f.capture({ clip: { x: 0, y: 0, width: 100, height: 100, scale: 2 } }),
      ),
    );
    const ended = performance.now();
    const size = await f.pageState(f.rootSurfaceId);
    expect(f.frames.some((frame) => frame.at >= at && frame.at <= ended)).toBe(true);
    await deadline(
      f.frameAt(f.rootSurfaceId, { width: size.width, height: size.height }, at),
      "Watcher received no frame during capture",
    );
    expect(
      f.frames
        .filter((frame) => frame.at >= at)
        .every(
          (frame) =>
            frame.header.viewportWidth === size.width &&
            frame.header.viewportHeight === size.height,
        ),
    ).toBe(true);
  });

  it("settles concurrent captures, navigation and closing in flight", async () => {
    const f = await fixture();
    const results = await Promise.all(Array.from({ length: 5 }, () => f.capture()));
    expect(results.every((data) => readImageDimensions(Buffer.from(data, "base64"), "png"))).toBe(
      true,
    );
    const navigation = f.agent("Page.navigate", { url: f.origin + "/mobile" });
    const captured = f.capture().then(
      () => "captured",
      (error) => String(error),
    );
    await deadline(Promise.all([navigation, captured]), "Navigation capture never settled");
    await f.capture({ clip: { x: 0, y: 0, width: 100, height: 100, scale: 1 } });
    const page = f.ledger.binding(f.rootSurfaceId)!.page;
    const platform = await page.cdp();
    await platform.send("Page.enable");
    const opened = Promise.withResolvers<void>();
    platform.on("Page.javascriptDialogOpening", () => opened.resolve());
    const alert = platform
      .send("Runtime.evaluate", { expression: "alert('close in flight')" })
      .catch(() => undefined);
    await deadline(opened.promise, "The blocking dialog never opened");
    const pending = page.captureViewport({
      format: "png",
      layout: { height: 700, width: 390 },
      pageScale: 1,
    });
    const settled = Promise.allSettled([pending]);
    await deadline(f.closeBrowser(), "The browser session did not close");
    const closed = await deadline(settled, "Capture did not settle after browser session close");
    expect(closed[0]?.status).toBe("rejected");
    await deadline(alert, "The dialog evaluation did not settle on close");
  });

  it("keeps click coordinates on a browser whose own display is 2x", async () => {
    const launcher = new PlaywrightChromiumLauncher({
      args: ["--force-device-scale-factor=2"],
      chromiumSandbox: false,
      executablePath: chromium.executablePath(),
      headless: true,
    });
    const browser = await launcher.launch({
      initialViewport: { devicePixelRatio: 1, height: 759, width: 631 },
      partitionKey: "session:capture-2x",
      storage: { kind: "guest" },
    });
    try {
      const page = browser.context.pages()[0]!;
      await (
        await page.cdp()
      ).send("Emulation.setDeviceMetricsOverride", {
        deviceScaleFactor: 0,
        height: 759,
        mobile: false,
        width: 631,
      });
      const request = { layout: { height: 759, width: 631 }, pageScale: 1 };
      const { data } = await page.captureViewport({ ...request, format: "png" });
      expect(pngSize(data)).toEqual({ width: 631, height: 759 });
      const jpeg = await page.captureViewport({ ...request, format: "jpeg" });
      expect(readImageDimensions(Buffer.from(jpeg.data, "base64"), "jpeg")).toEqual({
        width: 631,
        height: 759,
      });
    } finally {
      await browser.close();
    }
  });
});
