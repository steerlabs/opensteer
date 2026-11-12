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
vi.mock("react-native", () => ({ Linking: { openURL: vi.fn() } }));
vi.mock("../theme.js", () => ({ color: new Proxy({}, { get: () => "#000000" }) }));
vi.mock(
  "@expo/ui/jetpack-compose",
  async () => (await import("../../test-support/jetpack-compose-mock.js")).compose,
);
vi.mock(
  "@expo/ui/jetpack-compose/modifiers",
  async () => (await import("../../test-support/jetpack-compose-mock.js")).composeModifiers,
);
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
    await press(menuAction("More actions for Nightly memory 1", "Move down"));
    await vi.waitFor(async () => {
      const v = await host.rpc["automaticModels.get"]({});
      expect(v.ok && v.data.config.roles.deep?.[0]).toMatchObject({ model: "gpt-6.1-sol" });
    });
    await press(menuAction("More actions for Nightly memory 1", "Remove"));
    await press(choice("Add Nightly memory", "OpenRouter"));
    await vi.waitFor(async () => {
      const v = await host.rpc["automaticModels.get"]({});
      expect(v.ok && v.data.config.roles.deep?.some((e) => "harnessInstanceId" in e)).toBe(true);
    });
    const toggle = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await press(toggle);
    await vi.waitFor(() => expect(toggle.checked).toBe(false));
    await press(buttonWithText("Reset deep to default"));
    await vi.waitFor(async () => {
      const v = await host.rpc["automaticModels.get"]({});
      expect(v.ok && v.data.config.roles.deep).toBeUndefined();
    });
  });
  it("round trips Advanced JSON and explains strict errors", async () => {
    const { host } = await open();
    await press(buttonWithText("Advanced"));
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
    await press(buttonWithText("Save JSON"));
    expect(document.body.textContent).toContain("Too small");
    await type(
      '{"roles":{"deep":[{"engine":"codex","model":"gpt-6.1-sol"}]},"excludedAccounts":[]}',
    );
    await press(buttonWithText("Save JSON"));
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
    await press(buttonWithText("Save JSON"));
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
    await press(buttonWithText("Dismiss"));
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
function buttonWithText(text: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll("button")].find((item) =>
      item.textContent?.trim().startsWith(text),
    ) ?? null
  );
}
/** An action in the overflow menu whose button is named `menu`. */
function menuAction(menu: string, label: string): HTMLButtonElement | null {
  const trigger = document.querySelector(`button[aria-label="${CSS.escape(menu)}"]`);
  return (
    [...(trigger?.closest("[data-menu]")?.querySelectorAll("button") ?? [])].find(
      (item) => item.textContent === label,
    ) ?? null
  );
}
/** A choice offered under the row titled `title`. */
function choice(title: string, label: string): HTMLButtonElement | null {
  const menu = [...document.querySelectorAll("[data-menu]")].find(
    (item) => item.querySelector("span")?.textContent === title,
  );
  return (
    [...(menu?.querySelectorAll("button") ?? [])].find((item) =>
      item.textContent?.includes(label),
    ) ?? null
  );
}
async function press(target: HTMLElement | null) {
  if (!target) throw new Error("Nothing to press");
  await act(async () => target.click());
}
