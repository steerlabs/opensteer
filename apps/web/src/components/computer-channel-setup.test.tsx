// @vitest-environment happy-dom
import { channelProviderCatalog, type ChannelProviderManifest } from "@opensteer/channel-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ComputerChannelSetup } from "./computer-channel-setup.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.replaceChildren();
});

it("asks only for the Mac, says what comes after, and names Devices", async () => {
  const provider: ChannelProviderManifest = channelProviderCatalog.find(
    ({ provider }) => provider === "imessage",
  )!;
  const mac = {
    id: "rnr_00000000-0000-4000-8000-0000000000aa",
    name: "Studio Mac",
    status: "online",
    modules: { messaging: {} },
    apps: [{ definitionId: provider.computerApp }],
  };
  const dispatch = vi.fn(async () => ({ type: "channel.connection.computer.create" }) as never);
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <ComputerChannelSetup
        hostClient={{ dispatch } as never}
        machines={[mac] as never}
        onCancel={() => undefined}
        onCreated={() => undefined}
        provider={provider}
      />,
    ),
  );
  const text = container.textContent ?? "";
  expect(container.querySelector("textarea")).toBeNull();
  expect(text).not.toMatch(/approval|Computers page/u);
  expect(text).toContain("on its Devices page with reading and sending");
  expect(text).toContain("link your own iMessage account with a code, then add a chat");
  const connect = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.startsWith("Connect"),
  )!;
  expect(connect.disabled).toBe(false);
  await act(async () => connect.click());
  expect(dispatch).toHaveBeenCalledWith(
    expect.objectContaining({ type: "channel.connection.computer.create", runnerId: mac.id }),
  );
});
