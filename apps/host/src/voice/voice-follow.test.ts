import { createId, type AgentEvent, type UserId } from "@opensteer/core";
import { PersonShowMessageSchema, type PersonShowMessage } from "@opensteer/protocol";
import { expect, it, vi } from "vitest";
import { createVoiceFollow } from "./voice-follow.js";

const ownerId = createId("user") as UserId;
const runId = createId("run");
const threadId = createId("thread");
const workspaceId = createId("workspace");
const place = {
  kind: "browser",
  sessionId: "bsn_00000000-0000-4000-8000-000000000001",
  surfaceId: "surface_00000000-0000-4000-8000-000000000001",
};

const event = (type: string, data: unknown = {}, run: string | null = runId) =>
  ({ type, data, runId: run, threadId, workspaceId }) as unknown as AgentEvent;

function follower(options: { call?: boolean; lastPlace?: boolean } = {}) {
  const shown: PersonShowMessage[] = [];
  const onError = vi.fn();
  const follow = createVoiceFollow({
    store: {
      voiceCallForRun: vi.fn(async () =>
        options.call === false
          ? undefined
          : { ownerId, sessionId: "voice-session", admittedAt: new Date() },
      ),
      latestRunPlace: vi.fn(async () => (options.lastPlace === false ? null : { data: { place } })),
    } as never,
    show: async (userId, message) => {
      expect(userId).toBe(ownerId);
      shown.push(PersonShowMessageSchema.parse(message));
      return 1;
    },
    onError,
  });
  return { follow, shown, onError };
}

it.each([
  ["place.entered", { place }, { place }],
  ["request.opened", {}, { threadId }],
  ["request.resolved", {}, { place }],
])("moves the person's screen on a call's %s", async (type, data, target) => {
  const { follow, shown, onError } = follower();
  follow(event(type, data));
  await vi.waitFor(() =>
    expect(shown).toEqual([{ type: "host.show", workspaceId, threadId, runId, target }]),
  );
  expect(onError).not.toHaveBeenCalled();
});

it("leaves the screen alone for any Run that is not a call", async () => {
  const { follow, shown, onError } = follower({ call: false });
  follow(event("place.entered", { place }));
  follow(event("request.opened"));
  await vi.waitFor(() => expect(onError).not.toHaveBeenCalled());
  await Promise.resolve();
  expect(shown).toEqual([]);
});

it("stays put when an answered Request's Run has gone nowhere", async () => {
  const { follow, shown, onError } = follower({ lastPlace: false });
  follow(event("request.resolved"));
  await vi.waitFor(() => expect(onError).not.toHaveBeenCalled());
  await Promise.resolve();
  expect(shown).toEqual([]);
});

it("ignores events with no Run and events that move nothing", () => {
  const { follow, shown } = follower();
  follow(event("place.entered", { place }, null));
  follow(event("run.status"));
  expect(shown).toEqual([]);
});
