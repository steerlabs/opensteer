import { createId, type AuthSessionId } from "@opensteer/core";
import { RealtimeHub } from "@opensteer/orchestration";
import type { HostToClientMessage } from "@opensteer/protocol";
import { expect, it, vi } from "vitest";
import { finishDeviceRemoval } from "./device-removal.js";

const bumped = vi.hoisted(() => [] as string[]);
vi.mock("@opensteer/database/personal-mutation", () => ({
  commitPersonalMutation: async (
    _database: unknown,
    action: (tx: unknown, mutation: { bumpResource(kind: string): void }) => Promise<void>,
  ) => action({}, { bumpResource: (kind) => bumped.push(kind) }),
}));

function removal(failing?: "refreshDeviceDrivers") {
  const ownerId = createId("user");
  const threadId = createId("thread");
  const endedSessionId = createId("authSession");
  const hub = new RealtimeHub();
  const login = (sessionId: AuthSessionId) => {
    const messages: HostToClientMessage[] = [];
    hub.registerConnection({
      userId: ownerId,
      sessionId,
      sync: { wake: () => undefined, close: () => undefined, observedThreadIds: () => [threadId] },
      sink: {
        id: crypto.randomUUID(),
        send: async (message: HostToClientMessage) => {
          messages.push(message);
        },
        close: () => undefined,
      },
    } as never);
    return messages;
  };
  const removedLogin = login(endedSessionId);
  const survivingLogin = login(createId("authSession"));
  const profilesRemoved = vi.fn(async () => undefined);
  const dependencies = {
    computerApps: {
      forgetDevice: () => undefined,
      detachRunner: () => undefined,
      refreshDeviceDrivers: async () => {
        if (failing === "refreshDeviceDrivers") throw new Error("Driver refresh failed");
      },
    },
    shellControl: { endMachineSessions: async () => undefined },
    runners: { revoke: async () => undefined },
    channels: { relay: { forget: () => undefined } },
    browser: { abandonSession: () => undefined, profilesRemoved },
    // As the runtime's identity does: each ended login's sockets close.
    authenticator: {
      identity: {
        announceSessionsEnded: (ids: readonly AuthSessionId[]) => {
          for (const id of ids) hub.closeSession(id);
        },
      },
    },
    realtime: hub,
    store: { database: {} },
  };
  const removed = {
    removedDeviceIds: [],
    detachedDeviceBindings: [],
    endedSessionIds: [endedSessionId],
    deletedBrowserProfiles: [{ id: createId("browserProfile"), ownerId }],
    cancelledRequestIds: [],
    closedBrowserSessions: [],
    revokedComputerConnectionIds: [],
    events: [],
    requestEvents: [],
  };
  return {
    finish: (afterResponse?: (effect: () => void) => void) =>
      finishDeviceRemoval(
        dependencies as never,
        createId("runner"),
        removed as never,
        afterResponse,
      ),
    profilesRemoved,
    notice: { type: "host.browser-usage-changed", threadIds: [threadId] },
    removedLogin,
    survivingLogin,
  };
}

it("refreshes surviving logins' open browser usage after the removed logins' sockets close", async () => {
  bumped.length = 0;
  const device = removal();
  const effects: (() => void)[] = [];
  await device.finish((effect) => effects.push(effect));
  expect(device.profilesRemoved).toHaveBeenCalledOnce();
  expect(bumped).toContain("browser-placement");
  // Nothing reaches a socket until the response is sent.
  expect(device.survivingLogin).toEqual([]);
  for (const effect of effects) effect();
  expect(device.removedLogin).toEqual([]);
  expect(device.survivingLogin).toEqual([device.notice]);
});

it("still ends the removed logins and refreshes browser usage when a later cleanup step fails", async () => {
  bumped.length = 0;
  const device = removal("refreshDeviceDrivers");
  await expect(device.finish()).rejects.toThrow("Driver refresh failed");
  expect(device.profilesRemoved).not.toHaveBeenCalled();
  expect(bumped).toEqual([]);
  expect(device.removedLogin).toEqual([]);
  expect(device.survivingLogin).toEqual([device.notice]);
});
