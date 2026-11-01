import { createBrowsingChoiceStorage } from "./browsing-choice-storage.js";
import { BrowserPreferences } from "@opensteer/client/host";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("mobile Host bundle boundary", () => {
  it("persists only explicit browsing identities and scopes them to the viewer", () => {
    let value = "{}";
    const storage = createBrowsingChoiceStorage({
      exists: true,
      get size() {
        return value.length;
      },
      textSync: () => value,
      create: () => {},
      writeSync: (next) => {
        value = next;
      },
    });
    const preferences = new BrowserPreferences(storage);
    preferences.setScope({ deploymentId: "deployment", userId: "alice" });
    preferences.lastBrowsingChoice = { kind: "profile", profileId: "profile" };
    const reopened = new BrowserPreferences(storage);
    reopened.setScope({ deploymentId: "deployment", userId: "alice" });
    expect(reopened.lastBrowsingChoice).toEqual({ kind: "profile", profileId: "profile" });
    reopened.setScope({ deploymentId: "deployment", userId: "bob" });
    expect(reopened.lastBrowsingChoice).toBeNull();
    storage.setItem("opensteer.browsing-history.v2:private", "private URL");
    expect(value).not.toContain("private URL");
    value = "invalid";
    expect(reopened.lastBrowsingChoice).toBeNull();
  });
  it("keeps the network Host port independent of the mock client", () => {
    const source = readFileSync(new URL("./host-port.ts", import.meta.url), "utf8");
    expect(source).not.toContain("@opensteer/client/mock");
  });
});
