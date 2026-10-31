// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { placeList } from "@opensteer/client/host";
import type {
  PresentationCommitGuard,
  ScreenPresentationPort,
  ScreenShowTarget,
  ScreenSurface,
} from "@opensteer/client/screen";
import type { VoiceTarget } from "@opensteer/client/voice";
import { ThreadIdSchema } from "@opensteer/core";
import { Dialog } from "../dialog.js";
import {
  click,
  client,
  element,
  firstTaskId,
  goTo,
  history,
  isMockPage,
  mount,
  pageTab,
  placeParams,
  settle,
  tabSearch,
  write,
} from "./workspace.interaction.test-support.js";

let voice: {
  readonly navigate: (target: VoiceTarget) => void;
  readonly presentation: ScreenPresentationPort;
} | null = null;
vi.mock("../voice.js", async (original) => ({
  ...(await original<typeof import("../voice.js")>()),
  useVoiceRuntime: (
    _host: unknown,
    navigate: (target: VoiceTarget) => void,
    _dictation: unknown,
    presentation: ScreenPresentationPort,
  ) => {
    voice = { navigate, presentation };
    return null;
  },
}));

function port(): ScreenPresentationPort {
  if (!voice) throw new Error("The shell gave voice no presentation port");
  return voice.presentation;
}

/** The shared controller's guard: anything the person did since `capture` refuses. */
function guardSince(): PresentationCommitGuard {
  const captured = port().capture().interactionRevision;
  return {
    operationId: "op",
    check: () =>
      port().capture().interactionRevision === captured
        ? port().blocked()
        : { outcome: "superseded", reason: "interaction-ended" },
  };
}

async function prepare(target: ScreenShowTarget) {
  return port().prepare(target, new AbortController().signal);
}

async function commit(
  prepared: Awaited<ReturnType<typeof prepare>>,
  guard: PresentationCommitGuard,
) {
  let result: ReturnType<typeof prepared.commitIfCurrent> | undefined;
  await act(async () => {
    result = prepared.commitIfCurrent(guard);
  });
  await settle();
  return result!;
}

function surface(place = pageTab()): ScreenSurface {
  if (place.destination.kind !== "browser") throw new Error("Not a browser place");
  return place.destination as ScreenSurface;
}

function otherPage() {
  const first = pageTab();
  const other = placeList(client.getSnapshot()).find(
    (item) => item.kind === "browser" && isMockPage(item) && item.key !== first.key,
  );
  if (!other) throw new Error("Missing a second page");
  return other;
}

const thread = (id: string) => ThreadIdSchema.parse(id);

describe("an agent's presentation on the web", () => {
  it("prepares without navigating; a conversation keeps the place, as one push", async () => {
    await mount((source) => `/${tabSearch(pageTab(source))}`);
    const place = pageTab();
    const taskId = firstTaskId();
    const guard = guardSince();
    const before = history.length;
    const prepared = await prepare({ conversationId: thread(taskId) });
    await settle();
    expect(history.length).toBe(before);
    expect(await commit(prepared, guard)).toBe("committed");
    await expect(prepared.confirmation).resolves.toEqual({ outcome: "applied" });
    expect(history.slice(before)).toEqual([
      { path: `/threads/${taskId}`, search: expect.any(String), type: "PUSH" },
    ]);
    expect(placeParams(history.at(-1)!.search)).toBe(placeParams(tabSearch(place)));
    // Its own arrival is not the person's choice.
    expect(guard.check()).toBeNull();
  });

  it("a surface keeps the conversation; both axes are one entry; the same again adds none", async () => {
    await mount("/");
    const taskId = firstTaskId();
    const page = pageTab();
    const other = otherPage();
    let before = history.length;
    const alone = await prepare({ surface: surface(page) });
    expect(await commit(alone, guardSince())).toBe("committed");
    expect(history.slice(before)).toEqual([
      { path: "/", search: expect.any(String), type: "PUSH" },
    ]);
    expect(placeParams(history.at(-1)!.search)).toBe(placeParams(tabSearch(page)));

    before = history.length;
    const both = await prepare({ conversationId: thread(taskId), surface: surface(other) });
    expect(await commit(both, guardSince())).toBe("committed");
    expect(history.slice(before)).toEqual([
      { path: `/threads/${taskId}`, search: expect.any(String), type: "PUSH" },
    ]);
    expect(placeParams(history.at(-1)!.search)).toBe(placeParams(tabSearch(other)));
    expect(element(".place").getAttribute("data-place-key")).toBe(other.key);

    before = history.length;
    const again = await prepare({ conversationId: thread(taskId), surface: surface(other) });
    expect(await commit(again, guardSince())).toBe("committed");
    await expect(again.confirmation).resolves.toEqual({ outcome: "applied" });
    expect(history.length).toBe(before);
  });

  it("a conversation-only choice by the person outdates it, though the place never moved", async () => {
    await mount((source) => `/${tabSearch(pageTab(source))}`);
    const page = pageTab();
    const guard = guardSince();
    const prepared = await prepare({ surface: surface(otherPage()) });
    const taskId = firstTaskId();
    await click(element(`.side-task[data-thread-id="${taskId}"] .side-task__main`));
    expect(placeParams(history.at(-1)!.search)).toBe(placeParams(tabSearch(page)));
    const before = history.length;
    expect(await commit(prepared, guard)).toEqual({
      outcome: "superseded",
      reason: "interaction-ended",
    });
    expect(history.length).toBe(before);
    expect(element(".place").getAttribute("data-place-key")).toBe(page.key);
  });

  it("Back, choosing what is already shown, and a spoken Back each outdate it", async () => {
    await mount("/");
    const page = pageTab();
    await click(element(`.side-tab[data-place-key="${page.key}"] .side-tab__main`));

    let guard = guardSince();
    await act(async () => goTo!(-1));
    await settle();
    expect(guard.check()).toEqual({ outcome: "superseded", reason: "interaction-ended" });

    await click(element(`.side-tab[data-place-key="${page.key}"] .side-tab__main`));
    guard = guardSince();
    const before = history.length;
    await click(element(`.side-tab[data-place-key="${page.key}"] .side-tab__main`));
    expect(history.length).toBe(before);
    expect(guard.check()).toEqual({ outcome: "superseded", reason: "interaction-ended" });

    guard = guardSince();
    // Counted before the router has even answered.
    voice!.navigate({ kind: "back" });
    expect(guard.check()).toEqual({ outcome: "superseded", reason: "interaction-ended" });
    await settle();
  });

  it("is blocked in Settings, while words are typed or text is selected", async () => {
    await mount("/");
    const composer = element<HTMLTextAreaElement>(".composer textarea");
    await act(async () => composer.focus());
    // An empty focused composer is not an edit.
    expect(port().blocked()).toBeNull();
    const guard = guardSince();
    await write(composer, "draft");
    expect(port().blocked()).toEqual({ outcome: "superseded", reason: "busy" });
    await write(composer, "");
    expect(port().blocked()).toBeNull();
    // The edit itself outdated what was captured before it.
    expect(guard.check()).toEqual({ outcome: "superseded", reason: "interaction-ended" });
    await act(async () => composer.blur());

    const words = document.createElement("p");
    words.textContent = "Selected words";
    document.body.append(words);
    document.getSelection()!.selectAllChildren(words);
    expect(port().blocked()).toEqual({ outcome: "superseded", reason: "busy" });
    document.getSelection()!.removeAllRanges();
    expect(port().blocked()).toBeNull();

    await act(async () => goTo!("/settings/account"));
    await settle();
    expect(port().blocked()).toEqual({ outcome: "superseded", reason: "busy" });
  });

  it("a modal blocks it, and closing the modal does not bring it back", async () => {
    await mount("/");
    const guard = guardSince();
    const prepared = await prepare({ surface: surface() });
    const host = document.createElement("div");
    document.body.append(host);
    const modal = createRoot(host);
    await act(async () =>
      modal.render(
        <Dialog onClose={() => undefined} title="Rename">
          body
        </Dialog>,
      ),
    );
    expect(port().blocked()).toEqual({ outcome: "superseded", reason: "busy" });
    await act(async () => modal.unmount());
    expect(port().blocked()).toBeNull();
    const before = history.length;
    expect(await commit(prepared, guard)).toEqual({
      outcome: "superseded",
      reason: "interaction-ended",
    });
    expect(history.length).toBe(before);
  });

  it("on a narrow screen, opening the drawer outdates it and the open drawer blocks", async () => {
    await mount("/", { width: 820 });
    const guard = guardSince();
    const prepared = await prepare({ surface: surface() });
    await click(element(".conv-header .drawer-btn"));
    expect(port().blocked()).toEqual({ outcome: "superseded", reason: "busy" });
    const before = history.length;
    const whileOpen = await prepare({ surface: surface() });
    expect(await commit(whileOpen, guardSince())).toEqual({
      outcome: "superseded",
      reason: "busy",
    });
    await click(element(".sidebar-scrim"));
    expect(port().blocked()).toBeNull();
    // Closing it does not bring back what was captured before it opened.
    expect(await commit(prepared, guard)).toEqual({
      outcome: "superseded",
      reason: "interaction-ended",
    });
    expect(history.length).toBe(before);
  });

  it("input into the live page outdates it", async () => {
    await mount((source) => `/${tabSearch(pageTab(source))}`);
    const guard = guardSince();
    await act(async () => {
      element(".place [data-live-page]").dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
    });
    expect(guard.check()).toEqual({ outcome: "superseded", reason: "interaction-ended" });
  });

  it("refuses a conversation or tab it cannot find exactly, without navigating", async () => {
    await mount("/");
    const before = history.length;
    const closed = { outcome: "unavailable", reason: "closed" };
    const unknown = await prepare({
      conversationId: thread("thr_00000000-0000-4000-8000-0000000009ff"),
    });
    expect(await commit(unknown, guardSince())).toEqual(closed);
    const page = surface();
    if (page.kind !== "browser") throw new Error("Not a browser surface");
    const gone = await prepare({ surface: { ...page, tabId: "tab:gone" as typeof page.tabId } });
    expect(await commit(gone, guardSince())).toEqual(closed);
    expect(history.length).toBe(before);
  });
});

describe("what a spoken message carries", () => {
  it("the task and page in front when heard, read later only while that page is unchanged", async () => {
    const taskId = await (async () => {
      let id = "";
      await mount((source) => {
        const snapshot = source.getSnapshot();
        id = snapshot.threads.find((item) => item.id !== snapshot.homeThreadId)!.id;
        return `/threads/${id}${tabSearch(pageTab(source))}`;
      });
      return id;
    })();
    const page = pageTab();
    if (page.destination.kind !== "browser") throw new Error("Not a browser place");
    const { sessionId, tabId } = page.destination;
    const candidate = {
      sessionId,
      tabId,
      documentId: page.browser!.documentId!,
      title: "Page",
      url: "https://example.com/",
    } as Awaited<ReturnType<typeof client.readBrowserContextCandidate>>;
    const read = vi.spyOn(client, "readBrowserContextCandidate").mockResolvedValue(candidate);
    const heard = port().capture();
    expect(heard.currentThreadId).toBe(taskId);
    // The screen moves on before the message is sent; the heard page is still the one carried.
    await act(async () => goTo!("/"));
    await settle();
    expect(port().capture().currentThreadId).toBeUndefined();
    expect(await heard.places()).toEqual([{ ...candidate, auto: true, type: "browser-page" }]);
    expect(read).toHaveBeenCalledWith(sessionId, tabId);
    read.mockResolvedValue({ ...candidate, documentId: "another-document" });
    expect(await heard.places()).toEqual([]);
  });
});
