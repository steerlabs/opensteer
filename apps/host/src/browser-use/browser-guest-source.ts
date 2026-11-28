import { readFileSync } from "node:fs";

export const browserGuestModuleNames = [
  "page.mjs",
  "page-functions.mjs",
  "keyboard-layout.mjs",
] as const;
declare const __OPENSTEER_BROWSER_GUEST_MODULES__: ReturnType<typeof readBrowserGuestModules>;

export function readBrowserGuestModules(): Readonly<Record<string, string>> {
  return Object.fromEntries(
    browserGuestModuleNames.map((name) => [
      name,
      readFileSync(new URL(`../../../runner/browser-harness/${name}`, import.meta.url), "utf8"),
    ]),
  );
}

export function browserGuestModules(): Readonly<Record<string, string>> {
  return typeof __OPENSTEER_BROWSER_GUEST_MODULES__ === "undefined"
    ? readBrowserGuestModules()
    : __OPENSTEER_BROWSER_GUEST_MODULES__;
}
