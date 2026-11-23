import { describe, expect, it } from "vitest";
import { chatTasksWithdrawnMessage, tasksWithdrawnMessage } from "./resource-access.js";

/** A refusal reaches a person through a task's transcript: it says "your own agents". */
describe("the words a refusal of tasks uses", () => {
  it("names your own agents, for a connected agent and for a chat", () => {
    expect(tasksWithdrawnMessage).toBe(
      "This connected agent may no longer ask your own agents to work.",
    );
    expect(chatTasksWithdrawnMessage).toBe("This chat may no longer ask your own agents to work.");
  });
});
