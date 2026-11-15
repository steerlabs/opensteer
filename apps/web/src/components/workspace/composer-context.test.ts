import { expect, it, vi } from "vitest";
import type { HostClient, PlaceItem } from "@opensteer/client/host";
import { attachablePlaces, autoPlacePart } from "./composer-context.js";

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
