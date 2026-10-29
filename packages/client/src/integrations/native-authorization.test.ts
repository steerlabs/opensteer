import { createId } from "@opensteer/core";
import { createIntegrationId } from "@opensteer/integration-core";
import { describe, expect, it, vi } from "vitest";
import {
  buildNativeIntegrationAuthorizationCallback,
  opensteerMobileIntegrationAuthorizationCallback,
  parseNativeIntegrationAuthorizationCallback,
  waitForIntegrationAuthorization,
} from "./native-authorization.js";

describe("native integration authorization", () => {
  it.each(["oauthAttempt", "mcpOauthAttempt"] as const)(
    "round trips an opaque %s identifier",
    (kind) => {
      const value = {
        attemptId: createIntegrationId(kind),
        deploymentId: createId("deployment"),
      };
      const callback = buildNativeIntegrationAuthorizationCallback(value);
      expect(parseNativeIntegrationAuthorizationCallback(callback)).toEqual(value);
      expect(callback).toBe(
        `${opensteerMobileIntegrationAuthorizationCallback}?deployment_id=${value.deploymentId}&attempt_id=${value.attemptId}`,
      );
      expect(callback).not.toMatch(/ticket|code|token|host|success/iu);
    },
  );

  it.each([
    "https://example.test/oauth/integration-callback?deployment_id=dep_x&attempt_id=ioa_x",
    "com.opensteer.mobile://evil/oauth/integration-callback?deployment_id=dep_x&attempt_id=ioa_x",
    `${opensteerMobileIntegrationAuthorizationCallback}?deployment_id=dep_x&attempt_id=ioa_x&success=true`,
    `${opensteerMobileIntegrationAuthorizationCallback}?deployment_id=dep_x&deployment_id=dep_y&attempt_id=ioa_x`,
    `${opensteerMobileIntegrationAuthorizationCallback}#attempt_id=ioa_x`,
  ])("rejects an untrusted callback shape: %s", (callback) => {
    expect(parseNativeIntegrationAuthorizationCallback(callback)).toBeNull();
  });

  it("treats the durable Host status as the only success channel", async () => {
    const attemptId = createIntegrationId("oauthAttempt");
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        data: {
          connectionId: null,
          expiresAt: "2026-09-18T00:00:00.000Z",
          failureCode: null,
          status: "launched",
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          connectionId: createIntegrationId("connection"),
          expiresAt: "2026-09-18T00:00:00.000Z",
          failureCode: null,
          status: "completed",
        },
      });
    const result = await waitForIntegrationAuthorization({
      attemptId,
      client: { rpc: { "integration.authorization.get": rpc } },
      expiresAt: "2026-09-18T00:00:00.000Z",
      now: () => new Date("2026-09-17T00:00:00.000Z").getTime(),
      sleep: async () => undefined,
    });
    expect(result.status).toBe("completed");
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});
