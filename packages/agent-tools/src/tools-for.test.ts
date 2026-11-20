import { AgentGrantSchema, createId } from "@opensteer/core";
import { expect, it } from "vitest";
import { toolsFor } from "./tools-for.js";

it("offers the same connected browser tools for shared Chrome and saved profiles", () => {
  const offered = (resource: unknown) =>
    toolsFor({
      kind: "connection",
      accessMode: "full-access",
      grant: AgentGrantSchema.parse({ scope: "selected", tasks: false, resources: [resource] }),
    }).map(({ name }) => name);
  const chromeTools = offered({ kind: "chrome-tabs", sourceId: createId("browserSource") });
  expect(chromeTools).toEqual(
    offered({ kind: "browser-profile", profileId: createId("browserProfile") }),
  );
  expect(chromeTools).toEqual(
    expect.arrayContaining(["tab_list", "browser_use", "browser_connect"]),
  );
});
