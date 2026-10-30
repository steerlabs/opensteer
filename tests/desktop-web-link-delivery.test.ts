import { expect, it, vi } from "vitest";
import { DesktopWebLinks } from "../apps/desktop/src/app/web-links.js";
import { WebLinkDeliveryOwner } from "../apps/desktop/src/bridge/methods/web-links.js";
import { openDesktopWebLink, receiveDesktopWebLinks } from "../apps/web/src/desktop/web-links.js";
import type { BrowserIdentityChoice } from "../packages/client/src/host/index.js";
import { MockHostClient } from "../packages/client/src/mock/index.js";
import { createId } from "../packages/core/src/index.js";
import {
  DesktopWebLinkDeliverySchema,
  type DesktopWebLink,
  type DesktopWebLinkDelivery,
  type DesktopWorkspaceTabCommand,
  type OpensteerDesktopBridge,
} from "../packages/protocol/src/desktop.js";

// Desktop main's link queue and delivery owner feeding the renderer's receiver;
// it lives here because the web image type-checks apps/web without desktop sources.
async function deliveryFixture() {
  const client = new MockHostClient();
  const snapshot = client.getSnapshot();
  const scope = {
    deploymentId: DesktopWebLinkDeliverySchema.shape.deploymentId.parse(snapshot.deploymentId),
    userId: snapshot.user!.id,
    identity: (): BrowserIdentityChoice => ({ kind: "guest" }),
  };
  let listener: ((link: DesktopWorkspaceTabCommand) => void) | undefined;
  const sender = {
    send: (_channel: string, value: DesktopWorkspaceTabCommand) => listener?.(value),
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
    webLinkDelivery: async (input: DesktopWebLinkDelivery) => owner.handle(sender, input),
  } as unknown as OpensteerDesktopBridge;
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
  const start = () => (bound: DesktopWebLink, ack: (id: string) => Promise<void>) =>
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
