/**
 * A conversation of several hundred rows, end to end in a real browser: the
 * production web build against the mock Host, driven in headless Chromium.
 * The web transcript draws only the rows near the reader and measured gaps
 * for the rest, so this walks everything that windowing could break.
 *
 * Ways this journey can fail, each checked below:
 *  1. Every row is drawn, or the newest reply is not on screen at the tail.
 *  2. A reply that streams in leaves the reader short of the tail.
 *  3. Scrolling up through the conversation shows an empty gap where rows
 *     should be, or never reaches its first question.
 *  4. A text selection inside a row is lost when the reader scrolls away.
 *  5. An opened step is closed again after its row leaves the window and returns.
 *  6. Find in conversation cannot reach a message far outside the window, or
 *     the found message is not on screen.
 *  7. "Earlier messages" moves the row the reader was on out of view, or the
 *     rows keep shifting after the page has landed.
 *
 * `result.json` and screenshots go to OPENSTEER_LONG_THREAD_E2E_ARTIFACT_DIR,
 * or `opensteer-long-thread-e2e` in the system temporary directory.
 */
import type { MockHostClient } from "@opensteer/client/mock";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "playwright-core";
import { expectThat, finishJourney, journeyChecks, openMockWeb } from "./mock-web-journey.js";

const artifactDirectory = path.resolve(
  process.env.OPENSTEER_LONG_THREAD_E2E_ARTIFACT_DIR ??
    path.join(tmpdir(), "opensteer-long-thread-e2e"),
);
const homeTask = "/tasks/thr_00000000-0000-4000-8000-000000000002";
const turns = 300;
const scroller = ".transcript-scroll";

const { checks, check, abort } = journeyChecks();

await rm(artifactDirectory, { force: true, recursive: true });
await mkdir(artifactDirectory, { recursive: true });
const web = await openMockWeb("opensteer-long-thread-web");
const { browser, origin } = web;

try {
  const context = await browser.newContext({ viewport: { height: 900, width: 1280 } });
  context.setDefaultTimeout(8_000);
  context.setDefaultNavigationTimeout(15_000);
  await context.route(
    (url) => url.origin !== origin,
    (route) => route.fulfill({ body: "", contentType: "text/plain", status: 204 }),
  );
  const page = await context.newPage();
  const shot = (name: string) => page.screenshot({ path: path.join(artifactDirectory, name) });

  await page.goto(`${origin}${homeTask}`);
  await page.waitForFunction(
    () =>
      (Reflect.get(window, "opensteerMock") as MockHostClient)?.getSnapshot().connection ===
      "connected",
  );
  const threadId = await page.evaluate(
    (count) => (Reflect.get(window, "opensteerMock") as MockHostClient).mockLongThread(count),
    turns,
  );
  // In-app navigation keeps the mock world this page seeded.
  await page.evaluate((route) => {
    window.history.pushState({}, "", route);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, `/tasks/${threadId}`);
  await page.getByText(`Reply ${turns - 1}.`).waitFor();
  await settle(page);

  await check(
    "draws only the rows near the reader, with the newest reply at the tail",
    async () => {
      const observed = await page.evaluate((selector) => {
        const element = document.querySelector<HTMLElement>(selector)!;
        return {
          drawn: element.querySelectorAll("[data-transcript-row]").length,
          gaps: element.querySelectorAll(".transcript__gap").length,
          fromTail: element.scrollHeight - element.clientHeight - element.scrollTop,
        };
      }, scroller);
      await shot("01-tail.png");
      expectThat(observed, observed.drawn < 120, "Every row was drawn.");
      expectThat(observed, observed.gaps >= 1, "No gap stands in for the rows not drawn.");
      expectThat(observed, observed.fromTail < 4, "The reader is not at the tail.");
      return observed;
    },
  );

  await check("a reply that streams in keeps the reader at the tail", async () => {
    await page.getByRole("textbox", { name: "Message", exact: true }).fill("One more question.");
    await page.keyboard.press("Enter");
    const samples: number[] = [];
    for (let sample = 0; sample < 20; sample++) {
      await page.waitForTimeout(150);
      samples.push(
        await page.evaluate((selector) => {
          const element = document.querySelector<HTMLElement>(selector)!;
          return Math.round(element.scrollHeight - element.clientHeight - element.scrollTop);
        }, scroller),
      );
    }
    await settle(page);
    await shot("02-streamed.png");
    const observed = { samples, worst: Math.max(...samples) };
    expectThat(observed, observed.worst < 8, "The tail fell out of view while the reply grew.");
    return observed;
  });

  await check("scrolling up to the first question never shows an empty gap", async () => {
    const blanks: number[] = [];
    let steps = 0;
    while (steps < 400) {
      steps++;
      const top = await page.evaluate((selector) => {
        const element = document.querySelector<HTMLElement>(selector)!;
        element.scrollTop -= element.clientHeight * 0.8;
        return element.scrollTop;
      }, scroller);
      await settle(page);
      const empty = await page.evaluate((selector) => {
        const element = document.querySelector<HTMLElement>(selector)!;
        const box = element.getBoundingClientRect();
        const x = box.left + box.width / 2;
        return [0.2, 0.5, 0.8].filter((at) => {
          const hit = document.elementFromPoint(x, box.top + box.height * at);
          return hit?.closest(".transcript__gap") !== null && hit?.closest(".transcript__gap");
        }).length;
      }, scroller);
      if (empty) blanks.push(steps);
      if (steps === 40) await shot("03-scrolling.png");
      if (top === 0) break;
    }
    await settle(page);
    const first = await page.getByText("Question 0:").isVisible();
    await shot("04-top.png");
    const observed = { blanks, steps, first };
    expectThat(observed, blanks.length === 0, "A gap showed where rows should be.");
    expectThat(observed, first, "The first question is not on screen at the top.");
    return observed;
  });

  await check("a selection and an opened step survive scrolling away and back", async () => {
    const reply = page.locator(".msg--assistant__body").filter({ hasText: "Reply 3." }).first();
    await reply.scrollIntoViewIfNeeded();
    const turn = reply.locator("xpath=ancestor::*[@data-transcript-row]");
    await turn.locator(".work__head").click();
    await turn.getByRole("button", { name: /Ran / }).first().click();
    await turn.locator(".trace-step--open").first().waitFor();
    const key = await turn.getAttribute("data-transcript-row");
    await reply.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    const selected = await page.evaluate(() => window.getSelection()!.toString().trim());
    const back = await page.evaluate((selector) => {
      const element = document.querySelector<HTMLElement>(selector)!;
      const position = element.scrollTop;
      element.scrollTop += element.clientHeight * 12;
      return position;
    }, scroller);
    await settle(page);
    const awayDrawn = await page.evaluate(
      (row) => document.querySelector(`[data-transcript-row="${CSS.escape(row)}"]`) !== null,
      key!,
    );
    // A selection or focus keeps its row drawn; let both go to see the opened step come back.
    const kept = await page.evaluate(() => window.getSelection()!.toString().trim());
    await page.evaluate(() => {
      window.getSelection()!.removeAllRanges();
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await page.evaluate((selector) => {
      const element = document.querySelector<HTMLElement>(selector)!;
      element.scrollTop += element.clientHeight * 6;
    }, scroller);
    await settle(page);
    const goneAfter = await page.evaluate(
      (row) => document.querySelector(`[data-transcript-row="${CSS.escape(row)}"]`) === null,
      key!,
    );
    await page.evaluate(
      ({ selector, position }) => {
        document.querySelector<HTMLElement>(selector)!.scrollTop = position;
      },
      { selector: scroller, position: back },
    );
    await settle(page);
    const row = page.locator(`[data-transcript-row="${key}"]`);
    const open = await row.locator(".trace-step--open").count();
    await shot("05-step-kept.png");
    const observed = { selected, kept, awayDrawn, goneAfter, open };
    expectThat(observed, kept === selected && kept.length > 0, "The selection was lost.");
    expectThat(observed, awayDrawn, "The selected row was not kept drawn.");
    expectThat(observed, goneAfter, "The row never left the window.");
    expectThat(observed, open > 0, "The opened step came back closed.");
    return observed;
  });

  await check("find in conversation reaches a message far outside the window", async () => {
    await page.evaluate((selector) => {
      const element = document.querySelector<HTMLElement>(selector)!;
      element.scrollTop = element.scrollHeight;
    }, scroller);
    await settle(page);
    await page.keyboard.press("Control+f");
    const field = page.getByRole("searchbox", { name: "Find in conversation" });
    await field
      .or(page.getByRole("textbox", { name: "Find in conversation" }))
      .first()
      .fill("Question 40:");
    await page.keyboard.press("Enter");
    const result = page.locator(".thread-find__result").filter({ hasText: "Question 40:" }).first();
    await result.click();
    const found = page.locator(".transcript__found");
    await found.waitFor();
    await settle(page);
    const observed = await found.evaluate((element, selector) => {
      const box = element.getBoundingClientRect();
      const view = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
      return {
        text: element.textContent?.slice(0, 40) ?? "",
        inView: box.bottom > view.top && box.top < view.bottom,
      };
    }, scroller);
    await shot("06-found.png");
    expectThat(observed, observed.text.includes("Question 40:"), "The wrong message was found.");
    expectThat(observed, observed.inView, "The found message is not on screen.");
    return observed;
  });

  await check(
    "earlier messages land above the reader without moving them out of view",
    async () => {
      const earlier = page.getByRole("button", { name: "Earlier messages" });
      // Two pages first, so the loaded window is long enough to be drawn in part.
      for (let page_ = 0; page_ < 2; page_++) {
        await earlier.click();
        await page.waitForFunction(
          () => !document.querySelector(".transcript__load-earlier[aria-busy='true']"),
        );
        await slid(page);
      }
      const before = await page.evaluate(
        (selector) => document.querySelectorAll(`${selector} .transcript__gap`).length,
        scroller,
      );
      await earlier.scrollIntoViewIfNeeded();
      await settle(page);
      const anchor = await page.evaluate((selector) => {
        const element = document.querySelector<HTMLElement>(selector)!;
        const top = element.getBoundingClientRect().top;
        // A message keeps its id when an earlier page renames the row it sits in.
        const message = [...element.querySelectorAll<HTMLElement>("[data-message-id]")].find(
          (candidate) => candidate.getBoundingClientRect().top > top + 1,
        )!;
        return { id: message.dataset.messageId!, top: message.getBoundingClientRect().top - top };
      }, scroller);
      await shot("07-before-earlier.png");
      await earlier.click();
      await page.waitForFunction(
        () => !document.querySelector(".transcript__load-earlier[aria-busy='true']"),
      );
      const where = () =>
        page.evaluate(
          ({ selector, id }) => {
            const element = document.querySelector<HTMLElement>(selector)!;
            const row = element.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
            return row
              ? Math.round(row.getBoundingClientRect().top - element.getBoundingClientRect().top)
              : null;
          },
          { selector: scroller, id: anchor.id },
        );
      // The page lands with a short slide; read the anchor once it has finished.
      await slid(page);
      await settle(page);
      const landed = await where();
      await page.waitForTimeout(800);
      const later = await where();
      await shot("08-after-earlier.png");
      const viewport = await page.evaluate(
        (selector) => document.querySelector<HTMLElement>(selector)!.clientHeight,
        scroller,
      );
      const observed = { anchor, landed, later, viewport, gapsBefore: before };
      expectThat(observed, landed !== null && later !== null, "The anchor row was not drawn.");
      expectThat(
        observed,
        landed !== null && landed >= 0 && landed < viewport,
        "The anchor row left the view.",
      );
      expectThat(
        observed,
        landed !== null && later !== null && Math.abs(later - landed) < 2,
        "The rows kept shifting after the page landed.",
      );
      return observed;
    },
  );

  await check("coming back lands on the message the reader left, without a jump", async () => {
    const go = async (route: string) => {
      await page.evaluate((to) => {
        window.history.pushState({}, "", to);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }, route);
      await page.waitForFunction((to) => window.location.pathname === to, route);
      await page.locator(`${scroller} [data-transcript-row]`).first().waitFor();
      await settle(page);
    };
    await go(`/tasks/${threadId}`);
    await page.evaluate((selector) => {
      const element = document.querySelector<HTMLElement>(selector)!;
      element.scrollTop = Math.max(0, element.scrollTop - element.clientHeight * 4);
    }, scroller);
    await settle(page);
    const left = await page.evaluate((selector) => {
      const element = document.querySelector<HTMLElement>(selector)!;
      const top = element.getBoundingClientRect().top;
      const message = [...element.querySelectorAll<HTMLElement>("[data-message-id]")].find(
        (candidate) => candidate.getBoundingClientRect().top > top + 1,
      )!;
      return { id: message.dataset.messageId!, top: message.getBoundingClientRect().top - top };
    }, scroller);
    await go(homeTask);
    await go(`/tasks/${threadId}`);
    const where = () =>
      page.evaluate(
        ({ selector, id }) => {
          const element = document.querySelector<HTMLElement>(selector);
          const row = element?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
          return element && row
            ? Math.round(row.getBoundingClientRect().top - element.getBoundingClientRect().top)
            : null;
        },
        { selector: scroller, id: left.id },
      );
    await page.waitForFunction(
      ({ selector, id }) =>
        document.querySelector(`${selector} [data-message-id="${CSS.escape(id)}"]`) !== null,
      { selector: scroller, id: left.id },
    );
    await settle(page);
    const landed = await where();
    await page.waitForTimeout(600);
    const later = await where();
    await shot("09-returned.png");
    const observed = { left, landed, later };
    expectThat(
      observed,
      landed !== null && Math.abs(landed - Math.round(left.top)) < 2,
      "The reader came back somewhere else.",
    );
    expectThat(
      observed,
      landed !== null && later !== null && Math.abs(later - landed) < 2,
      "The view moved after it came back.",
    );
    return observed;
  });
} catch (error) {
  abort(error);
} finally {
  await finishJourney(artifactDirectory, checks).finally(() => web.close());
}

/** The finite animations, such as the slide an earlier page lands with, have finished. */
async function slid(page: Page) {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.playState !== "running" ||
          animation.effect?.getComputedTiming().iterations === Infinity,
      ),
  );
  await settle(page);
}

/** Three frames for scroll, layout and measurement to settle. */
async function settle(page: Page) {
  for (let frame = 0; frame < 3; frame++)
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
}
