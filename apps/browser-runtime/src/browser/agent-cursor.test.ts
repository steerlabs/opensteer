/**
 * Agent cursor journey: what `browser.activity` says about where an agent's
 * cursor is on a page, driven through the real BrowserController, router and
 * ledger in real Chromium with agent actor tokens.
 *
 * Ways it could fail, each a step below:
 *  A.1  A mouse click reports no pointer, or one away from the click.
 *  A.2  Typing, keys, a read-only script, a screenshot or a navigation drops
 *       the pointer, moves it, or labels it with a stale geometry revision.
 *  A.3  A script `el.click()` leaves the pointer where it was, or reports a
 *       point that a real click there would not land on the same element.
 *  A.4  A fillInput-style value set with input/change events does not move
 *       it to the input, or the value crosses the observer's boundary.
 *  A.5  A script click on an element outside the view moves it.
 *  A.6  A script click on a button inside an open shadow root reports the
 *       host, or one inside a closed shadow root leaks the inner button.
 *  A.7  A synthetic click the page dispatches on its own moves it.
 *  A.8  After the person resizes the page, a pointer-less activity loses the
 *       pointer or changes its normalised point.
 *  A.9  A second actor inherits the first actor's pointer, or moves it.
 *  A.10 A drag event reports no pointer.
 *  A.11 Script targets stop after a cross-origin navigation, or never start
 *       in a tab the agent created.
 *  A.12 At page scale 2 under mobile emulation with no screencast, the
 *       script target's normalised point lies off the element.
 *  A.13 A point won by a still-running script replaces a newer mouse click.
 *  A.14 A script that dispatches only pointerdown or mousedown does not move it.
 *  A.15 A renderer crash and reload leaves the page without script targets.
 *  A.16 A failed observer install, as a renderer swap fails one on Electron,
 *       never recovers.
 *
 * Every step records its command, the emitted activity and the expected and
 * observed pointer in `journey.json`, with viewport screenshots, under
 * OPENSTEER_AGENT_CURSOR_EVIDENCE_DIR (default: `opensteer-agent-cursor` in
 * the system temporary directory).
 */
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionCdpRouter, type CdpParameters } from "@opensteer/browser-core";
import {
  BrowserController,
  HostSignIns,
  SessionFiles,
  SurfaceLedger,
} from "@opensteer/browser-runtime-core";
import { FakeSink, validClaims } from "@opensteer/browser-runtime-core/test-support";
import type {
  BrowserRuntimeActivity,
  BrowserServerMessage,
  BrowserSurfaceId,
} from "@opensteer/protocol";
import { expect, it } from "vitest";
import {
  TestChromiumLauncher,
  cleanup,
  findChromium,
  waitForBrowserState,
  withBrowserTestSignal,
} from "./browser-test-lifecycle.js";

type Pointer = { x: number; y: number } | null;

interface CommandRecord {
  actor: string;
  method: string;
  parameters?: CdpParameters;
  surface: string;
  activity: {
    pointer: Pointer;
    geometryRevision: number;
    ledgerRevisionAtSend: number | null;
  } | null;
}

interface CheckRecord {
  label: string;
  expected: unknown;
  observed: unknown;
  pass: boolean;
}

interface StepRecord {
  id: string;
  name: string;
  commands: CommandRecord[];
  checks: CheckRecord[];
  evidence: Record<string, unknown>;
}

const executablePath = findChromium();
const viewport = { width: 800, height: 600 };

/** Fixture layout in CSS pixels; every expected point below is a centre of one of these. */
const cursorPage = `<!doctype html><meta charset="utf-8"><title>cursor</title>
<style>
html,body{margin:0}body{width:3000px;height:3000px;background:#fff}
.box{position:absolute;border:0;padding:0;margin:0;box-sizing:border-box}
#first{left:100px;top:150px;width:120px;height:60px;background:rgb(255,0,0)}
#second{left:300px;top:400px;width:100px;height:80px;background:rgb(0,0,255)}
#field{left:420px;top:120px;width:200px;height:40px;background:rgb(0,160,0)}
#far{left:100px;top:2000px;width:100px;height:50px;background:#333}
#open-host{left:560px;top:300px;width:160px;height:120px;background:rgb(200,200,0)}
#closed-host{left:40px;top:420px;width:160px;height:120px;background:rgb(0,200,200)}
#press{left:250px;top:250px;width:60px;height:60px;background:rgb(200,0,200)}
#down{left:650px;top:500px;width:80px;height:40px;background:rgb(120,60,0)}
</style>
<button id="first" class="box"></button><button id="second" class="box"></button>
<input id="field" class="box"><div id="far" class="box"></div>
<div id="open-host" class="box"></div><div id="closed-host" class="box"></div>
<div id="press" class="box"></div><div id="down" class="box"></div>
<script>
window.hits = [];
addEventListener("click", (event) => { if (event.isTrusted) hits.push(event.composedPath()[0].id || event.composedPath()[0].dataset.name); }, true);
const inner = '<button data-name="inner" style="position:absolute;left:0;top:0;width:60px;height:40px;border:0;padding:0;background:rgb(255,128,0)"></button>';
document.querySelector("#open-host").attachShadow({ mode: "open" }).innerHTML = inner;
const closed = document.querySelector("#closed-host").attachShadow({ mode: "closed" });
closed.innerHTML = inner;
window.closedButton = closed.querySelector("button");
</script>`;

const mobilePage = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=2"><title>mobile</title>
<style>html,body{margin:0}body{width:400px;height:1200px;background:#fff}
#target{position:absolute;left:250px;top:330px;width:60px;height:40px;border:0;padding:0;background:rgb(255,0,0)}</style>
<button id="target"></button>
<script>window.hits=[];addEventListener("click",(event)=>{if(event.isTrusted)hits.push([event.composedPath()[0].id||event.composedPath()[0].tagName,event.clientX,event.clientY])},true);</script>`;

const at = (x: number, y: number, size = viewport) => ({ x: x / size.width, y: y / size.height });
const centres = {
  first: at(160, 180),
  second: at(350, 440),
  field: at(520, 140),
  openInner: at(590, 320),
  closedHost: at(120, 480),
  press: at(280, 280),
  down: at(690, 520),
  drag: at(400, 300),
  mobileDesktop: at(280, 350),
};

function samePointer(observed: Pointer | undefined, expected: Pointer): boolean {
  if (observed === undefined) return false;
  if (observed === null || expected === null) return observed === expected;
  return Math.abs(observed.x - expected.x) < 1e-6 && Math.abs(observed.y - expected.y) < 1e-6;
}

it("reports each agent's cursor where a person's pointer would be", async () => {
  const evidence =
    process.env.OPENSTEER_AGENT_CURSOR_EVIDENCE_DIR ?? join(tmpdir(), "opensteer-agent-cursor");
  await rm(evidence, { recursive: true, force: true });
  await mkdir(evidence, { recursive: true });
  const steps: StepRecord[] = [];
  const order: { seq: number; kind: string; requestId?: string; payload?: string }[] = [];
  const payloads: string[] = [];
  let sequence = 0;
  let current: StepRecord | null = null;

  const site = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture").pathname;
    if (path !== "/cursor" && path !== "/mobile") return response.writeHead(404).end();
    return response
      .writeHead(200, { "content-type": "text/html", "cache-control": "no-store" })
      .end(path === "/cursor" ? cursorPage : mobilePage);
  });
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  cleanup.push(async () => {
    site.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      site.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = site.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address.");
  const origin = `http://127.0.0.1:${address.port}`;
  const crossOrigin = `http://localhost:${address.port}`;

  const claims = validClaims();
  const browser = await new TestChromiumLauncher({
    chromiumSandbox: false,
    executablePath,
    headless: true,
  }).launch({
    initialViewport: { devicePixelRatio: 1, ...viewport },
    partitionKey: `session:${claims.sessionId}`,
    sessionId: claims.sessionId,
    storage: { kind: "guest" },
  });
  cleanup.push(() => browser.close());
  const root = browser.context.pages()[0];
  if (!root) throw new Error("Missing root page.");
  const router = new SessionCdpRouter(browser.cdp);
  cleanup.push(async () => router.close());
  const files = new SessionFiles(join(tmpdir(), `opensteer-agent-cursor-${randomUUID()}`));
  const ledger = new SurfaceLedger(browser.context, {
    claimTarget: (targetId) => router.claimTarget(claims.sessionId, targetId),
    rootPages: [root],
    initialViewport: { devicePixelRatio: 1, ...viewport },
  });
  // A.16: the root page's first observer install fails before any agent acts.
  const rootPlatform = await root.cdp();
  const installs: { outcome: "pending" | "rejected" | "installed"; agentScriptsBefore: number }[] =
    [];
  let agentScripts = 0;
  let failInstall = true;
  const sendRoot = rootPlatform.send.bind(rootPlatform);
  rootPlatform.send = <Result = unknown>(method: string, parameters?: Record<string, unknown>) => {
    if (method !== "Page.addScriptToEvaluateOnNewDocument")
      return sendRoot<Result>(method, parameters);
    const attempt: (typeof installs)[number] = {
      outcome: "pending",
      agentScriptsBefore: agentScripts,
    };
    installs.push(attempt);
    if (failInstall) {
      failInstall = false;
      attempt.outcome = "rejected";
      return Promise.reject(new Error("Electron CDP renderer changed before command dispatch."));
    }
    return sendRoot<Result>(method, parameters).then((result) => {
      attempt.outcome = "installed";
      return result;
    });
  };
  const rootTarget = await root.targetId();
  router.registerSession(
    claims.sessionId,
    rootTarget,
    (id) => ledger.resolveTarget(id),
    files.root,
  );
  await ledger.start();
  cleanup.push(() => ledger.close());
  const sink = new FakeSink();
  const ledgerRevisionAtSend = new Map<BrowserServerMessage, number | null>();
  sink.sendServerImplementation = async (message) => {
    if (message.type === "browser.activity")
      ledgerRevisionAtSend.set(
        message,
        ledger.binding(message.surfaceId)?.surface.geometryRevision ?? null,
      );
    if (
      message.type === "browser.activity" ||
      message.type === "cdp.result" ||
      message.type === "cdp.error"
    )
      order.push({
        seq: ++sequence,
        kind: message.type,
        ...(message.type === "browser.activity" ? {} : { requestId: message.requestId }),
      });
  };
  const controller = new BrowserController({
    cdpRouter: router,
    claims,
    ledger,
    files,
    sink,
    replaceSiteCookies: (site, cookies, signal) =>
      browser.replaceSiteCookies(site, cookies, signal),
    signIns: new HostSignIns({ authority: undefined, runtimeId: "test" }),
  });
  await controller.start();
  cleanup.push(() => controller.close());

  const actors = { A: randomUUID(), B: randomUUID() } as const;
  /** Records every report crossing an observer binding, and when, relative to Runtime messages. */
  const observeBindings = (surfaceId: BrowserSurfaceId) => {
    ledger.binding(surfaceId)!.cdp.on("Runtime.bindingCalled", (value: unknown) => {
      const event = value as { name?: unknown; payload?: unknown };
      if (typeof event.name !== "string" || !event.name.startsWith("opensteerTarget_")) return;
      const payload = String(event.payload);
      payloads.push(payload);
      order.push({ seq: ++sequence, kind: "binding", payload });
    });
  };

  const command = async (
    actor: keyof typeof actors,
    method: string,
    parameters: CdpParameters | undefined,
    sessionId: string | undefined,
    surface: string,
  ) => {
    const requestId = randomUUID();
    const start = sink.messages.length;
    if (["Runtime.evaluate", "Runtime.callFunctionOn", "Runtime.awaitPromise"].includes(method))
      agentScripts += 1;
    await withBrowserTestSignal(
      controller.handle({
        type: "cdp.command",
        requestId,
        actorToken: actors[actor],
        command: {
          method,
          ...(parameters ? { parameters } : {}),
          ...(sessionId ? { sessionId } : {}),
        },
      }),
    );
    const index = sink.messages.findIndex(
      (message) =>
        (message.type === "cdp.result" || message.type === "cdp.error") &&
        message.requestId === requestId,
    );
    const reply = sink.messages[index];
    if (reply?.type === "cdp.error") throw new Error(`${method}: ${reply.error.message}`);
    if (reply?.type !== "cdp.result") throw new Error(`${method} was not answered.`);
    const activity = sink.messages
      .slice(start, index)
      .findLast(
        (message): message is BrowserRuntimeActivity =>
          message.type === "browser.activity" && message.actorToken === actors[actor],
      );
    current?.commands.push({
      actor,
      method,
      ...(parameters && method !== "Page.captureScreenshot" ? { parameters } : {}),
      surface,
      activity: activity
        ? {
            pointer: activity.pointer,
            geometryRevision: activity.geometryRevision,
            ledgerRevisionAtSend: ledgerRevisionAtSend.get(activity) ?? null,
          }
        : null,
    });
    return { requestId, result: reply.result, activity };
  };
  const value = (result: unknown) =>
    (result as { result?: { value?: unknown } } | undefined)?.result?.value;
  const check = (label: string, expected: unknown, observed: unknown, pass: boolean) => {
    current?.checks.push({ label, expected, observed, pass });
  };
  const checkPointer = (
    label: string,
    activity: BrowserRuntimeActivity | undefined,
    expected: Pointer,
  ) =>
    check(
      label,
      expected,
      activity ? activity.pointer : "no activity",
      samePointer(activity?.pointer, expected),
    );
  const step = async (id: string, name: string, body: (record: StepRecord) => Promise<void>) => {
    const record: StepRecord = { id, name, commands: [], checks: [], evidence: {} };
    steps.push(record);
    current = record;
    try {
      await body(record);
    } catch (error) {
      record.checks.push({
        label: "step completed",
        expected: "no error",
        observed: String(error),
        pass: false,
      });
      throw error;
    } finally {
      current = null;
    }
  };
  /** The binding report for `requestId` came in before its result, so it could be attributed. */
  const bindingBeforeResult = (requestId: string, bindingsBefore: number) => {
    const result = order.find((entry) => entry.requestId === requestId);
    const binding = order.filter((entry) => entry.kind === "binding")[bindingsBefore];
    check(
      "the observer's report arrived before the script's result",
      "binding seq < cdp.result seq",
      { binding: binding?.seq ?? null, result: result?.seq ?? null },
      binding !== undefined && result !== undefined && binding.seq < result.seq,
    );
  };
  /** Decodes a viewport screenshot, samples the pixel at a normalised point and marks it. */
  const markScreenshot = async (
    surfaceId: BrowserSurfaceId,
    png: string,
    point: Pointer,
    file: string,
  ) => {
    if (!point) throw new Error("No point to mark.");
    const platform = ledger.binding(surfaceId)!.cdp;
    const { frameTree } = await platform.send<{ frameTree: { frame: { id: string } } }>(
      "Page.getFrameTree",
    );
    const { executionContextId } = await platform.send<{ executionContextId: number }>(
      "Page.createIsolatedWorld",
      { frameId: frameTree.frame.id, worldName: "agent-cursor-evidence" },
    );
    const marked = await platform.send<{
      result: {
        value: {
          width: number;
          height: number;
          x: number;
          y: number;
          pixel: number[];
          image: string;
        };
      };
    }>("Runtime.evaluate", {
      contextId: executionContextId,
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const image = new Image(); image.src = "data:image/png;base64,${png}"; await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
        const x = Math.min(canvas.width - 1, Math.floor(${point.x} * canvas.width));
        const y = Math.min(canvas.height - 1, Math.floor(${point.y} * canvas.height));
        const pixel = [...context.getImageData(x, y, 1, 1).data];
        for (const [colour, width] of [["#fff", 5], ["#000", 2]]) {
          context.strokeStyle = colour; context.lineWidth = width; context.beginPath();
          context.moveTo(x - 18, y); context.lineTo(x - 5, y); context.moveTo(x + 5, y); context.lineTo(x + 18, y);
          context.moveTo(x, y - 18); context.lineTo(x, y - 5); context.moveTo(x, y + 5); context.lineTo(x, y + 18);
          context.stroke();
        }
        return { width: canvas.width, height: canvas.height, x, y, pixel, image: canvas.toDataURL("image/png") };
      })()`,
    });
    const { image, ...sample } = marked.result.value;
    await writeFile(join(evidence, file), Buffer.from(image.split(",")[1]!, "base64"));
    return { ...sample, file };
  };

  try {
    const main = ledger.surfaceIdForTarget(rootTarget)!;
    observeBindings(main);
    const attach = async (targetId: string) =>
      String(
        (
          (await command("A", "Target.attachToTarget", { targetId, flatten: true }, undefined, "-"))
            .result as { sessionId?: unknown }
        ).sessionId,
      );
    const mainSession = await attach(rootTarget);
    const on = (actor: keyof typeof actors, method: string, parameters?: CdpParameters) =>
      command(actor, method, parameters, mainSession, "main");
    const script = (
      actor: keyof typeof actors,
      expression: string,
      session = mainSession,
      surface = "main",
    ) =>
      command(
        actor,
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        session,
        surface,
      );
    const click = async (
      actor: keyof typeof actors,
      x: number,
      y: number,
      session = mainSession,
      surface = "main",
    ) => {
      const values = { button: "left", clickCount: 1, x, y };
      await command(
        actor,
        "Input.dispatchMouseEvent",
        { ...values, type: "mousePressed" },
        session,
        surface,
      );
      return command(
        actor,
        "Input.dispatchMouseEvent",
        { ...values, type: "mouseReleased" },
        session,
        surface,
      );
    };
    const load = async (url: string, session = mainSession, surface = "main") => {
      await command("A", "Page.navigate", { url }, session, surface);
      await waitForBrowserState(
        async () =>
          value(
            (
              await script(
                "A",
                `document.readyState === "complete" && location.href === ${JSON.stringify(url)}`,
                session,
                surface,
              )
            ).result,
          ) === true,
      );
    };
    const revision = (surfaceId: BrowserSurfaceId) =>
      ledger.binding(surfaceId)?.surface.geometryRevision ?? -1;
    const bindingCount = () => order.filter((entry) => entry.kind === "binding").length;
    await step(
      "A.16",
      "A failed observer install recovers on the agent's next script",
      async (record) => {
        check(
          "the page's first install failed before any agent script",
          [{ outcome: "rejected", agentScriptsBefore: 0 }],
          installs.slice(),
          installs.length === 1 && installs[0]?.outcome === "rejected" && agentScripts === 0,
        );
        await load(`${origin}/cursor`);
        await waitForBrowserState(() => installs.length > 1 && installs[1]?.outcome !== "pending");
        record.evidence.installs = installs.slice();
        check(
          "the agent's first script installed it again",
          { outcome: "installed", agentScriptsBefore: 1 },
          installs[1],
          installs.length === 2 &&
            installs[1]?.outcome === "installed" &&
            installs[1].agentScriptsBefore === 1,
        );
        const pressed = await script("A", `document.querySelector("#press").click()`);
        checkPointer("a later script click moves the pointer", pressed.activity, centres.press);
      },
    );

    await step("A.1", "A mouse click places the pointer at the click", async () => {
      const values = { button: "left", clickCount: 1, x: 160, y: 180 };
      const pressed = await on("A", "Input.dispatchMouseEvent", {
        ...values,
        type: "mousePressed",
      });
      const released = await on("A", "Input.dispatchMouseEvent", {
        ...values,
        type: "mouseReleased",
      });
      checkPointer("mousePressed activity", pressed.activity, centres.first);
      checkPointer("mouseReleased activity", released.activity, centres.first);
      const hits = value((await script("A", "hits.at(-1)")).result);
      check("the click landed on #first", "first", hits, hits === "first");
    });

    await step(
      "A.2",
      "Typing, keys, reads, screenshots and navigation keep the pointer",
      async (record) => {
        const before = revision(main);
        const kept = [
          await on("A", "Input.insertText", { text: "x" }),
          await on("A", "Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "a",
            code: "KeyA",
            windowsVirtualKeyCode: 65,
          }),
          await on("A", "Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "a",
            code: "KeyA",
            windowsVirtualKeyCode: 65,
          }),
          await script("A", "document.title"),
        ];
        const screenshot = await on("A", "Page.captureScreenshot", { format: "png" });
        await writeFile(
          join(evidence, "2-screenshot.png"),
          Buffer.from(String((screenshot.result as { data?: unknown }).data), "base64"),
        );
        kept.push(screenshot);
        for (const [index, entry] of kept.entries()) {
          checkPointer(
            `${record.commands[index]?.method ?? "command"} keeps the pointer`,
            entry.activity,
            centres.first,
          );
          check(
            "labelled with the current geometry revision",
            revision(main),
            entry.activity?.geometryRevision,
            entry.activity?.geometryRevision === revision(main),
          );
        }
        const navigated = await on("A", "Page.navigate", { url: `${origin}/cursor?step=2` });
        checkPointer("Page.navigate keeps the pointer", navigated.activity, centres.first);
        await waitForBrowserState(
          async () =>
            value(
              (
                await script(
                  "A",
                  `document.readyState === "complete" && location.search === "?step=2"`,
                )
              ).result,
            ) === true,
        );
        const read = await script("A", "document.title");
        const after = revision(main);
        record.evidence.geometryRevision = { before, after };
        check("navigation bumped the geometry revision", `> ${before}`, after, after > before);
        checkPointer(
          "a read after navigation keeps the normalised pointer",
          read.activity,
          centres.first,
        );
        check(
          "and labels it with the new revision",
          after,
          read.activity?.geometryRevision,
          read.activity?.geometryRevision === after,
        );
      },
    );

    await step(
      "A.3",
      "A script el.click() moves the pointer to the element's centre",
      async (record) => {
        const bindings = bindingCount();
        const clicked = await script("A", `document.querySelector("#second").click()`);
        checkPointer("el.click() activity", clicked.activity, centres.second);
        bindingBeforeResult(clicked.requestId, bindings);
        const point = clicked.activity?.pointer ?? null;
        const shot = await on("A", "Page.captureScreenshot", { format: "png" });
        record.evidence.screenshot = await markScreenshot(
          main,
          String((shot.result as { data?: unknown }).data),
          point,
          "3-script-click.png",
        );
        const pixel = (record.evidence.screenshot as { pixel: number[] }).pixel;
        check(
          "the screenshot pixel at the point is #second's blue",
          [0, 0, 255, 255],
          pixel,
          JSON.stringify(pixel) === "[0,0,255,255]",
        );
        const real = await click(
          "A",
          (point?.x ?? -1) * viewport.width,
          (point?.y ?? -1) * viewport.height,
        );
        const hit = value((await script("A", "hits.at(-1)")).result);
        check(
          "a real Input click at the denormalised point hits #second",
          "second",
          hit,
          hit === "second",
        );
        checkPointer("and the Input click reports the same pointer", real.activity, centres.second);
      },
    );

    await step(
      "A.4",
      "A fillInput-style value set moves the pointer to the input",
      async (record) => {
        const text = `private-${randomUUID()}`;
        const bindings = payloads.length;
        const filled = await script(
          "A",
          `(()=>{const e=document.querySelector(${JSON.stringify("#field")});if(!e)return false;e.focus();e.value="";e.value=${JSON.stringify(text)};e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));return true})()`,
        );
        checkPointer("fillInput activity", filled.activity, centres.field);
        const reports = payloads.slice(bindings);
        record.evidence.reports = reports;
        check(
          "only points crossed the binding",
          "payloads with exactly x, y and scale, no value or selector",
          reports,
          reports.length === 2 &&
            reports.every(
              (payload) =>
                !payload.includes(text) &&
                !payload.includes("field") &&
                JSON.stringify(Object.keys(JSON.parse(payload) as object).sort()) ===
                  '["scale","x","y"]',
            ),
        );
      },
    );

    await step("A.5", "A script click outside the view keeps the pointer", async () => {
      const bindings = bindingCount();
      const far = await script("A", `document.querySelector("#far").click()`);
      check(
        "the observer reported the off-view element",
        `> ${bindings}`,
        bindingCount(),
        bindingCount() > bindings,
      );
      checkPointer("off-view click activity", far.activity, centres.field);
    });

    await step("A.6", "Shadow roots: an open root's button, a closed root's host", async () => {
      const open = await script(
        "A",
        `document.querySelector("#open-host").shadowRoot.querySelector("button").click()`,
      );
      checkPointer("open shadow button activity", open.activity, centres.openInner);
      const closed = await script("A", "window.closedButton.click()");
      checkPointer(
        "closed shadow button activity reports the host",
        closed.activity,
        centres.closedHost,
      );
    });

    await step("A.7", "A synthetic click the page makes on its own keeps the pointer", async () => {
      const bindings = bindingCount();
      const scheduled = await script(
        "A",
        `setTimeout(() => document.querySelector("#press").click(), 100); true`,
      );
      checkPointer(
        "the scheduling script keeps the pointer",
        scheduled.activity,
        centres.closedHost,
      );
      await waitForBrowserState(() => bindingCount() > bindings);
      check(
        "the observer reported the page's own click",
        `> ${bindings}`,
        bindingCount(),
        bindingCount() > bindings,
      );
      const read = await script("A", "1");
      checkPointer("the next activity keeps the pointer", read.activity, centres.closedHost);
    });

    await step("A.14", "pointerdown or mousedown alone moves the pointer", async () => {
      const pointerdown = await script(
        "A",
        `document.querySelector("#press").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }))`,
      );
      checkPointer("pointerdown activity", pointerdown.activity, centres.press);
      const mousedown = await script(
        "A",
        `document.querySelector("#down").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))`,
      );
      checkPointer("mousedown activity", mousedown.activity, centres.down);
    });

    await step(
      "A.13",
      "A newer mouse click beats a point won by a script still running",
      async () => {
        const bindings = bindingCount();
        const running = script(
          "A",
          `(async () => { document.querySelector("#second").click(); await new Promise((resolve) => { window.releaseAgent = resolve; }); return true; })()`,
        );
        await waitForBrowserState(() => bindingCount() > bindings);
        const clicked = await click("A", 160, 180);
        checkPointer("the click during the script", clicked.activity, centres.first);
        await ledger
          .binding(main)!
          .cdp.send("Runtime.evaluate", { expression: "window.releaseAgent()" });
        const finished = await running;
        checkPointer("the script's own activity keeps the click", finished.activity, centres.first);
        const read = await script("A", "1");
        checkPointer("and so does the next", read.activity, centres.first);
      },
    );

    await step(
      "A.8",
      "The person's resize keeps the normalised pointer under a new revision",
      async (record) => {
        const before = revision(main);
        await controller.handle({
          type: "viewport.follow",
          surfaceId: main,
          width: 1000,
          height: 700,
        });
        await waitForBrowserState(() => revision(main) > before);
        const read = await script("A", "innerWidth");
        record.evidence.revisions = {
          before,
          after: revision(main),
          innerWidth: value(read.result),
        };
        checkPointer("a read after the resize", read.activity, centres.first);
        check(
          "under the resized page's revision",
          revision(main),
          read.activity?.geometryRevision,
          read.activity?.geometryRevision === revision(main) && revision(main) > before,
        );
        await controller.handle({ type: "viewport.follow", surfaceId: main, ...viewport });
        await waitForBrowserState(() => ledger.viewportOf(main)?.width === viewport.width);
      },
    );

    await step("A.9", "A second actor does not inherit the first actor's pointer", async () => {
      const read = await script("B", "1");
      checkPointer("actor B's first activity", read.activity, null);
      const clicked = await click("B", 350, 440);
      checkPointer("actor B's click", clicked.activity, centres.second);
      const first = await script("A", "1");
      checkPointer("actor A keeps its own pointer", first.activity, centres.first);
    });

    await step("A.10", "A drag event carries its point", async () => {
      const data = { items: [], dragOperationsMask: 1 };
      const enter = await on("A", "Input.dispatchDragEvent", {
        type: "dragEnter",
        x: 400,
        y: 300,
        data,
      });
      checkPointer("dragEnter activity", enter.activity, centres.drag);
      const cancel = await on("A", "Input.dispatchDragEvent", {
        type: "dragCancel",
        x: 400,
        y: 300,
        data,
      });
      checkPointer("dragCancel activity", cancel.activity, centres.drag);
    });

    await step("A.11", "Script targets after a cross-origin navigation", async () => {
      await load(`${crossOrigin}/cursor`);
      const clicked = await script("A", `document.querySelector("#second").click()`);
      checkPointer("el.click() on the other origin", clicked.activity, centres.second);
    });

    let created: { surfaceId: BrowserSurfaceId; session: string } | null = null;
    await step("A.11", "Script targets in a tab the agent created", async (record) => {
      const targetId = String(
        (
          (
            await command(
              "A",
              "Target.createTarget",
              { url: `${origin}/mobile` },
              undefined,
              "new tab",
            )
          ).result as {
            targetId?: unknown;
          }
        ).targetId,
      );
      await waitForBrowserState(() => ledger.surfaceIdForTarget(targetId) !== undefined);
      const surfaceId = ledger.surfaceIdForTarget(targetId)!;
      observeBindings(surfaceId);
      const session = await attach(targetId);
      created = { surfaceId, session };
      await waitForBrowserState(
        async () =>
          value(
            (
              await script(
                "A",
                `document.readyState === "complete" && location.pathname === "/mobile"`,
                session,
                "new tab",
              )
            ).result,
          ) === true,
      );
      record.evidence.viewport = ledger.viewportOf(surfaceId);
      const clicked = await script(
        "A",
        `document.querySelector("#target").click()`,
        session,
        "new tab",
      );
      checkPointer(
        "el.click() in the new tab",
        clicked.activity,
        at(280, 350, ledger.viewportOf(surfaceId) ?? viewport),
      );
    });

    await step(
      "A.12",
      "At page scale 2 with no screencast the point lies on the element",
      async (record) => {
        if (!created) throw new Error("The new tab is missing.");
        const { surfaceId, session } = created;
        await command(
          "A",
          "Emulation.setDeviceMetricsOverride",
          { width: 400, height: 600, deviceScaleFactor: 1, mobile: true },
          session,
          "new tab",
        );
        await waitForBrowserState(
          async () =>
            value((await script("A", "visualViewport.scale", session, "new tab")).result) === 2,
        );
        await script(
          "A",
          `document.querySelector("#target").scrollIntoView({ block: "center", inline: "center" })`,
          session,
          "new tab",
        );
        const view = value(
          (
            await script(
              "A",
              "({ scale: visualViewport.scale, offsetLeft: visualViewport.offsetLeft, offsetTop: visualViewport.offsetTop, scrollX, scrollY })",
              session,
              "new tab",
            )
          ).result,
        );
        record.evidence.visualViewport = view;
        record.evidence.ledgerPageScale = ledger.pageScaleOf(surfaceId);
        record.evidence.ledgerViewport = ledger.viewportOf(surfaceId);
        check(
          "the visual viewport is offset, so the offset correction is exercised",
          "offsetLeft > 0",
          view,
          typeof view === "object" &&
            view !== null &&
            (view as { offsetLeft: number }).offsetLeft > 0,
        );
        const clicked = await script(
          "A",
          `document.querySelector("#target").click()`,
          session,
          "new tab",
        );
        const point = clicked.activity?.pointer ?? null;
        check("the script click placed the pointer", "a point", point, point !== null);
        // The person's side, not an agent's: an agent click here would move the cursor itself.
        const platform = ledger.binding(surfaceId)!.cdp;
        const input = { x: ((point?.x ?? -1) * 400) / 2, y: ((point?.y ?? -1) * 600) / 2 };
        record.evidence.inputPoint = input;
        for (const type of ["mousePressed", "mouseReleased"])
          await platform.send("Input.dispatchMouseEvent", {
            type,
            button: "left",
            clickCount: 1,
            ...input,
          });
        const hit = value((await script("A", "hits.at(-1)", session, "new tab")).result);
        record.evidence.hit = hit;
        check(
          "a real Input click at the reported Input point hits #target",
          "target",
          hit,
          Array.isArray(hit) && hit[0] === "target",
        );
        const shot = await command(
          "A",
          "Page.captureScreenshot",
          { format: "png" },
          session,
          "new tab",
        );
        const marked = await markScreenshot(
          surfaceId,
          String((shot.result as { data?: unknown }).data),
          point,
          "12-mobile-scale-2.png",
        );
        record.evidence.screenshot = marked;
        check(
          "the screenshot pixel at the denormalised point is the element's red",
          [255, 0, 0, 255],
          marked.pixel,
          JSON.stringify(marked.pixel) === "[255,0,0,255]",
        );
        // Chromium's clipped capture re-applies emulation, which resets a pinch scale.
        record.evidence.scaleAfterScreenshot = value(
          (await script("A", "visualViewport.scale", session, "new tab")).result,
        );
        await command("A", "Emulation.clearDeviceMetricsOverride", {}, session, "new tab");
      },
    );

    await step("A.15", "Script targets after a renderer crash and reload", async (record) => {
      if (!created) throw new Error("The new tab is missing.");
      const { surfaceId, session } = created;
      const platform = ledger.binding(surfaceId)!.cdp;
      const crashed = new Promise<void>((resolve) => {
        const listener = () => {
          platform.off("Inspector.targetCrashed", listener);
          resolve();
        };
        platform.on("Inspector.targetCrashed", listener);
      });
      void platform.send("Page.crash").catch(() => undefined);
      await withBrowserTestSignal(crashed);
      await platform.send("Page.reload");
      await waitForBrowserState(
        async () =>
          value(
            (
              await script(
                "A",
                `document.readyState === "complete" && location.pathname === "/mobile"`,
                session,
                "new tab",
              )
            ).result,
          ) === true,
      );
      record.evidence.sameSurface = ledger.binding(surfaceId) !== null;
      const clicked = await script(
        "A",
        `document.querySelector("#target").click()`,
        session,
        "new tab",
      );
      checkPointer(
        "el.click() after the crash",
        clicked.activity,
        at(280, 350, ledger.viewportOf(surfaceId) ?? viewport),
      );
    });

    const failed = steps.flatMap((entry) =>
      entry.checks.filter((item) => !item.pass).map((item) => `${entry.id} ${item.label}`),
    );
    expect(failed).toEqual([]);
    expect(steps.map((entry) => entry.id)).toEqual([
      "A.16",
      "A.1",
      "A.2",
      "A.3",
      "A.4",
      "A.5",
      "A.6",
      "A.7",
      "A.14",
      "A.13",
      "A.8",
      "A.9",
      "A.10",
      "A.11",
      "A.11",
      "A.12",
      "A.15",
    ]);
  } finally {
    await writeFile(
      join(evidence, "journey.json"),
      JSON.stringify(
        {
          engine: executablePath,
          generatedAt: new Date().toISOString(),
          viewport,
          actors,
          steps,
          order,
          bindingPayloads: payloads,
          failed: steps
            .filter((entry) => entry.checks.some((item) => !item.pass))
            .map((entry) => entry.id),
        },
        null,
        2,
      ),
    );
  }
}, 120_000);
