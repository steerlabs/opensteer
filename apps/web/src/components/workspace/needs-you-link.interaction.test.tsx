// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { needsYouSearchParam } from "../app-shell.js";
import { history, mount, until } from "./workspace.interaction.test-support.js";

describe("the Mac menu bar's Needs you", () => {
  it("opens Home with Needs you showing, and leaves the address clean", async () => {
    await mount({ pathname: "/", search: `?${needsYouSearchParam}` });
    await until("Needs you never opened", () => {
      expect(document.querySelector('ul[aria-label="Needs you"]')).not.toBeNull();
    });
    expect(history.at(-1)).toMatchObject({ path: "/", search: "" });
  });
});
