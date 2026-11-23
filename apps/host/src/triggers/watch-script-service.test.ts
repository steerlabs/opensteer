import { createId } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import type { WatchControlScope } from "./watch-capability.js";
import { WatchScriptService } from "./watch-script-service.js";

describe("WatchScriptService", () => {
  it("serves only the script and opened secrets named by the live activation token", async () => {
    const revisionId = createId("triggerRevision");
    const triggerId = createId("trigger");
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
      revisionId,
      triggerId,
    };
    const script = {
      interpreter: null,
      text: "console.log('watching')",
    } as const;
    const encryptedSecrets = Buffer.from("sealed-envelope");
    const watchScript = vi.fn(async () => ({ encryptedSecrets, script, triggerId }));
    const values = vi.fn(async () => ({ API_KEY: "shh" }));
    const service = new WatchScriptService({
      secrets: { values },
      store: { watchScript },
      tokens: { authenticate: async () => claims },
    });

    await expect(service.get("token", revisionId)).resolves.toEqual({
      script,
      secrets: { API_KEY: "shh" },
    });
    expect(watchScript).toHaveBeenCalledWith(claims);
    expect(values).toHaveBeenCalledWith(triggerId, encryptedSecrets);
    await expect(service.get("token", createId("triggerRevision"))).rejects.toThrow(
      "does not grant this automation revision",
    );
  });
});
