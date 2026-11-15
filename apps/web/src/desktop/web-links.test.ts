import { expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import { tabFixture } from "@opensteer/client/test-support";
import { TabIdSchema } from "@opensteer/core";
import { desktopWebLinksReady, openDesktopWebLink, webLinkSelection } from "./web-links.js";

const link = {
  type: "open-web-url",
  id: "ffb4fd5c-8840-45ce-9497-42f387acb291",
  url: "https://example.com/path?q=1",
};
const opened = tabFixture({ tabId: TabIdSchema.parse("tab-link"), url: link.url });
const tab = (tabId: string) => ({ kind: "tab" as const, tabId: TabIdSchema.parse(tabId) });

it("revalidates renderer links before invoking any command", async () => {
  const client = new MockHostClient();
  const dispatch = vi.spyOn(client, "dispatch");
  for (const url of [
    "file:///tmp/a",
    "https://viewer:secret@example.com/",
    `https://example.com/${"é".repeat(4090)}`,
    "data:text/plain,a",
    "javascript:alert(1)",
    "https://",
    `https://example.com/${"a".repeat(8192)}`,
  ]) {
    await expect(
      openDesktopWebLink(
        { ...link, url },
        client,
        { identity: { kind: "guest" } },
        vi.fn(),
        vi.fn(),
      ),
    ).rejects.toThrow();
  }
  expect(dispatch).not.toHaveBeenCalled();
  client.dispose();
});

it("opens the page as a tab under a key the link fixes, shows it, then acknowledges", async () => {
  const client = new MockHostClient();
  const dispatch = vi.spyOn(client, "dispatch").mockResolvedValue({
    type: "tab.open",
    tab: opened,
    layout: { revision: 2, items: [{ kind: "tab", tabId: opened.tabId }] },
  });
  const order: string[] = [];
  const show = vi.fn(() => {
    order.push("show");
  });
  const ack = vi.fn(async () => {
    order.push("ack");
  });
  await openDesktopWebLink(link, client, { identity: { kind: "guest" } }, show, ack);
  expect(dispatch).toHaveBeenCalledExactlyOnceWith({
    type: "tab.open",
    target: { kind: "page", url: link.url, guest: true },
    idempotencyKey: `desktop-web-link:${link.id}`,
  });
  expect(show).toHaveBeenCalledExactlyOnceWith(tab(opened.tabId));
  expect(ack).toHaveBeenCalledWith(link.id);
  expect(order).toEqual(["show", "ack"]);
  client.dispose();
});

it("does not acknowledge or show anything when the command fails", async () => {
  const client = new MockHostClient();
  vi.spyOn(client, "dispatch").mockRejectedValue(new Error("Browser unavailable"));
  const ack = vi.fn();
  const show = vi.fn();
  await expect(
    openDesktopWebLink(link, client, { identity: { kind: "guest" } }, show, ack),
  ).rejects.toThrow("Browser unavailable");
  expect(show).not.toHaveBeenCalled();
  expect(ack).not.toHaveBeenCalled();
  client.dispose();
});

it("waits for a signed-in Personal UI and an available browser placement", () => {
  const client = new MockHostClient();
  const snapshot = client.getSnapshot();
  const ready = {
    ...snapshot,
    connection: "connected" as const,
    user: snapshot.user!,
    browserPlacements: [{ available: true }],
  } as typeof snapshot;
  expect(snapshot.user).not.toBeNull();
  expect(desktopWebLinksReady(true, ready)).toBe(true);
  expect(desktopWebLinksReady(false, ready)).toBe(false);
  expect(desktopWebLinksReady(true, { ...ready, user: null })).toBe(false);
  expect(desktopWebLinksReady(true, { ...ready, connection: "connecting" })).toBe(false);
  expect(desktopWebLinksReady(true, { ...ready, browserPlacements: [] })).toBe(false);
  client.dispose();
});

it("opens and acknowledges without stealing a view changed after arrival", async () => {
  const client = new MockHostClient();
  const show = vi.fn();
  const ack = vi.fn(async () => undefined);
  let view = { revision: 0, changedAt: 0 };
  const selection = webLinkSelection(() => view);
  const select = selection(show)(undefined);
  const answer = Promise.withResolvers<Awaited<ReturnType<typeof client.dispatch>>>();
  vi.spyOn(client, "dispatch").mockReturnValue(answer.promise);
  const opening = openDesktopWebLink(link, client, { identity: { kind: "guest" } }, select, ack);
  view = { revision: 1, changedAt: 50 };
  answer.resolve({
    type: "tab.open",
    tab: opened,
    layout: { revision: 2, items: [{ kind: "tab", tabId: opened.tabId }] },
  });
  await opening;
  expect(show).not.toHaveBeenCalled();
  expect(ack).toHaveBeenCalledWith(link.id);
  selection(show)(60)(tab(opened.tabId));
  expect(show).toHaveBeenCalledExactlyOnceWith(tab(opened.tabId));
  client.dispose();
});

it("keeps links waiting behind one in the background after the person leaves during its open", () => {
  const show = vi.fn();
  let view = { revision: 0, changedAt: 0 };
  const selection = webLinkSelection(() => view);
  // Both links arrived at 10 and 11; main delivers the second after the first's acknowledgement.
  const first = selection(show)(10);
  view = { revision: 1, changedAt: 20 };
  first(tab("first"));
  const second = selection(show)(11);
  second(tab("second"));
  expect(show).not.toHaveBeenCalled();
  selection(show)(30)(tab("third"));
  expect(show).toHaveBeenCalledExactlyOnceWith(tab("third"));
});

it("selects each waiting link in turn when the person stays", () => {
  let view = { revision: 0, changedAt: 0 };
  const shown: unknown[] = [];
  const show = (destination: unknown) => {
    shown.push(destination);
    // Selecting the tab is a navigation of its own, seen before the next delivery starts.
    view = { revision: view.revision + 1, changedAt: view.changedAt + 5 };
  };
  const selection = webLinkSelection(() => view);
  for (const tabId of ["first", "second"]) selection(show)(1)(tab(tabId));
  expect(shown).toEqual([tab("first"), tab("second")]);
});
