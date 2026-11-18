import { describe, expect, it } from "vitest";
import { redirectSettingsPath, settingsRedirects } from "./index.js";

describe("Settings models", () => {
  it.each(settingsRedirects)("redirects %s with raw callback selectors", (from, to) => {
    const tail = "?integrationAttempt=a%2Bb&provider=google&workspace=w#computer-app-mail";
    expect(redirectSettingsPath(`${from}${tail}`)).toBe(`${to}${tail}`);
    expect(redirectSettingsPath(`${from}/child${tail}`)).toBe(
      `${to}${to === "/settings/plugins" || to === "/settings/account" ? "" : "/child"}${tail}`,
    );
    expect(redirectSettingsPath(`${from}-other`)).toBe(
      from.startsWith("/settings/apps/") ? "/settings/plugins" : null,
    );
  });
});
