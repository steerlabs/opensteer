/** Tab group interaction evidence in headless Chromium, including focus and narrow layouts. */
import type { MockHostClient } from "@opensteer/client/mock";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { expectThat, finishJourney, journeyChecks, openMockWeb } from "./mock-web-journey.js";

const artifactDirectory = path.resolve(
  process.env.OPENSTEER_TAB_GROUPS_EVIDENCE_DIR ??
    path.join(tmpdir(), "opensteer-tab-groups-evidence/web"),
);
await mkdir(artifactDirectory, { recursive: true });
const { checks, check, abort } = journeyChecks();
const web = await openMockWeb("opensteer-tab-groups-web");
try {
  const context = await web.browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route(
    (url) => url.origin !== web.origin,
    (route) => route.fulfill({ body: "", status: 204 }),
  );
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(web.origin);
  const rows = page.locator('.side-tab[data-kind="page"]');
  await rows.first().waitFor();
  // The mock seeds a group of its own; this journey builds and follows one group alone.
  await page.evaluate(async () => {
    const client = Reflect.get(window, "opensteerMock") as MockHostClient;
    for (const item of client.getSnapshot().tabs.layout.items)
      if (item.kind === "group") await client.deleteTabGroup(item.group.groupId);
  });
  await page.locator(".side-tab-group__main").waitFor({ state: "detached" });
  const firstKey = await rows.first().getAttribute("data-place-key");
  const keys = await rows.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-place-key")!),
  );
  const secondKey = keys.find((key) => key !== firstKey)!;
  const first = () => page.locator(`.side-tab[data-place-key="${firstKey}"] .side-tab__main`);
  const second = () => page.locator(`.side-tab[data-place-key="${secondKey}"] .side-tab__main`);
  const header = page.locator(".side-tab-group__main");
  const title = page.getByRole("textbox", { name: "Group title" });
  const edit = async () => {
    await header.hover();
    await page.getByRole("button", { name: "Edit Research", exact: true }).click();
  };
  const shot = (name: string) => page.screenshot({ path: path.join(artifactDirectory, name) });
  await check("a tab creates a named group and focuses its editor", async () => {
    await first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Add to group", exact: true }).click();
    await page.getByRole("menu", { name: "Add to group", exact: true }).evaluate(async (node) => {
      await Promise.all(node.getAnimations().map((animation) => animation.finished));
    });
    await shot("add-to-group.png");
    await page.getByRole("menuitem", { name: "New group", exact: true }).click();
    await title.waitFor();
    const focused = await title.evaluate((input) => document.activeElement === input);
    expectThat({ focused }, focused, "the group title did not receive focus");
    await title.fill("Research");
    await title.press("Enter");
    await page.getByRole("button", { name: "Research, 1 tabs", exact: true }).waitFor();
    return { focused, firstKey };
  });
  await check(
    "joins another tab, recolours, and keeps the page mounted across collapse",
    async () => {
      await second().click({ button: "right" });
      await page.getByRole("menuitem", { name: "Add to group", exact: true }).click();
      await page.getByRole("menuitem", { name: "Research", exact: true }).click();
      await page.getByRole("button", { name: "Research, 2 tabs", exact: true }).waitFor();
      await edit();
      await page.getByRole("button", { name: "purple", exact: true }).click();
      await shot("group-editor.png");
      await title.press("Escape");
      await first().click();
      await page
        .locator(".place")
        .evaluate((node) => node.setAttribute("data-journey-held", "true"));
      await shot("expanded-group.png");
      await header.click();
      await page.waitForFunction(
        () =>
          document.querySelector(".side-tab-group__main")?.getAttribute("aria-expanded") ===
          "false",
      );
      const observed = {
        members: await page.locator(".side-tab--grouped").count(),
        active: await header.getAttribute("aria-current"),
        pageHeld: await page.locator('.place[data-journey-held="true"]').count(),
      };
      await header.locator(".side-tab-group__chevron").evaluate(async (node) => {
        await Promise.all(node.getAnimations().map((animation) => animation.finished));
      });
      await shot("collapsed-group.png");
      expectThat(
        observed,
        observed.members === 0 && observed.active === "true" && observed.pageHeld === 1,
        "collapse changed the page or kept member rows visible",
      );
      const message = page.getByRole("textbox", { name: "Message", exact: true });
      await message.fill("@");
      const firstTitle = await page.evaluate((key) => {
        const client = Reflect.get(window, "opensteerMock") as MockHostClient;
        return client.getSnapshot().tabs.get(key!)!.title;
      }, firstKey);
      await page
        .getByRole("option")
        .filter({ has: page.getByText(firstTitle, { exact: true }) })
        .waitFor();
      const mentionable = await page.locator(".mention-list .place-pick__title").allTextContents();
      expectThat(
        { mentionable, firstTitle },
        mentionable.includes(firstTitle),
        "collapse hid a tab from the mention picker",
      );
      await message.fill("");
      await header.press("Space");
      await first().waitFor();
      return observed;
    },
  );
  await check("Escape cancels a title draft and blur saves it", async () => {
    await edit();
    await title.fill("Cancelled");
    await title.press("Escape");
    expectThat(
      {},
      (await header.textContent())?.includes("Research") === true,
      "Escape saved the draft",
    );
    await edit();
    await title.fill("Reading");
    await page.getByRole("button", { name: "blue", exact: true }).click();
    await page.getByRole("button", { name: "Reading, 2 tabs", exact: true }).waitFor();
    await title.press("Escape");
    return { title: await header.textContent() };
  });
  await check("both submenus keep hover and arrow-key behavior", async () => {
    await first().click({ button: "right" });
    for (const [label, menuLabel] of [
      ["Open this page in…", "Open this page in"],
      ["Add to group", "Add to group"],
    ] as const) {
      const trigger = page.getByRole("menuitem", { name: label, exact: true });
      await trigger.hover();
      const menu = page.getByRole("menu", { name: menuLabel, exact: true });
      await menu.waitFor();
      await menu.getByRole("menuitem").first().press("ArrowLeft");
      await menu.waitFor({ state: "detached" });
      const focused = await trigger.evaluate((node) => node === document.activeElement);
      expectThat({ label, focused }, focused, "Left arrow did not return focus to the submenu row");
      await trigger.press("ArrowRight");
      await menu.waitFor();
      await page.getByRole("menuitem", { name: "Reload", exact: true }).hover();
      await menu.waitFor({ state: "detached" });
    }
    await page.keyboard.press("Escape");
    return { submenus: 2 };
  });
  await check("the chevron respects reduced motion", async () => {
    const chevron = header.locator(".side-tab-group__chevron");
    const normal = await chevron.evaluate((node) => getComputedStyle(node).transitionDuration);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const reduced = await chevron.evaluate((node) => ({
      property: getComputedStyle(node).transitionProperty,
      animations: node.getAnimations().length,
    }));
    expectThat(
      { normal, reduced },
      normal === "0.13s" && reduced.property === "none" && reduced.animations === 0,
      "the chevron ignores the motion preference",
    );
    await page.emulateMedia({ reducedMotion: "no-preference" });
    return { normal, reduced };
  });
  await check("the mobile drawer keeps group controls reachable", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator(".drawer-btn:visible").first().click();
    await header.waitFor({ state: "visible" });
    await page.locator(".sidebar").evaluate(async (node) => {
      await Promise.all(node.getAnimations().map((animation) => animation.finished));
    });
    await shot("mobile-group.png");
    await page.locator(".sidebar").evaluate(async (node) => {
      await Promise.all(node.getAnimations().map((animation) => animation.finished));
    });
    const box = await header.boundingBox();
    expectThat(
      { box },
      box !== null && box.x >= 0 && box.x + box.width <= 390,
      "group header overflows the drawer",
    );
    return { box };
  });
  await check("the tab resource reports the resulting layout without browser errors", async () => {
    const layout = await page.evaluate(async () => {
      const client = Reflect.get(window, "opensteerMock") as MockHostClient;
      const result = await client.rpc["resources.detail.get"]({ kind: "tab-layout" });
      if (!result.ok) throw new Error(result.error.message);
      if (result.data.data.kind !== "tab-layout") throw new Error("Wrong tab resource");
      return {
        groups: result.data.data.tabs.layout.items.flatMap((item) =>
          item.kind === "group" ? [item.group.name] : [],
        ),
      };
    });
    expectThat(
      { ...layout, errors },
      layout.groups.includes("Reading") && errors.length === 0,
      "the tab resource or page errors disagree with the UI",
    );
    return { ...layout, errors };
  });
  await context.close();
} catch (error) {
  abort(error);
} finally {
  await web.close();
}
await finishJourney(artifactDirectory, checks);
