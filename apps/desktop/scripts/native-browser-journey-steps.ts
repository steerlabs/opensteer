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
import type { CdpParameters } from "@opensteer/browser-core";
import { DesktopDownloadsSnapshotSchema } from "@opensteer/protocol/desktop";
import { electronPagePresentation } from "../src/browser/electron-browser-launcher.js";
import type { NativeBrowserE2EKit } from "./electron-native-browser-kit.js";
import { pageDownloadName } from "./electron-native-browser-download-fixture.js";
import { captureJourney } from "./native-browser-journey-capture.js";

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
      type: "tab.open",
      target: { kind: "page", guest: true, url: `${kit.context.origin}${route}` },
      idempotencyKey: randomUUID(),
    });
    assert(result.ok && result.data.type === "tab.open");
    await kit.selectNativePage(kit.context.sessionId, result.data.tab.tabId);
    return result.data.tab.tabId;
  }
  const nativeClick = (selector: string, page = true) => nativeJourneyClick(kit, selector, page);
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
  const capture = captureJourney(kit, step, open);
  await capture.size();
  await capture.geometry();
  await capture.states();
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
          "document.querySelector('#text').focus();document.querySelector('#text').value='';window.pastes=0;document.addEventListener('paste',()=>window.pastes++)",
      });
      // Own-agent CDP is unrestricted on page domains (pinned by session-cdp-router.test.ts
      // and electron-cdp-boundary-smoke.ts since PR #638), so page paste succeeds while
      // menu chords still stay inside the page because nativeVirtualKeyCode is stripped.
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "v",
        code: "KeyV",
        modifiers: 4,
        commands: ["paste"],
      });
      await cdp.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "v",
        code: "KeyV",
        modifiers: 4,
      });
      await kit.foregroundApp();
      await kit.focusPage();
      const beforeBootstrap = await kit.context.api["tabs.state"]({});
      assert(beforeBootstrap.ok);
      const tabs = beforeBootstrap.data;
      assert(tabs?.complete);
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
        // Each chord carries its macOS key code, as a native keyboard event would: the router
        // strips it, so none of them reaches the app's menus.
        for (const [key, code, modifiers, nativeVirtualKeyCode] of [
          ["w", "KeyW", 4, 13],
          ["q", "KeyQ", 4, 12],
          [",", "Comma", 4, 43],
          ["l", "KeyL", 4, 37],
          ["t", "KeyT", 4, 17],
          ["p", "KeyP", 12, 35],
        ] as const) {
          const chord = { key, code, modifiers, nativeVirtualKeyCode };
          await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...chord });
          await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...chord });
        }
      } finally {
        app.off("before-quit", preventQuit);
        shell.off("close", preventClose);
        items.forEach((item, i) => {
          item.click = originals[i]!;
        });
      }
      const afterBootstrap = await kit.context.api["tabs.state"]({});
      assert(afterBootstrap.ok);
      const after = afterBootstrap.data;
      assert(after?.complete);
      assert.deepEqual(after, tabs);
      assert.equal(quit, 0);
      assert.equal(closed, 0);
      assert.deepEqual(menus, []);
      assert(shell.isVisible());
      assert(shell.isFocused());
      assert(kit.pageContents().isFocused());
      assert(!shell.isDestroyed());
      assert(!kit.pageContents().isDestroyed());
      assert.equal(await kit.pageContents().executeJavaScript("window.pastes"), 1);
      assert.equal(
        await kit.pageContents().executeJavaScript("document.querySelector('#text').value"),
        sentinel,
      );
      assert.equal(await clipboard.readText(), sentinel);
    } finally {
      await runFile(kit.inputHelper, ["clipboard-restore", String(process.pid), previous]);
    }
  });
  await step("clipboardConnected", async () => {
    const previous = path.join(kit.run, "clipboard-connected.json");
    await runFile(kit.inputHelper, ["clipboard-save", String(process.pid), previous]);
    const sentinel = `private-${randomUUID()}`;
    await clipboard.writeText(sentinel);
    try {
      const refusal =
        "The clipboard is not available to a connected agent. Use Input.insertText to enter text.";
      const cdp = await kit.connectedAgentCdp();
      await cdp.send("Runtime.evaluate", {
        expression:
          "const text=document.querySelector('#text');text.focus();text.value='';window.pastes=0;window.copies=0;document.addEventListener('paste',()=>window.pastes++);document.addEventListener('copy',()=>window.copies++);document.addEventListener('cut',()=>window.copies++)",
      });
      const refused = async (
        method: string,
        parameters: CdpParameters,
        root = false,
        sentence = refusal,
      ) =>
        assert.equal(
          await cdp.send(method, parameters, root).then(
            () => "sent",
            (error: unknown) => (error instanceof Error ? error.message : String(error)),
          ),
          sentence,
          `${method} ${JSON.stringify(parameters)}`,
        );
      const paste = { type: "keyDown", key: "v", code: "KeyV", modifiers: 4 } as const;
      await refused("Input.dispatchKeyEvent", { ...paste, nativeVirtualKeyCode: 9 });
      await refused("Input.dispatchKeyEvent", { ...paste, commands: ["paste"] });
      await refused("Input.dispatchKeyEvent", { ...paste, commands: ["pasteAndMatchStyle"] });
      // Nor the Mac's camera, microphone or location: no browser permission changes.
      for (const permission of [
        "clipboardReadWrite",
        "audioCapture",
        "videoCapture",
        "geolocation",
      ])
        for (const root of [true, false])
          await refused(
            "Browser.grantPermissions",
            { permissions: [permission] },
            root,
            "Browser permissions cannot be changed by a connected agent.",
          );
      await cdp.send("Runtime.evaluate", {
        expression:
          "const copied=document.querySelector('#text');copied.value='agent-copy';copied.select()",
      });
      for (const [key, nativeVirtualKeyCode] of [
        ["c", 8],
        ["x", 7],
      ] as const)
        await refused("Input.dispatchKeyEvent", {
          type: "keyDown",
          key,
          code: `Key${key.toUpperCase()}`,
          modifiers: 4,
          nativeVirtualKeyCode,
        });
      assert.equal(await kit.pageContents().executeJavaScript("window.pastes"), 0);
      assert.equal(await kit.pageContents().executeJavaScript("window.copies"), 0);
      assert.equal(
        await kit.pageContents().executeJavaScript("document.querySelector('#text').value"),
        "agent-copy",
      );
      assert(
        !(
          await kit.pageContents().executeJavaScript("document.documentElement.outerHTML")
        ).includes(sentinel),
      );
      assert.equal(await clipboard.readText(), sentinel);
    } finally {
      await runFile(kit.inputHelper, ["clipboard-restore", String(process.pid), previous]);
    }
  });
  await step("clipboardPage", async () => {
    const previous = path.join(kit.run, "clipboard-page.json");
    await runFile(kit.inputHelper, ["clipboard-save", String(process.pid), previous]);
    // A fixture value, never what was on the clipboard before.
    const fixture = `fixture-${randomUUID()}`;
    await clipboard.writeText(fixture);
    const changeCount = async () =>
      z
        .object({ changeCount: z.number() })
        .parse(
          JSON.parse(
            (await runFile(kit.inputHelper, ["clipboard-count", String(process.pid)])).stdout,
          ),
        ).changeCount;
    const probes = {
      readText: `navigator.clipboard.readText().then((text) => "read:" + text, (error) => "refused:" + error.name)`,
      writeText: `navigator.clipboard.writeText("opensteer-page-write").then(() => "written", (error) => "refused:" + error.name)`,
      execCommand: `(() => { const field = document.createElement("textarea"); field.value = "opensteer-page-copy"; document.body.append(field); field.select(); const copied = document.execCommand("copy"); field.remove(); return copied; })()`,
    };
    /** Each page request under an agent's gesture, and whether the Mac's pasteboard moved. */
    const measure = async (cdp: Awaited<ReturnType<typeof kit.agentCdp>>) => {
      const seen: Record<string, { answer: unknown; moved: boolean }> = {};
      for (const [name, expression] of Object.entries(probes)) {
        const before = await changeCount();
        const reply = (await cdp.send("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          userGesture: true,
          returnByValue: true,
        })) as { result?: { value?: unknown } };
        seen[name] = { answer: reply.result?.value, moved: (await changeCount()) !== before };
      }
      return seen;
    };
    try {
      // An agent-driven tab in the background, focus emulated as an agent can.
      const background = await open("/q");
      await kit.selectNativePage(kit.context.sessionId, initial);
      await kit.foregroundApp();
      await kit.focusPage();
      const surface = kit.pages.get(background);
      assert(surface, "The background tab has a surface");
      const behind = await kit.agentCdp(surface);
      await behind.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      const fromBackground = await measure(behind);
      // The tab the person's window shows, with real focus.
      assert(kit.pageContents().isFocused());
      const fromPerson = await measure(await kit.agentCdp());
      kit.artifacts.event("clipboard.page-requests", { fromBackground, fromPerson });
      for (const [tab, seen] of [
        ["background", fromBackground],
        ["person's", fromPerson],
      ] as const) {
        // No page an agent works in reads the clipboard.
        assert.match(String(seen.readText!.answer), /^refused:/u, `${tab} tab read the clipboard`);
        assert(!String(seen.readText!.answer).includes(fixture));
        // The asynchronous clipboard API writes nothing, in either tab.
        assert.match(String(seen.writeText!.answer), /^refused:/u, `${tab} tab's writeText`);
        assert(!seen.writeText!.moved, `${tab} tab's writeText reached the Mac's clipboard`);
        // A known limit, recorded, not a wish: under an agent's gesture execCommand('copy')
        // replaces what is on the Mac's clipboard (Blink allows it on user activation alone and
        // Electron has no per-tab control). The consent says so; if Electron ever stops it,
        // this fails and that sentence is revisited.
        assert(seen.execCommand!.moved, `${tab} tab's execCommand('copy') no longer writes`);
      }
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
  await step("popup", async () => {
    const shown = () => {
      try {
        return kit.activeSurface().surfaceId;
      } catch {
        return null;
      }
    };
    /** A person's click brings its popup forward; the popup closing returns to the opener. */
    async function follows(opener: string, selector: string) {
      await nativeClick(selector);
      await kit.until(async () => ![opener, null].includes(shown()), "popup brought forward");
      assert.match(String(await kit.evaluateApp("location.search")), new RegExp(shown()!));
      await kit.pageContents().executeJavaScript("setTimeout(()=>window.close());undefined");
      await kit.until(async () => shown() === opener, "closing a popup returns to its opener");
    }
    const page = await open("/p");
    await kit.focusPage();
    await follows(page, "#popup");
    const framed = await open("/frame-opener");
    await kit.focusPage();
    const contents = kit.pageContents();
    await kit.until(
      async () => contents.mainFrame.frames[0]?.url.endsWith("/frame-button") === true,
      "cross-site frame loaded",
    );
    assert.notEqual(contents.mainFrame.frames[0]!.processId, contents.mainFrame.processId);
    await follows(framed, "#frame");
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
      type: "tab.open",
      target: { kind: "page", guest: true, url: `${kit.context.origin}/q` },
      idempotencyKey: randomUUID(),
    });
    assert(opened.ok && opened.data.type === "tab.open");
    const source = [...kit.runtimeSources].find((source) => source.hasSession(page.sessionId));
    const doomed = source?.presentSurface(page.sessionId, opened.data.tab.tabId);
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
          surfaceId: opened.data.tab.tabId,
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

export async function nativeJourneyClick(kit: NativeBrowserE2EKit, selector: string, page = true) {
  const shell = kit.shell;
  assert(shell);
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
