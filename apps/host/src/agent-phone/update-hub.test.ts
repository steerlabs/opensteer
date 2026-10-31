import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import type { OpensteerStore } from "@opensteer/database";
import { createId } from "@opensteer/core";
import { afterEach, expect, it, vi } from "vitest";
import type { RunnerAuthenticator } from "../agents/runner-authenticator.js";
import { AgentPhoneUpdateHub } from "./update-hub.js";
import type { AgentPhoneUpdateRelease } from "./update-release.js";

class UpdateSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: string[] = [];
  send(bytes: string | Buffer, done: (error?: Error) => void) {
    this.sent.push(bytes.toString());
    done();
  }
  close() {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.emit("close");
  }
  message(value: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(value)), false);
  }
}
afterEach(() => vi.useRealTimers());

it.each(["awaiting-user", "closed-awaiting-user", "reconnected", "installing"] as const)(
  "keeps Android consent separate from the network deadline (%s)",
  async (scenario) => {
    const state =
      scenario === "closed-awaiting-user" || scenario === "reconnected"
        ? "awaiting-user"
        : scenario;
    vi.useFakeTimers();
    const runnerId = createId("runner");
    const changed = vi.fn();
    const authenticator = {
      issueChallenge: () => ({}),
      authenticateUpdateRefusal: async () => ({ runnerId, connectionGeneration: 3 }),
    } as unknown as RunnerAuthenticator;
    const store = {
      runnerForAuthentication: async () => ({ connectionGeneration: 3, revokedAt: null }),
    } as unknown as Pick<OpensteerStore, "runnerForAuthentication">;
    const sha = "a".repeat(64);
    const release = {
      manifest: { apkSha256: sha },
      manifestJson: "{}",
      receipt: {},
      apk: Buffer.from([1]),
    } as unknown as AgentPhoneUpdateRelease;
    const hub = new AgentPhoneUpdateHub({ authenticator, store, release: () => release, changed });
    const socket = new UpdateSocket();
    try {
      hub.attach(socket as unknown as WebSocket, vi.fn());
      socket.message({
        type: "runner.authenticate",
        challengeId: "rch_11111111-1111-4111-8111-111111111111",
        signature: "A".repeat(86),
        proofFormatVersion: 2,
        descriptor: {
          runtimeVersion: "0.1.181",
          device: { form: "phone" },
          modules: { integrations: { platform: "android" } },
        },
      });
      await vi.waitFor(
        () =>
          expect(socket.sent.some((text) => text.includes("host.agent-phone.update"))).toBe(true),
        { timeout: 1_000 },
      );
      socket.message({ type: "phone.update.status", apkSha256: sha, state });
      if (scenario === "closed-awaiting-user") socket.close();
      await vi.waitFor(() => expect(hub.projection(runnerId, 3, false)).toBe(state), {
        timeout: 1_000,
      });
      await vi.advanceTimersByTimeAsync(11 * 60_000);
      expect(hub.projection(runnerId, 3, false)).toBe(state === "awaiting-user" ? state : "failed");
      if (scenario === "reconnected") {
        expect(hub.projection(runnerId, 4, true)).toBeNull();
        return;
      }
      const count = changed.mock.calls.length;
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      expect(hub.projection(runnerId, 3, false)).toBeNull();
      expect(changed.mock.calls.length).toBeGreaterThan(count);
    } finally {
      hub.close();
    }
  },
);
