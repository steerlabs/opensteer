/**
 * An overnight task in real Chromium, using the production renderer and event
 * reducer. The mock supplies only Host state; it does not test transport paging.
 *
 * Failures this journey must catch before changing the layout or scroll owner:
 * - a large transcript expands the outer body, hiding its latest row even while
 *   the inner scroller claims to be at the bottom;
 * - opening a narrow Work panel leaves a blank clipped viewport or hides input;
 * - leaving A scrolled up makes a newly opened B inherit A's scroll intent;
 * - returning to A loses its place, or live updates pull it away from that place;
 * - jumping to latest is itself outside the viewport, or subsequent work stops
 *   following the tail;
 * - a reload or smaller window loses the newest content or composer.
 *
 * Run through pnpm test:vm. Set OPENSTEER_LARGE_TRANSCRIPT_EVIDENCE_DIR inside
 * the guest's exported artifacts directory. Every check keeps geometry, and
 * screenshots plus result.json remain available when an assertion fails.
 */
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HostSnapshot, TranscriptEntry } from "@opensteer/client/host";
import type { MockHostClient } from "@opensteer/client/mock";
import type { ThreadId } from "@opensteer/core";
import type { BrowserContext, Page } from "playwright-core";
import { largeTranscriptFixture } from "./large-transcript-fixture.js";
import { expectThat, finishJourney, journeyChecks, openMockWeb } from "./mock-web-journey.js";

const directory = path.resolve(
  process.env.OPENSTEER_LARGE_TRANSCRIPT_EVIDENCE_DIR ??
    path.join(tmpdir(), "opensteer-large-transcript-evidence"),
);
const threadA = "thr_00000000-0000-4000-8000-000000000002";
const threadB = "thr_00000000-0000-4000-8000-000000000003";
const fixture = largeTranscriptFixture();
const { checks, check, abort } = journeyChecks();
await mkdir(directory, { recursive: true });
const web = await openMockWeb("opensteer-large-transcript");
const screenshots: string[] = [];
const pageErrors: string[] = [];
const responsiveness = { initialMs: 0, appendPaintMs: [] as number[], composerPaintMs: 0 };

async function installFixture(context: BrowserContext) {
  // tsx names nested functions with a helper that the browser does not ship.
  await context.addInitScript("globalThis.__name = (value) => value;");
  await context.addInitScript(
    ({ entries, first, second }) => {
      let client: MockHostClient | undefined;
      const listeners = new Set<() => void>();
      const composerIdentities = new WeakMap<Element, number>();
      let nextComposerIdentity = 0;
      Object.defineProperty(window, "opensteerLargeTranscriptComposerIdentity", {
        value: (element: Element | null) => {
          if (!element) return null;
          let identity = composerIdentities.get(element);
          if (identity === undefined) {
            identity = ++nextComposerIdentity;
            composerIdentities.set(element, identity);
          }
          return identity;
        },
      });
      let base: HostSnapshot | undefined;
      let projected: HostSnapshot | undefined;
      let current = entries;
      let showRequests = false;
      Object.defineProperty(window, "opensteerLargeTranscriptRequests", {
        value: (enabled: boolean) => {
          showRequests = enabled;
          base = undefined;
          for (const listener of listeners) listener();
        },
      });
      Object.defineProperty(window, "opensteerLargeTranscriptAppend", {
        value: (entry: TranscriptEntry) => {
          current = [...current, entry];
          base = undefined;
          for (const listener of listeners) listener();
        },
      });
      Object.defineProperty(window, "opensteerMock", {
        configurable: true,
        get: () => client,
        set(value: MockHostClient) {
          client = value;
          const read = value.getSnapshot;
          const subscribe = value.subscribe;
          Object.defineProperty(value, "subscribe", {
            value: (listener: () => void) => {
              listeners.add(listener);
              const dispose = subscribe(listener);
              return () => {
                listeners.delete(listener);
                dispose();
              };
            },
          });
          Object.defineProperty(value, "getSnapshot", {
            value: (): HostSnapshot => {
              const next = read();
              if (next === base && projected) return projected;
              base = next;
              const ids = new Set([first, second]);
              const result: HostSnapshot = {
                ...next,
                threads: next.threads.map((thread) =>
                  ids.has(thread.id)
                    ? {
                        ...thread,
                        status: showRequests && thread.id === first ? "waiting" : "idle",
                        pendingRequests: showRequests && thread.id === first ? 1 : 0,
                        inputQueuePaused: false,
                      }
                    : thread,
                ),
                runQueue: next.runQueue.filter((run) => !ids.has(run.threadId)),
                requests: {
                  ...next.requests,
                  [first]: showRequests ? (next.requests[first] ?? []) : [],
                  [second]: [],
                },
                waitingRequests: next.waitingRequests.filter(
                  ({ request }) =>
                    !ids.has(request.originatingThreadId) ||
                    (showRequests && request.originatingThreadId === first),
                ),
                inputQueues: {
                  ...next.inputQueues,
                  ...Object.fromEntries(
                    next.threads
                      .filter(({ id }) => ids.has(id))
                      .map(({ id }) => [
                        id,
                        { threadId: id as ThreadId, items: [], paused: false, steerRunId: null },
                      ]),
                  ),
                },
                transcripts: { ...next.transcripts, [first]: current, [second]: entries },
                transcriptWindows: {
                  ...next.transcriptWindows,
                  ...Object.fromEntries(
                    [...ids].map((threadId) => [
                      threadId,
                      {
                        threadId,
                        byteCount: 0,
                        hasMore: false,
                        itemCount: 1084,
                        totalItems: 1084,
                        nextBefore: null,
                      },
                    ]),
                  ),
                },
              };
              projected = result;
              return result;
            },
          });
        },
      });
    },
    { entries: fixture.entries, first: threadA, second: threadB },
  );
}

async function settle(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) =>
          Number.isFinite(Number(animation.effect?.getComputedTiming().endTime)),
        )
        .map((animation) => animation.finished.catch(() => undefined)),
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
}

async function shownThread(page: Page, threadId: string) {
  // The router changes the URL before React finishes its deferred screen commit.
  // Wait for that task's rendered identity before measuring its viewport.
  await page.waitForFunction((id) => {
    const client = Reflect.get(window, "opensteerMock") as MockHostClient | undefined;
    const thread = client?.getSnapshot().threads.find((item) => item.id === id);
    return !!thread && document.querySelector(".conv-header__name")?.textContent === thread.title;
  }, threadId);
}

async function geometry(page: Page, newestMessageId = fixture.newestMessageId) {
  return page.evaluate((messageId) => {
    const selectors = [
      ".thread",
      ".thread__body",
      ".thread__conversation",
      ".transcript-scroll",
      ".transcript",
      ".composer-dock",
    ];
    const boxes = selectors.map((selector) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing ${selector}`);
      const rect = element.getBoundingClientRect();
      const css = getComputedStyle(element);
      return {
        selector,
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        height: rect.height,
        width: rect.width,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop,
        minHeight: css.minHeight,
        flexBasis: css.flexBasis,
        flexShrink: css.flexShrink,
        computedHeight: css.height,
        overflowY: css.overflowY,
      };
    });
    const body = boxes[1]!;
    const scroller = boxes[3]!;
    const composer = boxes[5]!;
    const phoneSheet = !!document.querySelector(".thread--sheet-open");
    const owner = phoneSheet ? body : scroller;
    const scrollElement = document.querySelector(".transcript-scroll")!;
    const positioned = [...scrollElement.querySelectorAll<HTMLElement>("*")].filter(
      (element) => getComputedStyle(element).position === "absolute",
    );
    const escaped = positioned.filter(
      (element) => !element.offsetParent || !scrollElement.contains(element.offsetParent),
    );
    const newest = document.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(messageId)}"]`,
    );
    const rect = newest?.getBoundingClientRect();
    const top = Math.max(0, body.top, scroller.top);
    const bottom = Math.min(innerHeight, body.bottom, scroller.bottom);
    const center = document.elementFromPoint(
      (scroller.left + scroller.right) / 2,
      (top + bottom) / 2,
    );
    const jump = document.querySelector<HTMLElement>(".transcript__jump")?.getBoundingClientRect();
    const header = document.querySelector(".conv-header__name")?.textContent ?? null;
    const client = Reflect.get(window, "opensteerMock") as MockHostClient;
    const input = document.querySelector<HTMLTextAreaElement>(".composer-dock textarea");
    const composerIdentity = Reflect.get(window, "opensteerLargeTranscriptComposerIdentity") as (
      element: Element | null,
    ) => number | null;
    return {
      boxes,
      identity: {
        path: location.pathname,
        header,
        renderedThreadId:
          client.getSnapshot().threads.find((thread) => thread.title === header)?.id ?? null,
        composer: {
          instance: composerIdentity(input),
          placeholder: input?.placeholder ?? null,
          value: input?.value ?? null,
        },
      },
      documentHeight: document.documentElement.scrollHeight,
      viewportHeight: innerHeight,
      transcriptNodes: document.querySelector(".transcript")?.querySelectorAll("*").length ?? 0,
      positionedDescendants: positioned.length,
      escapedPositionedDescendants: escaped.length,
      escapedExamples: escaped.slice(0, 3).map((element) => ({
        className: element.className,
        text: element.textContent?.slice(0, 80),
        offsetParent: element.offsetParent?.className ?? null,
      })),
      newest: rect ? { top: rect.top, bottom: rect.bottom, height: rect.height } : null,
      newestVisible: !!rect && rect.bottom > top && rect.top < bottom,
      bodyOverflow: body.scrollHeight - body.clientHeight,
      tailGap: owner.scrollHeight - owner.clientHeight - owner.scrollTop,
      scrollOwner: phoneSheet ? ".thread__body" : ".transcript-scroll",
      composerVisible: composer.top >= 0 && composer.bottom <= innerHeight + 1,
      center: center
        ? {
            tag: center.tagName,
            className: center.className,
            text: center.textContent?.slice(0, 160),
          }
        : null,
      jumpVisible: !!jump && jump.top >= top && jump.bottom <= bottom,
      scrollTop: scroller.scrollTop,
    };
  }, newestMessageId);
}

async function capture(page: Page, name: string) {
  const filename = path.join(directory, `${name}.png`);
  await page.screenshot({ path: filename, animations: "disabled" });
  screenshots.push(filename);
}

async function latest(page: Page, name: string, newestMessageId?: string) {
  await settle(page);
  const observed = await geometry(page, newestMessageId);
  await capture(page, name);
  expectThat(observed, observed.newestVisible, "newest reply is outside the clipping ancestors");
  if (observed.scrollOwner === ".transcript-scroll")
    expectThat(
      observed,
      observed.bodyOverflow <= 1,
      "a text-only transcript expands the outer body",
    );
  expectThat(observed, observed.tailGap <= 2, "opening this task did not reach its latest content");
  expectThat(observed, observed.composerVisible, "the composer is outside the window");
  return observed;
}

async function showRequests(page: Page, enabled: boolean) {
  await page.evaluate((value) => {
    const show = Reflect.get(window, "opensteerLargeTranscriptRequests") as (
      enabled: boolean,
    ) => void;
    show(value);
  }, enabled);
  await settle(page);
}

async function requestReachable(page: Page, name: string) {
  await page.locator(".request-card").waitFor({ state: "attached" });
  await page.locator(".thread__body").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await settle(page);
  const observed = {
    ...(await geometry(page)),
    request: await page.locator(".request-card").evaluate((card) => {
      const body = card.closest(".thread__body")!;
      const send = [...card.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Send",
      );
      const button = send?.getBoundingClientRect();
      const viewport = body.getBoundingClientRect();
      const stack = card.closest<HTMLElement>(".request-stack")!;
      return {
        height: stack.scrollHeight,
        sendVisible:
          !!button &&
          button.top >= viewport.top &&
          button.bottom <= Math.min(viewport.bottom, innerHeight) + 1,
      };
    }),
  };
  await capture(page, name);
  expectThat(
    observed,
    observed.bodyOverflow > 0,
    "the long request did not exercise outer scrolling",
  );
  expectThat(
    observed,
    observed.request.sendVisible && observed.composerVisible,
    "the request's Send or composer is unreachable",
  );
  if (observed.scrollOwner === ".transcript-scroll")
    expectThat(
      observed,
      observed.boxes[1]!.scrollHeight <=
        observed.request.height + observed.boxes[2]!.clientHeight + 2,
      "transcript overflow leaked into the request scroll area",
    );
  return observed;
}

try {
  await check("synthetic incident retains the observed volume", async () => {
    const observed = fixture.counts;
    expectThat(
      observed,
      observed.events === 7004 &&
        observed.messages === 1084 &&
        observed.tools === 1078 &&
        observed.runs === 188,
      "fixture no longer matches the incident's counts",
    );
    expectThat(observed, observed.bytes >= 7 * 1024 * 1024, "fixture is smaller than the incident");
    return observed;
  });
  const context = await web.browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.route(
    (url) => url.origin !== web.origin,
    (route) => route.fulfill({ status: 204, body: "" }),
  );
  await installFixture(context);
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${web.origin}/threads/${threadA}`);
  await shownThread(page, threadA);
  await page
    .locator(`[data-message-id="${fixture.newestMessageId}"]`)
    .waitFor({ state: "attached" });
  await settle(page);
  responsiveness.initialMs = await page.evaluate(() => performance.now());
  await check("the overnight transcript initially paints within five seconds", async () => {
    const observed = { initialMs: responsiveness.initialMs, limitMs: 5_000 };
    expectThat(
      observed,
      observed.initialMs <= observed.limitMs,
      "initial transcript paint exceeded five seconds",
    );
    return observed;
  });
  await check("large task opens on its visible latest reply", () => latest(page, "wide-latest"));

  await page.locator(".side-tab__main").first().click();
  await page.locator(".workspace--work").waitFor();
  await check("narrow desktop Work panel has visible transcript and input", async () => {
    const observed = await latest(page, "narrow-work-latest");
    expectThat(
      observed,
      observed.boxes[0]!.width <= 500,
      "journey did not open a narrow Work panel",
    );
    return observed;
  });

  await check("scrolling the outer body cannot turn a text-only task blank", async () => {
    try {
      await page.locator(".thread__body").evaluate((element) => {
        element.scrollTop = 500;
      });
      await settle(page);
      const observed = await geometry(page);
      await capture(page, "outer-scroll-attempt");
      expectThat(
        observed,
        observed.boxes[1]!.scrollTop <= 1 && observed.newestVisible,
        "outer scrolling displaced the transcript into blank space",
      );
      return observed;
    } finally {
      // Start the following independent journey at the same visible place, even on the broken build.
      await page.locator(".thread__body").evaluate((element) => {
        element.scrollTop = 0;
      });
    }
  });

  await check("typing in the large task paints its controlled value within 250ms", async () => {
    await page.evaluate(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>(".composer-dock textarea")!;
      const timing = new Promise<{ elapsedMs: number; value: string }>((resolve) => {
        textarea.addEventListener(
          "input",
          () => {
            const start = performance.now();
            requestAnimationFrame(() =>
              requestAnimationFrame(() =>
                resolve({ elapsedMs: performance.now() - start, value: textarea.value }),
              ),
            );
          },
          { once: true, capture: true },
        );
      });
      Object.assign(window, { opensteerComposerTiming: timing });
    });
    await page.locator(".composer-dock textarea").fill("Continue the overnight task");
    const observed = await page.evaluate(
      () =>
        Reflect.get(window, "opensteerComposerTiming") as Promise<{
          elapsedMs: number;
          value: string;
        }>,
    );
    responsiveness.composerPaintMs = observed.elapsedMs;
    await page.locator(".composer-dock textarea").fill("");
    expectThat(
      observed,
      observed.value === "Continue the overnight task" && observed.elapsedMs <= 250,
      "composer input exceeded 250ms or lost its value",
    );
    return observed;
  });

  let savedTop = 0;
  await check("reading earlier work keeps the jump control in the panel", async () => {
    await page.locator(".transcript-scroll").evaluate((element) => {
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 900);
    });
    await page.locator(".transcript__jump").waitFor({ state: "attached" });
    await settle(page);
    const observed = await geometry(page);
    savedTop = observed.scrollTop;
    await capture(page, "reading-earlier");
    expectThat(
      observed,
      observed.tailGap > 100 && observed.jumpVisible,
      "earlier reading or the jump control is not visible",
    );
    return observed;
  });

  await page.locator(`.side-task[data-thread-id="${threadB}"] .side-task__main`).click();
  await page.waitForURL(`**/threads/${threadB}*`);
  await shownThread(page, threadB);
  await check("opening B after reading up in A starts at B's latest", () =>
    latest(page, "other-task-latest"),
  );
  await page.locator(`.side-task[data-thread-id="${threadA}"] .side-task__main`).click();
  await page.waitForURL(`**/threads/${threadA}*`);
  await shownThread(page, threadA);
  await check("returning to A restores its earlier reading position", async () => {
    await settle(page);
    const observed = { ...(await geometry(page)), savedTop };
    await capture(page, "return-to-earlier");
    expectThat(
      observed,
      Math.abs(observed.scrollTop - savedTop) <= 2 && observed.tailGap > 100,
      "A's reading position was lost",
    );
    return observed;
  });

  const append = async (suffix: string) => {
    const final = fixture.entries.find((entry) => entry.id === fixture.newestMessageId);
    if (!final || final.kind !== "message") throw new Error("Missing synthetic final reply");
    const entry = {
      ...final,
      id: `latest-${suffix}`,
      runId: null,
      sequence: String(7005 + Number(suffix)),
      body: `Live update ${suffix}: the newest synthetic reply.`,
    };
    const paintMs = await page.evaluate(async (value) => {
      const publish = Reflect.get(window, "opensteerLargeTranscriptAppend") as (
        entry: TranscriptEntry,
      ) => void;
      const start = performance.now();
      publish(value);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      return performance.now() - start;
    }, entry);
    responsiveness.appendPaintMs.push(paintMs);
    await settle(page);
    return entry.id;
  };
  await check("live work does not pull an earlier reader to the tail", async () => {
    const before = await geometry(page);
    await append("1");
    const observed = { ...(await geometry(page)), before: before.scrollTop };
    expectThat(
      observed,
      Math.abs(observed.scrollTop - before.scrollTop) <= 2,
      "new work stole the reader's position",
    );
    return observed;
  });
  await check("jump to latest is reachable and follows later live work", async () => {
    const before = await geometry(page);
    expectThat(before, before.jumpVisible, "jump button is outside the panel");
    await page.locator(".transcript__jump").click();
    const messageId = await append("2");
    return latest(page, "live-tail", messageId);
  });
  await page.reload();
  await shownThread(page, threadA);
  await page
    .locator(`[data-message-id="${fixture.newestMessageId}"]`)
    .waitFor({ state: "attached" });
  await check("reloading a large task opens its latest content", () =>
    latest(page, "reload-latest"),
  );
  await page.setViewportSize({ width: 1100, height: 650 });
  await check("a smaller desktop window keeps latest content and input visible", () =>
    latest(page, "short-window-latest"),
  );
  await check("each live append paints within 250ms", async () => {
    const observed = { appendPaintMs: responsiveness.appendPaintMs, limitMs: 250 };
    expectThat(
      observed,
      observed.appendPaintMs.length === 2 &&
        observed.appendPaintMs.every((elapsed) => elapsed <= observed.limitMs),
      "a live append exceeded 250ms",
    );
    return observed;
  });
  await showRequests(page, true);
  await check("a tall request still scrolls to Send above the desktop composer", () =>
    requestReachable(page, "desktop-request"),
  );
  await showRequests(page, false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".thread__sheet-handle").click();
  await page.locator(".thread--sheet-open").waitFor();
  await check("the phone sheet keeps one scroll owner and its newest reply", async () => {
    const observed = await latest(page, "phone-latest");
    expectThat(
      observed,
      observed.scrollOwner === ".thread__body" &&
        observed.boxes[3]!.overflowY === "visible" &&
        observed.boxes[3]!.scrollTop === 0,
      "phone sheet acquired a nested transcript scroller",
    );
    return observed;
  });
  await showRequests(page, true);
  await check("the phone sheet scrolls its long request to Send with input pinned", () =>
    requestReachable(page, "phone-request"),
  );
  await check("the large transcript raises no browser errors", async () => {
    expectThat({ pageErrors }, pageErrors.length === 0, "browser errors occurred");
    return { pageErrors };
  });
  await context.close();
} catch (error) {
  abort(error);
} finally {
  await web.close();
  await finishJourney(directory, checks, {
    fixture: fixture.counts,
    screenshots,
    pageErrors,
    responsiveness,
  });
}
