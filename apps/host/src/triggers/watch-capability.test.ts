import { createId, OpensteerError } from "@opensteer/core";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { SignedTokenService } from "../identity/host-keys.js";
import { WatchControlTokenService } from "./watch-capability.js";

describe("WatchControlTokenService", () => {
  it("issues a 24-hour activation scope without Runner boot authority and rechecks storage", async () => {
    let active = true;
    const assertActiveWatchBinding = vi.fn(async () => {
      if (!active) throw new OpensteerError({ code: "forbidden", message: "Watch was stopped" });
    });
    const service = new WatchControlTokenService({
      store: { assertActiveWatchBinding },
      tokens: new SignedTokenService(generateKeyPairSync("ed25519"), {
        deploymentId: createId("deployment"),
        hostInstanceId: createId("hostInstance"),
      }),
    });
    const scope = {
      activationId: createId("triggerWatchActivation"),
      anchorThreadId: createId("thread"),
      createdBy: createId("user"),
      environmentId: createId("environment"),
      executionGeneration: 4,
      membershipGeneration: 2,
      revisionId: createId("triggerRevision"),
      triggerId: createId("trigger"),
      toolContractVersion: 2,
      workspaceId: createId("workspace"),
    } as const;

    const issuedAt = Date.now();
    const issued = service.issue(scope);
    expect(Date.parse(issued.expiresAt) - issuedAt).toBeGreaterThan(23 * 60 * 60 * 1_000);
    const claims = await service.authenticate(issued.token);
    expect(claims).toMatchObject({ ...scope, aud: "opensteer-watch-control" });
    expect(claims).not.toHaveProperty("runnerBootId");
    expect(assertActiveWatchBinding).toHaveBeenCalledWith(expect.objectContaining(scope));

    active = false;
    await expect(service.authenticate(issued.token)).rejects.toMatchObject({ code: "forbidden" });
  });
});
