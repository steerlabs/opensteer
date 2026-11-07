import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { BrowserPage } from "@opensteer/browser-runtime-core";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { screen } from "electron";
import sharp from "sharp";
import { z } from "zod";
import { electronPagePresentation } from "../src/browser/electron-browser-launcher.js";
import type { NativeBrowserE2EKit } from "./electron-native-browser-kit.js";

type Rgb = readonly [number, number, number];
type Capture = { data: string; cropped?: unknown };
type AgentSurface = { surfaceId: string; sessionId: string; page: BrowserPage };

const red: Rgb = [255, 0, 0];
const green: Rgb = [0, 255, 0];
const near = (actual: Rgb, expected: Rgb) =>
  actual.every((channel, index) => Math.abs(channel - expected[index]!) < 32);

const markers = `(()=>{
  document.querySelectorAll('.capture-marker').forEach((node)=>node.remove());
  const add=(id,color,place)=>{const node=document.createElement('div');node.id=id;node.className='capture-marker';node.style.cssText='position:fixed;z-index:99999;width:24px;height:24px;background:'+color+';'+place;document.documentElement.append(node)};
  add('red','#f00','left:100px;top:60px');add('green','#0f0','left:300px;top:200px');
  const tall=document.createElement('div');tall.className='capture-marker';tall.style.cssText='position:absolute;left:0;top:0;width:1px;height:4000px';document.documentElement.append(tall);
})()`;
const recorder = `(()=>{
  window.looking={resizes:0,sizes:{}};
  addEventListener('resize',()=>looking.resizes++);
  const sample=()=>{const size=innerWidth+'x'+innerHeight+'@'+devicePixelRatio;looking.sizes[size]=(looking.sizes[size]??0)+1;requestAnimationFrame(sample)};
  sample();
})()`;
const twoFrames = "new Promise((done)=>requestAnimationFrame(()=>requestAnimationFrame(done)))";

async function pixels(png: Buffer) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    at: (x: number, y: number): Rgb => {
      const index = (y * info.width + x) * info.channels;
      return [data[index]!, data[index + 1]!, data[index + 2]!];
    },
    center(color: Rgb) {
      let sumX = 0;
      let sumY = 0;
      let count = 0;
      for (let y = 0; y < info.height; y++)
        for (let x = 0; x < info.width; x++)
          if (near(this.at(x, y), color)) {
            sumX += x;
            sumY += y;
            count++;
          }
      assert(count > 0, `No ${color.join(",")} marker in the screenshot`);
      return { x: Math.round(sumX / count), y: Math.round(sumY / count) };
    },
  };
}

export function captureJourney(
  kit: NativeBrowserE2EKit,
  step: (id: string, action: () => Promise<void>) => Promise<void>,
  open: (route: string) => Promise<string>,
) {
  const shell = kit.shell!;
  const state = kit.runtimeState();
  const { ledger, controller, host } = state;
  const router = host.router;
  /** The controller's own agent path: production exposes no IPC to a test. */
  const agentSession = async ({ page, sessionId }: AgentSurface) =>
    z.object({ sessionId: z.string() }).parse(
      await router.send(sessionId, {
        method: "Target.attachToTarget",
        parameters: { targetId: await page.targetId(), flatten: true },
      }),
    ).sessionId;
  async function agent(surface: AgentSurface) {
    const attached = await agentSession(surface);
    const capture = async (parameters: Record<string, unknown> = {}) => {
      const looked = Reflect.get(controller, "captureAgentViewport") as (
        command: unknown,
        surfaceId: string,
      ) => Promise<Capture>;
      return looked.call(
        controller,
        {
          method: "Page.captureScreenshot",
          parameters: { format: "png", ...parameters },
          sessionId: attached,
        },
        surface.surfaceId,
      );
    };
    const send = (method: string, parameters?: Record<string, unknown>) =>
      router.send(surface.sessionId, {
        method,
        sessionId: attached,
        ...(parameters ? { parameters } : {}),
      });
    return { capture, send };
  }
  const png = ({ data }: Capture) => Buffer.from(data, "base64");
  const contents = () => kit.pageContents();
  const nextFrames = () => contents().executeJavaScript(twoFrames);
  const view = () => electronPagePresentation(kit.activeSurface().page)!.view;

  /** Pixel (x, y) of the picture must be where a click at (x, y) lands. */
  async function clicksLand(
    looker: Awaited<ReturnType<typeof agent>>,
    size: { width: number; height: number },
  ) {
    await contents().executeJavaScript(markers);
    await nextFrames();
    const picture = await pixels(png(await looker.capture()));
    assert.deepEqual({ width: picture.width, height: picture.height }, size);
    for (const [id, color] of [
      ["red", red],
      ["green", green],
    ] as const) {
      const { x, y } = picture.center(color);
      await contents().executeJavaScript("fixture.events.length=0");
      await looker.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await looker.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      await looker.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      const hit = await contents().executeJavaScript(
        `fixture.events.filter((event)=>event.type==='mouseDown').map((event)=>document.elementFromPoint(event.x,event.y)?.id)`,
      );
      assert.deepEqual(hit, [id], `A click located from the screenshot missed ${id}`);
    }
    return picture;
  }

  /** The window's picture of the page's far corner, where a shrinking page first shows. */
  async function farCorner(id: string, name: string): Promise<Rgb> {
    const shot = path.join(kit.run, await kit.snapshot(id, name));
    const { width } = await sharp(shot).metadata();
    const outer = shell.getBounds();
    const content = shell.getContentBounds();
    const bounds = view().getBounds();
    assert(width);
    const scale = width / outer.width;
    const { data } = await sharp(shot)
      .extract({
        left: Math.round((content.x - outer.x + bounds.x + bounds.width - 60) * scale),
        top: Math.round((content.y - outer.y + bounds.y + bounds.height - 60) * scale),
        width: 2,
        height: 2,
      })
      .raw()
      .toBuffer({ resolveWithObject: true });
    return [data[0]!, data[1]!, data[2]!];
  }

  /**
   * What the person sees during back-to-back captures, from real window frames.
   * Bounds and DOM sizes stay right through Chromium's capture resize; only
   * these pixels show the page leaving that corner of the window.
   */
  async function presented(id: string, looker: Awaited<ReturnType<typeof agent>>, count: number) {
    await contents().executeJavaScript(markers);
    await contents().executeJavaScript(recorder);
    await nextFrames();
    const before = view().getBounds();
    const resting = await farCorner(id, "resting");
    let looking = true;
    const times: number[] = [];
    const burst = (async () => {
      while (looking) {
        const started = performance.now();
        await looker.capture();
        times.push(performance.now() - started);
      }
    })();
    const frames: Rgb[] = [];
    try {
      for (let frame = 0; frame < count; frame++)
        frames.push(await farCorner(id, `presented-${frame}`));
    } finally {
      looking = false;
      await burst;
    }
    kit.artifacts.event("capture.presented", { id, resting, frames, times });
    assert(times.length > 1, "Too few captures to judge presentation");
    assert(
      frames.every((frame) => near(frame, resting)),
      `The page left its place during capture: ${JSON.stringify({ resting, frames })}`,
    );
    assert.deepEqual(view().getBounds(), before);
    const page = z
      .object({ resizes: z.number(), sizes: z.record(z.string(), z.number()) })
      .parse(await contents().executeJavaScript("looking"));
    assert.equal(page.resizes, 0);
    assert.equal(Object.keys(page.sizes).length, 1, JSON.stringify(page.sizes));
    return [...times].sort((a, b) => a - b)[times.length >> 1]!;
  }

  async function withMetrics(
    metrics: { width: number; height: number; deviceScaleFactor: number; mobile: boolean },
    action: () => Promise<void>,
  ) {
    const targetId = await kit.activeSurface().page.targetId();
    assert(await ledger.agentMetrics(targetId, metrics));
    try {
      await kit.until(
        async () => (await contents().executeJavaScript("innerWidth")) === metrics.width,
        `agent width ${metrics.width}`,
        5_000,
      );
      await action();
    } finally {
      assert(await ledger.agentMetrics(targetId, null));
    }
  }

  const stageHeight = () => Math.min(759, screen.getPrimaryDisplay().workArea.height - 180);

  return {
    /** A page a person watches stays put, and its picture is in click coordinates. */
    async size() {
      await step("capture", async () => {
        const height = stageHeight();
        await kit.resizeStage(631, height);
        const looker = await agent(kit.activeSurface());
        const median = await presented("capture", looker, 8);
        kit.artifacts.event("capture.median", { milliseconds: median });
        await clicksLand(looker, { width: 631, height });
      });
    },

    async geometry() {
      await step("captureGeometry", async () => {
        const height = stageHeight();
        const looker = await agent(kit.activeSurface());
        await withMetrics(
          { width: 900, height: 900, deviceScaleFactor: 0, mobile: false },
          async () => {
            await presented("captureGeometry", looker, 3);
            await clicksLand(looker, { width: 631, height });
            assert.deepEqual((await looker.capture()).cropped, {
              page: { width: 900, height: 900 },
              visible: { width: 631, height },
            });
            await assert.rejects(
              looker.capture({ clip: { x: 700, y: 10, width: 20, height: 20, scale: 1 } }),
              /outside the 631×/,
            );
          },
        );
        await withMetrics(
          { width: 500, height: 400, deviceScaleFactor: 3, mobile: false },
          async () => {
            await presented("captureGeometry", looker, 3);
            await clicksLand(looker, { width: 500, height: 400 });
          },
        );
        await withMetrics(
          { width: 390, height: Math.min(600, height), deviceScaleFactor: 3, mobile: true },
          async () => {
            await clicksLand(looker, { width: 390, height: Math.min(600, height) });
            await contents().executeJavaScript(
              "document.querySelector('meta[name=viewport]').content='width=980'",
            );
            await kit.until(
              async () => (await contents().executeJavaScript("innerWidth")) === 980,
              "wide mobile layout",
              5_000,
            );
            const wide = await pixels(png(await looker.capture()));
            assert.equal(wide.width, 980);
            await contents().executeJavaScript(
              "document.querySelector('meta[name=viewport]').content='width=device-width,initial-scale=1'",
            );
          },
        );
        contents().setZoomFactor(1.5);
        try {
          await kit.until(
            async () =>
              (await contents().executeJavaScript("devicePixelRatio")) !==
              screen.getPrimaryDisplay().scaleFactor,
            "page zoom",
            5_000,
          );
          await clicksLand(looker, {
            width: Math.round(631 / 1.5),
            height: Math.round(height / 1.5),
          });
        } finally {
          contents().setZoomFactor(1);
        }
        await contents().executeJavaScript("scrollTo(0,500)");
        await clicksLand(looker, { width: 631, height });
        const clipped = await pixels(
          png(await looker.capture({ clip: { x: 104, y: 564, width: 16, height: 16, scale: 2 } })),
        );
        assert.deepEqual([clipped.width, clipped.height], [32, 32]);
        assert(near(clipped.at(16, 16), red), "The clip did not use document coordinates");
        await contents().executeJavaScript("scrollTo(0,0)");
        await assert.rejects(looker.capture({ captureBeyondViewport: true }), /Full-page capture/);
      });
    },

    async states() {
      await step("captureStates", async () => {
        const surface = kit.activeSurface();
        const looker = await agent(surface);
        const fill = (target: Electron.WebContents, color: string) =>
          target.executeJavaScript(
            `document.documentElement.style.background=document.body.style.background=${JSON.stringify(color)}`,
          );
        const fresh = async (
          target: Electron.WebContents,
          take: () => Promise<Capture>,
          label: string,
        ) => {
          for (const [css, rgb] of [
            ["rgb(255, 128, 0)", [255, 128, 0]],
            ["rgb(0, 128, 255)", [0, 128, 255]],
          ] as const) {
            await fill(target, css);
            const picture = await pixels(png(await take()));
            assert(
              near(picture.at(picture.width >> 1, picture.height >> 1), rgb),
              `${label} showed a stale frame`,
            );
          }
        };
        await contents().executeJavaScript(
          "document.querySelectorAll('.capture-marker').forEach((node)=>node.remove())",
        );
        const mine = contents();
        await fresh(mine, () => looker.capture(), "A shown page");

        const jpeg = png(await looker.capture({ format: "jpeg", quality: 30 }));
        assert.equal(jpeg.subarray(0, 2).toString("hex"), "ffd8");
        const webp = png(await looker.capture({ format: "webp", quality: 30 }));
        assert.equal(webp.toString("ascii", 8, 12), "WEBP");
        const webpPicture = await sharp(webp).metadata();
        assert.equal(webpPicture.width, view().getBounds().width);

        await mine.executeJavaScript(
          `(()=>{const canvas=document.createElement('canvas');canvas.width=innerWidth;canvas.height=innerHeight;canvas.style.cssText='position:fixed;left:0;top:0;z-index:99999';canvas.className='capture-marker';const context=canvas.getContext('2d');const image=context.createImageData(canvas.width,canvas.height);for(let i=0;i<image.data.length;i++)image.data[i]=Math.random()*255;context.putImageData(image,0,0);document.documentElement.append(canvas)})()`,
        );
        await assert.rejects(looker.capture(), /exceeds the bounded agent transport/);
        await mine.executeJavaScript(
          "document.querySelectorAll('.capture-marker').forEach((node)=>node.remove())",
        );

        const shots = await Promise.all(Array.from({ length: 8 }, () => looker.capture()));
        assert.equal(new Set(shots.map(({ data }) => data.length > 0)).size, 1);

        const hidden = new Promise<void>((resolve) => shell.once("hide", () => resolve()));
        shell.hide();
        await hidden;
        try {
          await fresh(mine, () => looker.capture(), "A page in a hidden window");
        } finally {
          shell.show();
        }

        void mine.executeJavaScript("setTimeout(()=>alert('capture'),0)");
        await kit.until(
          async () => ledger.dialogOpen(surface.surfaceId as never),
          "dialog open",
          5_000,
        );
        await assert.rejects(looker.capture(), /dialog is open/);
        await ledger.answerDialog(ledger.dialogOf(surface.surfaceId as never)!.id, true, undefined);

        await open("/q");
        assert.notEqual(kit.activeSurface().surfaceId, surface.surfaceId);
        await fresh(mine, () => looker.capture(), "A background tab");

        const result = await kit.context.api["commands.dispatch"]({
          type: "browser.tab.open",
          sessionId: kit.context.sessionId,
          idempotencyKey: randomUUID(),
          url: `${kit.context.origin}/behind`,
        });
        assert(result.ok && result.data.type === "browser.tab.open");
        const behindId = result.data.tabId;
        const records = Reflect.get(ledger, "records") as Map<string, { page: BrowserPage }>;
        await kit.until(async () => records.has(behindId), "unshown tab registered", 5_000);
        const behindPage = records.get(behindId)!.page;
        const behind = await agent({
          surfaceId: behindId,
          sessionId: surface.sessionId,
          page: behindPage,
        });
        const unshown = electronPagePresentation(behindPage)!.view.webContents;
        await fresh(unshown, () => behind.capture(), "A tab never shown");
        const closing = behind.capture();
        const answer = Promise.allSettled([closing]);
        await behindPage.close();
        await withTimeout(answer, 6_000, {
          timeoutError: () => new Error("A capture never settled after its page closed"),
        });
        await assert.rejects(behind.capture());

        await kit.selectNativePage(kit.context.sessionId, surface.surfaceId);
        const navigating = mine.loadURL(`${kit.context.origin}/p`);
        const during = await Promise.allSettled(Array.from({ length: 6 }, () => looker.capture()));
        await navigating;
        kit.artifacts.event("capture.navigation", {
          outcomes: during.map(({ status }) => status),
        });
        await pixels(png(await looker.capture()));
        await kit.resizeStage(720, 480);
      });
    },
  };
}
