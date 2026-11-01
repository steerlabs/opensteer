/**
 * How a task's transcript presents what others sent it and what each turn did,
 * in real Chromium with the production renderer and the mock Host.
 *
 * Failures this journey must catch:
 * - a message from an automation, another task or a collaborator grows wider
 *   than its column, collapsed or expanded, because a URL, a code line or a
 *   table sets its width;
 * - the sender line of such a message wraps, so its name, time and link
 *   stack into a column of fragments;
 * - a long message shows in full, or shows "Show more" when it already fits,
 *   or changes width when it opens;
 * - a long message the reader sent shows in full;
 * - a turn that answered keeps every step on screen, or a turn that failed,
 *   stopped or is still working hides the steps that explain it;
 * - a folded turn cannot be opened again from its "Worked for" line;
 * - a task's own turn repeats the task's mark the header already shows;
 * - the docked chat's header spends its width on a state word and buttons,
 *   leaving the title a few letters, or loses Expand and Find from its menu;
 * - a task's way back or its tasks spill the head past its own box, so the
 *   name runs under the transcript or through the head's rule, at any dock
 *   width, in a browser or under the desktop titlebar;
 * - the conversation cannot be put away and brought back from the computer's bar.
 *
 * Evidence: screenshots and result.json under
 * OPENSTEER_TRANSCRIPT_PRESENTATION_EVIDENCE_DIR.
 */
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HostSnapshot, TranscriptEntry } from "@opensteer/client/host";
import type { MockHostClient } from "@opensteer/client/mock";
import type { BrowserContext, Locator, Page } from "playwright-core";
import { expectThat, finishJourney, journeyChecks, openMockWeb } from "./mock-web-journey.js";

const directory = path.resolve(
  process.env.OPENSTEER_TRANSCRIPT_PRESENTATION_EVIDENCE_DIR ??
    path.join(tmpdir(), "opensteer-transcript-presentation-evidence"),
);
const threadId = "thr_00000000-0000-4000-8000-000000000002";
const title = "iPhone Duo: any immediate pickup near 10014";
const { checks, check, abort } = journeyChecks();
await mkdir(directory, { recursive: true });
const web = await openMockWeb("opensteer-transcript-presentation");
const screenshots: string[] = [];
const pageErrors: string[] = [];

const id = (prefix: string, number: number) =>
  `${prefix}_00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
const at = (minute: number) => new Date(Date.UTC(2026, 9, 26, 12, minute)).toISOString();
const viewer = "usr_0192f4a1-0000-4000-8000-000000000001";
/** The mock's Travel specialist: a task there still needs no byline of its own. */
const workspaceId = "wsp_00000000-0000-4000-8000-000000000800";
const agent = (run: number) => ({
  displayName: title,
  kind: "agent",
  runId: id("run", run),
  threadId,
  workspaceId,
  workspaceName: "Travel",
});
const tool = (run: number, call: number, minute: number, state = "done") => ({
  arguments: { cmd: `curl -s https://www.apple.com/shop/fulfillment-messages?store=${call}` },
  callId: `call-${run}-${call}`,
  createdAt: at(minute),
  id: `tool:${id("run", run)}:call-${run}-${call}`,
  integration: null,
  isError: false,
  kind: "tool",
  output: state === "running" ? undefined : { text: `{"store":${call},"pickup":false}\n` },
  runId: id("run", run),
  state,
  streamText: "",
  tool: { name: "exec_command", namespace: "functions" },
});
const reasoning = (run: number, minute: number) => ({
  createdAt: at(minute),
  id: `reasoning:${id("run", run)}:block-1`,
  kind: "reasoning",
  runId: id("run", run),
  state: "done",
  text: "Checking the stores within five miles first.",
});
const reply = (run: number, message: number, minute: number, body: string) => ({
  author: agent(run),
  body,
  createdAt: at(minute),
  id: id("msg", message),
  kind: "message",
  messageKind: "assistant",
  runId: id("run", run),
});
const run = (
  number: number,
  minute: number,
  status: string,
  replyMessageId: string | null = null,
) => ({
  createdAt: at(minute),
  error:
    status === "failed"
      ? { code: "engine_failed", message: "Apple sign-in expired", retryable: false }
      : null,
  id: `run:${id("run", number)}`,
  kind: "run",
  replyMessageId,
  runId: id("run", number),
  status,
});
const brief =
  "Check Apple's in-store pickup availability for iPhone Duo (all colours, 256 GB and 512 GB) at every Apple Store within 5 miles of 10014. " +
  "If any store shows pickup today or tomorrow, message me with the store, model and the pickup window, then reserve the first match. " +
  "Skip stores that only offer delivery.\n\n" +
  "Use this availability endpoint and keep the query exactly as written:\n\n" +
  "https://www.apple.com/shop/fulfillment-messages?pl=true&mts.0=regular&mts.1=compact&cppart=UNLOCKED/US&parts.0=MYW93LL/A&parts.1=MYWA3LL/A&parts.2=MYWC3LL/A&location=10014&searchNearby=true&store=R095&option.0=pickup\n\n" +
  "| Store | Address | Phone | Hours today | Pickup counter | Notes |\n" +
  "| --- | --- | --- | --- | --- | --- |\n" +
  "| West 14th Street | 401 West 14th Street, New York, NY 10014 | (212) 444-3400 | 10:00–21:00 | Second floor, rear | Usually first to restock |\n" +
  "| SoHo | 103 Prince Street, New York, NY 10012 | (212) 226-3126 | 10:00–20:00 | Ground floor | Busy on weekends |\n\n" +
  "```sh\n" +
  "curl -s \"https://www.apple.com/shop/fulfillment-messages?pl=true&parts.0=MYW93LL/A&location=10014&searchNearby=true\" | jq '.body.content.pickupMessage.stores[] | {storeName, partsAvailability}'\n" +
  "```\n\nReport back here.";
const ownLong = Array.from(
  { length: 30 },
  (_, line) =>
    `Line ${line + 1}: keep checking the West 14th Street store and tell me the moment it changes.`,
).join("\n");

/** One task's whole transcript, oldest first: every case this journey reads. */
const entries = [
  {
    author: {
      displayName: title,
      kind: "trigger",
      occurrenceId: "toc_6f3a9c2e-1b7d-4e55-9a0c-2d8e4b1f7a63",
      source: "schedule",
      triggerId: "trg_00000000-0000-4000-8000-000000000001",
    },
    body: brief,
    createdAt: at(0),
    id: id("msg", 1),
    kind: "message",
    messageKind: "input",
    policy: "queue",
    runId: null,
  },
  reasoning(1, 1),
  tool(1, 1, 1),
  tool(1, 2, 2),
  reply(1, 6, 2, "West 14th Street has a window today; SoHo next."),
  tool(1, 3, 2),
  reply(1, 2, 3, "**Yes: West 14th Street, today 4–6 pm.** I reserved it."),
  run(1, 3, "completed", id("msg", 2)),
  {
    author: { displayName: "Alex", kind: "human", principalId: `user:${viewer}`, userId: viewer },
    body: ownLong,
    createdAt: at(4),
    id: id("msg", 3),
    kind: "message",
    messageKind: "input",
    runId: null,
  },
  tool(2, 1, 5),
  tool(2, 2, 5),
  run(2, 6, "failed"),
  {
    author: {
      displayName: "Maya Shah",
      kind: "human",
      principalId: "user:usr_0192f4a1-0000-4000-8000-000000000002",
      userId: "usr_0192f4a1-0000-4000-8000-000000000002",
    },
    body: "Also check the Hudson Yards store.",
    createdAt: at(7),
    id: id("msg", 4),
    kind: "message",
    messageKind: "input",
    runId: null,
  },
  {
    author: { displayName: "Alex", kind: "human", principalId: `user:${viewer}`, userId: viewer },
    body: "Thanks!",
    createdAt: at(8),
    id: id("msg", 5),
    kind: "message",
    messageKind: "input",
    runId: null,
  },
  tool(3, 1, 9),
  run(3, 10, "interrupted"),
  tool(4, 1, 11),
  tool(4, 2, 11, "running"),
  run(4, 11, "running"),
];

async function installFixture(context: BrowserContext, working: boolean, family: boolean) {
  // tsx names nested functions with a helper that the browser does not ship.
  await context.addInitScript("globalThis.__name = (value) => value;");
  await context.addInitScript(
    ({ entries, family, threadId, title, workspaceId, working }) => {
      let client: MockHostClient | undefined;
      let base: HostSnapshot | undefined;
      let projected: HostSnapshot | undefined;
      Object.defineProperty(window, "opensteerMock", {
        configurable: true,
        get: () => client,
        set(value: MockHostClient) {
          client = value;
          // Find searches the Host, not the page: it answers from this transcript.
          Object.defineProperty(value, "searchThreadMessages", {
            value: async ({ query }: { query: string }) => ({
              messages: (entries as { kind: string; body?: string }[])
                .filter((entry) => entry.kind === "message" && entry.body?.includes(query))
                .map((entry) => {
                  const message = entry as unknown as {
                    author: unknown;
                    body: string;
                    createdAt: string;
                    id: string;
                    messageKind: string;
                  };
                  return {
                    author: message.author,
                    content: [{ text: message.body, type: "text" }],
                    createdAt: message.createdAt,
                    id: message.id,
                    kind: message.messageKind,
                  };
                }),
              threadId,
              window: { nextBefore: null },
            }),
          });
          Object.defineProperty(value, "loadTranscriptAround", { value: async () => undefined });
          const read = value.getSnapshot;
          Object.defineProperty(value, "getSnapshot", {
            value: (): HostSnapshot => {
              const next = read();
              if (next === base && projected) return projected;
              base = next;
              // The thread list and the task lists each carry their own copy.
              const patch = <T extends { readonly id: string }>(thread: T): T =>
                thread.id === threadId
                  ? {
                      ...thread,
                      title,
                      workspaceId,
                      status: working ? "running" : "idle",
                      pendingRequests: 0,
                      inputQueuePaused: false,
                      // Handed out by Chat: the head grows a way back above its bar.
                      ...(family ? { parentThreadId: next.homeThreadId } : {}),
                    }
                  : thread;
              const patchList = <
                L extends { readonly entries: readonly { thread: { id: string } }[] },
              >(
                list: L | null,
              ): L | null =>
                list && {
                  ...list,
                  entries: list.entries.map((entry) => ({ ...entry, thread: patch(entry.thread) })),
                };
              projected = {
                ...next,
                threads: next.threads.map(patch),
                tasks: patchList(next.tasks),
                activeTasks: next.activeTasks.map((entry) => ({
                  ...entry,
                  thread: patch(entry.thread),
                })),
                workspaceTasks: Object.fromEntries(
                  Object.entries(next.workspaceTasks).map(([key, list]) => [key, patchList(list)]),
                ) as HostSnapshot["workspaceTasks"],
                requests: { ...next.requests, [threadId]: [] },
                threadAutomations: family
                  ? {
                      ...next.threadAutomations,
                      [threadId]: ["Morning check", "Evening check", "Price watch"].map(
                        (name, index) => ({
                          id: `family-automation-${index}`,
                          kind: "schedule" as const,
                          name,
                          nextFireAt: new Date(Date.now() + (index + 1) * 3_600_000).toISOString(),
                          paused: false,
                        }),
                      ),
                    }
                  : next.threadAutomations,
                waitingRequests: next.waitingRequests.filter(
                  ({ request }) => request.originatingThreadId !== threadId,
                ),
                transcripts: {
                  ...next.transcripts,
                  [threadId]: entries as unknown as TranscriptEntry[],
                },
              };
              return projected;
            },
          });
        },
      });
    },
    { entries, family, threadId, title, workspaceId, working },
  );
}

async function openTask(
  viewport: { width: number; height: number },
  working = false,
  family = false,
) {
  const context = await web.browser.newContext({ viewport, deviceScaleFactor: 2 });
  await installFixture(context, working, family);
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${web.origin}/threads/${threadId}`);
  await page.locator(`[data-message-id="${id("msg", 1)}"]`).waitFor();
  return { context, page };
}

async function shot(page: Page, name: string, target?: Locator) {
  const file = `${name}.png`;
  if (target) {
    await target.scrollIntoViewIfNeeded();
    await target.screenshot({ path: path.join(directory, file) });
  } else await page.screenshot({ path: path.join(directory, file) });
  screenshots.push(file);
}

/** Where a message sits against its transcript column, and its card's parts. */
async function card(page: Page, messageId: string) {
  return page.locator(`[data-message-id="${messageId}"]`).evaluate((node) => {
    const box = (element: Element | null) => {
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return { left: r.left, right: r.right, width: r.width, height: r.height };
    };
    const column = node.parentElement!;
    // What paints past the card: content inside a box that scrolls or clips
    // sideways (a code block, a table) stays inside that box.
    const clipped = (element: Element) => {
      for (
        let parent = element.parentElement;
        parent && parent !== node;
        parent = parent.parentElement
      )
        if (getComputedStyle(parent).overflowX !== "visible") return true;
      return false;
    };
    const wide = [...node.querySelectorAll("*")]
      .filter((element) => !clipped(element))
      .reduce((widest, element) => Math.max(widest, element.getBoundingClientRect().right), 0);
    const toggle = node.querySelector<HTMLButtonElement>("button[aria-expanded]");
    const meta = node.querySelector(".input-card__meta");
    const pre = node.querySelector("pre");
    return {
      column: box(column),
      message: box(node),
      card: box(node.querySelector(".input-card")),
      meta: box(meta),
      metaLineHeight: meta ? parseFloat(getComputedStyle(meta).lineHeight) || 16 : null,
      title: node.querySelector(".input-card__title")?.textContent ?? null,
      body: box(node.querySelector(".message-fold")),
      bodyLineHeight: (() => {
        const body = node.querySelector(".message-fold");
        return body ? parseFloat(getComputedStyle(body).lineHeight) || 20 : null;
      })(),
      widestDescendantRight: wide,
      toggle: toggle
        ? { expanded: toggle.getAttribute("aria-expanded"), text: toggle.textContent }
        : null,
      pre: pre
        ? { ...box(pre)!, scrollWidth: pre.scrollWidth, clientWidth: pre.clientWidth }
        : null,
    };
  });
}

function contained(observed: Awaited<ReturnType<typeof card>>, what: string) {
  const column = observed.column!;
  const message = observed.message!;
  const inside = (box: { left: number; right: number } | null) =>
    box === null || (box.left >= column.left - 0.5 && box.right <= column.right + 0.5);
  expectThat(observed, inside(message), `${what}: the message leaves its column`);
  expectThat(observed, inside(observed.card), `${what}: the card leaves its column`);
  expectThat(
    observed,
    observed.widestDescendantRight <= column.right + 0.5,
    `${what}: content reaches past the column`,
  );
}

/** A turn, found by the Run it is a stretch of. */
async function turnOf(page: Page, runId: string) {
  return page.locator(`.turn[data-run-id="${runId}"]`).first();
}

async function turnState(turn: Locator) {
  return turn.evaluate((node) => {
    const toggle = node.querySelector<HTMLButtonElement>("button.work__toggle");
    return {
      toggle: toggle
        ? { expanded: toggle.getAttribute("aria-expanded"), text: toggle.textContent?.trim() }
        : null,
      steps: node.querySelectorAll(".trace-step").length,
      reply: node.querySelector(".msg--assistant__body")?.textContent?.trim() ?? null,
      byline: node.querySelector(".msg--assistant__author") !== null,
      failure: node.querySelector(".run-failure, .run-note")?.textContent?.trim() ?? null,
    };
  });
}

try {
  for (const viewport of [
    { name: "narrow", width: 390, height: 844 },
    { name: "wide", width: 1280, height: 900 },
  ]) {
    const { context, page } = await openTask(viewport);
    const automation = page.locator(`[data-message-id="${id("msg", 1)}"]`);

    await check(
      `${viewport.name}: an automation's message keeps its column, collapsed`,
      async () => {
        await automation.scrollIntoViewIfNeeded();
        const observed = await card(page, id("msg", 1));
        contained(observed, "collapsed");
        expectThat(observed, observed.title === title, "the automation's name is not its title");
        return observed;
      },
    );

    await check(`${viewport.name}: the sender line stays on one line`, async () => {
      const observed = await card(page, id("msg", 1));
      expectThat(
        observed,
        observed.meta !== null && observed.meta.height <= observed.metaLineHeight! * 1.5 + 8,
        "the sender line wraps",
      );
      return observed;
    });

    await check(
      `${viewport.name}: a long message folds to five lines and opens in place`,
      async () => {
        const before = await card(page, id("msg", 1));
        expectThat(
          before,
          before.toggle?.expanded === "false" && before.body !== null,
          "a long message offers no closed toggle",
        );
        expectThat(
          before,
          before.body!.height <= before.bodyLineHeight! * 5 + 4,
          "the closed message is taller than five lines",
        );
        await shot(page, `${viewport.name}-automation-closed`, automation);
        await automation.getByRole("button", { name: "Show more" }).click();
        const after = await card(page, id("msg", 1));
        contained(after, "expanded");
        expectThat(after, after.toggle?.expanded === "true", "the toggle does not say it is open");
        expectThat(after, after.body!.height > before.body!.height, "opening shows nothing more");
        expectThat(
          after,
          Math.abs(after.card!.width - before.card!.width) <= 0.5,
          "the card changes width when it opens",
        );
        expectThat(
          after,
          after.pre !== null &&
            after.pre.scrollWidth > after.pre.clientWidth &&
            after.pre.right <= after.card!.right + 0.5,
          "a long code line does not scroll inside the card",
        );
        await shot(page, `${viewport.name}-automation-open`, automation);
        await automation.getByRole("button", { name: "Show less" }).click();
        const closed = await card(page, id("msg", 1));
        expectThat(closed, closed.toggle?.expanded === "false", "Show less does not close it");
        return { before, after, closed };
      },
    );

    await check(`${viewport.name}: Tab onto a link the fold hides opens the fold`, async () => {
      await automation.locator(".input-card__open").focus();
      await page.keyboard.press("Tab");
      const observed = await automation.evaluate((node) => {
        const focused = document.activeElement;
        const fold = node.querySelector(".message-fold")!.getBoundingClientRect();
        const box = focused?.getBoundingClientRect();
        return {
          inside: focused !== null && node.contains(focused),
          tag: focused?.tagName ?? null,
          expanded:
            node.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded") ?? null,
          shown: box ? box.bottom <= fold.bottom + 1 : false,
        };
      });
      expectThat(
        observed,
        observed.inside && observed.tag === "A",
        "Tab did not reach the hidden link",
      );
      expectThat(
        observed,
        observed.expanded === "true" && observed.shown,
        "the focused link stays hidden",
      );
      await automation.getByRole("button", { name: "Show less" }).click();
      return observed;
    });

    await check(`${viewport.name}: a short message from a collaborator has no toggle`, async () => {
      const observed = await card(page, id("msg", 4));
      contained(observed, "collaborator");
      expectThat(observed, observed.toggle === null, "a message that fits offers Show more");
      return observed;
    });

    await check(
      `${viewport.name}: the reader's own long message folds; a short one does not`,
      async () => {
        const long = page.locator(`[data-message-id="${id("msg", 3)}"]`);
        await long.scrollIntoViewIfNeeded();
        const observed = await long.evaluate((node) => {
          const body = node.querySelector(".msg--user .message-fold");
          const line = body ? parseFloat(getComputedStyle(body).lineHeight) || 20 : 20;
          return {
            height: body?.getBoundingClientRect().height ?? null,
            line,
            toggle:
              node.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded") ?? null,
          };
        });
        const short = await page
          .locator(`[data-message-id="${id("msg", 5)}"]`)
          .evaluate((node) => node.querySelector("button[aria-expanded]") !== null);
        expectThat(
          { ...observed, short },
          observed.toggle === "false" &&
            observed.height !== null &&
            observed.height <= observed.line * 20 + 1,
          "the reader's 30-line message shows in full",
        );
        expectThat({ ...observed, short }, !short, "a one-line message offers Show more");
        await shot(page, `${viewport.name}-own-long`, long);
        return { ...observed, short };
      },
    );

    await check(`${viewport.name}: a turn that answered folds behind Worked for`, async () => {
      const turn = await turnOf(page, id("run", 1));
      await turn.scrollIntoViewIfNeeded();
      const folded = await turnState(turn);
      expectThat(
        folded,
        folded.toggle?.expanded === "false" && (folded.toggle.text ?? "").startsWith("Worked for"),
        "the answered turn has no closed Worked for line",
      );
      expectThat(folded, folded.steps === 0, "the folded turn still draws its steps");
      expectThat(
        folded,
        folded.reply?.startsWith("Yes: West 14th") === true,
        "the answer is hidden",
      );
      expectThat(folded, !folded.byline, "the task's own turn repeats the task's mark");
      await shot(page, `${viewport.name}-turn-folded`, turn);
      await turn.locator("button.work__toggle").click();
      const opened = await turnState(turn);
      expectThat(opened, opened.toggle?.expanded === "true", "Worked for does not open");
      expectThat(opened, opened.steps > 0, "opening shows no steps");
      expectThat(opened, opened.reply !== null, "opening loses the answer");
      await shot(page, `${viewport.name}-turn-opened`, turn);
      await turn.locator("button.work__toggle").click();
      const closed = await turnState(turn);
      expectThat(closed, closed.steps === 0, "Worked for does not fold the steps again");
      return { folded, opened, closed };
    });

    await check(
      `${viewport.name}: Find opens the folded turn that holds what it found`,
      async () => {
        const turn = await turnOf(page, id("run", 1));
        const before = await turnState(turn);
        expectThat(before, before.toggle?.expanded === "false", "the turn starts open");
        await page.keyboard.press("ControlOrMeta+f");
        const field = page.locator(".thread-find input");
        if ((await field.count()) === 0)
          await page.getByRole("button", { name: "Find in conversation" }).first().click();
        await field.fill("SoHo next");
        await field.press("Enter");
        await page.locator(".thread-find__result").first().click();
        const note = page.locator(`[data-message-id="${id("msg", 6)}"]`);
        await note.waitFor();
        const after = await turnState(turn);
        const visible = await note.isVisible();
        expectThat(
          { before, after, visible },
          after.toggle?.expanded === "true" && visible,
          "the found note stays folded away",
        );
        await page.keyboard.press("Escape");
        await turn.locator("button.work__toggle").click();
        return { before, after, visible };
      },
    );

    for (const [name, number] of [
      ["failed", 2],
      ["stopped", 3],
      ["still working", 4],
    ] as const) {
      await check(
        `${viewport.name}: a turn that ${name === "still working" ? "is" : ""} ${name} keeps its steps`,
        async () => {
          const turn = await turnOf(page, id("run", number));
          const observed = await turnState(turn);
          expectThat(observed, observed.steps > 0, `a ${name} turn hides its steps`);
          expectThat(observed, observed.toggle === null, `a ${name} turn folds`);
          return observed;
        },
      );
    }
    await context.close();
  }

  // The chat docked beside the computer, where the header is narrowest.
  {
    const { context, page } = await openTask({ width: 1280, height: 900 }, true);
    await check("the full-width header keeps Show computer and Find", async () => {
      const header = page.locator(".conv-header");
      const observed = {
        showComputer: await header.getByRole("button", { name: "Show computer" }).count(),
        find: await header.getByRole("button", { name: "Find in conversation" }).count(),
        stateWords:
          (await header
            .locator(".conv-header__state")
            .textContent()
            .catch(() => null)) ?? null,
      };
      expectThat(
        observed,
        observed.showComputer === 1 && observed.find === 1,
        "a header control went missing",
      );
      expectThat(observed, !/working/iu.test(observed.stateWords ?? ""), "the header says Working");
      await shot(page, "full-header", header);
      return observed;
    });

    await page.locator(".side-tab__main").first().click();
    await page.locator(".workspace--work").waitFor();
    await check("the docked header gives the title its width", async () => {
      const header = page.locator(".workspace--work .conv-header");
      await header.waitFor();
      const observed = await header.evaluate((node) => {
        const box = (element: Element | null) => element?.getBoundingClientRect() ?? null;
        const name = node.querySelector(".conv-header__name");
        const buttons = [...node.querySelectorAll(".conv-header__actions button")].map((button) =>
          button.getAttribute("aria-label"),
        );
        return {
          header: box(node)?.width ?? 0,
          name: box(name)?.width ?? 0,
          nameScroll: name
            ? { scrollHeight: name.scrollHeight, clientHeight: name.clientHeight }
            : null,
          text: node.textContent ?? "",
          buttons,
          mark:
            node.querySelector(".conv-header__mark [data-state]")?.getAttribute("data-state") ??
            null,
        };
      });
      expectThat(
        observed,
        observed.name >= observed.header * 0.55,
        "the title gets less than half the header",
      );
      expectThat(observed, !/working/iu.test(observed.text), "the docked header says Working");
      expectThat(
        observed,
        observed.buttons.length === 0,
        "the docked header keeps buttons of its own",
      );
      expectThat(observed, observed.mark === "working", "the task's mark does not show it working");
      await shot(page, "docked-header", header);
      return observed;
    });

    await check("Expand and Find are in the docked title menu", async () => {
      const header = page.locator(".workspace--work .conv-header");
      const menu = page.locator(".popover--conversation-menu");
      await header.locator(".conv-header__menu").click();
      await menu.waitFor({ timeout: 3_000 });
      await shot(page, "docked-title-menu");
      const rows = await menu.locator(".picker__label").allTextContents();
      expectThat(
        { rows },
        rows[0] === "Expand chat" && rows[1] === "Find in conversation",
        "the menu does not lead with Expand and Find",
      );
      await menu.getByRole("button", { name: /Find in conversation/u }).click();
      const opened = await page.locator(".thread-find input").count();
      expectThat({ opened }, opened === 1, "the menu's Find does not open Find");
      await page.keyboard.press("Escape");
      await header.locator(".conv-header__menu").click();
      await menu.getByRole("button", { name: /Expand chat/u }).click();
      await page.locator(".workspace--talk").waitFor({ timeout: 3_000 });
      return { rows, opened };
    });
    await context.close();
  }

  {
    const { context, page } = await openTask({ width: 1440, height: 900 }, false, true);
    await page.locator(".side-tab__main").first().click();
    await page.locator(".workspace--work").waitFor();
    const handle = page.getByRole("separator", { name: "Resize conversation" });
    for (const desktop of [false, true]) {
      await page.evaluate((on) => {
        document.documentElement.classList.toggle("electron-shell", on);
      }, desktop);
      for (const [width, key] of [
        ["narrowest", "Home"],
        ["widest", "End"],
      ] as const) {
        const surface = desktop ? "desktop" : "web";
        await check(`${surface}, ${width} dock: the head holds its rows`, async () => {
          await handle.focus();
          await page.keyboard.press(key);
          const header = page.locator(".workspace--work .conv-header");
          const observed = await header.evaluate((node) => {
            const box = (selector: string) => {
              const rect = node.querySelector(selector)?.getBoundingClientRect();
              return rect
                ? { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }
                : null;
            };
            const rect = node.getBoundingClientRect();
            const next = node.nextElementSibling?.getBoundingClientRect() ?? null;
            const name = node.querySelector<HTMLElement>(".conv-header__name");
            return {
              head: { top: rect.top, bottom: rect.bottom, width: rect.width },
              overflows: node.scrollWidth > node.clientWidth + 0.5,
              trail: box(".conv-header__trail"),
              bar: box(".conv-header__bar"),
              name: box(".conv-header__name"),
              nameShown: name ? name.getBoundingClientRect().width : 0,
              family: box(".task-family-button"),
              familyText: node.querySelector(".task-family-button")?.textContent ?? null,
              belowTop: next?.top ?? null,
            };
          });
          const { head, trail, bar, name, family } = observed;
          expectThat(
            observed,
            trail !== null && bar !== null,
            "the way back or the bar is missing",
          );
          expectThat(observed, family !== null, "the tasks' glance is missing");
          expectThat(observed, !observed.overflows, "the head is wider than its box");
          expectThat(
            observed,
            trail!.top >= head.top - 0.5 && trail!.bottom <= bar!.top + 0.5,
            "the way back is not its own row above the bar",
          );
          expectThat(observed, bar!.bottom <= head.bottom + 0.5, "the bar spills past the head");
          expectThat(
            observed,
            observed.belowTop === null || observed.belowTop >= head.bottom - 0.5,
            "what follows the head starts under it",
          );
          expectThat(
            observed,
            name!.right <= family!.left + 0.5 && family!.right <= bar!.right + 0.5,
            "the name and the tasks' glance overlap",
          );
          expectThat(
            observed,
            name!.top >= bar!.top - 0.5 && name!.bottom <= bar!.bottom + 0.5,
            "the name leaves its bar",
          );
          expectThat(
            observed,
            observed.nameShown >= Math.min(140, head.width * 0.4),
            "the name gets a few letters",
          );
          await shot(page, `${surface}-${width}-dock-head`, header);
          return observed;
        });
      }
    }

    await check("the computer's bar puts the conversation away and brings it back", async () => {
      const toggle = page.locator(".place .chat-toggle");
      await toggle.click();
      const chat = page.locator(".place .chat-btn");
      await chat.waitFor({ timeout: 3_000 });
      const focused = await chat.evaluate((node) => node === document.activeElement);
      // The computer takes the room the conversation gave up.
      await page.waitForFunction(
        () => {
          const place = document.querySelector(".place")?.getBoundingClientRect();
          return place !== undefined && window.innerWidth - place.right < 24;
        },
        undefined,
        { timeout: 3_000 },
      );
      await shot(page, "conversation-put-away");
      await chat.click();
      await page.locator(".workspace__conversation:not([inert]) .conv-header").waitFor();
      await toggle.waitFor({ timeout: 3_000 });
      expectThat({ focused }, focused, "focus does not land on the way back");
      return { focused };
    });
    await context.close();
  }
} catch (error) {
  abort(error);
} finally {
  await web.close();
  await finishJourney(directory, checks, { screenshots, pageErrors });
}
