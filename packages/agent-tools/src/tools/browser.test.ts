import { createId, type AgentGrant, type BrowserProfileId } from "@opensteer/core";
import { expect, it } from "vitest";
import { toolsFor } from "../index.js";
import { browser_connect, browser_use } from "./browser.js";

const profile = createId("browserProfile") as BrowserProfileId;
const names = (tools: readonly { readonly name: string }[]) => tools.map(({ name }) => name);

it("offers the browser primitives only to a connection whose grant holds a browser profile", () => {
  const withProfile: AgentGrant = {
    scope: "selected",
    tasks: false,
    resources: [{ kind: "browser-profile", profileId: profile }],
  };
  const tasksOnly: AgentGrant = { scope: "selected", tasks: true, resources: [] };
  for (const accessMode of ["approval-required", "auto", "full-access"] as const) {
    expect(names(toolsFor({ kind: "connection", accessMode, grant: withProfile }))).toEqual(
      expect.arrayContaining(["browser_use", "browser_connect"]),
    );
    expect(names(toolsFor({ kind: "connection", accessMode, grant: tasksOnly }))).not.toContain(
      "browser_use",
    );
    expect(names(toolsFor({ kind: "connection", accessMode, grant: tasksOnly }))).not.toContain(
      "browser_connect",
    );
  }
});

it("leaves native agents on their own Browser Harness", () => {
  for (const kind of ["run", "program"] as const) {
    const offered = names(toolsFor({ kind, accessMode: "full-access" }));
    expect(offered).not.toContain("browser_use");
    expect(offered).not.toContain("browser_connect");
  }
});

it("takes a place and the direct-work fields, nothing else", () => {
  const taskId = createId("thread");
  expect(
    browser_use.input.parse({ code: "print(1)", profileId: profile, taskId, operationKey: "k" }),
  ).toEqual({ code: "print(1)", profileId: profile, taskId, operationKey: "k" });
  expect(browser_use.input.safeParse({ code: "" }).success).toBe(false);
  expect(
    browser_connect.input.safeParse({ profileId: profile, mode: "whole-context" }).success,
  ).toBe(false);
  expect(browser_connect.input.safeParse({ profileId: "Guest" }).success).toBe(false);
});
