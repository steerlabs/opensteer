import { AgentGrantSchema, createId } from "@opensteer/core";
import { expect, it } from "vitest";
import { toolsFor } from "./tools-for.js";

it("reserves profile listing and saved fills for saved profiles", () => {
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
    "tab_list",
  ]);
  expect(offered({ kind: "browser-profile", profileId: createId("browserProfile") })).toEqual([
    "ask_person",
    "browser_connect",
    "browser_profile_list",
    "browser_use",
    "card_request",
    "saved_login_request",
    "tab_list",
  ]);
});
