import { expect, it, vi } from "vitest";
import { placeList } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { heardPlaces } from "./places.js";

it("carries the page in front when heard, only while it shows the same document", async () => {
  const host = new MockHostClient({ automations: "absent", latencyMs: 0 });
  await host.load();
  const tab = placeList(host.getSnapshot()).find((place) => place.destination.kind === "browser")!;
  if (tab.destination.kind !== "browser") throw new Error("Missing browser place");
  const { sessionId, tabId } = tab.destination;
  const candidate = {
    sessionId,
    tabId,
    documentId: tab.browser!.documentId!,
    title: "Page",
    url: "https://example.com/path",
  } as Awaited<ReturnType<MockHostClient["readBrowserContextCandidate"]>>;
  const read = vi.spyOn(host, "readBrowserContextCandidate").mockResolvedValue(candidate);
  const heard = heardPlaces(host, {
    name: "WorkspaceBrowser",
    params: { deploymentId: "dep", scope: "workspace", sessionId, tabId },
  });
  // Read later, after the screen has moved on: still exactly that page.
  expect(await heard()).toEqual([{ ...candidate, auto: true, type: "browser-page" }]);
  expect(read).toHaveBeenCalledWith(sessionId, tabId);
  read.mockResolvedValue({ ...candidate, documentId: "another-document" });
  expect(await heard()).toEqual([]);
  read.mockResolvedValue({ ...candidate, url: "about:blank" });
  expect(await heard()).toEqual([]);

  read.mockClear();
  for (const hidden of [
    undefined,
    { name: "Home" },
    { name: "WorkspaceBrowser", params: {} },
    { name: "WorkspaceBrowser", params: { sessionId, tabId: "gone" } },
  ])
    expect(await heardPlaces(host, hidden)()).toEqual([]);
  expect(read).not.toHaveBeenCalled();
});
