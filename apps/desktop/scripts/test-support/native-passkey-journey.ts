import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DeploymentIdSchema } from "@opensteer/core";
import { passkeyNotice } from "@opensteer/client/host";
import {
  BrowserClientMessageSchema,
  BrowserServerMessageSchema,
  type BrowserServerMessage,
} from "@opensteer/protocol";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { PasskeyProviderTestAuthenticator } from "@opensteer/browser-runtime-core/test-support/passkey-provider";
import { servePasskeyRoutingFixture } from "@opensteer/browser-runtime-core/test-support/passkey-routing";
import type { NativePasskeys } from "../../src/passkeys/native-passkeys.js";
import type { NativeBrowserE2EKit } from "../electron-native-browser-kit.js";
import { nativeJourneyClick } from "../native-browser-journey-steps.js";

/** Imported only by the VM test entry; no production launcher can select this authenticator. */
export async function createNativePasskeyJourney({
  nativeAvailable = true,
}: { nativeAvailable?: boolean } = {}) {
  const site = await servePasskeyRoutingFixture();
  const software = new PasskeyProviderTestAuthenticator();
  let nativeCalls = 0;
  let cancelNext = false;
  let cancelledSheets = 0;
  const native: NativePasskeys = {
    available: () => nativeAvailable,
    perform(request, signal) {
      nativeCalls++;
      assert(nativeAvailable, "A notice-only Mac cannot enter the authenticator");
      assert(!request.window.isDestroyed(), "Real presenting window is live");
      if (cancelNext) {
        cancelNext = false;
        cancelledSheets++;
        return Promise.resolve({ kind: "refused", error: "NotAllowedError" } as const);
      }
      return software.ceremony({ ...request, signal });
    },
  };
  return {
    native,
    close: () => site.close(),
    async run(kit: NativeBrowserE2EKit) {
      const started = performance.now();
      const caseId = nativeAvailable ? "passkeys" : "passkeys-notice";
      const cases: Record<string, unknown> = {};
      let stage = "open";
      const begin = (value: string) => {
        stage = value;
        kit.artifacts.event("passkeys.stage", { stage });
      };
      const open = async () => {
        const result = await kit.context.api["commands.dispatch"]({
          type: "browser.tab.open",
          sessionId: kit.context.sessionId,
          idempotencyKey: randomUUID(),
          url: site.origin,
        });
        assert(result.ok && result.data.type === "browser.tab.open");
        await kit.selectNativePage(kit.context.sessionId, result.data.tabId);
        await kit.until(
          async () =>
            (await kit.pageContents().executeJavaScript("typeof window.runCeremony")) ===
            "function",
          "RP loaded",
          4500,
        );
      };
      const read = async (label: string, expected: string, upper = 4000) => {
        const value: unknown = await withTimeout(
          kit.pageContents().executeJavaScript("window.result"),
          upper,
          { timeoutError: () => new Error(`${label} did not settle within ${upper}ms`) },
        );
        const parsed = z.object({ outcome: z.string(), ms: z.number() }).parse(value);
        assert.equal(parsed.outcome, expected);
        assert(parsed.ms < upper, label);
        cases[label] = parsed;
      };
      const click = async (
        op: "create" | "get",
        label: string,
        expected: string,
        mode = "normal",
        upper = 4000,
      ) => {
        begin(label);
        await kit
          .pageContents()
          .executeJavaScript(`window.ceremonyMode=${JSON.stringify(mode)}; delete window.result`);
        await nativeJourneyClick(kit, `#${op}`);
        await kit.until(
          async () =>
            (await kit.pageContents().executeJavaScript("typeof window.result")) === "object",
          `${label} started`,
          1500,
        );
        await read(label, expected, upper);
      };
      const notice = async () => {
        begin("notice-only");
        const surfaceId = kit.activeSurface().surfaceId;
        const admitted = Promise.withResolvers<void>();
        const closed = Promise.withResolvers<void>();
        let acknowledgements = 0;
        let closing = false;
        let socketError: Error | undefined;
        const otherMessages: BrowserServerMessage[] = [];
        const url = new URL(
          `/v1/browser-sessions/${kit.context.sessionId}/connect?passkeys=native`,
          kit.context.hostOrigin,
        );
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        const other = kit.context.network.openWebSocket(
          {
            authorization: null,
            canonicalOrigin: kit.context.hostOrigin,
            requestOrigin: kit.context.hostOrigin,
            deploymentId: DeploymentIdSchema.parse(kit.context.deploymentId),
            url: url.href,
          },
          {
            open: () => undefined,
            error: (message) => {
              socketError = new Error(message);
              admitted.reject(socketError);
            },
            close: (code) => {
              if (!closing) {
                socketError = new Error(`Other viewer closed: ${code}`);
                admitted.reject(socketError);
              }
              closed.resolve();
            },
            message: (data) => {
              assert.equal(typeof data, "string");
              if (typeof data !== "string") return;
              const message = BrowserServerMessageSchema.parse(JSON.parse(data));
              otherMessages.push(message);
              if (message.type === "browser.snapshot") {
                assert.equal(message.access, "full-control");
                assert.equal(message.passkeys, "native");
                admitted.resolve();
              }
              if (message.type === "browser.dialog.changed" && message.surfaceId === surfaceId)
                acknowledgements++;
            },
          },
        );
        const send = (value: unknown) =>
          other.send(JSON.stringify(BrowserClientMessageSchema.parse(value)));
        const subscribe = async () => {
          const before = acknowledgements;
          send({ type: "stream.subscribe", frames: false, surfaceId });
          await kit.until(
            async () => {
              if (socketError) throw socketError;
              return acknowledgements > before;
            },
            "Other viewer presents the same RP",
            1500,
          );
        };
        try {
          await withTimeout(admitted.promise, 1500, {
            timeoutError: () => new Error("Other viewer admission did not settle"),
          });
          await subscribe();
          const snapshot = kit.incomingMessages.findLast(
            (message) => message.type === "browser.snapshot",
          );
          assert(snapshot?.type === "browser.snapshot");
          assert.equal(snapshot.passkeys, "notice");
          await click("create", "notice-only", "NotAllowedError", "normal", 1500);
          await kit.until(
            async () =>
              Boolean(
                await kit.evaluateApp(`(() => {
            const notice = document.querySelector('.browser-passkey-bar');
            return !!notice && notice.getClientRects().length > 0 && getComputedStyle(notice).visibility !== 'hidden' && notice.textContent.includes(${JSON.stringify(passkeyNotice)});
          })()`),
              ),
            "Notice visible in the presenting window",
            1500,
          );
          assert.equal(
            await kit.evaluateApp(
              "document.querySelectorAll('.browser-passkey-bar button').length",
            ),
            0,
          );
          assert.equal(nativeCalls, 0);
          // The subscription acknowledgement follows any earlier messages on this socket.
          send({ type: "stream.unsubscribe", surfaceId });
          await subscribe();
          const ceremonies = (messages: readonly BrowserServerMessage[]) =>
            messages.filter(
              (message) =>
                message.type === "browser.passkey.offer" ||
                message.type === "browser.passkey.request",
            );
          assert.equal(
            ceremonies(otherMessages).length,
            0,
            "Nothing is offered or requested on another viewer",
          );
          assert.equal(ceremonies(kit.incomingMessages).length, 0);
          assert.equal(socketError, undefined, "Other viewer remains live");
          cases["notice-assertions"] = {
            noticeVisible: true,
            nativeCalls,
            otherViewerOffers: 0,
            otherViewerRequests: 0,
          };
        } finally {
          closing = true;
          other.close(1000, "Journey complete");
          await withTimeout(closed.promise, 1500, {
            timeoutError: () => new Error("Other viewer did not close"),
          });
        }
      };
      try {
        await withTimeout(
          (async () => {
            await open();
            if (!nativeAvailable) {
              await notice();
            } else {
              await click("create", "create", "verified");
              await click("get", "get", "verified");
              assert.equal(nativeCalls, 2);
              assert.equal(
                await kit.evaluateApp(
                  "document.querySelectorAll('.browser-passkey-bar button').length",
                ),
                0,
              );
              await click("create", "excluded", "InvalidStateError", "exclude");
              assert.equal(nativeCalls, 3);
              begin("cross-origin");
              const beforeFrame = nativeCalls;
              await kit.pageContents().executeJavaScript(`window.result=(async()=>{
              const started=performance.now(); const frame=document.createElement('iframe');
              frame.allow='publickey-credentials-get *; publickey-credentials-create *';
              frame.src=${JSON.stringify(site.crossOrigin + "/probe")};
              let timer, listener;
              try { const outcome=await new Promise(resolve=>{
                listener=event=>{if(event.source===frame.contentWindow && event.origin===${JSON.stringify(site.crossOrigin)}) resolve(event.data);};
                addEventListener('message',listener); timer=setTimeout(()=>resolve('pending'),1500); document.body.append(frame);
              }); return {outcome,ms:Math.round(performance.now()-started)}; }
              finally {clearTimeout(timer);removeEventListener('message',listener);frame.remove();}
            })(); true`);
              await read("cross-origin", "NotAllowedError", 1500);
              assert.equal(
                nativeCalls,
                beforeFrame,
                "A cross-origin frame cannot enter the authenticator",
              );
              const beforeCancel = nativeCalls;
              cancelNext = true;
              await click("get", "cancelled-sheet", "NotAllowedError");
              assert.equal(cancelledSheets, 1);
              assert.equal(nativeCalls, beforeCancel + 1);
              const beforeMissing = nativeCalls;
              await click("get", "no-matching-credential", "NotAllowedError", "missing");
              assert.equal(nativeCalls, beforeMissing + 1);
              begin("offer-claim");
              const beforeOffer = nativeCalls;
              await open();
              await kit.pageContents().loadURL(`${site.origin}/offer`);
              await kit.until(
                async () =>
                  Boolean(
                    await kit.evaluateApp(
                      "document.querySelector('.browser-passkey-bar button') !== null",
                    ),
                  ),
                "Continue offered",
                1500,
              );
              assert.equal(
                nativeCalls,
                beforeOffer,
                "Offer cannot open a native ceremony before Continue",
              );
              await nativeJourneyClick(kit, ".browser-passkey-bar button", false);
              await read("offer-claim", "verified");
              assert.equal(nativeCalls, beforeOffer + 1);
              assert.deepEqual(site.verified, { registrations: 2, assertions: 1 });
            }
            kit.artifacts.json(`${caseId}.json`, {
              cases,
              verified: site.verified,
              nativeAvailable,
              nativeCalls,
            });
            await kit.snapshot(caseId, "verified");
          })(),
          30_000,
          { timeoutError: () => new Error("Personal passkey journey exceeded 30000ms") },
        );
        kit.artifacts.result(caseId, "PASS", {
          measurements: { seconds: (performance.now() - started) / 1000 },
          evidence: [`${caseId}.json`, `cases/${caseId}`],
        });
      } catch (error) {
        kit.artifacts.result(caseId, "FAIL", {
          reason: `${stage}: ${kit.errorText(error)}`,
          measurements: { seconds: (performance.now() - started) / 1000 },
          evidence: ["trace.jsonl"],
        });
        throw error;
      }
    },
  };
}
