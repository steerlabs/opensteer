import { AesGcmSecretVault, StaticEncryptionKeyProvider } from "@opensteer/access/host";
import { createId } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { openRequestResponse, sealRequestResponse } from "./request-response-vault.js";

describe("request response vault", () => {
  it("round-trips a response only for its exact Request, Run, and Thread binding", async () => {
    const vault = new AesGcmSecretVault(
      new StaticEncryptionKeyProvider(new Map([[1, Buffer.alloc(32, 7)]]), 1),
    );
    const binding = {
      requestId: createId("request"),
      runId: createId("run"),
      threadId: createId("thread"),
    };
    const response = {
      answers: { password: ["never-persist-this"] },
      kind: "form" as const,
    };

    const sealed = await sealRequestResponse(vault, response, binding);
    const retried = await sealRequestResponse(vault, response, binding);
    const changed = await sealRequestResponse(
      vault,
      { answers: { password: ["different"] }, kind: "form" },
      binding,
    );

    expect(sealed.envelope.toString("utf8")).not.toContain("never-persist-this");
    expect(retried.envelope).not.toEqual(sealed.envelope);
    expect(retried.requestFingerprint).toBe(sealed.requestFingerprint);
    expect(changed.requestFingerprint).not.toBe(sealed.requestFingerprint);
    await expect(openRequestResponse(vault, sealed.envelope, binding)).resolves.toEqual(response);
    await expect(
      openRequestResponse(vault, sealed.envelope, {
        ...binding,
        requestId: createId("request"),
      }),
    ).rejects.toThrow(/could not be decrypted/);
  });
});
