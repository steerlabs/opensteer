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
