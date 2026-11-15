// @vitest-environment happy-dom

import type { HostClient } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import type { App } from "@opensteer/core";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appId, attachMockTabs, serverApp, type MockTabs } from "../../test-support/mock-tabs.js";

/*
 * The Apps page on a phone: what the person published, wherever it came from.
 *
 * What can go wrong:
 * - the list is read before anyone opens the page, or on an apps change while
 *   it is out of view, costing a round trip on cellular;
 * - an answer read before a newer change overwrites the newer list;
 * - an app whose chat was deleted vanishes or links to nothing;
 * - Open publishes nothing but also opens nothing, or opens another tab;
 * - Start/Stop/Rename/Delete hide their pending state or their failure, or a
 *   failed Start shows the app running.
 */

const harness = vi.hoisted(() => ({
  client: null as HostClient | null,
  dispatch: [] as { type: string; payload?: unknown }[],
  focused: true,
}));
vi.mock(
  "react-native",
  async () => (await import("../../test-support/tab-screen-mocks.js")).reactNative,
);
vi.mock("../theme.js", async () => (await import("../../test-support/tab-screen-mocks.js")).theme);
vi.mock(
  "../ui/primitives.js",
  async () => (await import("../../test-support/tab-screen-mocks.js")).primitives,
);
vi.mock(
  "../thread/composer-menu.js",
  async () => (await import("../../test-support/tab-screen-mocks.js")).composerMenu,
);
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("../ui/foreground.js", () => ({ useAppForeground: () => true }));
vi.mock("./confirm.js", () => ({
  confirmDestructive: (input: { readonly onConfirm: () => void }) => input.onConfirm(),
}));
vi.mock("../client/mobile-client.js", () => ({
  operationDetail: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));
vi.mock("../ui/screen.js", () => ({
  Screen: ({ children }: { readonly children?: ReactNode }) => <main>{children}</main>,
  useListContentInsets: () => ({}),
  useReadingColumn: () => ({}),
}));
vi.mock("./deployment-gate.js", () => ({
  DeploymentGate: () => null,
  useAttachedHost: () => harness.client,
}));
vi.mock("@react-navigation/native", () => ({
  StackActions: {
    push: (name: string, params?: object) => ({ payload: { name, params }, type: "PUSH" }),
  },
  useIsFocused: () => harness.focused,
  useNavigation: () => ({
    dispatch: (action: { type: string; payload?: unknown }) => harness.dispatch.push(action),
  }),
}));

const { AppsScreen } = await import("./apps.js");

const deploymentId = "dep_0192f4a1-1111-4000-8000-000000000001";
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  harness.dispatch = [];
  harness.focused = true;
  document.body.replaceChildren();
});

async function mount(apps: (host: MockHostClient) => App[]) {
  const host = new MockHostClient({ automations: "absent", latencyMs: 0 });
  await host.load();
  const mock = attachMockTabs(host, { apps: apps(host), layout: [], tabs: [] });
  harness.client = host;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const render = () =>
    act(async () => root.render(<AppsScreen route={{ params: { deploymentId } } as never} />));
  await render();
  return { container, host, mock, render };
}

const reads = (mock: MockTabs) => mock.calls.filter(({ method }) => method === "listApps").length;
function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) =>
      candidate.getAttribute("aria-label") === label || candidate.textContent === label,
  );
  if (!found) throw new Error(`No button ${label}`);
  return found;
}
async function press(target: HTMLElement): Promise<void> {
  await act(async () => target.click());
}
async function waitFor(condition: () => boolean, what: string): Promise<void> {
  await vi.waitFor(
    () => {
      if (!condition()) throw new Error(`Never happened: ${what}`);
    },
    { timeout: 2_000 },
  );
}

describe("the Apps page", () => {
  it("reads the list when opened and on an apps change only while in view", async () => {
    const { container, mock, render } = await mount(() => [serverApp(1)]);
    await waitFor(() => container.textContent?.includes("App 1") === true, "the list loaded");
    expect(reads(mock)).toBe(1);
    await act(async () => mock.bumpAppsRevision());
    await waitFor(() => reads(mock) === 2, "a reread on change");
    harness.focused = false;
    await render();
    await act(async () => mock.bumpAppsRevision());
    expect(reads(mock)).toBe(2);
    harness.focused = true;
    await render();
    await waitFor(() => reads(mock) === 3, "a read on returning");
  });

  it("drops an answer read before a newer change", async () => {
    const { container, mock } = await mount(() => [serverApp(1)]);
    await waitFor(() => reads(mock) === 1, "the first read");
    const hold = mock.holdNext("listApps");
    await act(async () => mock.bumpAppsRevision());
    await waitFor(() => reads(mock) === 2, "the held read began");
    mock.apps = [serverApp(1, { name: "Renamed elsewhere" })];
    await act(async () => mock.bumpAppsRevision());
    await waitFor(
      () => container.textContent?.includes("Renamed elsewhere") === true,
      "the newest read showed",
    );
    mock.apps = [serverApp(1, { name: "Stale" })];
    await act(async () => hold.release());
    expect(container.textContent).toContain("Renamed elsewhere");
    expect(container.textContent).not.toContain("Stale");
  });

  it("names each app's kind, state and computer, and its chat or that the chat was deleted", async () => {
    const { container } = await mount((host) => {
      const snapshot = host.getSnapshot();
      return [
        serverApp(1, {
          computerId: snapshot.machines[0]!.id as never,
          taskId: snapshot.threads[0]!.id as never,
        }),
        serverApp(2, {
          folder: undefined,
          kind: "html",
          localUrl: undefined,
          name: "Recipe card",
          server: null,
          start: undefined,
        }),
      ];
    });
    await waitFor(() => container.textContent?.includes("Recipe card") === true, "the list loaded");
    const text = container.textContent ?? "";
    expect(text).toContain("Server · Running");
    expect(text).toContain("Chat deleted");
    expect(text).toContain("Removed computer");
    const origin = [...container.querySelectorAll("button")].find((node) =>
      node.textContent?.startsWith("From “"),
    );
    await press(origin!);
    expect(harness.dispatch[0]).toMatchObject({ payload: { name: "Thread" }, type: "PUSH" });
    expect(() => button(container, "Start Recipe card")).toThrow();
  });

  it("opens an app as its one tab, then shows that tab", async () => {
    const { container, mock } = await mount(() => [serverApp(1)]);
    await waitFor(() => container.textContent?.includes("App 1") === true, "the list loaded");
    await press(button(container, "Open App 1"));
    await waitFor(() => harness.dispatch.length === 1, "the tab was shown");
    expect(mock.calls.find(({ method }) => method === "openTab")?.args).toEqual([
      { appId: appId(1), kind: "app" },
    ]);
    const [tab] = mock.model.rows.values();
    expect(harness.dispatch[0]).toEqual({
      payload: { name: "WorkspaceBrowser", params: { deploymentId, tabId: tab!.tabId } },
      type: "PUSH",
    });
  });

  it("stops and starts a server app, holding other actions while one is pending", async () => {
    const { container, mock } = await mount(() => [serverApp(1)]);
    await waitFor(() => container.textContent?.includes("App 1") === true, "the list loaded");
    const hold = mock.holdNext("stopApp");
    await press(button(container, "Stop App 1"));
    expect(button(container, "Open App 1").disabled).toBe(true);
    await act(async () => hold.release());
    await waitFor(() => container.textContent?.includes("Stopped") === true, "the app stopped");
    // The change notice the Host sends rereads the list; the stopped state stands.
    mock.apps = mock.apps.map((app) => ({
      ...app,
      server: { ...app.server!, desiredState: "stopped" as const, state: "stopped" as const },
    }));
    await act(async () => mock.bumpAppsRevision());
    await waitFor(() => button(container, "Start App 1") !== undefined, "Start is offered");
    mock.failNext("startApp", "Port 49153 is in use by another program.");
    await press(button(container, "Start App 1"));
    await waitFor(
      () => container.textContent?.includes("Port 49153 is in use") === true,
      "the failure was shown",
    );
    expect(container.textContent).toContain("Stopped");
  });

  it("renames and deletes an app", async () => {
    const { container, mock } = await mount(() => [serverApp(1)]);
    await waitFor(() => container.textContent?.includes("App 1") === true, "the list loaded");
    await press(button(container, "Rename"));
    const field = container.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        field,
        "Groceries",
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await press(button(container, "Save"));
    await waitFor(() => container.textContent?.includes("Groceries") === true, "the new name");
    await press(button(container, "Delete app"));
    await waitFor(() => container.textContent?.includes("No apps yet") === true, "the app left");
    expect(mock.calls.map(({ method }) => method)).toContain("deleteApp");
  });
});
