// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ reset: vi.fn() }));

vi.mock("react-native", () => ({
  Platform: { OS: "ios", Version: "26", select: (options: { ios?: unknown }) => options.ios },
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  StyleSheet: { create: (styles: object) => styles, hairlineWidth: 1 },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ canGoBack: () => false, goBack: vi.fn(), navigate: vi.fn() }),
}));
vi.mock("../navigation-ref.js", () => ({ resetToDeployments: navigation.reset }));
vi.mock("../ui/mobile-client-context.js", () => ({
  useMobileClient: () => ({}),
  useMobileState: () => ({ rows: [], selection: { deploymentId: null, hostClient: null } }),
}));
vi.mock("../ui/shell-gate.js", () => ({ useShellGate: () => undefined }));
vi.mock("../ui/pane.js", () => ({
  useContentInsets: () => ({ bottom: 0, left: 0, right: 0, top: 0 }),
}));
vi.mock("../ui/screen.js", () => ({
  Screen: ({ children }: { children?: ReactNode }) => <main>{children}</main>,
  useReadingColumn: () => ({}),
}));
vi.mock("../ui/primitives.js", () => ({
  DisplayTitle: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  AppText: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  PrimaryButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
  RowGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SecondaryButton: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
vi.mock("../ui/connection-gate.js", () => ({ ConnectionGate: () => null }));
vi.mock("../ui/route-gate.js", () => ({ ConnectionRouteGate: () => null }));
vi.mock("./gate-asleep-line.js", () => ({ GateAsleepLine: () => null }));
vi.mock("../iphone-apps/context.js", () => ({ useOptionalIphoneApps: () => null }));
vi.mock("../phone-setup/removed-view.js", () => ({ RemovedView: () => null }));
vi.mock("./use-deployment-update.js", () => ({ useDeploymentUpdate: () => null }));
vi.mock("./deployment-update.js", () => ({ deploymentUpdateRows: () => [] }));

const { DeploymentGate } = await import("./deployment-gate.js");
const { deploymentsTitle } = await import("./deployments-title.js");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

/*
 * A Home a route names that is no longer in this phone's list: it is said in a person's words,
 * and the way back is named by the list's own title, wherever that title is set.
 */
describe("a Home that is no longer in this phone's list", () => {
  it("says so in a person's words and goes back to the list by its own title", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () =>
      root.render(<DeploymentGate deploymentId="dep_00000000-0000-4000-8000-0000000000ff" />),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("This Home is no longer here");
    expect(text).not.toMatch(/deployment/iu);
    const back = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === deploymentsTitle,
    );
    if (!back) throw new Error(`No way back to ${deploymentsTitle}: ${text}`);
    await act(async () => back.click());
    expect(navigation.reset).toHaveBeenCalledOnce();
  });
});
