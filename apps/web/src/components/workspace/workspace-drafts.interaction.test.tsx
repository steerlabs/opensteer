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

import { startPageLink } from "./navigation.js";

import {
  root,
  client,
  history,
  historyState,
  goTo,
  type Entry,
  mount,
  settle,
  element,
  click,
  isMockPage,
  pageTab,
  tabSearch,
  deferred,
  write,
  pressEnter,
  firstTaskId,
  setRoot,
} from "./workspace.interaction.test-support.js";
describe("the draft's places", () => {
  it("follows the sign-in form page and sends its automatic reference on the first press", async () => {
    await mount((source) => {
      const form = placeList(source.getSnapshot()).find(
        (place) =>
          place.destination.kind === "browser" && place.destination.tabId === "mock-tab-0-2",
      )!;
      return `/${tabSearch(form)}`;
    });
    await settle(100);
    const form = placeList(client.getSnapshot()).find(
      (place) => place.destination.kind === "browser" && place.destination.tabId === "mock-tab-0-2",
    )!;
    if (form.destination.kind !== "browser") throw new Error("Missing sign-in form tab");
    expect(element(".context-chip__title").textContent).toBe(form.title);
    const dispatch = vi.spyOn(client, "dispatch");
    await write(element<HTMLTextAreaElement>("[data-composer-input]"), "Help with this form");
    await click(element(".composer__send"));
    await settle(100);
    const sends = dispatch.mock.calls.filter(([command]) => command.type === "thread.sendMessage");
    expect(sends).toHaveLength(1);
    const command = sends[0]![0];
    if (command.type !== "thread.sendMessage") throw new Error("Missing send");
    const page = {
      type: "browser-page",
      auto: true,
      documentId: form.browser?.documentId,
      sessionId: form.destination.sessionId,
      tabId: form.destination.tabId,
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
    expect(element<HTMLTextAreaElement>("[data-composer-input]").value).toBe("");
  });

  it("follows the page while untouched, freezes on typing, and a removal sticks", async () => {
    await mount((source) => `/${tabSearch(pageTab(source))}`);
    const place = pageTab();
    await settle(100);
    expect(element(".context-chip__title").textContent).toBe(place.title);
    // The field names whom it asks, and what about.
    expect(element<HTMLTextAreaElement>("[data-composer-input]").placeholder).toBe(
      "Ask Opensteer about this page…",
    );
    // Typing freezes the chip on this page; another tab does not replace it.
    const field = element<HTMLTextAreaElement>("[data-composer-input]");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        field,
        "About this",
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const other = placeList(client.getSnapshot()).find(
      (item) => item.kind === "browser" && item.key !== place.key && isMockPage(item),
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

  // A page's icon is published about a second after the page itself, and the
  // Host serves it only while a tab shows that page.
  describe("each chip wears its own page's icon", () => {
    const icon = (ref: string) => `data:image/png;base64,${btoa(ref)}`;
    const title = () => element(".context-chip__title").textContent;
    const chipIcon = (chip = ".context-chip") =>
      document.querySelector(`${chip} .site-mark--icon`)?.getAttribute("src") ?? null;
    async function open(path: Entry | ((source: MockHostClient) => Entry)) {
      vi.stubGlobal(
        "Image",
        class {
          naturalWidth = 32;
          onload: (() => void) | null = null;
          set src(_value: string) {
            queueMicrotask(() => this.onload?.());
          }
        },
      );
      await mount((source) => {
        vi.spyOn(source, "readBrowserTabIcon").mockImplementation(async (_session, ref) =>
          icon(ref),
        );
        return typeof path === "function" ? path(source) : path;
      });
      const place = pageTab();
      if (place.destination.kind !== "browser" || !place.destination.tabId)
        throw new Error("Not a browser tab");
      const { sessionId, tabId } = place.destination;
      const surfaceId = BrowserSurfaceIdSchema.parse(tabId);
      return {
        place,
        sessionId,
        tabId,
        icon: () =>
          client
            .getSnapshot()
            .browserSessions.find((session) => session.id === sessionId)
            ?.tabCatalog?.tabs.find((tab) => tab.id === tabId)?.iconRef ?? null,
        go: async (url: string) => {
          await act(async () => {
            client.sendBrowserCommand(sessionId, { surfaceId, type: "navigation.go", url });
          });
          await settle(100);
        },
      };
    }
    async function type(text: string) {
      const field = element<HTMLTextAreaElement>("[data-composer-input]");
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
          field,
          text,
        );
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }

    it("takes it once published, and keeps it when the tab moves on or the message comes back", async () => {
      const tab = await open((source) => `/${tabSearch(pageTab(source))}`);
      // The chip follows a new page at once, before its browser has an icon.
      await tab.go("https://verified.capitalone.com/auth/signin");
      expect(title()).toBe("verified.capitalone.com");
      expect(tab.icon()).toBeNull();
      expect(chipIcon()).toBeNull();
      await settle(1_100);
      const capitalOne = tab.icon();
      expect(capitalOne).not.toBeNull();
      expect(chipIcon()).toBe(icon(capitalOne!));
      // Frozen before the next page's icon is published, the chip still takes it…
      await tab.go("https://example.org/");
      await type("About this");
      expect(title()).toBe("example.org");
      expect(chipIcon()).toBeNull();
      await settle(1_100);
      const example = tab.icon();
      expect(example).not.toBeNull();
      expect(example).not.toBe(capitalOne);
      expect(chipIcon()).toBe(icon(example!));
      // …and keeps it when the tab moves on, never taking the next page's.
      await tab.go("https://example.net/");
      await settle(1_100);
      expect(tab.icon()).not.toBeNull();
      expect(tab.icon()).not.toBe(example);
      expect(title()).toBe("example.org");
      expect(chipIcon()).toBe(icon(example!));
      // A refused send hands the page back wearing its icon, its tab elsewhere by then.
      const refusal = deferred<void>();
      vi.spyOn(client, "dispatch").mockImplementationOnce(async () => {
        await refusal.promise;
        throw new HostClientRequestError({
          code: "forbidden",
          message: "This browser is no longer visible.",
          status: 403,
        });
      });
      await click(element(".composer__send"));
      await tab.go("https://example.com/");
      await act(async () => refusal.resolve());
      await settle(1_100);
      expect(title()).toBe("example.org");
      expect(chipIcon()).toBe(icon(example!));
    }, 20_000);

    it("an explicit pick wears the page its read found, never the page it was picked from", async () => {
      const tab = await open("/new");
      const read = client.readBrowserContextCandidate.bind(client);
      const reading = deferred<Awaited<ReturnType<typeof read>>>();
      vi.spyOn(client, "readBrowserContextCandidate").mockImplementationOnce(() => reading.promise);
      await click(element('.composer__attach[aria-label="Attach"]'));
      await click(
        [...document.querySelectorAll<HTMLButtonElement>(".popover--attach .place-pick")].find(
          (button) => button.textContent?.includes(tab.place.title),
        )!,
      );
      // The tab moves on while the pick is read, so the read finds the newer page.
      await tab.go("https://second.example/");
      const second = await read(tab.sessionId, tab.tabId);
      await act(async () => reading.resolve(second));
      await settle(1_100);
      const secondIcon = tab.icon();
      expect(secondIcon).not.toBeNull();
      expect(title()).toBe("second.example");
      expect(chipIcon()).toBe(icon(secondIcon!));
      await tab.go("https://third.example/");
      await settle(1_100);
      expect(title()).toBe("second.example");
      expect(chipIcon()).toBe(icon(secondIcon!));
    });
  });

  // The runtime reads a page's title after its document: until then the
  // reference is exact but untitled, and the catalog may still show the page
  // before it.
  describe("a page read before it has named itself", () => {
    type Candidate = Awaited<ReturnType<MockHostClient["readBrowserContextCandidate"]>>;
    const chipTitle = () => document.querySelector(".context-chip__title")?.textContent ?? null;
    const chipPicture = () =>
      document.querySelector(".context-chip__thumb")?.getAttribute("src") ?? null;
    const field = () => element<HTMLTextAreaElement>("[data-composer-input]");
    function sentPages(dispatch: MockInstance<MockHostClient["dispatch"]>) {
      return dispatch.mock.calls.flatMap(([command]) =>
        command.type === "thread.sendMessage"
          ? command.content.filter((part) => part.type === "browser-page")
          : [],
      );
    }
    function otherPage(place: PlaceItem) {
      const other = placeList(client.getSnapshot()).find(
        (item) => item.kind === "browser" && item.key !== place.key && isMockPage(item),
      );
      if (other?.destination.kind !== "browser" || !other.destination.tabId)
        throw new Error("Missing another page tab");
      return { place: other, tabId: other.destination.tabId };
    }

    /**
     * The selected tab as the runtime reports a document whose title is not
     * read yet: its candidate and its catalog row both say "" until `publish`
     * names it, and the catalog changes as a Host notice changes it. Picked
     * from a new task instead, its catalog row still shows the page before.
     */
    async function untitled({ pick = false, holdFirst = false } = {}) {
      const catalogTitles = new Map<string, string>();
      const readTitles = new Map<string, string>();
      const listeners = new Set<() => void>();
      let source: HostSnapshot | null = null;
      let shown: HostSnapshot | null = null;
      let readCandidate!: MockHostClient["readBrowserContextCandidate"];
      let reads!: MockInstance<MockHostClient["readBrowserContextCandidate"]>;
      const first = deferred<Candidate>();
      await mount(
        (mock) => {
          const place = pageTab(mock);
          if (place.destination.kind !== "browser" || !place.destination.tabId)
            throw new Error("Not a browser tab");
          if (!pick) catalogTitles.set(place.destination.tabId, "");
          readTitles.set(place.destination.tabId, "");
          readCandidate = mock.readBrowserContextCandidate;
          reads = vi
            .spyOn(mock, "readBrowserContextCandidate")
            .mockImplementation(async (sessionId, tabId) => {
              const candidate = await readCandidate(sessionId, tabId);
              return { ...candidate, title: readTitles.get(tabId) ?? candidate.title };
            });
          if (holdFirst) reads.mockImplementationOnce(() => first.promise);
          return pick ? "/new" : `/${tabSearch(place)}`;
        },
        {
          hostClient: (mock) =>
            new Proxy(mock, {
              get(target, name) {
                if (name === "getSnapshot")
                  return () => {
                    const current = target.getSnapshot();
                    if (current === source && shown) return shown;
                    source = current;
                    shown = {
                      ...current,
                      browserSessions: current.browserSessions.map((session) =>
                        session.tabCatalog
                          ? {
                              ...session,
                              tabCatalog: {
                                ...session.tabCatalog,
                                tabs: session.tabCatalog.tabs.map((tab) => ({
                                  ...tab,
                                  title: catalogTitles.get(tab.id) ?? tab.title,
                                })),
                              },
                            }
                          : session,
                      ),
                    };
                    return shown;
                  };
                if (name === "subscribe")
                  return (listener: () => void) => {
                    listeners.add(listener);
                    const stop = target.subscribe(listener);
                    return () => {
                      listeners.delete(listener);
                      stop();
                    };
                  };
                const value: unknown = Reflect.get(target, name);
                return typeof value === "function" ? value.bind(target) : value;
              },
            }),
        },
      );
      await settle(100);
      const place = pageTab();
      if (place.destination.kind !== "browser" || !place.destination.tabId)
        throw new Error("Not a browser tab");
      const { sessionId, tabId } = place.destination;
      const url = (await readCandidate(sessionId, tabId)).url;
      return {
        place,
        sessionId,
        tabId,
        first,
        site: new URL(url).hostname,
        reads: () => reads.mock.calls.filter(([, id]) => id === tabId).length,
        /** The next read of this page answers only when the test says so. */
        hold() {
          const answer = deferred<Candidate>();
          reads.mockImplementationOnce(() => answer.promise);
          return answer;
        },
        answer: async (title: string): Promise<Candidate> => ({
          ...(await readCandidate(sessionId, tabId)),
          title,
        }),
        async publish(tab: string, title: string) {
          catalogTitles.set(tab, title);
          readTitles.set(tab, title);
          source = null;
          await act(async () => {
            for (const listener of listeners) listener();
          });
          await settle(50);
        },
      };
    }

    /** Page pictures that finish only when painted, each as the picture it is given. */
    function heldPictures() {
      const loads: (() => void)[] = [];
      let picture = "";
      vi.stubGlobal(
        "Image",
        class {
          naturalWidth = 32;
          onload: (() => void) | null = null;
          set src(value: string) {
            if (value.startsWith("blob:")) loads.push(() => this.onload?.());
            else queueMicrotask(() => this.onload?.());
          }
        },
      );
      const thumbnail = { drawImage: vi.fn() } as unknown as CanvasRenderingContext2D;
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
        this: HTMLCanvasElement,
      ) {
        return this.width === 88 && this.height === 56 ? thumbnail : null;
      });
      vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(() => picture);
      return {
        taken: () => loads.length,
        async paint(index: number, value: string) {
          picture = value;
          await act(async () => loads[index]!());
          await settle();
        },
      };
    }

    it("names it by the read page's own site, never the catalog's older title, and sends no title", async () => {
      await mount((source) => {
        const read = source.readBrowserContextCandidate;
        vi.spyOn(source, "readBrowserContextCandidate").mockImplementation(
          async (sessionId, tabId) => ({
            ...(await read(sessionId, tabId)),
            title: "",
            url: "https://pay.example/checkout",
          }),
        );
        return `/${tabSearch(pageTab(source))}`;
      });
      await settle(100);
      const place = pageTab();
      expect(place.title).not.toBe("");
      expect(chipTitle()).toBe("pay.example");
      const dispatch = vi.spyOn(client, "dispatch");
      await write(field(), "What is this?");
      await click(element(".composer__send"));
      await settle(100);
      expect(sentPages(dispatch)).toEqual([
        expect.objectContaining({ auto: true, title: "", url: "https://pay.example/checkout" }),
      ]);
    });

    it("an explicit pick is named by its site, sends no title, and is never read again", async () => {
      const page = await untitled({ pick: true });
      expect(page.place.title).not.toBe(page.site);
      await click(element('.composer__attach[aria-label="Attach"]'));
      await click(
        [...document.querySelectorAll<HTMLButtonElement>(".popover--attach .place-pick")].find(
          (button) => button.textContent?.includes(page.place.title),
        )!,
      );
      await settle(100);
      expect(chipTitle()).toBe(page.site);
      expect(page.reads()).toBe(1);
      await page.publish(page.tabId, "Le Petit Jardin – Reserve");
      expect(page.reads()).toBe(1);
      expect(chipTitle()).toBe(page.site);
      const dispatch = vi.spyOn(client, "dispatch");
      await click(element(".composer__send"));
      await settle(100);
      expect(sentPages(dispatch)).toEqual([expect.objectContaining({ auto: false, title: "" })]);
    });

    it("reads it again once when its title is published while the first read is out", async () => {
      const page = await untitled({ holdFirst: true });
      expect(page.reads()).toBe(1);
      expect(chipTitle()).toBeNull();
      const untitledAnswer = await page.answer("");
      await page.publish(page.tabId, "Le Petit Jardin");
      await act(async () => page.first.resolve(untitledAnswer));
      await settle(100);
      expect(chipTitle()).toBe("Le Petit Jardin");
      expect(page.reads()).toBe(2);
    });

    it("reads it again once when its title is published after an untitled read", async () => {
      const pictures = heldPictures();
      const page = await untitled();
      expect(chipTitle()).toBe(page.site);
      expect(page.reads()).toBe(1);
      await pictures.paint(0, "data:image/jpeg;base64,Zmlyc3Q=");
      await page.publish(page.tabId, "Le Petit Jardin");
      await settle(100);
      expect(chipTitle()).toBe("Le Petit Jardin");
      expect(page.reads()).toBe(2);
      // The page keeps its picture while it is read again, then takes the newer one.
      expect(chipPicture()).toBe("data:image/jpeg;base64,Zmlyc3Q=");
      await pictures.paint(1, "data:image/jpeg;base64,c2Vjb25k");
      expect(chipPicture()).toBe("data:image/jpeg;base64,c2Vjb25k");
      // Only an untitled page waits for its title; a titled one is not read per change.
      await page.publish(page.tabId, "(1) Le Petit Jardin");
      expect(page.reads()).toBe(2);
      const dispatch = vi.spyOn(client, "dispatch");
      await write(field(), "What is this?");
      await click(element(".composer__send"));
      await settle(100);
      expect(sentPages(dispatch)).toEqual([
        expect.objectContaining({ auto: true, title: "Le Petit Jardin" }),
      ]);
    });

    it("another tab's title does not read this page again", async () => {
      const page = await untitled();
      const other = otherPage(page.place);
      await page.publish(other.tabId, "Another page's new title");
      await settle(100);
      expect(page.reads()).toBe(1);
      expect(chipTitle()).toBe(page.site);
    });

    it("a frozen untitled draft keeps its untitled page when the title arrives", async () => {
      const page = await untitled();
      await write(field(), "What is this?");
      await page.publish(page.tabId, "Le Petit Jardin");
      await settle(100);
      expect(page.reads()).toBe(1);
      expect(chipTitle()).toBe(page.site);
      const dispatch = vi.spyOn(client, "dispatch");
      await click(element(".composer__send"));
      await settle(100);
      expect(sentPages(dispatch)).toEqual([expect.objectContaining({ auto: true, title: "" })]);
    });

    const interruptions = ["freeze", "remove", "reset", "select", "unmount"] as const;
    async function interrupt(
      how: (typeof interruptions)[number],
      page: Awaited<ReturnType<typeof untitled>>,
    ) {
      if (how === "freeze") await write(field(), "What is this?");
      else if (how === "remove") await click(element(".context-chip__remove"));
      else if (how === "reset") {
        await write(field(), "What is this?");
        await click(element(".composer__send"));
      } else if (how === "select") {
        const other = otherPage(page.place);
        await click(element(`.side-tab[data-place-key="${other.place.key}"] .side-tab__main`));
      } else {
        act(() => root?.unmount());
        setRoot(null);
      }
      await settle(100);
    }
    /** What the draft shows once interrupted: never what a late answer brought. */
    function expectInterrupted(
      how: (typeof interruptions)[number],
      page: Awaited<ReturnType<typeof untitled>>,
    ) {
      if (how === "freeze") expect(chipTitle()).toBe(page.site);
      else if (how === "remove" || how === "unmount") expect(chipTitle()).toBeNull();
      // The next draft asks for itself and finds the page as it is now.
      else if (how === "reset") expect(chipTitle()).toBe("Le Petit Jardin");
      else expect(chipTitle()).toBe(otherPage(page.place).place.title);
    }

    it.each(interruptions)("%s drops the late answer of a title read", async (how) => {
      const page = await untitled();
      const late = page.hold();
      await page.publish(page.tabId, "Le Petit Jardin");
      expect(page.reads()).toBe(2);
      await interrupt(how, page);
      const reads = page.reads();
      await act(async () => late.resolve(await page.answer("A late answer")));
      await settle(100);
      expectInterrupted(how, page);
      expect(document.body.textContent).not.toContain("A late answer");
      await page.publish(page.tabId, "Le Petit Jardin, renamed");
      expect(page.reads()).toBe(reads);
    });

    // A removed or unmounted draft shows no chip to take a picture.
    it.each(["freeze", "reset", "select"] as const)(
      "%s drops the late pictures of the untitled read and the title read",
      async (how) => {
        const pictures = heldPictures();
        const page = await untitled();
        await page.publish(page.tabId, "Le Petit Jardin");
        expect(chipTitle()).toBe("Le Petit Jardin");
        expect(pictures.taken()).toBe(2);
        await interrupt(how, page);
        await pictures.paint(1, "data:image/jpeg;base64,dGl0bGVk");
        await pictures.paint(0, "data:image/jpeg;base64,dW50aXRsZWQ=");
        expect(chipPicture()).toBeNull();
      },
    );
  });

  it("never picks up a page on a task's reply", async () => {
    await mount((source) => `/${tabSearch(pageTab(source))}`);
    const threadId = firstTaskId();
    await click(element(`.side-task[data-thread-id="${threadId}"] .side-task__main`));
    await settle(150);
    expect(document.querySelector(".context-chip")).toBeNull();
  });

  it("explicit + attaches a tab through the candidate read", async () => {
    await mount("/new");
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
      await mount((source) => `/${tabSearch(pageTab(source))}`);
      await settle(100);
      const place = pageTab();
      if (place.destination.kind !== "browser" || !place.destination.tabId) throw new Error("tab");
      const { sessionId, tabId } = place.destination;
      const frozen = await client.readBrowserContextCandidate(sessionId, tabId);
      const field = element<HTMLTextAreaElement>("[data-composer-input]");
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
      expect(dispatch).toHaveBeenCalledOnce();
      expect(dispatch.mock.calls[0]![0]).toMatchObject({
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
      await expect(dispatch.mock.results[0]!.value).resolves.toMatchObject({
        type: "thread.sendMessage",
      });
      expect(document.querySelector(".composer__error")).toBeNull();
      expect(field.value).toBe("");
    },
  );

  it("hands a forbidden message back ahead of the newer draft without duplicate places or refusal UI", async () => {
    await mount((source) => `/${tabSearch(pageTab(source))}`);
    await settle(100);
    const place = pageTab();
    const other = placeList(client.getSnapshot()).find(
      (item) => item.kind === "browser" && item.key !== place.key && isMockPage(item),
    )!;
    const refusal = deferred<void>();
    const message = `This message includes the browser page "${place.title}", which you can no longer see. Remove the page and send the message again.`;
    vi.spyOn(client, "dispatch").mockImplementationOnce(async () => {
      await refusal.promise;
      throw new HostClientRequestError({ code: "forbidden", message, status: 403 });
    });
    const field = element<HTMLTextAreaElement>("[data-composer-input]");
    await write(field, "First message");
    await click(element(".composer__send"));
    await settle(100);
    await write(field, "Newer draft");
    // Put the duplicate after a newer pick so the returned message must reorder it.
    await click(element(".context-chip__remove"));
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
    expect(field.value).toBe("First message\nNewer draft");
    expect(
      [...document.querySelectorAll(".context-chip__title")].map((chip) => chip.textContent),
    ).toEqual([place.title, other.title]);
    expect(element(".composer__error").textContent).toContain(message);
    expect(document.querySelector(".context-chip--refused, .context-refusal")).toBeNull();
    expect(document.body.textContent).not.toContain("Send without it");
    expect(document.body.textContent).not.toContain("Include it");
  });

  it("an automatic page alone does not enable Send; an explicit pick alone does", async () => {
    await mount((source) => `/${tabSearch(pageTab(source))}`);
    await settle(100);
    const place = pageTab();
    expect(element(".context-chip__title").textContent).toBe(place.title);
    expect(document.querySelector(".composer__send")).toBeNull();
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
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]![0]).toMatchObject({
      type: "thread.sendMessage",
      content: [expect.objectContaining({ type: "browser-page", auto: false })],
    });
    await expect(dispatch.mock.results[0]!.value).resolves.toMatchObject({
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
      const place = placeList(client.getSnapshot()).find(
        (item) =>
          item.destination.kind === "app" &&
          item.destination.machineId === machineId &&
          item.ownerView !== null &&
          item.icon.kind === "app" &&
          item.icon.app.bundleId === bundleId,
      );
      if (!place) throw new Error(`Nothing shows ${bundleId} on ${machineId}`);
      return place;
    }
    async function show(place: PlaceItem) {
      await click(element(`.side-tab[data-place-key="${place.key}"] .side-tab__main`));
      await settle(100);
    }
    function reference(place: PlaceItem) {
      const { destination, icon } = place;
      if (destination.kind === "phone")
        return {
          type: "phone",
          machineId: destination.machineId,
          display: destination.display ?? "main",
          name: place.title,
        };
      if (destination.kind !== "app" || icon.kind !== "app") throw new Error("Not a native place");
      return {
        type: "computer-app",
        app: icon.app,
        machineId: destination.machineId,
        name: place.title,
      };
    }
    function sent(dispatch: MockInstance<MockHostClient["dispatch"]>) {
      return dispatch.mock.calls.flatMap(([command]) =>
        command.type === "thread.sendMessage" ? [command] : [],
      );
    }
    const chip = () => document.querySelector(".context-chip__title")?.textContent ?? null;
    const field = () => element<HTMLTextAreaElement>("[data-composer-input]");

    it("carries the app in front on the Mac it is shown from, whichever Mac that is", async () => {
      await mount("/?panel=browser");
      await openTile("Keynote on");
      const keynote = viewed(studioMac, "com.apple.Keynote");
      expect(chip()).toBe(keynote.title);
      expect(field().placeholder).toBe("Ask Opensteer about this app…");
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
      expect(field().value).toBe("");
    });

    it("carries the phone display in front", async () => {
      await mount("/");
      const phone = placeList(client.getSnapshot()).find(
        (item) => item.kind === "phone" && item.availability === "ready",
      );
      if (!phone) throw new Error("The mock world has no ready phone");
      await show(phone);
      expect(chip()).toBe(phone.title);
      expect(field().placeholder).toBe("Ask Opensteer about this phone…");
      const dispatch = vi.spyOn(client, "dispatch");
      await write(field(), "What is on it?");
      await click(element(".composer__send"));
      await settle(100);
      expect(sent(dispatch).map((command) => command.content)).toEqual([
        [{ type: "text", text: "What is on it?" }, reference(phone)],
      ]);
    });

    it("freezes on typing, keeps its app when another place is shown, and a removal sticks", async () => {
      await mount("/?panel=browser");
      await openTile("Keynote on");
      const keynote = viewed(studioMac, "com.apple.Keynote");
      await write(field(), "About this");
      await openTile("Notes on");
      expect(chip()).toBe(keynote.title);
      await click(element(".context-chip__remove"));
      await show(keynote);
      expect(chip()).toBeNull();
    });

    it("sends the place as it is now when it is renamed in the same place", async () => {
      await mount("/");
      const phone = placeList(client.getSnapshot()).find(
        (item) => item.kind === "phone" && item.availability === "ready",
      );
      if (!phone || phone.destination.kind !== "phone") throw new Error("No ready phone");
      const { machineId } = phone.destination;
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
      await mount("/?panel=browser");
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
      await mount("/?panel=browser");
      await openTile("Keynote on");
      const keynote = viewed(studioMac, "com.apple.Keynote");
      expect(chip()).toBe(keynote.title);
      expect(document.querySelector(".composer__send")).toBeNull();
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
      await mount("/?panel=browser");
      await openTile("Keynote on");
      expect(chip()).not.toBeNull();
      await click(element(`.side-task[data-thread-id="${firstTaskId()}"] .side-task__main`));
      await settle(150);
      expect(document.querySelector(".context-chip")).toBeNull();
    });

    it("retries the app it carried with identical content and key, again after a reload", async () => {
      const dispatch = vi.spyOn(MockHostClient.prototype, "dispatch");
      dispatch.mockImplementationOnce(async () => {
        throw new TypeError("Network unavailable");
      });
      await mount("/?panel=browser");
      await openTile("Keynote on");
      const keynote = viewed(studioMac, "com.apple.Keynote");
      await write(field(), "Can you see my screen?");
      await click(element(".composer__send"));
      await settle(50);
      const first = dispatch.mock.calls.at(-1)?.[0] as {
        idempotencyKey: string;
        content: unknown;
      };
      expect(first.content).toEqual([
        { type: "text", text: "Can you see my screen?" },
        reference(keynote),
      ]);
      expect(element(".held-message").textContent).toContain(keynote.title);
      act(() => root?.unmount());
      setRoot(null);
      client.dispose();
      document.body.replaceChildren();
      dispatch.mockClear();
      await mount("/");
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
    const dispatch = vi.spyOn(MockHostClient.prototype, "dispatch");
    dispatch.mockImplementationOnce(async () => {
      throw new TypeError("Network unavailable");
    });
    await mount((source) => `/${tabSearch(pageTab(source))}`);
    await settle(100);
    const app = placeList(client.getSnapshot()).find((place) => place.kind === "app")!;
    await click(element('.composer__attach[aria-label="Attach"]'));
    await click(
      [...document.querySelectorAll<HTMLButtonElement>(".popover--attach .place-pick")].find(
        (button) => button.textContent?.includes(app.title),
      )!,
    );
    await settle(50);
    const field = element<HTMLTextAreaElement>("[data-composer-input]");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        field,
        "Compare these",
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(element(".composer__send"));
    await settle(50);
    const first = dispatch.mock.calls.at(-1)?.[0] as {
      idempotencyKey: string;
      content: readonly { type: string; auto?: boolean }[];
    };
    expect(first.content.map((part) => part.type)).toEqual([
      "text",
      "browser-page",
      "computer-app",
    ]);
    expect(first.content[1]?.auto).toBe(true);
    expect(element(".held-message").textContent).toContain(app.title);
    // The page reloads: the kept message is sent again as exactly what was sent.
    act(() => root?.unmount());
    setRoot(null);
    client.dispose();
    document.body.replaceChildren();
    dispatch.mockClear();
    await mount("/");
    await settle(200);
    const retried = dispatch.mock.calls.find(
      ([command]) => (command as { type: string }).type === "thread.sendMessage",
    )?.[0] as { idempotencyKey: string; content: unknown };
    expect(retried.idempotencyKey).toBe(first.idempotencyKey);
    expect(JSON.stringify(retried.content)).toBe(JSON.stringify(first.content));
  });
});

describe("a link arriving at the start page", () => {
  const address = "https://portablefs.example/docs/mounts";
  const state = { startId: "reply-link", startAddress: address, startOpen: true, startFrom: null };

  it("opens the exact navigate row once in StrictMode and consumes only the history trigger", async () => {
    let open!: MockInstance<MockHostClient["openBrowserTab"]>;
    await mount(
      (source) => {
        open = vi.spyOn(source, "openBrowserTab");
        return { pathname: "/", search: "?panel=browser", state };
      },
      { strict: true },
    );
    await settle(100);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(
      { identity: { kind: "guest" } },
      expect.objectContaining({ url: address }),
    );
    // The mock's several computers refuse Guest until the person chooses one.
    expect(element<HTMLInputElement>(".start-page__input").value).toBe(address);
    expect(element(".start-page__refusal").textContent).toContain("Which computer");
    expect(historyState).toEqual({ ...state, startOpen: false });
    await act(async () => goTo!("/tasks"));
    await act(async () => goTo!(-1));
    await settle(50);
    expect(element<HTMLInputElement>(".start-page__input").value).toBe(address);
    expect(open).toHaveBeenCalledTimes(1);
    await pressEnter(element(".start-page__input"));
    expect(open).toHaveBeenCalledTimes(2);
    await click(element(".start-page__refusal-actions button"));
    await settle(100);
    expect(open).toHaveBeenCalledTimes(3);
    expect(open.mock.calls[2]?.[0]).toMatchObject({ placement: { kind: "runner" } });
    expect(element(".place").getAttribute("data-place-key")).toMatch(/^browser:/u);
  });

  it("uses the covered tab's profile ahead of a remembered Guest and opens even an already listed URL", async () => {
    let open!: MockInstance<MockHostClient["openBrowserTab"]>;
    let profileId: string | null = null;
    let url = "";
    await mount((source) => {
      const snapshot = source.getSnapshot();
      const session = snapshot.browserSessions.find(
        (item) => item.profileId && item.state === "ready",
      )!;
      const tab = session.tabs[0]!;
      profileId = session.profileId;
      url = tab.url;
      localStorage.setItem(
        `opensteer.browse-with.v1:${encodeURIComponent(snapshot.deploymentId!)}:${encodeURIComponent(snapshot.user!.id)}`,
        '{"kind":"guest"}',
      );
      open = vi.spyOn(source, "openBrowserTab");
      return {
        pathname: "/",
        search: "?panel=browser",
        state: {
          ...state,
          startAddress: url,
          startFrom: `panel=browser&browser=${session.id}&browserTab=${tab.id}`,
        },
      };
    });
    await settle(100);
    expect(open).toHaveBeenCalledExactlyOnceWith(
      { identity: { kind: "profile", profileId } },
      expect.objectContaining({ url }),
    );
    expect(element(".place").getAttribute("data-place-key")).toMatch(/^browser:/u);
    expect(document.querySelector(".start-page")).toBeNull();
  });

  it("opens a reply link from a start page already open with the tab it covers", async () => {
    let open!: MockInstance<MockHostClient["openBrowserTab"]>;
    let profileId: string | null = null;
    let from = "";
    await mount((source) => {
      const snapshot = source.getSnapshot();
      const session = snapshot.browserSessions.find(
        (item) => item.profileId && item.state === "ready",
      )!;
      profileId = session.profileId;
      from = `panel=browser&browser=${session.id}&browserTab=${session.tabs[0]!.id}`;
      localStorage.setItem(
        `opensteer.browse-with.v1:${encodeURIComponent(snapshot.deploymentId!)}:${encodeURIComponent(snapshot.user!.id)}`,
        '{"kind":"guest"}',
      );
      open = vi.spyOn(source, "openBrowserTab");
      return {
        pathname: "/threads/thr_00000000-0000-4000-8000-000000000002",
        search: "?panel=browser",
        state: { startId: "new-tab", startFrom: from },
      };
    });
    await settle(100);
    const link = [...document.querySelectorAll<HTMLAnchorElement>(".md-prose a")].find(
      (anchor) => anchor.textContent === "PortableFS mount guide",
    )!;
    await click(link);
    await settle(100);
    expect(open).toHaveBeenCalledExactlyOnceWith(
      { identity: { kind: "profile", profileId } },
      expect.objectContaining({ url: "https://portablefs.example/docs/mounts" }),
    );
  });

  it("consumes an unavailable arrival but keeps its address and refusal", async () => {
    let open!: MockInstance<MockHostClient["openBrowserTab"]>;
    await mount((source) => {
      open = vi.spyOn(source, "openBrowserTab");
      const snapshot = source.getSnapshot();
      localStorage.setItem(
        `opensteer.browse-with.v1:${encodeURIComponent(snapshot.deploymentId!)}:${encodeURIComponent(snapshot.user!.id)}`,
        '{"kind":"profile","profileId":"missing-profile"}',
      );
      return { pathname: "/", search: "?panel=browser", state };
    });
    expect(open).not.toHaveBeenCalled();
    expect(element<HTMLInputElement>(".start-page__input").value).toBe(address);
    expect(element(".start-page__refusal").textContent).toContain("isn’t available");
    expect(historyState).toEqual({ ...state, startOpen: false });
  });

  it("a consumed arrival survives remount without reopening", async () => {
    let open!: MockInstance<MockHostClient["openBrowserTab"]>;
    await mount((source) => {
      open = vi.spyOn(source, "openBrowserTab");
      return { pathname: "/", search: "?panel=browser", state: { ...state, startOpen: false } };
    });
    expect(open).not.toHaveBeenCalled();
    expect(element<HTMLInputElement>(".start-page__input").value).toBe(address);
  });

  it("a delayed arrival follows a conversation change, but never a newer place choice", async () => {
    await mount("/");
    const target = pageTab();
    if (target.destination.kind !== "browser" || !target.destination.tabId)
      throw new Error("Not a browser tab");
    const { sessionId, tabId } = target.destination;
    const open = vi.spyOn(client, "openBrowserTab");
    const answer = deferred<{ sessionId: string; tabId: string }>();
    open.mockImplementationOnce(() => answer.promise as never);
    await act(async () => goTo!({ pathname: "/", search: "?panel=browser" }, { state }));
    expect(open).toHaveBeenCalledTimes(1);
    const threadId = firstTaskId();
    await click(element(`.side-task[data-thread-id="${threadId}"] .side-task__main`));
    await act(async () => answer.resolve({ sessionId, tabId }));
    await settle(50);
    expect(history.at(-1)!.path).toBe(`/threads/${threadId}`);
    expect(new URLSearchParams(history.at(-1)!.search).get("browserTab")).toBe(tabId);
    const late = deferred<{ sessionId: string; tabId: string }>();
    open.mockImplementationOnce(() => late.promise as never);
    await act(async () =>
      goTo!(
        { pathname: `/threads/${threadId}`, search: "?panel=browser" },
        { state: { ...state, startId: "second-link" } },
      ),
    );
    const chosen = placeList(client.getSnapshot()).find(
      (item) => item.kind === "browser" && item.key !== target.key,
    )!;
    await click(element(`.side-tab[data-place-key="${chosen.key}"] .side-tab__main`));
    const before = history.length;
    await act(async () => late.resolve({ sessionId, tabId }));
    await settle(50);
    expect(history.length).toBe(before);
    expect(element(".place").getAttribute("data-place-key")).toBe(chosen.key);
  });

  it.each([
    null,
    {},
    { startAddress: 123 },
    { startAddress: "x".repeat(8193) },
    { startAddress: "search words" },
    { startAddress: "file:///tmp/a" },
    { startAddress: "https://user:password@example.test" },
  ])("rejects untrusted address state %j", (value) => {
    expect(startPageLink(value)).toBeNull();
  });
  it.each([address, "http://localhost:3000", "example.com"])(
    "keeps a valid address's spelling: %s",
    (value) => {
      expect(startPageLink({ startAddress: value })).toEqual({ address: value, open: false });
    },
  );
});

/*
 * The workspace web review's findings, one test each. The asynchronous ones
 * hold the Host's answer on a deferred promise, as the
 * review did, and let the reader act before it lands.
 */
