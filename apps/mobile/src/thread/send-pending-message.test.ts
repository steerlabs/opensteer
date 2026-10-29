import type { HostClient } from "@opensteer/client/host";
import { MemoryPrivateFilesystem } from "@opensteer/client/test-support";
import { describe, expect, it, vi } from "vitest";
import { PushRegistration } from "../notifications/push-registration.js";
import { sendPendingMessage } from "./send-pending-message.js";

describe("successful phone send permission journey", () => {
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
    await expect(sendPendingMessage(refused, command, registration)).rejects.toThrow("refused");
    expect(request).not.toHaveBeenCalled();
    const acknowledged = Promise.withResolvers<unknown>();
    const host = { dispatch: () => acknowledged.promise } as unknown as HostClient;
    const sending = sendPendingMessage(host, command, registration);
    expect(request).not.toHaveBeenCalled();
    acknowledged.resolve({ type: "thread.sendMessage" });
    await sending;
    await registration.sync();
    expect(request).toHaveBeenCalledTimes(1);
    await sendPendingMessage(host, command, registration);
    await registration.sync();
    expect(request).toHaveBeenCalledTimes(1);
    registration.stop();
  });
});
