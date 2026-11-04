import { describe, expect, it } from "vitest";
import { createId } from "@opensteer/core";
import { hostApi } from "./host-api.js";
import { RunnerSkillMetadataReportSchema } from "./runner-skill-metadata.js";
import { PluginTargetSchema } from "./settings.js";

describe("Settings authority inputs", () => {
  it("rejects session associations, injected authority, invalid branded IDs and overview paging", () => {
    expect(
      PluginTargetSchema.safeParse({ kind: "skill", workspaceId: "other", fullName: "skill" })
        .success,
    ).toBe(false);
    expect(
      PluginTargetSchema.safeParse({
        kind: "service",
        definitionId: "gmail",
        ownerUserId: createId("user"),
      }).success,
    ).toBe(false);
    expect(hostApi["plugins.overview.get"].payload.safeParse({ cursor: "page" }).success).toBe(
      false,
    );
    expect(
      hostApi["commands.dispatch"].payload.safeParse({
        type: "session.computer.associate",
        idempotencyKey: "test",
      }).success,
    ).toBe(false);
  });
  it("requires complete owner fences and separates a failed scan from an empty replacement", () => {
    const report = {
      type: "runner.skills.report",
      runnerId: createId("runner"),
      bootId: "rbt_00000000-0000-4000-8000-000000000001",
      connectionId: "rcn_00000000-0000-4000-8000-000000000001",
      connectionLeaseId: "rls_00000000-0000-4000-8000-000000000001",
      connectionGeneration: 1,
      environmentId: createId("environment"),
      storageAuthorityId: createId("storageAuthority"),
      binding: {
        bindingId: createId("workspaceBinding"),
        generation: 1,
        ownerEnvironmentId: createId("environment"),
        storageAuthorityId: createId("storageAuthority"),
        workspaceId: createId("workspace"),
      },
      scanSequence: 1,
      scannedAt: "2026-11-03T12:00:00.000Z",
      result: { status: "complete", skills: [], warnings: [] },
    };
    expect(RunnerSkillMetadataReportSchema.safeParse(report).success).toBe(true);
    expect(
      RunnerSkillMetadataReportSchema.safeParse({ ...report, connectionLeaseId: undefined })
        .success,
    ).toBe(false);
    expect(
      RunnerSkillMetadataReportSchema.safeParse({
        ...report,
        result: { status: "failed", reason: "unreadable" },
      }).success,
    ).toBe(true);
    expect(
      RunnerSkillMetadataReportSchema.safeParse({
        ...report,
        result: {
          status: "complete",
          skills: [
            { fullName: "x", description: "x", digest: "a".repeat(64), path: "/private/file" },
          ],
          warnings: [],
        },
      }).success,
    ).toBe(false);
  });
});
