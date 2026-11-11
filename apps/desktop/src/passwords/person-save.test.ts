import { describe, expect, it, vi } from "vitest";
import type { PersonSaveCandidate } from "@opensteer/browser-runtime-core";
import type { PasswordsBrokerPersonSaveSession, PasswordsBrokerSession } from "./broker-session.js";
import { PasswordsPersonSaveAuthority } from "./person-save.js";

const candidate: PersonSaveCandidate = {
  targetId: "tab",
  origin: "https://example.com",
  username: "synthetic@example.com",
  password: "synthetic-password",
  presence: "elsewhere",
};

function fixture(
  decision: Awaited<ReturnType<PasswordsBrokerPersonSaveSession["saveBegin"]>>["decision"] = {
    decision: "offer",
    expiresAt: "2026-11-11T10:02:00.000Z",
  },
) {
  const lifetime = new AbortController();
  const broker = {
    saveBegin: vi.fn<PasswordsBrokerPersonSaveSession["saveBegin"]>(async () => ({
      decision,
      lifetime: lifetime.signal,
    })),
    saveCommit: vi.fn<PasswordsBrokerPersonSaveSession["saveCommit"]>(async () => ({
      saved: true,
    })),
    cancel: vi.fn(async () => undefined),
  };
  const allowed = vi.fn((origin: string) => origin === "https://example.com");
  const authority = new PasswordsPersonSaveAuthority(
    broker as unknown as PasswordsBrokerSession,
    allowed,
  );
  return { authority, broker, lifetime };
}

describe("person save authority", () => {
  it("hands the login to the broker once and commits it only once", async () => {
    const { authority, broker } = fixture();
    const begun = await authority.begin(candidate);
    expect(begun).toEqual({
      kind: "offer",
      transactionId: expect.any(String),
      expiresAt: Date.parse("2026-11-11T10:02:00.000Z"),
    });
    expect(broker.saveBegin).toHaveBeenCalledWith(
      {
        transactionId: begun.kind === "offer" ? begun.transactionId : "",
        origin: candidate.origin,
        username: candidate.username,
        password: candidate.password,
      },
      expect.any(AbortSignal),
    );
    if (begun.kind !== "offer") throw new Error("expected an offer");
    expect(await authority.commit(begun.transactionId)).toBe("saved");
    expect(await authority.commit(begun.transactionId)).toBe("ended");
    expect(broker.saveCommit).toHaveBeenCalledOnce();
  });

  it("never sends a login for a site it may not save to", async () => {
    const { authority, broker } = fixture();
    expect(await authority.begin({ ...candidate, origin: "https://opensteer.example" })).toEqual({
      kind: "skip",
    });
    expect(broker.saveBegin).not.toHaveBeenCalled();
  });

  it("suggests setup once, and only to a person typing on this Mac", async () => {
    const { authority } = fixture({ decision: "skip", reason: "not-set-up" });
    expect(await authority.begin(candidate)).toEqual({ kind: "skip" });
    expect(await authority.begin({ ...candidate, presence: "here" })).toEqual({ kind: "setup" });
    expect(await authority.begin({ ...candidate, presence: "here" })).toEqual({ kind: "skip" });
  });

  it("reports an existing login, and forgets a held login the connection took with it", async () => {
    const { authority, broker, lifetime } = fixture();
    broker.saveCommit.mockResolvedValueOnce({ saved: false, reason: "saved" });
    const first = await authority.begin(candidate);
    if (first.kind !== "offer") throw new Error("expected an offer");
    expect(await authority.commit(first.transactionId)).toBe("exists");
    const second = await authority.begin(candidate);
    if (second.kind !== "offer") throw new Error("expected an offer");
    lifetime.abort();
    expect(await authority.commit(second.transactionId)).toBe("ended");
  });

  it("cancels what it still holds when it closes, and offers nothing after", async () => {
    const { authority, broker } = fixture();
    const begun = await authority.begin(candidate);
    if (begun.kind !== "offer") throw new Error("expected an offer");
    authority.close();
    expect(broker.cancel).toHaveBeenCalledWith(begun.transactionId);
    expect(await authority.begin(candidate)).toEqual({ kind: "skip" });
  });

  it("saves nothing over a connection that predates saving", async () => {
    const authority = new PasswordsPersonSaveAuthority({} as PasswordsBrokerSession, () => true);
    expect(await authority.begin(candidate)).toEqual({ kind: "skip" });
  });
});
