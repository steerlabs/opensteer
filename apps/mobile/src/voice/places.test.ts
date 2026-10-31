import { expect, it, vi } from "vitest";
import type { HostClient } from "@opensteer/client/host";
import { voicePlaces } from "./places.js";

it("includes only the focused browser route's web page", async () => {
  const candidate = {
    sessionId: "bsn_12345678-1234-4123-8123-123456789abc",
    tabId: "tab:test",
    documentId: "document:test",
    title: "Page",
    url: "https://example.com/path",
  };
  const readBrowserContextCandidate = vi.fn().mockResolvedValue(candidate);
  const host = { readBrowserContextCandidate } as unknown as HostClient;
  const route = {
    name: "WorkspaceBrowser",
    params: { sessionId: candidate.sessionId, tabId: candidate.tabId },
  };
  expect(await voicePlaces(host, route)).toEqual([
    { ...candidate, auto: true, type: "browser-page" },
  ]);
  expect(readBrowserContextCandidate).toHaveBeenCalledWith(candidate.sessionId, candidate.tabId);
  readBrowserContextCandidate.mockResolvedValue({ ...candidate, url: "about:blank" });
  expect(await voicePlaces(host, route)).toEqual([]);
  readBrowserContextCandidate.mockClear();
  for (const hidden of [undefined, { name: "Home" }, { name: "WorkspaceBrowser", params: {} }]) {
    expect(await voicePlaces(host, hidden)).toEqual([]);
  }
  expect(readBrowserContextCandidate).not.toHaveBeenCalled();
});
