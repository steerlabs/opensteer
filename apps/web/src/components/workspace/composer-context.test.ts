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
  const host = { readBrowserContextCandidate } as unknown as HostClient;
  const place = {
    availability: "ready",
    destination: { kind: "browser", sessionId: candidate.sessionId, tabId: candidate.tabId },
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
  const page = { kind: "browser" } as unknown as PlaceItem;
  const app = {
    availability: "ready",
    destination: { kind: "opensteer-app", appId: "app_11111111-1111-4111-8111-111111111111" },
    kind: "opensteer-app",
  } as unknown as PlaceItem;
  expect(attachablePlaces([page, app])).toEqual([page]);
  expect(await autoPlacePart({} as unknown as HostClient, app)).toBeNull();
});
