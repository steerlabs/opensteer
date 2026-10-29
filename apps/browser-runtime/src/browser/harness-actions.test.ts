import {
  assertDialogExitOrder,
  type DialogExitObservation,
} from "./dialog-exit-order.test-support.js";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SessionCdpRouter, type CdpParameters } from "@opensteer/browser-core";
import {
  BrowserController,
  HostSignIns,
  SessionFiles,
  SurfaceLedger,
} from "@opensteer/browser-runtime-core";
import { FakeSink, validClaims } from "@opensteer/browser-runtime-core/test-support";
import { serveHarnessActionsFixture } from "@opensteer/browser-runtime-core/test-support/harness-actions";
import {
  TestChromiumLauncher,
  browserTestSignal,
  cleanup,
  findChromium,
  waitForBrowserState,
  withBrowserTestSignal,
} from "./browser-test-lifecycle.js";
import {
  harnessScript,
  HarnessRunError,
  runHarness,
  sendAsAgent,
  startHarnessBridge,
} from "./browser-harness.test-support.js";

const executablePath = findChromium();
const evidenceRoot =
  process.env.OPENSTEER_HARNESS_ACTIONS_EVIDENCE_DIR ?? join(tmpdir(), "opensteer-harness-actions");
const command = "pnpm exec vitest run apps/browser-runtime/src/browser/harness-actions.test.ts";
const programAssertions = `
function assert(value, message) { if (!value) throw new Error('Contract assertion: '+message); }
async function fails(action, pattern) {
  try { await action(); } catch(error) {
    assert(pattern.test(String(error)), 'expected '+pattern+', received '+String(error));
    return {name:error.name,message:error.message,dialog:error.dialog};
  }
  throw new Error('Contract assertion: expected failure '+pattern);
}
`;

interface CommandTrace {
  method: string;
  parameters?: CdpParameters | undefined;
  sessionId?: string | undefined;
  at: number;
  finished?: number;
  error?: string;
}
type Kit = Awaited<ReturnType<typeof startActionJourney>>;

async function startActionJourney(id: string, report: Record<string, unknown>) {
  const site = await serveHarnessActionsFixture();
  cleanup.push(() => site.close());
  const claims = validClaims();
  const browser = await new TestChromiumLauncher({
    executablePath,
    chromiumSandbox: false,
    headless: true,
  }).launch({
    initialViewport: { width: 1000, height: 700, devicePixelRatio: 1 },
    partitionKey: `session:${claims.sessionId}`,
    sessionId: claims.sessionId,
    snapshot: { cookies: [], origins: [] },
  });
  const root = browser.context.pages()[0]!;
  const targetId = await root.targetId();
  const router = new SessionCdpRouter(browser.cdp);
  cleanup.push(() => router.close());
  const files = new SessionFiles(join(tmpdir(), `opensteer-actions-${randomUUID()}`));
  cleanup.push(() => files.dispose());
  const ledger = new SurfaceLedger(browser.context, {
    claimTarget: (target) => router.claimTarget(claims.sessionId, target),
    rootPages: [root],
    initialViewport: { width: 1000, height: 700, devicePixelRatio: 1 },
  });
  router.registerSession(
    claims.sessionId,
    targetId,
    (target) => ledger.resolveTarget(target),
    files.root,
  );
  await ledger.start();
  cleanup.push(() => ledger.close());
  const sink = new FakeSink();
  const controller = new BrowserController({
    cdpRouter: router,
    claims,
    files,
    ledger,
    sink,
    exportSnapshot: () => browser.exportSnapshot(),
    replaceSiteCookies: (site, cookies, signal) =>
      browser.replaceSiteCookies(site, cookies, signal),
    signIns: new HostSignIns({ authority: undefined, runtimeId: "actions-test" }),
  });
  await controller.start();
  cleanup.push(() => controller.close());
  const surfaceId = ledger.surfaceIdForTarget(targetId)!;
  cleanup.push(async () => {
    for (const surface of ledger.snapshot()) {
      const dialog = ledger.dialogOf(surface.id);
      if (dialog) await ledger.answerDialog(dialog.id, false, undefined);
    }
  });
  const platform = ledger.binding(surfaceId)!.cdp;
  const read = async <T = unknown>(expression: string): Promise<T> => {
    const result = await withBrowserTestSignal(
      platform.send<{ result: { value: T }; exceptionDetails?: unknown }>("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      }),
    );
    if (result.exceptionDetails)
      throw new Error(`Oracle evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
    return result.result.value;
  };
  const navigate = async (url: string) => {
    await platform.send("Page.navigate", { url });
    await waitForBrowserState(() =>
      read<boolean>(
        `location.href === ${JSON.stringify(url)} && document.readyState === 'complete' && !!window.fixture?.ready`,
      ),
    );
  };
  await navigate(site.url(id));
  if (id === "05" || id === "engine")
    await waitForBrowserState(() =>
      read<boolean>(
        `!!window.fixture.react && !!document.querySelector('${id === "05" ? "#controlled" : "#zip"}')`,
      ),
    );
  const trace: CommandTrace[] = [];
  const hooks: {
    before?: (method: string, parameters?: CdpParameters, sessionId?: string) => Promise<void>;
    /** Runs after the browser answered, before the reply reaches the harness. */
    after?: (method: string, parameters?: CdpParameters) => Promise<void>;
  } = {};
  const bridge = await startHarnessBridge(async (method, parameters, sessionId) => {
    const entry: CommandTrace = { method, parameters, sessionId, at: performance.now() };
    trace.push(entry);
    try {
      await hooks.before?.(method, parameters, sessionId);
      const result = await sendAsAgent(
        (message) => controller.handle(message),
        sink.messages,
        method,
        parameters,
        sessionId,
      );
      await hooks.after?.(method, parameters);
      return result;
    } catch (error) {
      entry.error = String(error);
      throw error;
    } finally {
      entry.finished = performance.now();
    }
  }, sink);
  cleanup.push(() => bridge.close());
  const runs: Record<string, unknown>[] = [];
  Object.assign(report, {
    browser: await browser.cdp.send("Browser.getVersion"),
    fixtureSha256: site.sha256,
    executablePlatform: process.platform,
    chromiumExecutable: executablePath,
    trace,
    runs,
    requests: site.requests,
  });
  const run = async (
    program: string,
    options: {
      inventory?: boolean;
      timeoutMs?: number;
      onStderrLine?: (line: string) => void;
    } = {},
  ) => {
    const record: Record<string, unknown> = {
      program,
      args: ["--session", claims.sessionId, ...(options.inventory ? [] : ["--tab", targetId])],
    };
    runs.push(record);
    try {
      const result = await runHarness(
        bridge.url,
        claims.sessionId,
        options.inventory ? undefined : targetId,
        programAssertions + program,
        {
          timeoutMs: options.timeoutMs ?? 15_000,
          ...(options.onStderrLine ? { onStderrLine: options.onStderrLine } : {}),
        },
      );
      Object.assign(record, result);
      return result;
    } catch (error) {
      Object.assign(
        record,
        error instanceof HarnessRunError ? error.output : { error: String(error) },
      );
      throw error;
    }
  };
  const state = () =>
    read<Record<string, unknown>>(`({ ...fixture,
    url:location.href,visibility:document.visibilityState,active:document.activeElement?.id,
    inputs:Object.fromEntries([...document.querySelectorAll('input,textarea')].map(e=>[e.id,{value:e.value,checked:e.checked}])),
    shadowValue:document.querySelector('#shadow-host')?.shadowRoot?.querySelector('input')?.value,
    editor:document.querySelector('#editor')?.textContent,
    selected:[...document.querySelectorAll('select')].map(e=>({id:e.id,values:[...e.selectedOptions].map(o=>o.value)})),
    results:document.querySelector('#results')?.textContent,
    activations:Number(sessionStorage.getItem('activations')||0)
  })`);
  return {
    site,
    claims,
    browser,
    root,
    targetId,
    router,
    ledger,
    controller,
    sink,
    surfaceId,
    platform,
    read,
    navigate,
    trace,
    hooks,
    run,
    state,
  };
}

function acceptance(
  id: string,
  title: string,
  body: (kit: Kit, report: Record<string, unknown>) => Promise<void>,
  fixtureId = id,
) {
  it(`A${id} ${title}`, async () => {
    const directory = join(evidenceRoot, id);
    await mkdir(directory, { recursive: true });
    const moduleHashes = Object.fromEntries(
      await Promise.all(
        (await readdir(dirname(harnessScript)))
          .filter((name) => name.endsWith(".mjs"))
          .map(async (name) => [
            name,
            createHash("sha256")
              .update(await readFile(join(dirname(harnessScript), name)))
              .digest("hex"),
          ]),
      ),
    );
    const report: Record<string, unknown> = {
      case: id,
      title,
      contract: "design.md v2 Acceptance 1–20",
      startedAt: new Date().toISOString(),
      sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      executable: harnessScript,
      executableSha256: moduleHashes["browser-harness.mjs"],
      moduleHashes,
      rerunCommand: `OPENSTEER_HARNESS_ACTIONS_EVIDENCE_DIR=${JSON.stringify(evidenceRoot)} ${command} -t ${JSON.stringify(`A${id} `)}`,
    };
    let kit: Kit | undefined;
    let journeyFailure: unknown;
    try {
      kit = await startActionJourney(fixtureId, report);
      await body(kit, report);
      report.passed = true;
    } catch (error) {
      report.passed = false;
      report.failure =
        error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
      journeyFailure = error;
    } finally {
      if (kit && !browserTestSignal().aborted) {
        report.dialogs = kit.sink.messages.filter(
          (message) => message.type === "browser.dialog.changed" || message.type === "cdp.event",
        );
        // Dialogs block evaluation/capture. Answer only this journey's observed identities first.
        for (let i = 0; i < 4; i++) {
          const dialog = kit.ledger.dialogOf(kit.surfaceId);
          if (!dialog) break;
          await kit.ledger.answerDialog(dialog.id, false, undefined).catch((error) => {
            report.dialogCleanupError = String(error);
          });
        }
        try {
          report.finalState = await kit.state();
          const screenshot = await kit.platform.send<{ data: string }>("Page.captureScreenshot", {
            format: "png",
          });
          await writeFile(join(directory, "page.png"), Buffer.from(screenshot.data, "base64"));
          report.screenshot = join(directory, "page.png");
        } catch (error) {
          report.oracleError = String(error);
          if (report.passed) {
            journeyFailure = error;
            report.passed = false;
            report.failure = { message: `Required page evidence failed: ${String(error)}` };
          }
        }
      }
      report.finishedAt = new Date().toISOString();
      await writeFile(join(directory, "result.json"), JSON.stringify(report, null, 2) + "\n");
    }
    if (journeyFailure) throw journeyFailure;
  }, 60_000);
}

/**
 * Waits for every command the bridge received to settle. A harness that leaves
 * early (the defects these cases catch) must not cut the evidence short.
 */
async function traceSettled(kit: Kit, timeoutMs = 10_000): Promise<void> {
  const until = performance.now() + timeoutMs;
  while (kit.trace.some((e) => e.finished === undefined) && performance.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 50));
}

/**
 * Every agent object group was released exactly once, successfully, before the
 * detach of the session that owned it (matched by session, not by time).
 */
function expectGroupsReleasedBeforeDetach(kit: Kit): string[] {
  const groups = new Map<string, { sessionId: string | undefined; group: string }>();
  for (const e of kit.trace)
    if (
      typeof e.parameters?.objectGroup === "string" &&
      e.parameters.objectGroup.startsWith("opensteer-op-")
    )
      groups.set(JSON.stringify([e.sessionId, e.parameters.objectGroup]), {
        sessionId: e.sessionId,
        group: e.parameters.objectGroup,
      });
  expect(groups.size).toBeGreaterThan(0);
  for (const [key, { sessionId, group }] of groups) {
    const releases = kit.trace.filter(
      (e) =>
        e.method === "Runtime.releaseObjectGroup" &&
        e.sessionId === sessionId &&
        e.parameters?.objectGroup === group,
    );
    expect(releases, key).toHaveLength(1);
    const detach = kit.trace.find(
      (e) => e.method === "Target.detachFromTarget" && e.parameters?.sessionId === sessionId,
    );
    expect(detach, key).toBeDefined();
    expect(releases[0]!.error, key).toBeUndefined();
    expect(releases[0]!.finished, key).toBeDefined();
    expect(releases[0]!.finished!, key).toBeLessThanOrEqual(detach!.at);
  }
  return [...groups.keys()];
}

describe("Browser Harness element actions / real hosted Chromium", () => {
  acceptance(
    "engine-baseline",
    "fixture baseline: combined React pickup form records a server-owned result",
    async (kit, report) => {
      await kit.run(`const pos=await js(\`(()=>{const label=document.querySelector('label[for="capacity-1"]');label.scrollIntoView({block:'center'});const r=label.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()\`);
await clickAt(pos.x,pos.y);
await js("document.querySelector('#zip').focus();true");await typeText('10014');await pressKey('Enter');`);
      await waitForBrowserState(() =>
        kit.read<boolean>("!!document.querySelector('#pickup-result')"),
      );
      expect(kit.site.submissions).toEqual([
        expect.objectContaining({
          nonce: "local",
          capacity: "512gb",
          zip: "10014",
          count: 1,
          resultId: expect.any(String),
          availability: "Available for pickup",
        }),
      ]);
      const state = await kit.state();
      expect(state).toMatchObject({
        counts: { "512gb": 1 },
        react: { zip: "10014" },
        inputs: { zip: { value: "10014" } },
      });
      expect(
        await kit.read("document.querySelector('#pickup-result').getAttribute('data-result-id')"),
      ).toBe(kit.site.submissions[0]!.resultId);
      report.serverSubmissions = kit.site.submissions;
    },
    "engine",
  );

  acceptance(
    "00",
    "fixture baseline: legacy measure-all then click deterministically activates the wrong capacity",
    async (kit, report) => {
      const output = await kit.run(`
const tabs=await listTabs(); const before=await currentTab();
assert(tabs.some(t=>t.targetId===before.targetId),'legacy inventory');
const controls=await js(\`[...document.querySelectorAll('[role=dialog] input[name="pl_dimensionCapacity"]')].map(e=>{const l=document.querySelector('label[for="'+e.id+'"]');l.scrollIntoView({block:'nearest'});const r=l.getBoundingClientRect();return {value:e.value,x:r.x+r.width/2,y:r.y+r.height/2}})\`);
const pos=controls.find(e=>e.value==='512gb'); await clickAt(pos.x,pos.y);
console.log(JSON.stringify({controls,target:'512gb',selected:await js("document.querySelector('[name=pl_dimensionCapacity]:checked').value")}));`);
      report.baseline = JSON.parse(output.stdout);
      expect(JSON.parse(output.stdout)).toMatchObject({ target: "512gb", selected: "1tb" });
      expect(await kit.state()).toMatchObject({
        counts: { "1tb": 1 },
        inputs: { "capacity-1": { checked: false }, "capacity-2": { checked: true } },
        trusted: [{ id: "1tb", trusted: true }],
      });
    },
    "01",
  );

  acceptance(
    "01",
    "fresh radio resolution selects the intended hidden input through its visible label",
    async (kit) => {
      await kit.run(`await page.getByRole('radio',{name:'512GB',exact:true}).check();
await page.getByRole('radio',{name:'512GB',exact:true}).check();
assert(await page.getByRole('radio',{name:'512GB',exact:true}).isChecked(),'selected radio');`);
      expect(await kit.state()).toMatchObject({
        counts: { "512gb": 1 },
        inputs: {
          "capacity-0": { checked: false },
          "capacity-1": { checked: true },
          "capacity-2": { checked: false },
        },
      });
      expect((await kit.state()).counts).toEqual({ "512gb": 1 });
    },
  );

  acceptance(
    "02",
    "role excludes hidden duplicate, CSS is strict, visible filter disambiguates",
    async (kit) => {
      await kit.run(`await page.getByRole('button',{name:'Continue',exact:true}).click();
const duplicate=await fails(()=>page.locator('.duplicate').click({timeout:500}),/2 elements|strict/i);
assert((duplicate.message.match(/button/gi)||[]).length>=2,'strict error lists both buttons');
await page.locator('.duplicate').filter({visible:true}).click();
assert(await page.locator('.duplicate').count()===2,'duplicates retained');`);
      expect((await kit.state()).counts).toEqual({ visible: 2 });
    },
  );

  acceptance("03", "sliding button waits for stable geometry", async (kit) => {
    await kit.read("startMotion();true");
    await kit.run(`await page.getByRole('button',{name:'Sliding button'}).click({timeout:4000});`);
    expect(await kit.state()).toMatchObject({
      counts: { moving: 1 },
      clickedAfterMotion: true,
      motionFinished: true,
    });
  });

  acceptance(
    "04",
    "overlay deadline names the interceptor and succeeds after removal",
    async (kit, report) => {
      const out = await kit.run(`const since=Date.now();
const error=await fails(()=>page.getByRole('button',{name:'Covered action'}).click({timeout:350}),/overlay.*intercepts|intercepts.*overlay/i);
assert(/Covered action/.test(error.message),'locator in error');
assert(/350/.test(error.message),'timeout in error');
console.log(JSON.stringify({error,ms:Date.now()-since}));
`);
      const blocked = JSON.parse(out.stdout);
      report.blocked = blocked;
      expect(blocked.ms).toBeLessThan(1500);
      expect((await kit.state()).counts).toEqual({});
      await kit.read("document.querySelector('#overlay').remove();true");
      await kit.run(`await page.locator('#covered').click();`);
      expect((await kit.state()).counts).toEqual({ covered: 1 });
    },
  );

  acceptance(
    "05-baseline",
    "fixture baseline: synthetic assignment fails React state, trusted insertText updates it",
    async (kit) => {
      await kit.run(
        `await js(\`(()=>{const e=document.querySelector('#controlled');e.value='synthetic';e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()\`);`,
      );
      expect(await kit.state()).toMatchObject({
        react: { controlled: "initial", legacy: "initial" },
        reactChanges: 0,
        inputs: { controlled: { value: "synthetic" } },
      });
      await kit.run(
        `await js("document.querySelector('#controlled').focus();document.querySelector('#controlled').select();true");await typeText('trusted');`,
      );
      expect(await kit.state()).toMatchObject({
        react: { controlled: "trusted", legacy: "initial" },
        reactChanges: 1,
      });
    },
    "05",
  );

  acceptance(
    "05",
    "fill updates real React, shadow, special types, editing host and focus replacement",
    async (kit) => {
      await kit.run(`await page.locator('#controlled').clear();
assert(await page.locator('#controlled').inputValue()==='','clear accepted');
await page.locator('#controlled').fill('React accepted');
await fillInput('#legacy','Adapter accepted');
await page.locator('#number').fill('42');
await fails(()=>page.locator('#number').fill('not a number'),/number|numeric|malformed/i);
await page.locator('#date').fill('2026-10-26');
await fails(()=>page.locator('#date').fill('not a date'),/malformed value/i);
await page.locator('#date').fill('2026-10-26');
await page.locator('#editor').fill('new nested text');
await page.locator('#replace').fill('replacement accepted');
await fails(()=>page.locator('#readonly').fill('bad',{timeout:1500}),/element is readonly/);
await fails(()=>page.locator('#aria-readonly').fill('bad',{timeout:1500}),/element is readonly/);
await fails(()=>page.locator('#checkbox').fill('bad',{timeout:1500}),/check[(][)]/i);
await fails(()=>page.locator('#file').fill('bad',{timeout:1500}),/setInputFiles[(][)]/i);`);
      expect(await kit.state()).toMatchObject({
        react: { controlled: "React accepted", legacy: "Adapter accepted" },
        editor: "new nested text",
        focusReplacements: 1,
        inputs: {
          number: { value: "42" },
          date: { value: "2026-10-26" },
          replace: { value: "replacement accepted" },
          readonly: { value: "protected" },
          "aria-readonly": { value: "protected" },
        },
      });
    },
  );

  acceptance(
    "05-shadow",
    "fill pierces a scoped open shadow root",
    async (kit) => {
      await kit.run(
        `await page.locator('#shadow-host').locator('#shadow-input').fill('shadow accepted');`,
      );
      expect((await kit.state()).shadowValue).toBe("shadow accepted");
    },
    "05",
  );

  acceptance(
    "06",
    "unknown ENTER suggests Enter and the correct key submits ZIP results",
    async (kit) => {
      await kit.run(`await page.getByLabel('ZIP',{exact:true}).fill('10014');
await fails(()=>page.getByLabel('ZIP').press('ENTER'),/Unknown key "ENTER".*Did you mean "Enter"/s);
assert((await page.evaluate(()=>fixture.submissions)).length===0,'uppercase key did not submit');
await page.getByLabel('ZIP').press('Enter');
await page.waitForFunction(()=>document.querySelectorAll('#results li').length===3);`);
      expect(await kit.state()).toMatchObject({
        submissions: ["10014"],
        results: "Pickup for 10014SoHoFifth Avenue",
      });
    },
  );

  acceptance("07", "CSS and role pierce open shadow roots", async (kit) => {
    await kit.run(`await page.locator('#shadow-host').locator('#shadow-button').click();
await page.getByRole('button',{name:'Shadow action',exact:true}).click();`);
    expect((await kit.state()).counts).toEqual({ shadow: 2 });
  });

  acceptance(
    "07-role",
    "role resolves an open shadow button independently of CSS",
    async (kit) => {
      await kit.run(`await page.getByRole('button',{name:'Shadow action',exact:true}).click();`);
      expect((await kit.state()).counts).toEqual({ shadow: 1 });
    },
    "07",
  );

  acceptance(
    "08",
    "hover replacement resolves the live node without activating the old-point decoy",
    async (kit) => {
      await kit.run(`await page.getByRole('button',{name:'Live action',exact:true}).click();`);
      expect(await kit.state()).toMatchObject({ hoverReplaced: true, counts: { live: 1 } });
      expect((await kit.state()).counts).toEqual({ live: 1 });
    },
  );

  acceptance(
    "09",
    "disabled controls reject, then work when enabled; missing role lists names",
    async (kit) => {
      await kit.run(`for(const id of ['disabled','fieldset','aria-disabled'])
  await fails(()=>page.locator('#'+id).click({timeout:1500}),/element is disabled/);
assert(Object.keys(await page.evaluate(()=>fixture.counts)).length===0,'disabled did not activate');
const missing=await fails(()=>page.getByRole('button',{name:'Missing action'}).click({timeout:1500}),/element was not found/);
assert(/Available action/.test(missing.message),'available role names');
await page.evaluate(()=>enableButtons());
for(const id of ['disabled','fieldset','aria-disabled']) await page.locator('#'+id).click();`);
      expect((await kit.state()).counts).toEqual({ disabled: 1, fieldset: 1, "aria-disabled": 1 });
    },
  );

  acceptance(
    "10",
    "prevented check fails honestly; setChecked and no-op preserve state",
    async (kit) => {
      await kit.run(`await fails(()=>page.getByLabel('Prevented',{exact:true}).check(),/clicking did not change its state/i);
assert(!(await page.locator('#prevented').isChecked()),'prevented stays unchecked');
await page.getByLabel('Working',{exact:true}).setChecked(true);
await page.getByLabel('Working',{exact:true}).check();
await page.getByLabel('Working',{exact:true}).uncheck();`);
      expect(await kit.state()).toMatchObject({
        counts: { prevented: 1, working: 2 },
        inputs: { prevented: { checked: false }, working: { checked: false } },
      });
    },
  );

  acceptance(
    "11",
    "selectOption matches values and labels and lists unknown choices",
    async (kit) => {
      await kit.run(`assert(JSON.stringify(await page.getByLabel('Shipping').selectOption('fast'))==='["fast"]','select value');
assert(JSON.stringify(await page.getByLabel('Shipping').selectOption('Economy'))==='["slow"]','select label');
assert(JSON.stringify(await page.locator('#multi').selectOption(['a','Beta']))==='["a","b"]','multiple select');
const error=await fails(()=>page.locator('#shipping').selectOption('missing'),/missing/i);
assert(/Economy/.test(error.message)&&/Express/.test(error.message),'available options');`);
      const state = await kit.state();
      expect(state.selected).toEqual([
        { id: "shipping", values: ["slow"] },
        { id: "multi", values: ["a", "b"] },
      ]);
      expect(
        (state.events as { type: string; id?: string }[])
          .filter((e) => e.type === "input" || e.type === "change")
          .map(({ type, id }) => ({ type, id })),
      ).toEqual([
        { type: "input", id: "shipping" },
        { type: "change", id: "shipping" },
        { type: "input", id: "shipping" },
        { type: "change", id: "shipping" },
        { type: "input", id: "multi" },
        { type: "change", id: "multi" },
      ]);
    },
  );

  acceptance("12", "evaluate and js retain page exception message and stack", async (kit) => {
    await kit.run(`const modern=await fails(()=>page.evaluate(function modernPageFailure(){throw new Error('modern detail')}),/modern detail/);
assert(/modernPageFailure/.test(modern.message),'modern page stack');
const legacy=await fails(()=>js("(function legacyPageFailure(){throw new Error('legacy detail')})()"),/legacy detail/);
assert(/legacyPageFailure/.test(legacy.message),'legacy page stack');
await page.getByRole('button',{name:'Still usable'}).click();`);
    expect((await kit.state()).counts).toEqual({ healthy: 1 });
  });

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
    "15",
    "background surface uses host sampling and leaves the selected page alone",
    async (kit, report) => {
      await kit.controller.handle({ type: "surface.open", url: kit.site.url("15") });
      const otherSurface = kit.ledger.active()!.surface.id;
      expect(otherSurface).not.toBe(kit.surfaceId);
      expect(kit.ledger.active()?.surface.id).not.toBe(kit.surfaceId);
      const visibility = await kit.read<string>("document.visibilityState");
      report.background = {
        selectedSurface: otherSurface,
        targetSurface: kit.surfaceId,
        visibilityState: visibility,
        nativeHiddenVisibilityQualified: visibility === "hidden",
      };
      await kit.read("blockPageTimers();true");
      await kit.run(
        `await page.locator('#background').click();await page.locator('#background-input').fill('background accepted');`,
      );
      const state = await kit.state();
      expect(state).toMatchObject({
        visibility,
        counts: { background: 1 },
        inputs: { "background-input": { value: "background accepted" } },
        pageTimerCalls: [],
      });
      expect(kit.ledger.active()?.surface.id).toBe(otherSurface);
      const samples = state.geometrySamples as {
        id: string;
        at: number;
        visibilityState: string;
      }[];
      report.hostSamples = { pageTimersDisabled: true, samples };
      for (const id of ["background", "background-input"]) {
        const targetSamples = samples.filter((sample) => sample.id === id);
        expect(targetSamples.length).toBeGreaterThanOrEqual(2);
        expect(
          targetSamples.some((sample, i) =>
            targetSamples.slice(0, i).some((before) => sample.at - before.at >= 50),
          ),
        ).toBe(true);
      }
      const groups = kit.trace.flatMap((e) =>
        typeof e.parameters?.objectGroup === "string" &&
        e.parameters.objectGroup.startsWith("opensteer-op-")
          ? [e.parameters.objectGroup]
          : [],
      );
      expect(groups.length).toBeGreaterThan(0);
      for (const group of new Set(groups))
        expect(
          kit.trace.some(
            (e) =>
              e.method === "Runtime.releaseObjectGroup" &&
              e.parameters?.objectGroup === group &&
              e.finished !== undefined &&
              e.error === undefined,
          ),
        ).toBe(true);
    },
  );

  acceptance(
    "16",
    "DSF 3 metrics and a person resize during resolution preserve click geometry",
    async (kit, report) => {
      await kit.run(
        `await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:3,mobile:true});await page.locator('#resize').click();`,
      );
      expect(await kit.state()).toMatchObject({
        counts: { resize: 1 },
        point: { dpr: 3, w: 390, h: 844 },
      });
      await kit.run(`await cdp('Emulation.clearDeviceMetricsOverride');`);
      let resized = false;
      kit.hooks.before = async (method) => {
        if (method !== "Runtime.callFunctionOn" || resized) return;
        resized = true;
        await kit.controller.handle({
          type: "viewport.set",
          surfaceId: kit.surfaceId,
          width: 620,
          height: 460,
        });
      };
      await kit.run(`await page.getByRole('button',{name:'Resize action'}).click();`);
      expect(resized).toBe(true);
      expect(await kit.state()).toMatchObject({ counts: { resize: 2 }, point: { w: 620, h: 460 } });
      report.resizeDuringResolution = resized;
    },
  );

  acceptance(
    "17",
    "AX names and values agree; oversized lookup/snapshot provide scoped recovery",
    async (kit, report) => {
      const output = await kit.run(`const snapshot=await page.ariaSnapshot();
assert(/button "Reserve pickup"/.test(snapshot),'snapshot button name');
assert(/textbox "ZIP": "?10014"?/.test(snapshot),'snapshot textbox value');
assert(/checkbox "Notify me".*\\[checked\\]/.test(snapshot),'snapshot checked state');
await page.getByRole('button',{name:'Reserve pickup',exact:true}).click();
console.log(JSON.stringify({snapshot}));`);
      report.ax = JSON.parse(output.stdout);
      expect(await kit.state()).toMatchObject({ counts: { snapshot: 1 } });
    },
  );

  acceptance(
    "17-overflow",
    "oversized AX lookup and snapshot fail with CSS scope hints on a reusable connection",
    async (kit, report) => {
      const output = await kit.run(`await page.evaluate(()=>addLargeAX());
const lookup=await fails(()=>page.getByRole('button',{name:/Large option/}).click({timeout:3000}),/too large|overflow|exceed|size|bounded/i);
const observation=await fails(()=>page.ariaSnapshot(),/too large|overflow|exceed|size|bounded/i);
await page.locator('#small').getByRole('button',{name:'Reserve pickup',exact:true}).click();
console.log(JSON.stringify({lookup,observation,scoped:await page.locator('#small').ariaSnapshot()}));
assert(/getByRole/.test(lookup.message)&&/locator[(]/.test(lookup.message)&&/scop/i.test(lookup.message),'lookup CSS scope hint');
assert(/locator[(]/.test(observation.message)&&/scop/i.test(observation.message),'snapshot CSS scope hint');`);
      report.ax = JSON.parse(output.stdout);
      expect(await kit.state()).toMatchObject({ counts: { snapshot: 1 }, largeCount: 5000 });
    },
    "17",
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
    "19",
    "DOM labels, external associations, ignored AX and DOM scoping stay distinct",
    async (kit) => {
      await kit.run(`const scope=page.locator('#scope');
await scope.getByLabel('External label',{exact:true}).fill('external');
await scope.getByLabel('ARIA label',{exact:true}).fill('aria');
await scope.getByLabel(/Referenced label/).fill('reference');
await scope.getByLabel('Wrapping label',{exact:true}).fill('wrapped');
for(const text of ['Own text only','Placeholder only','Title only']) assert(await page.getByLabel(text,{exact:true}).count()===0,'not a DOM label: '+text);
assert(await page.getByRole('button',{name:'Own text only',exact:true}).count()===1,'accessible own text');
assert(await scope.getByRole('button',{name:'Outside owned',exact:true}).count()===0,'aria-owns cannot escape DOM scope');
assert(JSON.stringify(await scope.getByRole('button',{name:/ordered/}).allInnerTexts())==='["First ordered","Second ordered"]','DOM order and deduplication');
await fails(()=>page.locator('#danger').check({timeout:1500}),/intercepts|not.*events|link/i);
assert(!(await page.locator('#danger').isChecked()),'nested link is not label activation');`);
      expect((await kit.state()).inputs).toMatchObject({
        "external-input": { value: "external" },
        "aria-label": { value: "aria" },
        labelledby: { value: "reference" },
        wrapped: { value: "wrapped" },
        danger: { checked: false },
      });
    },
  );

  acceptance(
    "19-hidden",
    "includeHidden includes Chromium ignored role matches",
    async (kit, report) => {
      // Capture Chromium's own query, since includeHidden means AX ignored rather
      // than CSS visibility in the v2 contract.
      const doc = await kit.platform.send<{ root: { nodeId: number } }>("DOM.getDocument");
      const raw = await kit.platform.send<{
        nodes: { ignored?: boolean; role?: { value?: string }; name?: { value?: string } }[];
      }>("Accessibility.queryAXTree", { nodeId: doc.root.nodeId, role: "button" });
      report.chromiumRoleQuery = raw;
      const ignored = raw.nodes.filter((n) => n.ignored && n.role?.value === "button");
      expect(ignored.length).toBeGreaterThan(0);
      for (const node of ignored) {
        const name = JSON.stringify(node.name?.value ?? "");
        await kit.run(`assert(await page.getByRole('button',{name:${name},exact:true}).count()===0,'ignored excluded');
assert(await page.getByRole('button',{name:${name},exact:true,includeHidden:true}).count()===1,'ignored included');`);
      }
    },
    "19",
  );

  acceptance(
    "20",
    "legacy adapters, local page declaration, lazy inventory and unsupported subset errors",
    async (kit) => {
      await kit.run(
        `const page={legacy:true};assert(page.legacy,'script page declaration');console.log((await listTabs()).length);`,
      );
      await kit.controller.handle({ type: "surface.open", url: kit.site.url("20") });
      const other = kit.ledger.binding(kit.ledger.active()!.surface.id)!.page;
      expect(kit.ledger.snapshot()).toHaveLength(2);
      const inventory = await kit.run(
        `const tabs=await listTabs();assert(tabs.length===2,'multi-tab inventory');console.log(JSON.stringify(tabs));`,
        { inventory: true },
      );
      expect(JSON.parse(inventory.stdout)).toHaveLength(2);
      await other.close();
      await kit.run(`const tabs=await listTabs();const current=await currentTab();assert(tabs.some(t=>t.targetId===current.targetId),'legacy inventory');
await fillInput('.legacy','replace');await fillInput('.legacy',' appended',{clear:false});
assert(await js("document.querySelectorAll('.legacy')[1].value")==='second','first match semantics');
await js("document.querySelector('#zip').focus();true");await pressKey('Enter',{modifiers:0});
const point=await js("(()=>{const r=document.querySelector('#legacy').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
await clickAt(point.x,point.y,{button:'left',clicks:1});
await fails(()=>page.frameLocator('iframe'),/TypeError.*frameLocator|frameLocator.*not supported/s);
await fails(()=>page.keyboard.down('Shift'),/TypeError.*down|down.*not supported/s);
await fails(()=>page.mouse.move(1,1),/TypeError.*move|move.*not supported/s);
await fails(()=>page.locator('#legacy').click({force:true}),/force.*not supported|unsupported.*force/is);`);
      expect(await kit.state()).toMatchObject({ counts: { legacy: 1 }, submissions: ["10014"] });
      expect(await kit.read("document.querySelector('.legacy').value")).toBe("replace appended");
    },
  );

  acceptance(
    "22",
    "locators, page.evaluate and js work on a site whose CSP forbids eval",
    async (kit, report) => {
      expect(await kit.read("fixture.evalAllowed")).toBe(false);
      const out = await kit.run(`const result={};
result.expression=await page.evaluate("document.title");
result.fn=await page.evaluate(() => document.title);
result.js=await js("document.title");
await page.getByRole('button',{name:'CSP action'}).click();
await page.getByLabel('CSP field').fill('strict');
result.value=await page.getByLabel('CSP field').inputValue();
result.element=await page.getByLabel('CSP field').evaluate((e,suffix)=>e.value+suffix,'!');
result.snapshot=await page.ariaSnapshot();
console.log(JSON.stringify(result));`);
      const result = JSON.parse(out.stdout) as Record<string, string>;
      report.result = result;
      expect(result).toMatchObject({
        expression: "Actions 22",
        fn: "Actions 22",
        js: "Actions 22",
        value: "strict",
        element: "strict!",
      });
      expect(result.snapshot).toContain('button "CSP action"');
      expect(await kit.state()).toMatchObject({ counts: { csp: 1 } });
    },
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
    "12-text",
    "text locators ignore head content such as the document title",
    async (kit) => {
      await kit.run(`await page.evaluate(()=>{document.title='Still usable';});
assert(await page.getByText('Still usable',{exact:true}).count()===1,'title text is not a match');
await page.getByText('Still usable',{exact:true}).click();`);
      expect((await kit.state()).counts).toEqual({ healthy: 1 });
    },
    "12",
  );

  acceptance(
    "05-number",
    "number fill rejects non-HTML numeric syntax and keeps the previous value",
    async (kit) => {
      await kit.run(`await page.locator('#number').fill('7');
for (const bad of ['0x10','0b10','+5','1.','1e','Infinity','1e309','-1e309']) {
  await fails(()=>page.locator('#number').fill(bad),/malformed/i);
  assert(await page.locator('#number').inputValue()==='7','unchanged after '+bad);
}
for (const good of ['-1.5','.5','1e3','0']) {
  await page.locator('#number').fill(good);
  assert(await page.locator('#number').inputValue()===good,'accepted '+good);
}`);
      expect((await kit.state()).inputs).toMatchObject({ number: { value: "0" } });
    },
    "05",
  );

  acceptance(
    "11-clear",
    "selectOption with an empty list clears single and multiple selects",
    async (kit) => {
      await kit.run(`await page.locator('#multi').selectOption(['a','c']);
assert(JSON.stringify(await page.getByLabel('Shipping').selectOption([]))==='[]','single cleared');
assert(JSON.stringify(await page.locator('#multi').selectOption([]))==='[]','multiple cleared');`);
      expect((await kit.state()).selected).toEqual([
        { id: "shipping", values: [] },
        { id: "multi", values: [] },
      ]);
    },
    "11",
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
    "15-released-handles",
    "an operation's object group is released and its handles stop resolving",
    async (kit, report) => {
      let handle: { objectId: unknown; sessionId?: string | undefined } | undefined;
      let control: string | undefined;
      let probed: string | undefined;
      const agent = (method: string, parameters: CdpParameters, sessionId?: string) =>
        sendAsAgent(
          (message) => kit.controller.handle(message),
          kit.sink.messages,
          method,
          parameters,
          sessionId,
        );
      kit.hooks.before = async (method, _parameters, sessionId) => {
        if (method !== "Target.detachFromTarget" || probed !== undefined) return;
        const used = kit.trace.find(
          (e) =>
            e.method === "Runtime.callFunctionOn" &&
            typeof e.parameters?.objectGroup === "string" &&
            e.parameters.objectGroup.startsWith("opensteer-op-"),
        );
        handle = { objectId: used?.parameters?.objectId, sessionId: used?.sessionId ?? sessionId };
        // A fresh object on the same live session must still resolve, so a failing
        // probe below means the handle was released, not that the session is gone.
        const fresh = await agent(
          "Runtime.evaluate",
          { expression: "document", objectGroup: "released-handles-control" },
          handle.sessionId,
        );
        control = await agent(
          "Runtime.callFunctionOn",
          {
            objectId: (fresh as { result: { objectId: string } }).result.objectId,
            functionDeclaration: "function() { return 1; }",
            returnByValue: true,
          },
          handle.sessionId,
        ).then(
          () => "resolved",
          (error: unknown) => String(error),
        );
        await agent(
          "Runtime.releaseObjectGroup",
          { objectGroup: "released-handles-control" },
          handle.sessionId,
        );
        probed = await agent(
          "Runtime.callFunctionOn",
          {
            objectId: handle.objectId as string,
            functionDeclaration: "function() { return 1; }",
            returnByValue: true,
          },
          handle.sessionId,
        ).then(
          () => "resolved",
          (error: unknown) => String(error),
        );
      };
      await kit.run(`await page.getByRole('button',{name:'Still usable'}).click();`);
      report.probe = { handle, control, probed };
      expect(typeof handle?.objectId).toBe("string");
      expect(control).toBe("resolved");
      expect(probed).toBeDefined();
      expect(probed).not.toBe("resolved");
      expect(
        kit.trace.some(
          (e) =>
            e.method === "Runtime.releaseObjectGroup" &&
            e.finished !== undefined &&
            e.error === undefined,
        ),
      ).toBe(true);
    },
    "12",
  );

  acceptance(
    "15-failed-op-release",
    "a program ending on a failed action still has its object group released before it detaches",
    async (kit) => {
      let delayed = 0;
      kit.hooks.before = async (method) => {
        if (method !== "Runtime.releaseObjectGroup") return;
        delayed++;
        await new Promise((resolve) => setTimeout(resolve, 500));
      };
      // Each program ends on an action whose group release is not awaited inline:
      // one past its deadline, one interrupted by a dialog the program answers.
      await kit.run(
        `await fails(()=>page.getByRole('button',{name:'Missing action'}).click({timeout:300}),/element was not found/);`,
      );
      await kit.navigate(kit.site.url("13"));
      await kit.run(
        `await fails(()=>page.locator('#click').click(),/dialog/i);await cdp('Page.handleJavaScriptDialog',{accept:true});`,
      );
      expect(delayed).toBeGreaterThan(0);
      const detaches = kit.trace.filter((e) => e.method === "Target.detachFromTarget");
      const groups = new Set(
        kit.trace.flatMap((e) =>
          typeof e.parameters?.objectGroup === "string" &&
          e.parameters.objectGroup.startsWith("opensteer-op-")
            ? [JSON.stringify([e.sessionId, e.parameters.objectGroup])]
            : [],
        ),
      );
      expect(groups.size).toBeGreaterThan(0);
      for (const group of groups) {
        const release = kit.trace.find(
          (e) =>
            e.method === "Runtime.releaseObjectGroup" &&
            JSON.stringify([e.sessionId, e.parameters?.objectGroup]) === group,
        );
        expect(release, group).toBeDefined();
        expect(release!.error, group).toBeUndefined();
        expect(release!.finished, group).toBeDefined();
        const detach = detaches.find((e) => e.at > release!.at);
        expect(release!.finished!, group).toBeLessThanOrEqual(detach!.at);
      }
    },
    "12",
  );

  acceptance(
    "15-slow-release",
    "a release slower than the grace on a page that still answers is awaited before the session detaches",
    async (kit) => {
      let delayed = 0;
      kit.hooks.before = async (method) => {
        if (method !== "Runtime.releaseObjectGroup") return;
        delayed++;
        await new Promise((resolve) => setTimeout(resolve, 2500));
      };
      // Each program ends on an action whose group release is not awaited inline:
      // one past its deadline, one interrupted by a dialog the program answers.
      await kit.run(
        `await fails(()=>page.getByRole('button',{name:'Missing action'}).click({timeout:300}),/element was not found/);`,
      );
      await kit.navigate(kit.site.url("13"));
      await kit.run(
        `await fails(()=>page.locator('#click').click(),/dialog/i);await cdp('Page.handleJavaScriptDialog',{accept:true});`,
      );
      // Replaying buffered events must not make the answered dialog look open again.
      await kit.run(
        `await fails(()=>page.locator('#click').click(),/dialog/i);await cdp('Page.handleJavaScriptDialog',{accept:true});drainEvents();`,
      );
      expect(delayed).toBeGreaterThan(0);
      const detaches = kit.trace.filter((e) => e.method === "Target.detachFromTarget");
      const groups = new Set(
        kit.trace.flatMap((e) =>
          typeof e.parameters?.objectGroup === "string" &&
          e.parameters.objectGroup.startsWith("opensteer-op-")
            ? [JSON.stringify([e.sessionId, e.parameters.objectGroup])]
            : [],
        ),
      );
      expect(groups.size).toBeGreaterThan(0);
      for (const group of groups) {
        const release = kit.trace.find(
          (e) =>
            e.method === "Runtime.releaseObjectGroup" &&
            JSON.stringify([e.sessionId, e.parameters?.objectGroup]) === group,
        );
        expect(release, group).toBeDefined();
        expect(release!.error, group).toBeUndefined();
        expect(release!.finished, group).toBeDefined();
        const detach = detaches.find((e) => e.at > release!.at);
        expect(release!.finished!, group).toBeLessThanOrEqual(detach!.at);
      }
    },
    "12",
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
    "15-stalled-move",
    "an action whose pointer move went unanswered leaves promptly without awaiting its group release",
    async (kit, report) => {
      kit.hooks.before = async (method, parameters) => {
        // Unanswered for longer than the release grace past the deadline: a stalled page.
        if (method === "Input.dispatchMouseEvent" && parameters?.type === "mouseMoved")
          await new Promise((resolve) => setTimeout(resolve, 4000));
        if (method === "Runtime.releaseObjectGroup")
          await new Promise((resolve) => setTimeout(resolve, 5000));
      };
      const out = await kit.run(
        `await fails(()=>page.getByRole('button',{name:'Still usable'}).click({timeout:500}),/Timeout/);`,
        { timeoutMs: 15_000 },
      );
      report.processElapsed = out.elapsedMs;
      // The page stopped answering inside the action, so leaving does not wait again.
      expect(out.elapsedMs).toBeLessThan(500 + 2000 + 1500);
      expect(
        kit.trace.filter(
          (e) => e.method === "Input.dispatchMouseEvent" && e.parameters?.type === "mousePressed",
        ),
      ).toHaveLength(0);
    },
    "12",
  );

  acceptance(
    "15-early-timer",
    "a settlement timer that wakes before its cutoff looks again, so a reply just before the cutoff keeps the release awaited",
    async (kit, report) => {
      // Wall-clock times from the harness's own stderr and from the bridge.
      let actionStart: number | undefined;
      let earlyWake: number | undefined;
      let moveReplySent: number | undefined;
      let started!: () => void;
      const actionStarted = new Promise<void>((resolve) => (started = resolve));
      kit.hooks.before = async (method, parameters) => {
        // The action's 500 ms deadline and 2 s grace put its cutoff at least
        // 2.5 s after its start. This reply goes out 500 ms before that.
        if (method === "Input.dispatchMouseEvent" && parameters?.type === "mouseMoved") {
          await actionStarted;
          await new Promise((resolve) => setTimeout(resolve, actionStart! + 2000 - Date.now()));
          moveReplySent = Date.now();
        }
        if (method === "Runtime.releaseObjectGroup")
          await new Promise((resolve) => setTimeout(resolve, 3500));
      };
      // After its action the program makes long timers wake a second early,
      // as an event loop may, and says when one does.
      const out = await kit.run(
        `process.stderr.write('[test] action-start '+Date.now()+'\\n');
await fails(()=>page.getByRole('button',{name:'Still usable'}).click({timeout:500}),/Timeout/);
const realSetTimeout=globalThis.setTimeout;
globalThis.setTimeout=(callback,ms,...rest)=>ms>=1500
  ?realSetTimeout(()=>{process.stderr.write('[test] early-wake '+Date.now()+'\\n');callback();},ms-1000,...rest)
  :realSetTimeout(callback,ms,...rest);`,
        {
          timeoutMs: 15_000,
          onStderrLine: (line) => {
            const [, kind, at] = /^\[test\] (action-start|early-wake) (\d+)$/u.exec(line) ?? [];
            if (kind === "action-start") {
              actionStart = Number(at);
              started();
            }
            if (kind === "early-wake") earlyWake ??= Number(at);
          },
        },
      );
      await traceSettled(kit);
      const cutoff = actionStart! + 500 + 2000;
      report.timing = { actionStart, earlyWake, moveReplySent, cutoff, exit: out.elapsedMs };
      // Preconditions: a settlement timer woke while the move was still
      // unanswered and well before the cutoff, and the reply went out early
      // enough to reach the harness before the cutoff.
      expect(actionStart).toBeDefined();
      expect(earlyWake).toBeDefined();
      expect(moveReplySent).toBeDefined();
      expect(earlyWake!).toBeLessThan(moveReplySent!);
      expect(earlyWake!).toBeLessThan(cutoff - 500);
      expect(moveReplySent!).toBeLessThan(cutoff - 300);
      report.groups = expectGroupsReleasedBeforeDetach(kit);
    },
    "12",
  );

  acceptance(
    "15-release-outlives-action",
    "a release still pending when an action that ended early reaches its deadline is awaited before detach",
    async (kit, report) => {
      kit.hooks.before = async (method) => {
        if (method === "Runtime.releaseObjectGroup")
          await new Promise((resolve) => setTimeout(resolve, 4000));
      };
      const out = await kit.run(
        `console.log(JSON.stringify({operationStart:Date.now()}));
await fails(()=>page.locator('.duplicate').click({timeout:3000}),/Strict mode violation/);`,
        { timeoutMs: 15_000 },
      );
      await traceSettled(kit);
      // The action's 3 s deadline starts after this harness-local reading, so
      // the budget computed from it is a lower bound, whatever binding took.
      const { operationStart } = z
        .object({ operationStart: z.number() })
        .parse(JSON.parse(out.stdout.trim().split("\n")[0]!));
      const release = kit.trace.find((e) => e.method === "Runtime.releaseObjectGroup")!;
      const wall = (at: number) => performance.timeOrigin + at;
      report.budgetLeftAtRelease = operationStart + 3000 - wall(release.at);
      report.releaseFinishedAfterDeadline = wall(release.finished!) - (operationStart + 3000);
      // Preconditions: the release was sent with most of the budget left and
      // stayed pending past the deadline.
      expect(report.budgetLeftAtRelease).toBeGreaterThanOrEqual(2500);
      expect(report.releaseFinishedAfterDeadline).toBeGreaterThan(0);
      report.groups = expectGroupsReleasedBeforeDetach(kit);
    },
    "02",
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

  for (const round of [1, 2, 3])
    acceptance(
      `15-deadline-soak-${round}`,
      "a 300 ms missing-element action, repeated, always has its slow release awaited",
      async (kit, report) => {
        kit.hooks.before = async (method) => {
          if (method === "Runtime.releaseObjectGroup")
            await new Promise((resolve) => setTimeout(resolve, 2500));
        };
        for (let iteration = 0; iteration < 5; iteration++)
          await kit.run(
            `await fails(()=>page.getByRole('button',{name:'Missing action'}).click({timeout:300}),/element was not found/);`,
          );
        report.groups = expectGroupsReleasedBeforeDetach(kit);
      },
      "12",
    );
});
