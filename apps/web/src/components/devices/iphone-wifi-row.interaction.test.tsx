// @vitest-environment happy-dom
import { createId } from "@opensteer/core";
import type { IphoneSetupPort } from "@opensteer/client/host";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { IphoneWifiRow } from "./iphone-wifi-row.js";

it("finishes a Wi-Fi mutation when a newer status read overtakes it", async () => {
  const change = Promise.withResolvers<Awaited<ReturnType<IphoneSetupPort["configureWifi"]>>>();
  const port = {
    wifiStatus: vi.fn(async () => ({ enabled: false, transport: "usb", reason: null })),
    configureWifi: vi.fn(() => change.promise),
  } as unknown as IphoneSetupPort;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const props = {
    deploymentId: createId("deployment"),
    deviceId: createId("device"),
    deploymentName: "Home",
    macName: "Mac",
    port,
  };
  try {
    await act(async () => root.render(<IphoneWifiRow {...props} revision={1} />));
    const toggle = container.querySelector<HTMLInputElement>("input")!;
    await act(async () => toggle.click());
    expect(toggle.disabled).toBe(true);
    await act(async () => root.render(<IphoneWifiRow {...props} revision={2} />));
    await act(async () => change.resolve({ enabled: true, transport: "usb", reason: null }));
    expect(toggle.disabled).toBe(false);
    expect(toggle.checked).toBe(false);
    expect(container.textContent).not.toContain("Turning on");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
