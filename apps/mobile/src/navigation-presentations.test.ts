import { describe, expect, it } from "vitest";
import { layoutRoute, presentedFrom } from "./navigation-presentations.js";

/*
 * Where the presented flow over the stack begins. What can go wrong: a sheet
 * or modal missing from the table, or a page pushed inside a modal, is taken
 * for a screen of the stack, so leaving the flow strands part of it, or the
 * layout and the sidebar follow a page the shell does not hold.
 */

function stack(...names: readonly string[]) {
  return { index: names.length - 1, routes: names.map((name) => ({ name })) };
}

describe("the presented flow", () => {
  it("starts at the first sheet or modal, and takes in every page pushed inside it", () => {
    expect(presentedFrom(stack("Home", "Thread"))).toBe(-1);
    expect(presentedFrom(stack("Home", "Thread", "Settings", "SettingsDevices"))).toBe(2);
    expect(presentedFrom(stack("Home", "QuietlyMoved"))).toBe(1);
    expect(presentedFrom(stack("Home", "AddDeployment", "AddServer"))).toBe(1);
    expect(presentedFrom(stack("Home", "AgentAuthorization"))).toBe(1);
  });

  it("leaves the screen beneath it in charge of the layout", () => {
    expect(layoutRoute(stack("Home", "Thread"))?.name).toBe("Thread");
    expect(layoutRoute(stack("Home", "Thread", "Settings", "SettingsDevices"))?.name).toBe(
      "Thread",
    );
    expect(layoutRoute(stack("Home", "Thread", "ThreadAround"))?.name).toBe("Thread");
  });
});
