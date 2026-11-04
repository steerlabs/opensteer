import { integrationMark } from "../packages/client/src/integrations/bundled-icons.js";
import { catalogProducts } from "../packages/integration-catalog/src/index.js";
import { describe, expect, it } from "vitest";

/** Brands Simple Icons does not carry; they wear initials until their owners' artwork is added. */
const awaitingArtwork = [
  "axiom-mcp",
  "browserbase-mcp",
  "context7-mcp",
  "deepwiki-mcp",
  "exa-rest",
  "exa-websets-rest",
  "firecrawl-rest",
  "microsoft-contacts",
  "microsoft-onedrive",
  "microsoft-onenote",
  "microsoft-outlook-calendar",
  "microsoft-outlook-mail",
  "microsoft-profile",
  "microsoft-teams-chat",
  "microsoft-todo",
  "monday-graphql",
  "openai-rest",
  "twilio-rest",
  "val-town-rest",
];

describe("integration marks", () => {
  it("draws every catalog product with one mark across its ways in", () => {
    const unmarked: string[] = [];
    for (const { definitionIds } of catalogProducts) {
      const marks = definitionIds.map((id) => integrationMark(id));
      if (marks[0] === null) unmarked.push(...definitionIds);
      for (const mark of marks) expect(mark, definitionIds.join()).toEqual(marks[0]);
    }
    expect(unmarked.sort()).toEqual(awaitingArtwork);
  });
});
