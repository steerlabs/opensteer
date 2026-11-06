// @vitest-environment happy-dom

import { MockHostClient } from "@opensteer/client/mock";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShellContext } from "../../app-shell.js";
import { AutomaticModelsSection } from "./automatic-models.js";

const roots: Root[] = [];
const hosts: MockHostClient[] = [];
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const host of hosts.splice(0)) host.dispose();
  document.body.replaceChildren();
});

describe("Automatic models", () => {
  it("edits defaults, accounts and strict JSON, then resets", async () => {
    const { page, host } = await mount();
    expect(page.textContent).toContain("General preference");
    await click(button(page, "Move deep 1 down"));
    await vi.waitFor(async () => expect((await host.rpc["automaticModels.get"]({})).ok).toBe(true));
    await vi.waitFor(() => expect(page.querySelector("fieldset")?.disabled).toBe(false));
    await click(button(page, "Remove deep 1"));
    await vi.waitFor(() => expect(page.querySelector("fieldset")?.disabled).toBe(false));
    const pick = select(page, "Add Nightly memory");
    await choose(
      pick,
      [...pick.options].find((o) => o.textContent?.includes("OpenRouter"))!.textContent!,
    );
    await click(button(page, "Add deep model"));
    await vi.waitFor(async () => {
      const result = await host.rpc["automaticModels.get"]({});
      expect(
        result.ok && result.data.config.roles.deep?.some((e) => "harnessInstanceId" in e),
      ).toBe(true);
    });
    await vi.waitFor(() => expect(page.querySelector("fieldset")?.disabled).toBe(false));
    const check = page.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await click(check);
    await vi.waitFor(() => expect(check.checked).toBe(false));
    const textarea = page.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        textarea,
        '{"roles":{"deep":[]},"excludedAccounts":[]}',
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(within(page, "Save JSON"));
    expect(page.textContent).toContain("Too small");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        textarea,
        '{"roles":{"deep":[{"engine":"codex","model":"gpt-6.1-sol"}]},"excludedAccounts":[]}',
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(within(page, "Save JSON"));
    await vi.waitFor(async () => {
      const result = await host.rpc["automaticModels.get"]({});
      expect(result.ok && result.data.config.roles.deep).toHaveLength(1);
    });
    const resets = [...page.querySelectorAll("button")].filter(
      (b) => b.textContent === "Reset to default",
    );
    await click(resets[1]!);
    await vi.waitFor(async () => {
      const result = await host.rpc["automaticModels.get"]({});
      expect(result.ok && result.data.config.roles.deep).toBeUndefined();
    });
  });
  it("hides the section without capability", async () => {
    const { page } = await mount({ automaticModelsAvailable: false });
    expect(page.textContent).not.toContain("Automatic models");
  });
  it("remembers the explanation dismissal", async () => {
    const first = await mount();
    await click(within(first.page, "Dismiss"));
    const again = await mount();
    expect(again.page.textContent).not.toContain("Automatic work —");
  });
});

async function mount(options: { readonly automaticModelsAvailable?: boolean } = {}) {
  const host = new MockHostClient({ latencyMs: 0, ...options });
  hosts.push(host);
  const dispatch = vi.fn(host.rpc["commands.dispatch"]);
  Object.defineProperty(host.rpc, "commands.dispatch", { value: dispatch, configurable: true });
  const context = { hostClient: host, snapshot: host.getSnapshot() } as unknown as ShellContext;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/settings/ai"]}>
        <Routes>
          <Route
            element={
              <ShellContext value={context}>
                <Outlet />
              </ShellContext>
            }
          >
            <Route element={<AutomaticModelsSection />} path="settings/ai" />
          </Route>
        </Routes>
      </MemoryRouter>,
    ),
  );
  await vi.waitFor(() => expect(container.textContent).not.toContain("Loading…"));
  return { dispatch, host, page: container };
}

function within(scope: HTMLElement, text: string) {
  const found = [...scope.querySelectorAll("button")].find((item) => item.textContent === text);
  if (!found) throw new Error(`No ${text} button`);
  return found;
}
function button(page: HTMLElement, label: string) {
  const found = page.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`No ${label} button`);
  return found;
}
function select(page: HTMLElement, label: string) {
  const found = page.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  if (!found) throw new Error(`No ${label} select`);
  return found;
}
async function click(target: HTMLElement) {
  await act(async () => target.click());
}
async function choose(target: HTMLSelectElement, label: string) {
  const option = [...target.options].find((item) => item.textContent === label);
  if (!option) throw new Error(`No ${label} option`);
  await act(async () => {
    target.value = option.value;
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
