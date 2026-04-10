const bootstrap = window.__OPENSTEER_LOCAL_BOOTSTRAP__ ?? {};
const apiBasePath = bootstrap.apiBasePath ?? "/api";
const apiToken = bootstrap.token ?? "";

const SESSION_REFRESH_MS = 2_500;
const STREAM_CONFIG_DEBOUNCE_MS = 120;
const CDP_COMMAND_TIMEOUT_MS = 10_000;
const RECONNECT_MAX_MS = 10_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const PREFERRED_TARGET_RESOLVE_ATTEMPTS = 4;
const PREFERRED_TARGET_RESOLVE_DELAY_MS = 50;
const MOUSE_MOVE_THROTTLE_MS = 33;
const VIEWPORT_REFRESH_MS = 1_500;
const FALLBACK_STREAM_ASPECT = 16 / 10;
const BROWSER_FRAME_BORDER_Y_PX = 2;

function apiFetch(pathname, options = {}) {
  const headers = new Headers(options.headers ?? {});
  headers.set("x-opensteer-local-token", apiToken);
  return fetch(pathname, {
    cache: "no-store",
    ...options,
    headers,
  });
}

function middleTrim(value, maxLength) {
  if (typeof value !== "string" || value.length <= maxLength) {
    return value;
  }
  const keep = Math.max(6, Math.floor((maxLength - 1) / 2));
  return `${value.slice(0, keep)}...${value.slice(value.length - keep)}`;
}

function resolveSelectedSessionIdFromHash() {
  const match = window.location.hash.match(/session=([^&]+)/u);
  return match ? decodeURIComponent(match[1]) : null;
}

function setSelectedSessionHash(sessionId) {
  if (!sessionId) {
    history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    return;
  }
  const hash = `session=${encodeURIComponent(sessionId)}`;
  history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${hash}`);
}

function normalizeBrowserStreamRenderSize(size, devicePixelRatio) {
  if (!size) {
    return null;
  }
  const width = Math.max(100, Math.min(8192, Math.floor(size.width * devicePixelRatio)));
  const height = Math.max(100, Math.min(8192, Math.floor(size.height * devicePixelRatio)));
  return { width, height };
}

function resolveNavigationHistoryEntryId(result, direction) {
  if (!result || typeof result !== "object") {
    return null;
  }
  const currentIndex = Number.isInteger(result.currentIndex) ? result.currentIndex : null;
  const entries = Array.isArray(result.entries) ? result.entries : null;
  if (currentIndex === null || !entries) {
    return null;
  }
  const targetIndex = direction === "back" ? currentIndex - 1 : currentIndex + 1;
  if (targetIndex < 0 || targetIndex >= entries.length) {
    return null;
  }
  const entryId = entries[targetIndex]?.id;
  return Number.isInteger(entryId) ? entryId : null;
}

function pickPageTargetId(targetIds, preferredTargetId, options = {}) {
  const ids = [...targetIds];
  if (ids.length === 0) {
    return null;
  }

  if (preferredTargetId) {
    const preferred = ids.find((targetId) => targetId === preferredTargetId);
    if (preferred) {
      return preferred;
    }
    if (options.requirePreferred) {
      return null;
    }
  }

  if (options.currentTargetId) {
    const current = ids.find((targetId) => targetId === options.currentTargetId);
    if (current) {
      return current;
    }
  }

  if (ids.length === 1 || options.allowArbitraryFallback) {
    return ids[0] ?? null;
  }

  return null;
}

function resolveActiveTabKey(tabs, activeTabIndex) {
  const active = resolveActiveTab(tabs, activeTabIndex);
  if (!active) {
    return null;
  }
  return active.targetId ?? `index:${String(active.index)}`;
}

function resolveActiveTab(tabs, activeTabIndex) {
  const byIndex = activeTabIndex >= 0 ? tabs.find((tab) => tab.index === activeTabIndex) : null;
  return byIndex ?? tabs.find((tab) => tab.active) ?? tabs[0] ?? null;
}

function wait(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

class CdpPageSessionController {
  constructor(sendRawCommand) {
    this.sendRawCommand = sendRawCommand;
    this.preferredTargetResolveAttempts = PREFERRED_TARGET_RESOLVE_ATTEMPTS;
    this.preferredTargetResolveDelayMs = PREFERRED_TARGET_RESOLVE_DELAY_MS;
    this.pageTargets = new Map();
    this.attachedSessionIdByTarget = new Map();
    this.targetIdByAttachedSession = new Map();
    this.currentTargetId = null;
    this.preferredTargetId = null;
    this.generation = 0;
    this.inFlightEnsure = null;
  }

  reset() {
    this.generation += 1;
    this.pageTargets.clear();
    this.attachedSessionIdByTarget.clear();
    this.targetIdByAttachedSession.clear();
    this.currentTargetId = null;
    this.preferredTargetId = null;
    this.inFlightEnsure = null;
  }

  setPreferredPageTarget(targetId) {
    this.preferredTargetId = typeof targetId === "string" && targetId.length > 0 ? targetId : null;
    if (this.preferredTargetId) {
      this.currentTargetId = this.preferredTargetId;
    }
  }

  replacePageTargets(targets) {
    const currentTargetId = this.currentTargetId;
    const preferredTargetId = this.preferredTargetId;

    this.pageTargets.clear();
    for (const [targetId, targetInfo] of targets) {
      this.pageTargets.set(targetId, targetInfo);
    }

    for (const [targetId, sessionId] of [...this.attachedSessionIdByTarget]) {
      if (this.pageTargets.has(targetId)) {
        continue;
      }
      this.attachedSessionIdByTarget.delete(targetId);
      this.targetIdByAttachedSession.delete(sessionId);
    }

    if (currentTargetId && !this.pageTargets.has(currentTargetId)) {
      this.currentTargetId = null;
    }
    if (preferredTargetId && !this.pageTargets.has(preferredTargetId)) {
      this.preferredTargetId = null;
    }
  }

  upsertPageTarget(targetInfo) {
    const targetId = normalizeTargetId(targetInfo?.targetId);
    if (!targetId || targetInfo?.type !== "page") {
      return;
    }
    this.pageTargets.set(targetId, targetInfo);
  }

  removePageTarget(targetId) {
    const normalizedTargetId = normalizeTargetId(targetId);
    if (!normalizedTargetId) {
      return;
    }

    this.pageTargets.delete(normalizedTargetId);
    const attachedSessionId = this.attachedSessionIdByTarget.get(normalizedTargetId) ?? null;
    if (attachedSessionId) {
      this.attachedSessionIdByTarget.delete(normalizedTargetId);
      this.targetIdByAttachedSession.delete(attachedSessionId);
    }
    if (this.currentTargetId === normalizedTargetId) {
      this.currentTargetId = null;
    }
    if (this.preferredTargetId === normalizedTargetId) {
      this.preferredTargetId = null;
    }
  }

  handleAttachedToTarget(args) {
    const sessionId = normalizeTargetId(args?.sessionId);
    const targetId = normalizeTargetId(args?.targetInfo?.targetId);
    if (!sessionId || !targetId || args?.targetInfo?.type !== "page") {
      return;
    }

    this.pageTargets.set(targetId, args.targetInfo);
    this.attachedSessionIdByTarget.set(targetId, sessionId);
    this.targetIdByAttachedSession.set(sessionId, targetId);
    if (
      this.currentTargetId === null ||
      this.currentTargetId === targetId ||
      this.preferredTargetId === targetId
    ) {
      this.currentTargetId = targetId;
    }
  }

  handleDetachedFromTarget(sessionId) {
    const normalizedSessionId = normalizeTargetId(sessionId);
    if (!normalizedSessionId) {
      return;
    }
    const targetId = this.targetIdByAttachedSession.get(normalizedSessionId) ?? null;
    this.targetIdByAttachedSession.delete(normalizedSessionId);
    if (!targetId) {
      return;
    }
    const attachedSessionId = this.attachedSessionIdByTarget.get(targetId);
    if (attachedSessionId === normalizedSessionId) {
      this.attachedSessionIdByTarget.delete(targetId);
    }
  }

  async refreshPageTargets() {
    const result = await this.sendRawCommand("Target.getTargets");
    const targets = new Map();
    const targetInfos = Array.isArray(result?.targetInfos) ? result.targetInfos : [];
    for (const targetInfo of targetInfos) {
      const targetId = normalizeTargetId(targetInfo?.targetId);
      if (!targetId || targetInfo?.type !== "page") {
        continue;
      }
      targets.set(targetId, targetInfo);
    }
    this.replacePageTargets(targets);
    return new Map(this.pageTargets);
  }

  async ensurePageSession() {
    const readySessionId = this.readReadySessionId();
    if (readySessionId) {
      return readySessionId;
    }
    if (this.inFlightEnsure) {
      return this.inFlightEnsure;
    }

    const generation = this.generation;
    const promise = this.resolvePageSession(generation);
    this.inFlightEnsure = promise;
    try {
      return await promise;
    } finally {
      if (this.inFlightEnsure === promise) {
        this.inFlightEnsure = null;
      }
    }
  }

  readReadySessionId() {
    const targetId = this.resolveCurrentTargetId();
    if (!targetId) {
      return null;
    }
    const sessionId = this.attachedSessionIdByTarget.get(targetId) ?? null;
    if (sessionId) {
      this.currentTargetId = targetId;
    }
    return sessionId;
  }

  resolveCurrentTargetId() {
    return pickPageTargetId(this.pageTargets.keys(), this.preferredTargetId, {
      requirePreferred: Boolean(this.preferredTargetId),
      currentTargetId: this.currentTargetId,
    });
  }

  async resolvePageSession(generation) {
    const targetId = await this.resolveTargetId(generation);
    this.assertGeneration(generation);
    this.currentTargetId = targetId;

    const existingSessionId = this.attachedSessionIdByTarget.get(targetId) ?? null;
    if (existingSessionId) {
      return existingSessionId;
    }

    const result = await this.sendRawCommand("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    this.assertGeneration(generation);

    const sessionId = normalizeTargetId(result?.sessionId);
    if (!sessionId) {
      throw new Error("Failed to attach CDP page target.");
    }

    this.attachedSessionIdByTarget.set(targetId, sessionId);
    this.targetIdByAttachedSession.set(sessionId, targetId);
    this.currentTargetId = targetId;
    return sessionId;
  }

  async resolveTargetId(generation) {
    const preferredTargetId = this.preferredTargetId;

    if (preferredTargetId) {
      let targets =
        this.pageTargets.size > 0 ? new Map(this.pageTargets) : await this.refreshPageTargets();

      for (let attempt = 0; attempt < this.preferredTargetResolveAttempts; attempt += 1) {
        this.assertGeneration(generation);

        const targetId = pickPageTargetId(targets.keys(), preferredTargetId, {
          requirePreferred: true,
          currentTargetId: this.currentTargetId,
        });
        if (targetId) {
          return targetId;
        }

        if (attempt === this.preferredTargetResolveAttempts - 1) {
          break;
        }

        await wait(this.preferredTargetResolveDelayMs);
        this.assertGeneration(generation);
        targets = await this.refreshPageTargets();
      }

      throw new Error("Preferred page target is unavailable for CDP command.");
    }

    let targetId = this.resolveCurrentTargetId();
    if (!targetId) {
      await this.refreshPageTargets();
      this.assertGeneration(generation);
      targetId = this.resolveCurrentTargetId();
    }
    if (!targetId) {
      throw new Error("No unambiguous active page target is available for CDP command.");
    }
    return targetId;
  }

  assertGeneration(generation) {
    if (generation !== this.generation) {
      throw new Error("CDP session state was reset.");
    }
  }
}

class LocalCdpConnection {
  constructor(onUpdate) {
    this.onUpdate = onUpdate;
    this.accessUrl = null;
    this.state = "idle";
    this.ws = null;
    this.pending = new Map();
    this.nextCommandId = 1;
    this.reconnectTimer = null;
    this.refreshTimer = null;
    this.reconnectAttempt = 0;
    this.closed = false;
    this.pageSessionController = new CdpPageSessionController((method, params, sessionId) =>
      this.sendRawCommand(method, params, sessionId),
    );
  }

  setAccessUrl(accessUrl) {
    if (this.accessUrl === accessUrl) {
      return;
    }
    this.accessUrl = accessUrl;
    this.restart();
  }

  setPreferredPageTarget(targetId) {
    this.pageSessionController.setPreferredPageTarget(targetId);
  }

  async sendCommand(method, params) {
    if (method.startsWith("Input.") || method.startsWith("Page.")) {
      const sessionId = await this.pageSessionController.ensurePageSession();
      return this.sendRawCommand(method, params, sessionId);
    }
    return this.sendRawCommand(method, params);
  }

  async sendRawCommand(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error("CDP connection is not ready."));
        return;
      }

      const id = this.nextCommandId++;
      const timer = window.setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) {
          return;
        }
        this.pending.delete(id);
        pending.reject(new Error(`CDP command ${method} timed out.`));
      }, CDP_COMMAND_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      ws.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  }

  async navigateHistory(direction) {
    const sessionId = await this.pageSessionController.ensurePageSession();
    const history = await this.sendRawCommand("Page.getNavigationHistory", {}, sessionId);
    const entryId = resolveNavigationHistoryEntryId(history, direction);
    if (entryId === null) {
      return false;
    }
    await this.sendRawCommand("Page.navigateToHistoryEntry", { entryId }, sessionId);
    return true;
  }

  close() {
    this.closed = true;
    this.clearTimers();
    this.closeSocket();
    this.clearPending("CDP connection closed.");
    this.pageSessionController.reset();
    this.setState("idle");
  }

  restart() {
    this.clearTimers();
    this.closeSocket();
    this.clearPending("CDP connection reset.");
    this.pageSessionController.reset();

    if (!this.accessUrl) {
      this.setState("idle");
      return;
    }

    this.closed = false;
    void this.connect();
  }

  async connect() {
    if (!this.accessUrl || this.closed) {
      return;
    }

    this.closeSocket();
    this.clearPending("CDP connection reset.");
    this.pageSessionController.reset();
    this.setState(this.reconnectAttempt === 0 ? "connecting" : "reconnecting");

    let response;
    try {
      response = await apiFetch(this.accessUrl);
    } catch {
      this.failAndReconnect();
      return;
    }

    if (!response.ok) {
      this.failAndReconnect();
      return;
    }

    const payload = await response.json();
    const cdpGrant = payload?.grants?.cdp;
    if (!cdpGrant || cdpGrant.transport !== "ws") {
      this.failAndReconnect();
      return;
    }

    this.scheduleGrantRefresh(cdpGrant.expiresAt);

    const ws = new WebSocket(`${cdpGrant.url}?token=${encodeURIComponent(cdpGrant.token)}`);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.setState("connected");
      void this.sendRawCommand("Target.setDiscoverTargets", { discover: true }).catch(
        () => undefined,
      );
      void this.pageSessionController.refreshPageTargets().catch(() => undefined);
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== "string") {
        return;
      }
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      if (Number.isInteger(message?.id)) {
        const pending = this.pending.get(message.id);
        if (!pending) {
          return;
        }
        this.pending.delete(message.id);
        window.clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(message.error);
        } else {
          pending.resolve(message.result);
        }
        return;
      }

      const method = message?.method;
      if (typeof method !== "string") {
        return;
      }

      const params = message?.params ?? {};
      if (method === "Target.targetCreated" || method === "Target.targetInfoChanged") {
        this.pageSessionController.upsertPageTarget(params.targetInfo);
        return;
      }
      if (method === "Target.targetDestroyed") {
        this.pageSessionController.removePageTarget(params.targetId);
        return;
      }
      if (method === "Target.attachedToTarget") {
        this.pageSessionController.handleAttachedToTarget({
          sessionId: params.sessionId,
          targetInfo: params.targetInfo,
        });
        return;
      }
      if (method === "Target.detachedFromTarget") {
        this.pageSessionController.handleDetachedFromTarget(params.sessionId);
      }
    };

    ws.onerror = () => {
      this.setState("error");
    };

    ws.onclose = () => {
      this.ws = null;
      if (this.closed) {
        this.setState("idle");
        return;
      }
      this.failAndReconnect();
    };
  }

  clearPending(message) {
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }

  closeSocket() {
    if (!this.ws) {
      return;
    }
    this.ws.onopen = null;
    this.ws.onmessage = null;
    this.ws.onerror = null;
    this.ws.onclose = null;
    this.ws.close();
    this.ws = null;
  }

  scheduleReconnect() {
    if (this.closed || !this.accessUrl) {
      return;
    }
    const delayMs = Math.min(1000 * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.reconnectAttempt += 1;
    this.setState("reconnecting");
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delayMs);
  }

  scheduleGrantRefresh(expiresAt) {
    if (!Number.isFinite(expiresAt)) {
      return;
    }
    const refreshInMs = expiresAt - Date.now() - 5000;
    if (!Number.isFinite(refreshInMs) || refreshInMs > MAX_TIMEOUT_MS) {
      return;
    }
    this.refreshTimer = window.setTimeout(
      () => {
        if (!this.accessUrl || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
          return;
        }
        void apiFetch(this.accessUrl).catch(() => undefined);
      },
      Math.max(1000, refreshInMs),
    );
  }

  clearTimers() {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  failAndReconnect() {
    this.clearTimers();
    this.closeSocket();
    this.clearPending("CDP connection closed.");
    this.pageSessionController.reset();
    this.setState("error");
    this.scheduleReconnect();
  }

  setState(state) {
    if (this.state === state) {
      return;
    }
    this.state = state;
    this.onUpdate();
  }
}

class LocalBrowserStream {
  constructor(onUpdate) {
    this.onUpdate = onUpdate;
    this.accessUrl = null;
    this.state = "waiting";
    this.viewport = null;
    this.tabs = [];
    this.activeTabIndex = -1;
    this.activeTabKey = null;
    this.frameUrl = null;
    this.ws = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.requestedRenderSize = null;
    this.streamConfigTimer = null;
    this.lastSentRenderSizeKey = null;
    this.closed = false;
  }

  setAccessUrl(accessUrl) {
    if (this.accessUrl === accessUrl) {
      return;
    }
    this.accessUrl = accessUrl;
    this.restart();
  }

  setRequestedRenderSize(size) {
    this.requestedRenderSize = size;
    this.lastSentRenderSizeKey = null;
    if (!size) {
      return;
    }
    this.scheduleStreamConfig(STREAM_CONFIG_DEBOUNCE_MS);
  }

  close() {
    this.closed = true;
    this.clearTimers();
    this.closeSocket();
    this.resetFrame();
    this.viewport = null;
    this.tabs = [];
    this.activeTabIndex = -1;
    this.activeTabKey = null;
    this.setState("waiting");
  }

  restart() {
    this.clearTimers();
    this.closeSocket();
    this.resetFrame();
    this.viewport = null;
    this.tabs = [];
    this.activeTabIndex = -1;
    this.activeTabKey = null;
    if (!this.accessUrl) {
      this.setState("waiting");
      this.onUpdate();
      return;
    }

    this.closed = false;
    void this.connect();
  }

  async connect() {
    if (!this.accessUrl || this.closed) {
      return;
    }
    this.setState(this.reconnectAttempt === 0 ? "connecting" : "reconnecting");

    let response;
    try {
      response = await apiFetch(this.accessUrl);
    } catch {
      this.failAndReconnect();
      return;
    }

    if (!response.ok) {
      this.failAndReconnect();
      return;
    }

    const payload = await response.json();
    const viewGrant = payload?.grants?.view;
    if (!viewGrant || viewGrant.transport !== "ws") {
      this.failAndReconnect();
      return;
    }

    const ws = new WebSocket(`${viewGrant.url}?token=${encodeURIComponent(viewGrant.token)}`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.flushStreamConfig();
    };

    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        this.handleControlMessage(message);
        return;
      }

      const blob =
        event.data instanceof Blob ? event.data : new Blob([event.data], { type: "image/jpeg" });
      const objectUrl = URL.createObjectURL(blob);
      this.resetFrame();
      this.frameUrl = objectUrl;
      this.setState("live");
      this.onUpdate();
    };

    ws.onerror = () => {
      this.setState("error");
      this.onUpdate();
    };

    ws.onclose = () => {
      this.ws = null;
      if (this.closed) {
        this.setState("waiting");
        this.onUpdate();
        return;
      }
      this.failAndReconnect();
    };
  }

  handleControlMessage(message) {
    if (!message || typeof message !== "object") {
      return;
    }
    if (message.type === "hello") {
      this.viewport =
        Number.isFinite(message.viewport?.width) && Number.isFinite(message.viewport?.height)
          ? {
              width: message.viewport.width,
              height: message.viewport.height,
            }
          : null;
      this.onUpdate();
      return;
    }
    if (message.type === "tabs") {
      const tabs = Array.isArray(message.tabs) ? message.tabs : [];
      const activeTabIndex = Number.isInteger(message.activeTabIndex) ? message.activeTabIndex : -1;
      const nextActiveTabKey = resolveActiveTabKey(tabs, activeTabIndex);
      if (this.activeTabKey !== null && this.activeTabKey !== nextActiveTabKey) {
        this.resetFrame();
      }
      this.activeTabKey = nextActiveTabKey;
      this.tabs = tabs;
      this.activeTabIndex = activeTabIndex;
      this.onUpdate();
      return;
    }
    if (message.type === "status") {
      if (message.status === "live") {
        this.setState("live");
      }
      this.onUpdate();
      return;
    }
    if (message.type === "error") {
      this.setState("error");
      this.onUpdate();
    }
  }

  scheduleReconnect() {
    if (this.closed || !this.accessUrl) {
      return;
    }
    const delayMs = Math.min(1000 * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.reconnectAttempt += 1;
    this.setState("reconnecting");
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delayMs);
  }

  failAndReconnect() {
    this.clearTimers();
    this.closeSocket();
    this.setState("error");
    this.scheduleReconnect();
    this.onUpdate();
  }

  scheduleStreamConfig(delayMs) {
    if (this.streamConfigTimer !== null) {
      window.clearTimeout(this.streamConfigTimer);
      this.streamConfigTimer = null;
    }
    this.streamConfigTimer = window.setTimeout(() => {
      this.streamConfigTimer = null;
      this.flushStreamConfig();
    }, delayMs);
  }

  flushStreamConfig() {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.requestedRenderSize) {
      return;
    }
    const size = normalizeBrowserStreamRenderSize(
      this.requestedRenderSize,
      window.devicePixelRatio || 1,
    );
    if (!size) {
      return;
    }
    const nextKey = `${size.width}x${size.height}`;
    if (nextKey === this.lastSentRenderSizeKey) {
      return;
    }
    this.lastSentRenderSizeKey = nextKey;
    ws.send(
      JSON.stringify({
        type: "stream-config",
        renderWidth: size.width,
        renderHeight: size.height,
      }),
    );
  }

  clearTimers() {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.streamConfigTimer !== null) {
      window.clearTimeout(this.streamConfigTimer);
      this.streamConfigTimer = null;
    }
  }

  closeSocket() {
    if (!this.ws) {
      return;
    }
    this.ws.onopen = null;
    this.ws.onmessage = null;
    this.ws.onerror = null;
    this.ws.onclose = null;
    this.ws.close();
    this.ws = null;
  }

  resetFrame() {
    if (this.frameUrl && this.frameUrl.startsWith("blob:")) {
      URL.revokeObjectURL(this.frameUrl);
    }
    this.frameUrl = null;
  }

  setState(state) {
    this.state = state;
  }
}

class LocalViewApp {
  constructor() {
    this.sessions = [];
    this.selectedSessionId = null;
    this.addressEditing = false;
    this.closingSessionId = null;
    this.refreshTimer = null;
    this.viewportRefreshTimer = null;
    this.inputCommandQueue = Promise.resolve();
    this.inputViewport = null;
    this.explicitPreferredTargetId = null;
    this.lastInputViewportTargetId = null;
    this.lastMouseMoveAt = 0;
    this.isMouseDragging = false;
    this.activeMouseButton = null;
    this.layoutFrame = null;
    this.lastBrowserFrameWidth = null;
    this.lastStreamAspect = null;

    this.viewerAreaEl = document.querySelector(".viewer-area");
    this.browserFrameEl = document.querySelector(".browser-frame");
    this.browserChromeEl = document.querySelector(".browser-chrome");
    this.browserViewportEl = document.querySelector(".browser-viewport");
    this.sessionListEl = document.getElementById("session-list");
    this.tabStripEl = document.getElementById("tab-strip");
    this.statusDotEl = document.getElementById("status-dot");
    this.statusLabelEl = document.getElementById("status-label");
    this.statusTextEl = document.getElementById("status-text");
    this.viewerSurfaceEl = document.getElementById("viewer-surface");
    this.viewerImageEl = document.getElementById("viewer-image");
    this.viewerEmptyEl = document.getElementById("viewer-empty");
    this.viewerEmptyTextEl = document.getElementById("viewer-empty-text");
    this.addressFormEl = document.getElementById("address-form");
    this.addressInputEl = document.getElementById("address-input");
    this.backButtonEl = document.getElementById("back-button");
    this.forwardButtonEl = document.getElementById("forward-button");
    this.reloadButtonEl = document.getElementById("reload-button");
    this.newTabButtonEl = document.getElementById("new-tab-button");
    this.closeBrowserButtonEl = document.getElementById("close-browser-button");

    this.stream = new LocalBrowserStream(() => this.render());
    this.cdp = new LocalCdpConnection(() => this.render());

    this.bindUi();
    this.render();
  }

  start() {
    void this.refreshSessions();
    this.refreshTimer = window.setInterval(() => {
      void this.refreshSessions();
    }, SESSION_REFRESH_MS);
    this.viewportRefreshTimer = window.setInterval(() => {
      void this.refreshInputViewport();
    }, VIEWPORT_REFRESH_MS);
  }

  bindUi() {
    window.addEventListener("hashchange", () => {
      const hashSessionId = resolveSelectedSessionIdFromHash();
      if (hashSessionId && this.sessions.some((session) => session.sessionId === hashSessionId)) {
        this.selectSession(hashSessionId);
      }
    });

    this.sessionListEl.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-session-id]");
      if (!button) {
        return;
      }
      this.selectSession(button.dataset.sessionId ?? null);
    });

    this.tabStripEl.addEventListener("click", (event) => {
      const closeButton = event.target.closest("button[data-close-target-id]");
      if (closeButton) {
        event.stopPropagation();
        const targetId = closeButton.dataset.closeTargetId;
        if (targetId) {
          if (this.explicitPreferredTargetId === targetId) {
            this.explicitPreferredTargetId = null;
          }
          void this.cdp.sendRawCommand("Target.closeTarget", { targetId }).catch(() => undefined);
        }
        return;
      }

      const tabButton = event.target.closest("button[data-target-id]");
      if (!tabButton) {
        return;
      }
      const targetId = tabButton.dataset.targetId;
      if (!targetId) {
        return;
      }
      this.explicitPreferredTargetId = targetId;
      this.cdp.setPreferredPageTarget(targetId);
      this.render();
      void this.cdp.sendRawCommand("Target.activateTarget", { targetId }).catch(() => undefined);
    });

    this.addressInputEl.addEventListener("focus", () => {
      this.addressEditing = true;
    });
    this.addressInputEl.addEventListener("blur", () => {
      this.addressEditing = false;
      this.renderAddress();
    });
    this.addressFormEl.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = this.normalizeSubmittedUrl(this.addressInputEl.value);
      if (!value) {
        return;
      }
      void this.cdp.sendCommand("Page.navigate", { url: value }).catch(() => undefined);
      this.viewerSurfaceEl.focus();
    });

    this.backButtonEl.addEventListener("click", () => {
      void this.cdp.navigateHistory("back").catch(() => undefined);
    });
    this.forwardButtonEl.addEventListener("click", () => {
      void this.cdp.navigateHistory("forward").catch(() => undefined);
    });
    this.reloadButtonEl.addEventListener("click", () => {
      void this.cdp.sendCommand("Page.reload", { ignoreCache: false }).catch(() => undefined);
    });
    this.newTabButtonEl.addEventListener("click", () => {
      void this.cdp
        .sendCommand("Target.createTarget", { url: "about:blank" })
        .then((result) => {
          const targetId = normalizeTargetId(result?.targetId);
          if (!targetId) {
            return undefined;
          }
          this.explicitPreferredTargetId = targetId;
          this.cdp.setPreferredPageTarget(targetId);
          this.render();
          return this.cdp.sendCommand("Target.activateTarget", { targetId });
        })
        .catch(() => undefined);
    });
    this.closeBrowserButtonEl.addEventListener("click", () => {
      void this.closeSelectedBrowser();
    });

    this.viewerSurfaceEl.addEventListener("contextmenu", (event) => {
      event.preventDefault();
    });
    this.viewerSurfaceEl.addEventListener("mousedown", (event) => {
      this.viewerSurfaceEl.focus();
      const point = this.eventToViewportPoint(event);
      if (!point) {
        return;
      }
      event.preventDefault();
      this.isMouseDragging = true;
      this.activeMouseButton = event.button;
      void this.dispatchPointerCommand("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: point.x,
        y: point.y,
        button: mouseButtonName(event.button),
        buttons: mouseButtonMask(event.button),
        clickCount: readMouseClickCount("mousePressed", event.detail),
        modifiers: resolveModifiers(event),
      });
    });
    this.viewerSurfaceEl.addEventListener("mouseup", (event) => {
      const point = this.eventToViewportPoint(event);
      if (!point) {
        return;
      }
      event.preventDefault();
      this.isMouseDragging = false;
      this.activeMouseButton = null;
      void this.dispatchPointerCommand("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: point.x,
        y: point.y,
        button: mouseButtonName(event.button),
        buttons: 0,
        clickCount: readMouseClickCount("mouseReleased", event.detail),
        modifiers: resolveModifiers(event),
      });
    });
    this.viewerSurfaceEl.addEventListener("mousemove", (event) => {
      const now = Date.now();
      if (now - this.lastMouseMoveAt < MOUSE_MOVE_THROTTLE_MS) {
        return;
      }
      this.lastMouseMoveAt = now;

      const point = this.eventToViewportPoint(event);
      if (!point) {
        return;
      }
      const trackedButton = this.activeMouseButton;
      void this.dispatchPointerCommand("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
        button: trackedButton === null ? "none" : mouseButtonName(trackedButton),
        buttons: trackedButton === null ? event.buttons : mouseButtonMask(trackedButton),
        clickCount: 0,
        modifiers: resolveModifiers(event),
      });
    });
    this.viewerSurfaceEl.addEventListener(
      "wheel",
      (event) => {
        const point = this.eventToViewportPoint(event);
        if (!point) {
          return;
        }
        event.preventDefault();
        void this.dispatchPointerCommand("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: point.x,
          y: point.y,
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          modifiers: resolveModifiers(event),
        });
      },
      { passive: false },
    );

    this.viewerSurfaceEl.addEventListener("keydown", (event) => {
      const payload = createCdpKeyDownPayload(event);
      if (!payload) {
        return;
      }
      event.preventDefault();
      void this.dispatchPointerCommand("Input.dispatchKeyEvent", payload);
    });

    this.viewerSurfaceEl.addEventListener("keyup", (event) => {
      const payload = createCdpKeyPayload(event, "keyUp");
      if (!payload) {
        return;
      }
      event.preventDefault();
      void this.dispatchPointerCommand("Input.dispatchKeyEvent", payload);
    });

    this.viewerSurfaceEl.addEventListener("paste", (event) => {
      const text = event.clipboardData?.getData("text/plain");
      if (!text) {
        return;
      }
      event.preventDefault();
      void this.dispatchPointerCommand("Input.insertText", { text });
    });

    this.viewerImageEl.addEventListener("load", () => {
      this.scheduleBrowserFrameLayout();
      void this.refreshInputViewport();
    });

    window.addEventListener("mousemove", (event) => {
      if (!this.isMouseDragging || this.cdp.state !== "connected") {
        return;
      }

      const now = Date.now();
      if (now - this.lastMouseMoveAt < MOUSE_MOVE_THROTTLE_MS) {
        return;
      }
      this.lastMouseMoveAt = now;

      const insidePoint = this.eventToViewportPoint(event);
      if (insidePoint) {
        return;
      }

      const point = this.eventToViewportPoint(event, { clampOutside: true });
      if (!point || this.activeMouseButton === null) {
        return;
      }

      void this.dispatchPointerCommand("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
        button: mouseButtonName(this.activeMouseButton),
        buttons: mouseButtonMask(this.activeMouseButton),
        clickCount: 0,
        modifiers: resolveModifiers(event),
      });
    });

    window.addEventListener("mouseup", (event) => {
      if (!this.isMouseDragging) {
        return;
      }

      const releasedButton = this.activeMouseButton;
      this.isMouseDragging = false;
      this.activeMouseButton = null;

      if (this.cdp.state !== "connected" || releasedButton === null) {
        return;
      }

      const point = this.eventToViewportPoint(event, { clampOutside: true });
      if (!point) {
        return;
      }

      void this.dispatchPointerCommand("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: point.x,
        y: point.y,
        button: mouseButtonName(releasedButton),
        buttons: 0,
        clickCount: readMouseClickCount("mouseReleased", event.detail),
        modifiers: resolveModifiers(event),
      });
    });

    const resizeObserver = new ResizeObserver(() => {
      this.scheduleBrowserFrameLayout();
    });
    if (this.viewerAreaEl) {
      resizeObserver.observe(this.viewerAreaEl);
    }
    if (this.browserChromeEl) {
      resizeObserver.observe(this.browserChromeEl);
    }
    if (this.browserViewportEl) {
      resizeObserver.observe(this.browserViewportEl);
    }
    window.addEventListener("resize", () => {
      this.scheduleBrowserFrameLayout();
    });
  }

  async refreshSessions() {
    let response;
    try {
      response = await apiFetch(`${apiBasePath}/sessions`);
    } catch {
      return;
    }
    if (!response.ok) {
      return;
    }

    const payload = await response.json();
    this.sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
    if (
      this.closingSessionId &&
      !this.sessions.some((session) => session.sessionId === this.closingSessionId)
    ) {
      this.closingSessionId = null;
    }

    const hashSessionId = resolveSelectedSessionIdFromHash();
    const activeSessionId = this.resolveActiveSessionId(hashSessionId);
    this.selectSession(activeSessionId, {
      force: hashSessionId !== activeSessionId,
      updateHash: hashSessionId !== activeSessionId,
    });
  }

  resolveActiveSessionId(hashSessionId) {
    if (hashSessionId && this.sessions.some((session) => session.sessionId === hashSessionId)) {
      return hashSessionId;
    }

    if (
      this.selectedSessionId &&
      this.sessions.some((session) => session.sessionId === this.selectedSessionId)
    ) {
      return this.selectedSessionId;
    }

    return this.sessions[0]?.sessionId ?? null;
  }

  selectSession(sessionId, options = {}) {
    if (this.selectedSessionId === sessionId && !options.force) {
      this.render();
      return;
    }

    this.selectedSessionId = sessionId;
    if (options.updateHash !== false) {
      setSelectedSessionHash(sessionId);
    }

    const accessUrl = sessionId
      ? `${apiBasePath}/sessions/${encodeURIComponent(sessionId)}/access`
      : null;
    this.stream.setAccessUrl(accessUrl);
    this.cdp.setAccessUrl(accessUrl);
    this.render();
  }

  render() {
    const selectedSession =
      this.sessions.find((session) => session.sessionId === this.selectedSessionId) ?? null;
    const activeTab =
      (this.stream.activeTabIndex >= 0
        ? this.stream.tabs.find((tab) => tab.index === this.stream.activeTabIndex)
        : null) ??
      this.stream.tabs.find((tab) => tab.active) ??
      this.stream.tabs[0] ??
      null;
    if (this.explicitPreferredTargetId !== null) {
      if (activeTab?.targetId === this.explicitPreferredTargetId) {
        this.explicitPreferredTargetId = null;
      }
    }
    const preferredTargetId = this.explicitPreferredTargetId ?? activeTab?.targetId ?? null;

    this.cdp.setPreferredPageTarget(preferredTargetId);
    this.scheduleBrowserFrameLayout();

    if (this.lastInputViewportTargetId !== preferredTargetId) {
      this.lastInputViewportTargetId = preferredTargetId;
      this.inputViewport = this.stream.viewport;
      void this.refreshInputViewport();
    }

    this.renderSessions();
    this.renderTabs(activeTab, preferredTargetId);
    this.renderAddress(activeTab);
    this.renderCloseBrowserButton(selectedSession);

    this.viewerImageEl.src = this.stream.frameUrl ?? "";
    this.viewerImageEl.hidden = !this.stream.frameUrl;
    this.viewerEmptyEl.hidden = Boolean(this.stream.frameUrl);
    this.viewerEmptyTextEl.textContent = selectedSession
      ? this.closingSessionId === selectedSession.sessionId
        ? "Closing browser..."
        : this.stream.state === "connecting" || this.stream.state === "reconnecting"
          ? "Connecting to browser\u2026"
          : "Waiting for frames\u2026"
      : "No live browser selected";

    this.statusDotEl.className = "chrome-status-dot";
    if (selectedSession && this.closingSessionId === selectedSession.sessionId) {
      this.statusDotEl.classList.add("is-connecting");
      this.statusLabelEl.textContent = "Closing";
    } else if (this.stream.state === "live") {
      this.statusDotEl.classList.add("is-live");
      this.statusLabelEl.textContent = "Live";
    } else if (this.stream.state === "connecting" || this.stream.state === "reconnecting") {
      this.statusDotEl.classList.add("is-connecting");
      this.statusLabelEl.textContent =
        this.stream.state === "connecting" ? "Connecting" : "Reconnecting";
    } else if (this.stream.state === "error") {
      this.statusDotEl.classList.add("is-error");
      this.statusLabelEl.textContent = "Error";
    } else if (selectedSession) {
      this.statusLabelEl.textContent = "Waiting";
    } else {
      this.statusDotEl.classList.add("is-idle");
      this.statusLabelEl.textContent = "";
    }

    const sessionSummary =
      selectedSession === null
        ? "No session selected"
        : `${selectedSession.label} / ${selectedSession.engine}`;
    this.statusTextEl.textContent = `${sessionSummary} / stream ${this.stream.state} / cdp ${this.cdp.state}`;
  }

  renderCloseBrowserButton(selectedSession) {
    const isClosing =
      selectedSession !== null && this.closingSessionId === selectedSession.sessionId;
    const canClose = selectedSession !== null && selectedSession.ownership === "owned";
    this.closeBrowserButtonEl.disabled = !canClose || isClosing;
    this.closeBrowserButtonEl.textContent = isClosing ? "Closing..." : "Close Browser";
    this.closeBrowserButtonEl.title =
      selectedSession && selectedSession.ownership !== "owned"
        ? "Only Opensteer-owned local browsers can be closed here."
        : "";
  }

  renderSessions() {
    this.sessionListEl.textContent = "";
    if (this.sessions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "session-list-empty";
      empty.innerHTML =
        '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.3"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>' +
        "<span>No active sessions</span>";
      this.sessionListEl.append(empty);
      return;
    }

    for (const session of this.sessions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "session-item";
      button.dataset.sessionId = session.sessionId;
      button.dataset.active = String(session.sessionId === this.selectedSessionId);
      button.setAttribute("data-testid", `session-item-${session.sessionId}`);

      const row1 = document.createElement("div");
      row1.className = "session-row";

      const label = document.createElement("span");
      label.className = "session-title";
      label.textContent = session.label;

      const dot = document.createElement("span");
      dot.className = "session-dot";

      row1.append(label, dot);

      const row2 = document.createElement("div");
      row2.className = "session-row";

      const badge = document.createElement("span");
      badge.className = "session-engine";
      badge.textContent = session.browserName ?? session.engine;

      const meta = document.createElement("span");
      meta.className = "session-info";
      meta.textContent = [session.workspace, `pid ${session.pid}`].filter(Boolean).join(" \u00b7 ");

      row2.append(badge, meta);

      const pathEl = document.createElement("div");
      pathEl.className = "session-path";
      const segments = (session.rootPath || "").split("/").filter(Boolean);
      const dirName = segments.length > 0 ? segments[segments.length - 1] : "";
      pathEl.textContent = dirName ? `\u2192 ${dirName}` : "";

      button.append(row1, row2);
      if (dirName) {
        button.append(pathEl);
      }
      this.sessionListEl.append(button);
    }
  }

  renderTabs(activeTab, preferredTargetId = null) {
    this.tabStripEl.textContent = "";
    for (const tab of this.stream.tabs) {
      const chip = document.createElement("div");
      chip.className = "chrome-tab-chip";
      chip.dataset.active = String(
        preferredTargetId
          ? tab.targetId === preferredTargetId
          : activeTab
            ? activeTab.index === tab.index
            : tab.active,
      );

      const button = document.createElement("button");
      button.type = "button";
      button.className = "chrome-tab tab-button";
      button.dataset.active = chip.dataset.active;
      if (tab.targetId) {
        button.dataset.targetId = tab.targetId;
      }

      const title = document.createElement("span");
      title.className = "chrome-tab-title";
      title.textContent = tab.title || tab.url || "Untitled";

      button.append(title);
      chip.append(button);

      if (tab.targetId) {
        const closeButton = document.createElement("button");
        closeButton.type = "button";
        closeButton.className = "chrome-tab-close";
        closeButton.dataset.closeTargetId = tab.targetId;
        closeButton.setAttribute("aria-label", "Close tab");
        closeButton.textContent = "\u00d7";
        chip.append(closeButton);
      }

      this.tabStripEl.append(chip);
    }
  }

  renderAddress(activeTab) {
    if (this.addressEditing) {
      return;
    }
    this.addressInputEl.value = activeTab?.url ?? "";
  }

  getActiveTab() {
    return (
      (this.stream.activeTabIndex >= 0
        ? this.stream.tabs.find((tab) => tab.index === this.stream.activeTabIndex)
        : null) ??
      this.stream.tabs.find((tab) => tab.active) ??
      this.stream.tabs[0] ??
      null
    );
  }

  activateActiveTab() {
    const targetId = this.getActiveTab()?.targetId;
    if (!targetId) {
      return;
    }
    this.cdp.setPreferredPageTarget(targetId);
    void this.cdp.sendRawCommand("Target.activateTarget", { targetId }).catch(() => undefined);
  }

  async closeSelectedBrowser() {
    const selectedSession =
      this.sessions.find((session) => session.sessionId === this.selectedSessionId) ?? null;
    if (!selectedSession || selectedSession.ownership !== "owned") {
      return;
    }
    if (this.closingSessionId !== null) {
      return;
    }
    if (!window.confirm(`Close browser "${selectedSession.label}"?`)) {
      return;
    }

    const { sessionId } = selectedSession;
    this.closingSessionId = sessionId;
    this.render();

    let response;
    try {
      response = await apiFetch(`${apiBasePath}/sessions/${encodeURIComponent(sessionId)}/close`, {
        method: "POST",
      });
    } catch {
      if (this.closingSessionId === sessionId) {
        this.closingSessionId = null;
      }
      this.render();
      return;
    }

    if (!response.ok) {
      if (this.closingSessionId === sessionId) {
        this.closingSessionId = null;
      }
      this.render();
      return;
    }

    if (this.selectedSessionId === sessionId) {
      this.selectedSessionId = null;
      setSelectedSessionHash(null);
      this.stream.setAccessUrl(null);
      this.cdp.setAccessUrl(null);
    }
    this.sessions = this.sessions.filter((session) => session.sessionId !== sessionId);
    if (this.closingSessionId === sessionId) {
      this.closingSessionId = null;
    }
    this.render();
    await this.refreshSessions();
  }

  async dispatchPointerCommand(method, payload) {
    this.inputCommandQueue = this.inputCommandQueue
      .catch(() => undefined)
      .then(async () => {
        await this.cdp.sendCommand(method, payload);
      })
      .catch(() => undefined);
    return this.inputCommandQueue;
  }

  async refreshInputViewport() {
    if (this.cdp.state !== "connected") {
      this.inputViewport = this.stream.viewport;
      return;
    }

    try {
      const metrics = await this.cdp.sendCommand("Page.getLayoutMetrics");
      const viewport = readViewportFromLayoutMetrics(metrics);
      if (viewport) {
        this.inputViewport = viewport;
      }
    } catch {}
  }

  scheduleBrowserFrameLayout() {
    if (this.layoutFrame !== null) {
      return;
    }
    this.layoutFrame = window.requestAnimationFrame(() => {
      this.layoutFrame = null;
      this.updateBrowserFrameLayout();
    });
  }

  updateBrowserFrameLayout() {
    if (!this.viewerAreaEl || !this.browserFrameEl || !this.browserChromeEl) {
      return;
    }

    const aspect = this.resolveStreamAspect();
    if (this.lastStreamAspect !== aspect) {
      this.lastStreamAspect = aspect;
      this.browserFrameEl.style.setProperty("--browser-stream-aspect", String(aspect));
    }

    const areaRect = this.viewerAreaEl.getBoundingClientRect();
    const areaStyle = window.getComputedStyle(this.viewerAreaEl);
    const availableWidth =
      areaRect.width -
      readCssPixelValue(areaStyle.paddingLeft) -
      readCssPixelValue(areaStyle.paddingRight);
    const availableHeight =
      areaRect.height -
      readCssPixelValue(areaStyle.paddingTop) -
      readCssPixelValue(areaStyle.paddingBottom);
    const chromeHeight = this.browserChromeEl.getBoundingClientRect().height;
    const availableViewportHeight = availableHeight - chromeHeight - BROWSER_FRAME_BORDER_Y_PX;

    if (availableWidth > 0 && availableViewportHeight > 0) {
      const width = Math.max(
        1,
        Math.floor(Math.min(availableWidth, availableViewportHeight * aspect)),
      );
      if (this.lastBrowserFrameWidth !== width) {
        this.lastBrowserFrameWidth = width;
        this.browserFrameEl.style.setProperty("--browser-frame-width", `${String(width)}px`);
      }
    } else {
      this.lastBrowserFrameWidth = null;
      this.browserFrameEl.style.removeProperty("--browser-frame-width");
    }

    this.updateRequestedRenderSize();
  }

  updateRequestedRenderSize() {
    const targetEl = this.browserViewportEl ?? this.viewerSurfaceEl;
    const rect = targetEl.getBoundingClientRect();
    if (rect.width < 100 || rect.height < 100) {
      return;
    }
    this.stream.setRequestedRenderSize({
      width: rect.width,
      height: rect.height,
    });
  }

  resolveStreamAspect() {
    if (this.viewerImageEl.naturalWidth > 0 && this.viewerImageEl.naturalHeight > 0) {
      const imageAspect = this.viewerImageEl.naturalWidth / this.viewerImageEl.naturalHeight;
      if (Number.isFinite(imageAspect) && imageAspect > 0) {
        return imageAspect;
      }
    }

    const viewport = this.inputViewport ?? this.stream.viewport;
    if (viewport?.width > 0 && viewport?.height > 0) {
      const viewportAspect = viewport.width / viewport.height;
      if (Number.isFinite(viewportAspect) && viewportAspect > 0) {
        return viewportAspect;
      }
    }

    return FALLBACK_STREAM_ASPECT;
  }

  normalizeSubmittedUrl(value) {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    if (/^[a-z][a-z0-9+.-]*:/iu.test(trimmed)) {
      return trimmed;
    }
    return `https://${trimmed}`;
  }

  eventToViewportPoint(event, options = {}) {
    const viewport = this.inputViewport ?? this.stream.viewport;
    if (!viewport) {
      return null;
    }
    const imageBounds = this.viewerImageEl.getBoundingClientRect();
    if (imageBounds.width <= 0 || imageBounds.height <= 0) {
      return null;
    }

    const sourceWidth =
      this.viewerImageEl.naturalWidth > 0 ? this.viewerImageEl.naturalWidth : viewport.width;
    const sourceHeight =
      this.viewerImageEl.naturalHeight > 0 ? this.viewerImageEl.naturalHeight : viewport.height;
    const imageAspect = sourceWidth / sourceHeight;
    const elementAspect = imageBounds.width / imageBounds.height;

    let renderWidth;
    let renderHeight;
    let offsetX;
    let offsetY;

    if (imageAspect > elementAspect) {
      renderWidth = imageBounds.width;
      renderHeight = imageBounds.width / imageAspect;
      offsetX = 0;
      offsetY = (imageBounds.height - renderHeight) / 2;
    } else {
      renderHeight = imageBounds.height;
      renderWidth = imageBounds.height * imageAspect;
      offsetX = (imageBounds.width - renderWidth) / 2;
      offsetY = 0;
    }

    const localX = event.clientX - imageBounds.left - offsetX;
    const localY = event.clientY - imageBounds.top - offsetY;
    const localXWithin = localX >= 0 && localX <= renderWidth;
    const localYWithin = localY >= 0 && localY <= renderHeight;

    if ((!localXWithin || !localYWithin) && !options.clampOutside) {
      return null;
    }

    const normalizedLocalX = options.clampOutside ? clamp(localX, 0, renderWidth) : localX;
    const normalizedLocalY = options.clampOutside ? clamp(localY, 0, renderHeight) : localY;

    return {
      x: clamp(
        Math.floor((normalizedLocalX / renderWidth) * viewport.width),
        0,
        viewport.width - 1,
      ),
      y: clamp(
        Math.floor((normalizedLocalY / renderHeight) * viewport.height),
        0,
        viewport.height - 1,
      ),
    };
  }
}

function normalizeTargetId(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeViewportDimension(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const normalized = Math.floor(value);
  if (normalized < 100) {
    return null;
  }
  return Math.min(8192, normalized);
}

function readViewportFromLayoutMetrics(result) {
  const candidates = [
    result?.cssVisualViewport,
    result?.cssLayoutViewport,
    result?.visualViewport,
    result?.layoutViewport,
  ];

  for (const candidate of candidates) {
    const width = normalizeViewportDimension(candidate?.clientWidth);
    const height = normalizeViewportDimension(candidate?.clientHeight);
    if (width !== null && height !== null) {
      return { width, height };
    }
  }
  return null;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function readCssPixelValue(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mouseButtonName(button) {
  if (button === 1) {
    return "middle";
  }
  if (button === 2) {
    return "right";
  }
  return "left";
}

function mouseButtonMask(button) {
  if (button === 1) {
    return 4;
  }
  if (button === 2) {
    return 2;
  }
  return 1;
}

function readMouseClickCount(type, detail) {
  if (type === "mouseMoved") {
    return 0;
  }
  if (!Number.isFinite(detail) || detail < 1) {
    return 1;
  }
  return Math.floor(detail);
}

function resolveModifiers(event) {
  let modifiers = 0;
  if (event.altKey) {
    modifiers |= 1;
  }
  if (event.ctrlKey) {
    modifiers |= 2;
  }
  if (event.metaKey) {
    modifiers |= 4;
  }
  if (event.shiftKey) {
    modifiers |= 8;
  }
  return modifiers;
}

function readEditingCommands(event) {
  if (event.altKey || event.shiftKey || (!event.metaKey && !event.ctrlKey)) {
    return undefined;
  }
  const command = EDITING_COMMANDS_BY_KEY[event.key.toLowerCase()];
  return command ? [command] : undefined;
}

function readKeyText(event) {
  if (event.isComposing) {
    return undefined;
  }
  if (event.key === "Enter") {
    return "\r";
  }
  if (
    typeof event.key === "string" &&
    event.key.length === 1 &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey
  ) {
    return event.key;
  }
  return undefined;
}

function readVirtualKeyCode(event) {
  if (typeof event.keyCode === "number" && Number.isFinite(event.keyCode)) {
    return event.keyCode;
  }
  return KEY_CODES[event.key] ?? 0;
}

function createCdpKeyDownPayload(event) {
  const windowsVirtualKeyCode = readVirtualKeyCode(event);
  const text = readKeyText({
    key: event.key,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    shiftKey: event.shiftKey,
    isComposing: event.isComposing,
  });
  const commands = readEditingCommands(event);

  return {
    type: text ? "keyDown" : "rawKeyDown",
    key: event.key,
    code: event.code,
    windowsVirtualKeyCode,
    nativeVirtualKeyCode: windowsVirtualKeyCode,
    isKeypad: event.code.startsWith("Numpad"),
    autoRepeat: event.repeat,
    modifiers: resolveModifiers(event),
    ...(text ? { text, unmodifiedText: text } : {}),
    ...(commands ? { commands } : {}),
  };
}

function createCdpKeyPayload(event, type = "keyDown") {
  const key = event.key;
  const code = event.code;
  const windowsVirtualKeyCode = readVirtualKeyCode(event);
  return {
    type,
    key,
    code,
    windowsVirtualKeyCode,
    nativeVirtualKeyCode: windowsVirtualKeyCode,
    isKeypad: event.code.startsWith("Numpad"),
    modifiers: resolveModifiers(event),
  };
}

const EDITING_COMMANDS_BY_KEY = {
  a: "selectAll",
  c: "copy",
  v: "paste",
  x: "cut",
};

const KEY_CODES = {
  " ": 32,
  Enter: 13,
  Tab: 9,
  Escape: 27,
  Backspace: 8,
  Delete: 46,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
};

new LocalViewApp().start();
