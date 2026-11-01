import { describe, expect, it } from "vitest";
import { hostApi } from "./host-api.js";
import { RunnerHarnessDriverSchema } from "./runner.js";

describe("runner installed-engine compatibility", () => {
  it("accepts an old Runner advertisement without installation maintenance", () => {
    expect(
      RunnerHarnessDriverSchema.parse({
        accessModes: ["full-access"],
        driverKind: "codex",
        readiness: "runtime-check",
        sources: [
          {
            kind: "first-party",
            label: "OpenAI",
            quota: "none",
            sourceId: "openai",
            stateKinds: ["ambient"],
          },
        ],
      }),
    ).not.toHaveProperty("installation");
  });

  it("keeps repair information on an unavailable driver", () => {
    expect(
      RunnerHarnessDriverSchema.parse({
        driverKind: "claude",
        installation: {
          latestVersion: "2.1.316",
          scope: "all",
          update: "available",
          version: "2.1.200",
        },
        readiness: "unavailable",
        reason: "Claude Code is too old",
      }).installation,
    ).toMatchObject({ update: "available", version: "2.1.200" });
  });

  it("adds the Host update command without changing old Runner advertisements", () => {
    expect(
      hostApi["commands.dispatch"].payload.parse({
        driverKind: "codex",
        environmentId: "env_00000000-0000-4000-8000-000000000001",
        idempotencyKey: "update-codex",
        type: "harness.update",
      }),
    ).toMatchObject({ driverKind: "codex", type: "harness.update" });
  });
});
