import { expect, it } from "vitest";
import { mentionFinder, mentionRuns } from "./mentions.js";
import type { MentionView } from "./team-models.js";

const maya: MentionView = { handle: "maya", kind: "person", label: "@Maya Chen" };
const mayasAgent: MentionView = {
  handle: "maya-agent",
  kind: "agent-inert",
  label: "@Maya's agent",
};

it("reads an agent's handle whole, never as its owner's handle and a stray suffix", () => {
  const finder = mentionFinder([maya, mayasAgent])!;
  expect(
    mentionRuns("ask @maya-agent, or @Maya's team; not @maya-agents or me@maya", finder),
  ).toEqual(["ask ", mayasAgent, ", or ", maya, "'s team; not @maya-agents or me@maya"]);
});
