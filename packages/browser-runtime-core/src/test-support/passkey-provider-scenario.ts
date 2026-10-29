import { once } from "node:events";
import { createServer } from "node:https";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createHash, randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { strict as assert } from "node:assert";
import { z } from "zod";
import { verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { createBrowserSessionId } from "@opensteer/protocol";
import { delay } from "@opensteer/shared/delay";
import { withTimeout } from "@opensteer/shared/withTimeout";
import type { BrowserLauncher, CdpSession, LaunchedBrowser } from "../browser/backend.js";
import type {
  PasskeyAuthenticator,
  PasskeyAuthenticatorInput,
  PasskeyAuthenticatorOutcome,
} from "../passkeys/index.js";
import { PasskeyTestAuthenticator } from "./passkey-test-authenticator.js";
import { key, cert, untrustedKey, untrustedCert } from "./fixtures/passkey-provider-tls.js";
export {
  cert as passkeyProviderCertificate,
  untrustedCert,
} from "./fixtures/passkey-provider-tls.js";

export const passkeyProviderChromiumArguments = [
  "--host-resolver-rules=MAP *.example.test 127.0.0.1",
  `--ignore-certificate-errors-spki-list=${createHash("sha256")
    .update(new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" }))
    .digest("base64")}`,
  "--no-proxy-server",
];
/** The same software authenticator in both engines, with observable cancellation. */
export class PasskeyProviderTestAuthenticator implements PasskeyAuthenticator {
  readonly #software = new PasskeyTestAuthenticator();
  calls = 0;
  holdNext = false;
  pending = 0;
  cancelled = 0;
  ceremony(input: PasskeyAuthenticatorInput): Promise<PasskeyAuthenticatorOutcome> {
    this.calls++;
    if (!this.holdNext) return this.#software.ceremony(input);
    this.holdNext = false;
    this.pending++;
    return new Promise((resolve) => {
      const abort = () => {
        this.pending--;
        this.cancelled++;
        resolve({ kind: "refused", error: "AbortError" });
      };
      if (input.signal.aborted) abort();
      else input.signal.addEventListener("abort", abort, { once: true });
    });
  }
}
const responseBase = {
  id: z.string(),
  rawId: z.string(),
  type: z.literal("public-key"),
  clientExtensionResults: z.object({}),
};
const registrationJSON = z.object({
  ...responseBase,
  response: z.object({
    clientDataJSON: z.string(),
    attestationObject: z.string(),
    transports: z.array(z.enum(["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"])),
  }),
});
const authenticationJSON = z.object({
  ...responseBase,
  response: z.object({
    clientDataJSON: z.string(),
    authenticatorData: z.string(),
    signature: z.string(),
    userHandle: z.string(),
  }),
});

// Runs in the first document, before the engine can depend on a later navigation.
const pageScenario = String.raw`
window.providerReport = (async () => {
  const report = {};
  const check = (condition, label) => { if (!condition) throw new Error(label); };
  const bounded = async (label, call, expected = "resolved", upper = 4500, exceptionClass = DOMException) => {
    const started = performance.now(); let timer;
    const outcome = await Promise.race([
      Promise.resolve().then(call).then(value => ({ name: "resolved", value, resolved: true }), error => ({ name: error.name, error, resolved: false })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ name: "pending" }), upper); }),
    ]);
    clearTimeout(timer);
    const ms = performance.now() - started;
    check(outcome.name === expected && outcome.resolved === (expected === "resolved") && ms < upper, label + ": " + outcome.name + " after " + Math.round(ms) + "ms");
    if (expected.endsWith("Error") && expected !== "TypeError") check(outcome.error instanceof exceptionClass, label + ": DOMException");
    report[label] = { outcome: outcome.name, ms: Math.round(ms) };
    return outcome.value;
  };
  check(typeof PublicKeyCredential === "function", "secure provider");
  const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const creation = PublicKeyCredential.parseCreationOptionsFromJSON(CREATION);
  const early = await bounded("first-document-create", async () => {
    try { return await navigator.credentials.create({ publicKey: creation }); }
    catch (error) { check(error instanceof DOMException && error.name === "NotAllowedError", "first document fails closed"); return null; }
  });
  if (early === null) report["first-document-create"].outcome = "NotAllowedError";
  const credential = early || await bounded("create-after-bootstrap", () => navigator.credentials.create({ publicKey: creation }));
  check(credential instanceof PublicKeyCredential && credential instanceof Credential, "credential prototypes");
  check(credential.response instanceof AuthenticatorAttestationResponse && credential.response instanceof AuthenticatorResponse, "attestation prototypes");
  check(Object.prototype.toString.call(credential) === "[object PublicKeyCredential]", "credential tag");
  for (const constructor of [PublicKeyCredential, AuthenticatorResponse, AuthenticatorAttestationResponse, AuthenticatorAssertionResponse]) {
    let threw = false; try { new constructor(); } catch (error) { threw = error instanceof TypeError; } check(threw, "illegal constructor");
  }
  const registered = credential.toJSON();
  check(b64(credential.rawId) === registered.rawId && b64(credential.response.clientDataJSON) === registered.response.clientDataJSON, "credential bytes");
  check(b64(credential.response.attestationObject) === registered.response.attestationObject, "attestation bytes");
  check(b64(credential.response.getAuthenticatorData()) === registered.response.authenticatorData, "authenticator bytes");
  check(b64(credential.response.getPublicKey()) === registered.response.publicKey && credential.response.getPublicKeyAlgorithm() === -7, "public key bytes");
  check(JSON.stringify(credential.response.getTransports()) === '["internal"]', "transports");
  check(credential.getClientExtensionResults().credProps.rk === true, "credential properties");
  registered.clientExtensionResults.credProps.rk = false;
  check(credential.getClientExtensionResults().credProps.rk === true, "JSON copies");
  await bounded("server-registration", async () => check((await (await fetch("/register", { method: "POST", body: JSON.stringify(credential) })).json()).verified, "server verifies registration"));
  const request = () => PublicKeyCredential.parseRequestOptionsFromJSON({ challenge: CHALLENGE, allowCredentials: [{ id: credential.id, type: "public-key" }] });
  const assertion = await bounded("get", () => navigator.credentials.get({ publicKey: request() }));
  check(assertion instanceof PublicKeyCredential && assertion.response instanceof AuthenticatorAssertionResponse, "assertion prototypes");
  const signed = assertion.toJSON();
  for (const member of ["clientDataJSON", "authenticatorData", "signature", "userHandle"]) check(b64(assertion.response[member]) === signed.response[member], "assertion bytes " + member);
  await bounded("server-authentication", async () => check((await (await fetch("/authenticate", { method: "POST", body: JSON.stringify(assertion) })).json()).verified, "server verifies assertion"));
  check(await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(), "platform availability");
  check(!await PublicKeyCredential.isConditionalMediationAvailable(), "conditional availability");
  const capabilities = await PublicKeyCredential.getClientCapabilities();
  check(JSON.stringify(Object.keys(capabilities)) === JSON.stringify(Object.keys(capabilities).sort()), "sorted capabilities");
  check(capabilities["extension:credProps"] && !capabilities.conditionalGet && !capabilities.hybridTransport, "capabilities");
  await bounded("conditional", () => navigator.credentials.get({ publicKey: request(), mediation: "conditional" }), "NotSupportedError", 1500);
  await bounded("bad-rp-id", () => navigator.credentials.get({ publicKey: { ...request(), rpId: "foreign.test" } }), "SecurityError", 1500);
  await bounded("bad-buffer", () => navigator.credentials.get({ publicKey: { challenge: "not bytes" } }), "TypeError", 1500);
  await bounded("bad-user-id", () => navigator.credentials.create({ publicKey: { ...creation, user: { ...creation.user, id: new Uint8Array(65) } } }), "TypeError", 1500);
  const copied = request(); const before = b64(copied.challenge);
  const copyPromise = navigator.credentials.get({ publicKey: copied });
  new Uint8Array(copied.challenge).fill(0);
  const copiedCredential = await bounded("copies-at-call", () => copyPromise);
  check(JSON.parse(new TextDecoder().decode(copiedCredential.response.clientDataJSON)).challenge === before, "challenge copied at call");
  const frame = document.createElement("iframe"); frame.src = "/blank";
  await bounded("same-origin-load", () => new Promise(resolve => { frame.onload = resolve; document.body.append(frame); }));
  await bounded("same-origin-get", () => frame.contentWindow.navigator.credentials.get({ publicKey: request() }));
  frame.contentDocument.open(); frame.contentDocument.write("<!doctype html><title>Rewritten eligible document</title>"); frame.contentDocument.close();
  await bounded("same-origin-written-get", () => frame.contentWindow.navigator.credentials.get({ publicKey: request() }));
  const probe = async (path, label) => {
    const child = document.createElement("iframe"); child.allow = "publickey-credentials-get *; publickey-credentials-create *"; child.src = path;
    await bounded(label, () => new Promise((resolve, reject) => {
      const listener = event => { if (event.source !== child.contentWindow) return; removeEventListener("message", listener); event.data.name === "NotAllowedError" ? resolve() : reject(Object.assign(new Error("Unexpected frame provider result."), { name: String(event.data.name) })); };
      addEventListener("message", listener); document.body.append(child);
    })); child.remove();
  };
  await probe(CROSS + "/probe", "cross-origin");
  await probe("/denied", "site-policy");
  const popup = window.open("about:blank", "_blank"); check(popup, "popup opened");
  await bounded("popup-initial", () => popup.navigator.credentials.get({ publicKey: request() }), "NotAllowedError", 1500, popup.DOMException);
  popup.location.hash = "initial";
  await bounded("popup-initial-fragment", () => popup.navigator.credentials.get({ publicKey: request() }), "NotAllowedError", 1500, popup.DOMException);
  popup.document.write("<!doctype html><title>Written initial document</title>"); popup.document.close();
  await bounded("popup-initial-written", () => popup.navigator.credentials.get({ publicKey: request() }), "NotAllowedError", 1500, popup.DOMException);
  const firstPopupOutcome = await bounded("popup-first-navigated-document", () => new Promise((resolve, reject) => {
    const listener = event => { if (event.source !== popup) return; removeEventListener("message", listener); event.data.name === "resolved" ? resolve(event.data.name) : reject(Object.assign(new Error("Unexpected first popup provider result."), { name: String(event.data.name) })); };
    addEventListener("message", listener); popup.location.href = "/popup";
  }));
  report["popup-first-navigated-document"].outcome = firstPopupOutcome;
  await bounded("popup-later-document", () => new Promise((resolve, reject) => {
    const listener = event => { if (event.source !== popup) return; removeEventListener("message", listener); event.data.name === "resolved" ? resolve() : reject(Object.assign(new Error("Unexpected popup provider result."), { name: String(event.data.name) })); };
    addEventListener("message", listener); popup.location.href = "/popup-again";
  })); popup.close();
  const directPopup = (path, label) => bounded(label, () => new Promise((resolve, reject) => {
    let direct;
    const listener = event => { if (event.source !== direct) return; removeEventListener("message", listener); direct.close(); event.data.name === "resolved" ? resolve() : reject(Object.assign(new Error("Unexpected direct popup provider result."), { name: String(event.data.name) })); };
    addEventListener("message", listener); direct = window.open(path, "_blank"); check(direct, "direct popup opened");
  }));
  await directPopup("/popup-direct", "popup-direct-first-document");
  await bounded("service-worker-registration", async () => {
    await navigator.serviceWorker.register("/worker.js"); await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }));
  });
  await directPopup("/popup-sw", "popup-service-worker-first-document");
  const waitPending = async () => { const until = Date.now() + 3000; while (!(await (await fetch("/pending")).json()).pending) { check(Date.now() < until, "authenticator starts"); await new Promise(resolve => setTimeout(resolve, 10)); } };
  const already = new AbortController(); const reason = { synthetic: "abort-reason" }; already.abort(reason);
  await bounded("already-aborted", async () => { try { await navigator.credentials.get({ publicKey: request(), signal: already.signal }); throw new Error("resolved"); } catch (error) { check(error === reason, "already abort identity"); } });
  await fetch("/hold", { method: "POST" });
  const controller = new AbortController();
  controller.signal.addEventListener("abort", event => event.stopImmediatePropagation());
  const first = navigator.credentials.get({ publicKey: request(), signal: controller.signal }).then(() => { throw new Error("aborted request resolved"); }, error => check(error === reason, "abort identity"));
  await bounded("authenticator-pending", waitPending);
  await bounded("concurrent", () => navigator.credentials.get({ publicKey: request() }), "OperationError", 1500);
  await bounded("abort", () => { controller.abort(reason); return first; });
  for (const [label, value] of [["assertion", assertion], ["registration", credential]]) {
    new Uint8Array(value.rawId).fill(4);
    for (const member of ["clientDataJSON", "authenticatorData", "signature", "userHandle", "attestationObject"]) {
      const buffer = value.response[member]; if (buffer) new Uint8Array(buffer).fill(5);
    }
    const json = value.toJSON(); check(json.rawId === b64(value.rawId), label + " current rawId");
    for (const member of ["clientDataJSON", "authenticatorData", "signature", "userHandle", "attestationObject"]) {
      const buffer = value.response[member]; if (buffer) check(json.response[member] === b64(buffer), label + " current " + member);
    }
    check(json !== value.toJSON() && json.response !== value.toJSON().response, label + " fresh JSON");
  }
  for (const method of ["parseCreationOptionsFromJSON", "parseRequestOptionsFromJSON"]) {
    let error; try { PublicKeyCredential[method]({ ...CREATION, challenge: "%" }); } catch (value) { error = value; }
    check(error instanceof DOMException && error.name === "EncodingError", method + " encoding error");
    try { PublicKeyCredential[method]({}); } catch (value) { error = value; }
    check(error instanceof TypeError, method + " shape error");
  }
  return report;
})();`;

export async function runPasskeyProviderScenario(options: {
  launcher: BrowserLauncher;
  authenticator: PasskeyProviderTestAuthenticator;
}) {
  const challenge = randomBytes(1024).toString("base64url");
  const creation = {
    rp: { name: "Test relying party" },
    user: { id: "AQID", name: "person@example.test", displayName: "Example Person" },
    challenge,
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    extensions: { credProps: true },
  };
  let origin = "";
  let cross = "";
  let saved:
    | NonNullable<
        Awaited<ReturnType<typeof verifyRegistrationResponse>>["registrationInfo"]
      >["credential"]
    | undefined;
  let verifiedRegistrations = 0;
  let verifiedAssertions = 0;
  let verifiedPopupAssertions = 0;
  let verifiedPopupRegistrations = 0;
  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    const path = request.url;
    if (path === "/worker.js") {
      response.setHeader("content-type", "application/javascript");
      response.end(
        "self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',e=>{if(new URL(e.request.url).pathname==='/popup-sw')e.respondWith(fetch('/popup-direct'));});",
      );
      return;
    }
    if (path === "/hold") {
      options.authenticator.holdNext = true;
      response.end("{}");
      return;
    }
    if (path === "/pending") {
      response.end(JSON.stringify({ pending: options.authenticator.pending }));
      return;
    }
    if (
      path === "/register" ||
      path === "/authenticate" ||
      path === "/popup-authenticate" ||
      path === "/popup-register"
    ) {
      let body = "";
      for await (const chunk of request) {
        body += String(chunk);
        if (body.length > 131_072) throw new Error("Fixture body too large.");
      }
      const input: unknown = JSON.parse(body);
      const expected = {
        expectedChallenge: challenge,
        expectedOrigin: origin,
        expectedRPID: "rp.example.test",
        requireUserVerification: true,
      };
      if (path === "/register" || path === "/popup-register") {
        const result = await verifyRegistrationResponse({
          ...expected,
          response: registrationJSON.parse(input),
        });
        assert(result.verified && result.registrationInfo);
        saved = result.registrationInfo.credential;
        if (path === "/popup-register") verifiedPopupRegistrations++;
        else verifiedRegistrations++;
        response.end(JSON.stringify({ verified: true }));
      } else {
        assert(saved);
        const result = await verifyAuthenticationResponse({
          ...expected,
          response: authenticationJSON.parse(input),
          credential: saved,
        });
        assert(result.verified);
        if (path === "/popup-authenticate") verifiedPopupAssertions++;
        else verifiedAssertions++;
        response.end(JSON.stringify({ verified: true }));
      }
      return;
    }
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (path === "/denied")
      response.setHeader("permissions-policy", "publickey-credentials-get=()");
    let script = "";
    if (path === "/")
      script = `const CREATION=${JSON.stringify(creation)}, CHALLENGE=${JSON.stringify(challenge)}, CROSS=${JSON.stringify(cross)};${pageScenario}`;
    if (path === "/probe" || path === "/denied")
      script = `navigator.credentials.get({publicKey:{challenge:new Uint8Array([1,2,3])}}).then(()=>parent.postMessage({name:'resolved'},'*'),e=>parent.postMessage({name:e.name},'*'));`;
    if (path === "/popup" || path === "/popup-again" || path === "/popup-direct")
      script = `(async()=>{const verify=async(path,c)=>{if(!(c instanceof PublicKeyCredential))throw new Error('Unexpected credential prototype.');const r=await fetch(path,{method:'POST',body:JSON.stringify(c)});if(!r.ok||!(await r.json()).verified)throw new Error('Popup verification failed.');};const c=await navigator.credentials.create({publicKey:PublicKeyCredential.parseCreationOptionsFromJSON(${JSON.stringify(creation)})});await verify('/popup-register',c);const a=await navigator.credentials.get({publicKey:PublicKeyCredential.parseRequestOptionsFromJSON({challenge:${JSON.stringify(challenge)},allowCredentials:[{type:'public-key',id:c.id}]})});await verify('/popup-authenticate',a);opener.postMessage({name:'resolved'},'*');})().catch(e=>opener.postMessage({name:e.name},'*'));`;
    if (path === "/navigation")
      script = `window.navigationRequest=navigator.credentials.get({publicKey:{challenge:new Uint8Array([1,2,3])}}).catch(()=>{});`;
    response.end(
      `<!doctype html><title>Passkey relying party</title><body><script>${script}</script>`,
    );
  };
  const site = createServer({ key, cert }, (request, response) => {
    void handler(request, response).catch(() => {
      response.writeHead(500).end("Fixture verification failed.");
    });
  });
  const insecure = createHttpServer((_request, response) =>
    response.end("<!doctype html><title>Insecure</title>"),
  );
  let browser: LaunchedBrowser | undefined;
  let stopDiagnostics: (() => void) | undefined;
  const diagnostics: Record<string, unknown>[] = [];
  try {
    site.listen(0, "127.0.0.1");
    insecure.listen(0, "127.0.0.1");
    await Promise.all([once(site, "listening"), once(insecure, "listening")]);
    const address = site.address();
    const httpAddress = insecure.address();
    assert(
      address && typeof address !== "string" && httpAddress && typeof httpAddress !== "string",
    );
    origin = `https://rp.example.test:${address.port}`;
    cross = `https://other.example.test:${address.port}`;
    const sessionId = createBrowserSessionId();
    browser = await options.launcher.launch({
      sessionId,
      partitionKey: `session:${sessionId}`,
      initialViewport: { width: 1280, height: 720, devicePixelRatio: 1 },
      snapshot: { cookies: [], origins: [] },
    });
    const cdp = await browser.context.pages()[0]!.cdp();
    stopDiagnostics = cdp.onEvent((method, parameters) => {
      let detail: Record<string, unknown> | undefined;
      if (method === "Page.frameNavigated") {
        const frame = z
          .object({ id: z.string(), loaderId: z.string(), url: z.string() })
          .safeParse(parameters.frame);
        if (frame.success)
          detail = {
            frameId: frame.data.id,
            loaderId: frame.data.loaderId,
            https: frame.data.url.startsWith("https:"),
          };
      }
      if (method === "Runtime.executionContextsCleared") detail = {};
      if (method === "Runtime.executionContextCreated") {
        const context = z
          .object({ auxData: z.object({ frameId: z.string(), isDefault: z.boolean() }) })
          .safeParse(parameters.context);
        if (context.success)
          detail = {
            frameId: context.data.auxData.frameId,
            mainWorld: context.data.auxData.isDefault,
          };
      }
      if (method === "Network.responseReceived" && parameters.type === "Document") {
        const response = z
          .object({
            frameId: z.string(),
            loaderId: z.string(),
            response: z.object({
              securityState: z.string(),
              securityDetails: z.unknown().optional(),
            }),
          })
          .safeParse(parameters);
        if (response.success)
          detail = {
            frameId: response.data.frameId,
            loaderId: response.data.loaderId,
            securityState: response.data.response.securityState,
            hasTLSDetails: response.data.response.securityDetails !== undefined,
          };
      }
      if (method === "Security.visibleSecurityStateChanged") {
        const state = z
          .object({
            securityState: z.string(),
            certificateSecurityState: z
              .object({ certificateNetworkError: z.string().optional() })
              .optional(),
          })
          .safeParse(parameters.visibleSecurityState);
        if (state.success)
          detail = {
            securityState: state.data.securityState,
            certificateError: Boolean(state.data.certificateSecurityState?.certificateNetworkError),
          };
      }
      if (detail) {
        diagnostics.push({ method, ...detail });
        if (diagnostics.length > 64) diagnostics.shift();
      }
    });
    await cdp.send("Page.enable");
    await cdp.send("Page.navigate", { url: `${origin}/` });
    await waitScenario(() => evaluate(cdp, "typeof window.providerReport === 'object'"));
    const report = await withTimeout(evaluate(cdp, "window.providerReport"), 30_000, {
      timeoutError: () => new Error("Passkey provider scenario timed out."),
    });
    assert.equal(verifiedRegistrations, 1);
    assert.equal(verifiedAssertions, 1);
    assert.equal(verifiedPopupRegistrations, 4);
    assert.equal(verifiedPopupAssertions, 4);
    const pages = new Set(browser.context.pages());
    await evaluate(
      cdp,
      `window.historyPopup = window.open("about:blank", "_blank"); window.historyPopup.document.write("<!doctype html><title>Initial document</title>"); window.historyPopup.document.close(); window.historyPopup.history.replaceState(null, "", ${JSON.stringify(origin + "/rewritten")}); true`,
    );
    await waitScenario(async () =>
      browser!.context.pages().some((candidate) => !pages.has(candidate)),
    );
    const popup = browser.context.pages().find((candidate) => !pages.has(candidate))!;
    try {
      const popupCdp = await withTimeout(popup.cdp(), 4500, {
        timeoutError: () => new Error("Popup CDP bootstrap did not settle."),
      });
      const calls = options.authenticator.calls;
      assert.equal(
        await rawPasskeyRequest(popupCdp),
        "NotAllowedError",
        "raw rewritten popup is refused",
      );
      assert.equal(
        options.authenticator.calls,
        calls,
        "initial popup never reaches the authenticator",
      );
    } finally {
      await popup.close();
    }
    options.authenticator.holdNext = true;
    const cancelled = options.authenticator.cancelled;
    await cdp.send("Page.navigate", { url: `${origin}/navigation` });
    await waitScenario(async () => options.authenticator.pending === 1);
    const started = Date.now();
    await cdp.send("Page.navigate", { url: `${origin}/blank` });
    await waitScenario(async () => options.authenticator.cancelled > cancelled);
    assert(Date.now() - started < 4500, "navigation cancels promptly");
    await cdp.send("Page.navigate", { url: `http://rp.example.test:${httpAddress.port}/` });
    await waitScenario(() =>
      evaluate(cdp, "location.protocol === 'http:' && document.readyState === 'complete'"),
    );
    assert.equal(await evaluate(cdp, "typeof PublicKeyCredential"), "undefined");
    return {
      cases: report,
      rewrittenPopupRefused: true,
      navigationCancelled: true,
      insecureProviderAbsent: true,
      verifiedRegistrations,
      verifiedAssertions,
      verifiedPopupAssertions,
      verifiedPopupRegistrations,
    };
  } catch (error) {
    // Only browser identity/status metadata is retained, never credential bytes.
    throw new Error(
      `${error instanceof Error ? error.message : "Passkey scenario failed."} Browser events: ${JSON.stringify(diagnostics)}`,
    );
  } finally {
    stopDiagnostics?.();
    try {
      await browser?.close();
    } finally {
      site.closeAllConnections();
      insecure.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => site.close(() => resolve())),
        new Promise<void>((resolve) => insecure.close(() => resolve())),
      ]);
    }
  }
}
async function evaluate(cdp: CdpSession, expression: string): Promise<unknown> {
  const result = await cdp.send<{
    result?: { value?: unknown };
    exceptionDetails?: { text: string; exception?: { description?: string } };
  }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails)
    throw new Error(
      (result.exceptionDetails.exception?.description ?? result.exceptionDetails.text).split(
        "\n",
      )[0],
    );
  return result.result?.value;
}
async function waitScenario(check: () => Promise<unknown>): Promise<void> {
  const until = Date.now() + 4500;
  while (!(await check())) {
    if (Date.now() >= until) throw new Error("Passkey scenario did not settle within 4500ms.");
    await delay(10);
  }
}

async function rawPasskeyRequest(cdp: CdpSession): Promise<string> {
  const id = randomUUID();
  const original = cdp.send.bind(cdp);
  let reply: (value: string) => void = () => undefined;
  const response = new Promise<string>((resolve) => {
    reply = resolve;
  });
  cdp.send = <Result>(method: string, parameters?: Record<string, unknown>): Promise<Result> => {
    if (
      method === "Runtime.evaluate" &&
      typeof parameters?.expression === "string" &&
      parameters.expression.startsWith("this[") &&
      parameters.expression.includes(id)
    ) {
      const expression = parameters.expression;
      const payload: unknown = JSON.parse(expression.slice(expression.indexOf("](") + 2, -1));
      const result = z.object({ id: z.literal(id), error: z.string().optional() }).parse(payload);
      reply(result.error ?? "resolved");
    }
    return original<Result>(method, parameters);
  };
  try {
    await waitScenario(() =>
      evaluate(
        cdp,
        `Object.getOwnPropertyNames(globalThis).some(name => name.startsWith("opensteerPasskey_") && typeof globalThis[name] === "function")`,
      ),
    );
    await evaluate(
      cdp,
      `globalThis[Object.getOwnPropertyNames(globalThis).find(name => name.startsWith("opensteerPasskey_") && typeof globalThis[name] === "function")](${JSON.stringify(JSON.stringify({ op: "get", id, options: { challenge: "AQID" } }))})`,
    );
    return await withTimeout(response, 1500, {
      timeoutError: () => new Error("Raw binding request did not settle within 1500ms."),
    });
  } finally {
    cdp.send = original;
  }
}

/** Bypass the browser's certificate warning; the page is secure-context but its TLS is untrusted. */
export async function runPasskeyCertificateErrorScenario(options: {
  launcher: BrowserLauncher;
  authenticator: PasskeyProviderTestAuthenticator;
}) {
  const site = createServer({ key: untrustedKey, cert: untrustedCert }, (_request, response) =>
    response.end(
      "<!doctype html><title>Untrusted fixture</title><script>window.untrustedDocument = true;</script>",
    ),
  );
  let browser: LaunchedBrowser | undefined;
  try {
    site.listen(0, "127.0.0.1");
    await once(site, "listening");
    const address = site.address();
    assert(address && typeof address !== "string");
    const sessionId = createBrowserSessionId();
    browser = await options.launcher.launch({
      sessionId,
      partitionKey: `session:${sessionId}`,
      initialViewport: { width: 1280, height: 720, devicePixelRatio: 1 },
      snapshot: { cookies: [], origins: [] },
    });
    const cdp = await browser.context.pages()[0]!.cdp();
    await cdp.send("Page.navigate", { url: `https://untrusted.example.test:${address.port}/` });
    await waitScenario(async () => {
      try {
        return await evaluate(
          cdp,
          `document.title === "Privacy error" || window.untrustedDocument === true`,
        );
      } catch {
        return false;
      }
    });
    if (await evaluate(cdp, `document.title === "Privacy error"`)) {
      await evaluate(
        cdp,
        `document.querySelector("#details-button").click(); document.querySelector("#proceed-link").click(); true`,
      );
      await waitScenario(async () => {
        try {
          return await evaluate(cdp, `window.untrustedDocument === true`);
        } catch {
          return false;
        }
      });
    }
    assert.equal(
      await evaluate(cdp, "isSecureContext"),
      true,
      "the bypassed page is a secure context",
    );
    const calls = options.authenticator.calls;
    const started = Date.now();
    assert.equal(await rawPasskeyRequest(cdp), "NotAllowedError");
    assert.equal(
      options.authenticator.calls,
      calls,
      "certificate-error documents never reach the authenticator",
    );
    assert(Date.now() - started < 4500, "certificate refusal settles promptly");
    return { certificateErrorRefused: true };
  } finally {
    try {
      await browser?.close();
    } finally {
      site.closeAllConnections();
      await new Promise<void>((resolve) => site.close(() => resolve()));
    }
  }
}
