import { ownChild } from "../apps/host/src/agents/owned-child.test-support.js";
import {
  executablePath,
  addCleanup,
  grantedProfile,
  profileRevision,
  waitFor,
} from "./browser-deployment.test-support.js";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { expect } from "vitest";
import { ModelSelectionSchema, type WorkspaceId } from "../packages/core/src/index.js";
import { readImageDimensions } from "../packages/browser-runtime-core/src/index.js";
import {
  BrowserServerMessageSchema,
  decodeBrowserFrameEnvelope,
  type BrowserServerMessage,
} from "../packages/protocol/src/browser.js";
import { WebSocket } from "../apps/host/src/browser/browser-watch-e2e.test-support.js";
import { type VerticalStack } from "../apps/host/src/agents/vertical-stack.test-support.js";

const browserServiceMain = fileURLToPath(
  new URL("../apps/browser-runtime/src/main.ts", import.meta.url),
);

/**
 * One agent's work, as the skill and tools describe it: two sessions side by
 * side, the chat's photo uploaded, every mistake explained, a granted profile
 * signed in, and the sign-in still there after Chromium dies.
 */
export async function agentJourney(
  stack: VerticalStack,
  label: string,
  crashChromium: () => void,
): Promise<void> {
  const page = await uploadPage();
  addCleanup("upload site", () => {
    // Chromium is still running when the page closes, and it can hold a
    // connection here that never carried a request. close() leaves such a
    // connection open and waits for it for as long as Chromium keeps it.
    page.closeAllConnections();
    return new Promise((resolve) => page.close(() => resolve(undefined)));
  });
  const pageOrigin = `http://127.0.0.1:${(page.address() as { port: number }).port}`;
  await waitFor(async () => {
    const bootstrap = await stack.api["bootstrap.get"]({});
    return bootstrap.ok && bootstrap.data.browser.available;
  }, 30_000);

  const workspace = await stack.createWorkspace("Marketplace");
  const threadId = await stack.createThread({
    modelSelection: ModelSelectionSchema.parse({
      modelId: "gpt-5.6-sol",
      options: {},
      providerId: "openai",
    }),
    title: "List the mattress",
    workspaceId: workspace.id,
  });
  const profileId = await grantedProfile(stack, workspace.id);
  const photo = noisePng(900, 900);
  const attachment = await upload(stack, workspace.id, "mattress.png", "image/png", photo);

  const first = await stack.sendMessage({
    attachments: [
      {
        artifactId: attachment.id,
        mediaType: attachment.mediaType,
        name: attachment.name,
        sizeBytes: attachment.sizeBytes,
        type: "artifact" as const,
      },
    ],
    text: `List this mattress. UPLOAD_PAGE=${pageOrigin}/upload PROFILE_ID=${profileId}`,
    threadId,
    workspaceId: workspace.id,
  });
  const report = JSON.parse(first.assistantText) as AgentReport;
  if ("error" in report) throw new Error(report.error);

  // Two sessions, both held by the Run, each driven by its own ID.
  const [sessionA, sessionB] = report.opened;
  expect(sessionA).not.toBe(sessionB);
  expect(report.listed).toEqual(
    expect.arrayContaining([
      { attached: true, id: sessionA },
      { attached: true, id: sessionB },
    ]),
  );
  // The chat's photo reaches the page under its own name and type, byte for byte.
  expect(report.photoName).toBe("mattress.png");
  const expectedPhoto = { name: "mattress.png", size: photo.byteLength, type: "image/png" };
  expect(report.upload.direct).toEqual({ files: [expectedPhoto] });
  expect(report.upload.chooser).toEqual({ files: [expectedPhoto] });
  for (const key of ["single", "hidden"] as const) {
    expect(report.upload.received[key]).toEqual({
      files: [{ name: "mattress.png", sha256: sha256(photo), size: photo.byteLength }],
      trusted: true,
    });
  }
  expect(report.second).toMatchObject({ url: `${pageOrigin}/upload?second` });
  expect(report.backToFirst).toEqual({
    received: ["single", "hidden"],
    url: `${pageOrigin}/upload`,
  });
  // One tab carries the visits: the session's own page, navigated in place.
  const { browsing } = report;
  expect(browsing.start).toMatchObject({ tabs: 1, url: `${pageOrigin}/upload?first` });
  expect(browsing.inPlace).toMatchObject({ tabs: 1, url: `${pageOrigin}/upload?next` });
  // A tab that cannot open is never left behind, and the page in use stays in use.
  expect(browsing.failed).toMatchObject({
    failures: [
      { error: "Navigation requires an HTTP or HTTPS URL" },
      { error: expect.stringMatching(/^Could not open http:\/\/127\.0\.0\.1:1\/: net::ERR_/u) },
    ],
    tabs: 1,
    url: `${pageOrigin}/upload?next`,
  });
  // Past six tabs the agent hears once that it is collecting tabs; closing
  // what it opened leaves the session as it found it.
  expect(browsing.many).toMatchObject({ tabs: 1, whileMany: 8 });
  // Cmd+V crosses the Runner and Host to the session's router, which refuses
  // it however the agent presses it; the page receives neither key nor paste.
  expect(browsing.paste).toMatchObject({
    refusals: ["refused", "refused", "refused", "refused"],
    pastes: 0,
    typedOnly: true,
    vKeys: 0,
  });
  expect(
    browsing.many.stderr.match(/\[opensteer\] This Browser Session has \d+ tabs open/gu),
  ).toEqual(["[opensteer] This Browser Session has 7 tabs open"]);
  // Every mistake says what happened and what to do next.
  expect(report.withoutSession.stderr).toContain("--session <Browser Session ID>");
  expect(report.outsideFile.stderr).toContain("accepts only files staged for this Browser Session");
  expect(report.endedSession.stderr).toContain(`Browser Session ${sessionB} has ended`);
  expect(report.unknownSession.stderr).toContain("was not found");
  expect(report.accessAlreadyAvailable.error).toContain(
    `This Workspace can already use browser profile ${profileId}`,
  );
  expect(report.signedIn).toMatchObject({
    stdout: expect.stringContaining("marketplace_session=signed-in"),
  });

  // The profile saves while in use; Chromium dying afterwards loses nothing.
  // The next session launches a new Chromium from the Host's saved copy.
  await waitFor(async () => (await profileRevision(stack, profileId)) > 0, 20_000);
  const savedRevision = await profileRevision(stack, profileId);
  const watch =
    label === "relayed" ? await watchBrowserSession(stack, report.profileSession) : null;
  if (watch && process.env.OPENSTEER_BROWSER_WATCH_CHROMIUM_ARTIFACT_PATH) {
    await writeFile(
      process.env.OPENSTEER_BROWSER_WATCH_CHROMIUM_ARTIFACT_PATH,
      `${JSON.stringify(watch, null, 2)}\n`,
    );
  }
  crashChromium();
  await waitFor(async () => {
    const bootstrap = await stack.api["bootstrap.get"]({});
    return (
      bootstrap.ok &&
      bootstrap.data.browser.sessions.every(
        (session) => session.id !== report.profileSession || session.state !== "ready",
      )
    );
  }, 20_000);
  const later = await stack.sendMessage({
    text: `Check the account. UPLOAD_PAGE=${pageOrigin}/upload CHECK_PROFILE=${profileId}`,
    threadId,
    workspaceId: workspace.id,
  });
  const check = JSON.parse(later.assistantText) as { cookie: string };
  expect(check.cookie).toContain("marketplace_session=signed-in");

  const reportPath = path.join(
    tmpdir(),
    `opensteer-browser-sessions-e2e-${label}-${Date.now()}.json`,
  );
  await writeFile(
    reportPath,
    `${JSON.stringify({ afterCrash: check, report, savedRevision, watch }, null, 2)}\n`,
  );
  process.stdout.write(`browser sessions E2E report (${label}): ${reportPath}\n`);
}

async function watchBrowserSession(
  stack: VerticalStack,
  sessionId: string,
): Promise<{
  readonly firstFrameId: number;
  readonly creditedFrameId: number;
  readonly frameIdAfterNavigation: number;
  readonly jpegBytes: number;
  readonly viewportWidth: number;
  readonly viewportMutationCloseCode: number;
  readonly pointerMutationCloseCode: number;
  readonly noAckCloseCode: number;
  readonly noAckElapsedMs: number;
  readonly controlFrameIdAfterWatchClose: number;
}> {
  const sockets: WebSocket[] = [];
  const open = async (mode: "control" | "watch") => {
    const url = new URL(`/v1/browser-sessions/${sessionId}/connect`, stack.hostOrigin);
    if (mode === "watch") url.searchParams.set("mode", "watch");
    const socket = new WebSocket(url, {
      headers: { cookie: stack.sessionCookie, origin: stack.hostOrigin.origin },
    });
    sockets.push(socket);
    await waitForBrowserSnapshot(socket);
    return socket;
  };
  try {
    const watch = await open("watch");
    const firstFrame = waitForBrowserFrame(watch);
    watch.send(JSON.stringify({ type: "stream.subscribe" }));
    const first = await firstFrame;
    expect(first.header.watchToken).toBeDefined();
    expect(first.jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(first.jpeg.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
    watch.send(JSON.stringify({ type: "stream.ack", token: first.header.watchToken }));

    const viewportAttempt = await open("watch");
    const viewportClose = waitForBrowserClose(viewportAttempt);
    viewportAttempt.send(
      JSON.stringify({
        height: first.header.viewportHeight + 1,
        surfaceId: first.header.surfaceId,
        type: "viewport.set",
        width: first.header.viewportWidth + 1,
      }),
    );
    const viewportMutationCloseCode = await viewportClose;
    expect(viewportMutationCloseCode).toBe(4002);

    const pointerAttempt = await open("watch");
    const pointerClose = waitForBrowserClose(pointerAttempt);
    pointerAttempt.send(
      JSON.stringify({
        action: "down",
        button: "left",
        surfaceId: first.header.surfaceId,
        type: "input.pointer",
        viewportHeight: first.header.viewportHeight,
        viewportWidth: first.header.viewportWidth,
        x: 0.5,
        y: 0.5,
      }),
    );
    const pointerMutationCloseCode = await pointerClose;
    expect(pointerMutationCloseCode).toBe(4002);

    const control = await open("control");
    const creditedFrame = waitForBrowserFrame(watch);
    control.send(JSON.stringify({ type: "navigation.reload" }));
    const second = await creditedFrame;
    expect(second.header.frameId).toBeGreaterThan(first.header.frameId);
    expect(second.header.viewportWidth).toBe(first.header.viewportWidth);
    expect(second.header.viewportHeight).toBe(first.header.viewportHeight);
    // The page navigates while that picture is still unacknowledged: its new
    // title and address are the same tab, so the acknowledgement still counts
    // and Watch carries on.
    control.send(JSON.stringify({ type: "navigation.reload" }));
    await new Promise((resolve) => setTimeout(resolve, 750));
    const afterNavigation = waitForBrowserFrame(watch);
    watch.send(JSON.stringify({ type: "stream.ack", token: second.header.watchToken }));
    const third = await afterNavigation;
    expect(third.header.frameId).toBeGreaterThan(second.header.frameId);
    expect(watch.readyState).toBe(WebSocket.OPEN);
    watch.close(1000, "Viewer done");
    await waitForBrowserClose(watch);

    const uncredited = await open("watch");
    const noAckFrame = waitForBrowserFrame(uncredited);
    const noAckClose = waitForBrowserClose(uncredited, 25_000);
    uncredited.send(JSON.stringify({ type: "stream.subscribe" }));
    const pending = await noAckFrame;
    expect(pending.header.watchToken).toBeDefined();
    const noAckStartedAt = Date.now();
    const noAckCloseCode = await noAckClose;
    const noAckElapsedMs = Date.now() - noAckStartedAt;
    expect(noAckCloseCode).toBe(1013);
    expect(noAckElapsedMs).toBeGreaterThanOrEqual(13_000);
    expect(noAckElapsedMs).toBeLessThan(25_000);

    const controlFrame = waitForBrowserFrame(control);
    control.send(JSON.stringify({ type: "stream.subscribe" }));
    const usable = await controlFrame;
    expect(usable.header.frameId).toBeGreaterThan(second.header.frameId);
    const result = {
      controlFrameIdAfterWatchClose: usable.header.frameId,
      creditedFrameId: second.header.frameId,
      firstFrameId: first.header.frameId,
      frameIdAfterNavigation: third.header.frameId,
      jpegBytes: first.jpeg.byteLength,
      noAckCloseCode,
      noAckElapsedMs,
      pointerMutationCloseCode,
      viewportMutationCloseCode,
      viewportWidth: first.header.viewportWidth,
    };
    control.send(JSON.stringify({ type: "stream.unsubscribe" }));
    control.close(1000, "Viewer done");
    await waitForBrowserClose(control);
    return result;
  } finally {
    for (const socket of sockets) socket.terminate();
  }
}

function waitForBrowserSnapshot(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Browser snapshot timed out."));
    }, 10_000);
    const onMessage = (raw: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return;
      const message = JSON.parse(raw.toString()) as { type: string };
      if (message.type !== "browser.snapshot") return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve();
    };
    socket.on("message", onMessage);
  });
}

export function waitForBrowserFrame(
  socket: WebSocket,
  accept = false,
): Promise<{
  readonly header: ReturnType<typeof decodeBrowserFrameEnvelope>["header"];
  readonly jpeg: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Browser JPEG frame timed out."));
    }, 20_000);
    const onMessage = (raw: WebSocket.RawData, isBinary: boolean) => {
      if (!isBinary) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      const envelope = decodeBrowserFrameEnvelope(
        Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer),
      );
      if (accept && envelope.header.watchToken)
        socket.send(JSON.stringify({ type: "stream.ack", token: envelope.header.watchToken }));
      resolve({ header: envelope.header, jpeg: Buffer.from(envelope.data) });
    };
    socket.on("message", onMessage);
  });
}

function waitForBrowserClose(socket: WebSocket, timeoutMs = 10_000): Promise<number> {
  return new Promise((resolve, reject) => {
    if (socket.readyState === WebSocket.CLOSED) return resolve(1000);
    const timeout = setTimeout(() => {
      socket.off("close", onClose);
      reject(new Error("Browser viewer close timed out."));
    }, timeoutMs);
    const onClose = (code: number) => {
      clearTimeout(timeout);
      resolve(code);
    };
    socket.once("close", onClose);
  });
}

/** Waits until the deployment offers a browser. */
/** A person starts a fresh browser from a view of `viewport`'s size. */
export async function startPersonBrowser(
  stack: VerticalStack,
  input: {
    readonly initialUrl?: string;
    readonly viewport: { readonly height: number; readonly width: number };
  },
): Promise<string> {
  const started = await stack.api["commands.dispatch"]({
    idempotencyKey: randomUUID(),
    input: { fresh: true, reuseExisting: false, ...input },
    type: "browser.session.start",
    workspaceId: stack.mainWorkspaceId,
  });
  if (!started.ok) throw new Error(started.error.message);
  if (started.data.type !== "browser.session.start") throw new Error("Session command mismatch.");
  return started.data.session.id;
}

/** Opens a viewer on a session and answers it with the page the session shows. */
export async function openBrowserView(
  stack: VerticalStack,
  sessionId: string,
  mode: "control" | "watch",
): Promise<{
  readonly activeSurfaceId: string;
  readonly snapshot: Extract<BrowserServerMessage, { type: "browser.snapshot" }>;
  readonly socket: WebSocket;
}> {
  const url = new URL(`/v1/browser-sessions/${sessionId}/connect`, stack.hostOrigin);
  if (mode === "watch") url.searchParams.set("mode", "watch");
  const socket = new WebSocket(url, {
    headers: { cookie: stack.sessionCookie, origin: stack.hostOrigin.origin },
  });
  const snapshot = await new Promise<Extract<BrowserServerMessage, { type: "browser.snapshot" }>>(
    (resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Browser snapshot timed out.")), 10_000);
      const onMessage = (raw: WebSocket.RawData, isBinary: boolean) => {
        if (isBinary) return;
        const message = BrowserServerMessageSchema.parse(JSON.parse(raw.toString()));
        if (message.type !== "browser.snapshot") return;
        clearTimeout(timeout);
        socket.off("message", onMessage);
        const active = message.surfaces?.find((surface) => surface.active);
        if (active) resolve(message);
        else reject(new Error("The session shows no page."));
      };
      socket.on("message", onMessage);
    },
  );
  if (mode === "control")
    socket.on("message", (raw: WebSocket.RawData, isBinary: boolean) => {
      if (!isBinary) return;
      const { header } = decodeBrowserFrameEnvelope(
        Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer),
      );
      if (header.watchToken)
        socket.send(JSON.stringify({ type: "stream.ack", token: header.watchToken }));
    });
  return {
    activeSurfaceId: snapshot.surfaces.find((surface) => surface.active)!.id,
    snapshot,
    socket,
  };
}

/** The next frame whose page is `size`. */
export async function waitForBrowserFrameAt(
  socket: WebSocket,
  size: { readonly height: number; readonly width: number },
): Promise<Awaited<ReturnType<typeof waitForBrowserFrame>>> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const frame = await waitForBrowserFrame(socket);
    if (frame.header.viewportWidth === size.width && frame.header.viewportHeight === size.height) {
      return frame;
    }
    if (Date.now() > deadline) throw new Error("No frame arrived at the followed size.");
  }
}

export function waitForBrowserClosing(
  socket: WebSocket,
): Promise<{ readonly code: number; readonly reason: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Browser viewer close timed out.")), 10_000);
    socket.once("close", (code: number, reason: Buffer) => {
      clearTimeout(timeout);
      resolve({ code, reason: reason.toString() });
    });
  });
}

/** A page that reports its size when it loads and whenever it is resized. */
export async function sizeReportingSite(): Promise<{
  readonly origin: string;
  readonly seen: { readonly at: string; readonly height: number; readonly width: number }[];
  close(): Promise<void>;
}> {
  const seen: { at: string; height: number; width: number }[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    if (url.pathname === "/seen") {
      seen.push({
        at: url.searchParams.get("at") ?? "",
        height: Number(url.searchParams.get("h")),
        width: Number(url.searchParams.get("w")),
      });
      response.writeHead(204).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><meta charset="utf-8"><title>Sized page</title>
<style>html,body{margin:0}</style><p id="state">Sized page</p>
<script>
const report = (at) => fetch("/seen?at=" + at + "&w=" + innerWidth + "&h=" + innerHeight);
report("load");
addEventListener("resize", () => report("resize"));
</script>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    seen,
  };
}

/**
 * Pages for a tab's loading: /slow sends its start and never finishes, /frame-host
 * finishes and then adds a frame at /slow-frame that never finishes, /empty
 * answers 204. `finished` lists the pages the server completed.
 */
export async function loadingSite(): Promise<{
  readonly origin: string;
  readonly requests: string[];
  readonly finished: string[];
  close(): Promise<void>;
}> {
  const requests: string[] = [];
  const finished: string[] = [];
  const held = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture").pathname;
    requests.push(path);
    if (path === "/slow" || path === "/slow-frame") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.write(
        `<!doctype html><meta charset="utf-8"><title>${path === "/slow" ? "Still loading" : "A frame"}</title><p>The start of a page`,
      );
      held.add(response);
      response.on("close", () => held.delete(response));
      return;
    }
    if (path === "/empty") {
      response.writeHead(204).end();
      finished.push(path);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><meta charset="utf-8"><title>Frame host</title><p>Done
<script>
addEventListener("load", () => setTimeout(() => {
  const frame = document.createElement("iframe");
  frame.src = "/slow-frame";
  document.body.append(frame);
}, 200));
</script>`);
    finished.push(path);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    close: async () => {
      for (const response of held) response.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    finished,
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    requests,
  };
}

/**
 * An opener whose page-wide button opens a popup, a confirm() and then an
 * alert() one; each popup's first script asks before the popup draws. A page
 * at /asks confirms when its page-wide button is clicked. Every page reports
 * the answer it got.
 */
export async function popupDialogSite(waitForAsks?: Promise<void>): Promise<{
  readonly origin: string;
  readonly seen: string[];
  close(): Promise<void>;
}> {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    if (url.pathname === "/seen") {
      seen.push(url.searchParams.get("at") ?? "");
      response.writeHead(204).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (url.pathname === "/asks") {
      const answer = () =>
        response.end(`<!doctype html><meta charset="utf-8"><title>Asks</title>
<style>html,body{margin:0}#ask{position:fixed;inset:0;width:100%;height:100%;border:0;background:#9cf}</style>
<button id="ask">Ask</button>
<script>
document.getElementById("ask").addEventListener("click", () => setTimeout(() => {
  const answer = confirm("Waiting on you");
  fetch("/seen?at=asked:" + answer);
}, 0));
fetch("/seen?at=asks-load");
</script>`);
      if (waitForAsks) void waitForAsks.then(answer);
      else answer();
      return;
    }
    if (url.pathname === "/popup") {
      const kind = url.searchParams.get("kind") === "alert" ? "alert" : "confirm";
      response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Immediate ${kind}</title>
<script>const answer = ${kind}("Immediate popup"); fetch("/seen?at=" + encodeURIComponent("popup-answered:${kind}:" + answer));</script>
</head><body style="margin:0;background:#aee"><p>Popup ${kind}</p></body></html>`);
      return;
    }
    response.end(`<!doctype html><meta charset="utf-8"><title>Opener</title>
<style>html,body{margin:0}#open{position:fixed;inset:0;width:100%;height:100%;border:0;background:#fe8}</style>
<button id="open">Open a popup</button>
<script>
let opened = 0;
document.getElementById("open").addEventListener("click", () => {
  window.open("/popup?kind=" + (opened++ === 0 ? "confirm" : "alert"), "_blank");
});
fetch("/seen?at=opener-load");
</script>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    seen,
  };
}

export type ViewerEntry =
  | { readonly at: number; readonly kind: "message"; readonly message: BrowserServerMessage }
  | {
      readonly at: number;
      readonly decoded: { readonly height: number; readonly width: number } | null;
      readonly header: ReturnType<typeof decodeBrowserFrameEnvelope>["header"];
      readonly jpeg: Buffer;
      readonly kind: "frame";
    };

/** Everything a viewer's socket receives, in order, and how it closed. */
export function recordBrowserView(socket: WebSocket): {
  readonly entries: ViewerEntry[];
  closed(): { readonly code: number; readonly reason: string } | null;
} {
  const entries: ViewerEntry[] = [];
  let closed: { readonly code: number; readonly reason: string } | null = null;
  socket.on("message", (raw: WebSocket.RawData, isBinary: boolean) => {
    const at = performance.now();
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    if (!isBinary) {
      const message = BrowserServerMessageSchema.parse(JSON.parse(bytes.toString()));
      entries.push({ at, kind: "message", message });
      return;
    }
    const envelope = decodeBrowserFrameEnvelope(bytes);
    const jpeg = Buffer.from(envelope.data);
    const decoded = readImageDimensions(jpeg, "jpeg");
    entries.push({ at, decoded, header: envelope.header, jpeg, kind: "frame" });
    if (envelope.header.watchToken)
      socket.send(JSON.stringify({ type: "stream.ack", token: envelope.header.watchToken }));
  });
  socket.once("close", (code: number, reason: Buffer) => {
    closed = { code, reason: reason.toString() };
  });
  return { closed: () => closed, entries };
}

/** One line of a viewer's record, naming pages by the role they play. */
export function describeViewerEntry(entry: ViewerEntry, names: Record<string, string>): string {
  const name = (surfaceId: string) => names[surfaceId] ?? surfaceId;
  if (entry.kind === "frame") {
    return `frame ${name(entry.header.surfaceId)} ${entry.header.viewportWidth}x${entry.header.viewportHeight}`;
  }
  const { message } = entry;
  if (message.type === "browser.surfaces.changed") {
    return `${message.type} [${message.surfaces.map((surface) => `${name(surface.id)}${surface.active ? "*" : ""}`).join(", ")}]`;
  }
  if (message.type === "browser.dialog.changed") {
    return `${message.type} ${message.dialog ? `${name(message.dialog.surfaceId)} ${message.dialog.type}` : "none"}`;
  }
  return message.type;
}

export async function writeViewReport(
  label: string,
  report: Record<string, unknown>,
  passed = true,
): Promise<void> {
  const directory =
    process.env.OPENSTEER_BROWSER_FOLLOW_E2E_ARTIFACT_DIR ??
    path.join(tmpdir(), "opensteer-browser-follow-e2e");
  await mkdir(directory, { recursive: true });
  const reportPath = path.join(directory, `deployment-${label}.json`);
  await writeFile(
    reportPath,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), ...report, passed }, null, 2)}\n`,
  );
  process.stdout.write(`browser follow-view report (${label}): ${reportPath}\n`);
}

interface HarnessResult {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}

interface DialogRun {
  readonly code: number;
  readonly exitMs?: number;
  readonly runMs: number;
  readonly stderr: string;
}

interface DialogAct extends DialogRun {
  readonly actMs?: number;
  readonly dialogId?: string;
  readonly outcome?: string;
}

interface DialogAnswer extends DialogRun {
  readonly answerMs?: number;
  readonly answers?: boolean[];
  readonly inputs?: number;
}

export interface DialogReport {
  readonly answeredLater: DialogAnswer & { readonly openId?: string };
  readonly leftOpen: DialogAct;
  readonly replacement: DialogAct &
    DialogAnswer & {
      readonly replacementId?: string;
      readonly stale?: string;
      readonly stillOpen?: string;
    };
  readonly sameProgram: DialogAct & DialogAnswer;
}

type AgentReport =
  | { readonly error: string }
  | {
      readonly accessAlreadyAvailable: { readonly error?: string };
      readonly backToFirst: { readonly received: string[]; readonly url: string };
      readonly browsing: {
        readonly failed: {
          readonly failures: unknown[];
          readonly tabs: number;
          readonly url: string;
        };
        readonly inPlace: { readonly tabs: number; readonly url: string };
        readonly many: {
          readonly stderr: string;
          readonly tabs: number;
          readonly whileMany: number;
        };
        readonly paste: {
          readonly pastes: number;
          readonly refusals: string[];
          readonly typedOnly: boolean;
          readonly vKeys: number;
        };
        readonly start: { readonly tabs: number; readonly url: string };
      };
      readonly endedSession: HarnessResult;
      readonly listed: { readonly attached: boolean; readonly id: string }[];
      readonly opened: [string, string];
      readonly outsideFile: HarnessResult;
      readonly photoName: string;
      readonly profileSession: string;
      readonly second: { readonly url: string };
      readonly signedIn: HarnessResult;
      readonly unknownSession: HarnessResult;
      readonly upload: {
        readonly chooser: unknown;
        readonly direct: unknown;
        readonly received: Record<"hidden" | "single", unknown>;
      };
      readonly withoutSession: HarnessResult;
    };

/**
 * The shipped browser service, as a process of its own that enrolls with the
 * Deployment's configured token and relays to the Host itself — the Compose
 * and managed-cloud arrangement.
 */
export async function startBrowserService(
  stack: VerticalStack,
  enrollmentToken: string,
): Promise<{ readonly pid: number }> {
  const root = await mkdtemp(path.join(tmpdir(), "opensteer-browser-service-e2e-"));
  addCleanup("browser service files", () => rm(root, { force: true, recursive: true }));
  const child = spawn(process.execPath, ["--import", "tsx", browserServiceMain], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      ...process.env,
      OPENSTEER_BROWSER_BRIDGE_TOKEN: randomBytes(32).toString("base64url"),
      OPENSTEER_BROWSER_CHECKPOINT_INTERVAL_MS: "1000",
      OPENSTEER_BROWSER_HEADLESS: "true",
      OPENSTEER_BROWSER_PORT: "0",
      OPENSTEER_BROWSER_PROFILE_ROOT: path.join(root, "profiles"),
      OPENSTEER_BROWSER_RELAY_HOST_URL: stack.hostOrigin.origin,
      OPENSTEER_BROWSER_RUNTIME_DATA_DIR: path.join(root, "runner"),
      OPENSTEER_BROWSER_RUNTIME_ID: "browser-service-e2e",
      OPENSTEER_CHROMIUM_EXECUTABLE: executablePath!,
      OPENSTEER_MODE: "development",
      OPENSTEER_RUNNER_ENROLLMENT_TOKEN: enrollmentToken,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const owner = ownChild(child);
  const output: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  // A container stop is a SIGTERM: the service saves its profiles and exits.
  addCleanup(
    "browser service process",
    async () => {
      await owner.close(() => {
        child.kill("SIGTERM");
      }, 20_000);
      if (child.exitCode !== 0)
        throw new Error(`The browser service did not stop cleanly: ${output.join("")}`);
    },
    0,
  );
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`The browser service exited: ${output.join("")}`);
    return output.join("").includes("browser-runtime.ready");
  }, 30_000);
  if (!child.pid) throw new Error("The browser service has no process ID");
  return { pid: child.pid };
}

async function upload(
  stack: VerticalStack,
  workspaceId: WorkspaceId,
  name: string,
  mediaType: string,
  bytes: Buffer,
) {
  const reservation = await stack.api["commands.dispatch"]({
    idempotencyKey: randomUUID(),
    mediaType,
    name,
    sizeBytes: bytes.length,
    type: "attachment.upload.create",
    workspaceId,
  });
  if (!reservation.ok || reservation.data.type !== "attachment.upload.create") {
    throw new Error("Could not reserve the attachment");
  }
  const uploaded = await stack.api["attachment.upload"](
    { attachmentId: reservation.data.attachment.id },
    { body: new Blob([Uint8Array.from(bytes)]) },
  );
  if (!uploaded.ok) throw new Error(uploaded.error.message);
  return uploaded.data;
}

/** A real, incompressible PNG about the size of a phone photo. */
function noisePng(width: number, height: number): Buffer {
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const start = row * (width * 3 + 1);
    rows[start] = 0;
    randomBytes(width * 3).copy(rows, start + 1);
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.byteLength);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(2, 9);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 0 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function uploadPage(): Promise<Server> {
  const html = `<!doctype html><meta charset="utf-8"><title>Marketplace listing</title>
<input id="single" type="file" accept="image/*">
<input id="hidden" type="file" accept="image/*" style="display:none">
<button id="choose" style="position:absolute;left:20px;top:120px;width:200px;height:40px">Add photos</button>
<script>
window.received = {};
async function digest(file) {
  const hash = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return { name: file.name, sha256: [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join(""), size: file.size };
}
for (const id of ["single", "hidden"]) {
  document.getElementById(id).addEventListener("change", async (event) => {
    window.received[id] = { files: await Promise.all([...event.target.files].map(digest)), trusted: event.isTrusted };
  });
}
document.getElementById("choose").addEventListener("click", () => document.getElementById("hidden").click());
</script>`;
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server;
}
