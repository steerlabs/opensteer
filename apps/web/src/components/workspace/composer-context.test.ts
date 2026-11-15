import { expect, it, vi } from "vitest";
import { browserPagePart, placeOf, type HostClient, type PlaceItem } from "@opensteer/client/host";
import { TabSchema } from "@opensteer/core";
import {
  attachablePlaces,
  autoPlacePart,
  chipFor,
  chipMark,
  readsAgainForTitle,
} from "./composer-context.js";

it("reads the ready shown page as automatic context and leaves blank tabs out", async () => {
  const candidate = {
    sessionId: "bsn_12345678-1234-4123-8123-123456789abc",
    tabId: "tab:test",
    documentId: "document:test",
    title: "Page",
    url: "https://example.com/path",
  };
  const readBrowserContextCandidate = vi.fn().mockResolvedValue(candidate);
  // A page is read through the session this device was shown it in.
  const tabViewer = () => ({ kind: "page", sessionId: candidate.sessionId, surfaceId: "tab:test" });
  const host = { readBrowserContextCandidate, tabViewer } as unknown as HostClient;
  const place = {
    availability: "ready",
    kind: "page",
    key: candidate.tabId,
  } as unknown as PlaceItem;
  expect(await autoPlacePart(host, place)).toEqual({
    ...candidate,
    auto: true,
    type: "browser-page",
  });
  expect(readBrowserContextCandidate).toHaveBeenCalledWith(candidate.sessionId, candidate.tabId);
  readBrowserContextCandidate.mockResolvedValue({ ...candidate, url: "about:blank" });
  expect(await autoPlacePart(host, place)).toBeNull();
  readBrowserContextCandidate.mockClear();
  expect(await autoPlacePart(host, { ...place, availability: "unavailable" })).toBeNull();
  expect(await autoPlacePart(host, null)).toBeNull();
  expect(readBrowserContextCandidate).not.toHaveBeenCalled();
});

it("keeps app tabs out of a draft's choices and its automatic context", async () => {
  const page = { kind: "page" } as unknown as PlaceItem;
  const app = { availability: "ready", kind: "app" } as unknown as PlaceItem;
  expect(attachablePlaces([page, app])).toEqual([page]);
  expect(await autoPlacePart({} as unknown as HostClient, app)).toBeNull();
});

const sessionId = "bsn_12345678-1234-4123-8123-123456789abc";
/** One page tab as the Host lists it, showing `url` with `iconRef`. */
function pageTabShowing(url: string, iconRef: string | null, title = ""): PlaceItem {
  return placeOf(
    TabSchema.parse({
      tabId: "tab:test",
      kind: "page",
      title,
      computer: { computerId: "rnr_12345678-1234-4123-8123-123456789abc", name: "Mac" },
      groupId: null,
      state: "open",
      openedBy: "person",
      usedBy: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      url,
      profile: null,
      iconRef,
    }),
    [],
  );
}
function readPage(url: string, title = "", auto = true) {
  return browserPagePart({
    auto,
    documentId: `document:${url}`,
    sessionId,
    tabId: "tab:test",
    title,
    url,
  });
}

// A page's icon is published about a second after the page itself, and the
// Host serves it only while a tab shows that page.
it("wears its own page's icon: taken once published, kept when the tab moves on", () => {
  const first = "https://verified.capitalone.com/auth/signin";
  const chip = { ...chipFor(pageTabShowing(first, null), readPage(first), null), auto: true };
  // The chip follows the new page before its browser has an icon: a neutral mark.
  expect(chipMark(chip, pageTabShowing(first, null), undefined)).toEqual({
    kind: "site",
    ref: null,
    tabId: "tab:test",
    url: first,
  });
  const published = pageTabShowing(first, "icon-1");
  expect(chipMark(chip, published, undefined)).toBe(published.icon);
  // The tab moves on: the page keeps the icon remembered for it, never the next page's.
  const remembered = published.icon as Extract<PlaceItem["icon"], { kind: "site" }>;
  const next = pageTabShowing("https://example.net/", "icon-2");
  expect(chipMark(chip, next, remembered)).toBe(remembered);
  // Nothing remembered yet (or the tab closed): its own neutral mark, not the tab's.
  expect(chipMark(chip, next, undefined)).toEqual({ kind: "site", ref: null, url: first });
  expect(chipMark(chip, undefined, remembered)).toBe(remembered);
});

it("an explicit pick wears the page its read found, never the page it was picked from", () => {
  const picked = pageTabShowing("https://first.example/", "icon-first", "First");
  // The tab moved on while the pick was read, so the read found the newer page.
  const chip = chipFor(picked, readPage("https://second.example/", "", false), null);
  expect(chip.title).toBe("second.example");
  expect(chipMark(chip, picked, undefined)).toEqual({
    kind: "site",
    ref: null,
    url: "https://second.example/",
  });
  const second = pageTabShowing("https://second.example/", "icon-second");
  expect(chipMark(chip, second, undefined)).toBe(second.icon);
  expect(chipMark(chip, pageTabShowing("https://third.example/", "icon-third"), undefined)).toEqual(
    { kind: "site", ref: null, url: "https://second.example/" },
  );
});

// The runtime reads a page's title after its document: until then the
// reference is exact but untitled, and the tab may still show the title before it.
it("names a page read before its title by its own site, never the tab's older title, and sends no title", () => {
  const tab = pageTabShowing("https://pay.example/checkout", null, "Cart – Old Shop");
  for (const auto of [true, false]) {
    const chip = chipFor(tab, readPage("https://pay.example/checkout", "", auto), null);
    expect(chip.title).toBe("pay.example");
    expect(chip.part).toMatchObject({ title: "" });
  }
});

it("reads a followed page again once, only when its own untitled read gets a title", () => {
  const key = "0:tab:test:document:1";
  const untitled = { key, title: "" };
  const titled = { key, title: "Le Petit Jardin" };
  const untitledRead = readPage("https://jardin.example/", "");
  // Published while the first read is out, or after it answered untitled.
  expect(readsAgainForTitle(untitled, titled, null)).toBe(true);
  expect(readsAgainForTitle(untitled, titled, untitledRead)).toBe(true);
  // A titled page is not read per title change.
  const titledRead = readPage("https://jardin.example/", "Le Petit Jardin");
  expect(readsAgainForTitle(titled, { key, title: "(1) Le Petit Jardin" }, titledRead)).toBe(false);
  // The same title again (another tab changed) is no new title.
  expect(readsAgainForTitle(titled, titled, untitledRead)).toBe(false);
  // A frozen draft asks nothing; another document or a new draft starts its own read.
  expect(readsAgainForTitle(untitled, null, untitledRead)).toBe(false);
  expect(readsAgainForTitle(untitled, { ...titled, key: "1:tab:test:document:1" }, null)).toBe(
    false,
  );
  // A title taken away is no title to read.
  expect(readsAgainForTitle(titled, untitled, null)).toBe(false);
});
