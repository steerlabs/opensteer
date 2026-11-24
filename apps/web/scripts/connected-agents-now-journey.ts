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

async function save(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(output!, `${name}.png`), animations: "disabled" });
  process.stdout.write(`${name}.png\n`);
}

try {
  for (const colorScheme of ["light", "dark"] as const) {
    const context = await web.browser.newContext({
      colorScheme,
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
    await save(page, `one-${colorScheme}`);

    await open("three");
    await page.getByRole("button", { name: "3 agents working" }).waitFor();
    await save(page, `three-${colorScheme}`);
    await showPanel(page);
    await panel(page).getByText("Opened a tab in Work").waitFor();
    await save(page, `panel-${colorScheme}`);

    await open("needs-you");
    await page.getByRole("button", { name: "Claude needs you · 2 working" }).waitFor();
    await showPanel(page);
    await panel(page).getByText("Run a script in Travel?").waitFor();
    await save(page, `needs-you-${colorScheme}`);

    await open("three");
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await page.locator("header .agents-now--compact").waitFor();
    await showPanel(page);
    await panel(page).getByText("Opened a tab in Work").waitFor();
    await save(page, `closed-${colorScheme}`);

    await page.keyboard.press("Escape");
    await panel(page).waitFor({ state: "detached" });
    await page.getByRole("button", { name: /Show sidebar/ }).click();
    await showPanel(page);
    await panel(page).getByRole("button", { name: "Stop all" }).click();
    await trigger(page).waitFor({ state: "detached" });
    await save(page, `idle-${colorScheme}`);

    if (colorScheme === "dark") {
      await page.setViewportSize({ width: 728, height: 820 });
      await page.goto(`${web.origin}/?mock-agents&mock-agent-work=long-panel`);
      await page.getByRole("button", { name: /Open sidebar/ }).click();
      await showPanel(page);
      await panel(page)
        .getByText("Household shopping and weekly groceries shared with family", { exact: true })
        .waitFor();
      await save(page, "panel-728");
    }
    await context.close();
  }
} finally {
  await web.close();
}
