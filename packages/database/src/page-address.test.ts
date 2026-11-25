import { ThisHomeAddressSet } from "@opensteer/shared/homeAddress";
import { describe, expect, it } from "vitest";
import { authorizePageAddress, authorizePlaceSite } from "./resource-access.js";

const home = new ThisHomeAddressSet({
  origins: ["https://home.example.com"],
  loopbackPorts: [4310],
});
const connection = { agentConnection: {}, actor: "agent" } as const;
const ownAgent = { agentConnection: null, actor: "native" } as const;
const person = { agentConnection: null, actor: "person" } as const;
const extension = `chrome-extension://${"a".repeat(32)}/options.html`;

describe("authorizePageAddress (rule 1's page rule)", () => {
  const rows: [string, unknown, boolean, boolean, boolean][] = [
    // address, connected agent, the person's own agent, the person
    ["a web page", "https://web.test/", true, true, true],
    ["a dev server on another loopback port", "http://localhost:5173/", true, true, true],
    ["this Home on loopback", "http://127.0.0.1:4310/tasks", false, false, true],
    ["this Home on another loopback name", "http://localhost:4310/", false, false, true],
    ["this Home's canonical origin", "https://home.example.com/settings", false, false, true],
    ["this Home inside view-source:", "view-source:https://home.example.com/", false, false, true],
    ["an extension's page", extension, false, true, true],
  ];
  for (const [name, url, byConnection, byOwnAgent, byPerson] of rows)
    it(name, () => {
      expect(authorizePageAddress(connection, url, home)).toBe(byConnection);
      expect(authorizePageAddress(ownAgent, url, home)).toBe(byOwnAgent);
      expect(authorizePageAddress(person, url, home)).toBe(byPerson);
    });

  it("judges only the extension rule for a recorded place, which keeps a site", () => {
    expect(authorizePlaceSite(connection, { kind: "page", site: "home.example.com" })).toBe(true);
    expect(authorizePlaceSite(connection, { kind: "page", site: extension })).toBe(false);
  });
});
