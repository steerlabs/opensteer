// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import { unwrapRpcResult } from "@opensteer/client/host";
import type { PluginTarget } from "@opensteer/protocol";
import type { NativeSettingsPageProps } from "./native-settings-page.types.js";

const state = vi.hoisted(() => ({ host: null as MockHostClient | null }));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: vi.fn() }) }));
vi.mock("./deployment-gate.js", () => ({
  useAttachedHost: () => state.host,
  DeploymentGate: () => null,
}));
vi.mock("../ui/mobile-client-context.js", () => {
  const mobile = { getSnapshot: () => ({ selection: { hostClient: state.host } }) };
  return { useMobileClient: () => mobile };
});
vi.mock("../ui/ai-sharing.js", () => ({
  useAiSharing: () => ({}),
  authorizeAiSharing: async () => true,
}));
vi.mock("./leave-sheets.js", () => ({ useLeaveSheets: () => ({ openNewTask: vi.fn() }) }));
vi.mock("../ui/sheet.js", () => ({
  Sheet: ({ children, open }: { children: ReactNode; open: boolean }) => (open ? children : null),
}));
vi.mock("./settings-plugin-accounts.js", () => ({ PluginAccounts: () => null }));
vi.mock("./native-settings-page.js", () => ({
  NativeSettingsPage: ({ sections, sheet }: NativeSettingsPageProps) => (
    <section data-sheet={sheet?.title ?? "page"}>
      {sections.map((section) => (
        <section key={section.key} data-section={section.key}>
          {section.rows.map((row) => (
            <div key={row.key} data-row={row.key}>
              {row.kind === "button" ? (
                <button disabled={row.disabled} onClick={row.onPress}>
                  {row.label}
                </button>
              ) : row.kind === "toggle" ? (
                <label>
                  {row.label}
                  <input
                    type="checkbox"
                    checked={row.value}
                    onChange={(event) => row.onChange(event.target.checked)}
                  />
                </label>
              ) : (
                row.label
              )}
            </div>
          ))}
        </section>
      ))}
    </section>
  ),
}));
const { SettingsPluginsScreen } = await import("./settings-plugins.js");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  state.host?.dispose();
  state.host = null;
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it.each([true, false])(
  "uses project consent, not ownership, for every mobile placement surface: %s",
  async (ownerWide) => {
    const host = new MockHostClient({ latencyMs: 0 });
    state.host = host;
    await host.load();
    const snapshot = host.getSnapshot();
    vi.spyOn(host, "getSnapshot").mockReturnValue({
      ...snapshot,
      deploymentPolicy: {
        ...snapshot.deploymentPolicy,
        ownership: ownerWide ? "members" : "single-user",
        projectConsent: ownerWide ? "owner-wide" : "per-project",
      },
    });
    const initialOverview = unwrapRpcResult(await host.rpc["plugins.overview.get"]({}));
    const overview = {
      ...initialOverview,
      rows: initialOverview.rows.map((entry) => ({
        ...entry,
        placement: { ...entry.placement, personalEverywhere: true },
      })),
    };
    const row = overview.rows.find((entry) => entry.title === "Gmail")!;
    expect(row).toBeDefined();
    const original = host.rpc;
    Object.defineProperty(host, "rpc", {
      value: new Proxy(original, {
        get: (target, key) =>
          key === "plugins.overview.get"
            ? async () => ({ ok: true, data: overview })
            : Reflect.get(target, key),
      }),
    });
    root = createRoot(document.body.appendChild(document.createElement("div")));
    const render = async (target?: PluginTarget) => {
      await act(async () =>
        root!.render(
          <SettingsPluginsScreen
            key={target ? JSON.stringify(target) : "overview"}
            route={{
              params: { deploymentId: snapshot.deploymentId!, ...(target ? { target } : {}) },
            }}
          />,
        ),
      );
    };
    await render();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Gmail"));
    expect(document.body.textContent?.includes("Everywhere")).toBe(ownerWide);
    await render(row.target);
    await vi.waitFor(() =>
      expect(document.querySelector('[data-section="places"]')).not.toBeNull(),
    );
    expect(document.querySelector('[data-row="everywhere"]') !== null).toBe(ownerWide);
    await render();
    const addButton = () =>
      document.querySelector<HTMLButtonElement>('[data-row^="product:"] button');
    await vi.waitFor(() => expect(addButton()).not.toBeNull());
    await act(async () => addButton()!.click());
    await vi.waitFor(() =>
      expect(document.querySelector('[data-section="places"]')).not.toBeNull(),
    );
    const everywhere = document.querySelector<HTMLInputElement>(
      '[data-section="places"] [data-row="everywhere"] input',
    );
    expect(everywhere !== null).toBe(ownerWide);
    if (ownerWide) expect(everywhere?.checked).toBe(true);
  },
);
