import { expect, it } from "vitest";
import { computerConnectionCommands, runnerImageReference } from "./connection-commands.js";
it("uses the caller's release image and keeps each enrollment in its own storage", () => {
  const revision = "a".repeat(40);
  const result = computerConnectionCommands({
    deploymentShape: { kind: "team" },
    enrollmentId: "ren_9f3c1d20-7a44-4c11-8b02-6d5e8f0a1b2c",
    hostOrigin: "https://host.example",
    name: "My Mac",
    token: "test-token",
    runnerDistribution: null,
    runnerImage: runnerImageReference(revision, "registry.example/opensteer"),
  });
  expect(result.bareHost).toBeNull();
  expect(result.container).toContain(`registry.example/opensteer/runner:sha-${revision}`);
  expect(result.container).toContain("opensteer-computer-9f3c1d207a444c118b026d5e8f0a1b2c");
});
