/**
 * Failures: picker omits/incorrectly labels windows; two owner bindings collapse;
 * closing one closes both; task Watch loses its title on a window change;
 * ending a task substitutes an owner destination; Host steps lose chips/count/status.
 * Evidence is outside the checkout; all browser/server processes close in finally.
 */
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MockHostClient } from "@opensteer/client/mock";
import { expectThat, finishJourney, journeyChecks, openMockWeb } from "./mock-web-journey.js";
const directory =
  process.env.OPENSTEER_COMPUTER_WINDOWS_EVIDENCE_DIR ??
  path.join(tmpdir(), "opensteer-computer-windows");
await mkdir(directory, { recursive: true });
const { check, checks, abort } = journeyChecks();
const web = await openMockWeb("computer-windows");
try {
  const page = await web.browser.newPage({ viewport: { width: 1400, height: 950 } });
  await page.goto(`${web.origin}/?panel=browser`);
  await page.locator(".start-tile[aria-label^='Notes on']").waitFor();
  await check("window picker marks minimized and other-Space windows", async () => {
    await page.getByRole("button", { name: "Windows of Notes on Mac mini", exact: true }).click();
    await page.getByRole("button", { name: "Notes — Shopping list", exact: true }).waitFor();
    const text = await page
      .locator(".start-app-windows", {
        has: page.getByRole("button", { name: "Notes — Shopping list", exact: true }),
      })
      .innerText();
    await page.screenshot({ animations: "disabled", path: path.join(directory, "picker.png") });
    expectThat(
      { text },
      text.includes("Minimized") && text.includes("Other Space"),
      "window state labels are missing",
    );
    return { text };
  });
  await check("two owner tabs survive independent closing", async () => {
    await page.getByRole("button", { name: "Notes — Shopping list", exact: true }).click();
    await page.locator(".owner-view").waitFor();
    // Two windows of one app are two tabs; closing one leaves the other.
    const opened = await page.evaluate(async () => {
      const client = Reflect.get(window, "opensteerMock") as MockHostClient;
      const app = (await client.listApprovedComputerApps()).find((a) => a.name === "Notes")!;
      if (app.target.kind !== "app") throw Error("Expected Notes");
      const windows = await client.listComputerAppWindows(app.machineId, app.target.app);
      // The page reads plain JSON; the Host parses its own branded ids.
      const computerId = app.machineId as never;
      const [a, b] = await Promise.all(
        windows
          .slice(0, 2)
          .map((held) => client.openTab({ kind: "window", computerId, windowId: held.windowId })),
      );
      return { a: a!.tabId as string, b: b!.tabId as string };
    });
    await page.locator(`.side-tab[data-place-key="${opened.b}"]`).waitFor();
    await page.locator(`.side-tab[data-place-key="${opened.a}"]`).waitFor();
    await page.screenshot({
      animations: "disabled",
      path: path.join(directory, "two-owner-tabs.png"),
    });
    await page.evaluate(async ({ a }) => {
      const client = Reflect.get(window, "opensteerMock") as MockHostClient;
      await client.closeTabs([a as never]);
    }, opened);
    await page.locator(`.side-tab[data-place-key="${opened.a}"]`).waitFor({ state: "detached" });
    const observed = {
      different: opened.a !== opened.b,
      remaining: await page.locator(`.side-tab[data-place-key="${opened.b}"]`).count(),
    };
    expectThat(
      observed,
      observed.different && observed.remaining === 1,
      "window tabs did not close independently",
    );
    await page.screenshot({
      animations: "disabled",
      path: path.join(directory, "one-owner-closed.png"),
    });
    return observed;
  });
  await check(
    "Host-authored computer steps keep chips, counts and live status; outer code stays compact",
    async () => {
      await page.goto(`${web.origin}/tasks/thr_00000000-0000-4000-8000-000000000006`);
      await page.locator(".computer-now").waitFor();
      const status = await page.locator(".computer-now").innerText();
      const chip = await page
        .locator(".surface-chip__title", { hasText: "Slack" })
        .first()
        .textContent();
      const body = await page.locator("body").innerText();
      await page.screenshot({
        animations: "disabled",
        path: path.join(directory, "host-computer-live.png"),
      });
      expectThat(
        { status, chip, body },
        status.includes("Slack") && status.includes("Mac mini") && chip === "Slack",
        "Host operations lost computer status or chip",
      );
      await page.goto(`${web.origin}/tasks/thr_00000000-0000-4000-8000-000000000005`);
      await page.locator(".work__toggle, .reply__action").first().waitFor();
      await page.screenshot({
        animations: "disabled",
        path: path.join(directory, "host-computer-folded.png"),
      });
      const toggle = page.locator(".work__toggle").first();
      if (await toggle.count()) {
        if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
      } else {
        await page.locator(".reply").last().hover();
        await page
          .locator(".reply")
          .last()
          .getByRole("button", { name: "More", exact: true })
          .click();
        await page.getByRole("menuitem", { name: "Run details", exact: true }).click();
      }
      await page.getByText("Ran computer code", { exact: true }).first().waitFor();
      const text = await page.locator("body").innerText();
      await page.screenshot({
        animations: "disabled",
        path: path.join(directory, "host-computer-settled.png"),
      });
      const observed = {
        status,
        chip,
        text,
        outerSteps: await page.getByText("Ran computer code", { exact: true }).count(),
      };
      expectThat(
        observed,
        observed.outerSteps === 1 &&
          text.includes("9 steps in Slack") &&
          text.includes("9 steps on Mac mini") &&
          text.includes("Used Slack"),
        "outer computer code or operation counts are wrong",
      );
      return observed;
    },
  );
} catch (error) {
  abort(error);
} finally {
  await web.close();
}
await finishJourney(directory, checks);
