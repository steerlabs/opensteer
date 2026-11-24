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
    "opensteer_command",
    "opensteer_commands",
    "opensteer_state",
  ]);
  expect(offered({ kind: "browser-profile", profileId: createId("browserProfile") })).toEqual([
    "ask_person",
    "browser_connect",
    "browser_use",
    "card_request",
    "discover",
    "opensteer_command",
    "opensteer_commands",
    "opensteer_state",
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

it("offers local servers only to your own agents: a folder package is never a connection's (B8)", () => {
  const names = (grant?: { readonly scope: "everything" }) =>
    toolsFor({
      kind: "run",
      accessMode: "full-access",
      ...(grant ? { grant } : {}),
      personalContext: true,
    })
      .map(({ name }) => name)
      .filter((name) => name.startsWith("local_server_"));
  // Your own Full agent: all of them.
  expect(names()).toEqual(
    expect.arrayContaining(["local_server_add", "local_server_list", "local_server_remove"]),
  );
  // A Run under an Everything connection at Full: what runs outside its Disconnect set is not
  // its to add or remove (the table's plugins.install folder source is your own agents' only).
  expect(names({ scope: "everything" })).toEqual(["local_server_list"]);
});
