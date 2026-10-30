import { sendAsAgent } from "./browser-harness.test-support.js";
import { describe, expect } from "vitest";
import {
  assertDialogExitOrder,
  type DialogExitObservation,
} from "./dialog-exit-order.test-support.js";
import { waitForBrowserState } from "./browser-test-lifecycle.js";
import {
  acceptance,
  traceSettled,
  expectGroupsReleasedBeforeDetach,
} from "./harness-actions.test-support.js";

describe("Browser Harness element actions / real hosted Chromium", () => {
  acceptance(
    "13",
    "dialogs interrupt each input phase promptly and preserve answer identity",
    async (kit, report) => {
      for (const phase of ["down", "click", "key"]) {
        const out = await kit.run(
          `const since=Date.now();
const error=await fails(()=>${phase === "key" ? "page.locator('#key').press('Enter')" : `page.locator('#${phase}').click()`},/dialog/i);
assert(error.name==='DialogOpenedError','typed dialog error');
assert(error.dialog?.id&&error.dialog.type==='confirm'&&error.dialog.message==='${phase} confirm','dialog identity');
await cdp('Page.handleJavaScriptDialog',{accept:true});
console.log(JSON.stringify({error,ms:Date.now()-since}));`,
          { timeoutMs: 5000 },
        );
        expect(out.elapsedMs).toBeLessThan(5000);
        report.phases ??= [] as unknown[];
        (report.phases as unknown[]).push(JSON.parse(out.stdout));
      }
      const interrupted = await kit.run(
        `const error=await fails(()=>page.locator('#click').click(),/dialog/i);console.log(JSON.stringify(error));`,
        { timeoutMs: 5000 },
      );
      expect(interrupted.elapsedMs).toBeLessThan(5000);
      const held = kit.ledger.dialogOf(kit.surfaceId)!;
      expect(JSON.parse(interrupted.stdout)).toMatchObject({
        name: "DialogOpenedError",
        dialog: { id: held.id, message: "click confirm", type: "confirm" },
      });
      await kit.run(`await cdp('Page.handleJavaScriptDialog',{accept:false});`);
      let personFirst = false;
      kit.hooks.before = async (method) => {
        if (method !== "Page.handleJavaScriptDialog" || personFirst) return;
        personFirst = true;
        const dialog = kit.ledger.dialogOf(kit.surfaceId)!;
        await kit.controller.handle({ type: "dialog.respond", dialogId: dialog.id, accept: false });
      };
      await kit.run(`await fails(()=>page.locator('#click').click(),/dialog/i);
await fails(()=>cdp('Page.handleJavaScriptDialog',{accept:true}),/No dialog|changed|no longer/i);`);
      delete kit.hooks.before;
      let replacement = false;
      kit.hooks.before = async (method) => {
        if (method !== "Page.handleJavaScriptDialog" || replacement) return;
        replacement = true;
        const dialog = kit.ledger.dialogOf(kit.surfaceId)!;
        await kit.controller.handle({ type: "dialog.respond", dialogId: dialog.id, accept: false });
        await waitForBrowserState(() => kit.ledger.dialogOf(kit.surfaceId)?.message === "B");
      };
      await kit.run(`await fails(()=>page.locator('#chain').click(),/dialog/i);
await fails(()=>cdp('Page.handleJavaScriptDialog',{accept:true}),/changed|no longer|stale|no active browser dialog/i);`);
      delete kit.hooks.before;
      expect(kit.ledger.dialogOf(kit.surfaceId)?.message).toBe("B");
      await kit.run(`await cdp('Page.handleJavaScriptDialog',{accept:true});`);
      expect((await kit.state()).answers).toEqual([
        { id: "down", answer: true },
        { id: "click", answer: true },
        { id: "key", answer: true },
        { id: "click", answer: false },
        { id: "click", answer: false },
        { id: "A", answer: false },
        { id: "B", answer: true },
      ]);
      const openings = kit.sink.messages.filter(
        (m) => m.type === "cdp.event" && m.event.method === "Page.javascriptDialogOpening",
      );
      expect(openings.length).toBe(7);
      for (const opening of openings)
        if (opening.type === "cdp.event")
          expect(opening.event.sessionId).toEqual(expect.any(String));
    },
  );

  acceptance(
    "14",
    "keyboard metadata, browser-platform shortcuts and modifier cleanup",
    async (kit, report) => {
      await kit.run(`await page.locator('#keys').fill('initial');await page.locator('#keys').press('Shift+Tab');
assert(await page.evaluate(()=>document.activeElement.id)==='before','Shift+Tab focus');
await page.locator('#keys').fill('abc');await page.keyboard.press('ControlOrMeta+A');await page.keyboard.press('Backspace');
assert(await page.locator('#keys').inputValue()==='','platform select-all and delete');
await page.keyboard.type('a!?:');await page.keyboard.press('ArrowLeft');await page.keyboard.press('Backspace');
assert(await page.locator('#keys').inputValue()==='a!:','punctuation/arrows');
await page.keyboard.insertText('雪🙂');
assert(await page.locator('#keys').inputValue()==='a!雪🙂:','unicode insertText');`);
      let injected = false;
      kit.hooks.before = async (method, params) => {
        if (
          method === "Input.dispatchKeyEvent" &&
          params?.key === "a" &&
          params.type !== "keyUp" &&
          !injected
        ) {
          injected = true;
          throw new Error("injected key failure");
        }
      };
      await kit.run(
        `await fails(()=>page.keyboard.press('Control+a'),/injected key failure/);await page.keyboard.press('b');`,
      );
      delete kit.hooks.before;
      expect(injected).toBe(true);
      const state = await kit.state();
      const keys = (state.events as Record<string, unknown>[]).filter((e) => e.type === "keydown");
      expect(keys).toContainEqual(
        expect.objectContaining({
          key: "Tab",
          code: "Tab",
          keyCode: 9,
          shift: true,
          trusted: true,
        }),
      );
      expect(keys).toContainEqual(
        expect.objectContaining({ key: "!", code: "Digit1", keyCode: 49, trusted: true }),
      );
      expect(keys.at(-1)).toMatchObject({
        key: "b",
        code: "KeyB",
        ctrl: false,
        meta: false,
        alt: false,
        shift: false,
        trusted: true,
      });
      expect(state.inputs).toMatchObject({ keys: { value: "a!雪🙂b:" } });
      const userAgent = await kit.read<string>("navigator.userAgent");
      const browserOS = /Macintosh/.test(userAgent)
        ? "darwin"
        : /Linux/.test(userAgent)
          ? "linux"
          : /Windows/.test(userAgent)
            ? "win32"
            : "unknown";
      report.platformMatrix = {
        runner: process.platform,
        browser: userAgent,
        browserOS,
        crossOSAvailable: browserOS !== process.platform,
      };
    },
  );

  acceptance(
    "18",
    "context loss before dispatch retries; navigation after dispatch is never replayed",
    async (kit, report) => {
      let navigated = false;
      kit.hooks.before = async (method) => {
        if (method !== "Runtime.callFunctionOn" || navigated) return;
        navigated = true;
        await kit.navigate(`${kit.site.url("18")}?before=1`);
      };
      await kit.run(
        `await page.getByRole('button',{name:'Navigate once'}).click({timeout:5000});await page.waitForURL(/after=1/);`,
      );
      expect(navigated).toBe(true);
      expect(await kit.state()).toMatchObject({ persistedActivations: 1, activations: 1 });
      expect(
        kit.trace.filter(
          (e) => e.method === "Input.dispatchMouseEvent" && e.parameters?.type === "mousePressed",
        ),
      ).toHaveLength(1);
      report.navigationRequests = kit.site.requests.filter((r) => r.path.startsWith("/case/18"));
      expect(kit.site.requests.filter((r) => r.path === "/case/18?after=1")).toHaveLength(1);
    },
  );

  acceptance(
    "18-post",
    "navigation after dispatch activates exactly once without a retry",
    async (kit) => {
      await kit.run(
        `await page.getByRole('button',{name:'Navigate once'}).click({timeout:5000});await page.waitForURL(/after=1/);`,
      );
      expect(await kit.state()).toMatchObject({ persistedActivations: 1, activations: 1 });
      expect(
        kit.trace.filter(
          (e) => e.method === "Input.dispatchMouseEvent" && e.parameters?.type === "mousePressed",
        ),
      ).toHaveLength(1);
      expect(kit.site.requests.filter((r) => r.path === "/case/18?after=1")).toHaveLength(1);
    },
    "18",
  );

  acceptance(
    "13-phases",
    "dialogs opened by focus, key release and modifier release interrupt promptly",
    async (kit, report) => {
      const out = await kit.run(
        `const phases={};
for (const [name,action] of [
  ['keyup',()=>page.getByLabel('Key release dialog').press('a')],
  ['focus',()=>page.getByLabel('Focus dialog').fill('typed')],
  ['modifier',()=>page.getByLabel('Modifier release dialog').press('Shift+b')],
]) {
  const since=Date.now();
  const error=await fails(action,/dialog/i);
  assert(error.name==='DialogOpenedError','typed dialog error for '+name);
  assert(error.dialog?.id&&error.dialog.message===name+' confirm','dialog identity for '+name);
  phases[name]=Date.now()-since;
  await cdp('Page.handleJavaScriptDialog',{accept:true});
}
console.log(JSON.stringify(phases));`,
        { timeoutMs: 8000 },
      );
      const phases = JSON.parse(out.stdout) as Record<string, number>;
      report.phases = phases;
      for (const elapsed of Object.values(phases)) expect(elapsed).toBeLessThan(2000);
      expect(await kit.state()).toMatchObject({
        counts: { keyup: 1, focus: 1, modifier: 1 },
        answers: [
          { id: "keyup", answer: true },
          { id: "focus", answer: true },
          { id: "modifier", answer: true },
        ],
      });
      expect(kit.ledger.dialogOf(kit.surfaceId)).toBeNull();
    },
    "13",
  );

  acceptance(
    "14-shift",
    "shifted character aliases type their shifted characters",
    async (kit) => {
      await kit.run(`await page.locator('#keys').fill('');
for (const key of ['Shift+a','Shift+1','Shift+KeyA','Shift+/']) await page.keyboard.press(key);
assert(await page.locator('#keys').inputValue()==='A!A?','shifted aliases: '+await page.locator('#keys').inputValue());`);
      const keys = ((await kit.state()).events as Record<string, unknown>[]).filter(
        (e) => e.type === "keydown" && e.shift === true && e.key !== "Shift",
      );
      expect(keys.map((e) => [e.key, e.code])).toEqual([
        ["A", "KeyA"],
        ["!", "Digit1"],
        ["A", "KeyA"],
        ["?", "Slash"],
      ]);
    },
    "14",
  );

  acceptance(
    "14-paste",
    "every way a harness program presses Cmd+V is refused at the router",
    async (kit, report) => {
      // The probe is not part of the recorded page state: a regression that
      // pasted would put this computer's clipboard there, and evidence keeps
      // only whether anything arrived.
      await kit.run(`await page.evaluate(()=>{
  document.body.insertAdjacentHTML('beforeend','<div id="paste-probe" contenteditable="true"></div>');
  window.pastes=0;document.addEventListener('paste',()=>window.pastes++,true);
  document.querySelector('#paste-probe').focus();
});
const refused=/Pasting is not available to agents/;
await fails(()=>page.keyboard.press('Meta+V'),refused);
await fails(()=>pressKey('v',{modifiers:4}),refused);
await fails(()=>pressKey('v',{modifiers:4,commands:[]}),refused);
await fails(()=>cdp('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'v',code:'KeyV',windowsVirtualKeyCode:86,modifiers:4}),refused);
await fails(()=>cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'v',code:'KeyV',modifiers:4,commands:['paste']}),refused);
await page.keyboard.type('ok');
const probe=await page.evaluate(()=>({pastes:window.pastes,typedOnly:document.querySelector('#paste-probe').textContent==='ok',length:document.querySelector('#paste-probe').textContent.length}));
console.log(JSON.stringify(probe));
assert(probe.pastes===0&&probe.typedOnly,'nothing pasted: '+JSON.stringify(probe));`);
      // Each press owes its release even when refused, so count the downs.
      const attempts = kit.trace.filter(
        (e) =>
          e.method === "Input.dispatchKeyEvent" &&
          e.parameters?.type !== "keyUp" &&
          String(e.parameters?.key).toLowerCase() === "v" &&
          (Number(e.parameters?.modifiers) & 4) !== 0,
      );
      expect(attempts).toHaveLength(5);
      for (const attempt of attempts)
        expect(attempt.error, JSON.stringify(attempt.parameters)).toMatch(
          /Pasting is not available to agents/,
        );
      // A macOS browser gets Playwright's paste command from the harness;
      // elsewhere the router infers it. Both are refused.
      const userAgent = await kit.read<string>("navigator.userAgent");
      const mac = /Macintosh/u.test(userAgent);
      expect(attempts.map((e) => e.parameters?.commands)).toEqual([
        mac ? ["paste"] : undefined,
        mac ? ["paste"] : undefined,
        [],
        undefined,
        ["paste"],
      ]);
      const state = await kit.state();
      const reached = (state.events as Record<string, unknown>[]).filter(
        (e) => e.type === "keydown" && String(e.key).toLowerCase() === "v",
      );
      expect(reached).toEqual([]);
      report.paste = { browser: userAgent, harnessSentPaste: mac, attempts: attempts.length };
    },
    "14",
  );

  acceptance(
    "14-version",
    "a slow browser-version lookup does not poison later actions in the program",
    async (kit) => {
      let delayed = false;
      kit.hooks.before = async (method) => {
        if (method !== "Browser.getVersion" || delayed) return;
        delayed = true;
        await new Promise((resolve) => setTimeout(resolve, 1500));
      };
      await kit.run(
        `await fails(()=>page.getByRole('button',{name:'Still usable'}).click({timeout:300}),/Timeout 300ms/);
await page.getByRole('button',{name:'Still usable'}).click({timeout:5000});`,
      );
      expect(delayed).toBe(true);
      expect((await kit.state()).counts).toEqual({ healthy: 1 });
    },
    "12",
  );

  acceptance(
    "18-ax",
    "navigation between the AX lookup and node resolution re-resolves before dispatch",
    async (kit) => {
      let navigated = false;
      kit.hooks.before = async (method) => {
        if (method !== "DOM.resolveNode" || navigated) return;
        navigated = true;
        await kit.navigate(`${kit.site.url("12")}?ax-navigation=1`);
      };
      await kit.run(
        `await page.getByRole('button',{name:'Still usable',exact:true}).click({timeout:5000});`,
      );
      expect(navigated).toBe(true);
      expect(await kit.state()).toMatchObject({
        url: `${kit.site.url("12")}?ax-navigation=1`,
        counts: { healthy: 1 },
      });
    },
    "12",
  );

  acceptance(
    "18-unknown",
    "a press whose release is never acknowledged reports an unknown outcome and is not replayed",
    async (kit, report) => {
      let delayed = false;
      kit.hooks.before = async (method, parameters) => {
        if (method !== "Input.dispatchMouseEvent" || parameters?.type !== "mouseReleased") return;
        if (delayed) return;
        delayed = true;
        await new Promise((resolve) => setTimeout(resolve, 4000));
      };
      const out = await kit.run(
        `const since=Date.now();
const error=await fails(()=>page.getByRole('button',{name:'Still usable'}).click({timeout:800}),/outcome unknown/);
const failedAfter=Date.now()-since;
await page.waitForFunction(()=>fixture.counts.healthy===1,undefined,{timeout:8000});
console.log(JSON.stringify({error,failedAfter}));`,
        { timeoutMs: 15_000 },
      );
      const result = JSON.parse(out.stdout) as { failedAfter: number };
      report.result = result;
      expect(delayed).toBe(true);
      // The harness stops waiting for the release before its reply arrives.
      expect(result.failedAfter).toBeLessThan(4000);
      expect((await kit.state()).counts).toEqual({ healthy: 1 });
      for (const type of ["mousePressed", "mouseReleased"])
        expect(
          kit.trace.filter(
            (e) => e.method === "Input.dispatchMouseEvent" && e.parameters?.type === type,
          ),
        ).toHaveLength(1);
    },
    "12",
  );

  acceptance(
    "18-late-release",
    "a release still in flight when the deadline passes completes the click instead of leaving the button down",
    async (kit) => {
      let delayed = false;
      kit.hooks.before = async (method, parameters) => {
        if (method !== "Input.dispatchMouseEvent" || parameters?.type !== "mouseReleased") return;
        if (delayed) return;
        delayed = true;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      };
      await kit.run(`await page.getByRole('button',{name:'Still usable'}).click({timeout:800});`);
      expect(delayed).toBe(true);
      expect((await kit.state()).counts).toEqual({ healthy: 1 });
      for (const type of ["mousePressed", "mouseReleased"])
        expect(
          kit.trace.filter(
            (e) => e.method === "Input.dispatchMouseEvent" && e.parameters?.type === type,
          ),
        ).toHaveLength(1);
    },
    "12",
  );

  acceptance(
    "18-press-failure",
    "a sent press whose reply fails still sends exactly one release and is not replayed",
    async (kit) => {
      let failed = false;
      kit.hooks.before = async (method, parameters) => {
        if (method !== "Input.dispatchMouseEvent" || parameters?.type !== "mousePressed") return;
        if (failed) return;
        failed = true;
        // The press reaches the page; only its acknowledgement is lost.
        await sendAsAgent(
          (message) => kit.controller.handle(message),
          kit.sink.messages,
          method,
          parameters,
          kit.trace.at(-1)?.sessionId,
        );
        throw new Error("injected lost press reply");
      };
      await kit.run(`await fails(()=>page.getByRole('button',{name:'Still usable'}).click({timeout:3000}),/injected lost press reply/);
await page.waitForFunction(()=>fixture.counts.healthy===1,undefined,{timeout:5000});
await page.getByRole('button',{name:'Still usable'}).click();`);
      expect(failed).toBe(true);
      expect((await kit.state()).counts).toEqual({ healthy: 2 });
      for (const type of ["mousePressed", "mouseReleased"])
        expect(
          kit.trace.filter(
            (e) => e.method === "Input.dispatchMouseEvent" && e.parameters?.type === type,
          ),
        ).toHaveLength(2);
    },
    "12",
  );

  acceptance(
    "14-release-budget",
    "stalled modifier releases are all sent and bounded by one grace period through exit",
    async (kit, report) => {
      let stalled = 0;
      kit.hooks.before = async (method, parameters) => {
        if (method !== "Input.dispatchKeyEvent" || parameters?.type !== "keyUp") return;
        stalled++;
        await new Promise((resolve) => setTimeout(resolve, 5000));
      };
      await kit.run(`await page.locator('#keys').fill('x');`);
      const out = await kit.run(
        `const since=Date.now();
await fails(()=>page.locator('#keys').press('Alt+Control+Shift+a',{timeout:1000}),/release|Timeout/);
console.log(JSON.stringify({elapsed:Date.now()-since}));`,
        { timeoutMs: 20_000 },
      );
      const { elapsed } = JSON.parse(out.stdout) as { elapsed: number };
      report.elapsed = elapsed;
      report.processElapsed = out.elapsedMs;
      // One action deadline plus one release grace, not a grace per key...
      expect(elapsed).toBeLessThan(1000 + 2000 + 1000);
      // ...and leaving spends no second grace on releases whose grace is spent.
      expect(out.elapsedMs).toBeLessThan(1000 + 2000 + 1500);
      expect(stalled).toBe(4);
      const ups = kit.trace.filter(
        (e) => e.method === "Input.dispatchKeyEvent" && e.parameters?.type === "keyUp",
      );
      // Shift is held, so the main key is reported shifted.
      expect(ups.map((e) => e.parameters?.key)).toEqual(["A", "Shift", "Control", "Alt"]);
    },
    "14",
  );

  acceptance(
    "14-release-tab-switch",
    "an unresolved release is waited for once, not again after a tab switch or at exit",
    async (kit, report) => {
      let firstSession: string | undefined;
      kit.hooks.before = async (method, parameters, sessionId) => {
        if (method !== "Input.dispatchKeyEvent" || parameters?.type !== "keyUp") return;
        firstSession ??= sessionId;
        if (sessionId === firstSession) await new Promise((resolve) => setTimeout(resolve, 8000));
      };
      const out = await kit.run(
        `await fails(()=>page.locator('#keys').press('a',{timeout:500}),/release|Timeout/);
const second=await newTab(${JSON.stringify(kit.site.url("12"))});
await page.getByRole('button',{name:'Still usable'}).click();
console.log(JSON.stringify({second}));`,
        { timeoutMs: 20_000 },
      );
      report.processElapsed = out.elapsedMs;
      // One deadline and one grace for the stalled release; the switch and the
      // final exit add no further waits for that departed session.
      expect(out.elapsedMs).toBeLessThan(500 + 2000 + 2500);
      const tabs = kit.ledger.snapshot();
      expect(tabs).toHaveLength(2);
    },
    "14",
  );

  acceptance(
    "13-keydown-failure-dialog",
    "a key-release dialog wins over a failed keydown, and leaving never repeats the release",
    async (kit, report) => {
      let failed = false;
      kit.hooks.before = async (method, parameters) => {
        if (method !== "Input.dispatchKeyEvent" || parameters?.type === "keyUp") return;
        if (parameters?.key !== "a" || failed) return;
        failed = true;
        await sendAsAgent(
          (message) => kit.controller.handle(message),
          kit.sink.messages,
          method,
          parameters,
          kit.trace.at(-1)?.sessionId,
        );
        throw new Error("injected lost keydown reply");
      };
      const rounds = 5;
      for (let round = 1; round <= rounds; round++) {
        failed = false;
        await kit.run(
          `const e=await fails(()=>page.getByLabel('Key release dialog').press('a'),/dialog/i);
assert(e.name==='DialogOpenedError'&&e.dialog?.message==='keyup confirm','dialog wins over the keydown failure');
await cdp('Page.handleJavaScriptDialog',{accept:true});`,
          { timeoutMs: 8000 },
        );
        expect(failed).toBe(true);
        // The runtime releases what a departing agent still holds; a release the
        // harness left unacknowledged would reach the page twice and reopen the dialog.
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(kit.ledger.dialogOf(kit.surfaceId)).toBeNull();
      }
      // Each keyUp is acknowledged before the session that sent it detaches.
      const detaches = kit.trace.filter((e) => e.method === "Target.detachFromTarget");
      for (const keyUp of kit.trace.filter(
        (e) => e.method === "Input.dispatchKeyEvent" && e.parameters?.type === "keyUp",
      )) {
        const detach = detaches.find((e) => e.at > keyUp.at);
        expect(keyUp.error).toBeUndefined();
        expect(keyUp.finished).toBeDefined();
        expect(keyUp.finished!).toBeLessThanOrEqual(detach!.at);
      }
      const state = await kit.state();
      report.answers = state.answers;
      expect(state).toMatchObject({ counts: { keyup: rounds } });
    },
    "13",
  );

  acceptance(
    "14-release-budget-group",
    "a slow object-group release after spent input grace adds no second grace at exit",
    async (kit, report) => {
      kit.hooks.before = async (method, parameters) => {
        const stalledKeyUp = method === "Input.dispatchKeyEvent" && parameters?.type === "keyUp";
        if (stalledKeyUp || method === "Runtime.releaseObjectGroup")
          await new Promise((resolve) => setTimeout(resolve, stalledKeyUp ? 5000 : 3000));
      };
      const out = await kit.run(
        `await fails(()=>page.locator('#keys').press('Shift+a',{timeout:1000}),/release|Timeout/);`,
        { timeoutMs: 20_000 },
      );
      report.processElapsed = out.elapsedMs;
      // The action's deadline plus its one release grace, then leave.
      expect(out.elapsedMs).toBeLessThan(1000 + 2000 + 1500);
    },
    "14",
  );

  acceptance(
    "13-replacement-open-at-exit",
    "answering a dialog that a replacement already followed leaves the replacement bounding exit",
    async (kit, report) => {
      let replaced = false;
      kit.hooks.after = async (method) => {
        if (method !== "Page.handleJavaScriptDialog" || replaced) return;
        replaced = true;
        // The replacement's opening reaches the harness before this answer's reply.
        await waitForBrowserState(() =>
          Promise.resolve(kit.ledger.dialogOf(kit.surfaceId)?.message === "B"),
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
      };
      const out = await kit.run(
        `await fails(()=>page.locator('#chain').click(),/dialog/i);await cdp('Page.handleJavaScriptDialog',{accept:true});`,
        { timeoutMs: 15_000 },
      );
      report.processElapsed = out.elapsedMs;
      expect(replaced).toBe(true);
      expect(kit.ledger.dialogOf(kit.surfaceId)?.message).toBe("B");
      // Releases blocked behind the unanswered replacement get one grace, not the command timeout.
      expect(out.elapsedMs).toBeLessThan(2000 + 3000);
    },
    "13",
  );

  acceptance(
    "13-dialog-closes-during-exit",
    "a dialog the person answers while the session waits to leave lets its releases finish first",
    async (kit, report) => {
      const events: DialogExitObservation[] = [];
      const observe = (phase: DialogExitObservation["phase"]) =>
        events.push({ phase, at: performance.now() });
      const releaseReady = Promise.withResolvers<void>();
      const settlingReady = Promise.withResolvers<void>();
      let active = true;
      let answer: Promise<unknown> | undefined;
      let heldGroup: unknown;
      let releaseHeld: number | undefined;
      let settling: number | undefined;
      let openWhenSettling: boolean | undefined;
      let answeredAt: number | undefined;
      let closeDelivered: number | undefined;
      let closeObserved: number | undefined;
      let releasedAt: number | undefined;
      let openGate!: () => void;
      const gate = new Promise<void>((resolve) => (openGate = resolve));
      const timers: NodeJS.Timeout[] = [];
      // A WebSocket command and a stderr notice can arrive in either order.
      // The person acts only after both acknowledgements, with the same timing bounds.
      const readyToAnswer = Promise.all([releaseReady.promise, settlingReady.promise]).then(() => {
        if (!active) return;
        timers.push(
          setTimeout(() => {
            const dialog = kit.ledger.dialogOf(kit.surfaceId);
            answeredAt = performance.now();
            observe("answered");
            if (dialog) {
              answer = kit.ledger.answerDialog(dialog.id, false, undefined);
              void answer.catch(() => undefined);
            }
          }, 300),
          setTimeout(openGate, 2500),
        );
      });
      kit.hooks.before = async (method, parameters) => {
        if (method === "Target.detachFromTarget") {
          observe("detach-sent");
          return;
        }
        if (method !== "Runtime.releaseObjectGroup" || releaseHeld !== undefined) return;
        releaseHeld = performance.now();
        heldGroup = parameters?.objectGroup;
        observe("release-held");
        releaseReady.resolve();
        await gate;
        releasedAt = performance.now();
      };
      kit.hooks.after = async (method, parameters) => {
        if (method === "Runtime.releaseObjectGroup" && parameters?.objectGroup === heldGroup)
          observe("release-finished");
      };
      // When the harness hears the close is when its dialog grace can end.
      const forward = kit.sink.sendServerImplementation;
      kit.sink.sendServerImplementation = async (message) => {
        await forward?.(message);
        if (message.type === "cdp.event" && message.event.method === "Page.javascriptDialogClosed")
          closeDelivered ??= performance.now();
      };
      try {
        const out = await kit.run(`await fails(()=>page.locator('#click').click(),/dialog/i);`, {
          timeoutMs: 15_000,
          // The harness says when it starts waiting to leave; only then
          // does the person answer, and the release is let through only
          // after the grace an open-dialog snapshot would have allowed.
          onStderrLine: (line) => {
            if (
              settling !== undefined &&
              line.startsWith("[opensteer] The dialog on this page closed")
            ) {
              closeObserved ??= performance.now();
              observe("dialog-close-observed");
            }
            if (settling !== undefined || !line.startsWith("[opensteer] Waiting for the page"))
              return;
            settling = performance.now();
            openWhenSettling = kit.ledger.dialogOf(kit.surfaceId) !== null;
            observe("settling");
            settlingReady.resolve();
          },
        });
        observe("exited");
        await readyToAnswer;
        await answer;
        await traceSettled(kit);
        report.sequence = events;
        report.timing = {
          releaseHeld,
          settling,
          openWhenSettling,
          answeredAt,
          closeDelivered,
          closeObserved,
          releasedAt,
          exit: out.elapsedMs,
        };
        // Both prerequisites precede the person's answer. The harness processes
        // the close within its old grace; its release still finishes before detach.
        expect(releaseHeld).toBeDefined();
        expect(settling).toBeDefined();
        assertDialogExitOrder(events);
        expect(openWhenSettling).toBe(true);
        expect(closeObserved).toBeDefined();
        expect(closeObserved! - settling!).toBeLessThan(2000);
        expect(releasedAt! - settling!).toBeGreaterThanOrEqual(2000);
        expect(kit.ledger.dialogOf(kit.surfaceId)).toBeNull();
        report.groups = expectGroupsReleasedBeforeDetach(kit);
        expect(out.elapsedMs).toBeLessThan(2500 + 3000);
      } finally {
        active = false;
        releaseReady.resolve();
        settlingReady.resolve();
        await readyToAnswer;
        for (const timer of timers) clearTimeout(timer);
        openGate();
        await answer?.catch(() => undefined);
        kit.sink.sendServerImplementation = forward;
      }
    },
    "13",
  );
});
