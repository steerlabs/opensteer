import { createId } from "@opensteer/core";
import {
  BrowserAttachTicketClaimsSchema,
  createBrowserSessionId,
} from "@opensteer/protocol/browser";
import { generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BrowserAttachTicketSigner } from "./browser-ticket.js";

describe("BrowserAttachTicketSigner", () => {
  it("binds initial navigation to the signed ticket", () => {
    const keys = generateKeyPairSync("ed25519");
    const initialNavigation = { operationKey: "open:1", url: "https://example.test/" };
    const ticket = new BrowserAttachTicketSigner({
      keyId: "host-primary",
      privateKey: keys.privateKey,
    }).issue({
      access: "full-control",
      identity: { kind: "fresh" },
      runtimeId: "browser",
      sessionId: createBrowserSessionId(),
      subject: "usr_owner",
      initialNavigation,
    });
    expect(
      BrowserAttachTicketClaimsSchema.parse(
        JSON.parse(Buffer.from(ticket.split(".")[1]!, "base64url").toString()),
      ),
    ).toMatchObject({ initialNavigation });
  });
  it("issues a ticket accepted by Browser Runtime's verifier", async () => {
    const keys = generateKeyPairSync("ed25519");
    const now = new Date("2026-08-09T18:00:00.000Z");
    const signer = new BrowserAttachTicketSigner({
      clock: () => now,
      keyId: "host-primary",
      privateKey: keys.privateKey,
    });
    const sessionId = createBrowserSessionId();

    const ticket = signer.issue({
      access: "full-control",
      identity: {
        kind: "fresh",
      },
      runtimeId: "hosted-browser-1",
      sessionId,
      subject: "usr_owner",
    });

    const [headerSegment, payloadSegment, signatureSegment] = ticket.split(".");
    expect(headerSegment).toBeTruthy();
    expect(payloadSegment).toBeTruthy();
    expect(signatureSegment).toBeTruthy();
    const header = JSON.parse(Buffer.from(headerSegment!, "base64url").toString("utf8"));
    const claims = BrowserAttachTicketClaimsSchema.parse(
      JSON.parse(Buffer.from(payloadSegment!, "base64url").toString("utf8")),
    );
    expect(header).toEqual({
      alg: "EdDSA",
      kid: "host-primary",
      typ: "opensteer-browser-attach+jwt",
    });
    expect(
      verify(
        null,
        Buffer.from(`${headerSegment}.${payloadSegment}`, "ascii"),
        keys.publicKey,
        Buffer.from(signatureSegment!, "base64url"),
      ),
    ).toBe(true);
    expect(claims).toMatchObject({ identity: { kind: "fresh" }, sessionId });
  });

  it.each([
    [1, undefined],
    [2, false],
    [2, true],
  ] as const)("signs editing %s with clipboard %s", (editingVersion, clipboard) => {
    const keys = generateKeyPairSync("ed25519");
    const ticket = new BrowserAttachTicketSigner({
      keyId: "split",
      privateKey: keys.privateKey,
    }).issue({
      access: "full-control",
      identity: { kind: "fresh" },
      runtimeId: "browser",
      sessionId: createBrowserSessionId(),
      subject: "usr_owner",
      editingVersion,
      ...(editingVersion === 2 ? { clipboard } : {}),
    });
    const claims = BrowserAttachTicketClaimsSchema.parse(
      JSON.parse(Buffer.from(ticket.split(".")[1]!, "base64url").toString()),
    );
    expect(claims.editingVersion).toBe(editingVersion);
    if (editingVersion === 2) expect(claims).toMatchObject({ clipboard });
    else expect(claims).not.toHaveProperty("clipboard");
  });
  it("issues a fresh ticket that carries no profile, lease, or state endpoint", () => {
    const keys = generateKeyPairSync("ed25519");
    const sessionId = createBrowserSessionId();
    const ticket = new BrowserAttachTicketSigner({
      keyId: "host-primary",
      privateKey: keys.privateKey,
    }).issue({
      access: "full-control",
      identity: { kind: "fresh" },
      runtimeId: "hosted-browser-1",
      sessionId,
      subject: "usr_owner",
    });
    const payloadSegment = ticket.split(".")[1];
    expect(payloadSegment).toBeTruthy();
    const claims = BrowserAttachTicketClaimsSchema.parse(
      JSON.parse(Buffer.from(payloadSegment!, "base64url").toString("utf8")),
    );
    expect(claims.identity).toEqual({ kind: "fresh" });
    expect(JSON.stringify(claims)).not.toContain("profileLeaseToken");
  });
});

it("keeps native storage out of the frozen released ticket reader", () => {
  const keys = generateKeyPairSync("ed25519");
  const signer = new BrowserAttachTicketSigner({
    keyId: "host-primary",
    privateKey: keys.privateKey,
  });
  const binding = {
    version: 1 as const,
    deploymentId: createId("deployment"),
    profileId: createId("browserProfile"),
    runnerId: createId("runner"),
    storageInstanceId: randomUUID(),
    bindingId: randomUUID(),
    engine: "electron" as const,
  };
  const ticket = signer.issue({
    access: "full-control",
    identity: {
      kind: "profile-local",
      binding,
      initialized: true,
      readyUrl: "https://host.test/ready",
    },
    runtimeId: "native",
    sessionId: createBrowserSessionId(),
    subject: "owner",
  });
  const claims = JSON.parse(Buffer.from(ticket.split(".")[1]!, "base64url").toString("utf8"));
  expect(BrowserAttachTicketClaimsSchema.parse(claims).identity).toEqual({
    kind: "profile-local",
    binding,
    initialized: true,
    readyUrl: "https://host.test/ready",
  });
  expect(JSON.stringify(claims)).not.toMatch(/profileLeaseToken|profileStateUrl|initialization/);
  const legacy = {
    ...claims,
    identity: {
      kind: "profile",
      profileId: binding.profileId,
      profileLeaseToken: "a".repeat(43),
      profileStateUrl: "https://host.test/state",
    },
  };
  expect(BrowserAttachTicketClaimsSchema.safeParse(legacy).success).toBe(false);
});
