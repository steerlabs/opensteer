import { generateKeyPairSync } from "node:crypto";
import { createId } from "@opensteer/core";
import { ShellSessionIdSchema, type RunnerAuxiliaryFrameFence } from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import { RunnerAuthenticator } from "../agents/runner-authenticator.js";
import { auxiliaryStream } from "./shell-hub.test-support.js";

function authenticator(now: () => number) {
  return new RunnerAuthenticator({
    issuancePrivateKey: generateKeyPairSync("ed25519").privateKey,
    now,
    store: {} as never,
  });
}

describe("shell data ticket", () => {
  it("carries the whole auxiliary fence of the stream that was asked", () => {
    const fence = auxiliaryStream({ runnerId: createId("runner") }).fence;
    const sessionId = ShellSessionIdSchema.parse(`shs_${globalThis.crypto.randomUUID()}`);
    const issuedAt = Date.parse("2026-09-13T12:00:00.000Z");

    const issued = authenticator(() => issuedAt).issueShellDataTicket({ fence, sessionId });

    expect(issued.claims).toEqual({
      ...fence,
      audience: "opensteer-shell-data",
      expiresAt: new Date(issuedAt + 30_000).toISOString(),
      issuedAt: new Date(issuedAt).toISOString(),
      module: "shell",
      nonce: expect.stringMatching(/^[A-Za-z0-9_-]{32,255}$/u),
      sessionId,
      type: "opensteer.shell.data-ticket",
    });
  });

  it("is one use, and only for the thirty seconds it names", () => {
    let now = Date.parse("2026-09-13T12:00:00.000Z");
    const tokens = authenticator(() => now);
    const fence = auxiliaryStream({ runnerId: createId("runner") }).fence;
    const first = tokens.issueShellDataTicket({
      fence,
      sessionId: ShellSessionIdSchema.parse(`shs_${globalThis.crypto.randomUUID()}`),
    });
    const second = tokens.issueShellDataTicket({
      fence,
      sessionId: ShellSessionIdSchema.parse(`shs_${globalThis.crypto.randomUUID()}`),
    });

    expect(tokens.verifyShellDataTicket(first.ticket).nonce).toBe(first.claims.nonce);
    expect(() => tokens.verifyShellDataTicket(first.ticket)).toThrow(/already used/u);

    now += 30_001;
    expect(() => tokens.verifyShellDataTicket(second.ticket)).toThrow(/authentication failed/iu);
  });

  it("refuses an auxiliary stream ticket, a forged one, and a foreign signature", () => {
    const now = Date.parse("2026-09-13T12:00:00.000Z");
    const tokens = authenticator(() => now);
    const stream = auxiliaryStream({ runnerId: createId("runner") });
    const issued = tokens.issueShellDataTicket({
      fence: stream.fence,
      sessionId: ShellSessionIdSchema.parse(`shs_${globalThis.crypto.randomUUID()}`),
    });

    // Another Host's key signs the same claims: the bytes parse, the signature
    // does not, and nothing about the fence is even reached.
    const stranger = authenticator(() => now);
    const foreign = stranger.issueShellDataTicket({
      fence: stream.fence,
      sessionId: ShellSessionIdSchema.parse(`shs_${globalThis.crypto.randomUUID()}`),
    });
    expect(() => tokens.verifyShellDataTicket(foreign.ticket)).toThrow(/authentication failed/iu);

    const [header, payload, signature] = issued.ticket.split(".");
    const tampered = JSON.parse(
      Buffer.from(payload ?? "", "base64url").toString("utf8"),
    ) as RunnerAuxiliaryFrameFence & { connectionGeneration: number };
    tampered.connectionGeneration = 99;
    const forged = [
      header,
      Buffer.from(JSON.stringify(tampered), "utf8").toString("base64url"),
      signature,
    ].join(".");
    expect(() => tokens.verifyShellDataTicket(forged)).toThrow(/authentication failed/iu);
  });

  it("never mints a data ticket for another module's stream", () => {
    const stream = auxiliaryStream({ runnerId: createId("runner") });

    expect(() =>
      authenticator(Date.now).issueShellDataTicket({
        fence: { ...stream.fence, module: "browser" },
        sessionId: ShellSessionIdSchema.parse(`shs_${globalThis.crypto.randomUUID()}`),
      }),
    ).toThrow(/only the shell module/u);
  });
});
