// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { placeAddress, placeSelection, rememberPlace, rememberedPlace } from "./navigation.js";

const destination = {
  kind: "opensteer-app",
  appId: "app_11111111-1111-4111-8111-111111111111",
} as const;
const scope = { deploymentId: "deployment", userId: "user" };

afterEach(() => localStorage.clear());

it("names an app tab in the address and refuses a malformed app id", () => {
  expect(placeSelection(new URLSearchParams(placeAddress(destination)))).toEqual({
    kind: "place",
    destination,
  });
  for (const appId of ["app_1", "../settings", `${destination.appId}&browser=x`])
    expect(placeSelection(new URLSearchParams({ panel: "browser", opensteerApp: appId }))).toEqual({
      kind: "launcher",
    });
});

it("remembers an app tab and refuses a forged memory of one", () => {
  rememberPlace(scope, destination);
  expect(rememberedPlace(scope)).toEqual(destination);
  const [key] = Object.keys(localStorage);
  localStorage.setItem(key!, JSON.stringify({ kind: "opensteer-app", appId: "../settings" }));
  expect(rememberedPlace(scope)).toBeNull();
});
