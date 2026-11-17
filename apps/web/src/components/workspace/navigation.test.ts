// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useNavigate } from "react-router";
import { MockHostClient } from "@opensteer/client/mock";
import { useWorkspaceNavigation, type WorkspaceNavigation } from "./navigation.js";
import { openWorkspaceWebLink } from "./start-page.js";
import { afterEach, expect, it, vi } from "vitest";
import { TabIdSchema } from "@opensteer/core";
import {
  placeAddress,
  placeSelection,
  rememberPlace,
  rememberedPlace,
  startPageLink,
  workspaceSide,
} from "./navigation.js";

const destination = {
  kind: "tab",
  tabId: TabIdSchema.parse("tab_11111111-1111-4111-8111-111111111111"),
} as const;
const scope = { deploymentId: "deployment", userId: "user" };

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const mounted: Root[] = [];
afterEach(() => {
  for (const root of mounted.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  localStorage.clear();
});

it("names a tab in the address and opens New tab for an unreadable one", () => {
  expect(placeSelection(new URLSearchParams(placeAddress(destination)))).toEqual({
    kind: "place",
    destination,
  });
  expect(placeSelection(new URLSearchParams({ panel: "browser", tab: "x".repeat(600) }))).toEqual({
    kind: "launcher",
  });
});

it("remembers a tab and refuses a forged memory of one", () => {
  rememberPlace(scope, destination);
  expect(rememberedPlace(scope)).toEqual(destination);
  const [key] = Object.keys(localStorage);
  localStorage.setItem(key!, JSON.stringify({ kind: "tab", tabId: "" }));
  expect(rememberedPlace(scope)).toBeNull();
});

it("classifies only workspace addresses, including a bare team link", () => {
  for (const path of ["/", "/tasks/t", "/automations", "/automations/a/edit", "/voice"])
    expect(workspaceSide(path)).toBe("tasks");
  for (const path of ["/teams/acme", "/teams/acme/", "/teams/acme/knowledge"])
    expect(workspaceSide(path)).toBe("acme");
  for (const path of [
    "/settings",
    "/settings/teams/acme/profile",
    "/setup",
    "/get-started",
    "/join",
    "/teams",
    "/live",
    "/teams/%",
  ])
    expect(workspaceSide(path)).toBeNull();
});

// History state survives reloads and can be written by other pages of the origin.
it.each([
  null,
  {},
  { startAddress: 123 },
  { startAddress: "x".repeat(8193) },
  { startAddress: "search words" },
  { startAddress: "file:///tmp/a" },
  { startAddress: "https://user:password@example.test" },
])("opens no start page link from untrusted history state %j", (value) => {
  expect(startPageLink(value)).toBeNull();
});
it.each(["https://storage.example/docs/mounts", "http://localhost:3000", "example.com"])(
  "keeps a start page link's address as spelled: %s",
  (value) => {
    expect(startPageLink({ startAddress: value })).toEqual({ address: value, open: false });
    expect(startPageLink({ startAddress: value, startOpen: true })?.open).toBe(true);
  },
);

it.each(["success", "failure"])(
  "shows a pending address immediately and ignores a late %s after Back",
  async (outcome) => {
    const { nav, navigate, host } = await workspace();
    const tab = [...host.getSnapshot().tabs.rows.values()][0]!;
    let resolve!: (value: typeof tab) => void;
    let reject!: (error: Error) => void;
    const open = vi.spyOn(host, "openTab").mockImplementationOnce(
      () =>
        new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        }),
    );
    act(() => openWorkspaceWebLink(host, nav.current!, "https://example.com/", null, null));
    expect(nav.current!.pendingPlace).toBe("https://example.com/");
    expect(startPageLink(nav.current!.address().state)?.open).toBe(false);
    expect(open).toHaveBeenCalledTimes(1);
    await act(async () => navigate.current!(-1));
    expect(nav.current!.pendingPlace).toBeNull();
    const before = nav.current!.address().search;
    await act(async () => (outcome === "success" ? resolve(tab) : reject(new Error("failed"))));
    expect(nav.current!.address().search).toBe(before);
    expect(nav.current!.pendingPlace).toBeNull();
    expect(open).toHaveBeenCalledTimes(1);
  },
);

it("replaces the pending selection on success and keeps an unknown failure on the start page without another request", async () => {
  const { nav, host } = await workspace();
  const tab = [...host.getSnapshot().tabs.rows.values()][0]!;
  const open = vi.spyOn(host, "openTab").mockResolvedValueOnce(tab);
  await act(async () =>
    openWorkspaceWebLink(host, nav.current!, "https://example.com/", null, null),
  );
  expect(placeSelection(new URLSearchParams(nav.current!.address().search))).toEqual({
    kind: "place",
    destination: { kind: "tab", tabId: tab.tabId },
  });
  open.mockRejectedValueOnce(new Error("unknown outcome"));
  await act(async () =>
    openWorkspaceWebLink(host, nav.current!, "https://example.org/", null, null),
  );
  expect(nav.current!.pendingPlace).toBeNull();
  expect(placeSelection(new URLSearchParams(nav.current!.address().search))).toEqual({
    kind: "launcher",
  });
  expect(startPageLink(nav.current!.address().state)).toMatchObject({
    address: "https://example.org/",
    open: false,
  });
  expect(open).toHaveBeenCalledTimes(2);
});

it("only the newest opening may select its result", async () => {
  const { nav } = await workspace();
  let older!: ReturnType<WorkspaceNavigation["beginPlaceOperation"]>;
  let newest!: ReturnType<WorkspaceNavigation["beginPlaceOperation"]>;
  act(() => {
    older = nav.current!.beginPlaceOperation({ address: "https://older.example/" });
  });
  act(() => {
    newest = nav.current!.beginPlaceOperation({ address: "https://newest.example/" });
  });
  act(() => older(destination));
  expect(nav.current!.pendingPlace).toBe("https://newest.example/");
  act(() => newest(destination));
  expect(nav.current!.pendingPlace).toBeNull();
  expect(placeSelection(new URLSearchParams(nav.current!.address().search))).toEqual({
    kind: "place",
    destination,
  });
});

async function workspace() {
  const nav: { current: WorkspaceNavigation | null } = { current: null };
  const navigate: { current: ReturnType<typeof useNavigate> | null } = { current: null };
  const host = new MockHostClient({ latencyMs: 0 });
  const Probe = () => {
    nav.current = useWorkspaceNavigation(scope);
    navigate.current = useNavigate();
    return null;
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push(root);
  await act(async () =>
    root.render(
      createElement(MemoryRouter, { initialEntries: ["/tasks/test"] }, createElement(Probe)),
    ),
  );
  return { nav, navigate, host };
}
