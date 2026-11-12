import { randomUUID } from "node:crypto";
import { createId, HarnessIdSchema, ThreadAccessModeSchema } from "@opensteer/core";
import type { RunnerDescriptor } from "@opensteer/protocol";

export function testRunnerDescriptor(input: {
  readonly environmentId: ReturnType<typeof createId<"environment">>;
  /** What this boot advertises; the full agents machine unless a caller says otherwise. */
  readonly modules?: RunnerDescriptor["modules"];
  readonly name: string;
  readonly runnerId: ReturnType<typeof createId<"runner">>;
  readonly runnerKind: "main" | "local" | "managed";
}): RunnerDescriptor {
  return {
    bootId: `rbt_${randomUUID()}` as RunnerDescriptor["bootId"],
    capabilities: ["filesystem"],
    modules: input.modules ?? {
      agents: {
        environmentIds: [input.environmentId],
        harnessDrivers: [
          {
            accessModes: ThreadAccessModeSchema.options,
            driverKind: HarnessIdSchema.parse("native"),
            readiness: "configured",
            steering: true,
            sources: [
              {
                fields: [],
                kind: "first-party",
                label: "Native",
                quota: "none",
                sourceId: "native",
                stateKinds: ["isolated"],
              },
            ],
          },
        ],
        maxConcurrentRuns: 4,
        providerStateModes: ["isolated"],
      },
    },
    name: input.name,
    runnerId: input.runnerId,
    runnerKind: input.runnerKind,
    runtimeVersion: "test",
  };
}
