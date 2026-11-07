import { MemoryPrivateFilesystem } from "@opensteer/client/test-support";
import { describe, expect, it } from "vitest";
import { createNotificationsIntroFile, NotificationsIntro } from "./notifications-intro.js";
import type { PushRegistrationStatus } from "./push-registration.js";

const filePath = "/private/notifications-intro.json";
const onConnectedChat = { connected: true, onChat: true };

function intro(
  privateFiles: MemoryPrivateFilesystem,
  status: Exclude<PushRegistrationStatus, "unavailable"> = "permission-undetermined",
) {
  return new NotificationsIntro({
    file: createNotificationsIntroFile({ filePath, privateFiles }),
    registration: {
      getSnapshot: () => ({
        preferences: { approvalsEnabled: true, runOutcomesEnabled: true },
        status,
      }),
    },
  });
}

describe("the notifications intro", () => {
  it("is offered on a connected Chat while the system can still ask", async () => {
    const gate = intro(new MemoryPrivateFilesystem());

    await expect(gate.due({ connected: false, onChat: true })).resolves.toBe(false);
    await expect(gate.due({ connected: true, onChat: false })).resolves.toBe(false);
    await expect(gate.due(onConnectedChat)).resolves.toBe(true);
  });

  it.each([
    // A privately paired phone has no Account to be sent through.
    "signed-out",
    "no-account-service",
    "permission-denied",
    "registered",
    "push-not-configured",
    "device-limit",
  ] as const)("is not offered when the registration is %s", async (status) => {
    await expect(intro(new MemoryPrivateFilesystem(), status).due(onConnectedChat)).resolves.toBe(
      false,
    );
  });

  it("is offered once, including after the app restarts", async () => {
    const privateFiles = new MemoryPrivateFilesystem();
    const gate = intro(privateFiles);
    await expect(gate.due(onConnectedChat)).resolves.toBe(true);

    await gate.presented();

    await expect(gate.due(onConnectedChat)).resolves.toBe(false);
    await expect(intro(privateFiles).due(onConnectedChat)).resolves.toBe(false);
  });
});
