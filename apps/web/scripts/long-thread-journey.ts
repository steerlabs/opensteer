/**
 * A conversation of several hundred rows, end to end in a real browser: the
 * production web build against the mock Host, driven in headless Chromium.
 * Every loaded row stays in the document and the browser skips laying out
 * and painting the ones off screen (`content-visibility: auto`), so this
 * walks everything that skipping could break.
 *
 * Ways this journey can fail, each checked below:
 *  1. A loaded row is missing from the document, rows are not skipped, or the
 *     newest reply is not on screen at the tail.
 *  2. A reply that streams in leaves the reader short of the tail.
 *  3. Scrolling up through the conversation moves what the reader is looking
 *     at once rows above are laid out, or never reaches its first question.
 *  4. Browser Find cannot reach a message far above the reader.
 *  5. Tab stops short of the controls in rows off screen.
 *  6. A selection across several screens copies less than it spans.
 *  7. Find in conversation cannot reach a message far away, or the found
 *     message is not on screen.
 *  8. "Earlier messages" moves the row the reader was on out of view, or the
 *     rows keep shifting after the page has landed.
 *  9. Coming back to the conversation lands somewhere other than where the
 *     reader left it.
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
    "keeps every row in the document, skipping off-screen ones, at the tail",
    async () => {
      const observed = await page.evaluate((selector) => {
        const element = document.querySelector<HTMLElement>(selector)!;
        const rows = [...element.querySelectorAll<HTMLElement>("[data-transcript-row]")];
        return {
          rows: rows.length,
          skipped: getComputedStyle(rows[0]!).contentVisibility,
          nodes: document.getElementsByTagName("*").length,
          fromTail: element.scrollHeight - element.clientHeight - element.scrollTop,
        };
      }, scroller);
      await shot("01-tail.png");
      expectThat(observed, observed.rows >= turns * 2, "A loaded row is not in the document.");
      expectThat(observed, observed.skipped === "auto", "Off-screen rows are not skipped.");
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

  await check(
    "scrolling up to the first question moves what the reader sees by the page only",
    async () => {
      // Real input: Page Up from the keyboard, then the wheel. Rows above lay out as they near the
      // view; what is on screen must move by exactly the distance scrolled, never more.
      await page.locator(scroller).click({ position: { x: 4, y: 200 } });
      const moves: number[] = [];
      const press = async (key: "PageUp" | "wheel") => {
        const before = await page.evaluate((selector) => {
          const element = document.querySelector<HTMLElement>(selector)!;
          const box = element.getBoundingClientRect();
          const row = [...element.querySelectorAll<HTMLElement>("[data-transcript-row]")].find(
            (candidate) => candidate.getBoundingClientRect().top > box.top + box.height * 0.6,
          );
          if (!row) return null;
          row.dataset.journeyHeld = "true";
          return row.getBoundingClientRect().top;
        }, scroller);
        if (key === "PageUp") await page.keyboard.press("PageUp");
        else await page.mouse.wheel(0, -120);
        await page.waitForTimeout(key === "PageUp" ? 350 : 120);
        await settle(page);
        if (before === null) return 0;
        const after = await page.evaluate(() => {
          const row = document.querySelector<HTMLElement>("[data-journey-held]")!;
          delete row.dataset.journeyHeld;
          return row.getBoundingClientRect().top;
        });
        return Math.round(after - before);
      };
      for (let step = 0; step < 400; step++) {
        moves.push(await press("PageUp"));
        if (step === 30) await shot("03-scrolling.png");
        const top = await page.evaluate(
          (selector) => document.querySelector<HTMLElement>(selector)!.scrollTop,
          scroller,
        );
        if (top === 0) break;
      }
      // The last press stops at the top; the rest each move one page.
      const pages = moves.slice(0, -1).filter((move) => move !== 0);
      const wheel: number[] = [];
      await page.evaluate((selector) => {
        const element = document.querySelector<HTMLElement>(selector)!;
        element.scrollTop = element.scrollHeight / 2;
      }, scroller);
      await settle(page);
      await page.mouse.move(640, 400);
      for (let tick = 0; tick < 40; tick++) wheel.push(await press("wheel"));
      await page.evaluate((selector) => {
        document.querySelector<HTMLElement>(selector)!.scrollTop = 0;
      }, scroller);
      await settle(page);
      const first = await page.getByText("Question 0:").isVisible();
      await shot("04-top.png");
      const page_ = pages.toSorted((a, b) => a - b)[Math.floor(pages.length / 2)] ?? 0;
      const observed = {
        pages: pages.length,
        pageMove: page_,
        uneven: pages.filter((move) => Math.abs(move - page_) > 2),
        wheelUneven: wheel.filter((move) => Math.abs(move - 120) > 2),
        first,
      };
      expectThat(observed, observed.uneven.length === 0, "A Page Up moved the view by more.");
      expectThat(
        observed,
        observed.wheelUneven.length === 0,
        "A wheel step moved the view by more.",
      );
      expectThat(observed, first, "The first question is not on screen at the top.");
      return observed;
    },
  );

  await check("browser Find reaches a message far below the reader", async () => {
    const found = await page.evaluate((text) => {
      (document.activeElement as HTMLElement | null)?.blur();
      window.getSelection()!.removeAllRanges();
      const search = window as unknown as {
        find(text: string, cased: boolean, backwards: boolean, wrap: boolean): boolean;
      };
      return search.find(text, false, false, true);
    }, "Question 250:");
    await settle(page);
    const observed = await page.evaluate((selector) => {
      const selection = window.getSelection()!;
      const node = selection.anchorNode?.parentElement;
      const box = node?.getBoundingClientRect();
      const view = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
      return {
        selected: selection.toString(),
        inView: box ? box.bottom > view.top && box.top < view.bottom : false,
      };
    }, scroller);
    await shot("05-browser-find.png");
    // `window.find` matches as the find bar does; scrolling to the match is the find bar's own.
    expectThat(
      { found, ...observed },
      found && observed.selected === "Question 250:",
      "Not found.",
    );
    return { found, ...observed };
  });

  await check("Tab reaches the controls of rows off screen", async () => {
    const start = await page.evaluate((selector) => {
      const element = document.querySelector<HTMLElement>(selector)!;
      const view = element.getBoundingClientRect();
      const controls = [...element.querySelectorAll<HTMLElement>("[data-transcript-row] button")];
      const visible = controls.filter((control) => {
        const box = control.getBoundingClientRect();
        return box.top >= view.top && box.bottom <= view.bottom;
      });
      const last = visible.at(-1)!;
      last.focus();
      const below = controls.slice(controls.indexOf(last) + 1);
      // The first control not yet on screen, two screens down.
      const target = below.find(
        (control) => control.getBoundingClientRect().top > view.bottom + view.height * 2,
      )!;
      target.dataset.journeyTarget = "true";
      return below.indexOf(target) + 1;
    }, scroller);
    for (let press = 0; press < start; press++) await page.keyboard.press("Tab");
    await settle(page);
    const observed = await page.evaluate((selector) => {
      const focused = document.activeElement as HTMLElement | null;
      const box = focused?.getBoundingClientRect();
      const view = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
      return {
        reached: focused?.dataset.journeyTarget === "true",
        inView: box ? box.bottom > view.top && box.top < view.bottom : false,
      };
    }, scroller);
    await shot("06-tab.png");
    expectThat({ start, ...observed }, observed.reached, "Tab stopped short of the row.");
    expectThat(observed, observed.inView, "The focused control is not on screen.");
    return { presses: start, ...observed };
  });

  await check("a selection across several screens copies everything it spans", async () => {
    const observed = await page.evaluate(() => {
      const bodies = [...document.querySelectorAll<HTMLElement>(".msg--assistant__body")];
      const from = bodies.find((body) => body.textContent?.startsWith("Reply 100."))!;
      const to = bodies.find((body) => body.textContent?.startsWith("Reply 140."))!;
      const range = document.createRange();
      range.setStartBefore(from);
      range.setEndAfter(to);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      const text = selection.toString();
      const missing = Array.from({ length: 41 }, (_, index) => `Reply ${100 + index}.`).filter(
        (reply) => !text.includes(reply),
      );
      selection.removeAllRanges();
      return { length: text.length, missing };
    });
    expectThat(observed, observed.missing.length === 0, "The copy skipped rows.");
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
      // Two pages first, so the anchor sits among many loaded rows.
      for (let page_ = 0; page_ < 2; page_++) {
        await earlier.click();
        await page.waitForFunction(
          () => !document.querySelector(".transcript__load-earlier[aria-busy='true']"),
        );
        await slid(page);
      }
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
      const observed = { anchor, landed, later, viewport };
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
  try {
    await finishJourney(artifactDirectory, checks);
  } finally {
    await web.close();
  }
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
