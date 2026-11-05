import { runInNewContext } from "node:vm";
import Fastify from "fastify";
import { createId } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import { createPortalRouter } from "./portal.js";
import { ControlPlaneError } from "../server/errors.js";

describe("Account linking from a Host browser", () => {
  it("requires explicit portal consent and protects the cookie-authorized challenge and completion", async () => {
    const accountId = `acct_${crypto.randomUUID()}`;
    const issueLinkChallenge = vi.fn(async () => ({ issued: true }));
    const completeLink = vi.fn();
    const router = createPortalRouter({
      accountDeletion: {} as never,
      auth: {} as never,
      portalOrigin: new URL("https://portal.test"),
      publicOrigin: new URL("https://accounts.portal.test"),
      portalSessions: {
        read: async () => ({
          accountId,
          accountSessionId: "session",
          email: "owner@example.test",
          displayName: "Owner",
          expiresAt: new Date(Date.now() + 3600000),
        }),
      } as never,
      personalRemoteAccount: { issueLinkChallenge, completeLink } as never,
      store: {} as never,
    });
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) =>
      reply.code(error instanceof ControlPlaneError ? error.status : 400).send({ failed: true }),
    );
    router.register(app);
    const headers = { host: "portal.test", cookie: "__Host-opensteer.portal=session" };
    try {
      const page = await app.inject({
        method: "GET",
        url: `/personal-host-link?origin=${encodeURIComponent("https://computer.private.test")}&nonce=${crypto.randomUUID()}`,
        headers,
      });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain("Link this computer");
      expect(page.body).toContain("owner@example.test");
      expect(page.body).toContain("computer.private.test");
      expect(page.body).toContain("event.source !== parent");
      expect(page.body).toContain("event.origin !== parameters.origin");
      expect(page.body).toContain("allow.onclick");
      const policy = String(page.headers["content-security-policy"]);
      expect(policy).toMatch(/script-src 'nonce-[\w-]+'/u);
      expect(policy).toContain("connect-src 'self'");
      expect(policy).not.toContain("unsafe-eval");
      expect(issueLinkChallenge).not.toHaveBeenCalled();
      // Exercise the popup wire without a browser or a real Account credential.
      const script = page.body.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u)?.[1];
      if (!script) throw new Error("The Account courier script is missing");
      const callbacks = new Map<string, (event: unknown) => Promise<void>>();
      const elements: Record<
        string,
        {
          dataset: Record<string, string>;
          disabled: boolean;
          textContent: string;
          onclick?: () => Promise<void>;
        }
      > = {};
      const parts = ["linked", "failed"].map((when) => ({ dataset: { when }, hidden: true }));
      const parent = { postMessage: vi.fn() };
      const issuedId = `phc_${crypto.randomUUID()}`;
      const fetch = vi.fn(async () => Response.json({ challengeId: issuedId }));
      runInNewContext(script, {
        window: {
          opener: parent,
          addEventListener: (kind: string, callback: (event: unknown) => Promise<void>) =>
            callbacks.set(kind, callback),
        },
        document: {
          getElementById: (id: string) =>
            (elements[id] ??= { dataset: {}, disabled: id === "allow", textContent: "" }),
          querySelectorAll: () => parts,
        },
        fetch,
        setTimeout: vi.fn(),
      });
      const state = () => elements.link?.dataset.state;
      const ready = parent.postMessage.mock.calls[0]?.[0] as { nonce: string };
      const receive = callbacks.get("message")!;
      await receive({
        source: {},
        origin: "https://computer.private.test",
        data: { nonce: ready.nonce, kind: "challenge", input: { name: "Wrong source" } },
      });
      expect(elements.allow!.disabled).toBe(true);
      expect(elements.title!.textContent).toBe("");
      await receive({
        source: parent,
        origin: "https://computer.private.test",
        data: { nonce: ready.nonce, kind: "challenge", input: { name: "My computer" } },
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(elements.title!.textContent).toBe("Link My computer");
      expect(elements.allow!.disabled).toBe(false);
      expect(state()).toBe("ready");
      await elements.allow!.onclick!();
      expect(fetch).toHaveBeenCalledOnce();
      expect(state()).toBe("linking");
      const complete = (id: string) => ({
        source: parent,
        origin: "https://computer.private.test",
        data: {
          nonce: ready.nonce,
          kind: "complete",
          input: { proof: { document: { challenge: { id } } } },
        },
      });
      await receive(complete(`phc_${crypto.randomUUID()}`));
      expect(fetch).toHaveBeenCalledOnce();
      await receive(complete(issuedId));
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(state()).toBe("linked");
      expect(parts.find((part) => part.dataset.when === "linked")?.hidden).toBe(false);
      expect(parts.find((part) => part.dataset.when === "failed")?.hidden).toBe(true);

      for (const path of ["challenge", "complete"]) {
        for (const origin of [
          "https://hostile.test",
          "https://accounts.portal.test",
          "https://portal.test.evil.test",
        ]) {
          const rejected = await app.inject({
            method: "POST",
            url: `/personal-host-link/${path}`,
            headers: { ...headers, origin },
            payload: {},
          });
          expect(rejected.statusCode).toBe(403);
        }
      }
      expect(completeLink).not.toHaveBeenCalled();
      const challenge = {
        authorityEnvelope: {
          document: {
            canonicalOrigin: "http://127.0.0.1:4310",
            deploymentId: createId("deployment"),
            hostInstanceId: createId("hostInstance"),
            hostKey: { algorithm: "Ed25519" },
            deploymentShape: { kind: "personal", defaultWorkspaceBacking: "local-directory" },
          },
          publicKey: { algorithm: "Ed25519", spki: "A".repeat(59) },
          signature: "A".repeat(86),
        },
        name: "My computer",
        operationId: `plo_${crypto.randomUUID()}`,
      };
      const accepted = await app.inject({
        method: "POST",
        url: "/personal-host-link/challenge",
        headers: { ...headers, origin: "https://portal.test" },
        payload: challenge,
      });
      expect(accepted.statusCode).toBe(200);
      expect(issueLinkChallenge).toHaveBeenCalledWith(accountId, challenge);
      const signedOut = await app.inject({
        method: "POST",
        url: "/personal-host-link/challenge",
        headers: { host: "portal.test", origin: "https://portal.test" },
        payload: challenge,
      });
      expect(signedOut.statusCode).toBe(401);
      expect(issueLinkChallenge).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });
});
