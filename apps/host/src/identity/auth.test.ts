import { createId, OpensteerError, type AuthenticatedSession } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import {
  HostAuthenticator,
  type HostAuthenticatingIdentity,
  type PersonalRemoteSessionAuthenticator,
} from "./auth.js";

const publicUrl = new URL("http://127.0.0.1:4310");
const headerCredential = `${"t".repeat(43)}.${"s".repeat(43)}=`;

describe("HostAuthenticator authorization chain", () => {
  it("answers a Personal remote header from that family alone, never as canonical", async () => {
    const fixture = authenticatorFixture();

    const authenticated = await fixture.authenticator.authenticateSessionContext({
      authorization: `PersonalRemote ${headerCredential}`,
    });

    expect(authenticated).toMatchObject({
      credentialKind: "personal-remote-header",
      surface: "personal-remote",
    });
    expect(fixture.personalRemote.authenticateRemoteCredential).toHaveBeenCalledWith(
      headerCredential,
    );
    expect(fixture.identity.authenticateNativeAccessToken).not.toHaveBeenCalled();
    expect(fixture.identity.requireSession).not.toHaveBeenCalled();
  });

  it("does not demand an Origin of a header mutation, because nothing attached it", async () => {
    const fixture = authenticatorFixture();

    await expect(
      fixture.authenticator.authenticateSessionContext(
        { authorization: `PersonalRemote ${headerCredential}` },
        { mutation: true },
      ),
    ).resolves.toMatchObject({ credentialKind: "personal-remote-header" });
    expect(fixture.personalRemote.authenticateRemoteSession).not.toHaveBeenCalled();
  });

  it("refuses an authorization it cannot read instead of falling through to cookies", async () => {
    for (const authorization of [
      "Foo x",
      "Bearer",
      "PersonalRemote",
      `PersonalRemote ${headerCredential} extra`,
      "",
      [`PersonalRemote ${headerCredential}`, "Bearer other"],
    ]) {
      const fixture = authenticatorFixture();

      await expect(
        fixture.authenticator.authenticateSessionContext({ authorization }),
      ).rejects.toMatchObject({ code: "unauthorized" });
      expect(fixture.identity.requireSession).not.toHaveBeenCalled();
      expect(fixture.personalRemote.authenticateRemoteSession).not.toHaveBeenCalled();
      expect(fixture.personalRemote.authenticateRemoteCredential).not.toHaveBeenCalled();
    }
  });

  it("refuses a rejected Personal remote header rather than trying the cookie the request also carried", async () => {
    const fixture = authenticatorFixture();
    fixture.personalRemote.authenticateRemoteCredential.mockResolvedValue(null);

    await expect(
      fixture.authenticator.authenticateSessionContext({
        authorization: `PersonalRemote ${headerCredential}`,
        cookie: "__Host-opensteer.session=someone-elses",
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(fixture.personalRemote.authenticateRemoteSession).not.toHaveBeenCalled();
    expect(fixture.identity.requireSession).not.toHaveBeenCalled();
  });

  it("labels a bearer token and a browser cookie by the credential each actually is", async () => {
    const bearer = authenticatorFixture();
    await expect(
      bearer.authenticator.authenticateSessionContext({ authorization: "Bearer access-token" }),
    ).resolves.toMatchObject({ credentialKind: "native-oauth", surface: "canonical" });

    const browser = authenticatorFixture();
    await expect(
      browser.authenticator.authenticateSessionContext({
        cookie: "opensteer.session=cookie",
        origin: publicUrl.origin,
      }),
    ).resolves.toMatchObject({ credentialKind: "browser-cookie", surface: "canonical" });

    const remote = authenticatorFixture();
    remote.personalRemote.authenticateRemoteSession.mockResolvedValue(testSession());
    await expect(
      remote.authenticator.authenticateSessionContext({ cookie: "__Host-opensteer.session=x" }),
    ).resolves.toMatchObject({
      credentialKind: "personal-remote-cookie",
      surface: "personal-remote",
    });
  });

  it("never lets a Personal remote credential become the canonical browser cookie", async () => {
    // The identity service refuses a remote session in its canonical lookup,
    // which is what `requireSession` goes through. The chain has to surface
    // that refusal rather than treating it as an unauthenticated request.
    const fixture = authenticatorFixture();
    fixture.identity.requireSession.mockRejectedValue(
      new OpensteerError({ code: "unauthorized", message: "Authentication required" }),
    );

    for (const cookie of [
      `opensteer.session=${encodeURIComponent(headerCredential)}`,
      `__Host-opensteer.session=${encodeURIComponent(headerCredential)}`,
    ]) {
      await expect(
        fixture.authenticator.authenticateSessionContext({ cookie, origin: publicUrl.origin }),
      ).rejects.toMatchObject({ code: "unauthorized" });
    }
  });

  it("has no Personal remote family to answer from on a Deployment without one", async () => {
    const identity = identityFixture();
    const authenticator = new HostAuthenticator({ identity, publicUrl });

    await expect(
      authenticator.authenticateSessionContext({
        authorization: `PersonalRemote ${headerCredential}`,
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });
});

function authenticatorFixture() {
  const identity = identityFixture();
  const personalRemote = {
    authenticateRemoteCredential: vi.fn<
      PersonalRemoteSessionAuthenticator["authenticateRemoteCredential"]
    >(async () => testSession()),
    authenticateRemoteSession: vi.fn<
      PersonalRemoteSessionAuthenticator["authenticateRemoteSession"]
    >(async () => null),
  };
  return {
    authenticator: new HostAuthenticator({ identity, personalRemote, publicUrl }),
    identity,
    personalRemote,
  };
}

/** Checked against the real signatures, so a drifting fake fails to compile. */
function identityFixture() {
  const session = testSession();
  return {
    authenticateNativeAccessToken: vi.fn<
      HostAuthenticatingIdentity["authenticateNativeAccessToken"]
    >(async () => ({
      absoluteExpiresAt: new Date(session.absoluteExpiresAt),
      application: "mobile",
      clientId: "opensteer-mobile",
      createdAt: new Date(session.createdAt),
      expiresAt: new Date(session.expiresAt),
      sessionId: session.id,
      subject: session.user.id,
    })),
    requireSession: vi.fn<HostAuthenticatingIdentity["requireSession"]>(async () => session),
    userSessionProfile: vi.fn<HostAuthenticatingIdentity["userSessionProfile"]>(
      async () => session.user,
    ),
  };
}

function testSession(): AuthenticatedSession {
  return {
    absoluteExpiresAt: "2026-10-14T10:00:00.000Z",
    createdAt: "2026-09-14T10:00:00.000Z",
    expiresAt: "2026-09-21T10:00:00.000Z",
    id: createId("authSession"),
    user: {
      disabledAt: null,
      displayName: "You",
      email: "owner@personal.opensteer.invalid",
      emailVerified: true,
      id: createId("user"),
      image: null,
      instanceRole: "administrator",
    },
  };
}
