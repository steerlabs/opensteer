import { DesktopWebLinkDeliverySchema } from "@opensteer/protocol/desktop";
import { DesktopWebLinks } from "../../../desktop/src/app/web-links.js";
import { WebLinkDeliveryOwner } from "../../../desktop/src/bridge/methods/web-links.js";
import { receiveDesktopWebLinks } from "./web-links.js";
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

async function deliveryFixture() {
  const client = new MockHostClient();
  const snapshot = client.getSnapshot();
  const scope = {
    deploymentId: DesktopWebLinkDeliverySchema.shape.deploymentId.parse(snapshot.deploymentId),
    userId: snapshot.user!.id,
    identity: (): import("@opensteer/client/host").BrowserIdentityChoice => ({ kind: "guest" }),
  };
  let listener:
    ((link: import("@opensteer/protocol/desktop").DesktopWorkspaceTabCommand) => void) | undefined;
  const sender = {
    send: (
      _channel: string,
      value: import("@opensteer/protocol/desktop").DesktopWorkspaceTabCommand,
    ) => listener?.(value),
    once: vi.fn(),
    removeListener: vi.fn(),
    isDestroyed: () => false,
  };
  const links = new DesktopWebLinks(vi.fn());
  const owner = new WebLinkDeliveryOwner(
    links,
    (candidate) => candidate === sender,
    () => true,
  );
  const bridge = {
    onWorkspaceTabCommand: (receive: typeof listener) => {
      listener = receive;
      return () => {
        listener = undefined;
      };
    },
    webLinkDelivery: async (input: import("@opensteer/protocol/desktop").DesktopWebLinkDelivery) =>
      owner.handle(sender, input),
  } as unknown as import("@opensteer/protocol/desktop").OpensteerDesktopBridge;
  const errors = vi.fn();
  const show = vi.fn();
  const commands = new Map<string, string>();
  let fail = true;
  const opened = vi.spyOn(client, "openBrowserTab").mockImplementation(async (target, options) => {
    const key = options!.idempotencyKey!;
    const command = JSON.stringify({ target, url: options!.url });
    const previous = commands.get(key);
    if (previous && previous !== command) throw new Error("Idempotency key already used");
    commands.set(key, command);
    if (fail) {
      fail = false;
      throw new Error("Response lost");
    }
    return { sessionId: "session", tabId: key } as Awaited<
      ReturnType<typeof client.openBrowserTab>
    >;
  });
  const start =
    () =>
    (
      bound: import("@opensteer/protocol/desktop").DesktopWebLink,
      ack: (id: string) => Promise<void>,
    ) =>
      openDesktopWebLink(bound, client, bound.request!.identity, show, ack);
  const connect = () => receiveDesktopWebLinks(bridge, scope, start, errors);
  links.accept("https://example.com/first");
  links.accept("https://example.com/next");
  const stop = connect();
  await vi.waitFor(() => expect(errors).toHaveBeenCalledOnce());
  return {
    scope,
    errors,
    opened,
    connect,
    stop,
    show,
    cleanup: () => {
      owner.dispose();
      links.dispose();
      client.dispose();
    },
  };
}
it("exposes Retry after failure, reuses the exact request and then delivers the next link", async () => {
  const fixture = await deliveryFixture();
  try {
    expect(fixture.opened).toHaveBeenCalledTimes(1);
    expect(fixture.errors.mock.calls[0]![1].retry).toBeTypeOf("function");
    await fixture.errors.mock.calls[0]![1].retry();
    await vi.waitFor(() => expect(fixture.opened).toHaveBeenCalledTimes(3));
    expect(fixture.opened.mock.calls[1]).toEqual(fixture.opened.mock.calls[0]);
    expect(fixture.opened.mock.calls[2]![1]!.url).toBe("https://example.com/next");
  } finally {
    fixture.stop();
    fixture.cleanup();
  }
});
it("Dismiss drops only the failed link and delivers its successor", async () => {
  const fixture = await deliveryFixture();
  try {
    await fixture.errors.mock.calls[0]![1].dismiss();
    await vi.waitFor(() => expect(fixture.opened).toHaveBeenCalledTimes(2));
    expect(fixture.opened.mock.calls[1]![1]!.url).toBe("https://example.com/next");
  } finally {
    fixture.stop();
    fixture.cleanup();
  }
});
it("replays the bound request after a renderer reload even when the remembered profile changes", async () => {
  const fixture = await deliveryFixture();
  try {
    fixture.stop();
    const { createId } = await import("@opensteer/core");
    fixture.scope.identity = () => ({ kind: "profile", profileId: createId("browserProfile") });
    const stop = fixture.connect();
    await vi.waitFor(() => expect(fixture.opened).toHaveBeenCalledTimes(3));
    expect(fixture.opened.mock.calls[1]).toEqual(fixture.opened.mock.calls[0]);
    expect(fixture.errors).toHaveBeenCalledOnce();
    stop();
  } finally {
    fixture.cleanup();
  }
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
