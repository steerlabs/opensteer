import { expect, it } from "vitest";
import { ModelSelectionSchema } from "@opensteer/core";
import { MockHostClient } from "../mock/mock-host-client.js";
import {
  backgroundConsentDismissalKey,
  backgroundModelsSettings,
  dismissedBackgroundProviders,
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
it("describes each background state for Settings and asks only about the next provider", async () => {
  const client = new MockHostClient({ latencyMs: 0 });
  const empty = new MockHostClient({ latencyMs: 0, backgroundModels: "none" });
  const read = async (host: MockHostClient, dismissed: ReadonlySet<string> | null = new Set()) => {
    const view = await getBackgroundModels(host);
    if (!view.ok) throw new Error(view.error.message);
    return backgroundModelsSettings(view.data, dismissed);
  };
  try {
    const anthropic = ModelSelectionSchema.shape.providerId.parse("anthropic");
    const waiting = await read(client);
    expect(waiting.roles.map((role) => role.detail)).toEqual([
      "Automatic. Waiting for you to allow a provider.",
      "Automatic. Waiting for you to allow a provider.",
    ]);
    expect(waiting.notice?.text).toBe(
      "Let Anthropic name your tasks and run memory passes? It sees the first message of each new task (up to 2,000 characters) and your memory files during memory passes.",
    );
    expect((await read(client, null)).notice).toBeNull();
    // "Not now" on the provider next in line asks about no other one either.
    expect((await read(client, new Set([anthropic]))).notice).toBeNull();

    await setBackgroundProviderConsent(client, anthropic, true);
    const allowed = await read(client);
    expect(allowed.roles[0]?.detail).toBe("Automatic (currently Claude Haiku 5.5 via Claude Code)");
    expect(allowed.notice).toBeNull();
    expect(allowed.providers).toEqual([
      { providerId: anthropic, name: "Anthropic", allowed: true },
      { providerId: "openai", name: "OpenAI", allowed: false },
    ]);

    const choice = allowed.roles[1]!.choices.find((item) => item.label.startsWith("Claude Opus"))!;
    expect(
      choice.mode.kind === "pinned" && choice.mode.selection.modelSelection,
    ).not.toHaveProperty("nativeModelId");
    await setBackgroundModelRole(client, "deep", choice.mode);
    const pinnedView = await read(client);
    expect(pinnedView.roles[1]).toMatchObject({
      detail: "Claude Opus 5.5 via Claude Code",
      value: choice.value,
    });

    await setBackgroundProviderConsent(client, anthropic, false);
    expect((await read(client)).roles[1]?.detail).toBe(
      "Claude Opus 5.5 isn't available (needs your OK).",
    );

    const nothing = await read(empty);
    expect(nothing.roles[0]).toMatchObject({
      detail: "Automatic. No model can run this right now.",
      choices: [{ value: "automatic", label: "Automatic" }],
    });
    expect(nothing.notice).toBeNull();
  } finally {
    client.dispose();
    empty.dispose();
  }
});
it("keeps a device's Not now per Deployment, person and provider", () => {
  const scope = { deploymentId: "dep_1", userId: "usr_1" };
  const keys = new Set([
    backgroundConsentDismissalKey({ ...scope, providerId: "openai" }),
    backgroundConsentDismissalKey({ deploymentId: "dep_2", userId: "usr_1", providerId: "xai" }),
  ]);
  expect(dismissedBackgroundProviders(keys, scope)).toEqual(new Set(["openai"]));
  expect(dismissedBackgroundProviders(null, scope)).toBeNull();
});
