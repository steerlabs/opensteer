// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { TabIdSchema } from "@opensteer/core";
import {
  placeAddress,
  placeSelection,
  rememberPlace,
  rememberedPlace,
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
