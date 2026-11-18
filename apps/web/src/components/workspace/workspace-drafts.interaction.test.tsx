// @vitest-environment happy-dom
import { act } from "react";

import { describe, expect, it, vi, type MockInstance } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import {
  HostClientRequestError,
  placeList,
  type HostSnapshot,
  type PlaceItem,
} from "@opensteer/client/host";
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
/** The first message a new task sends is lost to the network once, after the task exists. */
function loseFirstSend() {
  const real = MockHostClient.prototype.dispatch;
  let lost = false;
  return vi.spyOn(MockHostClient.prototype, "dispatch").mockImplementation(function (
    this: MockHostClient,
    ...args
  ) {
    if (!lost && args[0].type === "thread.sendMessage") {
      lost = true;
      return Promise.reject(new TypeError("Network unavailable"));
    }
    return real.apply(this, args);
  });
}

import {
  root,
  client,
  history,
  mount,
  settle,
  element,
  click,
  isMockPage,
  pageTab,
  tabSearch,
  deferred,
  write,
  firstTaskId,
  setRoot,
} from "./workspace.interaction.test-support.js";
import { composerText, rewrite } from "../composer-editor.test-support.js";
// These tests check what a Send carries, never the agent's reply to it.
const sentOnly = { mock: { replies: "brief" } } as const;

describe("the draft's places", () => {
  it("follows the sign-in form page and sends its automatic reference on the first press", async () => {
    await mount((source) => {
      const form = placeList(source.getSnapshot()).find((place) => place.key === "mock-tab-0-2")!;
      return `/${tabSearch(form)}`;
    }, sentOnly);
    await settle(100);
    const form = placeList(client.getSnapshot()).find((place) => place.key === "mock-tab-0-2")!;
    const sessionId = pageSession(form.key);
    expect(element(".context-chip__title").textContent).toBe(form.title);
    const dispatch = vi.spyOn(client, "dispatch");
    await write(element<HTMLElement>("[data-composer-input]"), "Help with this form");
    await click(element(".composer__send"));
    await settle(100);
    const sends = dispatch.mock.calls.filter(([command]) => command.type === "thread.sendMessage");
    expect(sends).toHaveLength(1);
    const command = sends[0]![0];
    if (command.type !== "thread.sendMessage") throw new Error("Missing send");
    const page = {
      type: "browser-page",
      auto: true,
      documentId: client.browserViewerSurface(sessionId, form.key)?.documentId,
      sessionId,
      tabId: form.key,
      title: form.title,
    };
    expect(command.content).toContainEqual(expect.objectContaining(page));
    await expect(
      dispatch.mock.results.find(
        (_, index) => dispatch.mock.calls[index]?.[0].type === "thread.sendMessage",
      )!.value,
    ).resolves.toMatchObject({ type: "thread.sendMessage" });
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
    expect(composerText(element("[data-composer-input]"))).toBe("");
  });

  it("follows the page while untouched, freezes on typing, and a removal sticks", async () => {
    await mount((source) => `/${tabSearch(pageTab(source))}`, sentOnly);
    const place = pageTab();
    await settle(100);
    expect(element(".context-chip__title").textContent).toBe(place.title);
    // Typing freezes the chip on this page; another tab does not replace it.
    const field = element<HTMLElement>("[data-composer-input]");
    await act(async () => {
      rewrite(field, "About this");
    });
    const other = placeList(client.getSnapshot()).find(
      (item) => item.key !== place.key && isMockPage(item),
    )!;
    await click(element(`.side-tab[data-place-key="${other.key}"] .side-tab__main`));
    await settle(100);
    expect(element(".context-chip__title").textContent).toBe(place.title);
    // Removing it is a choice that sticks across tabs.
    await click(element(".context-chip__remove"));
    await click(element(`.side-tab[data-place-key="${place.key}"] .side-tab__main`));
    await settle(100);
    expect(document.querySelector(".context-chip")).toBeNull();
  });

  // The followed page's read answers after the draft moved on: the draft shows
  // what it chose since, never what the late answer brought.
  it.each(["freeze", "select", "reset"] as const)(
    "%s drops the late answer of the followed page's read",
    async (how) => {
      type Candidate = Awaited<ReturnType<MockHostClient["readBrowserContextCandidate"]>>;
      const late = deferred<Candidate>();
      await mount((source) => {
        vi.spyOn(source, "readBrowserContextCandidate").mockImplementationOnce(() => late.promise);
        return `/${tabSearch(pageTab(source))}`;
      }, sentOnly);
      await settle(100);
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
      await settle(100);
      expect(chipTitle()).toBe(expected);
      const candidate = await client.readBrowserContextCandidate(pageSession(place.key), place.key);
      await act(async () => late.resolve({ ...candidate, title: "A late answer" }));
      await settle(100);
      expect(chipTitle()).toBe(expected);
      expect(document.body.textContent).not.toContain("A late answer");
      await act(async () => sent.resolve());
    },
  );

  it("never picks up a page on a task's reply", async () => {
    await mount((source) => `/${tabSearch(pageTab(source))}`, sentOnly);
    const threadId = firstTaskId();
    await click(element(`.side-task[data-thread-id="${threadId}"] .side-task__main`));
    await settle(150);
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
    await settle(100);
    expect(read).toHaveBeenCalled();
    expect(element(".context-chip__title").textContent).toBe(place.title);
  });

  it.each(["navigate", "reload"] as const)(
    "sends a frozen page on the first press after its tab %ss",
    async (change) => {
      await mount((source) => `/${tabSearch(pageTab(source))}`, sentOnly);
      await settle(100);
      const place = pageTab();
      const tabId = place.key;
      const sessionId = pageSession(tabId);
      const frozen = await client.readBrowserContextCandidate(sessionId, tabId);
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
      await settle(100);
      expect((await client.readBrowserContextCandidate(sessionId, tabId)).documentId).not.toBe(
        frozen.documentId,
      );
      expect(element(".context-chip__title").textContent).toBe(frozen.title);
      const dispatch = vi.spyOn(client, "dispatch");
      await click(element(".composer__send"));
      await settle(100);
      expect(sends(dispatch)).toHaveLength(1);
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
      await mount((source) => `/${tabSearch(pageTab(source))}`, sentOnly);
      await settle(100);
      const place = pageTab();
      const other = placeList(client.getSnapshot()).find(
        (item) => item.key !== place.key && isMockPage(item),
      )!;
      const titles = () =>
        [...document.querySelectorAll(".context-chip__title")].map((chip) => chip.textContent);
      const field = element<HTMLElement>("[data-composer-input]");
      await write(field, "About this");
      await click(element('.composer__attach[aria-label="Attach"]'));
      await click(
        [...document.querySelectorAll<HTMLButtonElement>(".popover--attach .place-pick")].find(
          (button) => button.textContent?.includes(other.title),
        )!,
      );
      await settle(100);
      expect(titles()).toEqual([place.title, other.title]);
      if (how === "handed back") {
        // Editing a refused message restores its places exactly as they were sent.
        const real = client.dispatch.bind(client);
        const dispatch = vi.spyOn(client, "dispatch").mockImplementation(async (...args) => {
          if (args[0].type === "thread.sendMessage")
            throw new HostClientRequestError({
              code: "forbidden",
              message: "Refused",
              status: 403,
            });
          return real(...args);
        });
        await click(element(".composer__send"));
        await settle(100);
        await click(element(".delivery [role=status] button"));
        await settle(100);
        dispatch.mockRestore();
        expect(titles()).toEqual([place.title, other.title]);
      }
      const close = async (closed: PlaceItem) => {
        await act(async () => client.closeTabs([closed.key]));
        await settle(100);
      };
      await close(place);
      expect(titles()).toEqual([other.title]);
      // A snapshot that can no longer prove the end never brings the closed page back.
      const connected = client.getSnapshot.bind(client);
      const seen = new WeakMap<HostSnapshot, HostSnapshot>();
      const offline = vi.spyOn(client, "getSnapshot").mockImplementation(() => {
        const snapshot = connected();
        if (!seen.has(snapshot)) seen.set(snapshot, { ...snapshot, connection: "offline" });
        return seen.get(snapshot)!;
      });
      await close(other);
      expect(titles()).toEqual([other.title]);
      expect(document.querySelector(".context-chip--gone")).not.toBeNull();
      const dispatch = vi.spyOn(client, "dispatch");
      dispatch.mockClear();
      if (how === "handed back") {
        await act(async () => client.connection.stop());
        await click(element(".composer__send"));
        expect(sends(dispatch)).toHaveLength(0);
      }
      offline.mockRestore();
      await act(async () => client.connection.retry());
      if (how === "held") await click(element(".composer__send"));
      await vi.waitFor(() => expect(sends(dispatch)).toHaveLength(1), { timeout: 1000 });
      const command = sends(dispatch)[0]!;
      expect(command.content.filter((part) => part.type !== "text")).toEqual([
        expect.objectContaining({
          type: "browser-page",
          auto: false,
          tabId: other.destination.tabId,
        }),
      ]);
    },
  );

  it("merges a refused message into a newer draft without losing either's places", async () => {
    await mount((source) => `/${tabSearch(pageTab(source))}`, sentOnly);
    await settle(100);
    const place = pageTab();
    const other = placeList(client.getSnapshot()).find(
      (item) => item.key !== place.key && isMockPage(item),
    )!;
    const refusal = deferred<void>();
    const message = `This message includes the browser page "${place.title}", which you can no longer see. Remove the page and send the message again.`;
    const real = client.dispatch.bind(client);
    vi.spyOn(client, "dispatch").mockImplementation(async (...args) => {
      if (args[0].type === "thread.sendMessage") {
        await refusal.promise;
        throw new HostClientRequestError({ code: "forbidden", message, status: 403 });
      }
      return real(...args);
    });
    await write(element("[data-composer-input]"), "First message");
    await click(element(".composer__send"));
    await settle(100);
    const field = element<HTMLElement>("[data-composer-input]");
    await write(field, "Newer draft");
    // The newer draft deliberately picks two pages, including one on the original message.
    for (const pick of [other, place]) {
      await click(element('.composer__attach[aria-label="Attach"]'));
      await click(
        [...document.querySelectorAll<HTMLButtonElement>(".popover--attach .place-pick")].find(
          (button) => button.textContent?.includes(pick.title),
        )!,
      );
      await settle(100);
    }
    expect(
      [...document.querySelectorAll(".context-chip__title")].map((chip) => chip.textContent),
    ).toEqual([other.title, place.title]);
    await act(async () => refusal.resolve());
    await settle(100);
    const rejected = element(".delivery [role=status]").closest(".delivery")!;
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
    await settle(100);
    expect(
      [...document.querySelectorAll(".context-chip__title")].map((chip) => chip.textContent),
    ).toEqual([place.title, other.title]);
  });

  it("an automatic page alone does not enable Send; an explicit pick alone does", async () => {
    await mount((source) => `/${tabSearch(pageTab(source))}`, sentOnly);
    await settle(100);
    const place = pageTab();
    expect(element(".context-chip__title").textContent).toBe(place.title);
    expect(sendEnabled()).toBe(false);
    await click(element(".context-chip__remove"));
    await click(element('.composer__attach[aria-label="Attach"]'));
    await click(
      [...document.querySelectorAll<HTMLButtonElement>(".popover--attach .place-pick")].find(
        (button) => button.textContent?.includes(place.title),
      )!,
    );
    await settle(100);
    expect(element<HTMLButtonElement>(".composer__send").disabled).toBe(false);
    const dispatch = vi.spyOn(client, "dispatch");
    await click(element(".composer__send"));
    await settle(100);
    expect(sends(dispatch)).toHaveLength(1);
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
        await click(element('.side-section--tabs .side-head__action[aria-label="New tab"]'));
      await click(element(`.start-tile[aria-label^='${label}']`));
      await settle(120);
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
      await click(element(`.side-tab[data-place-key="${place.key}"] .side-tab__main`));
      await settle(100);
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
      expect(chip()).toBe(keynote.title);
      await openTile("Notes on");
      expect(chip()).toBe(viewed(macMini, "com.apple.Notes").title);
      await show(keynote);
      expect(chip()).toBe(keynote.title);
      const dispatch = vi.spyOn(client, "dispatch");
      await write(field(), "Can you see my screen?");
      await click(element(".composer__send"));
      await settle(100);
      const sends = sent(dispatch);
      expect(sends).toHaveLength(1);
      expect(sends[0]!.content).toEqual([
        { type: "text", text: "Can you see my screen?" },
        reference(keynote),
      ]);
      expect(reference(keynote)).toMatchObject({ machineId: studioMac });
      await expect(
        dispatch.mock.results.find(
          (_, index) => dispatch.mock.calls[index]?.[0].type === "thread.sendMessage",
        )!.value,
      ).resolves.toMatchObject({ type: "thread.sendMessage" });
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
      await settle(100);
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
      expect(chip()).toBe(keynote.title);
      await click(element(".context-chip__remove"));
      await show(keynote);
      expect(chip()).toBeNull();
    });

    it("lets its automatic app go when its tab closes", async () => {
      await mount("/?panel=browser", sentOnly);
      await openTile("Keynote on");
      const keynote = viewed(studioMac, "com.apple.Keynote");
      await write(field(), "About this");
      expect(chip()).toBe(keynote.title);
      await act(async () => client.closeTabs([keynote.key]));
      await settle(100);
      expect(chip()).toBeNull();
      const dispatch = vi.spyOn(client, "dispatch");
      await click(element(".composer__send"));
      await settle(100);
      const command = sends(dispatch)[0];
      if (!command) throw new Error("Missing send");
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
      await settle(100);
      const renamed = placeList(client.getSnapshot()).find((item) => item.key === phone.key)!;
      expect(renamed.title).toBe("Work phone");
      expect(chip()).toBe("Work phone");
      const dispatch = vi.spyOn(client, "dispatch");
      await write(field(), "And now?");
      await click(element(".composer__send"));
      await settle(100);
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
      await settle(120);
      expect(chip()).toBeNull();
      await act(async () => client.setComputerUseReadiness(studioMac, "ready"));
      await settle(120);
      expect(chip()).toBe(keynote.title);
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
      await settle(100);
      expect(element<HTMLButtonElement>(".composer__send").disabled).toBe(false);
      const dispatch = vi.spyOn(client, "dispatch");
      await click(element(".composer__send"));
      await settle(100);
      expect(sent(dispatch).map((command) => command.content)).toEqual([[reference(keynote)]]);
    });

    it("never picks up an app on a task's reply", async () => {
      await mount("/?panel=browser", sentOnly);
      await openTile("Keynote on");
      expect(chip()).not.toBeNull();
      await click(element(`.side-task[data-thread-id="${firstTaskId()}"] .side-task__main`));
      await settle(150);
      expect(document.querySelector(".context-chip")).toBeNull();
    });

    it("retries the app it carried with identical content and key, again after a reload", async () => {
      const dispatch = loseFirstSend();
      await mount("/?panel=browser", sentOnly);
      await openTile("Keynote on");
      const keynote = viewed(studioMac, "com.apple.Keynote");
      await write(field(), "Can you see my screen?");
      await click(element(".composer__send"));
      await settle(50);
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
      // The kept message belongs to the task it started: reloading there sends it again.
      await mount(`${history.at(-1)!.path}${history.at(-1)!.search}`, { sameHost: true });
      await settle(200);
      const retried = dispatch.mock.calls.find(
        ([command]) => (command as { type: string }).type === "thread.sendMessage",
      )?.[0] as { idempotencyKey: string; content: unknown };
      expect(retried.idempotencyKey).toBe(first.idempotencyKey);
      expect(JSON.stringify(retried.content)).toBe(JSON.stringify(first.content));
    });
  });
});

describe("unconfirmed sends keep every place exactly", () => {
  it("retries with identical content and key, again after a reload, pages and apps alike", async () => {
    const dispatch = loseFirstSend();
    await mount((source) => `/${tabSearch(pageTab(source))}`, sentOnly);
    await settle(100);
    const app = placeList(client.getSnapshot()).find(
      (place) => place.kind === "window" && place.availability === "ready",
    )!;
    await click(element('.composer__attach[aria-label="Attach"]'));
    await click(
      [...document.querySelectorAll<HTMLButtonElement>(".popover--attach .place-pick")].find(
        (button) => button.textContent?.includes(app.title),
      )!,
    );
    await settle(50);
    const field = element<HTMLElement>("[data-composer-input]");
    await act(async () => {
      rewrite(field, "Compare these");
    });
    await click(element(".composer__send"));
    await settle(50);
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
    // The kept message belongs to the task it started: reloading there sends it again.
    await mount(`${history.at(-1)!.path}${history.at(-1)!.search}`, { sameHost: true });
    await settle(200);
    const retried = dispatch.mock.calls.find(
      ([command]) => (command as { type: string }).type === "thread.sendMessage",
    )?.[0] as { idempotencyKey: string; content: unknown };
    expect(retried.idempotencyKey).toBe(first.idempotencyKey);
    expect(JSON.stringify(retried.content)).toBe(JSON.stringify(first.content));
  });
});
