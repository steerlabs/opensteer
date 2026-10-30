import { expect, it, vi } from "vitest";
import { HostRelayAuthenticator } from "./host-relay.js";
import { PublicKeyCredentialRequestOptionsJSONSchema } from "./options.js";
import { serializeClientData } from "./index.js";
import type { PasskeyCeremony } from "@opensteer/protocol/passkeys";
it("uses only recent unambiguous browser input and accepts only the bound Host result", async () => {
  vi.useFakeTimers();
  try {
    const sent: unknown[] = [];
    const relay = new HostRelayAuthenticator(() => ({
      sessionId: "session",
      surfaceId: "tab",
      send: (message) => {
        sent.push(message);
      },
    }));
    const controller = new AbortController();
    const input = {
      op: "get" as const,
      options: PublicKeyCredentialRequestOptionsJSONSchema.parse({
        challenge: "AQID",
        hints: ["hybrid", "security-key"],
      }),
      origin: "https://login.example.test",
      rpId: "example.test",
      clientDataJSON: serializeClientData({
        type: "webauthn.get",
        challenge: "AQID",
        origin: "https://login.example.test",
      }),
      signal: controller.signal,
      targetId: "target",
      documentId: "document",
      deadline: Date.now() + 1000,
    };
    const token = "e2799da2-9fe9-438e-a160-47e275ee2703";
    relay.record("target", { person: token });
    const promise = relay.ceremony(input);
    const message = sent[0] as PasskeyCeremony;
    expect(message.cause).toEqual({ person: token });
    expect(message.options.challenge).toBe("AQID");
    expect(message.options.hints).toEqual(["hybrid", "security-key"]);
    relay.result("other-session", {
      type: "passkey.result",
      ceremonyId: message.ceremonyId,
      outcome: { kind: "refused", error: "SecurityError" },
    });
    relay.result("session", {
      type: "passkey.result",
      ceremonyId: message.ceremonyId,
      outcome: { kind: "refused", error: "NotAllowedError" },
    });
    await expect(promise).resolves.toEqual({ kind: "refused", error: "NotAllowedError" });
    relay.record("target", "agent");
    expect(relay.cause("target")).toBe("agent");
    vi.advanceTimersByTime(5001);
    expect(relay.cause("target")).toBe("unknown");
    relay.record("target", { person: token });
    relay.record("target", { person: "other" });
    expect(relay.cause("target")).toBe("unknown");
    const pending = relay.ceremony({ ...input, deadline: Date.now() + 1000 });
    controller.abort();
    await expect(pending).resolves.toMatchObject({ kind: "refused" });
    expect(sent.at(-1)).toMatchObject({ type: "passkey.cancel" });
    relay.close();
  } finally {
    vi.useRealTimers();
  }
});
