import { withTimeout } from "@opensteer/shared/withTimeout";
import { regionMeans } from "./native-browser-journey-image.js";
import { delay } from "@opensteer/shared/delay";
import assert from "node:assert/strict";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { app, clipboard, Menu } from "electron";
import { z } from "zod";
import { DesktopDownloadsSnapshotSchema } from "@opensteer/protocol/desktop";
import { electronPagePresentation } from "../src/browser/electron-browser-launcher.js";
import type { NativeBrowserE2EKit } from "./electron-native-browser-kit.js";
import { pageDownloadName } from "./electron-native-browser-download-fixture.js";

const runFile = promisify(execFile);

export async function runJourney(kit: NativeBrowserE2EKit): Promise<void> {
  const shell = kit.shell;
  assert(shell);
  const steps: { id: string; status: "PASS" | "FAIL"; seconds: number; error?: string }[] = [];
  async function step(id: string, action: () => Promise<void>) {
    const started = performance.now();
    kit.artifacts.event("step.start", { id });
    let timedOut = false;
    try {
      await withTimeout(
        (async () => {
          await action();
          await kit.snapshot(id, "after");
        })(),
        30_000,
        {
          timeoutError: () => {
            timedOut = true;
            return new Error(`Journey step ${id} exceeded 30000ms`);
          },
        },
      );
      steps.push({ id, status: "PASS", seconds: (performance.now() - started) / 1000 });
    } catch (error) {
      steps.push({
        id,
        status: "FAIL",
        seconds: (performance.now() - started) / 1000,
        error: kit.errorText(error),
      });
    } finally {
      const outcome = steps.at(-1)!;
      kit.artifacts.result(id, outcome.status, {
        measurements: { seconds: outcome.seconds },
        evidence: [`cases/${id}`],
        ...(outcome.error ? { reason: outcome.error } : {}),
      });
    }
    // A timed-out action may still be pending: tear down instead of overlapping steps.
    if (timedOut) throw new Error(`Journey stopped after ${id} deadline`);
  }
  async function open(route: string) {
    const result = await kit.context.api["commands.dispatch"]({
      type: "browser.tab.open",
      sessionId: kit.context.sessionId,
      idempotencyKey: randomUUID(),
      url: `${kit.context.origin}${route}`,
    });
    assert(result.ok && result.data.type === "browser.tab.open");
    await kit.selectNativePage(kit.context.sessionId, result.data.tabId);
    return result.data.tabId;
  }
  async function nativeClick(selector: string, page = true) {
    await kit.foregroundApp();
    await kit.inputReady();
    const contents = page ? kit.pageContents() : shell!.webContents;
    const point = await kit.elementPoint(contents, selector);
    const view = page ? electronPagePresentation(kit.activeSurface().page)!.view : shell!.appView;
    const offset = view.getBounds(),
      bounds = shell!.getContentBounds(),
      zoom = contents.getZoomFactor();
    await runFile(
      kit.inputHelper,
      [
        "mouse",
        String(process.pid),
        shell!.getMediaSourceId().split(":")[1]!,
        String(bounds.x + offset.x + point.x * zoom),
        String(bounds.y + offset.y + point.y * zoom),
        "left",
      ],
      { timeout: 5000 },
    );
  }
  async function painted(name: string, purple: boolean) {
    let attempt = 0;
    await kit.until(
      async () => {
        const file = await kit.snapshot("mount", `${name}-${++attempt}`);
        const image = sharp(path.join(kit.run, file));
        const metadata = await image.metadata();
        assert(metadata.width);
        const outer = shell!.getBounds(),
          content = shell!.getContentBounds();
        const bounds = electronPagePresentation(kit.activeSurface().page)!.view.getBounds();
        const scale = metadata.width / outer.width;
        const [red, green, blue] = await regionMeans(image, {
          left: Math.round((content.x - outer.x + bounds.x + bounds.width - 80) * scale),
          top: Math.round((content.y - outer.y + bounds.y + bounds.height - 80) * scale),
          width: Math.round(20 * scale),
          height: Math.round(20 * scale),
        });
        assert(red !== undefined && green !== undefined && blue !== undefined);
        kit.artifacts.event("paint.sample", { name, attempt, red, green, blue });
        return purple
          ? red > green + 30 && blue > green + 20
          : blue > red + 40 && blue > green + 20;
      },
      `composited ${name} page color`,
      5000,
    );
  }
  const initial = kit.activeSurface().surfaceId;
  await step("mount", async () => {
    const contents = kit.pageContents();
    assert.deepEqual(
      await contents.executeJavaScript(
        "({node:typeof require,process:typeof process,bridge:typeof window.opensteerDesktop})",
      ),
      { node: "undefined", process: "undefined", bridge: "undefined" },
    );
    const beforeOutgoing = kit.outgoing.length,
      appUrl = shell.webContents.getURL();
    const payload =
      '<img src=x onerror="window.nativeDragExecuted=true"><script>window.nativeDragExecuted=true</script>';
    await kit.evaluateApp(
      `(()=>{window.nativeDragExecuted=false;const dataTransfer=new DataTransfer();dataTransfer.setData('text/html',${JSON.stringify(payload)});dataTransfer.setData('text/plain',${JSON.stringify(payload)});dataTransfer.setData('text/uri-list','javascript:window.nativeDragExecuted=true');const target=document.querySelector('.browser-stage');target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer}));target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer}));})()`,
    );
    await delay(150);
    assert.equal(await kit.evaluateApp("window.nativeDragExecuted"), false);
    assert.equal(shell.webContents.getURL(), appUrl);
    assert(
      !kit.outgoing
        .slice(beforeOutgoing)
        .some((message) => /navigate|surface.open/.test(message.type)),
    );
    const timeOrigin = await contents.executeJavaScript("performance.timeOrigin");
    await kit.geometryFacts();
    await painted("initial-blue", false);
    await open("/q");
    assert.notEqual(kit.pageContents(), contents);
    assert.equal(
      await kit.pageContents().executeJavaScript("document.querySelector('#identity').textContent"),
      "Q",
    );
    await painted("switched-purple", true);
    await kit.selectNativePage(kit.context.sessionId, initial);
    await painted("returned-blue", false);
    assert.equal(kit.pageContents(), contents);
    assert.equal(await contents.executeJavaScript("performance.timeOrigin"), timeOrigin);
  });
  await step("geometry", async () => {
    const available = await kit.geometryFacts();
    const zoom = shell.webContents.getZoomFactor();
    await kit.resizeStage(
      Math.min(720, Math.floor(available.stage.width * zoom)),
      Math.min(480, Math.floor(available.stage.height * zoom)),
    );
    await kit.geometryFacts();
    const ledger = kit.runtimeState().ledger;
    const targetId = await kit.activeSurface().page.targetId();
    try {
      // Raw page CDP bypasses the controller's ledger and leaves paint geometry stale.
      assert(
        await ledger.agentMetrics(targetId, {
          width: 900,
          height: 650,
          deviceScaleFactor: 1,
          mobile: false,
        }),
      );
      await kit.until(async () => {
        try {
          return (
            z.object({ width: z.number() }).parse((await kit.geometryFacts()).viewport).width ===
            900
          );
        } catch (error) {
          if (!(error instanceof assert.AssertionError)) throw error;
          return false;
        }
      }, "agent viewport cropped");
      const before = await kit.pageContents().executeJavaScript("fixture.clicks");
      await nativeClick("#click");
      assert.equal(await kit.pageContents().executeJavaScript("fixture.clicks"), before + 1);
    } finally {
      assert(await ledger.agentMetrics(targetId, null));
    }
    await kit.until(async () => {
      try {
        await kit.geometryFacts();
        return true;
      } catch (error) {
        if (!(error instanceof assert.AssertionError)) throw error;
        return false;
      }
    }, "person viewport restored");
  });
  async function withSentinel(
    action: (
      front: () => Promise<number>,
      pid: number,
      state: () => Promise<{ text: string }>,
    ) => Promise<void>,
  ) {
    const file = path.join(kit.run, `sentinel-${randomUUID()}.json`);
    const child = spawn(kit.inputHelper, ["sentinel", file, String(process.pid)], {
      stdio: "ignore",
    });
    assert(child.pid);
    kit.ownedPids.add(child.pid);
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => {
        kit.ownedPids.delete(child.pid!);
        resolve();
      }),
    );
    const close = async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await exited;
    };
    kit.cleanup.push(close);
    try {
      const front = async () =>
        z.object({ frontmostPid: z.number() }).parse(JSON.parse(await readFile(file, "utf8")))
          .frontmostPid;
      await kit.until(async () => {
        try {
          return (await front()) === child.pid;
        } catch {
          return false;
        }
      }, "sentinel foreground");
      await action(front, child.pid, async () =>
        z.object({ text: z.string() }).parse(JSON.parse(await readFile(file, "utf8"))),
      );
    } finally {
      await close();
      await kit.foregroundApp();
    }
  }
  await step("focus", () =>
    withSentinel(async (front, pid, state) => {
      await kit
        .pageContents()
        .executeJavaScript(
          "document.querySelector('#text').focus();document.querySelector('#text').value=''",
        );
      const cdp = await kit.agentCdp();
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "a",
        code: "KeyA",
        text: "a",
      });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA" });
      assert.equal(await front(), pid);
      assert.equal((await state()).text, "");
      assert.equal(
        await kit.pageContents().executeJavaScript("document.querySelector('#text').value"),
        "a",
      );
      await runFile(kit.inputHelper, ["sentinel-key", String(pid), "11", "0"]);
      await kit.until(
        async () => (await state()).text === "b",
        "native keyboard remains with foreground sentinel",
      );
      assert.equal(
        await kit.pageContents().executeJavaScript("document.querySelector('#text').value"),
        "a",
      );
      await kit.foregroundApp();
      await kit.focusPage();
      await kit.key(8);
      assert.equal(
        await kit.pageContents().executeJavaScript("document.querySelector('#text').value"),
        "ac",
      );
      assert.equal((await state()).text, "b");
    }),
  );
  await step("clipboard", async () => {
    const previous = path.join(kit.run, "clipboard.json");
    await runFile(kit.inputHelper, ["clipboard-save", String(process.pid), previous]);
    const sentinel = `private-${randomUUID()}`;
    await clipboard.writeText(sentinel);
    try {
      const cdp = await kit.agentCdp();
      await cdp.send("Runtime.evaluate", {
        expression:
          "document.querySelector('#text').focus();window.pastes=0;document.addEventListener('paste',()=>window.pastes++)",
      });
      await assert.rejects(
        cdp.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "v",
          code: "KeyV",
          modifiers: 4,
          commands: ["paste"],
        }),
        /Pasting is not available/,
      );
      await kit.foregroundApp();
      await kit.focusPage();
      const tabs = await kit.context.api["browser.tabs.get"]({ sessionId: kit.context.sessionId });
      assert(tabs.ok);
      let quit = 0,
        closed = 0;
      const menus: string[] = [];
      const preventQuit = (event: Electron.Event) => {
        quit++;
        event.preventDefault();
      };
      const preventClose = (event: Electron.Event) => {
        closed++;
        event.preventDefault();
      };
      const items =
        Menu.getApplicationMenu()?.items.flatMap((item) => item.submenu?.items ?? []) ?? [];
      const originals = items.map((item) => item.click);
      app.on("before-quit", preventQuit);
      shell.on("close", preventClose);
      items.forEach((item, i) => {
        item.click = (...args: unknown[]) => {
          menus.push(item.label);
          return Reflect.apply(originals[i]!, item, args);
        };
      });
      try {
        for (const [key, code, modifiers] of [
          ["w", "KeyW", 4],
          ["q", "KeyQ", 4],
          [",", "Comma", 4],
          ["l", "KeyL", 4],
          ["t", "KeyT", 4],
          ["p", "KeyP", 12],
        ] as const) {
          await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, modifiers });
          await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers });
        }
      } finally {
        app.off("before-quit", preventQuit);
        shell.off("close", preventClose);
        items.forEach((item, i) => {
          item.click = originals[i]!;
        });
      }
      const after = await kit.context.api["browser.tabs.get"]({ sessionId: kit.context.sessionId });
      assert(after.ok);
      assert.deepEqual(
        after.data.tabs.map(({ id, site, order }) => ({ id, site, order })),
        tabs.data.tabs.map(({ id, site, order }) => ({ id, site, order })),
      );
      assert.equal(quit, 0);
      assert.equal(closed, 0);
      assert.deepEqual(menus, []);
      assert(shell.isVisible());
      assert(shell.isFocused());
      assert(kit.pageContents().isFocused());
      assert(!shell.isDestroyed());
      assert(!kit.pageContents().isDestroyed());
      assert.equal(await kit.pageContents().executeJavaScript("window.pastes"), 0);
      assert(
        !(
          await kit
            .pageContents()
            .executeJavaScript("document.body.innerText+document.querySelector('#text').value")
        ).includes(sentinel),
      );
      assert.equal(await clipboard.readText(), sentinel);
    } finally {
      await runFile(kit.inputHelper, ["clipboard-restore", String(process.pid), previous]);
    }
  });
  await step("editing", async () => {
    await kit.focusPage();
    await nativeClick("#text");
    await kit.key(0, 1 << 20);
    await kit.pageContents().insertText("journey");
    assert.equal(
      await kit.pageContents().executeJavaScript("document.querySelector('#text').value"),
      "journey",
    );
    await kit.key(6, 1 << 20);
    assert.notEqual(
      await kit.pageContents().executeJavaScript("document.querySelector('#text').value"),
      "journey",
    );
  });
  await step("find", async () => {
    await kit.focusPage();
    await kit.key(3, 1 << 20);
    await kit.until(
      async () =>
        (await kit.evaluateApp("!!document.querySelector('.browser-find input')")) === true,
      "find input",
    );
    await shell.webContents.insertText("needle");
    await kit.until(
      async () =>
        (await kit.evaluateApp("document.querySelector('.browser-find__count')?.textContent")) ===
        "1/3",
      "find matches",
    );
    await kit.key(53);
    await kit.until(
      async () => (await kit.evaluateApp("!document.querySelector('.browser-find')")) === true,
      "Escape closes find",
    );
  });
  await step("fullscreen", async () => {
    await nativeClick("#fullscreen");
    await kit.until(
      async () =>
        (await kit.pageContents().executeJavaScript("!!document.fullscreenElement")) === true,
      "HTML fullscreen",
    );
    assert.equal(shell.isFullScreen(), false);
    await kit.key(53);
    await kit.until(
      async () =>
        (await kit.pageContents().executeJavaScript("!document.fullscreenElement")) === true,
      "Escape exits fullscreen",
    );
  });
  await step("download", async () => {
    await open("/downloads");
    await kit.focusPage();
    await nativeClick("#download");
    await kit.until(
      async () =>
        DesktopDownloadsSnapshotSchema.parse(
          await kit.evaluateApp("window.opensteerDesktop.downloads.get()"),
        ).downloads.some((d) => d.filename === pageDownloadName && d.state === "completed"),
      "native download complete",
    );
    await kit.until(
      async () =>
        (await kit.evaluateApp(
          `Array.from(document.querySelectorAll('.toast')).some(el=>el.checkVisibility()&&el.textContent.includes(${JSON.stringify(`Downloaded ${pageDownloadName}`)}))`,
        )) === true,
      "visible completion feedback (60e962ef5)",
    );
    await kit.snapshot("download", "toast");
    await nativeClick('[aria-label="Downloads"][aria-haspopup="dialog"]', false);
    await kit.until(
      async () =>
        (await kit.evaluateApp("!!document.querySelector('.popover--downloads')")) === true,
      "downloads overlay",
    );
    kit.assertAppFront();
    const before = await kit.pageContents().executeJavaScript("fixture.clicks");
    await nativeClick(".popover--downloads", false);
    assert.equal(await kit.pageContents().executeJavaScript("fixture.clicks"), before);
    await kit.key(53);
    await kit.selectNativePage(kit.context.sessionId, initial);
  });
  await step("backgroundDialog", async () => {
    const page = kit.activeSurface();
    const contents = kit.pageContents();
    await open("/q");
    const cdp = await kit.agentCdp(page);
    await withSentinel(async (front, pid) => {
      await cdp.send("Runtime.evaluate", {
        expression: "setTimeout(()=>confirm('background journey'),0);undefined",
      });
      await kit.until(async () => kit.dialogPages.has(contents.id), "background dialog");
      assert.equal(await front(), pid, "Background dialog activated Opensteer");
      assert.notEqual(kit.pageContents(), contents);
      await cdp.send("Page.handleJavaScriptDialog", { accept: false });
      assert.equal(await front(), pid, "Dialog answer activated Opensteer");
    });
    await kit.selectNativePage(kit.context.sessionId, initial);
  });
  await step("return", async () => {
    shell.hide();
    shell.show();
    shell.focus();
    shell.webContents.reload();
    await kit.selectNativePage(kit.context.sessionId, initial);
    await kit.geometryFacts();
  });
  await step("nativeFailure", async () => {
    const page = kit.activeSurface(),
      contents = kit.pageContents(),
      target = kit.target();
    const wireStart = kit.outgoing.length,
      traceStart = kit.artifacts.trace.length;
    const opened = await kit.context.api["commands.dispatch"]({
      type: "browser.tab.open",
      sessionId: page.sessionId,
      url: `${kit.context.origin}/q`,
      idempotencyKey: randomUUID(),
    });
    assert(opened.ok && opened.data.type === "browser.tab.open");
    const source = [...kit.runtimeSources].find((source) => source.hasSession(page.sessionId));
    const doomed = source?.presentSurface(page.sessionId, opened.data.tabId);
    assert(doomed);
    const doomedContents = electronPagePresentation(doomed.page)!.view.webContents;
    doomedContents.close({ waitForBeforeUnload: false });
    await kit.until(
      async () => doomedContents.isDestroyed(),
      "destroy target before native exposure",
    );
    doomed.release();
    try {
      await assert.rejects(
        kit.presentationCall("update", {
          presentationId: target.presentationId,
          surfaceId: opened.data.tabId,
        }),
      );
      assert(!shell.contentView.children.includes(electronPagePresentation(page.page)!.view));
      await kit.until(
        async () => /can.t be shown|unavailable|ended/i.test(await kit.body()),
        "explicit native failure UI",
      );
      await delay(500);
      assert(
        !kit.outgoing
          .slice(wireStart)
          .some((message) => message.type === "stream.subscribe" && message.frames !== false),
        "Native failure started picture subscription",
      );
      assert.equal(
        kit.artifacts.trace.slice(traceStart).filter(
          (row) =>
            row.type === "debugger.invoke" &&
            z
              .object({
                contents: z.literal(contents.id),
                method: z.literal("Page.startScreencast"),
              })
              .safeParse(row.data).success,
        ).length,
        0,
        "Native failure started screencasting",
      );
      assert(!contents.isDestroyed());
    } finally {
      shell.webContents.reload();
      await kit.selectNativePage(kit.context.sessionId, initial);
    }
  });
  await step("revoke", async () => {
    const native = electronPagePresentation(kit.activeSurface().page)!;
    const stale = kit.target();
    kit.context.transport.closeSocketsForOwner(shell.webContents.id);
    assert(!shell.contentView.children.includes(native.view));
    await assert.rejects(
      kit.presentationCall("update", {
        presentationId: stale.presentationId,
        rect: { x: 0, y: 0, width: 100, height: 100 },
      }),
    );
  });
  assert(
    steps.every((step) => step.status === "PASS"),
    "Native browser journey failed; see summary.json",
  );
}
