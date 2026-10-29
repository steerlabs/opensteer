import { expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import { desktopWebLinksReady, openDesktopWebLink } from "./web-links.js";
const link = {
  type: "open-web-url",
  id: "ffb4fd5c-8840-45ce-9497-42f387acb291",
  url: "https://example.com/path?q=1",
};
it("revalidates renderer links before invoking any browser command", async () => {
  const client = new MockHostClient();
  const open = vi.spyOn(client, "openBrowserTab");
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
      openDesktopWebLink({ ...link, url }, client, { kind: "guest" }, vi.fn(), vi.fn()),
    ).rejects.toThrow();
  }
  expect(open).not.toHaveBeenCalled();
  client.dispose();
});
it("opens the exact destination through the person command, selects it then acknowledges with a stable retry key", async () => {
  const client = new MockHostClient();
  const open = vi
    .spyOn(client, "openBrowserTab")
    .mockResolvedValue({ sessionId: "session", tabId: "tab" } as Awaited<
      ReturnType<typeof client.openBrowserTab>
    >);
  const order: string[] = [];
  const show = vi.fn(() => {
    order.push("show");
  });
  const ack = vi.fn(async () => {
    order.push("ack");
  });
  await openDesktopWebLink(link, client, { kind: "guest" }, show, ack);
  expect(open).toHaveBeenCalledWith(
    { identity: { kind: "guest" } },
    { url: link.url, idempotencyKey: `desktop-web-link:${link.id}` },
  );
  expect(show).toHaveBeenCalledWith({ kind: "browser", sessionId: "session", tabId: "tab" });
  expect(ack).toHaveBeenCalledWith(link.id);
  expect(order).toEqual(["show", "ack"]);
  client.dispose();
});
it("does not acknowledge when the person command fails", async () => {
  const client = new MockHostClient();
  vi.spyOn(client, "openBrowserTab").mockRejectedValue(new Error("Browser unavailable"));
  const ack = vi.fn();
  const show = vi.fn();
  await expect(openDesktopWebLink(link, client, { kind: "guest" }, show, ack)).rejects.toThrow(
    "Browser unavailable",
  );
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
  const { preserveWebLinkSelection } = await import("./web-links.js");
  const client = new MockHostClient();
  const show = vi.fn();
  const ack = vi.fn(async () => undefined);
  let view = "/";
  const select = preserveWebLinkSelection(() => view, show);
  let resolve: ((value: Awaited<ReturnType<typeof client.openBrowserTab>>) => void) | undefined;
  vi.spyOn(client, "openBrowserTab").mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const opening = openDesktopWebLink(link, client, { kind: "guest" }, select, ack);
  view = "/settings";
  resolve!({ sessionId: "session", tabId: "tab" } as Awaited<
    ReturnType<typeof client.openBrowserTab>
  >);
  await opening;
  expect(show).not.toHaveBeenCalled();
  expect(ack).toHaveBeenCalledWith(link.id);
  const fresh = preserveWebLinkSelection(() => view, show);
  fresh({ kind: "browser", sessionId: "session", tabId: "tab" });
  expect(show).toHaveBeenCalledOnce();
  client.dispose();
});
