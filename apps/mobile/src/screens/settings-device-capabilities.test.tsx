// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import { reactNative, primitives } from "../../test-support/settings-screens.js";
vi.mock("react-native", () => ({ ...reactNative, TextInput: () => null }));
vi.mock("../ui/primitives.js", () => ({
  ...primitives,
  SwitchRow: ({
    label,
    value,
    onChange,
  }: {
    label: string;
    value: boolean;
    onChange: (value: boolean) => void;
  }) => (
    <label>
      {label}
      <input type="checkbox" checked={value} onChange={(event) => onChange(event.target.checked)} />
    </label>
  ),
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: vi.fn() }) }));
vi.mock("./use-settings-read.js", () => ({ useSettingsLease: () => () => true }));
const { SettingsDeviceCapabilities } = await import("./settings-device-capabilities.js");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it("keeps Main nonremovable and fences Terminal changes with the read policy revision", async () => {
  const host = new MockHostClient({ latencyMs: 0 });
  await host.load();
  const machine = {
    ...host.getSnapshot().machines[0]!,
    revocable: false,
    access: {
      ownerReachAvailable: true,
      revision: 9,
      activeSessions: [],
      policy: { commands: false, forwarding: false, reach: "nobody" as const, shares: [] },
    },
  };
  const dispatch = vi.spyOn(host, "dispatch").mockRejectedValue(new Error("Keep state"));
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <SettingsDeviceCapabilities host={host} machine={machine} deploymentId="deployment" />,
      ),
    );
    expect(container.textContent).not.toContain("Remove device");
    const terminal = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(terminal).not.toBeNull();
    await act(async () => terminal.click());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "machine.access.update",
        expectedRevision: 9,
        policy: expect.objectContaining({ commands: true }),
      }),
    );
  } finally {
    act(() => root.unmount());
    host.dispose();
  }
});
