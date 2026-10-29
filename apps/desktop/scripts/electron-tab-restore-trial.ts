import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { nativeImage, webContents, type BrowserWindow, type WebContents } from "electron";
import { HostBootstrapSchema, BrowserTabOpenResultSchema } from "@opensteer/protocol";
import { z } from "zod";

const State = z.object({
  profileId: z.string(),
  p1: z.string(),
  pop: z.string(),
  f1: z.string(),
  oldSessions: z.array(z.string()),
  rows: z.array(z.object({ id: z.string(), title: z.string(), order: z.number() })),
  icons: z.array(z.object({ id: z.string(), ref: z.string() })),
  tabGroup: z.object({ id: z.string(), title: z.string(), color: z.literal("purple") }).nullable(),
  /** The person's saved order of these tabs after the drag phases. */
  order: z.array(z.string()).optional(),
});

/** Production Personal/Host/Runtime with temporary inputs and API/renderer observations. */
export async function runTabRestoreTrial(input: {
  root: string;
  trial: string;
  window: BrowserWindow;
  rpc: (method: string, body?: object) => Promise<unknown>;
  checkpointed: () => boolean;
}): Promise<void> {
  const { root, trial, window, rpc } = input;
  const fixture = z.url().parse(process.env.OPENSTEER_TAB_RESTORE_FIXTURE);
  const statePath = path.join(root, "tab-restore-state.json");
  const selection = async () =>
    z
      .object({
        url: z.string(),
        remembered: z.array(z.string()),
      })
      .parse(
        await window.webContents.executeJavaScript(`({
    url: location.href,
    remembered: Object.keys(localStorage)
      .filter(key => key.startsWith('opensteer.workspace.last-place.v1:'))
      .map(key => localStorage.getItem(key)),
  })`),
      );
  const recordSelection = async (phase: string) => {
    const value = await selection();
    writeFileSync(
      path.join(root, `${trial}.${phase}.selection.json`),
      JSON.stringify(value, null, 2),
    );
    return value;
  };

  let state = existsSync(statePath)
    ? State.parse(JSON.parse(readFileSync(statePath, "utf8")))
    : null;
  const bootstrap = async () => HostBootstrapSchema.parse(await rpc("bootstrap.get"));
  const rows = (value: Awaited<ReturnType<typeof bootstrap>>) =>
    value.browser.workspaceTabs?.flatMap((group) => group.tabs ?? []) ?? [];
  const targets = (value: Awaited<ReturnType<typeof bootstrap>>) =>
    value.browser.sessions
      .filter((session) => session.state === "ready")
      .flatMap((session) => session.tabCatalog?.tabs ?? []);
  const page = (pathname: string) =>
    webContents
      .getAllWebContents()
      .find((contents) => contents.getURL() === `${fixture}${pathname}`);
  const wait = async (assertion: () => Promise<boolean> | boolean, name: string) => {
    const deadline = Date.now() + 20_000;
    while (!(await assertion())) {
      assert(Date.now() < deadline, `Timed out: ${name}`);
      await delay(25);
    }
  };
  const record = async (phase: string) => {
    const value = await bootstrap();
    writeFileSync(
      path.join(root, `${trial}.${phase}.json`),
      JSON.stringify(
        {
          bootstrap: value,
          liveTargets: targets(value).length,
          memory: process.memoryUsage(),
          cpu: process.cpuUsage(),
        },
        null,
        2,
      ),
    );
    return value;
  };
  const click = async (
    selector: string,
    contents: WebContents = window.webContents,
    options: { button?: "left" | "right"; text?: string } = {},
  ) => {
    const readinessStarted = performance.now();
    const wasMoving = await contents.executeJavaScript(
      `Boolean(document.querySelector(${JSON.stringify(selector)})?.closest('.side-list[data-moving]'))`,
    );
    // A newly inserted/reordered row exists before RowMotion lands it. Native
    // hit testing must use the settled location, not an animation's first frame.
    await wait(
      async () =>
        Boolean(
          await contents.executeJavaScript(`(() => {
            const nodes=[...document.querySelectorAll(${JSON.stringify(selector)})];
            const node=${options.text === undefined ? "nodes[0]" : `nodes.find(node=>node.textContent.trim()===${JSON.stringify(options.text)})`};
            if (!node || node.closest('.side-list[data-moving]')) return false;
            const r=node.getBoundingClientRect();
            return r.width>0 && r.height>0 && node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
          })()`),
        ),
      `click target ready: ${selector}`,
    );
    const point = z.object({ x: z.number(), y: z.number(), sequence: z.number() }).parse(
      await contents.executeJavaScript(
        `(() => {
            if (!window.__restoreInputs) {
              window.__restoreInputs=[];
              for (const type of ['mousedown','mouseup','click','contextmenu'])
                document.addEventListener(type,event=>window.__restoreInputs.push({type,button:event.button,x:event.clientX,y:event.clientY,key:event.target.closest?.('[data-place-key]')?.dataset.placeKey??null}),true);
            }
            const nodes=[...document.querySelectorAll(${JSON.stringify(selector)})];
            const node=${options.text === undefined ? "nodes[0]" : `nodes.find(node=>node.textContent.trim()===${JSON.stringify(options.text)})`};
            if(!node) throw new Error('Missing '+${JSON.stringify(selector)});
            const r=node.getBoundingClientRect();
            return {x:r.x+r.width/2,y:r.y+r.height/2,sequence:window.__restoreInputs.length};
          })()`,
      ),
    );
    appendFileSync(
      path.join(root, `${trial}.inputs.jsonl`),
      `${JSON.stringify({ selector, ...options, ...point, wasMoving, readinessMs: performance.now() - readinessStarted, at: Date.now() })}\n`,
    );
    contents.sendInputEvent({ type: "mouseMove", x: Math.round(point.x), y: Math.round(point.y) });
    contents.sendInputEvent({
      type: "mouseDown",
      button: options.button ?? "left",
      clickCount: 1,
      x: Math.round(point.x),
      y: Math.round(point.y),
    });
    contents.sendInputEvent({
      type: "mouseUp",
      button: options.button ?? "left",
      clickCount: 1,
      x: Math.round(point.x),
      y: Math.round(point.y),
    });
    // sendInputEvent queues input; executeJavaScript alone is not a delivery
    // barrier. Do not let the next right-click overtake selection's left-click.
    try {
      await wait(
        async () =>
          Boolean(
            await contents.executeJavaScript(
              `window.__restoreInputs.slice(${point.sequence}).some(event=>event.type==='mouseup' && event.button===${options.button === "right" ? 2 : 0} && event.x===${Math.round(point.x)} && event.y===${Math.round(point.y)})`,
            ),
          ),
        `native mouseup delivered: ${selector}`,
      );
    } finally {
      writeFileSync(
        path.join(root, `${trial}.delivered-inputs.json`),
        JSON.stringify(await contents.executeJavaScript("window.__restoreInputs"), null, 2),
      );
    }
  };
  const select = async (id: string) => {
    const selector = `li[data-place-key$=":${id}"] .side-tab__main`;
    await wait(
      async () =>
        Boolean(
          await window.webContents.executeJavaScript(
            `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
          ),
        ),
      "sidebar row",
    );
    await click(selector);
    await wait(
      async () =>
        Boolean(
          await window.webContents.executeJavaScript(
            `document.querySelector(${JSON.stringify(selector)})?.getAttribute('aria-current')==='true'`,
          ),
        ),
      `tab selected: ${id}`,
    );
  };
  const newTab = async () => {
    await click('button[aria-label="New tab"]');
    await wait(
      async () =>
        Boolean(
          await window.webContents.executeJavaScript(
            'document.querySelector("section[aria-label=\\"New tab\\"]")',
          ),
        ),
      "New tab selection",
    );
  };
  const activate = (id: string) =>
    rpc("commands.dispatch", {
      type: "workspace.tab.activate",
      tabId: id,
      idempotencyKey: `restore:${id}`,
    });
  const close = (id: string) =>
    rpc("commands.dispatch", {
      type: "workspace.tab.close",
      tabId: id,
      idempotencyKey: `close:${id}`,
    });
  const screenshot = async (phase = "final", sidebarOnly = false) => {
    const rectangle = sidebarOnly
      ? z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).parse(
          await window.webContents.executeJavaScript(`(() => {
            const r=document.querySelector('.sidebar').getBoundingClientRect();
            return {x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)};
          })()`),
        )
      : undefined;
    writeFileSync(
      path.join(root, `${trial}.${phase}.sidebar.png`),
      (await window.webContents.capturePage(rectangle)).toPNG(),
    );
  };
  const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
  const checkIcons = async (value: Awaited<ReturnType<typeof bootstrap>>, phase: string) => {
    assert(state);
    const images: { id: string; src: string }[] = [];
    for (const expected of state.icons) {
      const tab = rows(value).find((row) => row.id === expected.id);
      if (!tab) continue;
      assert.equal(
        tab.iconRef,
        expected.ref,
        "Suspension and rebinding must preserve the icon reference",
      );
      const icon = z.object({ favicon: z.string() }).parse(
        await rpc("browser.tabIcon.get", {
          sessionId: tab.sessionId,
          iconRef: expected.ref,
        }),
      );
      const image = nativeImage.createFromDataURL(icon.favicon);
      images.push({ id: tab.id, src: icon.favicon });
      assert.deepEqual(image.getSize(), { width: 32, height: 32 });
      assert.deepEqual(
        [...image.toBitmap().subarray((16 * 32 + 16) * 4, (16 * 32 + 16) * 4 + 4)],
        tab.id === state.p1
          ? [255, 0, 0, 255]
          : tab.id === state.pop
            ? [0, 128, 0, 255]
            : [0, 0, 255, 255],
      );
      writeFileSync(
        path.join(root, `${trial}.${phase}.${tab.id}.png`),
        Buffer.from(icon.favicon.split(",")[1]!, "base64"),
      );
    }
    await wait(
      async () =>
        Boolean(
          await window.webContents.executeJavaScript(`(() => {
      const images=${JSON.stringify(images)};
      return images.every(({id,src}) => {
        const row=[...document.querySelectorAll('li[data-place-key]')].find(node=>node.dataset.placeKey.endsWith(':'+id));
        if (!row) return false;
        const image=row.querySelector('img');
        return image?.complete && image.src===src && image.naturalWidth===32 && image.naturalHeight===32;
      });
    })()`),
        ),
      "dormant sidebar icons decoded without opening their pages",
    );
    await screenshot(phase);
  };
  const groupPhases: { phase: string; status: "running" | "passed" | "failed"; error?: string }[] =
    [];
  const saveGroupPhases = () =>
    writeFileSync(
      path.join(root, `${trial}.tab-groups.json`),
      JSON.stringify({ trial, phases: groupPhases }, null, 2),
    );
  const groupPhase = async (phase: string, run: () => Promise<void>) => {
    const result: (typeof groupPhases)[number] = { phase, status: "running" };
    groupPhases.push(result);
    saveGroupPhases();
    try {
      await run();
      result.status = "passed";
    } catch (error) {
      result.status = "failed";
      result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
      throw error;
    } finally {
      saveGroupPhases();
    }
  };
  const dom = (expression: string) => window.webContents.executeJavaScript(expression);
  const has = async (selector: string) =>
    Boolean(await dom(`Boolean(document.querySelector(${JSON.stringify(selector)}))`));
  const menuItem = async (text: string) => {
    const selector = '.popover [role="menuitem"]';
    await wait(
      async () =>
        Boolean(
          await dom(
            `[...document.querySelectorAll(${JSON.stringify(selector)})].some(node=>node.textContent.trim()===${JSON.stringify(text)})`,
          ),
        ),
      `menu item ${text}`,
    );
    await click(selector, window.webContents, { text });
  };
  const key = (keyCode: string) => {
    appendFileSync(path.join(root, `${trial}.inputs.jsonl`), `${JSON.stringify({ keyCode })}\n`);
    window.webContents.sendInputEvent({ type: "keyDown", keyCode });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode });
  };
  const addMenu = async (id: string) => {
    const selector = `li[data-place-key$=":${id}"] .side-tab__main`;
    await wait(() => has(selector), `tab menu row ${id}`);
    await click(selector, window.webContents, { button: "right" });
    await wait(() => has(".popover--tab-menu"), "tab menu opened");
    await menuItem("Add to group");
  };
  const groupHeader = () => {
    assert(state?.tabGroup);
    return `[data-tab-group-id="${state.tabGroup.id}"] .side-tab-group__main`;
  };
  const editGroup = async () => {
    await click(groupHeader(), window.webContents, { button: "right" });
    await wait(() => has('[role="dialog"][aria-label="Edit tab group"]'), "group editor opened");
  };
  const memberIds = () => {
    assert(state);
    return [state.p1, state.f1];
  };
  const liveIds = (value: Awaited<ReturnType<typeof bootstrap>>): string[] =>
    targets(value)
      .map((tab) => tab.id)
      .sort();
  const groupDom = async () => {
    assert(state?.tabGroup);
    return z
      .object({
        title: z.string().nullable(),
        expanded: z.string().nullable(),
        active: z.boolean(),
        color: z.string().nullable(),
        members: z.array(z.object({ id: z.string(), present: z.boolean(), grouped: z.boolean() })),
      })
      .parse(
        await dom(`(() => {
      const header=document.querySelector('[data-tab-group-id="'+${JSON.stringify(state.tabGroup.id)}+'"]');
      const rows=[...document.querySelectorAll('li[data-place-key]')];
      return {
        title:header?.querySelector('.side-tab-group__chip')?.textContent??null,
        expanded:header?.querySelector('.side-tab-group__main')?.getAttribute('aria-expanded')??null,
        active:header?.classList.contains('is-active')??false,
        color:header?.style.getPropertyValue('--tab-group-color').trim()??null,
        members:${JSON.stringify(memberIds())}.map(id=>{const row=rows.find(node=>node.dataset.placeKey.endsWith(':'+id)); return {id,present:!!row,grouped:row?.classList.contains('side-tab--grouped')??false};})
      };
    })()`),
      );
  };
  const checkGroup = async (phase: string, collapsed: boolean) => {
    assert(state?.tabGroup);
    const expected = state.tabGroup;
    const ids = memberIds().sort();
    await wait(async () => {
      const value = await bootstrap();
      const group = value.browser.tabGroups?.groups.find((group) => group.id === expected.id);
      const observed = await groupDom();
      return (
        value.browser.tabGroupsVersion === 1 &&
        group?.title === expected.title &&
        group.color === expected.color &&
        group.collapsed === collapsed &&
        JSON.stringify([...group.tabIds].sort()) === JSON.stringify(ids) &&
        observed.title === expected.title &&
        observed.expanded === String(!collapsed) &&
        observed.color === `var(--tab-group-${expected.color})` &&
        observed.members.every(
          (member) => member.present === !collapsed && member.grouped === !collapsed,
        )
      );
    }, phase);
    const value = await record(phase);
    const group = value.browser.tabGroups?.groups.find((group) => group.id === expected.id);
    assert.equal(value.browser.tabGroupsVersion, 1);
    assert(group);
    assert.deepEqual(
      {
        title: group.title,
        color: group.color,
        collapsed: group.collapsed,
        tabIds: [...group.tabIds].sort(),
      },
      { title: expected.title, color: expected.color, collapsed, tabIds: ids },
    );
    const observed = await groupDom();
    assert.equal(observed.title, expected.title);
    assert.equal(observed.expanded, String(!collapsed));
    assert.equal(observed.color, `var(--tab-group-${expected.color})`);
    for (const member of observed.members) {
      assert.equal(member.present, !collapsed);
      assert.equal(member.grouped, !collapsed);
    }
    writeFileSync(path.join(root, `${trial}.${phase}.dom.json`), JSON.stringify(observed, null, 2));
    await screenshot(phase, true);
    return value;
  };
  const tabRow = (id: string) => `li[data-place-key$=":${id}"]`;
  const headerRow = () => {
    assert(state?.tabGroup);
    return `li[data-tab-group-id="${state.tabGroup.id}"]`;
  };
  const rowPoint = async (selector: string) =>
    z.object({ x: z.number(), y: z.number(), height: z.number(), right: z.number() }).parse(
      await dom(`(() => {
        const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        const side=document.querySelector('.sidebar').getBoundingClientRect();
        return {x:r.x+Math.min(60,r.width/3),y:r.y+r.height/2,height:r.height,right:side.right};
      })()`),
    );
  /** The web rows as the sidebar shows them: tab IDs, and `group:` for a header. */
  const sidebarOrder = async () =>
    z
      .array(z.string())
      .parse(
        await dom(
          `[...document.querySelector('.side-section--tabs .side-list').children].flatMap(node => node.dataset.tabGroupId ? ['group:'+node.dataset.tabGroupId] : node.dataset.group==='web' ? [node.dataset.placeKey.split(':').pop()] : [])`,
        ),
      );
  const pointer = (type: "mouseMove" | "mouseDown" | "mouseUp", x: number, y: number) =>
    window.webContents.sendInputEvent({
      type,
      x: Math.round(x),
      y: Math.round(y),
      button: "left",
      clickCount: 1,
      ...(type === "mouseMove" && pressed ? { modifiers: ["leftbuttondown" as const] } : {}),
    });
  let pressed = false;
  const glide = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
    for (let step = 1; step <= 12; step++) {
      pointer(
        "mouseMove",
        from.x + ((to.x - from.x) * step) / 12,
        from.y + ((to.y - from.y) * step) / 12,
      );
      await delay(16);
    }
  };
  /**
   * Presses a row, lifts it, then glides to the y `target` gives once it has lifted
   * (a group folds first), optionally out over the native page and back, and drops.
   */
  const dragRow = async (
    selector: string,
    target: () => Promise<number>,
    options: { readonly overPage?: boolean; readonly escape?: boolean } = {},
  ) => {
    const start = await rowPoint(selector);
    await dom(`(() => {
      const log = [];
      window.__dragLog = log;
      const at = () => Math.round(performance.now());
      for (const type of ["blur", "focus"])
        window.addEventListener(type, () => log.push([at(), type]), true);
      for (const type of ["lostpointercapture", "pointercancel", "pointerup", "pointerdown"])
        document.addEventListener(type, (event) => log.push([at(), type, Math.round(event.clientX), Math.round(event.clientY), event.target?.closest?.("[data-motion-key]")?.dataset.motionKey ?? null]), true);
      const list = document.querySelector(".side-section--tabs .side-list");
      list.addEventListener("scroll", () => log.push([at(), "scroll", list.scrollTop, list.clientHeight]));
      new ResizeObserver(() => log.push([at(), "resize", list.clientHeight, list.scrollHeight, list.style.maxHeight])).observe(list);
      new MutationObserver((records) => {
        for (const record of records)
          log.push([at(), "attr", record.attributeName, record.target.dataset?.motionKey ?? "list", record.target.getAttribute(record.attributeName)]);
      }).observe(list, { attributes: true, subtree: true, attributeFilter: ["data-sorting", "data-sort", "data-sort-place"] });
    })()`);
    appendFileSync(
      path.join(root, `${trial}.inputs.jsonl`),
      `${JSON.stringify({ drag: selector, ...options })}\n`,
    );
    pointer("mouseMove", start.x, start.y);
    pointer("mouseDown", start.x, start.y);
    pressed = true;
    await glide(start, { x: start.x, y: start.y + 10 });
    await wait(() => has('.side-list > [data-sort="lifted"]'), "row lifted");
    await dom(`(() => {
      const list = document.querySelector(".side-section--tabs .side-list");
      window.__dragLog?.push([Math.round(performance.now()), "lifted", list.scrollTop, list.clientHeight, list.scrollHeight,
        [...list.children].map((node) => [node.dataset.motionKey?.slice(-8) ?? node.className, node.offsetTop, node.style.translate])]);
    })()`);
    await wait(async () => !(await has(".side-list[data-moving]")), "lifted rows settled");
    let at = { x: start.x, y: start.y + 10 };
    const y = await target();
    if (options.overPage) {
      // Across the native page and back: the overlay keeps the drag in the sidebar's hands.
      const page = { x: start.right + 320, y };
      await glide(at, page);
      await wait(
        () => has('.side-list > [data-sort="away"]'),
        "away from the sidebar the row dims",
      );
      at = page;
    }
    await glide(at, { x: start.x, y });
    await delay(260);
    if (options.escape) key("Escape");
    // The list as the release finds it, for a failure report.
    await dom(`(() => {
      const list = document.querySelector(".side-section--tabs .side-list");
      window.__dragLog?.push([Math.round(performance.now()), "before-up", list.scrollTop, list.clientHeight,
        [...list.children].map((node) => [node.dataset.motionKey?.slice(-8) ?? node.className, node.offsetTop, node.offsetHeight, node.style.translate, node.dataset.sort ?? null])]);
    })()`);
    pointer("mouseUp", start.x, y);
    pressed = false;
    await wait(async () => !(await has(".side-list[data-sorting]")), "drag finished");
    await wait(async () => !(await has(".side-list[data-moving]")), "dropped rows settled");
  };
  const expectOrder = async (phase: string, shown: string[], saved: string[]) => {
    assert(state);
    const ours = [state.p1, state.pop, state.f1];
    const savedOrder = async () => {
      const value = await bootstrap();
      return {
        order: value.browser.tabGroups?.order?.filter((id) => ours.includes(id)),
        groups: value.browser.tabGroups?.groups,
      };
    };
    try {
      await wait(
        async () =>
          JSON.stringify(await sidebarOrder()) === JSON.stringify(shown) &&
          JSON.stringify((await savedOrder()).order) === JSON.stringify(saved),
        phase,
      );
    } catch (error) {
      // What the sidebar, the Host and any message showed when the order did not arrive.
      writeFileSync(
        path.join(root, `${trial}.${phase}.failed.json`),
        JSON.stringify(
          {
            expected: { shown, saved },
            shown: await sidebarOrder(),
            saved: await savedOrder(),
            toasts: await dom(
              `[...document.querySelectorAll(".toast__message")].map((node) => node.textContent)`,
            ),
            log: await dom("window.__dragLog ?? null"),
          },
          null,
          2,
        ),
      );
      await screenshot(`${phase}-failed`, true);
      throw error;
    }
    await record(phase);
    await screenshot(phase, true);
  };
  const createGroup = async () => {
    assert(state);
    await addMenu(state.p1);
    await menuItem("New group");
    const title = "Restore research";
    await wait(
      async () =>
        Boolean(await dom(`document.activeElement?.getAttribute('aria-label')==='Group title'`)),
      "new group editor title focused",
    );
    window.webContents.focus();
    appendFileSync(path.join(root, `${trial}.inputs.jsonl`), `${JSON.stringify({ title })}\n`);
    for (const character of title)
      window.webContents.sendInputEvent({ type: "char", keyCode: character });
    key("Enter");
    await wait(
      async () =>
        Boolean(
          (await bootstrap()).browser.tabGroups?.groups.some(
            (group) => group.title === title && group.tabIds.some((id) => id === state!.p1),
          ),
        ),
      "group title saved by Enter",
    );
    const created = (await bootstrap()).browser.tabGroups!.groups.find(
      (group) => group.title === title && group.tabIds.some((id) => id === state!.p1),
    )!;
    state.tabGroup = { id: created.id, title, color: "purple" };
    await addMenu(state.f1);
    await menuItem(title);
    await wait(
      async () =>
        (await bootstrap()).browser.tabGroups?.groups.find(
          (group) => group.id === state!.tabGroup!.id,
        )?.tabIds.length === 2,
      "second tab joined through its menu",
    );
    await editGroup();
    await click('[role="dialog"][aria-label="Edit tab group"] button[aria-label="purple"]');
    await wait(
      async () =>
        (await bootstrap()).browser.tabGroups?.groups.find(
          (group) => group.id === state!.tabGroup!.id,
        )?.color === "purple",
      "group recoloured through editor",
    );
    key("Escape");
    await wait(
      async () => !(await has('[role="dialog"][aria-label="Edit tab group"]')),
      "group editor dismissed",
    );
  };
  const reopenGroupMember = async (id: string, phase: string) => {
    const before = await bootstrap();
    assert(!liveIds(before).includes(id), "The selected member must still be asleep");
    await click(groupHeader());
    const expanded = await checkGroup(`${phase}-expanded`, false);
    assert.deepEqual(liveIds(expanded), liveIds(before), "Expanding a group must open no pages");
    await select(id);
    await wait(
      async () => targets(await bootstrap()).some((tab) => tab.id === id),
      "only selected group member reopened",
    );
    const selected = await checkGroup(phase, false);
    assert.deepEqual(
      liveIds(selected),
      [...liveIds(before), id].sort(),
      "Selecting a member reopens exactly that tab",
    );
  };
  await wait(
    async () =>
      Boolean(
        await window.webContents.executeJavaScript(
          'document.querySelector("[aria-labelledby=sidebar-tabs]")',
        ),
      ),
    "workspace sidebar",
  );

  const initial = HostBootstrapSchema.parse(
    z
      .object({ ok: z.literal(true), data: z.unknown() })
      .parse(JSON.parse(readFileSync(path.join(root, `${trial}.before-window.json`), "utf8"))).data,
  );
  assert.equal(
    targets(initial).length,
    0,
    "Bootstrap must expose dormant rows before any page opens",
  );
  if (trial === "restore-normal") {
    assert(state);
    assert.deepEqual(
      rows(initial).map(({ id, title, order }) => ({ id, title, order })),
      state.rows,
    );
    assert.deepEqual(
      rows(initial).map((row) => ({ id: row.id, ref: row.iconRef })),
      state.icons,
    );
  }

  if (trial === "restore-before") {
    const created = z.object({ profile: z.object({ id: z.string() }) }).parse(
      await rpc("commands.dispatch", {
        type: "browser.profile.create",
        idempotencyKey: randomUUID(),
        input: { name: "Tab restoration" },
      }),
    );
    const p1 = BrowserTabOpenResultSchema.parse(
      await rpc("commands.dispatch", {
        type: "browser.tab.open",
        identity: { kind: "profile", profileId: created.profile.id },
        url: `${fixture}/p1`,
        idempotencyKey: randomUUID(),
      }),
    );
    const p2 = BrowserTabOpenResultSchema.parse(
      await rpc("commands.dispatch", {
        type: "browser.tab.open",
        sessionId: p1.sessionId,
        url: `${fixture}/p2`,
        idempotencyKey: randomUUID(),
      }),
    );
    const f1 = BrowserTabOpenResultSchema.parse(
      await rpc("commands.dispatch", {
        type: "browser.tab.open",
        identity: { kind: "guest" },
        url: `${fixture}/f1`,
        idempotencyKey: randomUUID(),
      }),
    );
    assert.notEqual(p1.sessionId, f1.sessionId);
    assert.equal(p1.session.profileId, created.profile.id);
    assert.equal(f1.session.profileId, null);
    await wait(() => Boolean(page("/p1") && page("/f1")), "fixture pages");
    await click("#popup", page("/p1")!);
    await wait(
      async () => rows(await bootstrap()).some((row) => row.title === "Restore /pop"),
      "committed popup",
    );
    const popup = rows(await bootstrap()).find((row) => row.title === "Restore /pop")!;
    await close(p2.tabId);
    await select(popup.id);
    await wait(() => input.checkpointed(), "profile checkpoint");
    await wait(
      async () =>
        rows(await bootstrap()).length === 3 && rows(await bootstrap()).every((row) => row.iconRef),
      "durable site icons",
    );
    const value = await record("committed");
    assert.equal(rows(value).length, 3);
    state = {
      profileId: created.profile.id,
      p1: p1.tabId,
      pop: popup.id,
      f1: f1.tabId,
      oldSessions: [p1.sessionId, f1.sessionId],
      rows: rows(value).map(({ id, title, order }) => ({ id, title, order })),
      icons: rows(value).map((row) => ({ id: row.id, ref: z.string().parse(row.iconRef) })),
      tabGroup: null,
    };
    const group = value.browser.workspaceTabs!.find((group) =>
      group.tabs?.some((tab) => tab.id === p1.tabId),
    )!;
    assert.deepEqual(
      group.tabs!.map((row) => row.id),
      [p1.tabId, popup.id],
    );
    save();
    await checkIcons(value, "acquired-icons");
    await groupPhase("groups-create-and-collapse", async () => {
      await createGroup();
      await checkGroup("tab-groups-expanded", false);
      await click(groupHeader());
      await checkGroup("tab-groups-collapsed", true);
      save();
    });
    await groupPhase("drag-and-drop", async () => {
      assert(state?.tabGroup);
      const { p1, pop, f1 } = state;
      const group = `group:${state.tabGroup.id}`;
      await click(groupHeader());
      await checkGroup("drag-expanded", false);
      // New tabs land at the bottom, and a group forms where its first tab stood.
      await expectOrder("drag-start", [group, p1, f1, pop], [p1, f1, pop]);
      await dom(`(() => {
        const state = { frames: [], longTasks: [] };
        window.__dragFrames = state;
        new PerformanceObserver((list) => { for (const entry of list.getEntries()) state.longTasks.push(entry.duration); }).observe({ type: "longtask" });
        let last = performance.now();
        const tick = (now) => { if (document.querySelector(".side-list[data-sorting]")) state.frames.push(now - last); last = now; requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      })()`);
      await dragRow(tabRow(pop), async () => (await rowPoint(headerRow())).y);
      await expectOrder("drag-before-group", [pop, group, p1, f1], [pop, p1, f1]);
      writeFileSync(
        path.join(root, `${trial}.drag-frames.json`),
        JSON.stringify(await dom("window.__dragFrames"), null, 2),
      );
      // From above, a tab dropped on a member's middle lands right after it, inside the group.
      await dragRow(tabRow(pop), async () => (await rowPoint(tabRow(p1))).y);
      await expectOrder("drag-into-group", [group, p1, pop, f1], [p1, pop, f1]);
      await dragRow(
        tabRow(pop),
        async () => {
          const last = await rowPoint(tabRow(f1));
          return last.y + last.height * 0.45;
        },
        { overPage: true },
      );
      await expectOrder("drag-out-over-page", [group, p1, f1, pop], [p1, f1, pop]);
      await dragRow(headerRow(), async () => (await rowPoint(tabRow(pop))).y);
      await expectOrder("drag-group", [pop, group, p1, f1], [pop, p1, f1]);
      await dom(
        `document.querySelector(${JSON.stringify(`${tabRow(pop)} .side-tab__main`)}).focus()`,
      );
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Down", modifiers: ["meta"] });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Down", modifiers: ["meta"] });
      await expectOrder("keyboard-into-group", [group, pop, p1, f1], [pop, p1, f1]);
      assert(
        await dom(
          `document.activeElement?.closest('li')?.dataset.placeKey?.endsWith(':${pop}') ?? false`,
        ),
        "the moved tab keeps focus",
      );
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Up", modifiers: ["meta"] });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Up", modifiers: ["meta"] });
      await expectOrder("keyboard-out-of-group", [pop, group, p1, f1], [pop, p1, f1]);
      await dragRow(tabRow(pop), async () => (await rowPoint(tabRow(f1))).y, { escape: true });
      await expectOrder("drag-escape", [pop, group, p1, f1], [pop, p1, f1]);
      await click(groupHeader());
      await checkGroup("drag-collapsed", true);
      state.order = [pop, p1, f1];
      save();
    });
  } else {
    assert(state);
    if (trial === "restore-normal") {
      await wait(() => Boolean(page("/pop#/document/42")), "automatic selected-tab reopening");
      await wait(async () => {
        const actual = rows(await bootstrap()).map(({ id, title, order }) => ({
          id,
          title,
          order,
        }));
        return JSON.stringify(actual) === JSON.stringify(state!.rows);
      }, "reopened tab titles");
      const value = await record("reopened");
      assert.deepEqual(
        rows(value).map(({ id, title, order }) => ({ id, title, order })),
        state.rows,
      );
      assert.equal(targets(value).length, 1);
      await groupPhase("order-survives-quit", async () => {
        assert(state?.order && state.tabGroup);
        await expectOrder("order-restored", [state.pop, `group:${state.tabGroup.id}`], state.order);
      });
      await groupPhase("groups-survive-quit", async () => {
        await checkGroup("tab-groups-restored-collapsed", true);
        for (const id of memberIds()) {
          assert(!liveIds(value).includes(id), "Group membership must not reopen sleeping tabs");
          assert.equal(rows(value).find((tab) => tab.id === id)?.state, "suspended");
        }
      });
      await groupPhase("groups-expand-without-opening-pages", async () => {
        await click(groupHeader());
        const expanded = await checkGroup("tab-groups-restored-expanded", false);
        assert.deepEqual(liveIds(expanded), liveIds(value));
        await checkIcons(value, "partial-restore-icons");
        await click(groupHeader());
        await checkGroup("tab-groups-before-member-selection", true);
      });
      for (const id of state.oldSessions)
        await assert.rejects(rpc("browser.tabs.get", { sessionId: id }));
      await screenshot("reopened");
      await newTab();
      await close(state.pop);
      assert(
        rows(await bootstrap()).some((row) => row.id === state!.p1),
        "Closing last live tab must retain its dormant sibling",
      );
      const opened = await Promise.all([activate(state.p1), activate(state.p1)]);
      const bindings = opened.map(
        (result) => z.object({ session: z.object({ id: z.string() }) }).parse(result).session.id,
      );
      assert.equal(bindings[0], bindings[1]);
      await wait(() => Boolean(page("/p1")), "saved profile reopening");
      assert.equal(targets(await bootstrap()).filter((tab) => tab.id === state!.p1).length, 1);
      assert.equal(
        await page("/p1")!.executeJavaScript("localStorage.getItem('restore-proof')"),
        "saved",
      );
      assert.match(
        z.string().parse(await page("/p1")!.executeJavaScript("document.cookie")),
        /restore-proof=saved/u,
      );
      await groupPhase("groups-reopen-guest-only", async () => {
        await reopenGroupMember(state!.f1, "tab-groups-reopened-guest");
      });
      await wait(() => Boolean(page("/f1")), "Guest reopening");
      assert.equal(
        await page("/f1")!.executeJavaScript("localStorage.getItem('restore-proof')"),
        null,
      );
      assert.equal(await page("/f1")!.executeJavaScript("document.cookie"), "");
      await click(groupHeader());
      await checkGroup("tab-groups-before-second-quit", true);
      await newTab();
    } else if (trial === "restore-crash") {
      const empty = await record("new-tab");
      assert.equal(targets(empty).length, 0);
      await groupPhase("groups-survive-second-launch", async () => {
        await checkGroup("tab-groups-before-crash", true);
        for (const id of memberIds())
          assert.equal(rows(empty).find((tab) => tab.id === id)?.state, "suspended");
      });
      await Promise.allSettled([activate(state.f1), close(state.f1)]);
      await wait(
        async () => !rows(await bootstrap()).some((row) => row.id === state!.f1) && !page("/f1"),
        "close wins activation",
      );
      const f1 = BrowserTabOpenResultSchema.parse(
        await rpc("commands.dispatch", {
          type: "browser.tab.open",
          identity: { kind: "guest" },
          url: `${fixture}/f1b`,
          idempotencyKey: randomUUID(),
        }),
      );
      state.f1 = f1.tabId;
      await wait(
        async () =>
          rows(await bootstrap()).some(
            (row) => row.id === state!.f1 && row.title === "Restore /f1b",
          ),
        "committed crash URL",
      );
      await select(state.f1);
      await groupPhase("groups-join-replacement-before-crash", async () => {
        assert(state?.tabGroup);
        await addMenu(state.f1);
        await menuItem(state.tabGroup.title);
        await checkGroup("tab-groups-replacement-collapsed", true);
        save();
      });
      // This trial crashes the page during navigation, after selection is saved.
      // Chromium buffers localStorage writes; the historical green runs happened
      // to drain them, while faster runs restarted at the preceding New tab.
      await wait(
        async () =>
          (await selection()).remembered.some(
            (value) =>
              z.object({ tabId: z.string() }).safeParse(JSON.parse(value)).data?.tabId ===
              state!.f1,
          ),
        "selected crash tab remembered",
      );
      window.webContents.session.flushStorageData();
      await recordSelection("before-crash");
      await record("before-hang");
      const live = page("/f1b");
      assert(live);
      void live.loadURL(`${fixture}/hang`).catch(() => undefined);
    } else if (trial === "restore-after-crash") {
      await recordSelection("startup");
      await wait(() => Boolean(page("/f1b")), "last committed URL after crash");
      await wait(
        async () =>
          rows(await bootstrap()).some(
            (row) => row.id === state!.f1 && row.title === "Restore /f1b",
          ),
        "recovered tab title",
      );
      const value = await record("recovered");
      assert.equal(new Set(rows(value).map((row) => row.id)).size, rows(value).length);
      assert(rows(value).some((row) => row.id === state!.f1 && row.title === "Restore /f1b"));
      await groupPhase("groups-survive-crash", async () => {
        await checkGroup("tab-groups-crash-restored-collapsed", true);
        assert.deepEqual(liveIds(value), [state!.f1]);
        assert.equal(rows(value).find((tab) => tab.id === state!.p1)?.state, "suspended");
        assert.equal(
          (await groupDom()).active,
          true,
          "The collapsed group marks its selected member",
        );
      });
      await groupPhase("groups-reopen-profile-only", async () => {
        await reopenGroupMember(state!.p1, "tab-groups-crash-reopened-profile");
      });
      await wait(() => Boolean(page("/p1")), "profile checkpoint after crash");
      assert.equal(
        await page("/p1")!.executeJavaScript("localStorage.getItem('restore-proof')"),
        "saved",
      );
      const control = BrowserTabOpenResultSchema.parse(
        await rpc("commands.dispatch", {
          type: "browser.tab.open",
          identity: { kind: "profile", profileId: state.profileId },
          url: `${fixture}/control`,
          idempotencyKey: randomUUID(),
        }),
      );
      await wait(
        async () =>
          rows(await bootstrap()).some(
            (tab) => tab.id === control.tabId && tab.title === "Restore /control",
          ),
        "unrelated control tab committed",
      );
      await groupPhase("groups-ungroup-keeps-tabs", async () => {
        const before = await bootstrap();
        assert(state?.tabGroup);
        const groupId = state.tabGroup.id;
        await editGroup();
        await menuItem("Ungroup");
        await wait(
          async () =>
            !(await bootstrap()).browser.tabGroups?.groups.some((group) => group.id === groupId) &&
            !(await has(`[data-tab-group-id="${groupId}"]`)),
          "group removed without closing tabs",
        );
        const after = await record("tab-groups-ungrouped");
        assert.deepEqual(
          rows(after)
            .map((tab) => tab.id)
            .sort(),
          rows(before)
            .map((tab) => tab.id)
            .sort(),
        );
        assert.deepEqual(liveIds(after), liveIds(before));
        for (const id of memberIds()) assert(await has(`li[data-place-key$=":${id}"]`));
        await screenshot("tab-groups-ungrouped", true);
      });
      await groupPhase("groups-close-exact-members", async () => {
        await createGroup();
        const before = await checkGroup("tab-groups-before-close", false);
        assert(state?.tabGroup);
        const groupId = state.tabGroup.id;
        const ids = new Set(memberIds());
        assert(rows(before).some((tab) => tab.id === control.tabId));
        await editGroup();
        await menuItem("Close group");
        await wait(async () => {
          const value = await bootstrap();
          return (
            memberIds().every((id) => !rows(value).some((tab) => tab.id === id)) &&
            !value.browser.tabGroups?.groups.some((group) => group.id === groupId) &&
            !(await has(`[data-tab-group-id="${groupId}"]`))
          );
        }, "Close group removed exactly its tabs and header");
        const after = await record("tab-groups-closed");
        assert.deepEqual(
          rows(after)
            .map((tab) => tab.id)
            .sort(),
          rows(before)
            .filter((tab) => !ids.has(tab.id))
            .map((tab) => tab.id)
            .sort(),
        );
        assert.deepEqual(
          liveIds(after),
          liveIds(before).filter((id) => !ids.has(id)),
        );
        assert(rows(after).some((tab) => tab.id === control.tabId));
        for (const id of memberIds()) assert(!(await has(`li[data-place-key$=":${id}"]`)));
        await screenshot("tab-groups-closed", true);
      });
    } else throw new Error(`Unknown restore phase ${trial}`);
  }
  await screenshot();
  writeFileSync(
    path.join(root, `${trial}.coverage.json`),
    JSON.stringify(
      {
        phase: trial,
        assertionsPassed: true,
        tabGroups: groupPhases,
        notCovered: [
          "real agent Run provenance and stale agent CDP",
          "trigger/watch bridge",
          "profile deletion",
        ],
      },
      null,
      2,
    ),
  );
}
