import { createId, type AuthenticatedSession } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { HostAuthenticator, type RequestHeaders } from "./auth.js";

const loopbackHome = "http://127.0.0.1:4310";
const route = "https://home.connect.example";
const session: AuthenticatedSession = {
  id: createId("authSession"),
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  absoluteExpiresAt: new Date(Date.now() + 3600000).toISOString(),
  user: {
    id: createId("user"),
    displayName: "Owner",
    email: "owner@example.test",
    emailVerified: true,
    disabledAt: null,
    image: null,
  },
};

/** A Home whose identity answers its own cookie, a remote cookie on its route, and a bearer. */
function home(publicOrigin = loopbackHome) {
  return new HostAuthenticator({
    identity: {
      requireSession: async (headers: Headers) => {
        if (!headers.get("cookie")?.includes("opensteer.session=")) throw new Error("no session");
        return session;
      },
      userSessionProfile: async () => session.user,
      authenticateNativeAccessToken: async () => ({
        sessionId: session.id,
        subject: session.user.id,
        createdAt: new Date(session.createdAt),
        expiresAt: new Date(session.expiresAt),
        absoluteExpiresAt: new Date(session.absoluteExpiresAt),
      }),
    } as never,
    personalRemote: {
      authenticateRemoteCredential: async () => session,
      // As the identity does: a remote cookie, and an Origin when one is demanded, its route's.
      authenticateRemoteSession: async (headers, options) =>
        typeof headers.cookie === "string" &&
        headers.cookie.includes("__Host-opensteer.session=") &&
        (!options?.mutation || headers.origin === route)
          ? session
          : null,
    },
    publicUrl: new URL(publicOrigin),
  });
}

const accepted = async (headers: RequestHeaders, mutation = false, at = loopbackHome) =>
  expect(home(at).authenticateSession(headers, { mutation })).resolves.toEqual(session);
const refused = async (headers: RequestHeaders, mutation = false, at = loopbackHome) =>
  expect(home(at).authenticateSession(headers, { mutation })).rejects.toMatchObject({
    code: "forbidden",
    message: "Request origin is not allowed",
  });

describe("a cookie's request comes from the Home's own page, in every scope (q1)", () => {
  const cookie = "opensteer.session=s; theirs=1";
  const foreign = [
    ["a dev server on another loopback port", { origin: "http://127.0.0.1:5173" }],
    ["another loopback name", { origin: "http://localhost:4310" }],
    ["an opaque origin", { origin: "null" }],
    ["a same-site page (another loopback port)", { "sec-fetch-site": "same-site" }],
    ["a cross-site page", { "sec-fetch-site": "cross-site" }],
  ] as const;
  for (const [who, headers] of foreign) {
    it(`refuses a read from ${who}`, () => refused({ cookie, ...headers }));
    it(`refuses a change from ${who}`, () =>
      refused({ cookie, origin: loopbackHome, ...headers }, true));
  }

  it("keeps working for the Home's own pages, the app and the person's address bar", async () => {
    // The web app in Chrome or Safari: a same-origin read sends no Origin; a change sends it.
    await accepted({ cookie, "sec-fetch-site": "same-origin" });
    await accepted({ cookie, origin: loopbackHome, "sec-fetch-site": "same-origin" }, true);
    // An address the person typed, or a bookmark: a top-level navigation the page did not make.
    await accepted({ cookie, "sec-fetch-site": "none" });
    // The desktop app's main process states the Home's origin itself; Chromium marks a request no
    // page made `none`, and an older engine sends no Sec-Fetch-Site at all.
    await accepted({ cookie, origin: loopbackHome, "sec-fetch-site": "none" }, true);
    await accepted({ cookie, origin: loopbackHome }, true);
    await accepted({ cookie, origin: loopbackHome });
    // A browser that sends neither header (an older Safari) is answered as before.
    await accepted({ cookie });
  });

  it("keeps working on an HTTPS Home and on its remote route", async () => {
    const hosted = "https://home.example.com";
    await accepted({ cookie, "sec-fetch-site": "same-origin" }, false, hosted);
    await accepted({ cookie, origin: hosted, "sec-fetch-site": "same-origin" }, true, hosted);
    await refused({ cookie, origin: "https://evil.example.com" }, false, hosted);
    // A remote cookie on the route: its Origin is the route's, for a read as for a change.
    const remote = "__Host-opensteer.session=r";
    await accepted({ cookie: remote, origin: route, "sec-fetch-site": "same-origin" });
    await accepted({ cookie: remote, origin: route, "sec-fetch-site": "same-origin" }, true);
    await accepted({ cookie: remote, "sec-fetch-site": "same-origin" });
    await refused({ cookie: remote, origin: "https://evil.example.com" });
    await refused({ cookie: remote, "sec-fetch-site": "same-site" });
  });

  it("asks nothing of a credential that is not ambient: the phone's and the apps' bearer", async () => {
    await expect(
      home().authenticateSession({
        authorization: "Bearer native-token",
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      }),
    ).resolves.toEqual(session);
  });
});
