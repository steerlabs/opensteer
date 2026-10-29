import { describe, expect, it } from "vitest";
import { searchIntegrationInventory, type IntegrationSearchable } from "./search.js";

const gmail = integration({
  description: "Search, read, draft, and send email through Google accounts.",
  name: "gmail",
  provider: "google",
  title: "Gmail",
  toolDescriptions: ["Search Gmail inbox messages", "Read one Gmail message"],
});
const outlook = integration({
  description: "Read mail from Microsoft Outlook accounts.",
  name: "outlook-email",
  provider: "microsoft-graph",
  title: "Outlook Email",
  toolDescriptions: ["Search an Outlook mailbox"],
});
const crm = integration({
  description: "Look up customer records.",
  name: "tinycrm",
  provider: "tinycrm",
  title: "TinyCRM",
  toolDescriptions: ["Search customers"],
});

describe("integration inventory search", () => {
  it.each([
    "Gmail",
    "Gmail unread mail",
    "Gmail read latest inbox emails",
    "Gmail integration connect account and read latest inbox emails",
  ])("keeps an exact integration identity visible inside a task query: %s", (query) => {
    expect(searchIntegrationInventory([crm, gmail, outlook], query, 10)).toEqual([gmail]);
  });

  it("uses tool and integration descriptions when the user does not name a provider", () => {
    expect(searchIntegrationInventory([crm, gmail], "read my latest inbox emails", 10)).toEqual([
      gmail,
    ]);
  });

  it("returns every plausible account provider so ambiguity remains visible", () => {
    expect(searchIntegrationInventory([crm, gmail, outlook], "search my email", 10)).toEqual([
      outlook,
      gmail,
    ]);
  });

  it("does not manufacture a match for an unrelated task", () => {
    expect(searchIntegrationInventory([crm, gmail, outlook], "deploy a website", 10)).toEqual([]);
  });
});

function integration(input: {
  readonly description: string;
  readonly name: string;
  readonly provider: string;
  readonly title: string;
  readonly toolDescriptions: readonly string[];
}): IntegrationSearchable {
  return {
    installation: {
      description: input.description,
      name: input.name,
      title: input.title,
    },
    servers: [
      { connectionRequirement: { kind: "provider", provider: input.provider }, name: input.name },
    ],
    skills: [],
    tools: input.toolDescriptions.map((description, index) => ({
      description,
      name: index === 0 ? "search" : "read",
      title: description,
    })),
  };
}
