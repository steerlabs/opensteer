import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { expect, it } from "vitest";
import { chromium } from "playwright-core";
import { WebSocket } from "ws";
import { z } from "zod";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { decodeBase64Url } from "@opensteer/shared/base64url";
import {
  BrowserClientMessageSchema,
  BrowserServerMessageSchema,
  createBrowserSessionId,
  type BrowserServerMessage,
} from "../packages/protocol/src/browser.js";
import {
  PasskeyClaimSchema,
  PasskeyRespondSchema,
  NormalizedPasskeyCreationOptionsJSONSchema,
  NormalizedPasskeyRequestOptionsJSONSchema,
  passkeyBytesToJSON,
} from "../packages/protocol/src/passkeys.js";
import { PasskeyService, type PasskeyViewer } from "../apps/host/src/browser/passkey-service.js";
import { BrowserAttachTicketSigner } from "../apps/host/src/browser/browser-ticket.js";
import { PlaywrightChromiumLauncher } from "../apps/browser-runtime/src/browser/playwright-launcher.js";
import { BrowserRuntime } from "../packages/browser-runtime-core/src/runtime.js";
import { BrowserRuntimeServer } from "../packages/browser-runtime-core/src/server.js";
import { Ed25519AttachTicketVerifier } from "../packages/browser-runtime-core/src/security/attach-ticket.js";
import type {
  LaunchedBrowser,
  CdpSession,
} from "../packages/browser-runtime-core/src/browser/backend.js";
import {
  PasskeyProviderTestAuthenticator,
  passkeyProviderChromiumArguments,
} from "../packages/browser-runtime-core/src/test-support/passkey-provider-scenario.js";
import { servePasskeyRoutingFixture } from "../packages/browser-runtime-core/src/test-support/passkey-routing-fixture.js";

// No persistence is involved: real signed attach, WebSocket codecs, controller,
// browser, Host routing and RP verification run with a fake opted-in viewer.
it.each([true, false])(
  "routes real Chromium ceremonies over the browser wire (enabled=%s)",
  async (enabled) => {
    const directory = await mkdtemp(path.join(tmpdir(), "passkey-wire-"));
    const fixture = await servePasskeyRoutingFixture();
    const software = new PasskeyProviderTestAuthenticator();
    const keys = generateKeyPairSync("ed25519");
    const sessionId = createBrowserSessionId();
    const token = randomUUID();
    const otherToken = randomUUID();
    const messages: BrowserServerMessage[] = [];
    const offers: string[] = [];
    const other: BrowserServerMessage[] = [];
    const causes: unknown[] = [];
    let surfaceId: string | null = null;
    let surfaces: Extract<BrowserServerMessage, { type: "browser.snapshot" }>["surfaces"] = [];
    let browser: LaunchedBrowser | undefined;
    let socket: WebSocket | undefined;
    let cancelSheet = false;
    let nativeRequests = 0;
    const launcher = new PlaywrightChromiumLauncher({
      probePasskeys: true,
      chromiumSandbox: false,
      executablePath: chromium.executablePath(),
      headless: true,
      args: passkeyProviderChromiumArguments,
    });
    const verifier = await Ed25519AttachTicketVerifier.create({
      replayLedgerPath: path.join(directory, "runtime", "replay.json"),
      resolvePublicKey: () => keys.publicKey,
    });
    const runtime = new BrowserRuntime({
      launcher: {
        prepare: () => launcher.prepare(),
        async launch(request) {
          browser = await launcher.launch(request);
          return browser;
        },
      },
      runtimeId: "example",
      sessionFilesRoot: path.join(directory, "files"),
      ticketVerifier: verifier,
      profileStateClient: {
        load: async () => {
          throw new Error("Fresh session loaded profile");
        },
        commit: async () => {
          throw new Error("Fresh session committed profile");
        },
      },
    });
    const server = new BrowserRuntimeServer({
      runtime,
      port: 0,
      relayBridge: { token: "example-bridge", updateAttachKeys: () => undefined },
    });
    const send = (value: unknown) =>
      socket!.send(JSON.stringify(BrowserClientMessageSchema.parse(value)));
    const viewer: PasskeyViewer = {
      token,
      userId: "person",
      fullControl: true,
      mode: "native",
      surfaceId,
      live: true,
      authorized: async () => true,
      send(message) {
        const parsed = BrowserServerMessageSchema.parse(JSON.parse(JSON.stringify(message)));
        messages.push(parsed);
        if (parsed.type === "browser.passkey.offer") offers.push(parsed.requestId);
        if (parsed.type !== "browser.passkey.request") return;
        nativeRequests++;
        const common = {
          origin: parsed.origin,
          rpId: parsed.rpId,
          clientDataJSON: decodeBase64Url(parsed.clientDataJSON),
          signal: new AbortController().signal,
        };
        void (
          cancelSheet
            ? Promise.resolve({ kind: "refused", error: "NotAllowedError" } as const)
            : software.ceremony(
                parsed.op === "create"
                  ? {
                      ...common,
                      op: "create",
                      options: NormalizedPasskeyCreationOptionsJSONSchema.parse(parsed.options),
                    }
                  : {
                      ...common,
                      op: "get",
                      options: NormalizedPasskeyRequestOptionsJSONSchema.parse(parsed.options),
                    },
              )
        ).then((outcome) =>
          host.viewer(
            token,
            PasskeyRespondSchema.parse({
              type: "passkey.respond",
              requestId: parsed.requestId,
              outcome: passkeyBytesToJSON(outcome),
            }),
          ),
        );
      },
    };
    const second: PasskeyViewer = {
      ...viewer,
      token: otherToken,
      send: (message) => other.push(BrowserServerMessageSchema.parse(message)),
    };
    const host = new PasskeyService({
      ownOrigins: () => [],
      viewers: () => [viewer, second],
      result: send,
    });
    try {
      const address = await server.start();
      const ticket = new BrowserAttachTicketSigner({
        keyId: "example",
        privateKey: keys.privateKey,
      }).issue({
        access: "full-control",
        runtimeId: "example",
        sessionId,
        subject: "person",
        identity: { kind: "fresh" },
        ...(enabled ? { passkeys: 1 } : {}),
      });
      socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/browser`, {
        headers: {
          authorization: `Bearer ${ticket}`,
          "x-opensteer-browser-bridge-token": "example-bridge",
          "x-opensteer-browser-attach-keys": Buffer.from(
            JSON.stringify([
              {
                keyId: "example",
                publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }),
              },
            ]),
          ).toString("base64url"),
          ...(enabled ? { "x-opensteer-browser-passkeys": "1" } : {}),
        },
      });
      socket.on("message", (data, binary) => {
        assert(!binary);
        const message = BrowserServerMessageSchema.parse(JSON.parse(data.toString()));
        if (message.type === "browser.snapshot") surfaceId = message.surfaces[0]?.id ?? null;
        if (message.type === "browser.snapshot" || message.type === "browser.surfaces.changed")
          surfaces = message.surfaces;
        if (message.type === "passkey.ceremony") {
          causes.push(message.cause);
          host.ceremony(message);
        }
        if (message.type === "passkey.cancel") host.cancel(message.ceremonyId);
        assert(message.type !== "browser.error", JSON.stringify(message));
      });
      await withTimeout(once(socket, "open"), 4500, {
        timeoutError: () => new Error("Browser socket did not open"),
      });
      await expect.poll(() => surfaceId, { timeout: 4500 }).toBeTruthy();
      viewer.surfaceId = second.surfaceId = surfaceId;
      assert(browser);
      const cdp = await browser.context.pages()[0]!.cdp();
      send({ type: "stream.subscribe", frames: false, surfaceId, producerId: token });
      send({ type: "navigation.go", url: fixture.origin, surfaceId });
      await expect
        .poll(() => evaluate(cdp, "typeof window.runCeremony"), { timeout: 4500 })
        .toBe("function");
      if (!enabled) {
        const started = Date.now();
        expect(
          await evaluate(
            cdp,
            `(async()=>({provider:typeof PublicKeyCredential,outcome:await navigator.credentials.get({publicKey:{challenge:new Uint8Array([1])}}).then(()=>"resolved",e=>e.name)}))()`,
          ),
        ).toEqual({ provider: "undefined", outcome: "NotAllowedError" });
        expect(Date.now() - started).toBeLessThan(1500);
        expect(causes).toEqual([]);
        return;
      }
      const result = async (expression: string, expected: string) => {
        const value = z
          .object({ outcome: z.string(), ms: z.number() })
          .parse(await evaluate(cdp, expression));
        expect(value.outcome).toBe(expected);
        expect(value.ms).toBeLessThan(4000);
        return value;
      };
      const click = async (op: "create" | "get") => {
        await evaluate(cdp, `document.getElementById(${JSON.stringify(op)}).focus()`);
        for (const action of ["down", "up"])
          send({
            type: "input.key",
            action,
            key: "Enter",
            code: "Enter",
            modifiers: [],
            surfaceId,
            consumerToken: token,
            producerId: token,
          });
        await expect
          .poll(() => evaluate(cdp, "typeof window.result"), { timeout: 4500 })
          .toBe("object");
        await result("window.result", "verified");
        await evaluate(cdp, "delete window.result");
      };
      await click("create");
      await click("get");
      expect(causes.slice(0, 2)).toEqual([{ person: token }, { person: token }]);
      expect(other).toEqual([]);
      await result("window.runCeremony('create','exclude')", "InvalidStateError");
      cancelSheet = true;
      await result("window.runCeremony('get')", "NotAllowedError");
      cancelSheet = false;
      await result("window.runCeremony('get','missing')", "NotAllowedError");
      const before = nativeRequests;
      viewer.mode = "notice";
      const notice = await result("window.runCeremony('get')", "NotAllowedError");
      expect(notice.ms).toBeLessThan(1500);
      expect(nativeRequests).toBe(before);
      expect(other).toEqual([]);
      expect(messages.some((message) => message.type === "browser.passkey.notice")).toBe(true);
      viewer.mode = "native";
      // A new document has no person input. Its load-time request must wait for Continue.
      send({ type: "surface.open", url: fixture.origin });
      await expect.poll(() => browser!.context.pages().length, { timeout: 4500 }).toBe(2);
      const offeredPage = browser.context
        .pages()
        .find((page) => page !== browser!.context.pages()[0])!;
      const offeredCdp = await offeredPage.cdp();
      await expect
        .poll(() => evaluate(offeredCdp, "typeof window.runCeremony"), { timeout: 4500 })
        .toBe("function");
      // Runtime surface IDs come from the public inventory.
      await expect.poll(() => surfaces.length, { timeout: 4500 }).toBe(2);
      const offeredSurface = surfaces.find((surface) => surface.id !== surfaceId);
      assert(offeredSurface);
      viewer.surfaceId = second.surfaceId = offeredSurface.id;
      await offeredCdp.send("Page.navigate", { url: `${fixture.origin}/offer` });
      await expect.poll(() => offers.length, { timeout: 4500 }).toBe(1);
      expect(nativeRequests).toBe(before);
      await host.viewer(
        token,
        PasskeyClaimSchema.parse({ type: "passkey.claim", requestId: offers[0] }),
      );
      const offered = z
        .object({ outcome: z.string(), ms: z.number() })
        .parse(await evaluate(offeredCdp, "window.result"));
      expect(offered.outcome).toBe("verified");
      expect(offered.ms).toBeLessThan(4000);
      const requestsBeforeFrame = nativeRequests;
      expect(
        await evaluate(
          offeredCdp,
          `new Promise(resolve=>{addEventListener('message',e=>resolve(e.data),{once:true});const f=document.createElement('iframe');f.allow='publickey-credentials-get *';f.src=${JSON.stringify(fixture.crossOrigin + "/probe")};document.body.append(f);setTimeout(()=>resolve('pending'),1500);})`,
        ),
      ).toBe("NotAllowedError");
      expect(nativeRequests).toBe(requestsBeforeFrame);
      expect(fixture.verified).toEqual({ registrations: 2, assertions: 1 });
    } finally {
      host.close();
      socket?.terminate();
      await server.close();
      await runtime.shutdown();
      await fixture.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

async function evaluate(cdp: CdpSession, expression: string): Promise<unknown> {
  const value = await withTimeout(
    cdp.send<{ result: { value?: unknown }; exceptionDetails?: unknown }>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }),
    4500,
    { timeoutError: () => new Error("Page evaluation timed out") },
  );
  assert(!value.exceptionDetails, JSON.stringify(value.exceptionDetails));
  return value.result.value;
}
