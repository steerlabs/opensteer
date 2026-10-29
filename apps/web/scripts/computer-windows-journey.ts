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
    const opened = await page.evaluate(async () => {
      const client = Reflect.get(window, "opensteerMock") as MockHostClient;
      const app = (await client.listApprovedComputerApps()).find((a) => a.name === "Notes")!;
      if (app.target.kind !== "app") throw Error("Expected Notes");
      const a = await client.openComputerView(app.machineId, { ...app.target, window: 101 });
      const b = await client.openComputerView(app.machineId, { ...app.target, window: 102 });
      return { a, b };
    });
    await page
      .locator(`.side-tab[data-place-key="app:${opened.b.machineId}:com.apple.notes:102"]`)
      .waitFor();
    await page
      .locator(`.side-tab[data-place-key="app:${opened.a.machineId}:com.apple.notes:101"]`)
      .waitFor();
    await page.screenshot({
      animations: "disabled",
      path: path.join(directory, "two-owner-tabs.png"),
    });
    await page.evaluate(async ({ a }) => {
      const client = Reflect.get(window, "opensteerMock") as MockHostClient;
      await client.closeComputerView(a.viewId, a.generation);
    }, opened);
    const remaining = await page.evaluate(() => {
      const client = Reflect.get(window, "opensteerMock") as MockHostClient;
      return client
        .getSnapshot()
        .machines.flatMap((m) => m.computerUse?.ownerViews ?? [])
        .filter((v) => v.state === "ready")
        .map((v) => v.window?.id);
    });
    const observed = { different: opened.a.viewId !== opened.b.viewId, remaining };
    expectThat(
      observed,
      observed.different && observed.remaining.includes(102) && !observed.remaining.includes(101),
      "owner tabs did not close independently",
    );
    await page.screenshot({
      animations: "disabled",
      path: path.join(directory, "one-owner-closed.png"),
    });
    return observed;
  });
  await check("task Watch follows window titles and task end never substitutes owner", async () => {
    const target = await page.evaluate(() => {
      const client = Reflect.get(window, "opensteerMock") as MockHostClient;
      const machine = client.getSnapshot().machines.find((m) => m.name === "Mac mini")!;
      const session = machine.computerUse!.sessions.find((s) =>
        s.apps.some((a) => a.displayName === "Notes"),
      )!;
      return { machineId: machine.id, sessionId: session.sessionId };
    });
    await page.goto(
      `${web.origin}/?panel=browser&mac=${target.machineId}&app=com.apple.notes&computerSession=${target.sessionId}`,
    );
    await page.locator(".computer-watch__app", { hasText: "Notes" }).waitFor();
    await page.evaluate(async ({ machineId, sessionId }) => {
      const client = Reflect.get(window, "opensteerMock") as MockHostClient;
      const app = (await client.listApprovedComputerApps()).find((a) => a.name === "Notes")!;
      if (app.target.kind !== "app") throw Error("Expected Notes");
      await client.openComputerView(machineId, { ...app.target, window: 102 });
      client.setComputerSessionWindow(machineId, sessionId, "com.apple.notes", {
        id: 102,
        title: "Work plan",
      });
    }, target);
    await page.locator(".computer-watch__app", { hasText: "Notes — Work plan" }).waitFor();
    await page
      .locator(
        `.side-tab[data-place-key="app:${target.machineId}:com.apple.notes:task:${target.sessionId}"] .side-tab__title`,
        { hasText: "Notes — Work plan" },
      )
      .waitFor();
    await page.screenshot({
      animations: "disabled",
      path: path.join(directory, "watch-window-change.png"),
    });
    const before = page.url();
    await page.evaluate(async ({ sessionId }) => {
      const client = Reflect.get(window, "opensteerMock") as MockHostClient;
      await client.rpc["integration.computer.session.stop"]({ sessionId });
    }, target);
    await page
      .locator(
        `.side-tab[data-place-key="app:${target.machineId}:com.apple.notes:task:${target.sessionId}"]`,
      )
      .waitFor({ state: "detached" });
    const observed = {
      before,
      after: page.url(),
      owner: await page.locator(".owner-view").count(),
      ownerStillListed: await page
        .locator(`.side-tab[data-place-key="app:${target.machineId}:com.apple.notes:102"]`)
        .count(),
    };
    expectThat(
      observed,
      observed.owner === 0 &&
        observed.ownerStillListed === 1 &&
        !new URL(page.url()).searchParams.has("computerView"),
      "task end substituted an owner view",
    );
    return observed;
  });
  await check(
    "Host-authored computer steps keep chips, counts and live status; outer code stays compact",
    async () => {
      await page.goto(`${web.origin}/threads/thr_00000000-0000-4000-8000-000000000006`);
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
      await page.goto(`${web.origin}/threads/thr_00000000-0000-4000-8000-000000000005`);
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
