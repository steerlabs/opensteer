import { AesGcmSecretVault, StaticEncryptionKeyProvider } from "@opensteer/access/host";
import { TriggerIdSchema } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { AutomationSecrets } from "./automation-secrets.js";

function makeSecrets() {
  const key = Buffer.alloc(32, 0x42);
  const vault = new AesGcmSecretVault(new StaticEncryptionKeyProvider(new Map([[1, key]]), 1));
  return new AutomationSecrets(vault);
}

const triggerA = TriggerIdSchema.parse("trg_00000000-0000-4000-8000-000000000001");
const triggerB = TriggerIdSchema.parse("trg_00000000-0000-4000-8000-000000000002");

describe("AutomationSecrets", () => {
  it("seals, lists names only, replaces, removes, and clears to null when empty", async () => {
    const secrets = makeSecrets();
    expect(await secrets.names(triggerA, null)).toEqual([]);
    expect(await secrets.values(triggerA, null)).toEqual({});

    const created = await secrets.apply(triggerA, null, {
      set: { WEBHOOK_SECRET: "whsec_1", API_TOKEN: "tok_1" },
    });
    expect(created).not.toBeNull();
    expect(created!.keyVersion).toBe(1);
    expect(created!.envelope.toString("utf8")).not.toContain("whsec_1");
    expect(await secrets.names(triggerA, created!.envelope)).toEqual([
      "API_TOKEN",
      "WEBHOOK_SECRET",
    ]);
    expect(await secrets.values(triggerA, created!.envelope)).toEqual({
      API_TOKEN: "tok_1",
      WEBHOOK_SECRET: "whsec_1",
    });

    const replaced = await secrets.apply(triggerA, created!.envelope, {
      remove: ["API_TOKEN"],
      set: { WEBHOOK_SECRET: "whsec_2", EXTRA: "val_3" },
    });
    expect(replaced).not.toBeNull();
    expect(await secrets.names(triggerA, replaced!.envelope)).toEqual(["EXTRA", "WEBHOOK_SECRET"]);
    expect(await secrets.values(triggerA, replaced!.envelope)).toEqual({
      EXTRA: "val_3",
      WEBHOOK_SECRET: "whsec_2",
    });

    const cleared = await secrets.apply(triggerA, replaced!.envelope, {
      remove: ["EXTRA", "WEBHOOK_SECRET"],
    });
    expect(cleared).toBeNull();
  });

  it("binds sealed envelopes to their trigger id, rejects case-insensitive collisions, and bounds total bytes (Z10)", async () => {
    const secrets = makeSecrets();
    const sealed = await secrets.apply(triggerA, null, { set: { MY_KEY: "secret" } });
    expect(sealed).not.toBeNull();

    await expect(secrets.values(triggerB, sealed!.envelope)).rejects.toThrow();

    await expect(
      secrets.apply(triggerA, null, { set: { "BAD-NAME": "nope" } }),
    ).rejects.toThrow();
    await expect(
      secrets.apply(triggerA, sealed!.envelope, { set: { my_key: "collision" } }),
    ).rejects.toThrow(/already exists/iu);
    await expect(
      secrets.apply(triggerA, null, {
        set: { BIG_A: "a".repeat(40_000), BIG_B: "b".repeat(40_000) },
      }),
    ).rejects.toThrow(/total/iu);
  });
});
