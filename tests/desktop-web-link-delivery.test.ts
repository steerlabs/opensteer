import { TabCommandSchema } from "../packages/protocol/src/tabs.js";
import { expect, it, vi } from "vitest";
import { DesktopWebLinks } from "../apps/desktop/src/app/web-links.js";
import { WebLinkDeliveryOwner } from "../apps/desktop/src/bridge/methods/web-links.js";
import { openDesktopWebLink, receiveDesktopWebLinks } from "../apps/web/src/desktop/web-links.js";
import type { BrowserIdentityOpenInput } from "../packages/client/src/host/index.js";

import { createId } from "../packages/core/src/index.js";
import {
  DesktopWebLinkDeliverySchema,
  type DesktopWebLink,
  type DesktopWebLinkDelivery,
  type DesktopPersonalTabCommand,
  type OpensteerDesktopBridge,
} from "../packages/protocol/src/desktop.js";

// Desktop main's link queue and delivery owner feeding the renderer's receiver;
// it lives here because the web image type-checks apps/web without desktop sources.
async function deliveryFixture() {
  const client = {
    getSnapshot: () => ({
      deploymentId: createId("deployment"),
      user: { id: createId("user") },
      machines: [
        {
          id: "dev_88888888-8888-4888-8888-888888888888",
          selfRunnerId: "rnr_88888888-8888-4888-8888-888888888888",
        },
      ],
    }),
    dispatch: async (
      _input: import("../packages/protocol/src/host-api.js").HostApiCommandInput,
    ): Promise<import("../packages/protocol/src/host-api.js").HostApiCommandOutput> => {
      throw new Error("Unconfigured dispatch");
    },
    dispose: () => {},
  };
  const snapshot = client.getSnapshot();
  const scope = {
    deploymentId: DesktopWebLinkDeliverySchema.shape.deploymentId.parse(snapshot.deploymentId),
    userId: snapshot.user!.id,
    // This Mac lends a browser to another Mac's Opensteer: Guest opens here.
    target: (): BrowserIdentityOpenInput => ({
      identity: { kind: "guest" },
      placement: { kind: "runner", runnerId: "rnr_88888888-8888-4888-8888-888888888888" },
    }),
  };
  let listener: ((link: DesktopPersonalTabCommand) => void) | undefined;
  const sender = {
    send: (_channel: string, value: DesktopPersonalTabCommand) => listener?.(value),
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
    onPersonalTabCommand: (receive: typeof listener) => {
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
  const inputs: Array<
    import("../packages/protocol/src/tabs.js").TabCommand & { type: "tab.open" }
  > = [];
  const opened = vi.spyOn(client, "dispatch").mockImplementation(async (input) => {
    if (input.type !== "tab.open") throw new Error("Expected tab.open");
    const parsed = TabCommandSchema.parse(input);
    if (parsed.type !== "tab.open") throw new Error("Expected tab.open");
    inputs.push(parsed);
    const key = input.idempotencyKey,
      command = JSON.stringify(input);
    const previous = commands.get(key);
    if (previous && previous !== command) throw new Error("Idempotency key already used");
    commands.set(key, command);
    if (fail) {
      fail = false;
      throw new Error("Response lost");
    }
    return { type: "tab.open", tab: { tabId: key } } as Awaited<ReturnType<typeof client.dispatch>>;
  });
  const start = () => (bound: DesktopWebLink, ack: (id: string) => Promise<void>) =>
    openDesktopWebLink(
      bound,
      client as unknown as import("../packages/client/src/host/index.js").HostClient,
      bound.request!,
      show,
      ack,
    );
  const connect = () => receiveDesktopWebLinks(bridge, scope, start, errors);
  links.accept("https://example.com/first");
  links.accept("https://example.com/next");
  const stop = connect();
  await vi.waitFor(() => expect(errors).toHaveBeenCalledOnce());
  return {
    scope,
    inputs,
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
    expect(fixture.show).not.toHaveBeenCalled();
    expect(fixture.errors.mock.calls[0]![1].retry).toBeTypeOf("function");
    await fixture.errors.mock.calls[0]![1].retry();
    await vi.waitFor(() => expect(fixture.opened).toHaveBeenCalledTimes(3));
    expect(fixture.opened.mock.calls[1]).toEqual(fixture.opened.mock.calls[0]);
    expect(fixture.inputs[2]!.target).toMatchObject({ url: "https://example.com/next" });
    expect(fixture.show).toHaveBeenCalledWith({
      kind: "tab",
      tabId: fixture.inputs[2]!.idempotencyKey,
    });
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
    expect(fixture.inputs[1]!.target).toMatchObject({ url: "https://example.com/next" });
    expect(fixture.show).toHaveBeenCalledWith({
      kind: "tab",
      tabId: fixture.inputs[1]!.idempotencyKey,
    });
  } finally {
    fixture.stop();
    fixture.cleanup();
  }
});
it("replays the bound request after a renderer reload even when the remembered profile or this Mac's browser changes", async () => {
  const fixture = await deliveryFixture();
  try {
    expect(fixture.opened.mock.calls[0]![0]).toMatchObject({
      type: "tab.open",
      target: { kind: "page", guest: true, computerId: "dev_88888888-8888-4888-8888-888888888888" },
    });
    fixture.stop();
    fixture.scope.target = () => ({
      identity: { kind: "profile", profileId: createId("browserProfile") },
    });
    const stop = fixture.connect();
    await vi.waitFor(() => expect(fixture.opened).toHaveBeenCalledTimes(3));
    expect(fixture.opened.mock.calls[1]).toEqual(fixture.opened.mock.calls[0]);
    expect(fixture.errors).toHaveBeenCalledOnce();
    stop();
  } finally {
    fixture.cleanup();
  }
});
