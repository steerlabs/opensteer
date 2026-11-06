// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddPersonalScreen } from "./add-personal.js";

const code = `osp_${"Ab3_-".repeat(8)}xyz`;
const origin = "https://studio-mac.tailnet.ts.net";
const deploymentId = "dep_0192f4a1-1111-4000-8000-000000000001";

const state = vi.hoisted(() => ({
  params: undefined as { code?: string | undefined; origin?: string | undefined } | undefined,
  navigation: {
    goBack: vi.fn(),
    navigate: vi.fn(),
    setParams: vi.fn(),
  },
  verify: vi.fn(),
  add: vi.fn(),
  reset: vi.fn(),
  client: {
    catalog: {},
    openDeployment: vi.fn().mockResolvedValue(undefined),
    reconcile: vi.fn().mockResolvedValue(undefined),
    sessionExchange: {},
    sessions: {},
  },
}));

vi.mock("@react-navigation/native", () => ({
  useNavigation: () => state.navigation,
  useRoute: () => ({ params: state.params }),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios", select: (input: { default?: unknown }) => input.default },
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) => (
    <button onClick={onPress}>{children}</button>
  ),
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  StyleSheet: { create: <T,>(value: T) => value, hairlineWidth: 1 },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ui/primitives.js", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Field: ({ label, input }: { label: string; input: { value?: string } }) => (
    <label>
      {label}
      <input readOnly value={input.value} />
    </label>
  ),
  Notice: ({ detail }: { detail: string }) => <span>{detail}</span>,
  PrimaryButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
  RowGroup: ({ children }: { children: readonly ReactNode[] }) => <div>{children}</div>,
}));
vi.mock("../ui/screen.js", () => ({
  Screen: ({ children }: { children?: ReactNode }) => <main>{children}</main>,
  useReadingColumn: () => ({}),
}));
vi.mock("../ui/mobile-client-context.js", () => ({ useMobileClient: () => state.client }));
vi.mock("./add-deployment.js", () => ({ DeploymentDoorSymbol: () => null }));
vi.mock("../navigation-ref.js", () => ({ resetToDeployment: state.reset }));
vi.mock("../client/mobile-client.js", () => ({
  operationDetail: (_error: unknown, fallback: string) => fallback,
}));
vi.mock("../client/add-deployment.js", () => ({
  addPersonalDeployment: state.add,
  defaultDeploymentName: () => "Personal computer",
  verifyPersonalDeployment: state.verify,
}));

afterEach(() => {
  state.params = undefined;
});

describe("pairing a computer from its code", () => {
  it("shows the address and pairs only after the person confirms", async () => {
    const verified = {
      discovery: { canonicalOrigin: origin, deploymentId },
      endpoint: { origin },
    };
    state.verify.mockResolvedValue(verified);
    state.add.mockResolvedValue(undefined);
    state.params = { code, origin };
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(<AddPersonalScreen />));

      expect(container.textContent).toContain("studio-mac.tailnet.ts.net");
      expect(container.textContent).not.toContain(code);
      // The code leaves the navigation state as soon as the form has it.
      expect(state.navigation.setParams).toHaveBeenCalledWith({
        code: undefined,
        origin: undefined,
      });
      // Nothing reaches the address, and nothing is redeemed, before Connect.
      expect(state.verify).not.toHaveBeenCalled();
      expect(state.add).not.toHaveBeenCalled();

      const connect = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Connect",
      );
      expect(connect, "Missing Connect").toBeDefined();
      await act(async () => connect!.click());

      expect(state.verify).toHaveBeenCalledWith(expect.objectContaining({ origin }));
      expect(state.add).toHaveBeenCalledWith(
        expect.objectContaining({ pairingCode: code, verified }),
      );
      expect(state.reset).toHaveBeenCalledWith(deploymentId);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
