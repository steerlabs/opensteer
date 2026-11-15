import { expect, it } from "vitest";
import { deploymentSettled } from "./kubernetes.js";

it("holds the fleet until the observed replacement is available and every old pod is gone", () => {
  const ready = {
    observedGeneration: 2,
    replicas: 1,
    readyReplicas: 1,
    updatedReplicas: 1,
    availableReplicas: 1,
  };
  expect(deploymentSettled(2, 1, ready, false)).toBe(true);
  for (const change of [
    { observedGeneration: 1 },
    { replicas: 2 },
    { updatedReplicas: 0 },
    { availableReplicas: 0 },
    { terminatingReplicas: 1 },
  ]) {
    expect(deploymentSettled(2, 1, { ...ready, ...change }, false)).toBe(false);
  }
  expect(deploymentSettled(2, 1, ready, true)).toBe(false);
  expect(deploymentSettled(2, 0, { observedGeneration: 2 }, false)).toBe(true);
  expect(deploymentSettled(2, 0, { observedGeneration: 2 }, true)).toBe(false);
});
