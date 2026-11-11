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
const step = { timeout: 8_000 };

/** A sign-in that goes home, and one whose form comes back as a failed sign-in does. */
async function signInSite() {
  const form = (action: string, password = "password") =>
    `<!doctype html><title>Sign in</title><form method="post" action="${action}"><input id="u" name="username" autocomplete="username"><input id="p" name="${password}" type="password" autocomplete="current-password"><button>Sign in</button></form>`;
  const server = createServer(
    { key: passkeyProviderKey, cert: passkeyProviderCertificate },
    (request, response) => {
      const path = new URL(request.url ?? "/", "https://fixture").pathname;
      response.setHeader("content-type", "text/html");
      response.end(
        path === "/login"
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
    authorize: async () => ({ kind: "ended", outcome: { kind: "cancelled" } }),
    fill: async () => "unavailable",
    end: async () => undefined,
    personFillAccounts: async () => [],
    personFill: async () => "unavailable",
    personSaveBegin: async (candidate) => {
      begun.push(candidate);
      const transactionId = randomUUID();
      transactions.push(transactionId);
      return { kind: "offer", transactionId, expiresAt: Date.now() + 120_000 };
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
    }, step);
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
    await session.read(id, `document.querySelector("#${field}").focus()`);
    for (const character of text) await key(character);
  };
  const saveMessages = (type: "browser.passwordSave.offer" | "browser.passwordSave.ended") =>
    session.sink.messages.filter(
      (message): message is Extract<BrowserServerMessage, { type: typeof type }> =>
        message.type === type,
    );
  return { ...session, ...recorded, id, origin, open, landed, key, type, saveMessages };
}

describe("saving a login a person typed", () => {
  it("offers it to the typing viewer once the sign-in moves on, and saves on that viewer's answer", async () => {
    const page = await signInPage();
    await page.open("/login");
    await page.type("u", "maya@example.test");
    await page.type("p", "synthetic-pw");
    await page.key("Enter");
    await vi.waitFor(
      () => expect(page.saveMessages("browser.passwordSave.offer"), "the offer").toHaveLength(1),
      step,
    );
    const [offer] = page.saveMessages("browser.passwordSave.offer");
    expect(offer).toMatchObject({
      surfaceId: page.id,
      consumerToken: viewer,
      offer: { kind: "save", origin: page.origin, username: "maya@example.test" },
    });
    expect(JSON.stringify(page.sink.messages)).not.toContain("synthetic-pw");
    expect(page.begun).toEqual([
      {
        targetId: page.rootTargetId,
        origin: page.origin,
        username: "maya@example.test",
        password: "synthetic-pw",
        presence: "elsewhere",
      },
    ]);
    const answer = (producerId: string) =>
      page.controller.handle({
        type: "passwordSave.answer",
        surfaceId: page.id as BrowserSurfaceId,
        offerId: offer!.offerId,
        save: true,
        producerId,
      });
    await answer(randomUUID());
    expect(page.committed, "another viewer cannot answer").toEqual([]);
    await answer(viewer);
    await vi.waitFor(
      () => expect(page.saveMessages("browser.passwordSave.ended"), "the result").toHaveLength(1),
      step,
    );
    expect(page.committed).toEqual(page.transactions);
    expect(page.saveMessages("browser.passwordSave.ended")[0]).toMatchObject({
      consumerToken: viewer,
      offerId: offer!.offerId,
      status: "saved",
    });
  });

  it("drops a login whose form comes back, as a failed sign-in's does", async () => {
    const page = await signInPage();
    await page.open("/retry");
    await page.type("u", "maya@example.test");
    await page.type("p", "wrong-pw");
    await page.key("Enter");
    await vi.waitFor(() => {
      expect(page.transactions, "the login was held").toHaveLength(1);
      expect(page.cancelled, "the held login was dropped").toEqual(page.transactions);
    }, step);
    expect(page.saveMessages("browser.passwordSave.offer")).toEqual([]);
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
