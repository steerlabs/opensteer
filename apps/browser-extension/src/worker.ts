import { browserSiteDomain, browserSiteFromUrl } from "@opensteer/browser-profile/source-state";
import { isLoopbackHostname } from "@opensteer/core";
import {
  verifyBrowserSourceChallenge,
  verifyBrowserSourceRouteChanged,
  type BrowserSourceInvitation,
} from "@opensteer/deployment-authority";
import {
  BrowserSourceClientMessageSchema,
  BrowserSourceHostMessageSchema,
  browserSourceProtocolVersion,
  maxBrowserSourceFrameBytes,
  type BrowserSourceClientMessage,
  type BrowserSourceHostMessage,
  type BrowserSourceStatus,
} from "@opensteer/protocol/browser-sources";
import { readSiteCookies } from "./cookies.js";
import {
  ConnectProblem,
  chooseDestination,
  fetchHostAuthority,
  readInvitation,
  requestPairing,
  sameDeployment,
  samePinnedAuthority,
  websocketUrl,
} from "./host.js";
import {
  UiRequestSchema,
  type ConnectResult,
  type ConnectionState,
  type ConnectionView,
  type InvitationCheck,
  type Status,
  type UiRequest,
} from "./messages.js";
import {
  addConnection,
  dailyNewSiteBudget,
  budgetWindowMs,
  loadConnection,
  loadConnections,
  recentNewShares,
  removeConnection,
  restrictCredentialStorage,
  updateConnection,
  type Connection,
} from "./storage.js";

interface Link {
  readonly sourceId: string;
  backoffAttempt: number;
  generation: number;
  ready: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  socket: WebSocket | null;
  state: ConnectionState;
}

interface Handshake {
  /** The nonce this socket's challenge sent; the Host signs it before or instead of its proof. */
  nonce: string | null;
  proofAccepted: boolean;
}

type HeldState = "ended" | "route-changed" | "update-required" | "host-outdated";

const links = new Map<string, Link>();
let pairingInProgress = false;

function link(sourceId: string): Link {
  let existing = links.get(sourceId);
  if (!existing) {
    existing = {
      backoffAttempt: 0,
      generation: 0,
      ready: false,
      reconnectTimer: null,
      socket: null,
      sourceId,
      state: "connecting",
    };
    links.set(sourceId, existing);
  }
  return existing;
}

function connectAll(): void {
  void (async () => {
    for (const connection of await loadConnections()) {
      const current = link(connection.sourceId);
      void connectLink(current).catch(() => {
        dropSocket(current, "offline");
        scheduleReconnect(current);
      });
    }
  })().catch(() => undefined);
}

function clearReconnect(current: Link): void {
  if (current.reconnectTimer !== null) clearTimeout(current.reconnectTimer);
  current.reconnectTimer = null;
}

function scheduleReconnect(current: Link): void {
  if (persistedStates.has(current.state) || current.reconnectTimer !== null) return;
  if (!links.has(current.sourceId)) return;
  const delay = Math.min(60_000, 1_000 * 2 ** Math.min(current.backoffAttempt, 6));
  current.backoffAttempt += 1;
  current.reconnectTimer = setTimeout(() => {
    current.reconnectTimer = null;
    void connectLink(current).catch(() => {
      dropSocket(current, "offline");
      scheduleReconnect(current);
    });
  }, delay);
}

/** Fences the current socket off; late frames from it are ignored by generation. */
function dropSocket(current: Link, state: ConnectionState, reason?: string): void {
  current.generation += 1;
  current.ready = false;
  current.state = state;
  const socket = current.socket;
  current.socket = null;
  try {
    socket?.close(reason ? 1008 : 1000, reason);
  } catch {
    // Already closed; the generation fence still applies.
  }
}

const persistedStates = new Set<ConnectionState>([
  "ended",
  "route-changed",
  "update-required",
  "host-outdated",
]);

function persistedState(connection: Connection): HeldState | null {
  if (connection.ended) return "ended";
  if (connection.routeChanged) return "route-changed";
  if (connection.hostOutdated) return "host-outdated";
  if (connection.blockedVersion === browserSourceProtocolVersion) return "update-required";
  return null;
}

async function connectLink(current: Link): Promise<void> {
  const connection = await loadConnection(current.sourceId);
  if (!connection) {
    current.state = "offline";
    return;
  }
  const held = persistedState(connection);
  if (held) {
    current.state = held;
    return;
  }
  if (connection.blockedVersion !== undefined) {
    // A newer build than the one the Host refused may try again.
    await updateConnection(connection.sourceId, (item) => {
      const { blockedVersion: _blocked, ...rest } = item;
      return { connection: rest, result: true };
    });
  }
  if (
    current.socket &&
    (current.socket.readyState === WebSocket.OPEN ||
      current.socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }
  const generation = ++current.generation;
  // A retry Chrome makes by itself leaves an offline connection saying so
  // until one succeeds, rather than flickering through Connecting on every
  // attempt; an attempt someone asked for says it is connecting.
  if (current.state !== "offline") current.state = "connecting";
  current.ready = false;
  try {
    const live = await fetchHostAuthority(connection.origin);
    if (generation !== current.generation) return;
    if (!samePinnedAuthority(connection.authority, live)) throw new Error("Different Opensteer");
  } catch {
    if (generation !== current.generation) return;
    current.state = "offline";
    scheduleReconnect(current);
    return;
  }
  let socket: WebSocket;
  try {
    socket = new WebSocket(websocketUrl(connection.origin));
  } catch {
    current.state = "offline";
    scheduleReconnect(current);
    return;
  }
  current.socket = socket;
  const handshake: Handshake = { nonce: null, proofAccepted: false };
  const readyTimer = setTimeout(
    () => reject(current, generation, "Opensteer did not finish"),
    15_000,
  );
  socket.addEventListener("open", () => {
    if (generation !== current.generation) return;
    handshake.nonce = crypto.randomUUID();
    try {
      send(current, generation, {
        nonce: handshake.nonce,
        origin: connection.origin,
        routeGeneration: connection.route?.document.route.generation ?? null,
        sourceId: connection.sourceId,
        type: "source.challenge",
      });
    } catch {
      reject(current, generation, "Challenge failed");
    }
  });
  socket.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (generation !== current.generation) return;
    void receive(event.data, connection, current, generation, handshake)
      .then(() => {
        if (current.ready) clearTimeout(readyTimer);
      })
      .catch(() => reject(current, generation, "Invalid frame"));
  });
  const onClosed = (): void => {
    clearTimeout(readyTimer);
    if (generation !== current.generation) return;
    current.generation += 1;
    current.socket = null;
    current.ready = false;
    current.state = "offline";
    scheduleReconnect(current);
  };
  socket.addEventListener("close", onClosed);
  socket.addEventListener("error", onClosed);
}

/** Sends on the socket of `generation` only; false when that socket is gone or replaced. */
function send(current: Link, generation: number, frame: BrowserSourceClientMessage): boolean {
  if (
    generation !== current.generation ||
    !current.socket ||
    current.socket.readyState !== WebSocket.OPEN
  ) {
    return false;
  }
  const payload = JSON.stringify(BrowserSourceClientMessageSchema.parse(frame));
  if (new TextEncoder().encode(payload).byteLength > maxBrowserSourceFrameBytes) {
    throw new RangeError("Frame too large");
  }
  current.socket.send(payload);
  return true;
}

function reject(current: Link, generation: number, reason: string): void {
  if (generation !== current.generation) return;
  dropSocket(current, "offline", reason);
  scheduleReconnect(current);
}

/** A proven Host refusal stops retries until the person acts; the marker survives restarts. */
async function hold(
  connection: Connection,
  current: Link,
  generation: number,
  state: HeldState,
): Promise<void> {
  if (generation !== current.generation) return;
  clearReconnect(current);
  dropSocket(current, state, "Stopped by Opensteer");
  const marker: Partial<Connection> =
    state === "ended"
      ? { ended: true }
      : state === "route-changed"
        ? { routeChanged: true }
        : state === "host-outdated"
          ? { hostOutdated: true }
          : { blockedVersion: browserSourceProtocolVersion };
  await updateConnection(
    connection.sourceId,
    (item) => ({ connection: { ...item, ...marker }, result: true }),
    connection.token,
  );
}

/** Which side has to update: only the older one can fix a version refusal. */
function refusal(error: Extract<BrowserSourceHostMessage, { type: "source.error" }>): HeldState {
  if (error.code === "source-unauthorized") return "ended";
  if (error.code === "route-changed") return "route-changed";
  return error.supportedVersion < browserSourceProtocolVersion
    ? "host-outdated"
    : "update-required";
}

async function receive(
  raw: unknown,
  connection: Connection,
  current: Link,
  generation: number,
  handshake: Handshake,
): Promise<void> {
  if (
    typeof raw !== "string" ||
    new TextEncoder().encode(raw).byteLength > maxBrowserSourceFrameBytes
  ) {
    reject(current, generation, "Invalid frame");
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    reject(current, generation, "Invalid frame");
    return;
  }
  const frame = BrowserSourceHostMessageSchema.safeParse(parsed);
  if (!frame.success) {
    reject(current, generation, "Invalid frame");
    return;
  }
  const message = frame.data;
  if (message.type === "source.error") {
    // Anyone answering on this address could send an error; only a Host that
    // proved the pinned identity may end or pause the connection. A Host that
    // no longer serves this address cannot prove it, so it signs the notice
    // over this socket's challenge instead.
    if (!handshake.proofAccepted) {
      const signedRouteChange =
        message.code === "route-changed" &&
        message.signature !== undefined &&
        handshake.nonce !== null &&
        verifyBrowserSourceRouteChanged({
          authority: connection.authority,
          nonce: handshake.nonce,
          origin: connection.origin,
          routeGeneration: connection.route?.document.route.generation ?? null,
          signature: message.signature,
          sourceId: connection.sourceId,
        });
      if (signedRouteChange) await hold(connection, current, generation, "route-changed");
      else reject(current, generation, "Proof required");
      return;
    }
    await hold(connection, current, generation, refusal(message));
    return;
  }
  if (message.type === "source.proof") {
    if (
      !handshake.nonce ||
      handshake.proofAccepted ||
      message.nonce !== handshake.nonce ||
      !verifyBrowserSourceChallenge({
        authority: connection.authority,
        nonce: message.nonce,
        origin: connection.origin,
        routeGeneration: connection.route?.document.route.generation ?? null,
        signature: message.signature,
        sourceId: connection.sourceId,
      })
    ) {
      reject(current, generation, "Proof failed");
      return;
    }
    handshake.nonce = null;
    handshake.proofAccepted = true;
    send(current, generation, {
      sourceId: connection.sourceId,
      token: connection.token,
      type: "source.hello",
      version: browserSourceProtocolVersion,
    });
    return;
  }
  if (!handshake.proofAccepted) {
    reject(current, generation, "Proof required");
    return;
  }
  if (message.type === "ping") {
    send(current, generation, { nonce: message.nonce, type: "pong" });
    return;
  }
  if (message.type === "source.ready") {
    if (message.sourceId !== connection.sourceId) {
      reject(current, generation, "Wrong connection");
      return;
    }
    current.ready = true;
    current.state = "connected";
    current.backoffAttempt = 0;
    return;
  }
  if (!current.ready) {
    reject(current, generation, "Not ready");
    return;
  }
  if (message.type === "source.inspect") {
    const status = await inspectSite(connection.sourceId, message.site);
    send(current, generation, {
      operationId: message.operationId,
      status,
      type: "source.inspect.result",
    });
    return;
  }
  try {
    await exportSite(connection, current, generation, message.site, message.operationId);
  } catch {
    send(current, generation, {
      operationId: message.operationId,
      result: { status: "unsupported" },
      type: "source.export.result",
    });
  }
}

type Gate = Exclude<BrowserSourceStatus, "available" | "no-state" | "too-large"> | null;

function siteDomainOf(origin: string): string | null {
  try {
    return browserSiteDomain(browserSiteFromUrl(origin));
  } catch {
    return null;
  }
}

/**
 * Sites Chrome never shares. Loopback carries every local service's cookies,
 * and an Opensteer's own site would sign an agent in to Opensteer itself,
 * where it could approve its own requests. Scheme is ignored on purpose: the
 * same cookies can reach http and https.
 */
async function refusedSite(domain: string): Promise<boolean> {
  if (isLoopbackHostname(domain)) return true;
  for (const connection of await loadConnections()) {
    const origins = [
      connection.origin,
      connection.authority.document.canonicalOrigin,
      connection.route?.document.route.origin,
    ];
    if (origins.some((origin) => origin !== undefined && siteDomainOf(origin) === domain)) {
      return true;
    }
  }
  return false;
}

/** The checks that come before any cookie is read, in the order the spec names them. */
async function gate(connection: Connection, site: string): Promise<Gate> {
  let domain: string;
  try {
    // Throws for anything that is not a registrable site, public suffixes included.
    domain = browserSiteDomain(site);
  } catch {
    return "unsupported";
  }
  if (await refusedSite(domain)) return "unsupported";
  if (connection.stoppedSites.includes(site)) return "stopped";
  if (!(await chrome.permissions.contains({ origins: [`${site}/*`] }))) return "chrome-blocked";
  if (
    !Object.hasOwn(connection.sharedSites, site) &&
    recentNewShares(connection).length >= dailyNewSiteBudget
  ) {
    return "limit";
  }
  return null;
}

async function inspectSite(sourceId: string, site: string): Promise<BrowserSourceStatus> {
  try {
    const connection = await loadConnection(sourceId);
    if (!connection) return "unsupported";
    const blocked = await gate(connection, site);
    if (blocked) return blocked;
    const cookies = await readSiteCookies(site);
    return cookies.status === "exported" ? "available" : cookies.status;
  } catch {
    return "unsupported";
  }
}

async function exportSite(
  pinned: Connection,
  current: Link,
  generation: number,
  site: string,
  operationId: string,
): Promise<void> {
  const reply = (status: Exclude<BrowserSourceStatus, "available">): void => {
    send(current, generation, { operationId, result: { status }, type: "source.export.result" });
  };
  const connection = await loadConnection(pinned.sourceId);
  if (!connection || connection.token !== pinned.token) {
    reply("unsupported");
    return;
  }
  const blocked = await gate(connection, site).catch((): Gate => "unsupported");
  if (blocked) {
    reply(blocked);
    return;
  }
  const cookies = await readSiteCookies(site);
  if (cookies.status !== "exported") {
    reply(cookies.status);
    return;
  }
  const frame: BrowserSourceClientMessage = {
    operationId,
    result: cookies,
    type: "source.export.result",
  };
  if (new TextEncoder().encode(JSON.stringify(frame)).byteLength > maxBrowserSourceFrameBytes) {
    reply("too-large");
    return;
  }
  // Stop sharing may land while cookies were being read, and two new sites may
  // race for the last slot of the budget; both are settled here, atomically.
  // The frame is sent inside the same update, so a share is recorded (and
  // notified) only when it actually left on this connection's live socket.
  const now = Date.now();
  const recorded = await updateConnection(
    connection.sourceId,
    (item): { connection: Connection; result: "stopped" | "limit" | "first" | "again" } | null => {
      if (item.stoppedSites.includes(site)) return { connection: item, result: "stopped" };
      const previous = item.sharedSites[site];
      const recent = recentNewShares(item, now);
      if (!previous && recent.length >= dailyNewSiteBudget) {
        return { connection: item, result: "limit" };
      }
      if (!send(current, generation, frame)) return null;
      if (previous) {
        return {
          connection: {
            ...item,
            sharedSites: { ...item.sharedSites, [site]: { ...previous, lastSharedAt: now } },
          },
          result: "again",
        };
      }
      return {
        connection: {
          ...item,
          newShares: [...recent, now],
          sharedSites: { ...item.sharedSites, [site]: { firstSharedAt: now, lastSharedAt: now } },
        },
        result: "first",
      };
    },
    connection.token,
  );
  if (recorded === "stopped" || recorded === "limit") {
    reply(recorded);
    return;
  }
  // null: the socket closed or was replaced, or this connection was replaced;
  // nothing was sent, and the reply below is dropped unless the socket lives.
  if (recorded === null) {
    reply("unsupported");
    return;
  }
  if (recorded === "first") await notifyFirstShare(connection, site).catch(() => undefined);
}

// ---- Notifications ----

const shareNotificationPrefix = "share\n";

function siteHost(site: string): string {
  return browserSiteDomain(site);
}

async function notifyFirstShare(connection: Connection, site: string): Promise<void> {
  await chrome.notifications.create(`${shareNotificationPrefix}${connection.sourceId}\n${site}`, {
    buttons: [{ title: "Stop sharing" }],
    iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
    message: `Opensteer agents can now use ${siteHost(site)} as you. You can stop this any time.`,
    priority: 0,
    title: `${siteHost(site)} sign-in shared with ${connection.deploymentName}`,
    type: "basic",
  });
}

function parseShareNotification(id: string): { site: string; sourceId: string } | null {
  if (!id.startsWith(shareNotificationPrefix)) return null;
  const [sourceId, site] = id.slice(shareNotificationPrefix.length).split("\n");
  return sourceId && site ? { site, sourceId } : null;
}

chrome.notifications.onButtonClicked.addListener((id, buttonIndex) => {
  const target = parseShareNotification(id);
  if (!target || buttonIndex !== 0) return;
  void (async () => {
    const connection = await setSiteStopped(target.sourceId, target.site, true);
    await chrome.notifications.clear(id);
    if (!connection) return;
    await chrome.notifications.create(`stopped\n${target.sourceId}\n${target.site}`, {
      iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
      message: `Share it again from the Opensteer button in Chrome's toolbar.`,
      priority: 0,
      title: `Stopped sharing ${siteHost(target.site)} with ${connection.deploymentName}`,
      type: "basic",
    });
  })().catch(() => undefined);
});

// ---- UI requests ----

async function setSiteStopped(
  sourceId: string,
  site: string,
  stopped: boolean,
): Promise<Connection | null> {
  return await updateConnection(sourceId, (item) => {
    const others = item.stoppedSites.filter((candidate) => candidate !== site);
    const next = { ...item, stoppedSites: stopped ? [...others, site] : others };
    return { connection: next, result: next };
  });
}

function view(connection: Connection): ConnectionView {
  const now = Date.now();
  const recent = recentNewShares(connection, now);
  const held = persistedState(connection);
  return {
    budget: {
      limit: dailyNewSiteBudget,
      nextAt: recent.length >= dailyNewSiteBudget ? Math.min(...recent) + budgetWindowMs : null,
      used: recent.length,
    },
    deploymentName: connection.deploymentName,
    name: connection.name,
    origin: connection.origin,
    sites: Object.entries(connection.sharedSites)
      .map(([site, share]) => ({
        lastSharedAt: share.lastSharedAt,
        site,
        stopped: connection.stoppedSites.includes(site),
      }))
      .sort((left, right) => right.lastSharedAt - left.lastSharedAt),
    sourceId: connection.sourceId,
    state: held ?? links.get(connection.sourceId)?.state ?? "connecting",
  };
}

async function status(): Promise<Status> {
  return { connections: (await loadConnections()).map(view) };
}

async function waitForState(
  sourceId: string,
  done: (state: ConnectionState) => boolean,
  timeoutMs: number,
): Promise<ConnectionState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = links.get(sourceId)?.state ?? "offline";
    if (done(state) || Date.now() >= deadline) return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** The connection a new pairing replaces: one Deployment keeps one signing key. */
async function existingFor(invitation: BrowserSourceInvitation): Promise<Connection | null> {
  return (
    (await loadConnections()).find((item) =>
      sameDeployment(item.authority, invitation.authority),
    ) ?? null
  );
}

/**
 * Chrome can forget a tab's opener (it is gone once that tab closes, and tab
 * switching may clear it), so the origin seen when the page first loaded is
 * kept for its Connect click. Keyed by tab; a service worker restart only
 * means the page must be opened again.
 */
const openerByTab = new Map<number, string>();

async function openerOrigin(tab: ChromeTab | undefined): Promise<string | null> {
  if (tab?.id === undefined) return null;
  try {
    const self = await chrome.tabs.get(tab.id);
    if (self.openerTabId !== undefined) {
      const opener = await chrome.tabs.get(self.openerTabId);
      if (opener.url) {
        const origin = new URL(opener.url).origin;
        openerByTab.set(tab.id, origin);
        return origin;
      }
    }
  } catch {
    // Treated as no opener below.
  }
  return openerByTab.get(tab.id) ?? null;
}

/**
 * The connect page is reachable from any website, and an invitation is only
 * self-consistent: any Deployment can sign one naming itself "Home". Opensteer
 * opens the page from its own tab (the web app, or `/connect/chrome` on the
 * Host), so the tab that opened it must be one of the invitation's addresses.
 */
async function readOpenedInvitation(
  text: string,
  tab: ChromeTab | undefined,
): Promise<BrowserSourceInvitation> {
  const invitation = readInvitation(text);
  const opener = await openerOrigin(tab);
  if (
    opener === null ||
    !invitation.destinations.some((destination) => new URL(destination.origin).origin === opener)
  ) {
    throw new ConnectProblem("not-from-opensteer", null, invitation.deploymentName);
  }
  return invitation;
}

async function checkInvitation(text: string, tab: ChromeTab | undefined): Promise<InvitationCheck> {
  const invitation = await readOpenedInvitation(text, tab);
  const existing = await existingFor(invitation);
  const destination = await chooseDestination(invitation);
  return {
    deploymentName: invitation.deploymentName,
    existing: existing ? "reconnect" : "none",
    name: existing?.name ?? null,
    origin: destination.origin,
  };
}

/**
 * Always pairs, even when a connection to the same Deployment is healthy: the
 * Opensteer page that opened this one completes only when it sees a new
 * connection, and the Host retires the replaced one in the same transaction.
 */
async function connect(
  text: string,
  name: string,
  tab: ChromeTab | undefined,
): Promise<ConnectResult> {
  if (pairingInProgress) throw new ConnectProblem("busy");
  pairingInProgress = true;
  try {
    const invitation = await readOpenedInvitation(text, tab);
    const existing = await existingFor(invitation);
    // Proven just now, with the invitation's key, which is also the replaced
    // connection's key: the code and the old token reach only that Deployment.
    const destination = await chooseDestination(invitation);
    const paired = await requestPairing({
      code: invitation.code,
      deploymentName: invitation.deploymentName,
      destination,
      name,
      replaces: existing ? { sourceId: existing.sourceId, token: existing.token } : null,
    });
    if (existing) {
      const old = links.get(existing.sourceId);
      if (old) {
        clearReconnect(old);
        dropSocket(old, "offline");
        links.delete(existing.sourceId);
      }
    }
    await addConnection(
      {
        authority: invitation.authority,
        connectedAt: Date.now(),
        deploymentName: invitation.deploymentName,
        name,
        newShares: [],
        origin: destination.origin,
        route: destination.route,
        sharedSites: {},
        sourceId: paired.sourceId,
        stoppedSites: [],
        token: paired.token,
      },
      existing?.sourceId ?? null,
    );
    const current = link(paired.sourceId);
    current.backoffAttempt = 0;
    // Pairing is an attempt someone asked for, even on a link that was offline.
    if (current.state === "offline") current.state = "connecting";
    await connectLink(current);
    const state = await waitForState(paired.sourceId, (value) => value !== "connecting", 10_000);
    return { deploymentName: invitation.deploymentName, ready: state === "connected" };
  } finally {
    pairingInProgress = false;
  }
}

async function handle(request: UiRequest, tab: ChromeTab | undefined): Promise<unknown> {
  switch (request.type) {
    case "ui.status":
      return await status();
    case "ui.invitation.check":
      return await checkInvitation(request.invitation, tab);
    case "ui.connect":
      return await connect(request.invitation, request.name, tab);
    case "ui.site.stop":
    case "ui.site.share":
      await setSiteStopped(request.sourceId, request.site, request.type === "ui.site.stop");
      return await status();
    case "ui.budget.reset":
      await updateConnection(request.sourceId, (item) => ({
        connection: { ...item, newShares: [] },
        result: true,
      }));
      return await status();
    case "ui.retry": {
      const connection = await loadConnection(request.sourceId);
      if (connection && !connection.ended && !connection.routeChanged) {
        await updateConnection(request.sourceId, (item) => {
          const { blockedVersion: _blocked, hostOutdated: _outdated, ...rest } = item;
          return { connection: rest, result: true };
        });
        const current = link(request.sourceId);
        clearReconnect(current);
        dropSocket(current, "connecting");
        current.backoffAttempt = 0;
        await connectLink(current);
        await waitForState(request.sourceId, (state) => state !== "connecting", 5_000);
      }
      return await status();
    }
    case "ui.disconnect": {
      // Forget first so no reconnect (alarm or backoff) can pick it up again.
      await removeConnection(request.sourceId);
      const current = links.get(request.sourceId);
      if (current) {
        links.delete(request.sourceId);
        clearReconnect(current);
        const socket = current.socket;
        if (current.ready && socket?.readyState === WebSocket.OPEN) {
          // Opensteer retires this Chrome itself, as its own Disconnect would,
          // and closes the socket; a silent Host must not hold the popup.
          const closed = new Promise<void>((resolve) => {
            socket.addEventListener("close", () => resolve(), { once: true });
            setTimeout(resolve, 2_000);
          });
          try {
            send(current, current.generation, { type: "source.disconnect" });
            await closed;
          } catch {
            // Forgetting locally still stands; Opensteer shows it offline.
          }
        }
        dropSocket(current, "offline");
      }
      return await status();
    }
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Only this extension's own top-level pages may drive it. connect.html is
  // reachable from the web, so a framed copy must not be able to pair.
  const extensionOrigin = chrome.runtime.getURL("");
  if (
    sender.id !== chrome.runtime.id ||
    !sender.url?.startsWith(extensionOrigin) ||
    (sender.frameId !== undefined && sender.frameId !== 0)
  ) {
    sendResponse({ code: "failed", deploymentName: null, ok: false, origin: null });
    return false;
  }
  const parsed = UiRequestSchema.safeParse(request);
  if (!parsed.success) {
    sendResponse({ code: "failed", deploymentName: null, ok: false, origin: null });
    return false;
  }
  void handle(parsed.data, sender.tab)
    .then((value) => sendResponse({ ok: true, value }))
    .catch((error: unknown) =>
      sendResponse(
        error instanceof ConnectProblem
          ? {
              code: error.code,
              deploymentName: error.deploymentName,
              ok: false,
              origin: error.origin,
            }
          : { code: "failed", deploymentName: null, ok: false, origin: null },
      ),
    );
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "reconnect") connectAll();
});
chrome.runtime.onStartup.addListener(connectAll);
chrome.runtime.onInstalled.addListener(() => {
  void restrictCredentialStorage().catch(() => undefined);
});
void (async () => {
  await restrictCredentialStorage();
  // Chrome stops an idle service worker; the alarm wakes it to reconnect.
  await chrome.alarms.create("reconnect", { periodInMinutes: 1 });
  connectAll();
})().catch(() => undefined);
