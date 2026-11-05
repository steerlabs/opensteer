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
  const call = {
    threadId: createId("thread"),
    runId: createId("run"),
    workspaceId: createId("workspace"),
    environmentId,
    sessionId,
    admittedAt: new Date(),
    status: "running" as const,
    threadStatus: "running" as const,
    busy: false as const,
    revokedGrants: [],
    events: [],
  };
  const store = {
    startVoiceCall: vi.fn(async () => call),
    resolveVoiceCall: vi.fn(async (): Promise<typeof call | undefined> => call),
    stopVoiceCall: vi.fn(async () => undefined),
    environmentIsAvailableToUser: vi.fn(async () => true),
    listAgentHarnessInstancesForUser: vi.fn(async (): Promise<readonly HarnessInstanceRecord[]> => [
      profile,
    ]),
    openVoiceThread: vi.fn(async () => ({ threadId: call.threadId, events: [] })),
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
    call,
    store,
    runners,
    handlers: createVoiceHandlers({ store, runners }),
    context: testHostApiContext(userId),
    input: { environmentId, harnessInstanceId, sessionId, offer: "private-offer" },
  };
}

describe("Host voice Run relay", () => {
  it("starts a Run and relays SDP only to the Runner", async () => {
    const f = fixture();
    expect(await f.handlers["voice.start"](f.input, f.context)).toEqual({
      ok: true,
      data: {
        answer: "answer",
        threadId: f.call.threadId,
        runId: f.call.runId,
        workspaceId: f.call.workspaceId,
      },
    });
    expect(f.store.startVoiceCall).toHaveBeenCalledWith({
      ownerId: userId,
      environmentId,
      harnessInstanceId,
      sessionId,
    });
    expect(f.runners.voice).toHaveBeenCalledWith(
      environmentId,
      userId,
      { action: "start", sessionId, runId: f.call.runId, offer: "private-offer" },
      f.context.signal,
    );
  });
  it("waits for what is finishing on the Voice Thread, then takes it", async () => {
    const f = fixture();
    f.store.startVoiceCall.mockResolvedValueOnce({
      busy: true,
      revokedGrants: [],
      events: [],
    } as never);
    expect((await f.handlers["voice.start"](f.input, f.context)).ok).toBe(true);
    expect(f.store.startVoiceCall).toHaveBeenCalledTimes(2);
  });

  it("creates the Voice Thread for a usable account, and refuses any other", async () => {
    const f = fixture();
    const { environmentId, harnessInstanceId } = f.input;
    expect(await f.handlers["voice.open"]({ environmentId, harnessInstanceId }, f.context)).toEqual(
      { ok: true, data: { threadId: f.call.threadId } },
    );
    f.store.environmentIsAvailableToUser.mockResolvedValueOnce(false);
    await expect(
      f.handlers["voice.open"]({ environmentId, harnessInstanceId }, f.context),
    ).rejects.toMatchObject({ reason: "voice-account-unavailable" });
  });

  it("stops admission on relay failure and never exposes SDP in errors", async () => {
    const f = fixture();
    f.runners.voice.mockRejectedValue(new Error("private-offer"));
    await expect(f.handlers["voice.start"](f.input, f.context)).rejects.toMatchObject({
      message: "The voice call could not start.",
    });
    expect(f.store.stopVoiceCall).toHaveBeenCalledWith(userId, sessionId);
  });
  it("refuses unusable accounts before admission", async () => {
    const f = fixture();
    f.store.environmentIsAvailableToUser.mockResolvedValue(false);
    await expect(f.handlers["voice.start"](f.input, f.context)).rejects.toBeInstanceOf(
      OpensteerError,
    );
    expect(f.store.startVoiceCall).not.toHaveBeenCalled();
  });
  it("authorizes controls by the recorded owner without rechecking accounts", async () => {
    const f = fixture();
    f.store.environmentIsAvailableToUser.mockResolvedValue(false);
    await f.handlers["voice.renew"]({ sessionId }, f.context);
    await f.handlers["voice.say"]({ sessionId, id: "message", text: "Hello" }, f.context);
    await f.handlers["voice.context"](
      { sessionId, view: { threadId: null, tabId: null } },
      f.context,
    );
    expect(f.store.environmentIsAvailableToUser).not.toHaveBeenCalled();
    expect(f.runners.voice).toHaveBeenLastCalledWith(
      environmentId,
      userId,
      { action: "context", sessionId, runId: f.call.runId, view: { threadId: null, tabId: null } },
      f.context.signal,
    );
  });
  it("refuses ended or foreign calls and keeps Stop idempotent", async () => {
    const f = fixture();
    f.store.resolveVoiceCall.mockResolvedValue(undefined);
    await expect(f.handlers["voice.renew"]({ sessionId }, f.context)).rejects.toMatchObject({
      reason: "voice-ended",
    });
    await f.handlers["voice.stop"]({ sessionId }, f.context);
    await f.handlers["voice.stop"]({ sessionId }, f.context);
  });
});
