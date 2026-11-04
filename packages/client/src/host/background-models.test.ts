import { expect, it } from "vitest";
import { ModelSelectionSchema } from "@opensteer/core";
import { MockHostClient } from "../mock/mock-host-client.js";
import {
  getBackgroundModels,
  setBackgroundModelRole,
  setBackgroundProviderConsent,
} from "./background-models.js";
it("shares background settings through the mock RPC and supports consent revocation", async () => {
  const client = new MockHostClient({ latencyMs: 0 });
  try {
    const providerId = ModelSelectionSchema.shape.providerId.parse("anthropic");
    expect((await setBackgroundProviderConsent(client, providerId, true)).ok).toBe(true);
    const view = await getBackgroundModels(client);
    expect(view.ok && view.data.backgroundProviderConsent).toEqual([providerId]);
    expect((await setBackgroundModelRole(client, "deep", { kind: "automatic" })).ok).toBe(true);
    expect((await setBackgroundProviderConsent(client, providerId, false)).ok).toBe(true);
    const revoked = await getBackgroundModels(client);
    expect(revoked.ok && revoked.data.backgroundProviderConsent).toEqual([]);
  } finally {
    client.dispose();
  }
});
