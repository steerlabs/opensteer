// @vitest-environment happy-dom

import type { HostClient } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import type { App } from "@opensteer/core";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * The Apps page on a phone: what the person published, wherever it came from,
 * over the mock Host's seeded apps (an HTML app and two servers from one chat,
 * one running and one stopped, and an HTML app whose chat is gone).
 *
 * What can go wrong:
 * - the list is read before anyone opens the page, or on an apps change while
 *   it is out of view, costing a round trip on cellular;
 * - an answer read before a newer change overwrites the newer list, or each
 *   change while a read is out sends another;
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
const hosts: MockHostClient[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const host of hosts.splice(0)) host.dispose();
  harness.dispatch = [];
  harness.focused = true;
  document.body.replaceChildren();
});

async function mount() {
  const host = new MockHostClient({ automations: "absent", latencyMs: 0 });
  hosts.push(host);
  await host.load();
  const changed = host.appsChanged;
  const listApps = vi.spyOn(host, "listApps");
  harness.client = host;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const render = () =>
    act(async () => root.render(<AppsScreen route={{ params: { deploymentId } } as never} />));
  await render();
  await waitFor(() => container.textContent?.includes("Ferry tracker") === true, "the list loaded");
  const apps = await host.listApps();
  listApps.mockClear();
  // The first read, which mount waited for.
  const reads = () => listApps.mock.calls.length + 1;
  const app = (name: string): App => apps.find((value) => value.name === name)!;
  return { app, changed, container, host, listApps, reads, render };
}

/** Everything one app's row says. */
function rowText(container: HTMLElement, name: string): string {
  return button(container, `Open ${name}`).closest("main > div > div")?.textContent ?? "";
}
function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) =>
      candidate.getAttribute("aria-label") === label || candidate.textContent === label,
  );
  if (!found) throw new Error(`No button ${label}`);
  return found;
}
function menuChoice(container: HTMLElement, menu: string, label: string): HTMLButtonElement {
  const found = [
    ...(container.querySelector(`[aria-label="${menu}"]`)?.querySelectorAll("button") ?? []),
  ].find((candidate) => candidate.textContent === label);
  if (!found) throw new Error(`No ${label} in ${menu}`);
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
    const { changed, reads, render } = await mount();
    expect(reads()).toBe(1);
    await act(async () => changed());
    await waitFor(() => reads() === 2, "a reread on change");
    harness.focused = false;
    await render();
    await act(async () => changed());
    expect(reads()).toBe(2);
    harness.focused = true;
    await render();
    await waitFor(() => reads() === 3, "a read on returning");
  });

  it("drops an answer read before a newer change", async () => {
    const { app, changed, container, host, listApps, reads } = await mount();
    const stale = await host.listApps();
    listApps.mockClear();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    listApps.mockImplementationOnce(async () => {
      await held;
      return stale;
    });
    await act(async () => changed());
    await waitFor(() => reads() === 2, "the held read began");
    await host.renameApp(app("Ferry tracker").appId, "Renamed elsewhere");
    await act(async () => changed());
    // Changes while a read is out queue one more read behind it, not one each.
    expect(reads()).toBe(2);
    await act(async () => release());
    await waitFor(
      () => container.textContent?.includes("Renamed elsewhere") === true,
      "the newest read showed",
    );
    expect(reads()).toBe(3);
    expect(container.textContent).not.toContain("Ferry tracker");
  });

  it("links each app to the chat that made it, or says that chat was deleted", async () => {
    const { app, container } = await mount();
    expect(rowText(container, "Reading list")).toContain("Chat deleted");
    await press(button(container, "From “Build the new architecture”"));
    expect(harness.dispatch).toEqual([
      {
        payload: { name: "Thread", params: { deploymentId, threadId: app("Trip budget").taskId } },
        type: "PUSH",
      },
    ]);
    expect(() => button(container, "Start Trip budget")).toThrow();
    // An HTML app has no server, so it never says it is running; a server does.
    expect(rowText(container, "Trip budget")).not.toContain("Running");
    expect(rowText(container, "Ferry tracker")).toContain("Running");
  });

  it("opens an app as its one tab, then shows that tab", async () => {
    const { app, container, host } = await mount();
    const open = vi.spyOn(host, "openTab");
    const ferry = app("Ferry tracker").appId;
    const tab = [...host.getSnapshot().tabs.rows.values()].find(
      (row) => row.kind === "app" && row.appId === ferry,
    )!;
    await press(button(container, "Open Ferry tracker"));
    await waitFor(() => harness.dispatch.length === 1, "the tab was shown");
    expect(open.mock.calls).toEqual([[{ appId: ferry, kind: "app" }]]);
    expect(harness.dispatch).toEqual([
      {
        payload: { name: "WorkspaceBrowser", params: { deploymentId, tabId: tab.tabId } },
        type: "PUSH",
      },
    ]);
  });

  it("stops and starts a server app, holding other actions while one is pending", async () => {
    const { container, host, reads } = await mount();
    const stop = host.stopApp.bind(host);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(host, "stopApp").mockImplementationOnce(async (id) => {
      await held;
      return stop(id);
    });
    await press(button(container, "Stop Ferry tracker"));
    expect(button(container, "Open Ferry tracker").disabled).toBe(true);
    expect(button(container, "Open Trip budget").disabled).toBe(false);
    await act(async () => release());
    await waitFor(
      () => rowText(container, "Ferry tracker").includes("Server · Stopped"),
      "the app stopped",
    );
    // The Host's change notice for the stop rereads the list; the stopped state stands.
    await waitFor(() => reads() === 2, "the reread");
    expect(rowText(container, "Ferry tracker")).toContain("Server · Stopped");
    vi.spyOn(host, "startApp").mockRejectedValueOnce(
      new Error("Port 51034 is in use by another program."),
    );
    await press(button(container, "Start Ferry tracker"));
    await waitFor(
      () => rowText(container, "Ferry tracker").includes("Port 51034 is in use"),
      "the failure was shown",
    );
    expect(rowText(container, "Ferry tracker")).toContain("Server · Stopped");
  });

  it("renames and deletes an app, and says when a delete fails", async () => {
    const { container, host } = await mount();
    await press(menuChoice(container, "Ferry tracker actions", "Rename"));
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
    vi.spyOn(host, "deleteApp").mockRejectedValueOnce(new Error("The computer is offline."));
    await press(menuChoice(container, "Groceries actions", "Delete app"));
    await waitFor(
      () => rowText(container, "Groceries").includes("The computer is offline."),
      "the failure was shown",
    );
    // The Host withdraws the app before it can say its server stopped.
    const withdraw = host.deleteApp;
    vi.spyOn(host, "deleteApp").mockImplementationOnce(async (appId) => {
      await withdraw(appId);
      throw new Error("Its computer did not confirm the server stopped.");
    });
    await press(menuChoice(container, "Groceries actions", "Delete app"));
    await waitFor(
      () => container.textContent?.includes("Its computer did not confirm") === true,
      "the outcome was shown",
    );
    expect(() => button(container, "Open Groceries")).toThrow();
    expect(container.textContent).toContain("“Groceries” could not be deleted");
    expect((await host.listApps()).map(({ name }) => name)).not.toContain("Groceries");
    await press(button(container, "Dismiss"));
    expect(container.textContent).not.toContain("Groceries");
  });
});
