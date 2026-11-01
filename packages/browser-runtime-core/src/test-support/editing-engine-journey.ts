import { SessionCdpRouter, type CdpEvent } from "@opensteer/browser-core";
import type { BrowserServerMessage } from "@opensteer/protocol/browser";
import type { EditingContext } from "@opensteer/protocol/editing";
import { delay } from "@opensteer/shared/delay";
import { withTimeout } from "@opensteer/shared/withTimeout";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { LaunchedBrowser } from "../browser/backend.js";
import { BrowserController } from "../browser/controller.js";
import { editingCommandParameters } from "../browser/editing-commands.js";
import { PageEditingObserver } from "../browser/editing-observer.js";
import { HostSignIns } from "../browser/host-sign-ins.js";
import { SessionFiles } from "../browser/session-files.js";
import { SurfaceLedger } from "../browser/surface-ledger.js";
import { freshClaims } from "./fakes.js";

/** The real engine supplies its debugger; no clipboard operation or OS activation is used. */
export async function runEditingEngineJourney(
  browser: LaunchedBrowser,
  url: string,
  evidence: string,
): Promise<void> {
  await mkdir(evidence, { recursive: true });
  const checks: string[] = [];
  const contexts: EditingContext[] = [];
  const page = browser.context.pages()[0];
  assert(page);
  const cdp = await page.cdp();
  const send = cdp.send.bind(cdp);
  let sequence = 0;
  cdp.send = async <Result = unknown>(
    method: string,
    parameters?: Record<string, unknown>,
  ): Promise<Result> => {
    const id = ++sequence;
    const started = performance.now();
    const record = (state: string) =>
      appendFileSync(
        path.join(evidence, "cdp.jsonl"),
        JSON.stringify({
          id,
          method,
          state,
          atMs: performance.now(),
          elapsedMs: performance.now() - started,
        }) + "\n",
      );
    record("sent");
    try {
      const result = await withTimeout(send<Result>(method, parameters), 5000, {
        timeoutError: () =>
          new Error(`Editing CDP step ${id} (${method}) did not acknowledge within 5000 ms.`),
      });
      record("acknowledged");
      return result;
    } catch (error) {
      record("failed");
      throw error;
    }
  };
  const releaseRendering = cdp.retainRendering?.();
  const menus: { editable: boolean; selection: boolean; linkUrl?: string | undefined }[] = [];
  const observer = new PageEditingObserver(
    cdp,
    (context) => contexts.push(context),
    (menu) => menus.push(menu),
  );
  const ledger = new SurfaceLedger(browser.context, {
    initialViewport: { width: 800, height: 600, devicePixelRatio: 1 },
  });
  let controller: BrowserController | undefined;
  const signIns = new HostSignIns({ authority: undefined, runtimeId: "editing-engine" });
  const messages: BrowserServerMessage[] = [];
  const events: CdpEvent[] = [];
  const machineClipboardShared = browser.clipboard?.machineClipboardShared ?? true;
  const router = new SessionCdpRouter(browser.cdp, {}, machineClipboardShared);
  const read = async <T>(expression: string): Promise<T> =>
    (
      await cdp.send<{ result: { value: T } }>("Runtime.evaluate", {
        expression,
        returnByValue: true,
      })
    ).result.value;
  const wait = async (predicate: () => Promise<boolean> | boolean) => {
    const end = Date.now() + 5000;
    while (!(await predicate())) {
      if (Date.now() >= end)
        throw new Error("The editing engine journey did not reach its asserted state.");
      await delay(10);
    }
  };
  let failure: unknown;
  let focus: unknown;
  try {
    await ledger.start();
    await cdp.send("Page.enable");
    await observer.start();
    await cdp.send("Page.navigate", { url });
    await wait(() => read<boolean>("!!document.querySelector('#t')"));
    await read("t.focus()");
    focus = await read("document.hasFocus()");
    await wait(() => contexts.at(-1)?.field !== null && contexts.at(-1)?.field !== undefined);
    checks.push("private observer reports the focused field without OS focus");
    assert.equal(focus, true);
    const first = contexts.at(-1)!;
    assert(first.caret && first.caret.height > 0);
    assert(first.caret.x >= 0 && first.caret.x <= 1 && first.caret.y >= 0 && first.caret.y <= 1);
    checks.push("editing observer publishes a normalized native caret");
    for (const text of ["a", "b"])
      await observer.input(() =>
        cdp.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: text,
          code: `Key${text.toUpperCase()}`,
          windowsVirtualKeyCode: text.toUpperCase().charCodeAt(0),
          text,
        }),
      );
    assert.equal(await read("t.value"), "ab");
    await observer.input(() =>
      cdp.send("Input.dispatchKeyEvent", editingCommandParameters("undo", process.platform)),
    );
    assert.equal(await read("t.value"), "");
    await observer.input(() =>
      cdp.send("Input.dispatchKeyEvent", editingCommandParameters("redo", process.platform)),
    );
    assert.equal(await read("t.value"), "ab");
    await observer.input(() =>
      cdp.send(
        "Input.dispatchKeyEvent",
        editingCommandParameters("moveToLeftEndOfLine", process.platform),
      ),
    );
    assert.equal(await read("t.selectionStart"), 0);
    if (process.platform === "darwin") {
      assert(
        await read<boolean>("events.some(e=>e.type==='keydown'&&e.key==='z'&&e.meta&&!e.control)"),
      );
      assert(
        await read<boolean>("events.some(e=>e.type==='keydown'&&e.key==='Z'&&e.meta&&e.shift)"),
      );
      assert(
        await read<boolean>("events.some(e=>e.type==='keydown'&&e.key==='ArrowLeft'&&e.meta)"),
      );
    }
    await read("t.onkeydown=e=>{if(e.key==='a')e.preventDefault()}");
    await observer.input(() =>
      cdp.send("Input.dispatchKeyEvent", editingCommandParameters("selectAll", process.platform)),
    );
    assert.equal(await read("t.selectionStart"), 0);
    assert.equal(await read("t.selectionEnd"), 0);
    await read("t.onkeydown=null");
    checks.push(
      "platform chords and Blink commands: undo, redo, line start and page-canceled select all",
    );
    await observer.input(() =>
      cdp.send(
        "Input.dispatchKeyEvent",
        editingCommandParameters("moveToRightEndOfLine", process.platform),
      ),
    );
    assert.equal(
      await observer.edit(
        { contextId: first.contextId, before: "ab", after: "", text: "the" },
        false,
      ),
      true,
    );
    assert.equal(await read("t.value"), "the");
    assert.equal(
      await observer.edit(
        { contextId: first.contextId, text: "한", selectionStart: 1, selectionEnd: 1 },
        true,
      ),
      true,
    );
    assert.equal(await read("t.value"), "the한");
    assert.equal(
      await observer.edit(
        { contextId: first.contextId, before: "", after: "", text: "한국" },
        false,
      ),
      true,
    );
    assert.equal(await read("t.value"), "the한국");
    const compositionEvents = await read<{ type: string }[]>("events");
    assert(compositionEvents.some((event) => event.type === "compositionstart"));
    assert(compositionEvents.some((event) => event.type === "compositionupdate"));
    assert(compositionEvents.some((event) => event.type === "compositionend"));
    checks.push("verified replacement and one live composition commit on the engine debugger");
    const before = observer.context.contextId;
    assert.equal(
      await observer.edit({ contextId: before, before: "mismatch", after: "", text: "bad" }, false),
      false,
    );
    assert.notEqual(observer.context.contextId, before);
    assert.equal(await read("t.value"), "the한국");
    checks.push("stale text refuses and rotates context without mutation");
    await read(
      "t.focus();t.setSelectionRange(0,3);window.menuEvents=0;document.addEventListener('contextmenu',()=>menuEvents++)",
    );
    const rect = await read<{ x: number; y: number }>(
      "(()=>{const r=t.getBoundingClientRect();return {x:r.x+10,y:r.y+5}})()",
    );
    const contextMenu = async () => {
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        button: "right",
        clickCount: 1,
        ...rect,
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        button: "right",
        clickCount: 1,
        ...rect,
      });
    };
    await contextMenu();
    await wait(() => menus.length === 1);
    assert.equal(menus[0]!.editable, true);
    assert.equal(menus[0]!.selection, true);
    await read("t.oncontextmenu=e=>e.preventDefault()");
    await contextMenu();
    await wait(() => read<boolean>("menuEvents===2"));
    await cdp.send("Runtime.evaluate", {
      expression: "new Promise(resolve=>setTimeout(resolve,0))",
      awaitPromise: true,
    });
    assert.equal(menus.length, 1);
    await read("t.oncontextmenu=null");
    checks.push("native context-menu editable/selection facts and page cancellation");
    const targetId = await page.targetId();
    router.registerSession("editing-engine", targetId, async () => false, evidence);
    const stopEvents = router.onEvent("editing-engine", (event) => events.push(event));
    const attached = (await router.send("editing-engine", {
      method: "Target.attachToTarget",
      parameters: { targetId, flatten: true },
    })) as { sessionId: string };
    await router.send("editing-engine", {
      method: "Runtime.enable",
      sessionId: attached.sessionId,
    });
    assert(!JSON.stringify(events).includes("opensteer-editing-"));
    stopEvents();
    await assert.rejects(
      router.send("editing-engine", {
        method: "Input.imeSetComposition",
        parameters: { text: "blocked", selectionStart: 7, selectionEnd: 7 },
        sessionId: attached.sessionId,
      }),
      /not available to agents/iu,
    );
    checks.push("agent CDP cannot acquire the private composition method");
    if (machineClipboardShared) {
      for (const operation of ["copy", "cut"])
        await assert.rejects(
          router.send("editing-engine", {
            method: "Input.dispatchKeyEvent",
            parameters: { type: "keyDown", commands: [operation] },
            sessionId: attached.sessionId,
          }),
          /clipboard/iu,
        );
      checks.push("agent native copy/cut is refused on the shared machine clipboard engine");
    }
    checks.push("agent CDP does not see the editing private world");
    await observer.close();
    await router.unregisterSession("editing-engine");
    const claims = freshClaims(
      browser.clipboard ? { editingVersion: 1 } : { editingVersion: 2, clipboard: false },
    );
    router.registerSession(claims.sessionId, targetId, ledger.resolveTarget.bind(ledger), evidence);
    controller = new BrowserController({
      cdpRouter: router,
      claims,
      clipboard: browser.clipboard,
      replaceSiteCookies: (...args) => browser.replaceSiteCookies(...args),
      files: new SessionFiles(path.join(evidence, "session-files")),
      ledger,
      signIns,
      maxPendingCommands: 32,
      sink: {
        sendFrame: async () => {},
        sendServer: async (message) => {
          messages.push(message);
        },
      },
    });
    await controller.start();
    const surfaceId = ledger.active()!.surface.id;
    await read("t.value='owner';t.focus();t.setSelectionRange(5,5)");
    const editingContext = () => messages.findLast((message) => message.type === "browser.editing");
    await wait(
      () =>
        editingContext()?.type === "browser.editing" &&
        editingContext()?.context.field?.kind === "text",
    );
    const contextId = editingContext()!.context.contextId;
    const owner = randomUUID(),
      contender = randomUUID();
    await controller.handle({
      type: "input.key",
      surfaceId,
      producerId: owner,
      action: "down",
      key: "Shift",
      code: "ShiftLeft",
      modifiers: ["shift"],
    });
    await controller.handle({
      type: "input.text",
      surfaceId,
      producerId: contender,
      edit: { contextId, before: "", after: "", text: "blocked" },
    });
    await controller.handle({
      type: "input.compose",
      surfaceId,
      producerId: contender,
      composition: { contextId, text: "blocked", selectionStart: 7, selectionEnd: 7 },
    });
    await controller.handle({
      type: "input.command",
      surfaceId,
      producerId: contender,
      command: "deleteBackward",
    });
    await controller.handle(
      browser.clipboard
        ? {
            type: "clipboard.cut",
            surfaceId,
            producerId: contender,
            operationId: randomUUID(),
          }
        : {
            type: "input.key",
            surfaceId,
            producerId: contender,
            action: "down",
            key: "x",
            code: "KeyX",
            modifiers: ["primary"],
          },
    );
    await wait(
      () =>
        messages.filter(
          (message) =>
            message.type === "browser.error" &&
            message.producerId === contender &&
            message.error.reason === "browser-input-owner-conflict",
        ).length === 4,
    );
    assert.equal(await read("t.value"), "owner");
    await controller.handle({
      type: "input.key",
      surfaceId,
      producerId: owner,
      action: "up",
      key: "Shift",
      code: "ShiftLeft",
      modifiers: [],
    });
    await controller.handle({
      type: "input.text",
      surfaceId,
      producerId: contender,
      edit: { contextId, before: "", after: "", text: " accepted" },
    });
    assert.equal(await read("t.value"), "owner accepted");
    checks.push(
      "controller authority refuses text, composition, command and cut behind another producer's held key",
    );
    await read(
      "t.value='';t.setSelectionRange(0,0);window.pressureKeys=0;t.addEventListener('keydown',e=>{if(e.key==='x')pressureKeys++})",
    );
    const producerId = randomUUID();
    await Promise.all(
      Array.from({ length: 150 }, (_, index) =>
        controller!.handle({
          type: "input.key",
          surfaceId,
          producerId,
          action: "down",
          key: "x",
          code: "KeyX",
          modifiers: [],
          text: "x",
          repeat: index > 0,
        }),
      ),
    );
    await controller.handle({
      type: "input.key",
      surfaceId,
      producerId,
      action: "up",
      key: "x",
      code: "KeyX",
      modifiers: [],
    });
    const refused = messages.filter(
      (message) =>
        message.type === "browser.error" &&
        message.producerId === producerId &&
        message.error.reason === "browser-input-overload",
    ).length;
    const accepted = await read<number>("pressureKeys");
    assert(refused > 0 && accepted > 0);
    assert.equal(accepted + refused, 150);
    assert.equal(await read("t.value"), "x".repeat(accepted));
    checks.push("surface lane pressure admits whole text-bearing keystrokes exactly once");
    const copyController = controller;
    const legacyCopy = async () => {
      await copyController.handle({
        type: "input.key",
        surfaceId,
        action: "down",
        key: "c",
        code: "KeyC",
        modifiers: ["primary"],
      });
      await copyController.handle({
        type: "input.key",
        surfaceId,
        action: "up",
        key: "c",
        code: "KeyC",
        modifiers: ["primary"],
      });
    };
    if (!browser.clipboard) {
      await read("t.onkeydown=null;t.value='plain-copy-fixture';t.focus();t.select()");
      const before = messages.filter((message) => message.type === "clipboard.data").length;
      await legacyCopy();
      const publications = messages.filter((message) => message.type === "clipboard.data");
      assert.equal(publications.length, before + 1);
      assert.equal(publications.at(-1)?.text, "plain-copy-fixture");
      checks.push("production primary copy chord publishes a non-sensitive field exactly once");
    }
    await read(
      "window.password=document.createElement('input');password.type='password';document.body.append(password);password.value='sensitive-fixture';password.focus();password.select()",
    );
    await wait(() => editingContext()?.context.field?.sensitive === true);
    const sensitiveCopy = randomUUID();
    const clipboardEventsBefore = await read<number>(
      "events.filter(e=>e.type==='copy'||e.type==='cut').length",
    );
    if (browser.clipboard) {
      await controller.handle({ type: "clipboard.copy", surfaceId, operationId: sensitiveCopy });
      await wait(() =>
        messages.some(
          (message) =>
            message.type === "clipboard.result" &&
            message.operationId === sensitiveCopy &&
            message.outcome === "refused",
        ),
      );
      assert.equal(
        await read<number>("events.filter(e=>e.type==='copy'||e.type==='cut').length"),
        clipboardEventsBefore,
      );
      checks.push("sensitive copy refuses before any native clipboard event");
    } else {
      const before = messages.filter((message) => message.type === "clipboard.data").length;
      await legacyCopy();
      assert.equal(messages.filter((message) => message.type === "clipboard.data").length, before);
      checks.push("baseline clipboard never exports password values while v2 editing is active");
    }
    await read(
      "t.focus();t.value='terminal';t.setSelectionRange(8,8);window.interrupts=0;t.onkeydown=e=>{if(e.ctrlKey&&e.key==='c'){e.preventDefault();interrupts++}}",
    );
    await wait(() => editingContext()?.context.field?.sensitive === false);
    await controller.handle({
      type: "input.key",
      surfaceId,
      action: "down",
      key: "c",
      code: "KeyC",
      modifiers: ["control"],
    });
    await controller.handle({
      type: "input.key",
      surfaceId,
      action: "up",
      key: "c",
      code: "KeyC",
      modifiers: [],
    });
    assert.equal(await read("interrupts"), 1);
    assert.equal(await read("t.value"), "terminal");
    checks.push("terminal Control+C reaches the page without becoming copy");
    // Payment and sign-in frames are usually cross-site, so they run in their
    // own renderer, which the page's own debugger session never sees. A person
    // clicks into the frame's field before typing there.
    const frameUrl = new URL("/frame", url);
    frameUrl.hostname = frameUrl.hostname === "localhost" ? "127.0.0.1" : "localhost";
    const pageContext = editingContext()?.context.contextId;
    type FrameReport = { value: string; active: boolean; hasFocus: boolean; keys: number } | null;
    const frame = () => read<FrameReport>("frame");
    await read(
      `(()=>{window.frame=null;addEventListener('message',e=>{if(e.data&&e.data.frame)frame=e.data.frame});const f=document.createElement('iframe');f.id='cross';f.src=${JSON.stringify(frameUrl.href)};document.body.append(f)})()`,
    );
    await wait(async () => (await frame()) !== null);
    const field = await read<{ x: number; y: number }>(
      "(()=>{const r=cross.getBoundingClientRect();return {x:(r.x+40)/innerWidth,y:(r.y+25)/innerHeight}})()",
    );
    for (const action of ["down", "up"] as const)
      await controller.handle({
        type: "input.pointer",
        surfaceId,
        action,
        button: "left",
        clickCount: 1,
        x: field.x,
        y: field.y,
        viewportWidth: 800,
        viewportHeight: 600,
      });
    await delay(500);
    const afterClick = await frame();
    const document = await cdp
      .send<{ root: unknown }>("DOM.getDocument", { depth: -1, pierce: true })
      .catch(() => null);
    await controller.handle({
      type: "input.key",
      surfaceId,
      action: "down",
      key: "k",
      code: "KeyK",
      modifiers: [],
      text: "k",
    });
    await controller.handle({
      type: "input.key",
      surfaceId,
      action: "up",
      key: "k",
      code: "KeyK",
      modifiers: [],
    });
    await delay(500);
    await writeFile(
      path.join(evidence, "cross-site-frame.json"),
      JSON.stringify(
        {
          frameUrl: frameUrl.href,
          documentInPageSession: document && JSON.stringify(document).includes('"contentDocument"'),
          afterClick,
          afterKeystroke: await frame(),
          editing: editingContext(),
          errors: messages.filter((message) => message.type === "browser.error").slice(-3),
        },
        null,
        2,
      ),
    );
    await wait(async () => (await frame())?.active === true);
    await wait(
      () =>
        editingContext()?.type === "browser.editing" &&
        editingContext()?.context.contextId !== pageContext &&
        editingContext()?.context.field?.kind === "text",
    );
    const typed = (await frame())!.value;
    await controller.handle({
      type: "input.text",
      surfaceId,
      edit: {
        contextId: editingContext()!.context.contextId,
        before: typed,
        after: "",
        text: "OOPIF",
      },
    });
    // The verified text before the caret is what the edit replaces.
    await wait(async () => (await frame())?.value === "OOPIF");
    const dialogs = messages.length;
    const opened = () =>
      messages
        .slice(dialogs)
        .find((message) => message.type === "browser.dialog.changed" && message.dialog !== null);
    await read("cross.contentWindow.postMessage('alert','*')");
    await wait(() => opened() !== undefined);
    const dialog = opened();
    assert(dialog?.type === "browser.dialog.changed" && dialog.dialog);
    await controller.handle({
      type: "dialog.respond",
      surfaceId,
      dialogId: dialog.dialog.id,
      accept: true,
    });
    await wait(() => {
      const last = messages.findLast((message) => message.type === "browser.dialog.changed");
      return last?.type === "browser.dialog.changed" && last.dialog === null;
    });
    checks.push(
      "a cross-site frame's field has an editing context and takes verified text; its dialog still reaches the person",
    );
    await writeFile(path.join(evidence, "controller.json"), JSON.stringify(messages, null, 2));
    const shot = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
    await writeFile(path.join(evidence, "editing.png"), Buffer.from(shot.data, "base64"));
    await writeFile(
      path.join(evidence, "events.json"),
      JSON.stringify(await read("events"), null, 2),
    );
  } catch (error) {
    failure = error;
    await Promise.allSettled([
      read("events").then((events) =>
        writeFile(path.join(evidence, "events.json"), JSON.stringify(events, null, 2)),
      ),
      cdp
        .send<{ data: string }>("Page.captureScreenshot", { format: "png" })
        .then((shot) =>
          writeFile(path.join(evidence, "editing.png"), Buffer.from(shot.data, "base64")),
        ),
    ]);
  } finally {
    for (const close of [
      () => controller?.close(),
      () => observer.close(),
      () => signIns.close(),
      () => ledger.close(),
      () => releaseRendering?.(),
      () => router.close(),
    ]) {
      try {
        await close();
      } catch (error) {
        failure ??= error;
      }
    }
    await writeFile(
      path.join(evidence, "report.json"),
      JSON.stringify(
        {
          passed: !failure,
          ...(failure ? { failure: String(failure) } : {}),
          platform: process.platform,
          focus,
          checks,
          contexts,
        },
        null,
        2,
      ),
    );
    console.info(`Editing engine evidence: ${evidence}`);
  }
  if (failure) throw failure;
}
