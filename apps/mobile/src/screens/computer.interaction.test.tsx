// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ComputerScreen } from "./computer.js";

const phoneId = vi.hoisted(() => "rnr_00000000-0000-4000-8000-00000000000b");
const state = vi.hoisted(() => ({
  dispatch: vi.fn(),
  focused: true,
  openTab: vi.fn(async () => ({ tabId: "tab_phone" })),
  snapshot: {
    machines: [
      {
        id: phoneId,
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
  openTab: state.openTab,
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
  useNavigation: () => ({
    dispatch: state.dispatch,
    setOptions: vi.fn(),
    isFocused: () => state.focused,
  }),
  StackActions: { push: (name: string, params: unknown) => ({ name, params }) },
}));
vi.mock("@opensteer/client/react", () => ({
  useHostSelector: (_: unknown, select: (snapshot: unknown) => unknown) => select(state.snapshot),
}));
vi.mock("@opensteer/client/integrations", () => ({
  isIphone: () => false,
  computerUseView: () => null,
  phoneUseView: () => ({ access: "read-write", state: { kind: "ready" } }),
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
vi.mock("./settings-device-capabilities.js", () => ({ SettingsDeviceCapabilities: () => null }));
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
vi.mock("../computers/device-browser-row.js", () => ({ DeviceBrowserRow: () => null }));
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
vi.mock("../ui/sheet.js", () => ({ Sheet: () => null }));
vi.mock("../ui/screen.js", () => ({
  Screen: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useListContentInsets: () => ({}),
  useReadingColumn: () => ({}),
}));
vi.mock("../client/mobile-client.js", () => ({ operationDetail: () => "Failed" }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it("opens the phone's one tab and shows it by its tabId", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ComputerScreen route={{ params: { deploymentId: "deployment", machineId: phoneId } }} />,
      ),
    );
    const button = container.querySelector("button");
    expect(button?.textContent).toBe("Open phone");
    await act(async () => button!.click());
    expect(state.openTab).toHaveBeenCalledWith({ computerId: phoneId, kind: "phone" });
    expect(state.dispatch).toHaveBeenCalledWith({
      name: "WorkspaceBrowser",
      params: { deploymentId: "deployment", tabId: "tab_phone" },
    });
  } finally {
    await act(async () => root.unmount());
  }
});

it("shows nothing to a person who left before the phone's tab opened", async () => {
  state.dispatch.mockClear();
  state.openTab.mockImplementationOnce(async () => {
    state.focused = false;
    return { tabId: "tab_phone" };
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ComputerScreen route={{ params: { deploymentId: "deployment", machineId: phoneId } }} />,
      ),
    );
    await act(async () => container.querySelector("button")!.click());
    expect(state.dispatch).not.toHaveBeenCalled();
  } finally {
    state.focused = true;
    await act(async () => root.unmount());
  }
});
