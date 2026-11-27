import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { openMockWeb } from "./mock-web-journey.js";

const output = process.argv[2];
if (!output) throw new Error("Pass the directory for the connected agent screenshots.");
await mkdir(output, { recursive: true });
const web = await openMockWeb("opensteer-connected-agents-now");

const trigger = (page: Page) => page.locator(".agents-now__trigger");
const panel = (page: Page) => page.getByRole("dialog", { name: "On your computer now" });
async function showPanel(page: Page) {
  await trigger(page).click();
  await panel(page).waitFor();
  const fits = await panel(page).evaluate((element) => {
    const { left, right, top, bottom } = element.getBoundingClientRect();
    return (
      left >= 0 &&
      right <= innerWidth &&
      top >= 0 &&
      bottom <= innerHeight &&
      element.scrollWidth <= element.clientWidth
    );
  });
  if (!fits) throw new Error("The connected agent panel exceeds the viewport.");
}

async function checkSoloLine(
  page: Page,
  expected: { nameClipped: boolean; detailClipped: boolean },
) {
  const layout = await trigger(page).evaluate((button) => {
    const name = button.querySelector<HTMLElement>(".agents-now__headline-name")!;
    const detail = button.querySelector<HTMLElement>(".agents-now__headline-detail")!;
    const stop = button.parentElement!.querySelector<HTMLElement>(".agents-now__quick-stop")!;
    const line = button.getBoundingClientRect();
    const action = stop.getBoundingClientRect();
    return {
      title: button.getAttribute("title"),
      label: button.getAttribute("aria-label"),
      nameClipped: name.scrollWidth > name.clientWidth,
      detailClipped: detail.scrollWidth > detail.clientWidth,
      separate: name.getBoundingClientRect().bottom <= detail.getBoundingClientRect().top,
      detailText: detail.textContent?.trim(),
      centreOffset: Math.abs((line.top + line.bottom - action.top - action.bottom) / 2),
    };
  });
  if (
    !layout.title ||
    layout.title !== layout.label ||
    !layout.separate ||
    !layout.detailText?.startsWith("is working in ") ||
    layout.nameClipped !== expected.nameClipped ||
    layout.detailClipped !== expected.detailClipped ||
    layout.centreOffset > 1
  )
    throw new Error(`The single-agent line did not fit: ${JSON.stringify(layout)}`);
}

async function save(page: Page, name: string) {
  if (process.argv.includes("--task-origin") && !name.startsWith("tasks-started-by")) return;
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(output!, `${name}.png`), animations: "disabled" });
  process.stdout.write(`${name}.png\n`);
}

try {
  const context = await web.browser.newContext({
    colorScheme: "dark",
    viewport: { width: 1360, height: 820 },
  });
  await context.route(
    (url) => url.origin !== web.origin,
    (route) => route.fulfill({ status: 204, body: "" }),
  );
  const page = await context.newPage();
  const open = async (scene: string) => {
    await page.goto(`${web.origin}/?mock-agents${scene ? `&mock-agent-work=${scene}` : ""}`);
    await page.locator("#app-sidebar").waitFor({ state: "attached" });
  };
  await open("one");
  await page.getByRole("button", { name: "ChatGPT is working in Shopping" }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await checkSoloLine(page, { nameClipped: false, detailClipped: false });
  await save(page, "one-dark");

  await open("three");
  await page.getByRole("button", { name: "3 agents working" }).waitFor();
  await save(page, "three-dark");
  await showPanel(page);
  await panel(page).getByText("Opened a tab in Work").waitFor();
  await save(page, "panel-dark");

  await open("needs-you");
  await page.getByRole("button", { name: "Claude needs you · 2 working" }).waitFor();
  await showPanel(page);
  await panel(page).getByText("Run a script in Travel?").waitFor();
  await save(page, "needs-you-dark");

  await open("three");
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await page.locator("header .agents-now--compact").waitFor();
  await showPanel(page);
  await panel(page).getByText("Opened a tab in Work").waitFor();
  await save(page, "closed-dark");

  await page.keyboard.press("Escape");
  await panel(page).waitFor({ state: "detached" });
  await page.getByRole("button", { name: /Show sidebar/ }).click();
  await showPanel(page);
  await panel(page).getByRole("button", { name: "Stop all" }).click();
  await trigger(page).waitFor({ state: "detached" });
  await save(page, "idle-dark");

  await open("long-one");
  await page
    .getByRole("button", {
      name: /Grok research assistant.*is working in Shopping/,
    })
    .waitFor();
  await checkSoloLine(page, { nameClipped: true, detailClipped: false });
  const resize = page.getByRole("separator", { name: "Resize navigation sidebar" });
  await resize.press("Home");
  if ((await resize.getAttribute("aria-valuenow")) !== (await resize.getAttribute("aria-valuemin")))
    throw new Error("The sidebar did not reach its minimum width.");
  await checkSoloLine(page, { nameClipped: true, detailClipped: false });
  await save(page, "one-long-dark");

  await open("long-place");
  await page
    .getByRole("button", {
      name: "ChatGPT is working in Household shopping and weekly groceries shared with family",
    })
    .waitFor();
  await checkSoloLine(page, { nameClipped: false, detailClipped: true });
  await save(page, "one-long-place-dark");

  await page.setViewportSize({ width: 728, height: 820 });
  await page.goto(`${web.origin}/?mock-agents&mock-agent-work=long-panel`);
  await page.getByRole("button", { name: /Open sidebar/ }).click();
  await showPanel(page);
  // The panel names the place in the agent's line and again in its activity (891c55166).
  await panel(page)
    .getByText("Household shopping and weekly groceries shared with family", { exact: true })
    .first()
    .waitFor();
  await save(page, "panel-728");

  const settings = "/settings/external-agents";
  const claude = "mcn_00000000-0000-4000-8000-000000000002";
  const chatgpt = "mcn_00000000-0000-4000-8000-000000000008";
  const now = page.getByRole("region", { name: "Now", exact: true });
  const openSettings = (scene: string, id?: string) =>
    page.goto(
      `${web.origin}${settings}${id ? `/${id}` : ""}?mock-agents${scene ? `&mock-agent-work=${scene}` : ""}`,
    );
  const ready = () => now.locator(".session-op").first().waitFor();
  await openSettings("one", chatgpt);
  await ready();
  await save(page, "page-now-728");

  await page.setViewportSize({ width: 1360, height: 820 });
  await openSettings("one", chatgpt);
  await ready();
  await save(page, "page-now-dark");
  await now.getByRole("button", { name: "Watch ChatGPT" }).click();
  await page.waitForURL(
    (url) => url.pathname === "/tasks/thr_00000000-0000-4000-8000-0000000000a5",
  );
  await page.locator(".session-activity").waitFor();

  // A connected agent working in a tab of the Cloud Computer's own pooled browser (tester run
  // 12): Watch lands on that tab's live picture beside the task, never on the launcher.
  await openSettings("cloud-tab", chatgpt);
  await ready();
  await now.getByRole("button", { name: "Watch ChatGPT" }).click();
  await page.waitForURL(
    (url) =>
      url.pathname === "/tasks/thr_00000000-0000-4000-8000-0000000000a5" &&
      url.searchParams.get("tab") === "mock-tab-1-0",
  );
  await page.locator(".place--page").waitFor();
  if (await page.locator(".place--launcher").count())
    throw new Error("Watch on a Cloud Computer's tab stayed on the launcher.");
  await page.locator(".session-activity").waitFor();
  await save(page, "watch-cloud-tab-dark");

  // Two tabs held by the task (tester run 15, trials 2, 4, 6, 7): Watch lands on the one its work
  // took up last, never the earlier one.
  const shopping = "thr_00000000-0000-4000-8000-0000000000a5";
  const watchLands = async (scene: string, tab: string, timeout: number) => {
    await page.waitForURL(
      (url) => url.pathname === `/tasks/${shopping}` && url.searchParams.get("tab") === tab,
      { timeout },
    );
    await page.locator(".place--page").waitFor();
    if (await page.locator(".place--launcher").count())
      throw new Error(`Watch in ${scene} stayed on the launcher.`);
  };
  await openSettings("two-tabs", chatgpt);
  await ready();
  await now.getByRole("button", { name: "Watch ChatGPT" }).click();
  await watchLands("two-tabs", "mock-tab-1-0", 5_000);
  await save(page, "watch-two-tabs-dark");

  // The row naming the task's tab reaches this client after the click (run 15, trial 5): the
  // click lasts, and Watch lands when it arrives.
  await openSettings("late-tab", chatgpt);
  await ready();
  const heldAtClick = await page.evaluate(
    (task) =>
      [
        ...(
          window as unknown as {
            opensteerMock: {
              getSnapshot(): { tabs: { rows: Map<string, { usedBy: { taskId: string }[] }> } };
            };
          }
        ).opensteerMock
          .getSnapshot()
          .tabs.rows.values(),
      ].some((tab) => tab.usedBy.some(({ taskId }) => taskId === task)),
    shopping,
  );
  if (heldAtClick) throw new Error("The late tab reached the client before the Watch click.");
  await now.getByRole("button", { name: "Watch ChatGPT" }).click();
  await watchLands("late-tab", "mock-tab-1-0", 8_000);
  await save(page, "watch-late-tab-dark");

  await openSettings("needs-you", claude);
  await now.getByText("Run a script in Travel?", { exact: true }).waitFor();
  const waitingHead = now.locator(".connected-agent__session-head");
  await waitingHead.getByText("Needs you", { exact: true }).waitFor();
  if (await waitingHead.getByRole("button", { name: "Watch Claude" }).count())
    throw new Error("Watch is visible beside a waiting Request.");
  await ready();
  await save(page, "page-needs-you-dark");
  await now.getByRole("button", { name: "Allow once" }).click();
  await now.locator(".request-card").waitFor({ state: "detached" });

  await openSettings("", chatgpt);
  await page.getByRole("heading", { name: "ChatGPT", exact: true }).waitFor();
  if (await now.count()) throw new Error("Now is visible for an idle agent.");
  await save(page, "page-idle-dark");

  await openSettings("needs-you");
  await page.locator(".connected-agents__work").getByText("Needs you", { exact: true }).waitFor();
  await page.locator(".connected-agents__work").filter({ hasText: "Working" }).first().waitFor();
  await save(page, "list-dark");

  const earlier = page.getByRole("region", { name: "Earlier", exact: true });
  const historyReady = async () => {
    await earlier.getByRole("heading", { name: "Today", exact: true }).waitFor();
    await earlier.getByRole("heading", { name: "Yesterday", exact: true }).waitFor();
    if ((await earlier.locator(".connected-agent__history-row").count()) !== 3)
      throw new Error("Earlier should show three past sessions.");
    const overflow = await earlier.evaluate((section) => section.scrollWidth > section.clientWidth);
    if (overflow) throw new Error("The Earlier section exceeds its available width.");
  };
  await openSettings("history", chatgpt);
  await historyReady();
  if (await now.count()) throw new Error("Now is visible in the idle history scene.");
  await save(page, "page-earlier-dark");

  await openSettings("one-history", chatgpt);
  await historyReady();
  await ready();
  await save(page, "page-now-earlier-dark");

  await page.setViewportSize({ width: 728, height: 820 });
  await openSettings("history", chatgpt);
  await historyReady();
  await save(page, "page-earlier-728");
  await earlier.getByRole("button", { name: /^Shopping · 1 action/ }).click();
  await page.waitForURL(
    (url) => url.pathname === "/tasks/thr_00000000-0000-4000-8000-0000000000a6",
  );
  await page
    .locator(".session-activity")
    .getByText("Opened a tab in Shopping on Studio Mac")
    .waitFor();
  await page.setViewportSize({ width: 1360, height: 820 });
  await page.evaluate(() => localStorage.removeItem("opensteer.sidebar-width"));
  await open("three");
  await page.getByRole("button", { name: "3 agents working" }).waitFor();
  const tasks = page.locator(".side-section--tasks");
  const ownTitles = [
    "Find a desk chair",
    "Find flights to Lisbon",
    "Buy the phone case",
    "Renew the parking permit",
    "Compare running shoes",
  ];
  async function checkPersonTasks() {
    const titles = await tasks.locator(".side-task__title").allTextContents();
    if (!titles.length || ownTitles.some((title) => titles.includes(title)))
      throw new Error(
        "Tasks should contain the person's tasks and none of the connected agents' own tasks.",
      );
  }
  await checkPersonTasks();
  await save(page, "tasks-three-agents-dark");

  await open("needs-you");
  await page.getByRole("button", { name: "Claude needs you · 2 working" }).waitFor();
  await checkPersonTasks();
  await page.getByRole("button", { name: /Open Needs you/ }).click();
  const needsYou = page.getByRole("dialog", { name: "Needs you" });
  const request = needsYou.getByRole("button", { name: /Claude · Run a script in Travel\?/ });
  await request.scrollIntoViewIfNeeded();
  await save(page, "tasks-needs-you-dark");
  await request.click();
  await page.locator(".operation-request").waitFor();
  if (await tasks.locator(".is-filled, .is-open").count())
    throw new Error("The connected agent's task selected a row in Tasks.");

  await open("three");
  await showPanel(page);
  await panel(page).getByRole("button", { name: "Stop all" }).click();
  await trigger(page).waitFor({ state: "detached" });
  await checkPersonTasks();
  await page.mouse.move(650, 640);
  await save(page, "tasks-idle-dark");
  await page.goto(`${web.origin}/?mock-agents&mock-task-origin`);
  const origin = tasks.getByText("started by ChatGPT", { exact: true });
  await origin.scrollIntoViewIfNeeded();
  await save(page, "tasks-started-by-dark");
  await page.setViewportSize({ width: 728, height: 820 });
  await page
    .getByRole("button", { name: /Open sidebar/ })
    .first()
    .click();
  await origin.scrollIntoViewIfNeeded();
  await save(page, "tasks-started-by-728");
  await context.close();
} finally {
  await web.close();
}
