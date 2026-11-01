import {
  BrowserController,
  BrowserRuntime,
  BrowserRuntimeServer,
  type LaunchedBrowser,
} from "@opensteer/browser-runtime-core";
import {
  FakeTicketVerifier,
  testSessionFilesRoot,
  validClaims,
} from "@opensteer/browser-runtime-core/test-support";
import {
  type BrowserClientMessage,
  BrowserClientMessageSchema,
  type BrowserServerMessage,
  BrowserServerMessageSchema,
  decodeBrowserFrameEnvelope,
  editingClipboardPartMaxBytes,
} from "@opensteer/protocol";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { z } from "zod";
import {
  TestChromiumLauncher,
  cleanup,
  findChromium,
  waitForBrowserState,
} from "./browser-test-lifecycle.js";

it.each(["editing", "editing-v2", "typing", "pressure", "undo", "undo-baseline"] as const)(
  "negotiates and performs verified editing over the real Chromium wire (%s)",
  async (mode) => {
    const evidence = join(
      process.env.OPENSTEER_EDITING_EVIDENCE_DIR ?? "/tmp/opensteer-editing",
      `${Date.now()}-${mode}`,
    );
    await mkdir(evidence, { recursive: true });
    const checks: string[] = [];
    let failure: string | undefined;
    let captureFailure: string | undefined;
    let capture: (() => Promise<void>) | undefined;
    const messages: BrowserServerMessage[] = [];
    let holdEditing: ((message: BrowserServerMessage) => boolean) | undefined;
    let releaseEditing: (() => void) | undefined;
    let releaseEditingTurn: ReturnType<typeof setImmediate> | undefined;
    let frameCount = 0;
    try {
      const executablePath = findChromium();
      expect(executablePath, "Chromium is required for this journey").toBeTruthy();
      const fixtureDirectory = process.env.OPENSTEER_EDITORS_FIXTURE_DIR;
      const editorAssets = fixtureDirectory
        ? {
            html: await readFile(join(fixtureDirectory, "index.html")),
            script: await readFile(join(fixtureDirectory, "probe.js")),
          }
        : null;
      let frameValue = "";
      const site = createServer((_request, response) => {
        response.writeHead(200, {
          "content-type": _request.url === "/editors/probe.js" ? "text/javascript" : "text/html",
        });
        if (_request.url === "/editors/") {
          response.end(editorAssets?.html);
          return;
        }
        if (_request.url === "/editors/probe.js") {
          response.end(editorAssets?.script);
          return;
        }
        if (_request.url?.startsWith("/record?")) {
          frameValue = new URL(_request.url, "http://fixture").searchParams.get("value") ?? "";
          response.end("ok");
          return;
        }
        if (_request.url === "/frame") {
          response.end(
            '<textarea id="inner">frame text</textarea><script>inner.oninput=()=>fetch("/record?value="+encodeURIComponent(inner.value));inner.focus()</script>',
          );
          return;
        }
        response.end(`<!doctype html><textarea id="t"></textarea><input id="second"><input id="p" type="password"><div id="rich" contenteditable>cross <b>node</b></div><script>
      window.events=[];for(const type of ['keydown','keypress','beforeinput','input','copy','cut','paste'])document.addEventListener(type,e=>events.push({type,key:e.key,code:e.code,keyCode:e.keyCode,location:e.location,repeat:e.repeat,alt:e.altKey,control:e.ctrlKey,meta:e.metaKey,shift:e.shiftKey,trusted:e.isTrusted,inputType:e.inputType}));
      t.addEventListener('keydown',e=>{if(e.key==='!')e.preventDefault()});t.focus();</script>`);
      });
      site.listen(0, "127.0.0.1");
      await once(site, "listening");
      cleanup.push(async () => {
        site.closeAllConnections();
        await new Promise<void>((resolve) => site.close(() => resolve()));
      });
      const address = site.address();
      if (!address || typeof address === "string") throw new Error("No fixture address");
      const editingVersion = mode === "undo-baseline" ? undefined : mode === "editing-v2" ? 2 : 1;
      const negotiated = editingVersion !== undefined;
      const claims = validClaims({
        ...(editingVersion ? { editingVersion } : {}),
        ...(editingVersion === 2 ? { clipboard: true } : {}),
        viewport: { width: 1280, height: 800 },
      });
      const verifier = new FakeTicketVerifier();
      verifier.setClaims("editing", claims);
      let browser: LaunchedBrowser | undefined;
      const launcher = new TestChromiumLauncher({
        executablePath: executablePath!,
        headless: true,
        chromiumSandbox: false,
      });
      const pressureControllers: BrowserController[] = [];
      if (mode === "pressure") {
        const start = BrowserController.prototype.start;
        vi.spyOn(BrowserController.prototype, "start").mockImplementation(function (
          this: BrowserController,
        ) {
          // Exercise saturation with a small configured queue; bulk accounting is unit-tested.
          expect(Object.hasOwn(this, "maxPendingCommands")).toBe(true);
          expect(Reflect.get(this, "maxPendingCommands")).toBe(128);
          pressureControllers.push(this);
          Object.defineProperty(this, "maxPendingCommands", { value: 4 });
          return start.call(this);
        });
      }
      const runtime = new BrowserRuntime({
        launcher: {
          launch: async (request) => {
            browser = await launcher.launch(request);
            return browser;
          },
        },
        runtimeId: claims.runtimeId,
        ticketVerifier: verifier,
        sessionFilesRoot: testSessionFilesRoot(),
      });
      const server = new BrowserRuntimeServer({ port: 0, runtime });
      cleanup.push(() => server.close());
      const listening = await server.start();
      const socket = new WebSocket(`ws://127.0.0.1:${listening.port}/v1/browser`, {
        headers: { authorization: "Bearer editing" },
      });
      cleanup.push(async () => {
        socket.terminate();
      });

      socket.on("message", (raw, binary) => {
        if (!binary) {
          const message = BrowserServerMessageSchema.parse(JSON.parse(raw.toString()));
          if (!holdEditing?.(message)) messages.push(message);
        } else {
          decodeBrowserFrameEnvelope(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer));
          frameCount++;
        }
      });
      await waitForBrowserState(() => messages.some((m) => m.type === "browser.snapshot"));
      const snapshot = messages.find((m) => m.type === "browser.snapshot");
      expect(snapshot).toMatchObject(
        negotiated ? { editingVersion, ...(editingVersion === 2 ? { clipboard: true } : {}) } : {},
      );
      if (!negotiated) expect(snapshot).not.toHaveProperty("editingVersion");
      checks.push("negotiation");
      const surfaceId = snapshot!.type === "browser.snapshot" ? snapshot!.surfaces[0]!.id : never();
      const consumerToken = randomUUID();
      const send = (message: BrowserClientMessage) =>
        socket.send(
          JSON.stringify(
            message.type === "input.key" ||
              message.type === "input.pointer" ||
              message.type === "input.command" ||
              message.type === "clipboard.copy" ||
              message.type === "clipboard.cut" ||
              message.type === "clipboard.paste-data"
              ? { ...message, consumerToken }
              : message,
          ),
        );
      const stroke = (
        key: Omit<
          Extract<BrowserClientMessage, { type: "input.key" }>,
          "type" | "action" | "surfaceId"
        >,
      ) => {
        send({ ...key, type: "input.key", action: "down", surfaceId });
        send({ ...key, type: "input.key", action: "up", surfaceId });
      };
      const navigate = async (url: string) => {
        const after = messages.length;
        send({ type: "navigation.go", surfaceId, url });
        // Page.navigate returns before commit; document reads need the loaded surface acknowledgement.
        await waitForBrowserState(() => {
          const latest = messages
            .slice(after)
            .findLast((message) => message.type === "browser.surfaces.changed");
          return (
            latest?.type === "browser.surfaces.changed" &&
            latest.surfaces.some(
              (surface) => surface.id === surfaceId && surface.url === url && !surface.loading,
            )
          );
        });
      };
      await navigate(`http://127.0.0.1:${address.port}/`);
      const page = browser!.context.pages()[0]!;
      const cdp = await page.cdp();
      const read = async <T>(expression: string): Promise<T> =>
        (
          await cdp.send<{ result: { value: T } }>("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise: true,
          })
        ).result.value;
      capture = async () => {
        const shot = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
        await writeFile(join(evidence, "editing.png"), Buffer.from(shot.data, "base64"));
        await writeFile(
          join(evidence, "events.json"),
          JSON.stringify(await read("events"), null, 2),
        );
        await writeFile(
          join(evidence, "models.json"),
          JSON.stringify(
            await read(
              "({focus:document.activeElement?.id,text:globalThis.t?.value,selection:[globalThis.t?.selectionStart,globalThis.t?.selectionEnd],editContext:globalThis.editContext?{text:editContext.text,start:editContext.selectionStart,end:editContext.selectionEnd}:null})",
            ),
            null,
            2,
          ),
        );
      };
      const agent = async (
        method: string,
        parameters?: Record<string, unknown>,
        sessionId?: string,
      ) => {
        const requestId = randomUUID();
        send({ type: "cdp.command", requestId, command: { method, parameters, sessionId } });
        await waitForBrowserState(() =>
          messages.some(
            (message) =>
              (message.type === "cdp.result" || message.type === "cdp.error") &&
              message.requestId === requestId,
          ),
        );
        const reply = messages.find(
          (message) =>
            (message.type === "cdp.result" || message.type === "cdp.error") &&
            message.requestId === requestId,
        );
        if (reply?.type !== "cdp.result") throw new Error(`${method}: ${JSON.stringify(reply)}`);
        return reply.result;
      };
      await waitForBrowserState(() => read<boolean>("!!document.querySelector('#t')"));
      if (negotiated)
        await waitForBrowserState(() =>
          messages.some((m) => m.type === "browser.editing" && m.context.field !== null),
        );
      if (mode === "undo" || mode === "undo-baseline") {
        for (const text of ["a", "b"]) {
          stroke({ key: text, code: `Key${text.toUpperCase()}`, modifiers: [], text });
          await waitForBrowserState(() =>
            read<boolean>(`t.value===${JSON.stringify(text === "a" ? "a" : "ab")}`),
          );
        }
        if (negotiated) send({ type: "input.command", surfaceId, command: "undo" });
        else
          stroke({
            key: "z",
            code: "KeyZ",
            modifiers: [process.platform === "darwin" ? "meta" : "control"],
          });
        await waitForBrowserState(() =>
          read<boolean>("events.some(e=>e.inputType==='historyUndo')"),
        );
        expect(await read("t.value"), "Undo must remove the native typed run").toBe("");
        checks.push("typing ab then one native Undo removes the run");
        await capture();
        capture = undefined;
        return;
      }
      const context = () => messages.filter((m) => m.type === "browser.editing").at(-1)!;
      if (mode === "editing" || mode === "editing-v2") {
        send({
          type: "input.key",
          surfaceId,
          action: "down",
          key: "a",
          code: "KeyQ",
          modifiers: [],
          text: "a",
        });
        send({ type: "input.key", surfaceId, action: "up", key: "a", code: "KeyQ", modifiers: [] });
        await waitForBrowserState(() => read<boolean>("t.value === 'a'"));
        expect(await read("events.filter(e=>e.type==='keydown').map(e=>e.key)")).toEqual(["a"]);
        checks.push("single text carrying key");
        const first = context();
        if (first.type !== "browser.editing") throw new Error("No editing context");
        send({
          type: "input.text",
          surfaceId,
          edit: { contextId: first.context.contextId, before: "a", after: "", text: "é" },
        });
        await waitForBrowserState(() => read<boolean>("t.value === 'é'"));
        checks.push("verified replacement");
        send({
          type: "input.text",
          surfaceId,
          edit: { contextId: first.context.contextId, before: "wrong", after: "", text: "bad" },
        });
        await waitForBrowserState(() => context().context.contextId !== first.context.contextId);
        expect(await read("t.value")).toBe("é");
        checks.push("stale rotates context");
        const current = context();
        send({
          type: "input.compose",
          surfaceId,
          composition: {
            contextId: current.context.contextId,
            text: "한",
            selectionStart: 1,
            selectionEnd: 1,
          },
        });
        await waitForBrowserState(() => read<boolean>("t.value === 'é한'"));
        send({
          type: "input.text",
          surfaceId,
          edit: { contextId: current.context.contextId, before: "", after: "", text: "한국" },
        });
        await waitForBrowserState(() => read<boolean>("t.value === 'é한국'"));
        checks.push("composition commits once");
        await read("t.value='';t.setSelectionRange(0,0)");
        const canceled = context().context.contextId;
        const keydowns = await read<number>("events.filter(e=>e.type==='keydown').length");
        send({
          type: "input.key",
          surfaceId,
          action: "down",
          key: "!",
          code: "Digit1",
          modifiers: ["shift"],
          text: "!",
        });
        send({
          type: "input.key",
          surfaceId,
          action: "up",
          key: "!",
          code: "Digit1",
          modifiers: ["shift"],
        });
        await waitForBrowserState(() =>
          read<boolean>(`events.filter(e=>e.type==='keydown').length===${keydowns + 1}`),
        );
        send({
          type: "input.text",
          surfaceId,
          edit: { contextId: canceled, before: "!", after: "", text: "accent" },
        });
        await waitForBrowserState(() => context().context.contextId !== canceled);
        expect(await read("t.value")).toBe("");
        checks.push("canceled keystroke then replacement refuses stale without mutation");
        await read("t.value='foo foo';t.setSelectionRange(7,7)");
        await read(
          "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
        );
        const moved = context().context.contextId;
        const staged: Extract<BrowserServerMessage, { type: "browser.editing" }>[] = [];
        holdEditing = (message) => {
          if (message.type !== "browser.editing") return false;
          staged.push(message);
          return true;
        };
        releaseEditing = () => {
          holdEditing = undefined;
          messages.push(...staged.splice(0));
        };
        const handle = BrowserController.prototype.handleRaw;
        let staleEditFinished = false;
        const staleEdit = vi
          .spyOn(BrowserController.prototype, "handleRaw")
          .mockImplementation(function (this: BrowserController, frame) {
            const result = handle.call(this, frame);
            const message = BrowserClientMessageSchema.parse(JSON.parse(frame.toString()));
            if (
              message.type === "input.text" &&
              message.edit.contextId === moved &&
              message.edit.text === "bad"
            )
              return result.then(() => {
                staleEditFinished = true;
              });
            return result;
          });
        await read("t.setSelectionRange(3,3)");
        send({
          type: "input.text",
          surfaceId,
          edit: { contextId: moved, before: "foo", after: "", text: "bad" },
        });
        await waitForBrowserState(
          () => staleEditFinished && staged.some((message) => message.context.contextId !== moved),
        );
        staleEdit.mockRestore();
        expect(await read("t.value")).toBe("foo foo");
        checks.push("same-field caret move invalidates verified replacement");
        const beforeComposition = context().context.contextId;
        await read("t.value='seed';t.setSelectionRange(4,4);t.inputMode='text'");
        // Deliver the previous caret acknowledgement after the next DOM setup.
        for (const message of staged.splice(0)) {
          if (message.context.field?.inputMode === "text") staged.push(message);
          else messages.push(message);
        }
        releaseEditingTurn = setImmediate(() => releaseEditing?.());
        await waitForBrowserState(
          () =>
            context().context.contextId !== beforeComposition &&
            context().context.field?.inputMode === "text",
        );
        const composing = context().context.contextId;
        send({
          type: "input.compose",
          surfaceId,
          composition: {
            contextId: composing,
            before: "seed",
            after: "",
            text: "仮",
            selectionStart: 1,
            selectionEnd: 1,
          },
        });
        await waitForBrowserState(() => read<boolean>("t.value==='仮'"));
        await read("second.value='untouched';second.focus()");
        await waitForBrowserState(() => context().context.contextId !== composing);
        const secondContext = context().context.contextId;
        send({
          type: "input.text",
          surfaceId,
          edit: { contextId: composing, before: "", after: "", text: "wrong field" },
        });
        await waitForBrowserState(() => context().context.contextId !== secondContext);
        expect(await read("second.value")).toBe("untouched");
        checks.push("first composition takes over verified text; focus change refuses old commit");
        await read(
          "t.value='az';t.focus();t.setSelectionRange(2,2);window.layoutBinding=e=>{if(!(e.metaKey||e.ctrlKey)||e.altKey||e.shiftKey)return;if(e.keyCode===65){e.preventDefault();t.select()}if(e.keyCode===90){e.preventDefault();document.execCommand('undo')}};t.addEventListener('keydown',layoutBinding)",
        );
        stroke({ key: "a", code: "KeyQ", modifiers: ["primary"] });
        await waitForBrowserState(() => read<boolean>("t.selectionStart===0&&t.selectionEnd===2"));
        expect(await read("events.filter(e=>e.type==='keydown').at(-1)")).toMatchObject({
          key: "a",
          code: "KeyQ",
          keyCode: 65,
          ...(process.platform === "darwin"
            ? { meta: true, control: false }
            : { control: true, meta: false }),
        });
        stroke({ key: "x", code: "KeyX", modifiers: [], text: "x" });
        await waitForBrowserState(() => read<boolean>("t.value==='x'"));
        stroke({ key: "z", code: "KeyY", modifiers: ["primary"] });
        await waitForBrowserState(() => read<boolean>("t.value==='az'"));
        expect(await read("events.filter(e=>e.type==='keydown').at(-1)")).toMatchObject({
          key: "z",
          code: "KeyY",
          keyCode: 90,
        });
        await read("t.removeEventListener('keydown',layoutBinding)");
        send({ type: "input.command", surfaceId, command: "redo" });
        await waitForBrowserState(() => read<boolean>("t.value==='x'"));
        expect(await read("events.filter(e=>e.type==='keydown').at(-1)")).toMatchObject(
          process.platform === "darwin"
            ? { key: "Z", meta: true, shift: true }
            : process.platform === "win32"
              ? { key: "y", control: true }
              : { key: "Z", control: true, shift: true },
        );
        checks.push(
          "AZERTY/QWERTZ page bindings and runtime-platform redo preserve model, selection and chord",
        );
        await read("t.value='';t.setSelectionRange(0,0)");
        stroke({ key: "@", code: "KeyQ", modifiers: [], text: "@" });
        stroke({ key: "€", code: "KeyE", modifiers: ["alt"], text: "€" });
        stroke({ key: "1", code: "Numpad1", modifiers: [], text: "1", location: 3 });
        await waitForBrowserState(() => read<boolean>("t.value==='@€1'"));
        expect(await read("events.filter(e=>e.type==='keydown').at(-1)")).toMatchObject({
          key: "1",
          code: "Numpad1",
          keyCode: 97,
          location: 3,
          repeat: false,
        });
        checks.push("AltGr, Option characters and numpad location insert once");
        await read(
          "window.commandCanceled=false;t.addEventListener('keydown',e=>{e.preventDefault();window.commandCanceled=true},{once:true});t.setSelectionRange(3,3)",
        );
        send({ type: "input.command", surfaceId, command: "moveToBeginningOfLine" });
        await waitForBrowserState(() => read<boolean>("commandCanceled"));
        expect(await read("t.selectionStart")).toBe(3);
        checks.push("page keydown cancellation suppresses the native editing command");
        await read(
          "window.terminalControlC=0;t.addEventListener('keydown',e=>{if(e.key==='c'&&e.ctrlKey){e.preventDefault();window.terminalControlC++}},{once:true})",
        );
        stroke({ key: "c", code: "KeyC", modifiers: ["control"] });
        await waitForBrowserState(() => read<boolean>("terminalControlC===1"));
        expect(await read("t.value")).toBe("@€1");
        checks.push("terminal Control+C reaches the page without a runtime copy operation");
        await read("t.value='é한국';t.focus()");
        await waitForBrowserState(
          () =>
            context().context.contextId !== secondContext &&
            context().context.field?.sensitive === false,
        );
        send({ type: "input.command", surfaceId, command: "selectAll" });
        await waitForBrowserState(() =>
          read<boolean>("t.selectionStart === 0 && t.selectionEnd === t.value.length"),
        );
        const operationId = randomUUID();
        send({ type: "clipboard.cut", surfaceId, operationId, consumerToken });
        await waitForBrowserState(() =>
          messages.some((m) => m.type === "clipboard.result" && m.operationId === operationId),
        );
        expect(
          messages.find((m) => m.type === "clipboard.result" && m.operationId === operationId),
        ).toMatchObject({ outcome: "cut", consumerToken });
        expect(await read("t.value")).toBe("");
        checks.push("native cut and attributed bytes");
        const pasteId = randomUUID();
        const pasteText = "native <paste> 한글";
        const pasteBytes = Buffer.from(pasteText);
        send({
          type: "clipboard.paste-data",
          surfaceId,
          operationId: pasteId,
          consumerToken,
          items: [{ type: "text/plain", size: pasteBytes.length }],
        });
        send({
          type: "input.key",
          surfaceId,
          action: "down",
          key: "Z",
          code: "KeyZ",
          modifiers: [],
          text: "Z",
        });
        send({
          type: "clipboard.part",
          part: { operationId: pasteId, index: 0, data: pasteBytes.toString("base64") },
        });
        send({ type: "input.key", surfaceId, action: "up", key: "Z", code: "KeyZ", modifiers: [] });
        await waitForBrowserState(() =>
          read<boolean>(`t.value === ${JSON.stringify(pasteText + "Z")}`),
        );
        expect(await read("events.filter(e=>e.type==='paste').every(e=>e.trusted)")).toBe(true);
        checks.push("paste parts retain lane position and native trusted paste");
        await read("p.focus();p.value='secret';p.select()");
        const sensitiveId = randomUUID();
        const copyEvents = await read<number>("events.filter(e=>e.type==='copy').length");
        send({ type: "clipboard.copy", surfaceId, operationId: sensitiveId, consumerToken });
        await waitForBrowserState(() =>
          messages.some((m) => m.type === "clipboard.result" && m.operationId === sensitiveId),
        );
        expect(
          messages.find((m) => m.type === "clipboard.result" && m.operationId === sensitiveId),
        ).toMatchObject({ outcome: "refused" });
        expect(await read("events.filter(e=>e.type==='copy').length")).toBe(copyEvents);
        checks.push("sensitive copy refused before events");
        await read(
          "rich.focus();const r=document.createRange();r.selectNodeContents(rich);r.collapse(false);getSelection().removeAllRanges();getSelection().addRange(r)",
        );
        await waitForBrowserState(() => context().context.field?.kind === "rich");
        send({
          type: "input.text",
          surfaceId,
          edit: {
            contextId: context().context.contextId,
            before: "cross node",
            after: "",
            text: "replacement",
          },
        });
        await waitForBrowserState(() => read<boolean>("rich.textContent === 'replacement'"));
        checks.push("cross-node contenteditable replacement");
        send({ type: "stream.subscribe", surfaceId });
        await waitForBrowserState(() => frameCount > 0);
        await read("rich.scrollIntoView()");
        const point = await read<{ x: number; y: number }>(
          "(()=>{const r=rich.getBoundingClientRect();return {x:(r.x+5)/innerWidth,y:(r.y+5)/innerHeight}})()",
        );
        send({
          type: "input.pointer",
          surfaceId,
          action: "down",
          button: "right",
          x: point.x,
          y: point.y,
          viewportWidth: 1280,
          viewportHeight: 800,
          consumerToken,
        });
        send({
          type: "input.pointer",
          surfaceId,
          action: "up",
          button: "right",
          x: point.x,
          y: point.y,
          viewportWidth: 1280,
          viewportHeight: 800,
          consumerToken,
        });
        await waitForBrowserState(() => messages.some((m) => m.type === "browser.contextmenu"));
        expect(messages.find((m) => m.type === "browser.contextmenu")).toMatchObject({
          consumerToken,
          editable: true,
        });
        checks.push("uncanceled page context menu attributed to clicking controller");
        const menus = messages.filter((m) => m.type === "browser.contextmenu").length;
        await read(
          "window.menuCanceled=false;window.addEventListener('contextmenu',event=>{event.preventDefault();window.menuCanceled=true},{once:true})",
        );
        for (const action of ["down", "up"] as const)
          send({
            type: "input.pointer",
            surfaceId,
            action,
            button: "right",
            x: point.x,
            y: point.y,
            viewportWidth: 1280,
            viewportHeight: 800,
          });
        await waitForBrowserState(() => read<boolean>("menuCanceled"));
        await cdp.send("Runtime.evaluate", {
          expression: "new Promise(resolve=>setTimeout(resolve,100))",
          awaitPromise: true,
        });
        expect(messages.filter((m) => m.type === "browser.contextmenu")).toHaveLength(menus);
        checks.push("page-owned window context menu suppresses the viewer menu");
        await read(
          `(()=>{const frame=document.createElement('iframe');frame.src='http://localhost:${address.port}/frame';document.body.append(frame)})()`,
        );
        await waitForBrowserState(() => context().context.field?.kind === "text");
        send({
          type: "input.text",
          surfaceId,
          edit: { contextId: context().context.contextId, before: "", after: "", text: "OOPIF" },
        });
        await waitForBrowserState(() => frameValue === "OOPIFframe text");
        checks.push("cross-origin frame editing context");
        const tooLargeId = randomUUID();
        socket.send(
          JSON.stringify({
            type: "clipboard.paste-data",
            surfaceId,
            operationId: tooLargeId,
            consumerToken,
            items: [{ type: "image/png", size: 16 * 1024 * 1024 + 1 }],
          }),
        );
        await waitForBrowserState(() =>
          messages.some(
            (m) =>
              m.type === "clipboard.result" &&
              m.operationId === tooLargeId &&
              m.outcome === "too-large",
          ),
        );
        expect(socket.readyState).toBe(WebSocket.OPEN);
        checks.push("oversize paste metadata refused without disconnect");
      }
      await read("t.value='';t.focus()");
      if (mode === "typing") {
        const fastStarted = performance.now();
        const repeatEventsAt = await read<number>("events.length");
        for (let count = 0; count < 500; count++) {
          send({
            type: "input.key",
            surfaceId,
            action: "down",
            key: "x",
            code: "KeyX",
            modifiers: [],
            text: "x",
            repeat: count > 0,
          });
          if (count % 16 === 15 || count === 499)
            await waitForBrowserState(() => read<boolean>(`t.value.length===${count + 1}`));
        }
        send({ type: "input.key", surfaceId, action: "up", key: "x", code: "KeyX", modifiers: [] });
        expect(await read("t.value")).toBe("x".repeat(500));
        expect(
          await read(
            `events.slice(${repeatEventsAt}).filter(e=>e.type==='keydown').map(e=>e.repeat)`,
          ),
        ).toEqual([false, ...Array<boolean>(499).fill(true)]);
        await writeFile(
          join(evidence, "fast-typing.json"),
          JSON.stringify(
            { characters: 500, elapsedMs: performance.now() - fastStarted, burstSize: 16 },
            null,
            2,
          ),
        );
        checks.push("500 characters and repeat flag exact through attributed activation scopes");
      }
      if (mode === "editing" || mode === "editing-v2") {
        const attached = (await agent("Target.attachToTarget", {
          targetId: await page.targetId(),
          flatten: true,
        })) as { sessionId: string };
        const writtenBefore = messages.filter((m) => m.type === "clipboard.written").length;
        await agent(
          "Runtime.evaluate",
          {
            expression: "t.value='agent secret';t.select()",
            returnByValue: true,
          },
          attached.sessionId,
        );
        for (const command of ["copy", "cut"]) {
          await agent(
            "Input.dispatchKeyEvent",
            {
              type: "rawKeyDown",
              key: command === "copy" ? "c" : "x",
              code: command === "copy" ? "KeyC" : "KeyX",
              modifiers: process.platform === "darwin" ? 4 : 2,
              commands: [command],
            },
            attached.sessionId,
          );
          await agent(
            "Input.dispatchKeyEvent",
            {
              type: "keyUp",
              key: command === "copy" ? "c" : "x",
              code: command === "copy" ? "KeyC" : "KeyX",
            },
            attached.sessionId,
          );
        }
        expect(await read("t.value")).toBe("");
        await agent(
          "Runtime.evaluate",
          {
            expression: "navigator.clipboard.writeText('forged activation')",
            awaitPromise: true,
            returnByValue: true,
            userGesture: true,
          },
          attached.sessionId,
        );
        send({
          type: "input.key",
          surfaceId,
          action: "down",
          key: "Escape",
          code: "Escape",
          modifiers: [],
        });
        send({
          type: "input.key",
          surfaceId,
          action: "up",
          key: "Escape",
          code: "Escape",
          modifiers: [],
        });
        const emptyCopyId = randomUUID();
        send({ type: "clipboard.copy", surfaceId, operationId: emptyCopyId });
        await waitForBrowserState(() =>
          messages.some((m) => m.type === "clipboard.result" && m.operationId === emptyCopyId),
        );
        expect(
          messages.find((m) => m.type === "clipboard.result" && m.operationId === emptyCopyId),
        ).toMatchObject({ outcome: "empty" });
        expect(messages.filter((m) => m.type === "clipboard.written")).toHaveLength(writtenBefore);
        checks.push(
          "agent copy/cut and forged activation never publish or survive into a person scope",
        );
        await read(
          "window.personKey=false;const handler=()=>{window.personKey=true;window.releaseCopy=()=>navigator.clipboard.writeText('agent interleaved')};t.addEventListener('keydown',handler,{once:true})",
        );
        send({
          type: "input.key",
          surfaceId,
          action: "down",
          key: "ArrowLeft",
          code: "ArrowLeft",
          modifiers: [],
        });
        send({
          type: "input.key",
          surfaceId,
          action: "up",
          key: "ArrowLeft",
          code: "ArrowLeft",
          modifiers: [],
        });
        await waitForBrowserState(() => read<boolean>("personKey"));
        await agent(
          "Runtime.evaluate",
          {
            expression: "releaseCopy()",
            awaitPromise: true,
            returnByValue: true,
            userGesture: true,
          },
          attached.sessionId,
        );
        const interleavedCopy = randomUUID();
        send({ type: "clipboard.copy", surfaceId, operationId: interleavedCopy });
        await waitForBrowserState(() =>
          messages.some((m) => m.type === "clipboard.result" && m.operationId === interleavedCopy),
        );
        expect(messages.filter((m) => m.type === "clipboard.written")).toHaveLength(writtenBefore);
        checks.push("agent command during a person activation voids page-write attribution");
      }
      const pasteData = async (items: { type: string; name?: string; bytes: Buffer }[]) => {
        const operationId = randomUUID();
        const bytes = Buffer.concat(items.map((item) => item.bytes));
        send({
          type: "clipboard.paste-data",
          surfaceId,
          operationId,
          items: items.map((item) => ({
            type: item.type,
            size: item.bytes.length,
            ...(item.name ? { name: item.name } : {}),
          })),
        });
        for (let index = 0; index < Math.max(1, Math.ceil(bytes.length / (512 * 1024))); index++)
          send({
            type: "clipboard.part",
            part: {
              operationId,
              index,
              data: bytes.subarray(index * 512 * 1024, (index + 1) * 512 * 1024).toString("base64"),
            },
          });
        await waitForBrowserState(() =>
          messages.some((m) => m.type === "clipboard.result" && m.operationId === operationId),
        );
        return messages.find(
          (m) => m.type === "clipboard.result" && m.operationId === operationId,
        )!;
      };
      if (mode === "editing" || mode === "editing-v2") {
        const shadowContext = context().context.contextId;
        await read(
          "window.shadowHost=document.createElement('div');document.body.append(shadowHost);window.shadowField=document.createElement('textarea');shadowField.value='shadow';shadowHost.attachShadow({mode:'open'}).append(shadowField);shadowField.focus();shadowField.setSelectionRange(6,6)",
        );
        await waitForBrowserState(
          () => context().context.field !== null && context().context.contextId !== shadowContext,
        );
        send({
          type: "input.text",
          surfaceId,
          edit: {
            contextId: context().context.contextId,
            before: "shadow",
            after: "",
            text: "verified",
          },
        });
        await waitForBrowserState(() => read<boolean>("shadowField.value==='verified'"));
        expect(
          await pasteData([{ type: "text/plain", bytes: Buffer.from(" paste") }]),
        ).toMatchObject({
          outcome: "pasted",
        });
        expect(await read("shadowField.value")).toBe("verified paste");
        checks.push("shadow-root text control verifies a replacement and receives native paste");
        const frameContext = context().context.contextId;
        await read(
          "window.sameFrame=document.createElement('iframe');sameFrame.srcdoc='<textarea id=field>frame</textarea><script>field.focus();field.setSelectionRange(5,5)</script>';document.body.append(sameFrame)",
        );
        await waitForBrowserState(
          () => context().context.field !== null && context().context.contextId !== frameContext,
        );
        send({
          type: "input.text",
          surfaceId,
          edit: {
            contextId: context().context.contextId,
            before: "frame",
            after: "",
            text: "same-process",
          },
        });
        await waitForBrowserState(() =>
          read<boolean>(
            "sameFrame.contentDocument.querySelector('textarea').value==='same-process'",
          ),
        );
        checks.push("same-origin frame verifies its own text through the page debugger");
        const ecContext = context().context.contextId;
        await read(
          "window.editContext=new EditContext({text:'seed',selectionStart:4,selectionEnd:4});window.ecElement=document.createElement('div');ecElement.tabIndex=0;ecElement.editContext=editContext;document.body.append(ecElement);ecElement.focus()",
        );
        await waitForBrowserState(
          () => context().context.field !== null && context().context.contextId !== ecContext,
        );
        send({
          type: "input.text",
          surfaceId,
          edit: { contextId: context().context.contextId, before: "seed", after: "", text: "the" },
        });
        await waitForBrowserState(() => read<boolean>("editContext.text==='the'"));
        send({
          type: "input.text",
          surfaceId,
          edit: { contextId: context().context.contextId, before: "the", after: "", text: "" },
        });
        await waitForBrowserState(() => read<boolean>("editContext.text===''"));
        expect(await read("editContext.selectionStart")).toBe(0);
        checks.push("generic EditContext verified replacement and native range deletion");
        send({
          type: "input.compose",
          surfaceId,
          composition: {
            contextId: context().context.contextId,
            text: "한",
            selectionStart: 1,
            selectionEnd: 1,
          },
        });
        await waitForBrowserState(() => read<boolean>("editContext.text==='한'"));
        send({
          type: "input.text",
          surfaceId,
          edit: { contextId: context().context.contextId, before: "", after: "", text: "한국" },
        });
        await waitForBrowserState(() => read<boolean>("editContext.text==='한국'"));
        checks.push("generic EditContext composition commits once");
        await read(
          "rich.innerHTML='<b>Bold</b> text';rich.focus();const range=document.createRange();range.selectNodeContents(rich);getSelection().removeAllRanges();getSelection().addRange(range)",
        );
        const htmlCopy = randomUUID();
        send({ type: "clipboard.copy", surfaceId, operationId: htmlCopy });
        await waitForBrowserState(() =>
          messages.some((m) => m.type === "clipboard.result" && m.operationId === htmlCopy),
        );
        const copied = messages.find(
          (m) => m.type === "clipboard.result" && m.operationId === htmlCopy,
        );
        if (copied?.type !== "clipboard.result") throw new Error("No native rich copy result.");
        expect(copied).toMatchObject({ outcome: "copied" });
        const representations = copied.items ?? [];
        expect(representations.map((item) => item.type)).toEqual(
          expect.arrayContaining(["text/plain", "text/html"]),
        );
        const copiedParts = () =>
          messages.filter(
            (m): m is Extract<BrowserServerMessage, { type: "clipboard.part" }> =>
              m.type === "clipboard.part" && m.part.operationId === htmlCopy,
          );
        await waitForBrowserState(
          () =>
            copiedParts().reduce(
              (size, part) => size + Buffer.from(part.part.data, "base64").length,
              0,
            ) === representations.reduce((size, item) => size + item.size, 0),
        );
        const copiedBytes = Buffer.concat(
          copiedParts().map((part) => Buffer.from(part.part.data, "base64")),
        );
        let offset = 0;
        for (const item of representations) {
          const data = copiedBytes.subarray(offset, offset + item.size).toString();
          if (item.type === "text/plain") expect(data).toBe("Bold text");
          else
            expect(
              await read(
                `(()=>{const body=new DOMParser().parseFromString(${JSON.stringify(data)},'text/html').body;return{bold:body.querySelector('b')?.textContent,text:body.textContent.replaceAll('\\u00a0',' ')}})()`,
              ),
            ).toEqual({ bold: "Bold", text: "Bold text" });
          offset += item.size;
        }
        await read("rich.innerHTML='';rich.focus()");
        expect(
          await pasteData([
            { type: "text/plain", bytes: Buffer.from("pasted") },
            { type: "text/html", bytes: Buffer.from("<b>pasted</b>") },
          ]),
        ).toMatchObject({ outcome: "pasted" });
        expect(await read("rich.textContent")).toBe("pasted");
        expect(await read("!!rich.querySelector('b')")).toBe(true);
        checks.push("native rich copy returns text and HTML; HTML paste preserves formatting");
        const authorityContext = context().context.contextId;
        await read("t.value='owner';t.focus();t.setSelectionRange(5,5)");
        await waitForBrowserState(
          () =>
            context().context.field?.kind === "text" &&
            context().context.contextId !== authorityContext,
        );
        const owner = randomUUID(),
          contender = randomUUID();
        send({
          type: "input.key",
          surfaceId,
          producerId: owner,
          action: "down",
          key: "Shift",
          code: "ShiftLeft",
          modifiers: ["shift"],
        });
        const blockedContext = context().context.contextId;
        send({
          type: "input.text",
          surfaceId,
          producerId: contender,
          edit: { contextId: blockedContext, before: "", after: "", text: "blocked" },
        });
        send({
          type: "input.compose",
          surfaceId,
          producerId: contender,
          composition: {
            contextId: blockedContext,
            text: "bad",
            selectionStart: 3,
            selectionEnd: 3,
          },
        });
        send({
          type: "input.command",
          surfaceId,
          producerId: contender,
          command: "deleteBackward",
        });
        send({
          type: "clipboard.cut",
          surfaceId,
          producerId: contender,
          operationId: randomUUID(),
        });
        await waitForBrowserState(
          () =>
            messages.filter(
              (m) =>
                m.type === "browser.error" &&
                m.producerId === contender &&
                m.error.reason === "browser-input-owner-conflict",
            ).length === 4,
        );
        expect(await read("t.value")).toBe("owner");
        send({
          type: "input.key",
          surfaceId,
          producerId: owner,
          action: "up",
          key: "Shift",
          code: "ShiftLeft",
          modifiers: [],
        });
        send({
          type: "input.text",
          surfaceId,
          producerId: contender,
          edit: { contextId: blockedContext, before: "", after: "", text: " accepted" },
        });
        await waitForBrowserState(() => read<boolean>("t.value==='owner accepted'"));
        checks.push(
          "text, composition, command and clipboard refuse another producer's held key, then admit after release",
        );
      }
      if (mode === "pressure") {
        await read(
          "t.value='';t.setSelectionRange(0,0);window.pressureKeys=0;t.addEventListener('keydown',e=>{if(e.key==='x')window.pressureKeys++})",
        );
        const pressureProducer = randomUUID(),
          pressurePaste = randomUUID();
        send({
          type: "clipboard.paste-data",
          surfaceId,
          producerId: pressureProducer,
          operationId: pressurePaste,
          items: [{ type: "text/plain", size: 1 }],
          inputSequence: 1,
        });
        const sentKeys = 6;
        for (let count = 0; count < sentKeys; count++)
          send({
            type: "input.key",
            surfaceId,
            producerId: pressureProducer,
            inputSequence: count + 2,
            action: "down",
            key: "x",
            code: "KeyX",
            modifiers: [],
            text: "x",
            repeat: count > 0,
          });
        send({
          type: "clipboard.part",
          producerId: pressureProducer,
          part: { operationId: pressurePaste, index: 0, data: Buffer.from("p").toString("base64") },
        });
        send({
          type: "input.key",
          surfaceId,
          producerId: pressureProducer,
          action: "up",
          key: "x",
          code: "KeyX",
          modifiers: [],
        });
        const overloads = () =>
          messages.filter(
            (m) =>
              m.type === "browser.error" &&
              m.producerId === pressureProducer &&
              m.error.reason === "browser-input-overload",
          );
        // The final key-up is a lane barrier, after the paste and every admitted key.
        await waitForBrowserState(() => {
          const diagnostic = pressureControllers[0]
            ?.diagnostics()
            .find((entry) => entry.surfaceId === surfaceId);
          const completed = diagnostic?.input.filter(
            (entry) => entry.producerId === pressureProducer && entry.outcome === "completed",
          );
          // The paste and final key-up each contribute one completed entry.
          return (
            diagnostic?.heldKeys === 0 &&
            (completed?.length ?? 0) + overloads().length === sentKeys + 2 &&
            completed?.at(-1)?.pending === 0
          );
        });
        const [acceptedKeys, value] = z
          .tuple([z.number().int().nonnegative(), z.string()])
          .parse(JSON.parse(await read<string>("JSON.stringify([pressureKeys, t.value])")));
        expect(overloads().length).toBeGreaterThan(0);
        expect(acceptedKeys).toBeGreaterThan(0);
        expect(acceptedKeys + overloads().length).toBe(sentKeys);
        expect(value).toBe("p" + "x".repeat(acceptedKeys));
        checks.push(
          "lane pressure refuses whole keystrokes; each admitted key and its text apply exactly once",
        );
      }
      if (mode === "editing" || mode === "editing-v2") {
        await read("t.value='';t.focus()");
        expect(
          await pasteData([{ type: "text/plain", bytes: Buffer.from("字".repeat(400000)) }]),
        ).toMatchObject({ outcome: "pasted" });
        expect(await read("t.value.length")).toBe(400000);
        checks.push("400k CJK native paste in bounded parts");
        await read(
          "t.onpaste=e=>{window.pastedImage={trusted:e.isTrusted,type:e.clipboardData.files[0]?.type,size:e.clipboardData.files[0]?.size};window.pastedImageBytes=e.clipboardData.files[0]?.arrayBuffer().then(buffer=>{let binary='';const bytes=new Uint8Array(buffer);for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(binary)});e.preventDefault()}",
        );
        const png = Buffer.from(
          await read<string>(
            "(()=>{const c=document.createElement('canvas');c.width=640;c.height=640;const x=c.getContext('2d'),d=x.createImageData(c.width,c.height);let n=123456789;for(let i=0;i<d.data.length;i++){n^=n<<13;n^=n>>>17;n^=n<<5;d.data[i]=n&255;}x.putImageData(d,0,0);return c.toDataURL('image/png').split(',')[1]})()",
          ),
          "base64",
        );
        // Several parts prove the native paste reassembles one trusted file;
        // the cap's edge is ClipboardParts' unit, where its size costs nothing.
        expect(png.length).toBeGreaterThan(3 * editingClipboardPartMaxBytes);
        expect(
          await pasteData([{ type: "image/png", name: "image.png", bytes: png }]),
        ).toMatchObject({
          outcome: "pasted",
        });
        expect(await read("pastedImage")).toEqual({
          trusted: true,
          type: "image/png",
          size: png.length,
        });
        expect(await read("pastedImageBytes")).toBe(png.toString("base64"));
        checks.push("multi-part PNG native file paste in bounded parts");
      }
      if (editorAssets && mode === "pressure") {
        await navigate(`http://127.0.0.1:${address.port}/editors/`);
        await waitForBrowserState(() =>
          read<boolean>("globalThis.ready === true && !!globalThis.editors?.draft"),
        );
        const editorResults: Record<string, unknown>[] = [];
        for (const name of [
          "codemirror",
          "prosemirror",
          "monaco-false",
          "monaco-true",
          "lexical",
          "draft",
          "controlled",
          "xterm",
          "keypress-canvas",
        ]) {
          await read(
            `editors[${JSON.stringify(name)}].clear();editors[${JSON.stringify(name)}].focus();events=[]`,
          );
          await waitForBrowserState(() =>
            read<boolean>(`editors[${JSON.stringify(name)}].text()===''`),
          );
          for (const text of ["a", "A", " ", "@", "€"]) {
            const code =
              text === " " ? "Space" : text === "@" ? "Digit2" : text === "€" ? "KeyE" : "KeyA";
            send({
              type: "input.key",
              surfaceId,
              action: "down",
              key: text,
              code,
              modifiers: [],
              text,
            });
            send({ type: "input.key", surfaceId, action: "up", key: text, code, modifiers: [] });
          }
          await waitForBrowserState(() =>
            read<boolean>(`editors[${JSON.stringify(name)}].text()==='aA @€'`),
          );
          const facts = await read<Record<string, unknown>>(
            `({model:editors[${JSON.stringify(name)}].text(),selection:document.activeElement?.selectionStart??getSelection()?.toString().length,events:events.map(({type,key,inputType,isComposing})=>({type,key,inputType,isComposing}))})`,
          );
          expect(
            (facts.events as { type: string }[]).filter((e) => e.type === "keydown"),
          ).toHaveLength(5);
          editorResults.push({ name, ...facts });
        }
        for (const name of ["codemirror", "prosemirror"]) {
          await read(
            `editors[${JSON.stringify(name)}].clear();editors[${JSON.stringify(name)}].focus();document.activeElement.addEventListener('keydown',e=>{if(e.key==='a'){e.preventDefault();editors[${JSON.stringify(name)}].insertA()}},{once:true})`,
          );
          send({
            type: "input.key",
            surfaceId,
            action: "down",
            key: "a",
            code: "KeyA",
            modifiers: [],
            text: "a",
          });
          send({
            type: "input.key",
            surfaceId,
            action: "up",
            key: "a",
            code: "KeyA",
            modifiers: [],
          });
          await waitForBrowserState(() =>
            read<boolean>(`editors[${JSON.stringify(name)}].text()==='a'`),
          );
          editorResults.push({
            name,
            customBinding: await read(`editors[${JSON.stringify(name)}].text()`),
          });
        }
        await writeFile(join(evidence, "editors.json"), JSON.stringify(editorResults, null, 2));
        checks.push(
          "editor models and key events: CodeMirror, ProseMirror, both Monaco modes, Lexical, Draft, controlled React, xterm and keypress canvas; custom bindings exactly once",
        );
      }
    } catch (error) {
      failure = String(error);
      throw error;
    } finally {
      clearImmediate(releaseEditingTurn);
      releaseEditing?.();
      await writeFile(join(evidence, "wire.json"), JSON.stringify(messages, null, 2));
      try {
        await capture?.();
      } catch (error) {
        captureFailure = String(error);
      }
      await writeFile(
        join(evidence, "report.json"),
        JSON.stringify(
          { mode, checks, failure, captureFailure, passed: !failure && !captureFailure },
          null,
          2,
        ),
      );
      console.info(`Editing evidence: ${evidence}`);
    }
    if (captureFailure) throw new Error(captureFailure);
  },
  60_000,
);

function never(): never {
  throw new Error("No snapshot");
}
