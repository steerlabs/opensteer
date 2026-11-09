// @vitest-environment happy-dom
import { createUsageNoticeDismissals, type UsageNoticeDismissals } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  host: null as unknown,
  notices: null as unknown,
}));
vi.mock("react-native", () => ({
  Switch: (p: { accessibilityLabel: string; value: boolean; onValueChange: () => void }) => (
    <input
      aria-label={p.accessibilityLabel}
      type="checkbox"
      checked={p.value}
      onChange={p.onValueChange}
    />
  ),
  TextInput: (p: {
    accessibilityLabel: string;
    value: string;
    onChangeText: (s: string) => void;
  }) => (
    <textarea
      aria-label={p.accessibilityLabel}
      value={p.value}
      onChange={(e) => p.onChangeText(e.currentTarget.value)}
    />
  ),
  StyleSheet: { create: (styles: object) => styles, hairlineWidth: 1 },
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../theme.js", () => ({ color: {}, radius: {}, space: {}, touchTarget: 44 }));
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("../ui/choice-menu.js", () => ({ ChoiceMenu: () => null }));
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
    get usageNotices() {
      return state.notices;
    },
    getSnapshot: () => ({ selection: { hostClient: state.host } }),
  };
  return { useMobileClient: () => mobile };
});

const { AiSettingsForm } = await import("./settings-ai-form.js");
const { useAutomaticModelsForm } = await import("./settings-automatic-models.js");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
const hosts: MockHostClient[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const host of hosts.splice(0)) host.dispose();
  document.body.replaceChildren();
});

describe("Automatic models on a phone", () => {
  it("edits the ordered list and account eligibility", async () => {
    const { host } = await open();
    expect(document.body.textContent).toContain("General preference");
    await press(button("Move deep 1 down"));
    await vi.waitFor(async () => {
      const v = await host.rpc["automaticModels.get"]({});
      expect(v.ok && v.data.config.roles.deep?.[0]).toMatchObject({ model: "gpt-6.1-sol" });
    });
    await press(button("Remove deep 1"));
    await press(menuItem("Add Nightly memory", "OpenRouter")!);
    await vi.waitFor(async () => {
      const v = await host.rpc["automaticModels.get"]({});
      expect(v.ok && v.data.config.roles.deep?.some((e) => "harnessInstanceId" in e)).toBe(true);
    });
    const toggle = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await press(toggle);
    await vi.waitFor(() => expect(toggle.checked).toBe(false));
    await press(button("Reset deep to default"));
    await vi.waitFor(async () => {
      const v = await host.rpc["automaticModels.get"]({});
      expect(v.ok && v.data.config.roles.deep).toBeUndefined();
    });
  });
  it("round trips Advanced JSON and explains strict errors", async () => {
    const { host } = await open();
    await press(button("Advanced"));
    const textarea = document.querySelector<HTMLTextAreaElement>("textarea")!;
    const type = async (value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
          textarea,
          value,
        );
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
    await type('{"roles":{"deep":[]},"excludedAccounts":[]}');
    await press(button("Save JSON"));
    expect(document.body.textContent).toContain("Too small");
    await type(
      '{"roles":{"deep":[{"engine":"codex","model":"gpt-6.1-sol"}]},"excludedAccounts":[]}',
    );
    await press(button("Save JSON"));
    await vi.waitFor(async () => {
      const result = await host.rpc["automaticModels.get"]({});
      expect(result.ok && result.data.config.roles.deep).toHaveLength(1);
    });
    await vi.waitFor(() =>
      expect(JSON.parse(textarea.value)).toEqual({
        roles: { deep: [{ engine: "codex", model: "gpt-6.1-sol" }] },
        excludedAccounts: [],
      }),
    );
    await press(document.querySelector<HTMLInputElement>('input[type="checkbox"]'));
    await vi.waitFor(() => expect(JSON.parse(textarea.value).excludedAccounts).toHaveLength(1));
    await press(button("Save JSON"));
    await vi.waitFor(async () => {
      const result = await host.rpc["automaticModels.get"]({});
      expect(result.ok && result.data.config.excludedAccounts).toHaveLength(1);
    });
  });
  it("hides on an older Host", async () => {
    await open({ automaticModelsAvailable: false });
    expect(document.body.textContent).not.toContain("Automatic models");
  });
  it("remembers a dismissed explanation across relaunch", async () => {
    let saved: readonly string[] = [];
    const storage = { read: () => saved, write: (keys: readonly string[]) => void (saved = keys) };
    await open({}, createUsageNoticeDismissals(storage));
    await press(button("Dismiss"));
    for (const root of roots.splice(0)) act(() => root.unmount());
    await open({}, createUsageNoticeDismissals(storage));
    expect(document.body.textContent).not.toContain("Automatic work —");
  });
});

function Harness({ host }: { readonly host: MockHostClient }): ReactNode {
  return <AiSettingsForm automatic={useAutomaticModelsForm(host)} page="ai" />;
}
async function open(
  options: { readonly automaticModelsAvailable?: boolean } = {},
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
function button(label: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`button[aria-label="${CSS.escape(label)}"]`);
}
function menuItem(role: string, label: string): HTMLButtonElement | undefined {
  const menu = [...document.querySelectorAll('[role="menu"]')].find(
    (item) => item.getAttribute("aria-label") === role,
  );
  return [...(menu?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((item) =>
    item.textContent?.includes(label),
  );
}
async function press(target: HTMLElement | null) {
  if (!target) throw new Error("Nothing to press");
  await act(async () => target.click());
}
