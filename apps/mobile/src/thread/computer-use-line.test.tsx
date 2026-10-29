// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
vi.mock("@opensteer/client/react", () => ({ useComputerUseStop: () => null }));
vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: object) => styles },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: ({ children }: { children?: ReactNode }) => <div>{children}</div> },
}));
vi.mock("../ui/motion.js", () => ({ appear: undefined }));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("../ui/primitives.js", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  SecondaryButton: (props: { accessibilityLabel?: string; label: string; onPress: () => void }) => (
    <button aria-label={props.accessibilityLabel} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
const { ComputerUseLine, TranscriptComputersContext } = await import("./computer-use-line.js");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it("offers only phone Stop on the mobile activity line", () => {
  const client = new MockHostClient({ latencyMs: 0 });
  const machine = client.getSnapshot().machines.find((machine) => machine.device?.form === "phone");
  const session = machine?.computerUse?.sessions[0];
  if (!machine || !session) throw new Error("Expected phone session");
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        <TranscriptComputersContext.Provider
          value={{ hostClient: client, machines: [machine], kept: null }}
        >
          <ComputerUseLine
            now={{
              kind: "phone",
              action: "Tapping",
              place: `On ${machine.name}`,
              machine,
              session,
            }}
          />
        </TranscriptComputersContext.Provider>,
      ),
    );
    const button = container.querySelector<HTMLButtonElement>(
      `button[aria-label="Stop using phone, ${machine.name}"]`,
    );
    expect(button).not.toBeNull();
    expect(button?.textContent).toBe("Stop using phone");
    expect(container.textContent).not.toContain("Watch");
  } finally {
    act(() => root.unmount());
  }
});
