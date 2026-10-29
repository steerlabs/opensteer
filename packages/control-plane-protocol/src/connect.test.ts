import { createId } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { ProvisionConnectRequestSchema, RotateConnectCredentialRequestSchema } from "./connect.js";

const operationId = `cop_${crypto.randomUUID()}`;

describe("Opensteer Connect control-plane protocol", () => {
  it("accepts an exact local Host fence and loopback origin", () => {
    const request = ProvisionConnectRequestSchema.parse({
      hostInstanceId: createId("hostInstance"),
      localOrigin: "http://127.0.0.1:4310/",
      operationId,
    });
    expect(request.localOrigin).toBe("http://127.0.0.1:4310");
  });

  it.each([
    "http://127.0.0.1",
    "http://192.168.1.10:4310",
    "https://127.0.0.1:4310",
    "http://127.0.0.1:4310/path",
  ])("rejects a non-loopback service origin %s", (localOrigin) => {
    expect(
      ProvisionConnectRequestSchema.safeParse({
        hostInstanceId: createId("hostInstance"),
        localOrigin,
        operationId,
      }).success,
    ).toBe(false);
  });

  it("requires a caller-stable operation ID and does not accept a tunnel token in requests", () => {
    const base = {
      hostInstanceId: createId("hostInstance"),
    };
    expect(RotateConnectCredentialRequestSchema.safeParse(base).success).toBe(false);
    expect(
      RotateConnectCredentialRequestSchema.safeParse({
        ...base,
        operationId,
        tunnelToken: "must-not-cross-this-boundary",
      }).success,
    ).toBe(false);
  });
});
