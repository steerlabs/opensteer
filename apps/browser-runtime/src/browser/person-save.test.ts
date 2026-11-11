import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import type { BrowserLoginAuthority, PersonSaveCandidate } from "@opensteer/browser-runtime-core";
import {
  passkeyProviderCertificate,
  passkeyProviderChromiumArguments,
  passkeyProviderKey,
} from "@opensteer/browser-runtime-core/test-support/passkey-provider";
import type { BrowserServerMessage, BrowserSurfaceId } from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import { cleanup } from "./browser-test-lifecycle.js";
import { asRecord, rootCdpNavigate, startFollowSession } from "./chromium.test-support.js";

const viewer = randomUUID();
/** A verdict waits two seconds for a password field to come back; this leaves room inside the test timeout. */
const stepWait = { timeout: 8_000 };

/**
 * A sign-in inside a shadow root that, like an app's, answers without a
 * navigation: it leaves, or on a wrong password draws its form again.
 */
const shadowForm = (
  signedIn: boolean,
) => `<!doctype html><title>App sign in</title><div id="host"></div><script>
const root = host.attachShadow({ mode: "open" });
const form = '<form><input id="u" autocomplete="username"><input id="p" type="password"><button>Sign in</button></form>';
root.innerHTML = form;
root.querySelector("form").addEventListener("submit", (event) => {
  event.preventDefault();
  setTimeout(() => ${signedIn} ? root.replaceChildren(Object.assign(document.createElement("p"), { textContent: "Signed in" })) : (root.innerHTML = form), 50);
});
</script>`;

/** An app's sign-in that refuses one username and, without a navigation, lets the next one in. */
const appRetry = `<!doctype html><title>App sign in</title><form id="f"><input id="u" autocomplete="username"><input id="p" type="password"><button>Sign in</button></form><script>
f.addEventListener("submit", (event) => {
  event.preventDefault();
  if (u.value !== "wrong@example.test") setTimeout(() => f.remove(), 50);
});
</script>`;
/** A sign-in in a frame, its username already known, telling its parent where it is. */
const frameSignIn = `<!doctype html><form method="post" action="/frame-home"><input type="hidden" autocomplete="username" value="framed@example.test"><input id="p" type="password"><button>Sign in</button></form><script>document.querySelector("#p").focus();parent.postMessage(location.pathname, "*")</script>`;
const framed = (sandbox: boolean) =>
  `<!doctype html><title>Framed</title><script>window.framePath = null; addEventListener("message", (event) => { window.framePath = event.data; });</script><iframe ${sandbox ? 'sandbox="allow-forms allow-scripts"' : ""} src="/frame-login"></iframe>`;

/**
 * A sign-in that goes home on another host of the site, one whose form comes
 * back as a failed sign-in does, one in a shadow root, one in an app that
 * answers in place and ones in frames.
 */
async function signInSite() {
  const form = (action: string, password = "password") =>
    `<!doctype html><title>Sign in</title><form method="post" action="${action}"><input id="u" name="username" autocomplete="username"><input id="p" name="${password}" type="password" autocomplete="current-password"><button>Sign in</button></form>`;
  const server = createServer(
    { key: passkeyProviderKey, cert: passkeyProviderCertificate },
    (request, response) => {
      const path = new URL(request.url ?? "/", "https://fixture").pathname;
      response.setHeader("content-type", "text/html");
      const host = request.headers.host ?? "";
      response.end(
        path === "/login"
          ? form(`https://app.example.test:${host.split(":")[1]}/home`)
          : path === "/shadow" || path === "/shadow-retry"
            ? shadowForm(path === "/shadow")
            : path === "/app-retry"
              ? appRetry
              : path === "/framed" || path === "/sandboxed"
                ? framed(path === "/sandboxed")
                : path === "/frame-login"
                  ? frameSignIn
                  : path === "/frame-home"
                    ? `<script>parent.postMessage("/frame-home", "*")</script>`
                    : path === "/plain"
                      ? form("/home")
                      : path === "/pin"
                        ? form("/home", "card-pin")
                        : path === "/retry"
                          ? form("/retry")
                          : "<!doctype html><title>Home</title><p>Signed in</p>",
      );
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `https://login.example.test:${(server.address() as AddressInfo).port}`;
}

function recordingAuthority() {
  const begun: PersonSaveCandidate[] = [];
  const transactions: string[] = [];
  const committed: string[] = [];
  const cancelled: string[] = [];
  const authority: BrowserLoginAuthority = {
    probe: async () => "no-login",
    authorize: async () => ({ kind: "ended", outcome: { kind: "cancelled", reason: "declined" } }),
    fill: async () => "unavailable",
    end: async () => undefined,
    personFillAccounts: async () => [],
    personFill: async () => "unavailable",
    personSaveBegin: async (candidate) => {
      begun.push(candidate);
      const transactionId = randomUUID();
      transactions.push(transactionId);
      return {
        kind: "offer",
        transactionId,
        expiresAt: Date.now() + 120_000,
        ended: new AbortController().signal,
      };
    },
    personSaveCommit: async (transactionId) => {
      committed.push(transactionId);
      return "saved";
    },
    personSaveCancel: (transactionId) => {
      cancelled.push(transactionId);
    },
  };
  return { authority, begun, transactions, committed, cancelled };
}

async function signInPage() {
  const origin = await signInSite();
  const recorded = recordingAuthority();
  const session = await startFollowSession({
    claims: { personFillVersion: 2 },
    loginAuthority: recorded.authority,
    args: passkeyProviderChromiumArguments,
  });
  const id = session.rootSurfaceId;
  const landed = (path: string) =>
    vi.waitFor(async () => {
      const state = asRecord(
        await session.read(id, "({ ready: document.readyState, path: location.pathname })"),
      );
      expect(state, `${path} loaded`).toMatchObject({ ready: "complete", path });
    }, stepWait);
  const open = async (path: string) => {
    await rootCdpNavigate(session.ledger, id, `${origin}${path}`);
    await landed(path);
  };
  const key = async (key: string, producerId = viewer) => {
    for (const action of ["down", "up"] as const)
      await session.controller.handle({
        type: "input.key",
        action,
        key,
        code: key === "Enter" ? "Enter" : "",
        modifiers: [],
        surfaceId: id,
        producerId,
        ...(action === "down" && key.length === 1 ? { text: key } : {}),
      });
  };
  const type = async (field: "u" | "p", text: string) => {
    await session.read(
      id,
      `(document.querySelector("#host")?.shadowRoot ?? document).querySelector("#${field}").focus()`,
    );
    for (const character of text) await key(character);
  };
  const saveMessages = <Type extends "browser.passwordSave.offer" | "browser.passwordSave.ended">(
    type: Type,
  ) =>
    session.sink.messages.filter(
      (message): message is Extract<BrowserServerMessage, { type: Type }> => message.type === type,
    );
  return { ...session, ...recorded, id, origin, open, landed, key, type, saveMessages };
}

describe("saving a login a person typed", () => {
  // One browser for every case with no agent in it: each step asks only about
  // what happened since it began, and ends whatever offer it made.
  it("offers only a person's finished sign-in, under its own site, to the viewer that typed it", async () => {
    const page = await signInPage();
    const offers = () => page.saveMessages("browser.passwordSave.offer");
    const ended = () => page.saveMessages("browser.passwordSave.ended");
    const since = () => {
      const at = [
        offers(),
        ended(),
        page.begun,
        page.transactions,
        page.cancelled,
        page.committed,
      ].map((list) => list.length);
      return {
        offers: () => offers().slice(at[0]),
        ended: () => ended().slice(at[1]),
        begun: () => page.begun.slice(at[2]),
        transactions: () => page.transactions.slice(at[3]),
        cancelled: () => page.cancelled.slice(at[4]),
        committed: () => page.committed.slice(at[5]),
      };
    };
    const answer = (offerId: string, save: boolean, producerId = viewer) =>
      page.controller.handle({
        type: "passwordSave.answer",
        surfaceId: page.id as BrowserSurfaceId,
        offerId,
        save,
        producerId,
      });
    const offered = async (step: ReturnType<typeof since>) => {
      await vi.waitFor(() => expect(step.offers(), "the offer").toHaveLength(1), stepWait);
      return step.offers()[0]!;
    };
    const dropped = (step: ReturnType<typeof since>) =>
      vi.waitFor(() => {
        expect(step.transactions(), "the login was held").toHaveLength(1);
        expect(step.cancelled(), "the held login was dropped").toEqual(step.transactions());
      }, stepWait);

    // A sign-in that moves on, here to another host of the site, keeps the site
    // it was typed on; only the typing viewer's answer saves it.
    let step = since();
    await page.open("/login");
    await page.type("u", "maya@example.test");
    await page.type("p", "synthetic-pw");
    await page.key("Enter");
    const offer = await offered(step);
    expect(offer).toMatchObject({
      surfaceId: page.id,
      consumerToken: viewer,
      offer: { kind: "save", origin: page.origin, username: "maya@example.test" },
    });
    expect(JSON.stringify(page.sink.messages)).not.toContain("synthetic-pw");
    expect(step.begun()).toEqual([
      {
        targetId: page.rootTargetId,
        origin: page.origin,
        username: "maya@example.test",
        password: "synthetic-pw",
        presence: "elsewhere",
      },
    ]);
    await answer(offer.offerId, true, randomUUID());
    expect(step.committed(), "another viewer cannot answer").toEqual([]);
    await answer(offer.offerId, true);
    await vi.waitFor(() => expect(step.ended(), "the result").toHaveLength(1), stepWait);
    expect(step.committed()).toEqual(step.transactions());
    expect(step.ended()[0]).toMatchObject({ offerId: offer.offerId, status: "saved" });

    // A form that comes back, as a failed sign-in's does, is dropped.
    step = since();
    await page.open("/retry");
    await page.type("u", "maya@example.test");
    await page.type("p", "wrong-pw");
    await page.key("Enter");
    await dropped(step);
    expect(step.offers()).toEqual([]);

    // A viewer that leaves before the sign-in settles takes its save with it.
    step = since();
    await page.open("/login");
    await page.type("u", "maya@example.test");
    await page.type("p", "synthetic-pw");
    await page.key("Enter");
    await vi.waitFor(
      () => expect(step.transactions(), "the login was held").toHaveLength(1),
      stepWait,
    );
    await page.controller.handle({ type: "input.cancel", producerId: viewer, ended: true });
    expect(step.cancelled(), "the held login was dropped").toEqual(step.transactions());
    await page.landed("/home");
    expect(step.offers()).toEqual([]);

    // In a shadow root, a form that leaves is a sign-in, and one drawn again is not.
    step = since();
    await page.open("/shadow");
    await page.type("u", "maya@example.test");
    await page.type("p", "synthetic-pw");
    await page.key("Enter");
    await answer((await offered(step)).offerId, false);
    expect(step.begun().map(({ username }) => username)).toEqual(["maya@example.test"]);
    step = since();
    await page.open("/shadow-retry");
    await page.type("u", "maya@example.test");
    await page.type("p", "wrong-pw");
    await page.key("Enter");
    await dropped(step);
    expect(step.offers()).toEqual([]);

    // An app that refuses one username and lets the corrected one in offers the corrected one.
    step = since();
    await page.open("/app-retry");
    await page.type("u", "wrong@example.test");
    await page.type("p", "synthetic-pw");
    await page.key("Enter");
    await vi.waitFor(
      () => expect(step.transactions(), "the first try was held").toHaveLength(1),
      stepWait,
    );
    await page.read(page.id, `document.querySelector("#u").value = ""`);
    await page.type("u", "maya@example.test");
    await page.key("Enter");
    const corrected = await offered(step);
    expect(corrected.offer).toMatchObject({ username: "maya@example.test" });
    expect(step.cancelled(), "the refused try was dropped").toEqual(
      step.transactions().slice(0, 1),
    );
    await answer(corrected.offerId, false);

    // A frame saves under its own origin; a sandboxed frame's is opaque, so it saves nothing.
    const framedSubmit = async (path: string) => {
      await page.open(path);
      await vi.waitFor(async () => {
        expect(await page.read(page.id, "window.framePath"), "the frame loaded").toBe(
          "/frame-login",
        );
      }, stepWait);
      for (const character of "synthetic-pw") await page.key(character);
      await page.key("Enter");
      await vi.waitFor(async () => {
        expect(await page.read(page.id, "window.framePath"), "the frame signed in").toBe(
          "/frame-home",
        );
      }, stepWait);
    };
    step = since();
    await framedSubmit("/sandboxed");
    await page.read(page.id, "1");
    expect(step.begun()).toEqual([]);
    await framedSubmit("/framed");
    await offered(step);
    expect(step.begun()).toMatchObject([{ origin: page.origin, username: "framed@example.test" }]);
  });

  it("never offers a PIN, or a password an agent typed or touched before the submit", async () => {
    const page = await signInPage();
    // The page reports a submit before it navigates, and a save that may begin
    // first asks the frame's origin on this same channel: one read after landing
    // comes back only after any such begin.
    const begunBy = async () => {
      await page.landed("/home");
      await page.read(page.id, "1");
      return page.begun.map(({ username }) => username);
    };
    // A PIN field is never a password to save, though the person typed it.
    await page.open("/pin");
    await page.type("u", "pin@example.test");
    await page.type("p", "1234");
    await page.key("Enter");
    expect(await begunBy()).toEqual([]);
    // The person types it, then an agent acts on the tab before the submit.
    await page.open("/login");
    await page.type("u", "agent-touched@example.test");
    await page.type("p", "touched-pw");
    const { sessionId } = asRecord(
      await page.agent("Target.attachToTarget", { targetId: page.rootTargetId, flatten: true }),
    );
    await page.key("Enter");
    expect(await begunBy()).toEqual([]);
    // An agent types the password.
    await page.open("/login");
    await page.type("u", "agent-typed@example.test");
    await page.read(page.id, `document.querySelector("#p").focus()`);
    await page.agent("Input.insertText", { text: "agent-pw" }, String(sessionId));
    await page.key("Enter");
    expect(await begunBy()).toEqual([]);
  });
});
