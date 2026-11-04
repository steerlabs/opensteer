// @vitest-environment happy-dom
import { createUsageNoticeDismissals, type UsageNoticeDismissals } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * How the phone's Settings → AI → Background models could mislead or nag:
 * - a role claims a model runs it when none can, or hides that a provider waits on the person;
 * - Allow, Revoke or a pin sends nothing, or the page keeps showing the old state;
 * - "Not now" comes back after the app is relaunched.
 */

const state = vi.hoisted(() => ({
  host: null as unknown,
  notices: null as unknown,
}));
vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: object) => styles, hairlineWidth: 1 },
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../theme.js", () => ({ color: {}, radius: {}, space: {}, touchTarget: 44 }));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("../ui/primitives.js", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  RowGroup: ({ children }: { children: readonly ReactNode[] }) => <div>{children}</div>,
  SecondaryButton: (props: { accessibilityLabel?: string; label: string; onPress: () => void }) => (
    <button aria-label={props.accessibilityLabel ?? props.label} onClick={props.onPress}>
      {props.label}
    </button>
  ),
  SectionLabel: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
}));
vi.mock("../thread/composer-menu.js", () => ({
  NativeMenu: (props: {
    accessibilityLabel: string;
    children: ReactNode;
    options: readonly { label: string; onPress: () => void; selected?: boolean }[];
  }) => (
    <div aria-label={props.accessibilityLabel} role="menu">
      {props.children}
      {props.options.map((option) => (
        <button
          aria-checked={option.selected === true}
          key={option.label}
          onClick={option.onPress}
          role="menuitemradio"
        >
          {option.label}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("../ui/mobile-client-context.js", () => {
  const mobile = {
    get backgroundNotices() {
      return state.notices;
    },
    getSnapshot: () => ({ selection: { hostClient: state.host } }),
  };
  return { useMobileClient: () => mobile };
});

const { AiSettingsForm } = await import("./settings-ai-form.js");
const { useBackgroundModelsForm } = await import("./settings-background-models.js");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
const hosts: MockHostClient[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const host of hosts.splice(0)) host.dispose();
  document.body.replaceChildren();
});

describe("Settings → AI → Background models on a phone", () => {
  it("asks about the provider next in line, then names what runs each role", async () => {
    const { host } = await open();
    expect(roles()).toEqual([
      "Task names and quick memory, Automatic. Waiting for you to allow a provider.",
      "Nightly memory, Automatic. Waiting for you to allow a provider.",
    ]);
    expect(document.body.textContent).toContain(
      "Let Anthropic name your tasks and run memory passes? It sees the first message of each new task (up to 2,000 characters) and your memory files during memory passes.",
    );
    await press(button("Allow"));
    await vi.waitFor(() =>
      expect(roles()).toEqual([
        "Task names and quick memory, Automatic (currently Claude Haiku 5.5 via Claude Code)",
        "Nightly memory, Automatic (currently Claude Opus 5.5 via Claude Code)",
      ]),
    );
    expect(document.body.textContent).not.toContain("Let Anthropic");
    await press(button("Allow OpenAI"));
    await vi.waitFor(() => expect(button("Revoke OpenAI")).not.toBeNull());
    await press(button("Revoke OpenAI"));
    await vi.waitFor(() => expect(button("Allow OpenAI")).not.toBeNull());
    expect((await host.rpc["backgroundModels.get"]({})).ok).toBe(true);
  });

  it("pins a model from the role's menu and goes back to automatic", async () => {
    await open();
    await press(button("Allow Anthropic"));
    await vi.waitFor(() => expect(menuItem("Nightly memory", "Claude Opus 5.5 · Claude Code")));
    await press(menuItem("Nightly memory", "Claude Opus 5.5 · Claude Code")!);
    await vi.waitFor(() =>
      expect(roles()[1]).toBe("Nightly memory, Claude Opus 5.5 via Claude Code"),
    );
    expect(
      menuItem("Nightly memory", "Claude Opus 5.5 · Claude Code")?.getAttribute("aria-checked"),
    ).toBe("true");
    await press(menuItem("Nightly memory", "Automatic")!);
    await vi.waitFor(() =>
      expect(roles()[1]).toBe(
        "Nightly memory, Automatic (currently Claude Opus 5.5 via Claude Code)",
      ),
    );
  });

  it("says so plainly when no model can run background work", async () => {
    await open({ backgroundModels: "none" });
    expect(roles()).toEqual([
      "Task names and quick memory, Automatic. No model can run this right now.",
      "Nightly memory, Automatic. No model can run this right now.",
    ]);
    expect(document.body.textContent).not.toContain("Providers for background work");
  });

  it("remembers Not now across a relaunch", async () => {
    let saved: readonly string[] = [];
    const storage = { read: () => saved, write: (keys: readonly string[]) => void (saved = keys) };
    await open({}, createUsageNoticeDismissals(storage));
    await press(button("Not now"));
    expect(document.body.textContent).not.toContain("Let Anthropic");
    expect(saved.some((key) => key.endsWith("\nanthropic"))).toBe(true);
    for (const root of roots.splice(0)) act(() => root.unmount());
    await open({}, createUsageNoticeDismissals(storage));
    expect(document.body.textContent).not.toContain("Let Anthropic");
    expect(button("Allow Anthropic")).not.toBeNull();
  });
});

function Harness({ host }: { readonly host: MockHostClient }): ReactNode {
  return <AiSettingsForm background={useBackgroundModelsForm(host)} page="ai" />;
}
async function open(
  options: { readonly backgroundModels?: "none" } = {},
  notices: UsageNoticeDismissals = createUsageNoticeDismissals({ read: () => [], write: () => {} }),
) {
  const host = new MockHostClient({ latencyMs: 0, ...options });
  hosts.push(host);
  await host.load();
  state.host = host;
  state.notices = notices;
  document.body.replaceChildren();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<Harness host={host} />));
  await vi.waitFor(() => expect(document.body.textContent).not.toContain("Loading…"));
  return { host };
}
function roles(): readonly (string | null)[] {
  return [...document.querySelectorAll('[role="menu"]')].map((menu) =>
    menu.getAttribute("aria-label"),
  );
}
function button(label: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`button[aria-label="${CSS.escape(label)}"]`);
}
function menuItem(role: string, label: string): HTMLButtonElement | undefined {
  const menu = [...document.querySelectorAll('[role="menu"]')].find((item) =>
    item.getAttribute("aria-label")?.startsWith(`${role},`),
  );
  return [...(menu?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (item) => item.textContent === label,
  );
}
async function press(target: HTMLElement | null) {
  if (!target) throw new Error("Nothing to press");
  await act(async () => target.click());
}
