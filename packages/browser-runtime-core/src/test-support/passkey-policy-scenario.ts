import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { CdpChannel } from "@opensteer/browser-core";
import { BrowserSessionIdSchema } from "@opensteer/protocol";
import { withTimeout } from "@opensteer/shared/withTimeout";
import type { BrowserLauncher } from "../browser/backend.js";

/**
 * One page-policy scenario shared by every real engine: the Playwright
 * integration test and the Electron smoke load the same documents and must
 * show each of them a browser without WebAuthn whose passkey requests fail at
 * once. The documents cover the ways a page reaches `navigator.credentials`:
 * frames of every origin and source, windows it opens and touches before they
 * load, writes into or sends to another site, pages a service worker serves
 * and pages whose own Permissions-Policy is malformed, with the frames they
 * load, and tabs an agent opens, one of them to a slow site. The top page sends
 * a strict nonce CSP and a header enabling WebAuthn for every origin, both of
 * which the policy must survive. `localhost` is a secure context and a valid
 * relying party ID.
 */
export interface PasskeyPolicyAttempt {
  readonly message?: string;
  readonly ms: number;
  readonly outcome: string;
}

export interface PasskeyPolicyDocumentReport {
  readonly callable: PasskeyPolicyAttempt;
  readonly conditional: PasskeyPolicyAttempt;
  readonly create: PasskeyPolicyAttempt;
  readonly get: PasskeyPolicyAttempt;
  readonly password: PasskeyPolicyAttempt;
  readonly publicKeyCredential: string;
}

export interface PasskeyPolicyScenarioReport {
  readonly agentTabCreatedMs: number;
  readonly documents: Readonly<Record<string, PasskeyPolicyDocumentReport>>;
  readonly engine: string;
}

const policyMessage = "Passkeys aren't available in this browser.";
const malformedPermissionsPolicy = "geolocation=(self), broken=";
const slowSiteDelayMs = 3_000;
const pageDocuments = [
  "cross-site-iframe",
  "cross-site-popup",
  "fresh-iframe",
  "fresh-popup",
  "malformed-header-popup",
  "malformed-header-popup-frame",
  "same-origin-iframe",
  "service-worker-popup",
  "service-worker-popup-frame",
  "srcdoc-iframe",
  "top",
  "written-popup",
];
// Each agent tab reports itself, then the frames beneath it.
const malformedTab = ["malformed-header-tab", "malformed-header-frame"] as const;
const workerTab = ["service-worker-tab", "service-worker-frame"] as const;
const slowTab = ["agent-tab"] as const;
const agentTabs = {
  "/malformed-tab": malformedTab,
  "/served-by-worker-tab": workerTab,
  "/slow": slowTab,
} as const;
const expectedDocuments = [...pageDocuments, "navigated-popup", ...Object.values(agentTabs).flat()];

// Runs in each fixture document. Every passkey attempt starts synchronously, so
// a window the page has only just created is probed before anything else runs.
// `password` leaves `publicKey` undefined, which the browser reads as absent;
// `callable` passes its options as a function, which the browser accepts.
const probeSource = String.raw`
async function passkeyProbe(win) {
  const failed = (error) => ({ message: String(error && error.message), outcome: String(error && error.name) });
  const attempt = (call) => {
    const started = performance.now();
    let settled;
    try {
      settled = call().then(() => ({ outcome: "resolved" }), failed);
    } catch (error) {
      settled = Promise.resolve(failed(error));
    }
    const pending = new Promise((resolve) => setTimeout(() => resolve({ outcome: "pending" }), 2000));
    return Promise.race([settled, pending]).then((result) => ({ ...result, ms: Math.round(performance.now() - started) }));
  };
  const bytes = (length) => crypto.getRandomValues(new Uint8Array(length));
  const rpId = location.hostname;
  const credentials = win.navigator.credentials;
  const publicKeyCredential = typeof win.PublicKeyCredential;
  const [get, create, conditional, callable] = await Promise.all([
    attempt(() => credentials.get({ publicKey: { challenge: bytes(32), rpId, timeout: 60000 } })),
    attempt(() => credentials.create({ publicKey: {
      challenge: bytes(32),
      pubKeyCredParams: [{ alg: -7, type: "public-key" }],
      rp: { id: rpId, name: "Opensteer" },
      timeout: 60000,
      user: { displayName: "Probe", id: bytes(16), name: "probe" },
    } })),
    attempt(() => credentials.get({ mediation: "conditional", publicKey: { challenge: bytes(32), rpId } })),
    attempt(() => credentials.get(Object.assign(function options() {}, {
      publicKey: { challenge: bytes(32), rpId, timeout: 60000 },
    }))),
  ]);
  const password = await attempt(() => credentials.get({ password: true, publicKey: undefined }));
  return { callable, conditional, create, get, password, publicKeyCredential };
}
function reportPasskeyProbe(label) {
  window.selfProbe = passkeyProbe(window);
  const top = window.top;
  const collector = top.opener || (top !== window ? top : null);
  if (collector) window.selfProbe.then((result) => collector.postMessage({ label, passkeyProbe: true, result }, "*"));
}`;

// Registered in a collecting page's head, before any frame exists: a
// cross-site frame runs in its own process and can report before the body has
// parsed.
const collectorSource = String.raw`
const results = {};
window.addEventListener("message", (event) => {
  if (event.data && event.data.passkeyProbe) results[event.data.label] = event.data.result;
});
const reported = async (labels) => {
  const deadline = Date.now() + 15000;
  while (labels.some((label) => !results[label]) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};`;

// The frames report before the page opens any window: Chromium can drop a
// cross-site frame's first message while its parent opens and closes popups,
// with or without the policy.
function topScript(crossSite: string): string {
  return String.raw`
window.passkeyPolicyReport = (async () => {
  await reported(["cross-site-iframe", "same-origin-iframe", "srcdoc-iframe"]);
  results.top = await passkeyProbe(window);
  const fresh = document.createElement("iframe");
  document.body.append(fresh);
  results["fresh-iframe"] = await passkeyProbe(fresh.contentWindow);
  const freshPopup = window.open("about:blank", "_blank");
  results["fresh-popup"] = await passkeyProbe(freshPopup);
  freshPopup.close();
  const written = window.open("about:blank", "_blank");
  written.document.write("<!doctype html><title>Written</title><p>Written by its opener</p>");
  written.document.close();
  results["written-popup"] = await passkeyProbe(written);
  written.close();
  window.open("/hop", "_blank");
  await navigator.serviceWorker.register("/service-worker.js");
  await navigator.serviceWorker.ready;
  window.open("/served-by-worker", "_blank");
  window.open("/malformed", "_blank");
  window.open(${JSON.stringify(`${crossSite}/popup`)}, "_blank");
  await reported(${JSON.stringify(pageDocuments)});
  return results;
})();`;
}

function tabScript([label, ...frames]: readonly [string, ...string[]]): string {
  return String.raw`
window.tabReport = (async () => {
  const own = await passkeyProbe(window);
  await reported(${JSON.stringify(frames)});
  return { ...results, ${JSON.stringify(label)}: own };
})();`;
}

export async function runPasskeyPolicyScenario(options: {
  readonly engine: string;
  readonly launcher: BrowserLauncher;
}): Promise<PasskeyPolicyScenarioReport> {
  return withTimeout(runScenario(options), 120_000, {
    timeoutError: () => new Error(`Passkey page policy scenario timed out in ${options.engine}.`),
  });
}

async function runScenario(options: {
  readonly engine: string;
  readonly launcher: BrowserLauncher;
}): Promise<PasskeyPolicyScenarioReport> {
  const nonce = randomUUID();
  const crossSite = await listen((request, response) => {
    const label =
      request.url === "/popup"
        ? "cross-site-popup"
        : request.url === "/navigated"
          ? "navigated-popup"
          : "cross-site-iframe";
    sendDocument(response, nonce, documentScripts(nonce, label), `<p>${label}</p>`);
  });
  const site = await listen((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const malformed = { "permissions-policy": malformedPermissionsPolicy };
    switch (url.pathname) {
      case "/service-worker.js":
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end(serviceWorkerSource());
        return;
      case "/frame":
        sendDocument(
          response,
          nonce,
          documentScripts(nonce, url.searchParams.get("label") ?? "frame"),
          "<p>frame</p>",
          url.searchParams.has("malformed") ? malformed : {},
        );
        return;
      case "/hop":
        sendDocument(response, nonce, "", "<p>An agent sends this popup to another site.</p>");
        return;
      case "/malformed":
        sendDocument(
          response,
          nonce,
          documentScripts(nonce, "malformed-header-popup"),
          `<iframe src="/frame?label=malformed-header-popup-frame&malformed"></iframe>`,
          malformed,
        );
        return;
      case "/malformed-tab":
        sendDocument(
          response,
          nonce,
          collectingScripts(nonce),
          `<iframe src="/frame?label=malformed-header-frame&malformed"></iframe>${script(nonce, tabScript(malformedTab))}`,
          malformed,
        );
        return;
      case "/slow":
        setTimeout(() => {
          sendDocument(
            response,
            nonce,
            collectingScripts(nonce),
            script(nonce, tabScript(slowTab)),
          );
        }, slowSiteDelayMs);
        return;
      default:
        sendDocument(
          response,
          nonce,
          collectingScripts(nonce),
          [
            `<iframe src="/frame?label=same-origin-iframe"></iframe>`,
            `<iframe srcdoc="${escapeAttribute(documentScripts(nonce, "srcdoc-iframe"))}"></iframe>`,
            `<iframe allow="publickey-credentials-create *; publickey-credentials-get *" src="${crossSite.origin}/frame"></iframe>`,
            script(nonce, topScript(crossSite.origin)),
          ].join(""),
          { "permissions-policy": "publickey-credentials-create=*, publickey-credentials-get=*" },
        );
    }
  });
  const sessionId = BrowserSessionIdSchema.parse(`bsn_${randomUUID()}`);
  const browser = await options.launcher.launch({
    initialViewport: { devicePixelRatio: 1, height: 720, width: 1_280 },
    partitionKey: `session:${sessionId}`,
    sessionId,
    storage: { kind: "guest" },
  });
  try {
    const [page] = browser.context.pages();
    if (!page) throw new Error("The launched browser has no page.");
    const cdp = await page.cdp();
    await cdp.send("Page.navigate", { url: `${site.localhostOrigin}/` });
    const documents: Record<string, PasskeyPolicyDocumentReport> = {
      ...(await evaluateWhenReady<Record<string, PasskeyPolicyDocumentReport>>(
        cdp,
        "window.passkeyPolicyReport",
      )),
    };
    // An agent sends a popup to another site; its next document needs another
    // process, which takes the popup's own preferences.
    const { targetInfos } = (await browser.cdp.send("Target.getTargets")) as {
      targetInfos: { targetId: string; url: string }[];
    };
    const hop = targetInfos.find((target) => target.url === `${site.localhostOrigin}/hop`);
    if (!hop) throw new Error("The popup an agent navigates never opened.");
    const popup = await attachWhenListed(browser.cdp, hop.targetId);
    try {
      await popup.send("Page.navigate", { url: `${crossSite.origin}/navigated` });
      documents["navigated-popup"] = await evaluateWhenReady<PasskeyPolicyDocumentReport>(
        popup,
        "window.selfProbe",
      );
    } finally {
      await popup.close();
    }
    let agentTabCreatedMs = 0;
    for (const path of Object.keys(agentTabs)) {
      const started = Date.now();
      const { targetId } = (await browser.cdp.send("Target.createTarget", {
        url: `${site.localhostOrigin}${path}`,
      })) as { targetId: string };
      agentTabCreatedMs = Math.max(agentTabCreatedMs, Date.now() - started);
      const tab = await attachWhenListed(browser.cdp, targetId);
      try {
        Object.assign(
          documents,
          await evaluateWhenReady<Record<string, PasskeyPolicyDocumentReport>>(
            tab,
            "window.tabReport",
          ),
        );
      } finally {
        await tab.close();
      }
    }
    assertPolicy(options.engine, documents, agentTabCreatedMs);
    return { agentTabCreatedMs, documents, engine: options.engine };
  } finally {
    await browser.close().catch(() => undefined);
    await Promise.all([site.close(), crossSite.close()]);
  }
}

function assertPolicy(
  engine: string,
  documents: Readonly<Record<string, PasskeyPolicyDocumentReport>>,
  agentTabCreatedMs: number,
): void {
  const failures: string[] = [];
  // An agent's tab opens at once even when its site is slow to answer.
  if (agentTabCreatedMs > 1_000) {
    failures.push(`agent tabs: Target.createTarget took ${agentTabCreatedMs} ms`);
  }
  for (const label of expectedDocuments) {
    const report = documents[label];
    if (!report) {
      failures.push(`${label}: never reported`);
      continue;
    }
    if (report.publicKeyCredential !== "undefined") {
      failures.push(`${label}: PublicKeyCredential is ${report.publicKeyCredential}`);
    }
    for (const kind of ["get", "create", "conditional", "callable"] as const) {
      const attempt = report[kind];
      if (attempt.outcome !== "NotAllowedError" || attempt.ms > 1_000) {
        failures.push(`${label}: ${kind} ${JSON.stringify(attempt)}`);
      }
    }
    if (report.password.message === policyMessage || report.password.outcome === "pending") {
      failures.push(`${label}: password request ${JSON.stringify(report.password)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Passkey page policy failed in ${engine}:\n${failures.join("\n")}`);
  }
}

async function evaluateWhenReady<T>(channel: CdpChannel, expression: string): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const ready = (await channel
      .send("Runtime.evaluate", { expression: `typeof ${expression}`, returnByValue: true })
      .catch(() => null)) as { result?: { value?: unknown } } | null;
    if (ready?.result?.value === "object") break;
    if (Date.now() >= deadline) throw new Error(`${expression} never appeared.`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const evaluated = (await channel.send("Runtime.evaluate", {
    awaitPromise: true,
    expression,
    returnByValue: true,
  })) as { exceptionDetails?: unknown; result?: { value?: unknown } };
  if (evaluated.exceptionDetails) {
    throw new Error(`${expression} failed: ${JSON.stringify(evaluated.exceptionDetails)}`);
  }
  return evaluated.result?.value as T;
}

async function attachWhenListed(
  backend: { attach(targetId: string): Promise<CdpChannel> },
  targetId: string,
): Promise<CdpChannel> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      return await backend.attach(targetId);
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

function script(nonce: string, source: string): string {
  return `<script nonce="${nonce}">${source}</script>`;
}

function documentScripts(nonce: string, label: string): string {
  return script(nonce, `${probeSource}\nreportPasskeyProbe(${JSON.stringify(label)});`);
}

function collectingScripts(nonce: string): string {
  return script(nonce, `${probeSource}\n${collectorSource}`);
}

function sendDocument(
  response: ServerResponse,
  nonce: string,
  head: string,
  body: string,
  headers: Record<string, string> = {},
): void {
  response.writeHead(200, {
    "content-security-policy": `script-src 'nonce-${nonce}'; worker-src 'self'; object-src 'none'`,
    "content-type": "text/html; charset=utf-8",
    ...headers,
  });
  response.end(`<!doctype html><meta charset="utf-8"><title>Passkey policy</title>${head}${body}`);
}

// Pages a service worker builds carry no response headers of their own.
function serviceWorkerSource(): string {
  const page = (head: string, body: string) =>
    `<!doctype html><meta charset="utf-8"><title>Served by worker</title><script>${head}</script>${body}`;
  const pages = {
    "/served-by-worker": page(
      `${probeSource}\nreportPasskeyProbe("service-worker-popup");`,
      `<iframe src="/served-by-worker-popup-frame"></iframe>`,
    ),
    "/served-by-worker-popup-frame": page(
      `${probeSource}\nreportPasskeyProbe("service-worker-popup-frame");`,
      "<p>frame</p>",
    ),
    "/served-by-worker-frame": page(
      `${probeSource}\nreportPasskeyProbe("service-worker-frame");`,
      "<p>frame</p>",
    ),
    "/served-by-worker-tab": page(
      `${probeSource}\n${collectorSource}`,
      `<iframe src="/served-by-worker-frame"></iframe><script>${tabScript(workerTab)}</script>`,
    ),
  };
  return String.raw`
const pages = ${JSON.stringify(pages)};
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  const page = pages[new URL(event.request.url).pathname];
  if (page) event.respondWith(new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } }));
});`;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ close(): Promise<void>; localhostOrigin: string; origin: string }> {
  const server: Server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture address missing.");
  return {
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    localhostOrigin: `http://localhost:${address.port}`,
    origin: `http://127.0.0.1:${address.port}`,
  };
}
