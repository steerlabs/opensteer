// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ComputerScreen } from "./computer.js";

const state = vi.hoisted(() => ({
  dispatch: vi.fn(),
  cancelAutoWake: vi.fn(),
  focused: true,
  open: vi.fn(async () => ({ viewId: "phone-view", generation: 2 })),
  snapshot: {
    machines: [
      {
        id: "phone",
        name: "My phone",
        status: "online",
        platform: "android",
        computerUse: { state: "ready", sessions: [] },
      },
    ],
    machineRevision: 1,
  },
}));
const host = {
  getSnapshot: () => state.snapshot,
  listApprovedComputerApps: async () => [
    { machineId: "phone", target: { kind: "phone", display: "main" } },
  ],
  openComputerView: state.open,
};
vi.mock("@opensteer/client/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@opensteer/client/host")>()),
  canRespondToRequests: () => true,
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios", Version: "27" },
  StyleSheet: { create: (v: unknown) => v },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ActivityIndicator: () => null,
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ dispatch: state.dispatch, setOptions: vi.fn(), isFocused: () => state.focused }),
  StackActions: { push: (name: string, params: unknown) => ({ name, params }) },
}));
vi.mock("@opensteer/client/react", () => ({
  useHostSelector: (_: unknown, select: (snapshot: unknown) => unknown) => select(state.snapshot),
}));
vi.mock("@opensteer/client/integrations", () => ({
  isIphone: () => false,
  computerUseView: () => null,
  phoneUseView: () => ({ access: "read-write", state: { kind: "ready" } }),
  sharedDisplayStreams: () => ({ cancelAutoWake: state.cancelAutoWake }),
}));
vi.mock("@opensteer/client/computers", () => ({
  computerRole: () => null,
  computerRoleLabel: {},
  computerStatus: () => ({ label: "Online" }),
  computerUses: () => [],
  computerUsesPhrase: () => "",
  computerUsesChosenElsewhere: () => "",
}));
vi.mock("../ui/mobile-client-context.js", () => ({
  useMobileClient: () => ({}),
  useMobileState: () => ({
    rows: [{ deploymentId: "deployment", signIn: null }],
    selection: { deploymentId: "deployment", hostClient: host },
  }),
}));
vi.mock("../computers/use-computer-use-data.js", () => ({
  useComputerUseData: () => ({ data: {}, reload: vi.fn() }),
}));
vi.mock("../computers/computer-use-block.js", () => ({
  PhoneUseBlock: () => null,
  ComputerUseBlock: () => null,
}));
vi.mock("../iphone-apps/context.js", () => ({
  useIphoneApps: () => null,
  useIphoneAppsState: () => ({ snapshot: { enrollment: null } }),
}));
vi.mock("../iphone-apps/iphone-apps-block.js", () => ({ IphoneAppsBlock: () => null }));
vi.mock("../iphone-apps/remote-iphone-apps-block.js", () => ({
  RemoteIphoneAppsBlock: () => null,
}));
vi.mock("../ui/primitives.js", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Notice: () => null,
  StatusDot: () => null,
  SecondaryButton: ({ label, onPress }: { label: string; onPress(): void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
vi.mock("../ui/screen.js", () => ({
  Screen: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useListContentInsets: () => ({}),
  useReadingColumn: () => ({}),
}));
vi.mock("../client/mobile-client.js", () => ({ operationDetail: () => "Failed" }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it("opens the approved phone as an independent workspace owner view", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ComputerScreen route={{ params: { deploymentId: "deployment", machineId: "phone" } }} />,
      ),
    );
    const button = container.querySelector("button");
    expect(button?.textContent).toBe("Open phone");
    await act(async () => button!.click());
    expect(state.open).toHaveBeenCalledWith("phone", { kind: "phone", display: "main" });
    expect(state.dispatch).toHaveBeenCalledWith({
      name: "WorkspaceBrowser",
      params: {
        deploymentId: "deployment",
        scope: "workspace",
        phone: true,
        machineId: "phone",
        viewId: "phone-view",
        generation: 2,
      },
    });
  } finally {
    await act(async () => root.unmount());
  }
});

it("cancels the Open wake when the person leaves before the phone opens", async () => {
  state.dispatch.mockClear();
  state.open.mockImplementationOnce(async () => {
    state.focused = false;
    return { viewId: "phone-view", generation: 3 };
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ComputerScreen route={{ params: { deploymentId: "deployment", machineId: "phone" } }} />,
      ),
    );
    await act(async () => container.querySelector("button")!.click());
    expect(state.dispatch).not.toHaveBeenCalled();
    expect(state.cancelAutoWake).toHaveBeenCalledWith({
      kind: "owner-view",
      viewId: "phone-view",
      generation: 3,
    });
  } finally {
    state.focused = true;
    await act(async () => root.unmount());
  }
});
