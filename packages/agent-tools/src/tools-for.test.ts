import { AgentGrantSchema, createId } from "@opensteer/core";
import { expect, it } from "vitest";
import { toolsFor } from "./tools-for.js";

it("offers discovery for both browser grants and reserves saved fills for profiles", () => {
  const offered = (resource: unknown) =>
    toolsFor({
      kind: "connection",
      accessMode: "full-access",
      grant: AgentGrantSchema.parse({ scope: "selected", tasks: false, resources: [resource] }),
    })
      .map(({ name }) => name)
      .sort();
  expect(offered({ kind: "chrome-tabs", sourceId: createId("browserSource") })).toEqual([
    "ask_person",
    "browser_connect",
    "browser_use",
    "discover",
  ]);
  expect(offered({ kind: "browser-profile", profileId: createId("browserProfile") })).toEqual([
    "ask_person",
    "browser_connect",
    "browser_use",
    "card_request",
    "discover",
    "saved_login_request",
  ]);
});

it("offers no automation to work without the person's personal context", () => {
  const names = (personalContext: boolean) =>
    toolsFor({
      kind: "run",
      accessMode: "full-access",
      grant: { scope: "selected", tasks: true, resources: [] },
      personalContext,
    })
      .map(({ name }) => name)
      .filter((name) => name.startsWith("opensteer_automation_"));
  expect(names(true)).toContain("opensteer_automation_create");
  expect(names(false)).toEqual([]);
});
