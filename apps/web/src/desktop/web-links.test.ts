import { withTimeout } from "@opensteer/shared/withTimeout";
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
  const open = vi.spyOn(client, "beginBrowserTabOpen");
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
  const open = vi.spyOn(client, "beginBrowserTabOpen").mockReturnValue({
    idempotencyKey: `desktop-web-link:${link.id}`,
    result: Promise.resolve({ sessionId: "session", tabId: "tab" } as Awaited<
      ReturnType<typeof client.openBrowserTab>
    >),
  });
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
  expect(order).toEqual(["show", "show", "ack"]);
  client.dispose();
});
it("does not acknowledge when the person command fails", async () => {
  const client = new MockHostClient();
  vi.spyOn(client, "beginBrowserTabOpen").mockImplementation(() => ({
    idempotencyKey: `desktop-web-link:${link.id}`,
    result: Promise.reject(new Error("Browser unavailable")),
  }));
  const ack = vi.fn();
  const show = vi.fn();
  await expect(openDesktopWebLink(link, client, { kind: "guest" }, show, ack)).rejects.toThrow(
    "Browser unavailable",
  );
  expect(show).toHaveBeenCalledExactlyOnceWith({
    kind: "pending-browser",
    idempotencyKey: `desktop-web-link:${link.id}`,
  });
  expect(ack).not.toHaveBeenCalled();
  client.dispose();
});
it("acknowledges without a failure when the person closes the opening tab", async () => {
  const client = new MockHostClient();
  const gate = Promise.withResolvers<void>();
  const dispatch = client.rpc["commands.dispatch"];
  const delayed: typeof dispatch = async (command, options) => {
    if (command.type === "browser.tab.open")
      await withTimeout(gate.promise, 2_000, {
        timeoutError: () => new Error("The delayed browser command was never released."),
      });
    return dispatch(command, options);
  };
  Object.defineProperty(client, "rpc", {
    value: new Proxy(client.rpc, {
      get: (target, name) => (name === "commands.dispatch" ? delayed : Reflect.get(target, name)),
    }),
  });
  const ack = vi.fn(async () => {});
  const show = vi.fn();
  try {
    const opening = openDesktopWebLink(link, client, { kind: "guest" }, show, ack);
    client.dismissPendingBrowserTab(`desktop-web-link:${link.id}`);
    await opening;
    expect(ack).toHaveBeenCalledExactlyOnceWith(link.id);
    expect(show).toHaveBeenCalledExactlyOnceWith({
      kind: "pending-browser",
      idempotencyKey: `desktop-web-link:${link.id}`,
    });
  } finally {
    gate.resolve();
    client.dispose();
  }
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
  const { webLinkSelection } = await import("./web-links.js");
  const client = new MockHostClient();
  const show = vi.fn();
  const ack = vi.fn(async () => undefined);
  let view = { revision: 0, changedAt: 0 };
  const selection = webLinkSelection(() => view);
  const select = selection(show)(undefined);
  let resolve: ((value: Awaited<ReturnType<typeof client.openBrowserTab>>) => void) | undefined;
  vi.spyOn(client, "beginBrowserTabOpen").mockImplementation(() => ({
    idempotencyKey: `desktop-web-link:${link.id}`,
    result: new Promise((done) => {
      resolve = done;
    }),
  }));
  const opening = openDesktopWebLink(link, client, { kind: "guest" }, select, ack);
  view = { revision: 1, changedAt: 50 };
  resolve!({ sessionId: "session", tabId: "tab" } as Awaited<
    ReturnType<typeof client.openBrowserTab>
  >);
  await opening;
  expect(show).toHaveBeenCalledExactlyOnceWith({
    kind: "pending-browser",
    idempotencyKey: `desktop-web-link:${link.id}`,
  });
  expect(ack).toHaveBeenCalledWith(link.id);
  const later = selection(show)(60);
  later({ kind: "browser", sessionId: "session", tabId: "tab" });
  expect(show).toHaveBeenCalledTimes(2);
  client.dispose();
});
it("keeps links waiting behind one in the background after the person leaves during its open", async () => {
  const { webLinkSelection } = await import("./web-links.js");
  const show = vi.fn();
  let view = { revision: 0, changedAt: 0 };
  const selection = webLinkSelection(() => view);
  const tab = (tabId: string) => ({ kind: "browser" as const, sessionId: "session", tabId });
  // Both links arrived at 10 and 11; main delivers the second after the first's acknowledgement.
  const first = selection(show)(10);
  view = { revision: 1, changedAt: 20 };
  first(tab("first"));
  const second = selection(show)(11);
  second(tab("second"));
  expect(show).not.toHaveBeenCalled();
  const arrivedAfterLeaving = selection(show)(30);
  arrivedAfterLeaving(tab("third"));
  expect(show).toHaveBeenCalledExactlyOnceWith(tab("third"));
});
it("selects each waiting link in turn when the person stays", async () => {
  const { webLinkSelection } = await import("./web-links.js");
  let view = { revision: 0, changedAt: 0 };
  const shown: unknown[] = [];
  const show = (destination: unknown) => {
    shown.push(destination);
    // Selecting the tab is a navigation of its own, seen before the next delivery starts.
    view = { revision: view.revision + 1, changedAt: view.changedAt + 5 };
  };
  const selection = webLinkSelection(() => view);
  const tab = (tabId: string) => ({ kind: "browser" as const, sessionId: "session", tabId });
  for (const tabId of ["first", "second"]) selection(show)(1)(tab(tabId));
  expect(shown).toEqual([tab("first"), tab("second")]);
});

it("selects a pending external link in the input turn before dispatch resolves", async () => {
  const client = new MockHostClient({ latencyMs: 0 });
  const gate = Promise.withResolvers<void>();
  const dispatch = client.rpc["commands.dispatch"];
  const delayed: typeof dispatch = async (command, options) => {
    if (command.type === "browser.tab.open")
      await withTimeout(gate.promise, 2_000, {
        timeoutError: () => new Error("The delayed browser command was never released."),
      });
    return dispatch(command, options);
  };
  Object.defineProperty(client, "rpc", {
    value: new Proxy(client.rpc, {
      get: (target, name) => (name === "commands.dispatch" ? delayed : Reflect.get(target, name)),
    }),
  });
  const show = vi.fn();
  const ack = vi.fn(async () => undefined);
  const profile = client.getSnapshot().browserProfiles[0]!;
  const opening = openDesktopWebLink(
    link,
    client,
    { kind: "profile", profileId: profile.id },
    show,
    ack,
  );
  expect(show).toHaveBeenCalledExactlyOnceWith({
    kind: "pending-browser",
    idempotencyKey: `desktop-web-link:${link.id}`,
  });
  expect(ack).not.toHaveBeenCalled();
  gate.resolve();
  await opening;
  expect(ack).toHaveBeenCalledWith(link.id);
  client.dispose();
});

it("follows its own pending selection and keeps queued links behind a later user choice", async () => {
  const { webLinkSelection } = await import("./web-links.js");
  type Destination = Parameters<Parameters<typeof openDesktopWebLink>[3]>[0];
  const shown: Destination[] = [];
  let view = { revision: 0, changedAt: 0, pendingBrowserTab: null as string | null };
  const show = (destination: Destination) => {
    shown.push(destination);
    view = {
      revision: view.revision + 1,
      changedAt: view.changedAt + 1,
      pendingBrowserTab: destination.kind === "pending-browser" ? destination.idempotencyKey : null,
    };
  };
  const selection = webLinkSelection(() => view);
  const pending = (idempotencyKey: string) => ({
    kind: "pending-browser" as const,
    idempotencyKey,
  });
  const tab = (tabId: string) => ({ kind: "browser" as const, sessionId: "session", tabId });
  const first = selection(show)(10);
  first(pending("first"));
  first(tab("first"));
  expect(shown).toEqual([pending("first"), tab("first")]);
  const second = selection(show)(11);
  second(pending("second"));
  view = { revision: view.revision + 1, changedAt: 20, pendingBrowserTab: null };
  second(tab("second"));
  selection(show)(12)(pending("waiting"));
  expect(shown).toEqual([pending("first"), tab("first"), pending("second")]);
  selection(show)(30)(pending("later"));
  expect(shown.at(-1)).toEqual(pending("later"));
});
