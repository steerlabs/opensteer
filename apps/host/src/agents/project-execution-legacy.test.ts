import { createId, GrantIdSchema, RunnerIdSchema, OpensteerError } from "@opensteer/core";
import { ProjectCapabilityScopeSchema, RunnerCommandSchema } from "@opensteer/protocol";
import {
  legacyExecuteRunFixture,
  legacyRunCapabilityScopeFixture,
} from "./legacy-execution-fixture.test-support.js";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SignedTokenClaimsSchema, SignedTokenService } from "../identity/host-keys.js";
import { RunCapabilityTokenService } from "./run-capability.js";

describe("legacy execution compatibility", () => {
  it("retains the old serialized command and user capability fields", async () => {
    const command = RunnerCommandSchema.parse(legacyExecuteRunFixture);
    expect(JSON.stringify(command)).toBe(JSON.stringify(legacyExecuteRunFixture));
    if (command.type !== "run.execute") throw new Error("Expected the legacy execution variant");
    const authority = {
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance"),
    };
    const tokens = new SignedTokenService(
      generateKeyPairSync("ed25519"),
      authority,
      () => 1_800_000_000_000,
    );
    const service = new RunCapabilityTokenService({
      audience: "opensteer-run-tools",
      authorizer: { async assertActiveGrant() {} },
      tokens,
    });
    const scope = {
      ...legacyRunCapabilityScopeFixture,
      environmentId: command.context.environmentId,
      grantId: GrantIdSchema.parse(legacyRunCapabilityScopeFixture.grantId),
      requestedBy: command.context.requestedBy,
      runId: command.context.runId,
      runnerId: RunnerIdSchema.parse(legacyRunCapabilityScopeFixture.runnerId),
      threadId: command.context.threadId,
      workspaceId: command.context.workspaceId,
    };
    const claims = await service.authenticate(service.issue(scope));
    const { aud, deploymentId, exp, hostInstanceId, iat, iss, jti, ...binding } = {
      ...claims,
      ...SignedTokenClaimsSchema.parse(claims),
    };
    expect(JSON.stringify(binding)).toBe(JSON.stringify(legacyRunCapabilityScopeFixture));
    expect({ aud, deploymentId, exp, hostInstanceId, iat, iss, jti }).toEqual({
      ...authority,
      aud: "opensteer-run-tools",
      exp: 1_800_086_400,
      iat: 1_800_000_000,
      iss: "opensteer-host",
      jti: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    });
  });

  it("refuses signed Project audiences and nullable human roots before any binding query", async () => {
    const tokens = new SignedTokenService(generateKeyPairSync("ed25519"), {
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance"),
    });
    let bindingQueries = 0;
    const service = new RunCapabilityTokenService({
      audience: "opensteer-run-tools",
      authorizer: {
        async assertActiveGrant() {
          bindingQueries += 1;
          throw new Error("Project credentials reached the legacy query path");
        },
      },
      tokens,
    });
    const {
      requestedBy: _requester,
      membershipGeneration: _generation,
      ...binding
    } = legacyRunCapabilityScopeFixture;
    const project = ProjectCapabilityScopeSchema.parse({
      ...binding,
      authority: {
        version: 1,
        principal: {
          kind: "project",
          workspaceId: binding.workspaceId,
          principalId: "principal:project:fixture",
        },
        origin: null,
      },
    });
    for (const aud of [
      "opensteer-project-run-tools",
      "opensteer-project-run-attachments",
      "opensteer-project-egress",
      "opensteer-run-tools",
    ])
      await expect(
        service.authenticate(tokens.issue({ ...project, aud }, 60)),
      ).rejects.toMatchObject({ code: "unauthorized" });
    await expect(
      service.authenticate(
        tokens.issue(
          { ...binding, requestedBy: null, membershipGeneration: null, aud: "opensteer-run-tools" },
          60,
        ),
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(bindingQueries).toBe(0);
    expect(
      RunnerCommandSchema.safeParse({ ...legacyExecuteRunFixture, type: "run.execute.project" })
        .success,
    ).toBe(false);
    expect(
      RunnerCommandSchema.safeParse({
        ...legacyExecuteRunFixture,
        context: { ...legacyExecuteRunFixture.context, authority: project.authority },
      }).success,
    ).toBe(false);
  });

  it("never retries a failed live-binding verification as a different caller", async () => {
    const tokens = new SignedTokenService(generateKeyPairSync("ed25519"), {
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance"),
    });
    let bindingQueries = 0;
    const service = new RunCapabilityTokenService({
      audience: "opensteer-run-tools",
      authorizer: {
        async assertActiveGrant() {
          bindingQueries += 1;
          throw new OpensteerError({ code: "forbidden", message: "Binding revoked" });
        },
      },
      tokens,
    });
    await expect(
      service.authenticate(
        tokens.issue({ ...legacyRunCapabilityScopeFixture, aud: "opensteer-run-tools" }, 60),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(bindingQueries).toBe(1);
  });
});
