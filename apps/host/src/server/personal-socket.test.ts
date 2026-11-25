import { EventEmitter } from "node:events";
import type { WebSocket } from "@fastify/websocket";
import { afterEach, expect, it, vi } from "vitest";
import type { AuthenticatedHostSession } from "../identity/auth.js";
import { attachPersonalSocket } from "./personal-socket.js";

afterEach(() => {
  vi.useRealTimers();
});

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  readonly ping = vi.fn();
  readonly terminate = vi.fn();
  readonly send = vi.fn();
  readonly close = vi.fn(() => {
    this.readyState = 3;
    this.emit("close");
  });
}

const minute = 60_000;

function attach(
  expiresInMs: number,
  reauthenticate?: () => Promise<AuthenticatedHostSession["session"] | null>,
  credentialKind: AuthenticatedHostSession["credentialKind"] = "browser-cookie",
) {
  const now = Date.now();
  const session = {
    id: "ses_0192f4a1-4444-4000-8000-000000000004",
    createdAt: new Date(now - 6 * 24 * 60 * minute).toISOString(),
    expiresAt: new Date(now + expiresInMs).toISOString(),
    absoluteExpiresAt: new Date(now + 24 * 24 * 60 * minute).toISOString(),
    user: { id: "usr_0192f4a1-5555-4000-8000-000000000005" },
  } as unknown as AuthenticatedHostSession["session"];
  const closeSession = vi.fn();
  const socket = new FakeSocket();
  attachPersonalSocket({
    socket: socket as unknown as WebSocket,
    logFailure: () => {},
    authenticated: {
      credentialKind,
      session,
      surface: "canonical",
    } as unknown as AuthenticatedHostSession,
    realtime: {
      registerConnection: () => () => {},
      closeSession,
      guardRead: () => ({ current: () => true, release: () => {} }),
    } as unknown as Parameters<typeof attachPersonalSocket>[0]["realtime"],
    reads: {} as Parameters<typeof attachPersonalSocket>[0]["reads"],
    resources: { revisions: () => ({}) } as unknown as Parameters<
      typeof attachPersonalSocket
    >[0]["resources"],
    refreshOwner: () => {},
    probeMachines: () => {},
    ...(reauthenticate ? { reauthenticate } : {}),
  });
  return { session, socket, closeSession };
}

it("keeps a realtime socket open past its handshake deadline when use renewed the session", async () => {
  vi.useFakeTimers();
  const renewed = vi.fn(async () => null as AuthenticatedHostSession["session"] | null);
  const { session, closeSession } = attach(5 * minute, renewed);
  renewed.mockImplementation(async () => ({
    ...session,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * minute).toISOString(),
  }));

  await vi.advanceTimersByTimeAsync(10 * minute);

  expect(renewed).toHaveBeenCalledOnce();
  expect(closeSession).not.toHaveBeenCalled();
});

it("still ends a realtime socket at its deadline when the session was not renewed", async () => {
  vi.useFakeTimers();
  const unchanged = vi.fn(async () => null);
  const { session, closeSession } = attach(5 * minute, unchanged);

  await vi.advanceTimersByTimeAsync(5 * minute - 1_000);
  expect(unchanged).toHaveBeenCalledOnce();
  expect(closeSession).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(2_000);
  expect(closeSession).toHaveBeenCalledWith(session.id);
});

it("ends a realtime socket at its deadline when the session cannot be checked again", async () => {
  vi.useFakeTimers();
  const failing = vi.fn(async () => {
    throw new Error("Personal remote session credential is invalid");
  });
  const { session, closeSession } = attach(5 * minute, failing);

  await vi.advanceTimersByTimeAsync(5 * minute + 1_000);

  expect(failing).toHaveBeenCalledOnce();
  expect(closeSession).toHaveBeenCalledWith(session.id);
});

it("ends a realtime socket at its deadline while a session check is still pending", async () => {
  vi.useFakeTimers();
  const stalled = vi.fn(() => new Promise<AuthenticatedHostSession["session"] | null>(() => {}));
  const { session, closeSession } = attach(5 * minute, stalled);

  await vi.advanceTimersByTimeAsync(5 * minute + 1_000);

  expect(stalled).toHaveBeenCalledOnce();
  expect(closeSession).toHaveBeenCalledWith(session.id);
});

it("closes a socket whose native access token ran out for a reconnect, never as its session ending", async () => {
  // A native sign-in's access token lives ten minutes; its session lives on. The app
  // reconnects with a refreshed token; were the session gone, that reconnect is refused.
  vi.useFakeTimers();
  const { socket, closeSession } = attach(10 * minute, undefined, "native-oauth");

  await vi.advanceTimersByTimeAsync(10 * minute + 1_000);

  expect(closeSession).not.toHaveBeenCalled();
  expect(socket.close).toHaveBeenCalledOnce();
  const [code, reason] = socket.close.mock.calls[0] as unknown as [number, string];
  expect(code).toBe(1001);
  expect(reason).not.toBe("Session ended");
});
