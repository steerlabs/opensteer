// @vitest-environment happy-dom
import { getAutomaticModels } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { AutomaticModelsForm } from "./settings-form.types.js";

vi.mock("@expo/ui/swift-ui", () => {
  const view =
    () =>
    ({ children, title }: { children?: ReactNode; title?: string }) => (
      <div>
        {title}
        {children}
      </div>
    );
  return {
    Button: ({ label, onPress }: { label: string; onPress: () => void }) => (
      <button onClick={onPress}>{label}</button>
    ),
    DisclosureGroup: view(),
    useNativeState: () => ({ set: () => {} }),
    TextField: () => null,
    Toggle: (p: { label: string; isOn: boolean; onIsOnChange: () => void }) => (
      <input aria-label={p.label} type="checkbox" checked={p.isOn} onChange={p.onIsOnChange} />
    ),
    HStack: view(),
    Image: () => null,
    Picker: (props: {
      children: ReactNode;
      label: string;
      onSelectionChange: (value: string) => void;
      selection: string;
    }) => (
      <select
        aria-label={props.label}
        onChange={(event) => props.onSelectionChange(event.currentTarget.value)}
        value={props.selection}
      >
        {props.children}
      </select>
    ),
    Section: view(),
    Spacer: () => null,
    Text: ({ children, modifiers }: { children?: ReactNode; modifiers?: { tag?: string }[] }) => {
      const value = modifiers?.find((modifier) => modifier.tag !== undefined)?.tag;
      return value === undefined ? (
        <span>{children}</span>
      ) : (
        <option value={value}>{children}</option>
      );
    },
    VStack: view(),
  };
});
vi.mock("@expo/ui/swift-ui/modifiers", () => ({
  accessibilityAddTraits: () => ({}),
  accessibilityHidden: () => ({}),
  accessibilityLabel: () => ({}),
  background: () => ({}),
  contentShape: () => ({}),
  disabled: () => ({}),
  font: () => ({}),
  lineLimit: () => ({}),
  foregroundStyle: () => ({}),
  frame: () => ({}),
  pickerStyle: () => ({}),
  shapes: { circle: () => ({}), rectangle: () => ({}), roundedRectangle: () => ({}) },
  tag: (tag: string) => ({ tag }),
}));
vi.mock("../theme.js", () => ({ color: {}, deploymentPaint: {} }));

const { AiSettingsForm } = await import("./settings-ai-form.ios.js");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("shows native ordered roles, account switches, advanced editor and dismissal", async () => {
  const host = new MockHostClient({ latencyMs: 0 });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    const form: AutomaticModelsForm = {
      supported: true,
      view: await getAutomaticModels(host),
      error: null,
      pending: false,
      explanation: true,
      dismiss: vi.fn(),
      save: vi.fn(),
      edit: vi.fn(),
      toggle: vi.fn(),
    };
    await act(async () => root.render(<AiSettingsForm automatic={form} page="ai" />));
    expect(container.textContent).toContain("General preference");
    expect(container.textContent).toContain("haiku");
    const press = (label: string) =>
      [...container.querySelectorAll("button")].find((b) => b.textContent === label)!;
    await act(async () => press("Move deep 1 down").click());
    expect(form.edit).toHaveBeenCalledWith("deep", { type: "move", index: 0, offset: 1 });
    await act(async () => press("Remove deep 1").click());
    expect(form.edit).toHaveBeenCalledWith("deep", { type: "remove", index: 0 });
    await act(async () => press("Reset deep to default").click());
    expect(form.edit).toHaveBeenCalledWith("deep", { type: "reset" });
    await act(async () => container.querySelector<HTMLInputElement>("input")!.click());
    expect(form.toggle).toHaveBeenCalled();
    await act(async () => press("Dismiss").click());
    expect(form.dismiss).toHaveBeenCalled();
    await act(async () =>
      root.render(<AiSettingsForm automatic={{ ...form, supported: false }} page="ai" />),
    );
    expect(container.textContent).not.toContain("Automatic models");
  } finally {
    act(() => root.unmount());
    host.dispose();
  }
});
