// @vitest-environment happy-dom

import { MockHostClient } from "@opensteer/client/mock";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ShellContext } from "../../app-shell.js";
import { BackgroundModelsSection } from "./background-models.js";

/*
 * How Settings → AI → Background models could mislead or nag:
 * - a role claims a model runs it when none can, or hides that a provider waits on the person;
 * - Allow, Revoke or a pin sends the wrong command or leaves the page showing the old state;
 * - "Not now" comes back on the next visit.
 */

const roots: Root[] = [];
const hosts: MockHostClient[] = [];
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const host of hosts.splice(0)) host.dispose();
  document.body.replaceChildren();
});

describe("Settings → AI → Background models", () => {
  it("says nothing can run until a provider is allowed, then names the pick", async () => {
    const { page, dispatch: consent } = await mount();
    expect(details(page)).toEqual([
      "Automatic. Waiting for you to allow a provider.",
      "Automatic. Waiting for you to allow a provider.",
      "Not allowed",
      "Not allowed",
    ]);
    expect(notice(page)?.textContent).toContain(
      "Let Anthropic name your tasks and run memory passes? It sees the first message of each new task (up to 2,000 characters)",
    );
    await click(within(notice(page)!, "Allow"));
    expect(consent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "backgroundModels.consent.set",
        providerId: "anthropic",
        acknowledged: true,
      }),
    );
    await vi.waitFor(() =>
      expect(details(page).slice(0, 3)).toEqual([
        "Automatic (currently Claude Haiku 5.5 via Claude Code)",
        "Automatic (currently Claude Opus 5.5 via Claude Code)",
        "Allowed",
      ]),
    );
    expect(notice(page)).toBeNull();
    await click(button(page, "Revoke Anthropic"));
    await vi.waitFor(() => expect(details(page)[2]).toBe("Not allowed"));
  });

  it("pins a model and returns to automatic", async () => {
    const { page, dispatch } = await mount();
    await click(button(page, "Allow Anthropic"));
    await vi.waitFor(() => expect(select(page, "Nightly memory").options).toHaveLength(2));
    await choose(select(page, "Nightly memory"), "Claude Opus 5.5 · Claude Code");
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "backgroundModels.role.set",
        role: "deep",
        mode: expect.objectContaining({ kind: "pinned" }),
      }),
    );
    await vi.waitFor(() => expect(details(page)[1]).toBe("Claude Opus 5.5 via Claude Code"));
    await choose(select(page, "Nightly memory"), "Automatic");
    await vi.waitFor(() =>
      expect(details(page)[1]).toBe("Automatic (currently Claude Opus 5.5 via Claude Code)"),
    );
  });

  it("says so plainly when no model can run background work", async () => {
    const { page } = await mount({ backgroundModels: "none" });
    expect(details(page)).toEqual([
      "Automatic. No model can run this right now.",
      "Automatic. No model can run this right now.",
    ]);
    expect(notice(page)).toBeNull();
    expect(page.textContent).not.toContain("Providers for background work");
  });

  // Last: the device's dismissals outlive a mount, as they should.
  it("remembers Not now on this device", async () => {
    const first = await mount();
    await click(within(notice(first.page)!, "Not now"));
    expect(notice(first.page)).toBeNull();
    expect(localStorage.getItem("opensteer.background-notices.dismissed")).toContain("anthropic");
    const again = await mount();
    expect(notice(again.page)).toBeNull();
    expect(button(again.page, "Allow Anthropic")).toBeDefined();
  });
});

async function mount(options: { readonly backgroundModels?: "none" } = {}) {
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
          <Route element={<Outlet context={context} />}>
            <Route element={<BackgroundModelsSection />} path="settings/ai" />
          </Route>
        </Routes>
      </MemoryRouter>,
    ),
  );
  await vi.waitFor(() => expect(container.querySelector('[role="status"]')).toBeNull());
  return { dispatch, page: container };
}

function details(page: HTMLElement) {
  return [...page.querySelectorAll(".card__row-detail")].map((detail) => detail.textContent);
}
function notice(page: HTMLElement) {
  return page.querySelector<HTMLElement>('[role="region"][aria-label^="Allow"]');
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
