import { createId, ProjectRunBindingSchema } from "@opensteer/core";
import { ProjectCapabilityClaimsSchema } from "@opensteer/protocol";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SignedTokenService } from "../identity/host-keys.js";
import {
  ProjectCapabilityTokenService,
  RunCapabilityTokenService,
  projectCapabilityBinding,
} from "./run-capability.js";

function setup() {
  const workspaceId = createId("workspace");
  const binding = ProjectRunBindingSchema.parse({
    authority: {
      version: 1,
      principal: { kind: "project", principalId: "pri-project-fixture", workspaceId },
      origin: null,
    },
    bindingGeneration: 1,
    environmentId: createId("environment"),
    grantId: createId("grant"),
    runId: createId("run"),
    runnerBootId: `rbt_${randomUUID()}`,
    runnerId: createId("runner"),
    threadId: createId("thread"),
    workspaceId,
  });
  const keys = generateKeyPairSync("ed25519");
  const authority = {
    deploymentId: createId("deployment"),
    hostInstanceId: createId("hostInstance"),
  };
  const tokens = new SignedTokenService(keys, authority, () => 1_800_000_000_000);
  let live = true;
  const service = new ProjectCapabilityTokenService({
    tokens,
    authorizer: {
      async assertProjectBinding(scope) {
        if (!live || JSON.stringify(scope) !== JSON.stringify(binding))
          throw new Error("Binding is no longer current");
      },
    },
  });
  return {
    binding,
    keys,
    authority,
    tokens,
    service,
    revoke: () => {
      live = false;
    },
  };
}

describe("Project Run capabilities", () => {
  it("separates all three audiences and binds every token to the complete immutable origin and live grant", async () => {
    const { binding, service, revoke } = setup();
    const audiences = [
      "opensteer-project-run-tools",
      "opensteer-project-run-attachments",
      "opensteer-project-egress",
    ] as const;
    const issued = await Promise.all(
      audiences.map(async (audience) => ({
        audience,
        token: await service.issue(binding, audience),
      })),
    );
    for (const { audience, token } of issued) {
      const claims = await service.verify(token, audience);
      expect(projectCapabilityBinding(claims)).toEqual(binding);
      expect(claims).not.toHaveProperty("requestedBy");
      expect(claims.authority.origin).toBeNull();
      for (const other of audiences.filter((value) => value !== audience))
        await expect(service.verify(token, other)).rejects.toMatchObject({ code: "unauthorized" });
    }
    revoke();
    for (const { audience, token } of issued)
      await expect(service.verify(token, audience)).rejects.toThrow("Binding is no longer current");
  });

  it("refuses cross-field forgeries, legacy envelopes and a different Host before consulting a binding", async () => {
    const { binding, tokens, keys, authority } = setup();
    let checks = 0;
    const service = new ProjectCapabilityTokenService({
      tokens,
      authorizer: {
        async assertProjectBinding() {
          checks += 1;
        },
      },
    });
    const humanConsumer = new RunCapabilityTokenService({
      audience: "opensteer-run-tools",
      tokens,
      authorizer: {
        async assertActiveGrant() {
          checks += 1;
        },
      },
    });
    const mixed = tokens.issue(
      {
        ...binding,
        aud: "opensteer-run-tools",
        requestedBy: createId("user"),
        membershipGeneration: 1,
      },
      60,
    );
    await expect(humanConsumer.authenticate(mixed)).rejects.toMatchObject({ code: "unauthorized" });
    const audience = "opensteer-project-run-tools";
    const forged = tokens.issue(
      { ...binding, workspaceId: createId("workspace"), aud: audience },
      60,
    );
    await expect(service.verify(forged, audience)).rejects.toMatchObject({ code: "unauthorized" });
    const legacy = tokens.issue(
      {
        ...binding,
        authority: undefined,
        requestedBy: createId("user"),
        membershipGeneration: 1,
        aud: "opensteer-run-tools",
      },
      60,
    );
    await expect(service.verify(legacy, audience)).rejects.toMatchObject({ code: "unauthorized" });
    const otherHost = new SignedTokenService(
      keys,
      { ...authority, hostInstanceId: createId("hostInstance") },
      () => 1_800_000_000_000,
    );
    await expect(
      service.verify(otherHost.issue({ ...binding, aud: audience }, 60), audience),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(checks).toBe(0);
    expect(
      ProjectCapabilityClaimsSchema.safeParse({
        ...binding,
        workspaceId: createId("workspace"),
        ...authority,
        aud: audience,
        exp: 1_800_000_060,
        iat: 1_800_000_000,
        iss: "opensteer-host",
        jti: randomUUID(),
      }).success,
    ).toBe(false);
  });
});
