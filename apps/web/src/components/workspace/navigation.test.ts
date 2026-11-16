// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
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

afterEach(() => localStorage.clear());

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
