import { AiSharing, aiCompanies, genericAiCompany } from "@opensteer/client/ai-sharing";
import type { HostClient } from "@opensteer/client/host";
import { MemoryPrivateFilesystem } from "@opensteer/client/test-support";
import { describe, expect, it, vi } from "vitest";
import { PushRegistration } from "../notifications/push-registration.js";
import { sendPendingMessage } from "./send-pending-message.js";

describe("successful phone send permission journey", () => {
  it("sends on an older Host after explicit generic consent without company data", async () => {
    const confirm = vi.fn(async () => true);
    const sharing = new AiSharing({
      records: [],
      save: () => {},
      confirm,
      now: () => "2026-11-06T12:00:00.000Z",
    });
    const dispatch = vi.fn(async () => ({}));
    const host = { dispatch } as unknown as HostClient;
    const command = {
      threadId: "thr_legacy",
      idempotencyKey: "message:legacy",
      text: "Hello",
      delivery: "queue" as const,
      createdAt: new Date().toISOString(),
      userId: "usr_person",
    };
    const authorize = () =>
      sharing.ensure("content", () => aiCompanies({ harnesses: [], environments: [] }));
    expect(await sendPendingMessage(host, command, authorize)).toBe(true);
    expect(confirm).toHaveBeenCalledWith({ scope: "content", companies: [genericAiCompany] });
    expect(dispatch).toHaveBeenCalledOnce();
  });
  it("keeps restored pending input on the device when consent is declined", async () => {
    const dispatch = vi.fn();
    const host = { dispatch } as unknown as HostClient;
    const command = {
      threadId: "thr_saved",
      idempotencyKey: "message:saved",
      text: "private",
      quotedMessageId: "msg_private",
      delivery: "queue" as const,
      attachments: [],
      createdAt: new Date().toISOString(),
      userId: "usr_person",
    };
    const before = structuredClone(command);
    expect(await sendPendingMessage(host, command, async () => false)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(command).toEqual(before);
  });
  it("prompts once after acknowledgment and never on a refused send", async () => {
    let granted = false;
    const request = vi.fn(async () => {
      granted = true;
      return { canAskAgain: false, granted };
    });
    const registration = new PushRegistration({
      accountConfigured: true,
      filePath: "/private/push.json",
      platform: "ios",
      privateFiles: new MemoryPrivateFilesystem(),
      randomBytes: (size) => new Uint8Array(size).fill(1),
      signedInSubject: async () => "acct_person",
      permissions: { current: async () => ({ granted, canAskAgain: !granted }), request },
      tokens: {
        current: async () => "a".repeat(64),
        apsEnvironment: async () => "development",
        subscribe: () => () => undefined,
      },
      registry: { register: async () => undefined, unregister: async () => undefined },
    });
    await registration.start();
    const command = {
      threadId: "thr_phone",
      idempotencyKey: "message:phone",
      text: "Hello",
      delivery: "queue" as const,
      createdAt: new Date().toISOString(),
      userId: "usr_person",
    };
    const refused = {
      dispatch: async () => {
        throw new Error("refused");
      },
    } as unknown as HostClient;
    await expect(
      sendPendingMessage(refused, command, async () => true, registration),
    ).rejects.toThrow("refused");
    expect(request).not.toHaveBeenCalled();
    const acknowledged = Promise.withResolvers<unknown>();
    const host = { dispatch: () => acknowledged.promise } as unknown as HostClient;
    const sending = sendPendingMessage(host, command, async () => true, registration);
    expect(request).not.toHaveBeenCalled();
    acknowledged.resolve({ type: "thread.sendMessage" });
    await sending;
    await registration.sync();
    expect(request).toHaveBeenCalledTimes(1);
    await sendPendingMessage(host, command, async () => true, registration);
    await registration.sync();
    expect(request).toHaveBeenCalledTimes(1);
    registration.stop();
  });
});
