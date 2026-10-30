/** Headless mock-Host journey. `pnpm --filter @opensteer/web test:model-picker`.
 * Builds into a temporary directory and closes its browser/server in finally.
 * OPENSTEER_CHROMIUM_EXECUTABLE optionally selects an installed Chromium.
 */
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MockHostClient } from "@opensteer/client/mock";
import { expectThat, finishJourney, journeyChecks, openMockWeb } from "./mock-web-journey.js";
const directory = path.join(tmpdir(), `composer-menu-${Date.now()}`);
await mkdir(directory, { recursive: true });
const { checks, check } = journeyChecks();
const web = await openMockWeb("composer-menu");
try {
  for (const width of [320, 390, 768, 1280]) {
    const page = await web.browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(10000);
    await check(`${width}: menu and settings`, async () => {
      await page.goto(`${web.origin}/composer-visual.html`);
      const button = page.getByRole("button", { name: /^Engine and model:/ });
      await button.waitFor();
      await page.screenshot({ path: path.join(directory, `${width}-rest.png`) });
      const footer = await page.locator(".composer__footer").evaluate((element) => {
        const rects = [...element.querySelectorAll("button")].map((button) => {
          const rect = button.getBoundingClientRect();
          return { left: rect.left, right: rect.right, width: rect.width };
        });
        return {
          rects,
          overlaps: rects.some(
            (rect, index) => index > 0 && rect.left < rects[index - 1]!.right - 1,
          ),
        };
      });
      expectThat({ footer }, !footer.overlaps, "Footer controls overlap");
      await button.click();
      const menu = page.getByRole("dialog", { name: "Choose an engine and model" });
      await menu.waitFor();
      await page.screenshot({ path: path.join(directory, `${width}-menu.png`) });
      await page.screenshot({ path: path.join(directory, `${width}-sheet.png`) });
      const box = await menu.boundingBox();
      expectThat(
        { box, width },
        !!box && box.x >= 0 && box.x + box.width <= width + 1,
        "Menu escapes viewport",
      );
      if (width < 600)
        expectThat(
          { box },
          !!box && box.y + box.height >= 899,
          "Narrow menu is not a bottom sheet",
        );
      const beforeBrowse = await button.getAttribute("aria-label");
      const codex = menu.getByRole("tab", { name: "Codex", exact: true });
      const claude = menu.getByRole("tab", { name: "Claude Code", exact: true });
      await codex.focus();
      await page.keyboard.press("ArrowDown");
      expectThat(
        {},
        await claude.evaluate((element) => element === document.activeElement),
        "Arrow keys do not rove AI chips",
      );
      await page.keyboard.press("Enter");
      expectThat(
        {},
        (await button.getAttribute("aria-label")) === beforeBrowse,
        "Browsing changed the selection",
      );
      if (width < 600) {
        const chip = await claude.boundingBox();
        expectThat({ chip }, !!chip && chip.height >= 44, "Narrow AI chip misses the touch target");
      }
      await codex.click();
      const slider = menu.getByRole("slider", { name: "Reasoning" });
      await slider.fill("1");
      await menu.getByRole("button", { name: "Default", exact: true }).click();
      expectThat(
        {},
        (await menu
          .getByRole("button", { name: "Default", exact: true })
          .getAttribute("aria-pressed")) === "true",
        "Automatic setting did not apply",
      );
      await menu.getByRole("switch", { name: "Fast", exact: true }).click();
      expectThat(
        {},
        (await menu
          .getByRole("switch", { name: "Fast", exact: true })
          .getAttribute("aria-checked")) === "true",
        "Switch did not apply",
      );
      await menu.getByRole("button", { name: /Full access ·/ }).click();
      await menu.getByRole("button", { name: "This conversation" }).waitFor();
      await page.screenshot({ path: path.join(directory, `${width}-conversation.png`) });
      await menu.getByRole("menuitemradio", { name: /Supervised/ }).click();
      await menu.getByRole("radio", { name: /alex@work.example/ }).click();
      await menu.waitFor({ state: "hidden" });
      await button.click();
      await menu.getByRole("button", { name: /Supervised ·/ }).click();
      expectThat(
        {},
        (await menu
          .getByRole("radio", { name: /alex@work.example/ })
          .getAttribute("aria-checked")) === "true",
        "Account did not apply",
      );
      await page.keyboard.press("Escape");
      await menu.getByRole("menuitemradio", { name: "GPT Mini", exact: true }).click();
      await menu.waitFor({ state: "hidden" });
      expectThat(
        {},
        (await button.getAttribute("aria-label"))?.includes("GPT Mini") === true,
        "Model did not apply",
      );
      return { width, box };
    });
    await check(`${width}: immediate recording bar`, async () => {
      await page.goto(`${web.origin}/dictation-visual.html?state=starting`);
      await page.locator(".dictation-live").waitFor();
      expectThat(
        {},
        await page.getByRole("button", { name: "Stop dictation", exact: true }).isVisible(),
        "Stop is missing during starting",
      );
      await page.screenshot({ path: path.join(directory, `${width}-recording.png`) });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      expectThat({ overflow }, !overflow, "Recording bar overflows viewport");
      return { width };
    });
    await check(`${width}: usage notice`, async () => {
      await page.goto(`${web.origin}/composer-visual.html?usage`);
      const notice = page.locator(".composer-usage");
      await notice.waitFor();
      const noticeBox = await notice.boundingBox();
      const fieldBox = await page
        .getByRole("textbox", { name: "Message", exact: true })
        .boundingBox();
      expectThat(
        { noticeBox, fieldBox },
        !!noticeBox && !!fieldBox && noticeBox.y + noticeBox.height <= fieldBox.y + 1,
        "Usage notice overlaps the field",
      );
      await page.screenshot({ path: path.join(directory, `${width}-usage.png`) });
      await notice.getByRole("button", { name: "Switch account", exact: true }).click();
      await page.getByRole("button", { name: "This conversation" }).waitFor();
      return { width };
    });
    if (width === 1280) {
      // The fixtures above apply choices to local state. This one starts a real
      // task, so a menu that looks right but never reaches the Host fails here.
      await check(`${width}: real task carries the chosen settings`, async () => {
        await page.goto(`${web.origin}/new`);
        const button = page.getByRole("button", { name: /^Engine and model:/ });
        const menu = page.getByRole("dialog", { name: "Choose an engine and model" });
        await button.click();
        await menu.getByRole("button", { name: /Full access ·/ }).click();
        await menu.getByRole("radio", { name: /alex@opensteer\.test/ }).click();
        await menu.waitFor({ state: "hidden" });
        await button.click();
        await menu.getByRole("menuitemradio", { name: "GPT-5.6-Sol", exact: true }).waitFor();
        await menu.getByRole("slider", { name: "Reasoning" }).fill("3");
        await menu.getByRole("switch", { name: "Fast", exact: true }).click();
        await menu.getByRole("button", { name: /Full access ·/ }).click();
        await menu.getByRole("menuitemradio", { name: /Supervised/ }).click();
        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");
        await menu.waitFor({ state: "hidden" });
        const message = "Carry the chosen AI settings.";
        await page.getByRole("textbox", { name: "Message", exact: true }).fill(message);
        await page.getByRole("button", { name: "Start task", exact: true }).click();
        await page.waitForFunction((sent) => {
          const snapshot = (Reflect.get(window, "opensteerMock") as MockHostClient).getSnapshot();
          return snapshot.threads.some((thread) =>
            snapshot.transcripts[thread.id]?.some(
              (entry) => entry.kind === "message" && entry.body === sent,
            ),
          );
        }, message);
        const stored = await page.evaluate((sent) => {
          const snapshot = (Reflect.get(window, "opensteerMock") as MockHostClient).getSnapshot();
          const account = snapshot.environments
            .flatMap((environment) => environment.harnessCatalogs)
            .find((catalog) =>
              catalog.connections.some(
                (connection) => connection.accountLabel === "alex@opensteer.test",
              ),
            )?.harnessInstanceId;
          const thread = snapshot.threads.find((candidate) =>
            snapshot.transcripts[candidate.id]?.some(
              (entry) => entry.kind === "message" && entry.body === sent,
            ),
          );
          return { account, preferences: snapshot.executionPreferences, thread };
        }, message);
        const remembered = stored.preferences.history[0];
        expectThat(
          stored,
          !!stored.account &&
            stored.thread?.harnessInstanceId === stored.account &&
            stored.thread.modelSelection.modelId === "gpt-5.6-sol" &&
            stored.thread.modelSelection.options.effort === "high" &&
            stored.thread.modelSelection.options.speed === "priority" &&
            stored.thread.accessMode === "approval-required" &&
            remembered?.harnessInstanceId === stored.account &&
            remembered.modelSelection.options.effort === "high" &&
            remembered.modelSelection.options.speed === "priority" &&
            stored.preferences.accessMode === "approval-required",
          "The sent task or saved preferences lost the chosen account, model, options or access",
        );
        return { thread: stored.thread?.id };
      });
    }
    await page.close();
  }
} finally {
  await web.close();
}
await finishJourney(directory, checks);
