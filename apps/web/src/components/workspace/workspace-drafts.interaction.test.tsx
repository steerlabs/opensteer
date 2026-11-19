// @vitest-environment happy-dom
import { act } from "react";

import { describe, expect, it, vi, type MockInstance } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import { HostClientRequestError, placeList, type PlaceItem } from "@opensteer/client/host";
import { BrowserSurfaceIdSchema } from "@opensteer/core";

/** The browser session this device was shown a page tab through. */
function pageSession(tabId: string): string {
  const viewer = client.tabViewer(tabId);
  if (viewer?.kind !== "page") throw new Error("That page was never shown here");
  return viewer.sessionId;
}
/** What reached the Host as messages: a task's start is not one. */
function sends(dispatch: MockInstance<MockHostClient["dispatch"]>) {
  return dispatch.mock.calls.flatMap(([command]) =>
    command.type === "thread.sendMessage" ? [command] : [],
  );
}
function sendResult(dispatch: MockInstance<MockHostClient["dispatch"]>) {
  const index = dispatch.mock.calls.findIndex(([command]) => command.type === "thread.sendMessage");
  return dispatch.mock.results[index]!.value as Promise<unknown>;
}
const sendEnabled = () =>
  document.querySelector<HTMLButtonElement>(".composer__send")?.disabled === false;
/**
 * Messages are lost to the network until the page reloads, so the outbox's own timed retries
 * cannot deliver a message before the reload this test is about. A task still starts.
 */
function networkDownUntilReload() {
  const real = MockHostClient.prototype.dispatch;
  let down = true;
  const dispatch = vi.spyOn(MockHostClient.prototype, "dispatch").mockImplementation(function (
    this: MockHostClient,
    ...args
  ) {
    if (down && args[0].type === "thread.sendMessage")
      return Promise.reject(new TypeError("Network unavailable"));
    return real.apply(this, args);
  });
  return { dispatch, reconnect: () => void (down = false) };
}
/**
 * The lost send is settled in what this page saved: tried, its outcome unknown, and no longer
 * held by the attempt, so a reload may send it again at once.
 */
function lostSendSettled() {
  const saved = storedMessageRecords().filter((raw) => raw.includes('"thread.sendMessage"'));
  expect(saved).toHaveLength(1);
  expect(saved[0]).toContain('"uncertain":true');
  expect(saved[0]).not.toContain('"lease"');
}

/**
 * Waits until `check` passes, with React's pending work flushed before each try. Nothing here
 * waits a fixed time: a test waits for what it is about, and a miss names what never happened.
 */
async function until<T>(never: string, check: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(
    async () => {
      await act(async () => {});
      try {
        return await check();
      } catch (error) {
        throw new Error(`${never}: ${error instanceof Error ? error.message : String(error)}`, {
          cause: error,
        });
      }
    },
    { timeout: 2_000, interval: 5 },
  );
}
/** The place the workspace shows now, as its address names it. */
const shownPlace = () => new URLSearchParams(history.at(-1)?.search ?? "").get("tab");
const chipTitles = () =>
  [...document.querySelectorAll(".context-chip__title")].map((chip) => chip.textContent);
/** Every explicit pick has been read: none is still pending. */
const picksRead = () => document.querySelector(".context-chip--pending") === null;
/**
 * Lets a promise chain that uses no timer run to its end: every microtask queued before a
 * macrotask runs ahead of it. Used only where the test proves something did not happen, after the
 * one answer that could have made it happen.
 */
async function microtasksDrained() {
  await act(() => new Promise<void>((resolve) => setImmediate(resolve)));
}

import {
  root,
  client,
  history,
  mount,
  element,
  click,
  isMockPage,
  pageTab,
  tabSearch,
  deferred,
  write,
  firstTaskId,
  setRoot,
  storedMessageRecords,
} from "./workspace.interaction.test-support.js";
import { composerDraftKey, composerDrafts, homeDraftId } from "../composer-drafts.js";
import { composerText, rewrite } from "../composer-editor.test-support.js";
// These tests check what a Send carries, never the agent's reply to it.
const sentOnly = { mock: { replies: "brief" } } as const;

it("fences a started task's earlier revision and resumes with the saved revision and files", async () => {
  await mount(() => "/", sentOnly);
  const { deploymentId, user } = client.getSnapshot();
  const key = composerDraftKey(
    { deploymentId: deploymentId!, userId: user!.id },
    { kind: "task", draftId: homeDraftId },
  );
  const answer = deferred<void>();
  const actualCreate = client.createThread.bind(client);
  const create = vi.spyOn(client, "createThread").mockImplementationOnce(async (input) => {
    await answer.promise;
    return actualCreate(input);
  });
  const dispatch = vi.spyOn(client, "dispatch");
  try {
    await write(element("[data-composer-input]"), "Earlier first message");
    await click(element(".composer__send"));
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce(), { timeout: 1000 });
    const startedGeneration = composerDrafts.read(key)?.startGeneration;
    expect(startedGeneration).toBeDefined();
    const reserved = await client.createAttachment({
      mediaType: "text/plain",
      name: "revision.txt",
      sizeBytes: 12,
      idempotencyKey: "revision-file",
    });
    await client.uploadAttachment({
      attachmentId: reserved.id,
      source: new Blob(["saved draft!"]),
    });
    const file = {
      mediaType: "text/plain",
      name: "revision.txt",
      sizeBytes: 12,
      part: {
        type: "artifact" as const,
        artifactId: reserved.id,
        mediaType: "text/plain",
        name: "revision.txt",
        sizeBytes: 12,
      },
    };
    await act(async () => {
      await composerDrafts.update(key, { text: "Revised in another window", files: [file] });
      answer.resolve();
    });
    const reload = await vi.waitFor(
      () => {
        const button = [...document.querySelectorAll("button")].find(
          (el) => el.textContent?.trim() === "Reload draft",
        );
        expect(button).toBeDefined();
        return button!;
      },
      { timeout: 1000 },
    );
    expect(sends(dispatch)).toEqual([]);
    expect(composerDrafts.read(key)).toMatchObject({
      text: "Revised in another window",
      files: [file],
      startGeneration: startedGeneration,
    });
    await click(reload);
    await vi.waitFor(() => expect(sendEnabled()).toBe(true), { timeout: 1000 });
    await click(element(".composer__send"));
    await vi.waitFor(
      () =>
        expect(
          sends(dispatch),
          document.querySelector(".composer__error")?.textContent ??
            JSON.stringify(composerDrafts.read(key)),
        ).toHaveLength(1),
      { timeout: 1000 },
    );
    expect(create).toHaveBeenCalledOnce();
    expect(sends(dispatch)[0]?.content).toEqual([
      { type: "text", text: "Revised in another window" },
      file.part,
    ]);
  } finally {
    answer.resolve();
  }
});

describe("the draft's places", () => {
  it("follows the sign-in form page and sends its automatic reference on the first press", async () => {
    await mount((source) => {
      const form = placeList(source.getSnapshot()).find((place) => place.key === "mock-tab-0-2")!;
      return `/${tabSearch(form)}`;
    }, sentOnly);
    const form = placeList(client.getSnapshot()).find((place) => place.key === "mock-tab-0-2")!;
    await vi.waitFor(
      () => expect(document.querySelector(".context-chip__title")?.textContent).toBe(form.title),
      { timeout: 1_000 },
    );
    const sessionId = pageSession(form.key);
    const dispatch = vi.spyOn(client, "dispatch");
    await write(element<HTMLElement>("[data-composer-input]"), "Help with this form");
    await click(element(".composer__send"));
    await vi.waitFor(() => expect(sends(dispatch)).toHaveLength(1), { timeout: 1_000 });
    const command = sends(dispatch)[0]!;
    const page = {
      type: "browser-page",
      auto: true,
      documentId: client.browserViewerSurface(sessionId, form.key)?.documentId,
      sessionId,
      tabId: form.key,
      title: form.title,
    };
    expect(command.content).toContainEqual(expect.objectContaining(page));
    await act(async () => {
      await expect(sendResult(dispatch)).resolves.toMatchObject({ type: "thread.sendMessage" });
    });
    expect(
      Object.values(client.getSnapshot().transcripts)
        .flat()
        .some(
          (entry) =>
            entry.kind === "message" &&
            entry.pages?.some(
              (part) =>
                part.tabId === page.tabId &&
                part.auto === true &&
                part.documentId === page.documentId,
            ),
        ),
    ).toBe(true);
    expect(document.querySelector(".composer__error")).toBeNull();
    await vi.waitFor(() => expect(composerText(element("[data-composer-input]"))).toBe(""), {
      timeout: 1_000,
    });
    expect(sends(dispatch)).toHaveLength(1);
  });

  it("follows the page while untouched, freezes on typing, and a removal sticks", async () => {
    await mount((source) => `/${tabSearch(pageTab(source))}`, sentOnly);
    const place = pageTab();
    await until("The shown page never became the chip", () =>
      expect(chipTitles()).toEqual([place.title]),
    );
    // Typing freezes the chip on this page; another tab does not replace it.
    const field = element<HTMLElement>("[data-composer-input]");
    await act(async () => {
      rewrite(field, "About this");
    });
    const other = placeList(client.getSnapshot()).find(
      (item) => item.key !== place.key && isMockPage(item),
    )!;
    await click(element(`.side-tab[data-place-key="${other.key}"] .side-tab__main`));
    // A frozen draft's chips are its own state, so the render showing the other tab is final.
    await until("The other tab was never shown", () => expect(shownPlace()).toBe(other.key));
    expect(element(".context-chip__title").textContent).toBe(place.title);
    // Removing it is a choice that sticks across tabs.
    await click(element(".context-chip__remove"));
    await click(element(`.side-tab[data-place-key="${place.key}"] .side-tab__main`));
    await until("The first tab was never shown again", () => expect(shownPlace()).toBe(place.key));
    expect(document.querySelector(".context-chip")).toBeNull();
  });

  // The followed page's read answers after the draft moved on: the draft shows
  // what it chose since, never what the late answer brought.
  it.each(["freeze", "select", "reset"] as const)(
    "%s drops the late answer of the followed page's read",
    async (how) => {
      type Candidate = Awaited<ReturnType<MockHostClient["readBrowserContextCandidate"]>>;
      const late = deferred<Candidate>();
      let read: MockInstance<MockHostClient["readBrowserContextCandidate"]> | undefined;
      await mount((source) => {
        read = vi
          .spyOn(source, "readBrowserContextCandidate")
          .mockImplementationOnce(() => late.promise);
        return `/${tabSearch(pageTab(source))}`;
      }, sentOnly);
      await until("The followed page was never read", () => expect(read).toHaveBeenCalled());
      const place = pageTab();
      const chipTitle = () => document.querySelector(".context-chip__title")?.textContent ?? null;
      expect(chipTitle()).toBeNull();
      const field = element<HTMLElement>("[data-composer-input]");
      const sent = deferred<void>();
      let expected: string | null = null;
      if (how === "freeze") {
        // Typing before the read answered freezes nothing at all.
        await write(field, "What is this?");
      } else if (how === "select") {
        const other = placeList(client.getSnapshot()).find(
          (item) => item.key !== place.key && isMockPage(item),
        )!;
        await click(element(`.side-tab[data-place-key="${other.key}"] .side-tab__main`));
        expected = other.title;
      } else {
        // A durable send closes this draft even while the Host's answer is outstanding.
        const real = client.dispatch.bind(client);
        vi.spyOn(client, "dispatch").mockImplementation(async (...args) => {
          if (args[0].type === "thread.sendMessage") await sent.promise;
          return real(...args);
        });
        await write(field, "What is this?");
        await click(element(".composer__send"));
        await vi.waitFor(
          async () => {
            await act(async () => {});
            expect(history.at(-1)?.path).toMatch(/^\/tasks\//);
          },
          { timeout: 1000 },
        );
      }
      if (expected !== null)
        await until("The selected page never became the chip", () =>
          expect(chipTitle()).toBe(expected),
        );
      expect(chipTitle()).toBe(expected);
      const candidate = await client.readBrowserContextCandidate(pageSession(place.key), place.key);
      await act(async () => late.resolve({ ...candidate, title: "A late answer" }));
      // The late answer's handler is a promise chain with no timer: it has run by now.
      await microtasksDrained();
      expect(chipTitle()).toBe(expected);
      expect(document.body.textContent).not.toContain("A late answer");
      await act(async () => sent.resolve());
    },
  );

  it("never picks up a page on a task's reply", async () => {
    await mount((source) => `/${tabSearch(pageTab(source))}`, sentOnly);
    const threadId = firstTaskId();
    await click(element(`.side-task[data-thread-id="${threadId}"] .side-task__main`));
    // A reply's draft starts with what it holds and follows nothing, so its first render is final.
    await until("The task's reply was never shown", () => {
      expect(history.at(-1)?.path).toBe(`/tasks/${threadId}`);
      element("[data-composer-input]");
    });
    expect(document.querySelector(".context-chip")).toBeNull();
  });

  it("explicit + attaches a tab through the candidate read", async () => {
    await mount("/", sentOnly);
    const read = vi.spyOn(client, "readBrowserContextCandidate");
    const place = pageTab();
    await click(element('.composer__attach[aria-label="Attach"]'));
    const row = [
      ...document.querySelectorAll<HTMLButtonElement>(".popover--attach .place-pick"),
    ].find((button) => button.textContent?.includes(place.title))!;
    await click(row);
    await until("The picked tab was never read into a chip", () => {
      expect(picksRead()).toBe(true);
      expect(element(".context-chip__title").textContent).toBe(place.title);
    });
    expect(read).toHaveBeenCalled();
  });

  it.each(["navigate", "reload"] as const)(
    "sends a frozen page on the first press after its tab %ss",
    async (change) => {
      await mount((source) => `/${tabSearch(pageTab(source))}`, sentOnly);
      const place = pageTab();
      const tabId = place.key;
      const sessionId = pageSession(tabId);
      const frozen = await client.readBrowserContextCandidate(sessionId, tabId);
      await until("The shown page never became the chip", () =>
        expect(chipTitles()).toEqual([frozen.title]),
      );
      const field = element<HTMLElement>("[data-composer-input]");
      await write(field, "About the page I was reading");
      await act(async () => {
        client.sendBrowserCommand(sessionId, {
          surfaceId: BrowserSurfaceIdSchema.parse(tabId),
          ...(change === "navigate"
            ? { type: "navigation.go", url: "https://next.example/" }
            : { type: "navigation.reload" }),
        });
      });
      await until(`The tab never ${change === "navigate" ? "navigated" : "reloaded"}`, async () =>
        expect((await client.readBrowserContextCandidate(sessionId, tabId)).documentId).not.toBe(
          frozen.documentId,
        ),
      );
      // The draft froze on typing: its chip is its own state, whatever the tab shows now.
      expect(element(".context-chip__title").textContent).toBe(frozen.title);
      const dispatch = vi.spyOn(client, "dispatch");
      await click(element(".composer__send"));
      await until("Send never reached the Host", () => expect(sends(dispatch)).toHaveLength(1));
      expect(sends(dispatch)[0]).toMatchObject({
        type: "thread.sendMessage",
        content: [
          expect.objectContaining({ type: "text" }),
          expect.objectContaining({
            type: "browser-page",
            auto: true,
            documentId: frozen.documentId,
            sessionId,
            tabId,
            title: frozen.title,
            url: frozen.url,
          }),
        ],
      });
      await expect(sendResult(dispatch)).resolves.toMatchObject({
        type: "thread.sendMessage",
      });
      expect(document.querySelector(".composer__error")).toBeNull();
    },
  );

  it.each(["held", "handed back"] as const)(
    "lets its automatic page go when that tab closes, but keeps an explicit pick, greyed (%s)",
    async (how) => {
      await mount((source) => {
        source.scriptPlaces();
        return `/${tabSearch(pageTab(source))}`;
      });
      const place = pageTab();
      const other = placeList(client.getSnapshot()).find(
        (item) => item.key !== place.key && isMockPage(item),
      )!;
      const titles = () =>
        [...document.querySelectorAll(".context-chip__title")].map((chip) => chip.textContent);
      const field = element<HTMLElement>("[data-composer-input]");
      await write(field, "About this");
      act(() => element<HTMLButtonElement>('.composer__attach[aria-label="Attach"]').click());
      act(() =>
        [...document.querySelectorAll<HTMLButtonElement>(".popover--attach .place-pick")]
          .find((button) => button.textContent?.includes(other.title))!
          .click(),
      );
      await vi.waitFor(() => expect(titles()).toEqual([place.title, other.title]), {
        timeout: 1000,
      });
      if (how === "handed back") {
        await vi.waitFor(
          () => expect(sendEnabled(), "The explicit place read never released Send").toBe(true),
          { timeout: 1000 },
        );
        // Refusing task creation hands the draft back with both places.
        const refused = vi
          .spyOn(client, "dispatch")
          .mockRejectedValueOnce(
            new HostClientRequestError({ code: "forbidden", message: "Refused", status: 403 }),
          );
        await act(async () => {
          element<HTMLButtonElement>(".composer__send").click();
          await vi.waitFor(
            () =>
              expect(refused).toHaveBeenCalledExactlyOnceWith(
                expect.objectContaining({ type: "thread.create" }),
              ),
            { timeout: 1000 },
          );
          await expect(refused.mock.results[0]!.value).rejects.toMatchObject({ code: "forbidden" });
        });
        expect(titles()).toEqual([place.title, other.title]);
      }
      const close = async (closed: PlaceItem) => {
        await act(async () => client.closeTabs([closed.key]));
      };
      await close(place);
      expect(titles()).toEqual([other.title]);
      // A snapshot that can no longer prove the end never brings the closed page back.
      await act(async () => client.goOffline());
      await close(other);
      expect(titles()).toEqual([other.title]);
      expect(document.querySelector(".context-chip--gone")).not.toBeNull();
      await vi.waitFor(
        () => expect(sendEnabled(), "The offline draft could not be kept").toBe(true),
        { timeout: 1000 },
      );
      const dispatch = vi.spyOn(client, "dispatch");
      dispatch.mockClear();
      await act(async () => element<HTMLButtonElement>(".composer__send").click());
      expect(sends(dispatch)).toEqual([]);

      await act(async () => client.load());
      await vi.waitFor(
        () =>
          expect(
            sends(dispatch),
            "The pending message did not send after synchronization",
          ).toHaveLength(1),
        { timeout: 1000 },
      );
      const command = sends(dispatch)[0]!;
      expect(command.content.filter((part) => part.type !== "text")).toEqual([
        expect.objectContaining({
          type: "browser-page",
          auto: false,
          tabId: other.destination.tabId,
        }),
      ]);
      await expect(sendResult(dispatch)).resolves.toMatchObject({ type: "thread.sendMessage" });
    },
  );

  it("merges a refused message into a newer draft without losing either's places", async () => {
    await mount((source) => `/${tabSearch(pageTab(source))}`, sentOnly);
    const place = pageTab();
    await until("The shown page never became the chip", () =>
      expect(chipTitles()).toEqual([place.title]),
    );
    const other = placeList(client.getSnapshot()).find(
      (item) => item.key !== place.key && isMockPage(item),
    )!;
    const refusal = deferred<void>();
    const message = `This message includes the browser page "${place.title}", which you can no longer see. Remove the page and send the message again.`;
    const real = client.dispatch.bind(client);
    const dispatch = vi.spyOn(client, "dispatch").mockImplementation(async (...args) => {
      if (args[0].type === "thread.sendMessage") {
        await refusal.promise;
        throw new HostClientRequestError({ code: "forbidden", message, status: 403 });
      }
      return real(...args);
    });
    await write(element("[data-composer-input]"), "First message");
    await click(element(".composer__send"));
    // The message is out, waiting on the Host, and the next draft has begun.
    const field = await until("The first message never went out", () => {
      expect(sends(dispatch)).toHaveLength(1);
      const next = element<HTMLElement>("[data-composer-input]");
      expect(composerText(next)).toBe("");
      return next;
    });
    await write(field, "Newer draft");
    // The newer draft deliberately picks two pages, including one on the original message.
    for (const pick of [other, place]) {
      await click(element('.composer__attach[aria-label="Attach"]'));
      await click(
        [...document.querySelectorAll<HTMLButtonElement>(".popover--attach .place-pick")].find(
          (button) => button.textContent?.includes(pick.title),
        )!,
      );
      await until(`${pick.title} was never read into a chip`, () => {
        expect(picksRead()).toBe(true);
        expect(chipTitles()).toContain(pick.title);
      });
    }
    expect(
      [...document.querySelectorAll(".context-chip__title")].map((chip) => chip.textContent),
    ).toEqual([other.title, place.title]);
    await act(async () => refusal.resolve());
    const rejected = await until("The refusal never came back as a kept message", () => {
      const row = element(".delivery [role=status]").closest(".delivery")!;
      expect(row.textContent).toContain("Not sent. You don't have access.");
      return row;
    });
    expect(rejected.textContent).toContain("First message");
    expect(rejected.textContent).toContain(place.title);
    expect(rejected.textContent).toContain("Not sent. You don't have access.");
    await click(element("button", element("[role=status]", rejected)));
    expect(composerText(field)).toBe("First message\n\nNewer draft");
    expect(
      [...document.querySelectorAll(".context-chip__title")].map((chip) => chip.textContent),
    ).toEqual([place.title, other.title]);
    expect(rejected.isConnected).toBe(false);
    expect(document.body.textContent).not.toContain(message);
    expect(document.querySelector(".context-chip--refused, .context-refusal")).toBeNull();
    expect(document.body.textContent).not.toContain("Send without it");
    expect(document.body.textContent).not.toContain("Include it");
    // Closing a page explicitly picked by the newer draft keeps that pick.
    await act(async () => client.closeTabs([place.key]));
    // The draft sees the end in the same render that drops the tab from the sidebar.
    await until("The closed tab never left the sidebar", () =>
      expect(document.querySelector(`.side-tab[data-place-key="${place.key}"]`)).toBeNull(),
    );
    expect(
      [...document.querySelectorAll(".context-chip__title")].map((chip) => chip.textContent),
    ).toEqual([place.title, other.title]);
  });

  it("an automatic page alone does not enable Send; an explicit pick alone does", async () => {
    await mount((source) => `/${tabSearch(pageTab(source))}`, sentOnly);
    const place = pageTab();
    await until("The shown page never became the chip", () =>
      expect(element(".context-chip__title").textContent).toBe(place.title),
    );
    expect(sendEnabled()).toBe(false);
    await click(element(".context-chip__remove"));
    await click(element('.composer__attach[aria-label="Attach"]'));
    await click(
      [...document.querySelectorAll<HTMLButtonElement>(".popover--attach .place-pick")].find(
        (button) => button.textContent?.includes(place.title),
      )!,
    );
    await until("The explicit pick never enabled Send", () =>
      expect(element<HTMLButtonElement>(".composer__send").disabled).toBe(false),
    );
    const dispatch = vi.spyOn(client, "dispatch");
    await click(element(".composer__send"));
    await until("Send never reached the Host", () => expect(sends(dispatch)).toHaveLength(1));
    expect(sends(dispatch)[0]).toMatchObject({
      type: "thread.sendMessage",
      content: [expect.objectContaining({ type: "browser-page", auto: false })],
    });
    await expect(sendResult(dispatch)).resolves.toMatchObject({
      type: "thread.sendMessage",
    });
  });

  // The agent cannot tell which computer "my screen" means unless the message says.
  describe("a Mac app or phone in the middle", () => {
    const macMini = "rnr_11111111-1111-4111-8111-111111111111";
    const studioMac = "rnr_88888888-8888-4888-8888-888888888888";
    async function openTile(label: string) {
      if (!document.querySelector(".start-page"))
        await act(async () =>
          element<HTMLButtonElement>(
            '.side-section--tabs .side-head__action[aria-label="New tab"]',
          ).click(),
        );
      const open = vi.spyOn(client, "openTab");
      try {
        await act(async () => {
          element<HTMLButtonElement>(`.start-tile[aria-label^='${label}']`).click();
          expect(open).toHaveBeenCalledTimes(1);
          await open.mock.results[0]!.value;
        });
      } finally {
        open.mockRestore();
      }
    }
    function viewed(machineId: string, bundleId: string) {
      const place = placeList(client.getSnapshot()).findLast(
        (item) =>
          item.kind === "window" &&
          item.device.machineId === machineId &&
          item.tab.bundleId === bundleId,
      );
      if (!place) throw new Error(`Nothing shows ${bundleId} on ${machineId}`);
      return place;
    }
    async function show(place: PlaceItem) {
      await act(async () =>
        element<HTMLButtonElement>(
          `.side-tab[data-place-key="${place.key}"] .side-tab__main`,
        ).click(),
      );
    }
    function reference(place: PlaceItem) {
      if (place.kind === "phone")
        return {
          type: "phone",
          machineId: place.device.machineId,
          display: "main",
          name: place.title,
        };
      if (place.kind !== "window") throw new Error("Not a native place");
      return {
        type: "computer-app",
        app: expect.objectContaining({ bundleId: place.tab.bundleId }),
        machineId: place.device.machineId,
        name: place.title,
      };
    }
    function sent(dispatch: MockInstance<MockHostClient["dispatch"]>) {
      return dispatch.mock.calls.flatMap(([command]) =>
        command.type === "thread.sendMessage" ? [command] : [],
      );
    }
    const chip = () => document.querySelector(".context-chip__title")?.textContent ?? null;
    const field = () => element<HTMLElement>("[data-composer-input]");

    it("carries the app in front on the Mac it is shown from, whichever Mac that is", async () => {
      await mount("/?panel=browser", sentOnly);
      await openTile("Keynote on");
      const keynote = viewed(studioMac, "com.apple.Keynote");
      await vi.waitFor(() => expect(chip()).toBe(keynote.title), { timeout: 1000 });
      await openTile("Notes on");
      await vi.waitFor(() => expect(chip()).toBe(viewed(macMini, "com.apple.Notes").title), {
        timeout: 1000,
      });
      await show(keynote);
      await vi.waitFor(() => expect(chip()).toBe(keynote.title), { timeout: 1000 });
      const dispatch = vi.spyOn(client, "dispatch");
      await write(field(), "Can you see my screen?");
      await vi.waitFor(
        () => expect(sendEnabled(), "The app context never released Send").toBe(true),
        { timeout: 1000 },
      );
      act(() => element<HTMLButtonElement>(".composer__send").click());
      await vi.waitFor(() => expect(sent(dispatch)).toHaveLength(1), { timeout: 1000 });
      const sends = sent(dispatch);
      expect(sends).toHaveLength(1);
      expect(sends[0]!.content).toEqual([
        { type: "text", text: "Can you see my screen?" },
        reference(keynote),
      ]);
      expect(reference(keynote)).toMatchObject({ machineId: studioMac });
      await act(async () => {
        await expect(sendResult(dispatch)).resolves.toMatchObject({ type: "thread.sendMessage" });
      });
      expect(document.querySelector(".composer__error")).toBeNull();
      expect(composerText(field())).toBe("");
    });

    it("carries the phone display in front", async () => {
      await mount("/", sentOnly);
      const phone = placeList(client.getSnapshot()).find(
        (item) => item.kind === "phone" && item.availability === "ready",
      );
      if (!phone) throw new Error("The mock world has no ready phone");
      await show(phone);
      expect(chip()).toBe(phone.title);
      const dispatch = vi.spyOn(client, "dispatch");
      await write(field(), "What is on it?");
      await click(element(".composer__send"));
      await until("Send never reached the Host", () => expect(sent(dispatch)).toHaveLength(1));
      expect(sent(dispatch).map((command) => command.content)).toEqual([
        [{ type: "text", text: "What is on it?" }, reference(phone)],
      ]);
    });

    it("freezes on typing, keeps its app when another place is shown, and a removal sticks", async () => {
      await mount("/?panel=browser", sentOnly);
      await openTile("Keynote on");
      const keynote = viewed(studioMac, "com.apple.Keynote");
      await write(field(), "About this");
      await openTile("Notes on");
      // A frozen draft's chips are its own state, so the render showing Notes is final.
      const notes = viewed(macMini, "com.apple.Notes");
      await until("Notes was never shown", () =>
        expect(shownPlace()).toBe(notes.destination.tabId),
      );
      expect(chip()).toBe(keynote.title);
      await click(element(".context-chip__remove"));
      await show(keynote);
      await until("Keynote was never shown again", () =>
        expect(shownPlace()).toBe(keynote.destination.tabId),
      );
      expect(chip()).toBeNull();
    });

    it("lets its automatic app go when its tab closes", async () => {
      await mount("/?panel=browser", sentOnly);
      await openTile("Keynote on");
      const keynote = viewed(studioMac, "com.apple.Keynote");
      await write(field(), "About this");
      expect(chip()).toBe(keynote.title);
      await act(async () => client.closeTabs([keynote.key]));
      await until("The closed app's chip never left", () => expect(chip()).toBeNull());
      const dispatch = vi.spyOn(client, "dispatch");
      await click(element(".composer__send"));
      const command = await until("Send never reached the Host", () => {
        expect(sends(dispatch)).toHaveLength(1);
        return sends(dispatch)[0]!;
      });
      expect(command.content.filter((part) => part.type !== "text")).toEqual([]);
    });

    it("sends the place as it is now when it is renamed in the same place", async () => {
      await mount("/", sentOnly);
      const phone = placeList(client.getSnapshot()).find(
        (item) => item.kind === "phone" && item.availability === "ready",
      );
      if (!phone) throw new Error("No ready phone");
      const { machineId } = phone.device;
      await show(phone);
      expect(chip()).toBe(phone.title);
      await act(async () => {
        await client.dispatch({
          type: "machine.rename",
          machineId,
          name: "Work phone",
          idempotencyKey: "rename-shown-phone",
        });
      });
      await until("The chip never took the new name", () => expect(chip()).toBe("Work phone"));
      const renamed = placeList(client.getSnapshot()).find((item) => item.key === phone.key)!;
      expect(renamed.title).toBe("Work phone");
      expect(chip()).toBe("Work phone");
      const dispatch = vi.spyOn(client, "dispatch");
      await write(field(), "And now?");
      await click(element(".composer__send"));
      await until("Send never reached the Host", () => expect(sent(dispatch)).toHaveLength(1));
      expect(sent(dispatch).map((command) => command.content)).toEqual([
        [{ type: "text", text: "And now?" }, reference(renamed)],
      ]);
      expect(reference(renamed)).toMatchObject({ name: "Work phone" });
    });

    it("takes no app from a Mac that is not ready, and follows it again once it is", async () => {
      await mount("/?panel=browser", sentOnly);
      await openTile("Keynote on");
      const keynote = viewed(studioMac, "com.apple.Keynote");
      expect(chip()).toBe(keynote.title);
      await act(async () => client.setComputerUseReadiness(studioMac, "unavailable"));
      await until("The app of a Mac that is not ready was kept", () => expect(chip()).toBeNull());
      await act(async () => client.setComputerUseReadiness(studioMac, "ready"));
      await until("The app was not followed again once its Mac was ready", () =>
        expect(chip()).toBe(keynote.title),
      );
    });

    it("an automatic app alone does not enable Send; an explicit pick alone does", async () => {
      await mount("/?panel=browser", sentOnly);
      await openTile("Keynote on");
      const keynote = viewed(studioMac, "com.apple.Keynote");
      expect(chip()).toBe(keynote.title);
      expect(sendEnabled()).toBe(false);
      await click(element(".context-chip__remove"));
      await click(element('.composer__attach[aria-label="Attach"]'));
      await click(
        [...document.querySelectorAll<HTMLButtonElement>(".popover--attach .place-pick")].find(
          (button) => button.textContent?.includes(keynote.title),
        )!,
      );
      await until("The explicit pick never enabled Send", () =>
        expect(element<HTMLButtonElement>(".composer__send").disabled).toBe(false),
      );
      const dispatch = vi.spyOn(client, "dispatch");
      await click(element(".composer__send"));
      await until("Send never reached the Host", () => expect(sent(dispatch)).toHaveLength(1));
      expect(sent(dispatch).map((command) => command.content)).toEqual([[reference(keynote)]]);
    });

    it("never picks up an app on a task's reply", async () => {
      await mount("/?panel=browser", sentOnly);
      await openTile("Keynote on");
      expect(chip()).not.toBeNull();
      const threadId = firstTaskId();
      await click(element(`.side-task[data-thread-id="${threadId}"] .side-task__main`));
      // A reply's draft starts with what it holds and follows nothing, so its first render is final.
      await until("The task's reply was never shown", () => {
        expect(history.at(-1)?.path).toBe(`/tasks/${threadId}`);
        element("[data-composer-input]");
      });
      expect(document.querySelector(".context-chip")).toBeNull();
    });

    it("retries the app it carried with identical content and key, again after a reload", async () => {
      const { dispatch, reconnect } = networkDownUntilReload();
      await mount("/?panel=browser", sentOnly);
      await openTile("Keynote on");
      const keynote = viewed(studioMac, "com.apple.Keynote");
      await write(field(), "Can you see my screen?");
      await click(element(".composer__send"));
      await until("The lost send was never kept for a retry", lostSendSettled);
      const first = sends(dispatch).at(-1) as unknown as {
        idempotencyKey: string;
        content: unknown;
      };
      expect(first.content).toEqual([
        { type: "text", text: "Can you see my screen?" },
        reference(keynote),
      ]);
      expect(element(".delivery [role=status]").closest(".delivery")!.textContent).toContain(
        keynote.title,
      );
      act(() => root?.unmount());
      setRoot(null);
      document.body.replaceChildren();
      dispatch.mockClear();
      reconnect();
      // The kept message belongs to the task it started: reloading there sends it again.
      await mount(`${history.at(-1)!.path}${history.at(-1)!.search}`, { sameHost: true });
      const retried = (await until("The reload never sent the kept message again", () => {
        expect(sends(dispatch)).not.toHaveLength(0);
        return sends(dispatch)[0];
      })) as unknown as { idempotencyKey: string; content: unknown };
      expect(retried.idempotencyKey).toBe(first.idempotencyKey);
      expect(JSON.stringify(retried.content)).toBe(JSON.stringify(first.content));
    });
  });
});

describe("unconfirmed sends keep every place exactly", () => {
  it("retries with identical content and key, again after a reload, pages and apps alike", async () => {
    const { dispatch, reconnect } = networkDownUntilReload();
    await mount((source) => `/${tabSearch(pageTab(source))}`, sentOnly);
    const shown = pageTab();
    await until("The shown page never became the chip", () =>
      expect(chipTitles()).toEqual([shown.title]),
    );
    const app = placeList(client.getSnapshot()).find(
      (place) => place.kind === "window" && place.availability === "ready",
    )!;
    await click(element('.composer__attach[aria-label="Attach"]'));
    await click(
      [...document.querySelectorAll<HTMLButtonElement>(".popover--attach .place-pick")].find(
        (button) => button.textContent?.includes(app.title),
      )!,
    );
    await until("The picked app was never read into a chip", () => {
      expect(picksRead()).toBe(true);
      expect(chipTitles()).toEqual([shown.title, app.title]);
    });
    const field = element<HTMLElement>("[data-composer-input]");
    await act(async () => {
      rewrite(field, "Compare these");
    });
    await click(element(".composer__send"));
    await until("The lost send was never kept for a retry", lostSendSettled);
    const first = sends(dispatch).at(-1) as unknown as {
      idempotencyKey: string;
      content: readonly { type: string; auto?: boolean }[];
    };
    expect(first.content.map((part) => part.type)).toEqual([
      "text",
      "browser-page",
      "computer-app",
    ]);
    expect(first.content[1]?.auto).toBe(true);
    expect(element(".delivery [role=status]").closest(".delivery")!.textContent).toContain(
      app.title,
    );
    // The page reloads: the kept message is sent again as exactly what was sent.
    act(() => root?.unmount());
    setRoot(null);
    document.body.replaceChildren();
    dispatch.mockClear();
    reconnect();
    // The kept message belongs to the task it started: reloading there sends it again.
    await mount(`${history.at(-1)!.path}${history.at(-1)!.search}`, { sameHost: true });
    const retried = (await until("The reload never sent the kept message again", () => {
      expect(sends(dispatch)).not.toHaveLength(0);
      return sends(dispatch)[0];
    })) as unknown as { idempotencyKey: string; content: unknown };
    expect(retried.idempotencyKey).toBe(first.idempotencyKey);
    expect(JSON.stringify(retried.content)).toBe(JSON.stringify(first.content));
  });
});
