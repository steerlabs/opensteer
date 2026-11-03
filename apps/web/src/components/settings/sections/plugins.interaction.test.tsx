// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import { unwrapRpcResult } from "@opensteer/client/host";
import { pluginPath } from "@opensteer/client/settings";
import { PluginsSection } from "./plugins.js";
import { ToastProvider } from "../../toast.js";
import type { SettingsView } from "../primitives.js";
const shell = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("../../app-shell.js", () => ({ useShell: () => shell.value }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;
let client: MockHostClient;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  client?.dispose();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});
const view: SettingsView = {
  administrator: true,
  deployment: null,
  kind: "personal",
  machineOwner: true,
  name: "My Mac",
  facts: { desktop: false, onThisComputer: false, remote: false },
  statusInfo: { status: "ready", reason: null },
};
async function mount(path = "/settings/plugins") {
  client = new MockHostClient({ latencyMs: 0 });
  shell.value = {
    hostClient: client,
    snapshot: client.getSnapshot(),
    desktopBridge: null,
    desktopDeployment: null,
    localExecutionStatus: null,
  };
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () =>
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <ToastProvider>
          <PluginsSection view={view} />
        </ToastProvider>
      </MemoryRouter>,
    ),
  );
  await act(async () => {
    await vi.waitFor(() => expect(node.textContent).not.toContain("Loading plugins…"), {
      timeout: 1500,
    });
  });
  return node;
}
describe("Plugins settings", () => {
  it("shows one Gmail row and retains committed switch state while the Host is pending", async () => {
    const node = await mount();
    expect(node.querySelectorAll("a.card__row-body").length).toBeGreaterThan(1);
    const toggle = node.querySelector<HTMLInputElement>('[aria-label="Enable Gmail"]')!;
    expect(toggle.checked).toBe(true);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dispatch = client.dispatch.bind(client);
    const spy = vi.spyOn(client, "dispatch").mockImplementation(async (command) => {
      await gate;
      return dispatch(command);
    });
    await act(async () => toggle.click());
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(true);
    expect(node.textContent).toContain("Saving…");
    expect(spy).toHaveBeenCalledTimes(1);
    await act(async () => release());
    await vi.waitFor(
      async () => {
        await act(async () => {});
        expect(node.querySelector<HTMLInputElement>('[aria-label="Enable Gmail"]')?.checked).toBe(
          false,
        );
      },
      { timeout: 1500 },
    );
    const row = unwrapRpcResult(await client.rpc["plugins.overview.get"]({})).rows.find(
      (row) => row.title === "Gmail",
    )!;
    const detail = unwrapRpcResult(await client.rpc["plugins.detail.get"]({ target: row.target }));
    expect(detail.accounts).toHaveLength(2);
    expect(detail.places.some((place) => place.selected)).toBe(true);
  });
  it("opens a composite identity with exact accounts and layered permission facts", async () => {
    const node = await mount(pluginPath({ kind: "service", definitionId: "google-gmail" }));
    await act(async () => {
      await vi.waitFor(() => expect(node.textContent).toContain("Where it’s on"), {
        timeout: 1500,
      });
    });
    expect(node.textContent).toContain("What agents may do");
    const detail = unwrapRpcResult(
      await client.rpc["plugins.detail.get"]({
        target: { kind: "service", definitionId: "google-gmail" },
      }),
    );
    for (const account of detail.accounts) expect(node.textContent).toContain(account.displayName);
    expect(node.querySelector('[aria-label="Enable Gmail"]')).not.toBeNull();
  });
});
