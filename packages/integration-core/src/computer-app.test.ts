import { createIntegrationId } from "./ids.js";
import { computerAppTools } from "./computer-app-tools.js";
import { describe, expect, it } from "vitest";
import {
  computerAppIdentitiesEqual,
  type ComputerAppDefinition,
  type ComputerAppIdentity,
} from "./computer-app.js";

const notes: ComputerAppIdentity = {
  bundleId: "com.apple.Notes",
  displayName: "Notes",
  teamId: "ABCDEFGHIJ",
};

describe("computerAppIdentitiesEqual", () => {
  it("normalizes bundle-id case but keeps the reviewed name and signing team exact", () => {
    expect(computerAppIdentitiesEqual(notes, { ...notes, bundleId: "COM.APPLE.NOTES" })).toBe(true);
    expect(computerAppIdentitiesEqual(notes, { ...notes, displayName: "Other Notes" })).toBe(false);
    expect(computerAppIdentitiesEqual(notes, { ...notes, teamId: "KLMNOPQRST" })).toBe(false);
    expect(computerAppIdentitiesEqual(notes, null)).toBe(false);
  });
});

describe("computer app tool authority", () => {
  it("returns no rows for a blocked connection and caps read access", () => {
    const definition: ComputerAppDefinition = {
      id: "macos-app",
      name: "Computer use",
      description: "Apps",
      provider: "apple",
      adapter: "computer",
      authMethods: [{ id: "computer", kind: "computer", label: "This Mac" }],
      config: {
        kind: "gui",
        platforms: ["darwin"],
        accessLabels: { read: "Can see", readWrite: "Can see and control" },
        accessSummaries: { read: "Observe", readWrite: "Act" },
        operations: [
          {
            name: "observe",
            title: "Observe",
            description: "Observe",
            effect: "read",
            inputSchema: {},
            outputSchema: null,
          },
          {
            name: "act",
            title: "Act",
            description: "Act",
            effect: "write",
            inputSchema: {},
            outputSchema: null,
          },
        ],
      },
    };
    const connectionId = createIntegrationId("connection");
    expect(
      computerAppTools(definition, "read-write", connectionId, "2026-09-22T00:00:00Z"),
    ).toEqual([]);
    expect(computerAppTools(definition, "read", connectionId).map(({ name }) => name)).toEqual([
      "observe",
    ]);
    expect(
      computerAppTools(definition, "read-write", connectionId).map(({ name }) => name),
    ).toEqual(["observe", "act"]);
  });
});
