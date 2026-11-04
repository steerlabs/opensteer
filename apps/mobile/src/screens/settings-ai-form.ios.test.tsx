// @vitest-environment happy-dom
import {
  backgroundModelsSettings,
  getBackgroundModels,
  setBackgroundProviderConsent,
  unwrapRpcResult,
} from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { ModelSelectionSchema } from "@opensteer/core";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { BackgroundModelsForm } from "./settings-form.types.js";

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
  foregroundStyle: () => ({}),
  frame: () => ({}),
  pickerStyle: () => ({}),
  shapes: { circle: () => ({}), rectangle: () => ({}), roundedRectangle: () => ({}) },
  tag: (tag: string) => ({ tag }),
}));
vi.mock("../theme.js", () => ({ color: {}, deploymentPaint: {} }));

const { AiSettingsForm } = await import("./settings-ai-form.ios.js");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("pins from the iPhone's role picker and answers the consent notice", async () => {
  const host = new MockHostClient({ latencyMs: 0 });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    const view = async () => unwrapRpcResult(await getBackgroundModels(host));
    const form: BackgroundModelsForm = {
      settings: backgroundModelsSettings(await view(), new Set()),
      error: null,
      pending: false,
      onRole: vi.fn(),
      onConsent: vi.fn(),
      onNotNow: vi.fn(),
    };
    await act(async () => root.render(<AiSettingsForm background={form} page="ai" />));
    expect(container.textContent).toContain("Let Anthropic name your tasks");
    const press = (label: string) =>
      [...container.querySelectorAll("button")].find((button) => button.textContent === label);
    await act(async () => press("Not now")?.click());
    expect(form.onNotNow).toHaveBeenCalledWith("anthropic");
    await act(async () => press("Allow")?.click());
    expect(form.onConsent).toHaveBeenCalledWith("anthropic", true);

    await setBackgroundProviderConsent(
      host,
      ModelSelectionSchema.shape.providerId.parse("anthropic"),
      true,
    );
    const allowed = { ...form, settings: backgroundModelsSettings(await view(), new Set()) };
    await act(async () => root.render(<AiSettingsForm background={allowed} page="ai" />));
    expect(container.textContent).toContain(
      "Automatic (currently Claude Opus 5.5 via Claude Code)",
    );
    const picker = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Nightly memory"]',
    )!;
    const opus = [...picker.options].find((option) => option.textContent?.startsWith("Claude"))!;
    await act(async () => {
      picker.value = opus.value;
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(form.onRole).toHaveBeenCalledWith("deep", opus.value);
    expect(press("Revoke")).toBeDefined();
  } finally {
    act(() => root.unmount());
    host.dispose();
  }
});
