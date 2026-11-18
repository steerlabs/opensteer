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
import { TabCloserProvider, useTabCloseLine, useTabCloser } from "./tab-closer.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const tab = "tab_00000000-0000-4000-8000-000000000001" as TabId;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

function Row() {
  const close = useTabCloser();
  const line = useTabCloseLine(tab);
  return (
    <div>
      <button onClick={() => close({ key: tab })} type="button">
        Close
      </button>
      <p data-line>{line?.text ?? ""}</p>
      {line?.link ? (
        <button onClick={line.link.onPress} type="button">
          {line.link.label}
        </button>
      ) : null}
    </div>
  );
}

function setup(closeTabs: HostClient["closeTabs"], open: () => boolean) {
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
      "tabs.get": async () => {
        if (open()) return { ok: true, data: { tabId: tab } };
        throw Object.assign(new Error("gone"), {
          code: "not_found",
          provenance: "host",
          retryable: false,
        });
      },
    },
  } as unknown as HostClient;
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  act(() =>
    root!.render(
      <TabCloserProvider hostClient={hostClient}>
        <Row />
      </TabCloserProvider>,
    ),
  );
  return {
    hostClient,
    line: () => node.querySelector("[data-line]")?.textContent ?? "",
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
