import { describe, expect, it, vi } from "vitest";
import { createId, HarnessIdSchema, OpensteerError } from "@opensteer/core";
import type { HarnessInstanceRecord } from "@opensteer/database";
import { HarnessInstanceCatalogSchema } from "@opensteer/protocol";
import { createVoiceHandlers } from "./voice-handlers.js";
import { testHostApiContext } from "../server/test-host-api-context.js";
const userId = createId("user"),
  environmentId = createId("environment"),
  harnessInstanceId = createId("harnessInstance");
const sessionId = "00000000-0000-4000-8000-000000000001";
const profile: HarnessInstanceRecord = {
  id: harnessInstanceId,
  environmentId,
  driverKind: HarnessIdSchema.parse("codex"),
  sourceId: "openai",
  stateKind: "isolated",
  config: {},
  enabled: true,
  isDefault: false,
  name: "Codex",
  removedAt: null,
  runtimeRevision: 1,
};
function fixture() {
  const store = {
    environmentIsAvailableToUser: vi.fn(async () => true),
    listAgentHarnessInstancesForUser: vi.fn(async (): Promise<readonly HarnessInstanceRecord[]> => [
      profile,
    ]),
    getHarnessCatalog: vi.fn(async () =>
      HarnessInstanceCatalogSchema.parse({
        driverKind: "codex",
        harnessInstanceId,
        continuationIdentity: {
          driverKind: "codex",
          continuationKey: "runner:v1:gloDaTsWIkNBQ7kNDmrhYJ4LgXV9NgDqGfcuVjZ08-Y",
        },
        models: [
          {
            modelId: "gpt-5.6-sol",
            providerId: "openai",
            displayName: "GPT",
            isDefault: true,
            options: [],
          },
        ],
        status: "ready",
        connections: [
          {
            connectionSlot: "primary",
            label: "ChatGPT",
            status: "connected",
            authKind: "subscription",
          },
        ],
      }),
    ),
  };
  const runners = {
    voice: vi.fn(async (): Promise<import("@opensteer/protocol").RunnerVoiceResult> => ({
      ok: true,
      answer: "answer",
    })),
  };
  return {
    store,
    runners,
    handlers: createVoiceHandlers({ store, runners }),
    context: testHostApiContext(userId),
    input: { environmentId, harnessInstanceId, sessionId, offer: "private-offer" },
  };
}
describe("Host voice authorization and relay", () => {
  it.each([false, true])(
    "reports negotiated agent support %s only when requested",
    async (agent) => {
      const f = fixture();
      f.runners.voice.mockResolvedValue({ ok: true, answer: "answer", agent });
      expect(await f.handlers["voice.start"]({ ...f.input, agent: true }, f.context)).toEqual({
        ok: true,
        data: { answer: "answer", agent },
      });
      expect(f.runners.voice).toHaveBeenCalledWith(
        environmentId,
        userId,
        expect.objectContaining({ agent: true }),
        f.context.signal,
      );
      expect(await f.handlers["voice.start"](f.input, f.context)).toEqual({
        ok: true,
        data: { answer: "answer" },
      });
    },
  );
  it("relays start with the authenticated person and authorized account", async () => {
    const f = fixture();
    expect(await f.handlers["voice.start"](f.input, f.context)).toEqual({
      ok: true,
      data: { answer: "answer" },
    });
    expect(f.store.environmentIsAvailableToUser).toHaveBeenCalledWith(environmentId, userId);
    expect(f.store.listAgentHarnessInstancesForUser).toHaveBeenCalledWith(userId, {
      id: harnessInstanceId,
      limit: 1,
    });
    expect(f.runners.voice).toHaveBeenCalledWith(
      environmentId,
      userId,
      { action: "start", sessionId, harnessInstanceId, offer: "private-offer" },
      f.context.signal,
    );
  });
  it.each([
    "unauthorized-environment",
    "unowned-or-revoked",
    "wrong-environment",
    "disabled",
    "removed",
    "non-codex",
    "non-subscription",
    "disconnected",
  ])("refuses %s before touching the Runner", async (scenario) => {
    const f = fixture();
    if (scenario === "unauthorized-environment")
      f.store.environmentIsAvailableToUser.mockResolvedValue(false);
    if (scenario === "unowned-or-revoked")
      f.store.listAgentHarnessInstancesForUser.mockResolvedValue([]);
    if (scenario === "wrong-environment")
      f.store.listAgentHarnessInstancesForUser.mockResolvedValue([
        { ...profile, environmentId: createId("environment") },
      ]);
    if (scenario === "disabled")
      f.store.listAgentHarnessInstancesForUser.mockResolvedValue([{ ...profile, enabled: false }]);
    if (scenario === "removed")
      f.store.listAgentHarnessInstancesForUser.mockResolvedValue([
        { ...profile, removedAt: new Date() },
      ]);
    if (scenario === "non-codex")
      f.store.listAgentHarnessInstancesForUser.mockResolvedValue([
        { ...profile, driverKind: HarnessIdSchema.parse("claude") },
      ]);
    if (scenario === "non-subscription" || scenario === "disconnected") {
      const catalog = await f.store.getHarnessCatalog();
      f.store.getHarnessCatalog.mockResolvedValue({
        ...catalog,
        connections: [
          {
            connectionSlot: "primary",
            label: "Codex",
            authKind: scenario === "non-subscription" ? "api-key" : "subscription",
            status: scenario === "disconnected" ? "authentication-required" : "connected",
          },
        ],
      });
    }
    await expect(f.handlers["voice.start"](f.input, f.context)).rejects.toMatchObject({
      reason: "voice-account-unavailable",
    });
    expect(f.runners.voice).not.toHaveBeenCalled();
  });
  it.each([
    "voice.renew",
    "voice.say",
    "voice.stop",
    "voice.next",
    "voice.answer",
    "voice.context",
  ] as const)(
    "reauthorizes %s against fresh profiles without retaining session state",
    async (method) => {
      const f = fixture();
      const call = {
        environmentId,
        sessionId,
        harnessInstanceId,
        text: "hello",
        callId: "opaque",
        ok: true,
      };
      await f.handlers[method](call, f.context);
      expect(f.runners.voice).toHaveBeenLastCalledWith(
        environmentId,
        userId,
        expect.objectContaining({ action: method.slice(6), sessionId, harnessInstanceId }),
        f.context.signal,
      );
      f.store.listAgentHarnessInstancesForUser.mockResolvedValue([]);
      await expect(f.handlers[method](call, f.context)).rejects.toMatchObject({
        reason: "voice-account-unavailable",
      });
      expect(f.runners.voice).toHaveBeenCalledTimes(1);
      expect(f.store.listAgentHarnessInstancesForUser).toHaveBeenCalledTimes(2);
    },
  );
  it("preserves old Runner and Runner refusal reasons without payload details", async () => {
    const f = fixture();
    f.runners.voice.mockRejectedValueOnce(
      new OpensteerError({
        code: "conflict",
        reason: "voice-runner-unsupported",
        message: "Update Opensteer.",
      }),
    );
    await expect(f.handlers["voice.start"](f.input, f.context)).rejects.toMatchObject({
      reason: "voice-runner-unsupported",
    });
    f.runners.voice.mockResolvedValueOnce({
      ok: false,
      reason: "voice-refused",
      message: "Voice refused.",
    });
    await expect(f.handlers["voice.start"](f.input, f.context)).rejects.toMatchObject({
      reason: "voice-refused",
      details: undefined,
    });
  });
});
