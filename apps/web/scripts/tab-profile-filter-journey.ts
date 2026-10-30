/** Exact profile filtering in the production sidebar, against the mock Host. */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { Page } from "playwright-core";
import { expectThat, finishJourney, journeyChecks, openMockWeb } from "./mock-web-journey.js";

const artifactDirectory = path.resolve(
  process.env.OPENSTEER_TAB_PROFILE_FILTER_EVIDENCE_DIR ??
    path.join(tmpdir(), "opensteer-tab-profile-filter-evidence"),
);
await mkdir(artifactDirectory, { recursive: true });
const { checks, check, abort } = journeyChecks();
const web = await openMockWeb("opensteer-tab-profile-filter-web");
const trigger = (page: Page) => page.getByRole("button", { name: "Filter tabs by profile" });
const rows = (page: Page) =>
  page.locator(".side-section--tabs [data-place-key]").evaluateAll((items) =>
    items.map((item) => ({
      key: item.getAttribute("data-place-key")!,
      title: item.querySelector(".side-tab__title")?.textContent ?? "",
    })),
  );
async function shot(page: Page, name: string) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) =>
          Number.isFinite(Number(animation.effect?.getComputedTiming().endTime)),
        )
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
  await page.screenshot({ path: path.join(artifactDirectory, name) });
}
const inventory = (page: Page) =>
  page.evaluate(() => {
    const client = Reflect.get(window, "opensteerMock") as {
      getSnapshot(): {
        workspaceTabs?: {
          session: { profileId: string | null };
          tabs?: { id: string; sessionId: string }[];
        }[];
      };
    };
    return (client.getSnapshot().workspaceTabs ?? []).flatMap((group) =>
      (group.tabs ?? []).map((tab) => ({
        key: `browser:${tab.sessionId}:${tab.id}`,
        profileId: group.session.profileId,
      })),
    );
  });
async function choose(page: Page, name: string) {
  await trigger(page).click();
  await page.getByRole("menuitemradio", { name, exact: true }).click();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await page.waitForFunction(
    () => document.activeElement === document.querySelector(".side-profile-filter"),
  );
}

try {
  const context = await web.browser.newContext({ viewport: { width: 1440, height: 1000 } });
  context.setDefaultTimeout(4000);
  await context.route(
    (url) => url.origin !== web.origin,
    (route) => route.fulfill({ body: "", status: 204 }),
  );
  await context.addInitScript("globalThis.__name = (value) => value;");
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${web.origin}/?mock-world=busy`);
  await page.locator(".side-section--tabs [data-place-key]").first().waitFor();
  await page.evaluate(() =>
    (Reflect.get(window, "opensteerMock") as { scriptPlaces(): unknown }).scriptPlaces(),
  );
  const before = await rows(page);
  const identities = await inventory(page);
  const tasks = await page.locator(".side-section--tasks").textContent();

  // All failure modes are covered by journeys before the production implementation:
  // absent/undiscoverable control; inaccurate counts; text instead of ID matching;
  // mixed profiles in a group; collapsed groups; Guest; hidden native rows; changes
  // to Host state; reorder corrupting hidden rows; search choosing a hidden tab;
  // live last-tab removal; clearing; keyboard focus; responsive drawer overflow.
  await check("Tabs exposes a keyboard-accessible profile menu with exact counts", async () => {
    await trigger(page).click({ timeout: 3000 });
    const choices = await page.getByRole("menuitemradio").allTextContents();
    const all = await page
      .getByRole("menuitemradio", { name: "All profiles", exact: true })
      .getAttribute("aria-checked");
    expectThat({ choices, all }, choices.length === 4 && all === "true", "profile choices missing");
    for (const [name, profileId] of [
      ["Personal", "bpr_00000000-0000-4000-8000-000000000001"],
      ["Work", "bpr_00000000-0000-4000-8000-000000000002"],
      ["Guest", null],
    ] as const) {
      const count = identities.filter((tab) => tab.profileId === profileId).length;
      const text = await page.getByRole("menuitemradio", { name, exact: true }).textContent();
      expectThat(
        { name, count, text },
        text?.endsWith(String(count)) === true,
        "profile count is inaccurate",
      );
    }
    await shot(page, "01-profile-menu.png");
    await page.keyboard.press("Escape");
    expectThat(
      {},
      await trigger(page).evaluate((button) => document.activeElement === button),
      "Escape lost the keyboard",
    );
    return { choices, all };
  });
  if (checks.some((item) => item.status === "failed"))
    throw new Error("The profile-filter control is absent; remaining dependent checks cannot run.");

  await check(
    "Work filters only its browser tabs without changing Tasks or Host order",
    async () => {
      await choose(page, "Work");
      const filtered = await rows(page);
      const work = new Set(
        identities.filter((tab) => tab.profileId?.endsWith("000000000002")).map((tab) => tab.key),
      );
      const expected = before.filter(({ key }) => work.has(key));
      expectThat(
        { filtered, expected },
        JSON.stringify(filtered) === JSON.stringify(expected),
        "wrong profile rows",
      );
      expectThat(
        { tasks },
        (await page.locator(".side-section--tasks").textContent()) === tasks,
        "Tasks changed",
      );
      await shot(page, "02-work.png");
      await page.getByRole("button", { name: "Clear profile filter" }).click();
      expectThat(
        {},
        JSON.stringify(await rows(page)) === JSON.stringify(before),
        "clearing changed tab order",
      );
      return { filtered };
    },
  );

  await check(
    "Guest includes every Guest browser and excludes profiles and native surfaces",
    async () => {
      await choose(page, "Guest");
      const filtered = await rows(page);
      const guest = new Set(
        identities.filter((tab) => tab.profileId === null).map((tab) => tab.key),
      );
      const expected = before.filter(({ key }) => guest.has(key));
      expectThat(
        { filtered, expected },
        JSON.stringify(filtered) === JSON.stringify(expected),
        "Guest matches are wrong",
      );
      await page.getByRole("button", { name: "Clear profile filter" }).click();
      return { filtered };
    },
  );

  await check(
    "mixed-profile groups retain only matching members and their collapse state",
    async () => {
      await page.evaluate(async () => {
        const client = Reflect.get(window, "opensteerMock") as {
          groupBrowserTabs(ids: string[], group: { title: string; color: string }): Promise<string>;
        };
        await client.groupBrowserTabs(["mock-tab-0-0", "mock-tab-2-0"], {
          title: "Mixed accounts",
          color: "blue",
        });
      });
      await choose(page, "Work");
      const members = await page.locator(".side-tab--grouped").allTextContents();
      expectThat(
        { members },
        members.length === 1 && !members[0]!.includes("Nopa"),
        "mixed group leaked a profile",
      );
      await page.getByRole("button", { name: "Mixed accounts, 1 tabs", exact: true }).click();
      expectThat(
        {},
        (await page.locator(".side-tab--grouped").count()) === 0,
        "filtered group did not collapse",
      );
      await shot(page, "03-grouped.png");
      await page.getByRole("button", { name: "Clear profile filter" }).click();
      expectThat(
        {},
        (await page
          .getByRole("button", { name: "Mixed accounts, 2 tabs", exact: true })
          .getAttribute("aria-expanded")) === "false",
        "filter changed collapse state",
      );
      return { members };
    },
  );

  await check("global search can open a tab outside the selected profile", async () => {
    await choose(page, "Work");
    await page.keyboard.press("Meta+k");
    const field = page.getByRole("combobox", { name: "Search tasks and tabs" });
    await field.fill("lisbon");
    await page.getByRole("option").filter({ hasText: "Lisbon · Stays" }).click();
    expectThat(
      {},
      (await page.getByRole("button", { name: "Clear profile filter" }).count()) === 0,
      "search left its chosen tab filtered out",
    );
    expectThat(
      {},
      (await rows(page)).some((row) => row.title === "Lisbon · Stays – Airbnb"),
      "chosen tab is hidden",
    );
    return { rows: await rows(page) };
  });

  await check(
    "filtered keyboard reordering preserves hidden tabs and the chosen profile",
    async () => {
      const beforeAll = await rows(page);
      const beforeInventory = await inventory(page);
      await choose(page, "Guest");
      const initial = await rows(page);
      const first = page.locator(".side-section--tabs [data-place-key] .side-tab__main").first();
      await first.focus();
      await page.keyboard.press("Meta+ArrowDown");
      await page.waitForTimeout(350);
      const moved = await rows(page);
      expectThat(
        { initial, moved },
        moved[0]?.key === initial[1]?.key && moved[1]?.key === initial[0]?.key,
        "filtered reorder failed",
      );
      await page.getByRole("button", { name: "Clear profile filter" }).click();
      const after = await rows(page);
      const guestKeys = new Set(initial.map((row) => row.key));
      const hidden = (items: typeof after) => items.filter((row) => !guestKeys.has(row.key));
      const afterInventory = await inventory(page);
      expectThat(
        { beforeAll, after },
        JSON.stringify(hidden(beforeAll)) === JSON.stringify(hidden(after)),
        "reorder changed hidden tabs' relative order",
      );
      expectThat(
        { beforeInventory, afterInventory },
        JSON.stringify(beforeInventory.map((tab) => tab.key).sort()) ===
          JSON.stringify(afterInventory.map((tab) => tab.key).sort()),
        "reorder lost or duplicated tabs",
      );
      return { initial, moved };
    },
  );

  await check(
    "closing the last matching tab keeps a clearable, explicit empty filter",
    async () => {
      await choose(page, "Work");
      await page.evaluate(async () => {
        const client = Reflect.get(window, "opensteerMock") as {
          getSnapshot(): {
            workspaceTabs?: { session: { profileId: string | null }; tabs?: { id: string }[] }[];
          };
          closeWorkspaceTabs(ids: string[]): Promise<unknown>;
        };
        const ids = (client.getSnapshot().workspaceTabs ?? [])
          .filter((group) => group.session.profileId?.endsWith("000000000002"))
          .flatMap((group) => (group.tabs ?? []).map((tab) => tab.id));
        await client.closeWorkspaceTabs(ids);
      });
      await page.waitForTimeout(250);
      const remaining = await rows(page);
      expectThat(
        { remaining },
        remaining.length === 0 &&
          (await page.getByText("No tabs in this profile.", { exact: true }).isVisible()),
        "last tab silently cleared the filter",
      );
      await shot(page, "04-empty.png");
      await page.getByRole("button", { name: "Clear profile filter" }).click();
      expectThat({}, (await rows(page)).length > 0, "clear did not restore other tabs");
      return { remaining };
    },
  );

  await check("the filter menu fits in the narrow sidebar drawer", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.keyboard.press("Meta+k");
    await page.getByRole("combobox", { name: "Search tasks and tabs" }).waitFor();
    await page.keyboard.press("Escape");
    await trigger(page).click();
    const menu = await page.getByRole("menu", { name: "Filter tabs by profile" }).boundingBox();
    expectThat(
      { menu },
      !!menu && menu.x >= 0 && menu.x + menu.width <= 390,
      "filter menu overflows drawer",
    );
    await shot(page, "05-drawer.png");
    await page.keyboard.press("Escape");
    return { menu };
  });
  await check("the journey has no browser errors", async () => {
    expectThat({ errors }, errors.length === 0, "browser errors");
    return { errors };
  });
  await check(
    "a single identity needs no filter, and clearing returns keyboard focus to Tabs",
    async () => {
      await choose(page, "Guest");
      const otherTabs = (await inventory(page)).filter((tab) => tab.profileId !== null);
      await page.evaluate(
        async (ids) => {
          const client = Reflect.get(window, "opensteerMock") as {
            closeWorkspaceTabs(ids: string[]): Promise<unknown>;
          };
          await client.closeWorkspaceTabs(ids);
        },
        otherTabs.map((tab) => tab.key.split(":").at(-1)!),
      );
      await page.getByRole("button", { name: "Clear profile filter" }).click();
      await trigger(page).waitFor({ state: "hidden" });
      await page.waitForFunction(() => document.activeElement?.id === "sidebar-tabs");
      return {
        remainingProfiles: [...new Set((await inventory(page)).map((tab) => tab.profileId))],
      };
    },
  );
  await check("selected profiles and tab rows fit at every sidebar width", async () => {
    const layoutContext = await web.browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await layoutContext.addInitScript(() => {
      Reflect.set(globalThis, "__name", (value: unknown) => value);
      localStorage.removeItem("opensteer.sidebar-width");
    });
    await layoutContext.route(
      (url) => url.origin !== web.origin,
      (route) => route.fulfill({ body: "", status: 204 }),
    );
    const observed: Record<string, unknown>[] = [];
    try {
      for (const name of [
        "Email account",
        "Work Shopping Research Travel Projects Personal Accounts",
        "AnExtremelyLongUnbrokenBrowserProfileNameForWork",
      ]) {
        const sample = await layoutContext.newPage();
        try {
          await sample.goto(`${web.origin}/?mock-world=busy`);
          await sample.locator(".side-section--tabs [data-place-key]").first().waitFor();
          await sample.evaluate((profileName) => {
            const client = Reflect.get(window, "opensteerMock") as {
              scriptDormantBrowser(options: { profileName: string }): unknown;
            };
            client.scriptDormantBrowser({ profileName });
          }, name);
          await choose(sample, name);

          const measure = async (layout: string) => {
            await sample.evaluate(() =>
              Promise.all(
                document
                  .getAnimations()
                  .filter((animation) =>
                    Number.isFinite(Number(animation.effect?.getComputedTiming().endTime)),
                  )
                  .map((animation) => animation.finished.catch(() => undefined)),
              ),
            );
            const bounds = await sample.locator(".side-section--tabs").evaluate((section) => {
              const rect = (selector: string) => {
                const element = section.querySelector<HTMLElement>(selector);
                if (!element) throw new Error(`Missing ${selector}`);
                const { left, right, width } = element.getBoundingClientRect();
                return { left, right, width };
              };
              const label = section.querySelector<HTMLElement>(
                ".side-profile-filter > span:last-child",
              );
              if (!label) throw new Error("Missing profile label");
              const { left, right } = section.getBoundingClientRect();
              return {
                section: { left, right },
                heading: rect(".side-head"),
                title: rect(".side-head__title"),
                filter: rect(".side-profile-filter"),
                clear: rect(".side-profile-clear"),
                newTab: rect('[aria-label="New tab"]'),
                list: rect(".side-list"),
                label: { width: label.clientWidth, scrollWidth: label.scrollWidth },
              };
            });
            const entry = { name, layout, ...bounds };
            observed.push(entry);
            const { section, heading, title, filter, clear, newTab, list, label } = bounds;
            expectThat(
              entry,
              heading.left >= section.left &&
                heading.right <= section.right &&
                list.left >= section.left &&
                list.right <= section.right &&
                title.width > 0 &&
                title.right <= filter.left &&
                filter.right <= clear.left &&
                clear.right <= newTab.left &&
                newTab.right <= heading.right,
              "selected profile pushes the header or tab rows outside the sidebar",
            );
            if (name !== "Email account")
              expectThat(
                entry,
                label.width < label.scrollWidth,
                "long profile name does not truncate",
              );
          };
          await measure("default");
          await sample.getByRole("separator", { name: "Resize navigation sidebar" }).press("Home");
          await sample.waitForFunction(
            () =>
              document
                .querySelector('[aria-label="Resize navigation sidebar"]')
                ?.getAttribute("aria-valuenow") === "224",
          );
          await measure("minimum");
          await sample.setViewportSize({ width: 390, height: 844 });
          await sample.keyboard.press("Meta+k");
          await sample.getByRole("combobox", { name: "Search tasks and tabs" }).waitFor();
          await sample.keyboard.press("Escape");
          await measure("drawer");
          await sample.getByRole("button", { name: "Clear profile filter" }).click();
          await trigger(sample).waitFor();
        } finally {
          await sample.close();
        }
      }
    } finally {
      await layoutContext.close();
    }
    return { observed };
  });
  await context.close();
} catch (error) {
  abort(error);
} finally {
  await web.close();
  await finishJourney(artifactDirectory, checks);
}
