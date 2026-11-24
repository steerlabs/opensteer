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

async function checkSoloLine(page: Page, { clipped }: { clipped: boolean }) {
  const layout = await trigger(page).evaluate((button) => {
    const text = button.querySelector<HTMLElement>(".agents-now__headline")!;
    const stop = button.parentElement!.querySelector<HTMLElement>(".agents-now__quick-stop")!;
    const line = button.getBoundingClientRect();
    const action = stop.getBoundingClientRect();
    return {
      title: button.getAttribute("title"),
      label: button.getAttribute("aria-label"),
      height: text.clientHeight,
      fullHeight: text.scrollHeight,
      lineHeight: Number.parseFloat(getComputedStyle(text).lineHeight),
      centreOffset: Math.abs((line.top + line.bottom - action.top - action.bottom) / 2),
    };
  });
  if (
    !layout.title ||
    layout.title !== layout.label ||
    layout.height > 2 * layout.lineHeight + 1 ||
    layout.fullHeight > layout.height + 1 !== clipped ||
    layout.centreOffset > 1
  )
    throw new Error(`The single-agent line did not fit: ${JSON.stringify(layout)}`);
}

async function save(page: Page, name: string) {
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
  await checkSoloLine(page, { clipped: false });
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
      name: /Grok research assistant.*Household shopping and weekly groceries shared with family/,
    })
    .waitFor();
  await checkSoloLine(page, { clipped: true });
  const resize = page.getByRole("separator", { name: "Resize navigation sidebar" });
  await resize.press("Home");
  if ((await resize.getAttribute("aria-valuenow")) !== (await resize.getAttribute("aria-valuemin")))
    throw new Error("The sidebar did not reach its minimum width.");
  await checkSoloLine(page, { clipped: true });
  await save(page, "one-long-dark");

  await page.setViewportSize({ width: 728, height: 820 });
  await page.goto(`${web.origin}/?mock-agents&mock-agent-work=long-panel`);
  await page.getByRole("button", { name: /Open sidebar/ }).click();
  await showPanel(page);
  await panel(page)
    .getByText("Household shopping and weekly groceries shared with family", { exact: true })
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

  await openSettings("needs-you", claude);
  await now.getByText("Run a script in Travel?", { exact: true }).waitFor();
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
  await context.close();
} finally {
  await web.close();
}
