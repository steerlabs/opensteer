import { createId } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import type { WatchControlScope } from "./watch-capability.js";
import { WatchProgramService } from "./watch-program-service.js";

describe("WatchProgramService", () => {
  it("serves only the immutable revision named by the live activation token", async () => {
    const revisionId = createId("triggerRevision");
    const claims: WatchControlScope = {
      activationId: createId("triggerWatchActivation"),
      anchorThreadId: createId("thread"),
      aud: "opensteer-watch-control",
      createdBy: createId("user"),
      environmentId: createId("environment"),
      executionGeneration: 1,
      exp: Math.floor(Date.now() / 1_000) + 60,
      iat: Math.floor(Date.now() / 1_000),
      iss: "opensteer-host",
      jti: crypto.randomUUID(),
      membershipGeneration: 1,
      revisionId,
      triggerId: createId("trigger"),
      toolContractVersion: 2,
      workspaceId: createId("workspace"),
    };
    const program = {
      language: "javascript",
      source: "export default async () => {}",
      toolContractVersion: 2,
    } as const;
    const watchProgram = vi.fn(async () => program);
    const service = new WatchProgramService({
      store: { watchProgram },
      tokens: { authenticate: async () => claims },
    });

    await expect(service.get("token", revisionId)).resolves.toEqual(program);
    expect(watchProgram).toHaveBeenCalledWith(claims);
    await expect(service.get("token", createId("triggerRevision"))).rejects.toThrow(
      "does not grant this Trigger revision",
    );
  });
});
