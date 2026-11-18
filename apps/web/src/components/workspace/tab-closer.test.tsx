// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { TabId } from "@opensteer/core";
import {
  HostTransportError,
  type ClientConnection,
  type ClientConnectionState,
} from "@opensteer/client/connections";
import type { HostClient } from "@opensteer/client/host";
import { localSession } from "../use-action.js";
import {
  TabCloserProvider,
  useTabCloseLine,
  useTabCloser,
  useTabGroupCloser,
} from "./tab-closer.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const tab = "tab_00000000-0000-4000-8000-000000000001" as TabId;
const anotherTab = "tab_00000000-0000-4000-8000-000000000002" as TabId;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

function Row({ id = tab }: { readonly id?: TabId }) {
  const close = useTabCloser();
  const line = useTabCloseLine(id);
  return (
    <div>
      <button onClick={() => close({ key: id })} type="button">
        Close
      </button>
      <p data-line={id}>{line?.text ?? ""}</p>
      {line?.link ? (
        <button onClick={line.link.onPress} type="button">
          {line.link.label}
        </button>
      ) : null}
    </div>
  );
}

function Group({ ids = [tab, anotherTab] }: { readonly ids?: readonly TabId[] }) {
  const close = useTabGroupCloser();
  return (
    <button type="button" onClick={() => close(ids)}>
      Close group
    </button>
  );
}

function setup(
  closeTabs: HostClient["closeTabs"],
  open: (id: TabId) => boolean,
  group: boolean | readonly TabId[] = false,
) {
  const listeners = new Set<() => void>();
  let state: ClientConnectionState = localSession.connection.getSnapshot();
  const connection: ClientConnection = {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    retry: () => undefined,
  };
  const hostClient = {
    connection,
    closeTabs: vi.fn(closeTabs),
    rpc: {
      "tabs.get": vi.fn(async ({ tabId }: { tabId: TabId }, _options?: { signal: AbortSignal }) => {
        if (open(tabId)) return { ok: true, data: { tabId } };
        throw Object.assign(new Error("gone"), {
          code: "not_found",
          provenance: "host",
          retryable: false,
        });
      }),
    },
  } as unknown as HostClient;
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  act(() =>
    root!.render(
      <TabCloserProvider hostClient={hostClient}>
        <Row />
        {Array.isArray(group) ? (
          <Group ids={group} />
        ) : group ? (
          <>
            <Row id={anotherTab} />
            <Group />
          </>
        ) : null}
      </TabCloserProvider>,
    ),
  );
  return {
    hostClient,
    watchers: () => listeners.size,
    line: (id = tab) => node.querySelector(`[data-line="${id}"]`)?.textContent ?? "",
    checks: () => [...node.querySelectorAll("button")].filter((b) => b.textContent === "Check"),
    button: (name: string) =>
      [...node.querySelectorAll("button")].find((b) => b.textContent === name),
    offline() {
      state = { ...state, phase: "recovering", network: "offline" };
      listeners.forEach((listener) => listener());
    },
  };
}

it("says an offline close on the tab's row without sending it", async () => {
  const view = setup(
    async () => ({ closed: [tab], failed: [] }),
    () => true,
  );
  view.offline();
  await act(async () => view.button("Close")!.click());
  expect(view.hostClient.closeTabs).not.toHaveBeenCalled();
  expect(view.line()).toContain("Not closed");
});

it("keeps a lost answer on the row until a tab read settles it", async () => {
  let open = true;
  const view = setup(
    async () => {
      open = false;
      throw new HostTransportError("unreachable");
    },
    () => open,
  );
  await act(async () => view.button("Close")!.click());
  expect(view.line()).toContain("Couldn't confirm");
  await act(async () => view.button("Check")!.click());
  expect(view.line()).toBe("");
  expect(view.hostClient.closeTabs).toHaveBeenCalledOnce();
});

it("says the Host's refusal of the tab on its row", async () => {
  const view = setup(
    async () => ({
      closed: [],
      failed: [{ tabId: tab, error: { code: "conflict", message: "busy", next: null } }],
    }),
    () => true,
  );
  await act(async () => view.button("Close")!.click());
  expect(view.line()).not.toBe("");
  expect(view.line()).not.toContain("busy");
});

it("keeps each tab's outcome when a group close or a check has mixed results", async () => {
  const view = setup(
    vi
      .fn<HostClient["closeTabs"]>()
      .mockResolvedValueOnce({
        closed: [tab],
        failed: [{ tabId: anotherTab, error: { code: "conflict", message: "busy", next: null } }],
      })
      .mockRejectedValueOnce(new HostTransportError("unreachable")),
    (id) => {
      if (id === anotherTab) throw new HostTransportError("timed-out");
      return true;
    },
    true,
  );
  await act(async () => view.button("Close group")!.click());
  expect(view.line(tab)).toBe("");
  expect(view.line(anotherTab)).not.toBe("");
  await act(async () => view.button("Close group")!.click());
  expect(view.checks()).toHaveLength(2);
  await act(async () => {
    for (const check of view.checks()) check.click();
  });
  expect(view.line(tab)).toContain("Not closed");
  expect(view.line(anotherTab)).toContain("Couldn't confirm");
  expect(view.checks()).toHaveLength(1);
  expect(view.hostClient.rpc["tabs.get"]).toHaveBeenCalledWith(
    { tabId: anotherTab },
    { signal: expect.any(AbortSignal) },
  );
  expect(view.hostClient.closeTabs).toHaveBeenCalledTimes(2);
});

it("lets go of refused closes of tabs no row shows, keeping only the newest", async () => {
  const ids = Array.from(
    { length: 40 },
    (_, i) => `tab_00000000-0000-4000-8000-${String(i + 100).padStart(12, "0")}` as TabId,
  );
  const view = setup(
    async (tabIds) => ({
      closed: [],
      failed: tabIds.map((tabId) => ({
        tabId,
        error: { code: "conflict", message: "busy", next: null },
      })),
    }),
    () => true,
    ids,
  );
  await act(async () => view.button("Close group")!.click());
  expect(view.watchers()).toBe(40);
  await act(async () => view.button("Close")!.click());
  expect(view.watchers()).toBe(32);
  expect(view.line()).not.toBe("");
});
