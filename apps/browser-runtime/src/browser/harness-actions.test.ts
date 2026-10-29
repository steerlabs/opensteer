import { describe, expect } from "vitest";
import { waitForBrowserState } from "./browser-test-lifecycle.js";
import { acceptance } from "./harness-actions.test-support.js";

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
});
