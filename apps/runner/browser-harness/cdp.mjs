#!/usr/bin/env node
/**
 * Provider-free Browser Harness for an already-authorized Run-local connection.
 *
 * Opensteer owns browser launch, profiles, grants, and session lifetime. This
 * executable keeps the useful code-generation workflow: it evaluates one
 * JavaScript program from stdin with session-negotiated page helpers.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { open, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { COMMAND_TIMEOUT, CdpProtocolError, createPage, evaluationResult } from "./page.mjs";

const MAX_MESSAGE_BYTES = 1_048_576;
const MAX_EVENTS = 500;
const STAGE_CHUNK_BYTES = 256 * 1_024;
const PERSON_ACTIVITY = {
  click: "clicked in this page",
  dialog: "answered a dialog in this page",
  navigation: "navigated this page",
  scroll: "scrolled this page",
  typing: "typed in this page",
};

/**
 * One line about what the person did in a page since the agent last sent it a
 * command, or null. It is information for the agent: nothing waits on it.
 */
function personActivityLine(activity, now = Date.now()) {
  if (activity?.sinceLastAgentCommand !== true) return null;
  const action = PERSON_ACTIVITY[activity.kind];
  if (!action) return null;
  return `[opensteer] The person ${action}${ago(activity.at, now)}. Look at the page again before continuing.`;
}

/**
 * One line about the person's view resizing a page since the agent last sent
 * it a command, or null. Like activity, it is information only.
 */
function pageResizeLine(resize, now = Date.now()) {
  if (resize?.sinceLastAgentCommand !== true) return null;
  if (!Number.isInteger(resize.width) || !Number.isInteger(resize.height)) return null;
  const size = `${resize.width}×${resize.height}`;
  const change =
    resize.agentSizeRemoved === true
      ? `fit this page to their view (${size})${ago(resize.at, now)}, removing the size an agent set`
      : `resized this page to ${size}${ago(resize.at, now)}`;
  return `[opensteer] The person ${change}. Look at the page again before continuing.`;
}

/**
 * One line about the JavaScript dialog open in a page, or null. The page
 * answers no other command until the person or an agent answers the dialog.
 */
function pageDialogLine(dialog) {
  if (typeof dialog?.type !== "string" || typeof dialog.message !== "string") return null;
  const text = dialog.message.length > 200 ? `${dialog.message.slice(0, 200)}…` : dialog.message;
  const kind = `${dialog.type === "alert" ? "an" : "a"} ${dialog.type}`;
  return `[opensteer] This page shows ${kind} dialog (${JSON.stringify(text)}); the page answers no other command until the dialog is answered with respondDialog({ accept: true or false }).`;
}

function navigableUrl(url) {
  const address = String(url);
  if (
    address !== "about:blank" &&
    !address.startsWith("http://") &&
    !address.startsWith("https://")
  ) {
    throw new Error("Navigation requires an HTTP or HTTPS URL");
  }
  return address;
}

class CdpTimeoutError extends Error {}

function ago(timestamp, now) {
  const at = Date.parse(timestamp);
  return Number.isFinite(at) ? ` ${formatAge(Math.max(0, now - at))} ago` : "";
}

function formatAge(milliseconds) {
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

export class CdpClient {
  #closedError = null;
  #events = [];
  #nextId = 1;
  #pending = new Map();
  #socket;
  #waiters = new Set();
  #listeners = new Set();
  #closeListeners = new Set();

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => this.#receive(event.data));
    socket.addEventListener("close", (event) => {
      // The reason names why the Browser Session is unusable and what to do next.
      this.#closedError = new Error(
        event.reason ? `Browser connection closed: ${event.reason}` : "Browser connection closed",
      );
      this.#rejectPending(this.#closedError);
    });
    socket.addEventListener("error", () => this.#rejectPending(new Error("CDP WebSocket failed")));
  }

  static async connect(url, sessionId) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      throw new Error("OPENSTEER_BROWSER_CDP_WS must be a ws:// or wss:// URL", {
        cause: error,
      });
    }
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      throw new Error("OPENSTEER_BROWSER_CDP_WS must be a ws:// or wss:// URL");
    }
    parsed.pathname = `${parsed.pathname.replace(/\/$/u, "")}/${encodeURIComponent(sessionId)}`;
    const socket = new WebSocket(parsed);
    const client = new CdpClient(socket);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error("CDP WebSocket connection timed out"));
      }, 15_000);
      const cleanup = () => clearTimeout(timeout);
      socket.addEventListener(
        "open",
        () => {
          cleanup();
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          cleanup();
          reject(
            new Error(
              "Could not connect to this tab. Use tab_list and openPage(tabId) to bind it again.",
            ),
          );
        },
        { once: true },
      );
    });
    return client;
  }

  async command(method, params = {}, sessionId) {
    if (typeof method !== "string" || method.length === 0) {
      throw new TypeError("CDP method must be a non-empty string");
    }
    const id = this.#nextId++;
    const request = { id, method };
    if (Object.keys(params).length > 0) request.params = params;
    if (sessionId) request.sessionId = sessionId;
    const serialized = JSON.stringify(request);
    if (Buffer.byteLength(serialized) > MAX_MESSAGE_BYTES) {
      throw new Error("CDP request is too large");
    }
    if (this.#closedError) throw this.#closedError;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CdpTimeoutError(`CDP command timed out: ${method}`));
      }, COMMAND_TIMEOUT);
      timeout.unref();
      this.#pending.set(id, {
        reject,
        resolve,
        timeout,
      });
      try {
        this.#socket.send(serialized);
      } catch (error) {
        clearTimeout(timeout);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  drainEvents() {
    return this.#events.splice(0);
  }

  onEvent(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Resolves with the next event `predicate` accepts. */
  waitForEvent(predicate, timeoutMs) {
    if (this.#closedError) return Promise.reject(this.#closedError);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        reject,
        resolve,
        timeout: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(new Error("Timed out waiting for a browser event"));
        }, timeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  onClose(listener) {
    this.#closeListeners.add(listener);
    if (this.#closedError) listener(this.#closedError);
    return () => this.#closeListeners.delete(listener);
  }

  close() {
    this.#closedError = new Error("CDP client closed");
    this.#rejectPending(this.#closedError);
    this.#socket.close(1000);
  }

  #receive(data) {
    const serialized =
      typeof data === "string"
        ? data
        : Buffer.from(data instanceof ArrayBuffer ? data : data.buffer).toString("utf8");
    if (Buffer.byteLength(serialized) > MAX_MESSAGE_BYTES) {
      this.#rejectPending(new Error("CDP response is too large"));
      this.#socket.close(1009);
      return;
    }
    let message;
    try {
      message = JSON.parse(serialized);
    } catch {
      this.#rejectPending(new Error("CDP returned invalid JSON"));
      this.#socket.close(1007);
      return;
    }
    if (!Number.isInteger(message?.id)) {
      for (const listener of this.#listeners) listener(message);
      for (const waiter of this.#waiters) {
        if (!waiter.predicate(message)) continue;
        this.#waiters.delete(waiter);
        clearTimeout(waiter.timeout);
        waiter.resolve(message);
      }
      this.#events.push(message);
      if (this.#events.length > MAX_EVENTS)
        this.#events.splice(0, this.#events.length - MAX_EVENTS);
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.error) {
      pending.reject(
        Object.assign(new CdpProtocolError(message.error.message || "CDP command failed"), {
          code: message.error.code,
          reason: message.error.reason,
        }),
      );
    } else {
      pending.resolve(message.result ?? {});
    }
  }

  #rejectPending(error) {
    this.#closedError = error;
    for (const listener of this.#closeListeners) listener(error);
    this.#closeListeners.clear();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.#waiters.clear();
  }
}

export function createBrowserHarness(client, initialTargetId) {
  const operations = new AsyncLocalStorage();
  /**
   * Explicit disposal keeps the page channel until its outstanding work settles.
   */
  const inFlight = new Map();
  const detachTarget = (departing) =>
    client.command("Target.detachFromTarget", { sessionId: departing }).catch(() => {
      // The target may have closed before cleanup.
    });
  let sessionId;
  let targetId;
  const selectedTargetId = initialTargetId;
  /**
   * The person's activity and resize the latest attach measured, before the
   * attach counted as a command.
   */
  let attachedActivity;
  let attachedResize;
  let attachedObservationPending = false;
  let notedActivity;
  let notedDialog;
  let notedResize;

  const notePersonActivity = (activity) => {
    const line = personActivityLine(activity);
    if (!line || (notedActivity?.at === activity.at && notedActivity?.kind === activity.kind)) {
      return;
    }
    notedActivity = activity;
    process.stderr.write(`${line}\n`);
  };

  const notePageResize = (resize) => {
    const line = pageResizeLine(resize);
    if (!line || notedResize?.at === resize.at) return;
    notedResize = resize;
    process.stderr.write(`${line}\n`);
  };

  const observedDialogs = new Map();
  /**
   * Each target's open dialog ({ id, since }) as the page shows it now. Live
   * events and answers set it; target information sets it only when no event
   * for that target arrived after the information was requested, so a stale
   * reply never reopens or hides a dialog. observedDialogs also keeps
   * identities replayed by drainEvents, which never touch this state.
   */
  const openDialogs = new Map();
  const dialogDescriptions = new Map();
  const stale = new AbortController();
  let dialogSequence = 0;
  const dialogEvents = new Map();
  const dialogWatchers = new Map();
  const attachedTargets = new Map();
  const inputSessions = new Map();
  const observeDialog = (target, dialog) => {
    if (typeof target === "string" && typeof dialog?.id === "string") {
      observedDialogs.set(target, dialog.id);
    }
  };
  const setOpenDialog = (target, id) => {
    const current = openDialogs.get(target);
    if (id === undefined) {
      if (!current) return;
      openDialogs.delete(target);
    } else {
      if (current?.id === id) return;
      openDialogs.set(target, { id, since: performance.now() });
    }
    for (const watcher of dialogWatchers.get(target) ?? []) watcher();
  };
  /** A dialog opened, or closed when `id` is undefined. */
  const noteDialogEvent = (target, id, dialog) => {
    if (typeof target !== "string") return;
    dialogEvents.set(target, ++dialogSequence);
    dialogDescriptions.set(target, id ? (dialog ?? { id }) : null);
    if (typeof id === "string") observeDialog(target, { id });
    setOpenDialog(target, typeof id === "string" ? id : undefined);
  };
  /** Target information requested when the dialog sequence stood at `sequence`. */
  const noteDialogSnapshot = (target, dialog, sequence) => {
    if (typeof target !== "string") return;
    if ((dialogEvents.get(target) ?? 0) > sequence) return;
    observeDialog(target, dialog);
    dialogDescriptions.set(target, dialog ?? null);
    setOpenDialog(target, typeof dialog?.id === "string" ? dialog.id : undefined);
  };
  const watchDialogs = (target) => ({
    open: () => openDialogs.get(target),
    onChange: (watcher) => {
      const watchers = dialogWatchers.get(target) ?? new Set();
      watchers.add(watcher);
      dialogWatchers.set(target, watchers);
      return () => watchers.delete(watcher);
    },
  });
  const observeTargets = (result, sequence) => {
    for (const target of result.targetInfos ?? (result.targetInfo ? [result.targetInfo] : [])) {
      noteDialogSnapshot(target.targetId, target.dialog, sequence);
    }
    return result;
  };
  const notePageDialog = (dialog) => {
    const line = pageDialogLine(dialog);
    if (!line || line === notedDialog) return;
    notedDialog = line;
    process.stderr.write(`${line}\n`);
  };
  client.onEvent((event) => {
    if (
      event.method === "Target.attachedToTarget" &&
      attachedTargets.has(event.sessionId) &&
      typeof event.params?.sessionId === "string"
    )
      attachedTargets.set(event.params.sessionId, event.params.targetInfo?.targetId);
    if (event.method === "Target.detachedFromTarget" && attachedTargets.has(event.sessionId))
      attachedTargets.delete(event.params?.sessionId);
    const target = attachedTargets.get(event.sessionId);
    if (event.method === "Target.targetDestroyed" && event.params?.targetId === targetId)
      stale.abort(new Error("This page handle is stale; bind it again with openPage(tabId)."));
    if (event.method === "Page.javascriptDialogClosed") noteDialogEvent(target, undefined);
    if (event.method === "Page.javascriptDialogOpening")
      noteDialogEvent(target, event.params?.dialogId, {
        id: event.params?.dialogId,
        type: event.params?.type,
        message: event.params?.message,
      });
  });

  const resumedNotice = (surfaceId, reopened = false) =>
    process.stderr.write(
      reopened
        ? `[opensteer] Tab ${surfaceId} was asleep and was reopened at its address: its typed text, scroll position and page state are gone. Observe it again before acting; old page handles are invalid.\n`
        : `[opensteer] Tab ${surfaceId} was asleep and has reloaded. Observe it again before acting; old page handles are invalid.\n`,
    );
  const attachedSurfaces = new Map();
  const invalidSessions = new Set();
  const invalidateSurface = (surfaceId) => {
    for (const [id, surface] of attachedSurfaces) {
      if (surface !== surfaceId) continue;
      if (id === sessionId)
        stale.abort(
          new Error("This page handle is stale after the tab reloaded; use openPage(tabId)."),
        );
      invalidSessions.add(id);
      const target = attachedTargets.get(id);
      attachedSurfaces.delete(id);
      attachedTargets.delete(id);
      inputSessions.delete(id);
      observedDialogs.delete(target);
      openDialogs.delete(target);
      dialogEvents.delete(target);
    }
  };

  const detach = async ({ final = false } = {}) => {
    // Captured before waiting, so the session settled is the one detached.
    const departing = sessionId;
    if (departing) {
      await settleInput(departing, watchDialogs(attachedTargets.get(departing)), {
        waiting: (count) =>
          process.stderr.write(
            `[opensteer] Waiting for the page to acknowledge ${count} pending release${count === 1 ? "" : "s"} before leaving it.\n`,
          ),
        dialogClosed: () =>
          process.stderr.write(
            "[opensteer] The dialog on this page closed; waiting for the page to acknowledge its pending releases.\n",
          ),
      });
      if (sessionId === departing) sessionId = undefined;
      const running = inFlight.get(departing);
      if (!final) {
        if (running) running.detach = true;
        else await detachTarget(departing);
      }
    }
    if (!sessionId) targetId = undefined;
  };

  let attaching;
  const attach = () => {
    stale.signal.throwIfAborted();
    if (sessionId) return Promise.resolve(sessionId);
    attaching ??= (async () => {
      if (!selectedTargetId) throw new Error("openPage(tabId) requires an explicit tab ID.");
      const sequence = dialogSequence;
      const resumed = await client.command("Opensteer.resumeTab", { surfaceId: selectedTargetId });
      if (resumed.reloaded) resumedNotice(selectedTargetId, resumed.reopened === true);
      if (typeof resumed.targetId !== "string" || !resumed.targetId.length)
        throw new Error("The browser did not provide the tab identity");
      targetId = resumed.targetId;
      noteDialogSnapshot(targetId, resumed.dialog, sequence);
      const attachSequence = dialogSequence;
      const result = await client.command("Target.attachToTarget", {
        flatten: true,
        targetId,
      });
      if (typeof result.sessionId !== "string" || !result.sessionId.length)
        throw new Error("The browser did not provide a tab connection");
      sessionId = result.sessionId;
      attachedTargets.set(sessionId, targetId);
      attachedSurfaces.set(sessionId, selectedTargetId);
      attachedActivity = resumed.userActivity;
      attachedResize = resumed.pageResize;
      attachedObservationPending = true;
      notePersonActivity(attachedActivity);
      notePageResize(attachedResize);
      notePageDialog(resumed.dialog);
      if (Object.hasOwn(result, "dialog"))
        noteDialogSnapshot(targetId, result.dialog, attachSequence);
      return sessionId;
    })().finally(() => {
      attaching = undefined;
    });
    return attaching;
  };

  const cdp = async (method, params = {}, requestedSessionId) => {
    const browserLevel =
      [
        "Target.getTargets",
        "Target.getTargetInfo",
        "Target.attachToTarget",
        "Target.detachFromTarget",
        "Target.createTarget",
        "Target.closeTarget",
        "Target.activateTarget",
        "Target.setDiscoverTargets",
        "Target.getBrowserContexts",
      ].includes(method) ||
      method.startsWith("Browser.") ||
      method === "Opensteer.resumeTab";
    const captured = operations.getStore();
    if (!browserLevel && !requestedSessionId && !captured?.sessionId && !sessionId) await attach();
    const pageSessionId =
      requestedSessionId ?? (browserLevel ? undefined : (captured?.sessionId ?? sessionId));
    if (pageSessionId === sessionId && !browserLevel) attachedObservationPending = false;
    try {
      stale.signal.throwIfAborted();
      if (invalidSessions.has(pageSessionId))
        throw new Error(
          "This tab reloaded after sleeping. Observe it again and use fresh page handles.",
        );
      if (method === "Page.handleJavaScriptDialog") {
        const dialogId = params.dialogId ?? observedDialogs.get(attachedTargets.get(pageSessionId));
        if (typeof dialogId !== "string") {
          throw new Error(
            "Read the dialog with currentTab(), pageInfo(), or drainEvents() before answering it.",
          );
        }
        params = { ...params, dialogId };
      }
      const sequence = dialogSequence;
      const result = observeTargets(await client.command(method, params, pageSessionId), sequence);
      if (method === "Target.attachToTarget") {
        attachedTargets.set(result.sessionId, params.targetId);
        attachedSurfaces.set(result.sessionId, result.surfaceId ?? params.targetId);
        noteDialogSnapshot(params.targetId, result.dialog, sequence);
      }
      if (method === "Opensteer.resumeTab" && result.reloaded) {
        const selectedSurface = attachedSurfaces.get(sessionId);
        invalidateSurface(result.surfaceId);
        resumedNotice(result.surfaceId, result.reopened === true);
        if (selectedSurface === result.surfaceId) {
          sessionId = undefined;
          targetId = undefined;
        }
      }
      // A replacement may already be open; only the dialog answered here closed.
      const answered = attachedTargets.get(pageSessionId);
      if (
        method === "Page.handleJavaScriptDialog" &&
        openDialogs.get(answered)?.id === params.dialogId
      )
        noteDialogEvent(answered, undefined);
      return result;
    } catch (error) {
      if (error.reason === "target-suspended")
        process.stderr.write(
          `[opensteer] Tab ${attachedSurfaces.get(pageSessionId) ?? selectedTargetId} is asleep. Bind it with openPage(tabId), then observe it again before acting; it will reload and old page handles are invalid.\n`,
        );
      // A dialog is the usual reason a page stops answering.
      if (error instanceof CdpTimeoutError && pageSessionId && pageSessionId === sessionId) {
        const sequence = dialogSequence;
        const info = observeTargets(
          await client.command("Target.getTargetInfo", { targetId }).catch(() => ({})),
          sequence,
        );
        const line = pageDialogLine(info.targetInfo?.dialog);
        if (line) process.stderr.write(`${line}\n`);
      }
      throw error;
    }
  };

  /**
   * Reading target information is not a page command, so the person's
   * activity and resize it carries are measured from the agent's last command
   * there. An attach this call makes counts as one; what it measured first is
   * what is reported.
   */
  const currentTab = async () => {
    const attaching = !sessionId;
    if (attaching) await attach();
    const sequence = dialogSequence;
    const result = observeTargets(
      await client.command("Target.getTargetInfo", { targetId }),
      sequence,
    );
    const info = result.targetInfo;
    if (!info) throw new Error("CDP did not return target information");
    const userActivity = attachedObservationPending ? attachedActivity : info.userActivity;
    const pageResize = attachedObservationPending ? attachedResize : info.pageResize;
    attachedObservationPending = false;
    notePersonActivity(userActivity);
    notePageResize(pageResize);
    const dialog = dialogDescriptions.get(targetId) ?? undefined;
    notePageDialog(dialog);
    return {
      targetId: info.targetId,
      ...(info.surfaceId ? { surfaceId: info.surfaceId } : {}),
      title: info.title ?? "",
      url: info.url ?? "",
      ...(userActivity ? { userActivity } : {}),
      ...(pageResize ? { pageResize } : {}),
      ...(dialog ? { dialog } : {}),
    };
  };

  const gotoUrl = async (url) => cdp("Page.navigate", { url: navigableUrl(url) });
  const ensureRealTab = () => currentTab();

  const js = async (expression, target) => {
    if (target !== undefined)
      throw new TypeError(
        "js() is bound to this page; use openPage(tabId).js(expression) for another page.",
      );
    const response = await cdp("Runtime.evaluate", {
      awaitPromise: true,
      expression: String(expression),
      returnByValue: true,
    });
    return evaluationResult(response);
  };

  const pageInfo = async () => {
    // Activity and resize first: the page read below counts as the agent's latest command there.
    const tab = await currentTab();
    // A page under a dialog would answer the read only once the dialog closes.
    const info = tab.dialog
      ? { url: tab.url, title: tab.title }
      : await js(
          "({url:location.href,title:document.title,w:innerWidth,h:innerHeight,sx:scrollX,sy:scrollY,pw:document.documentElement.scrollWidth,ph:document.documentElement.scrollHeight})",
        );
    return {
      ...info,
      targetId: tab.targetId,
      ...(tab.surfaceId ? { surfaceId: tab.surfaceId } : {}),
      ...(tab.userActivity ? { userActivity: tab.userActivity } : {}),
      ...(tab.pageResize ? { pageResize: tab.pageResize } : {}),
      ...(tab.dialog ? { dialog: tab.dialog } : {}),
    };
  };

  const clickAt = (x, y, { button = "left", clicks = 1 } = {}) =>
    page.mouse.click(x, y, { button, clickCount: clicks });

  const fillLogin = async (loginRef, field) => {
    if (typeof loginRef === "string" && loginRef.startsWith("crd_"))
      throw new TypeError("Saved card references can only be used with fillCard in a tab.");
    if (typeof loginRef !== "string" || !/^lgn_[0-9a-f]{32}$/u.test(loginRef)) {
      throw new TypeError("fillLogin requires a loginRef from saved_login_request.");
    }
    if (!["username", "password", "code"].includes(field)) {
      throw new TypeError("fillLogin field must be username, password, or code.");
    }
    const { status } = await cdp("Opensteer.fillLogin", { loginRef, field });
    if (status === "filled") return "filled";
    const explanations = {
      "no-field": "Focus an editable field of the requested kind.",
      "wrong-site": "The focused field is outside the approved website.",
      stale: "The focused field or page changed; inspect the page before trying again.",
      expired: "Call saved_login_request again for a fresh reference.",
      denied: "Permission to use this login ended.",
      unavailable: "The saved field or Opensteer Passwords is unavailable.",
    };
    const known = Object.hasOwn(explanations, status) ? status : "unavailable";
    throw new Error(`fillLogin ${known}: ${explanations[known]}`);
  };

  const fillCard = async (cardRef, field) => {
    if (typeof cardRef !== "string" || !/^crd_[0-9a-f]{32}$/u.test(cardRef)) {
      throw new TypeError("fillCard requires a cardRef from card_request.");
    }
    if (
      ![
        "number",
        "expiry",
        "expiry-month",
        "expiry-year",
        "cvc",
        "name",
        "billing-postal-code",
      ].includes(field)
    ) {
      throw new TypeError("fillCard field must be a supported card field.");
    }
    const { status } = await cdp("Opensteer.fillCard", { cardRef, field });
    if (status === "filled") return "filled";
    const explanations = {
      "no-field": "Focus an editable field of the requested kind.",
      "wrong-site": "The focused field is outside the approved website.",
      stale: "The focused field or page changed; inspect the page before trying again.",
      expired: "Call card_request again to authorize this tab.",
      denied: "Permission to use this card ended.",
      unavailable: "The saved field or Opensteer Passwords is unavailable.",
    };
    const known = Object.hasOwn(explanations, status) ? status : "unavailable";
    throw new Error(`fillCard ${known}: ${explanations[known]}`);
  };

  const typeText = (text) => page.keyboard.insertText(text);

  const sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(milliseconds))));

  const waitForElement = async (selector, { timeout = 10_000 } = {}) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await js(`Boolean(document.querySelector(${JSON.stringify(String(selector))}))`))
        return true;
      await sleep(100);
    }
    return false;
  };

  const scroll = (x, y, { deltaX = 0, deltaY = -300 } = {}) =>
    cdp("Input.dispatchMouseEvent", { deltaX, deltaY, type: "mouseWheel", x, y });

  const waitForLoad = async ({ timeout = 15_000 } = {}) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if ((await js("document.readyState")) === "complete") return true;
      await sleep(100);
    }
    throw new Error("Page did not finish loading");
  };

  const captureScreenshot = async (
    outputPath = path.join(process.env.OPENSTEER_AGENT_WORKSPACE ?? ".", "browser-screenshot.png"),
  ) => {
    const result = await cdp("Page.captureScreenshot", { format: "png" });
    const resolved = path.resolve(outputPath);
    await writeFile(resolved, Buffer.from(result.data, "base64"));
    if (result.cropped) {
      const { page, visible } = result.cropped;
      process.stderr.write(
        `[opensteer] This screenshot shows ${visible.width}×${visible.height} of a ${page.width}×${page.height} page; a person's view crops the rest. Its coordinates are still correct. Scroll to see more.\n`,
      );
    }
    return resolved;
  };

  const { page, fillInput, pressKey, settleInput } = createPage({
    bind: async () => {
      const captured = operations.getStore();
      if (captured?.sessionId) return captured;
      if (!sessionId) await attach();
      return { sessionId, targetId };
    },
    command: cdp,
    enableInput: (pageSessionId) => {
      if (!inputSessions.has(pageSessionId)) {
        const enabled = cdp("Page.enable", {}, pageSessionId).catch((error) => {
          inputSessions.delete(pageSessionId);
          throw error;
        });
        inputSessions.set(pageSessionId, enabled);
      }
      return inputSessions.get(pageSessionId);
    },
    watchDialog: (binding) => {
      let cancel;
      const promise = new Promise((resolve) => {
        cancel = client.onEvent((event) => {
          if (
            event.method !== "Page.javascriptDialogOpening" ||
            event.sessionId !== binding.sessionId
          )
            return;
          const dialog = {
            id: event.params?.dialogId,
            type: event.params?.type,
            message: event.params?.message,
          };
          noteDialogEvent(binding.targetId, dialog.id, dialog);
          const line = pageDialogLine(dialog);
          if (line && line !== notedDialog) {
            notedDialog = line;
            process.stderr.write(`${line}\n`);
          }
          resolve(dialog);
        });
      });
      return { promise, cancel: () => cancel() };
    },
    navigableUrl,
    screenshot: captureScreenshot,
  });

  /**
   * Copies local files into this Browser Session's private folder on the
   * machine running the browser and returns their paths there. Only those
   * paths can be given to file inputs or drag data (DOM.setFileInputFiles,
   * Input.dispatchDragEvent). Each file keeps its name.
   */
  const stageFiles = async (paths) => {
    const list = (Array.isArray(paths) ? paths : [paths]).map((entry) =>
      path.resolve(String(entry)),
    );
    if (list.length === 0) throw new TypeError("stageFiles needs at least one file path");
    const staged = [];
    for (const local of list) {
      let info;
      try {
        info = await stat(local);
      } catch {
        throw new Error(`Cannot read ${local}`);
      }
      if (!info.isFile()) throw new Error(`${local} is not a file`);
      const fileId = randomUUID();
      const name = path.basename(local);
      const handle = await open(local, "r");
      try {
        const buffer = Buffer.alloc(STAGE_CHUNK_BYTES);
        let offset = 0;
        for (;;) {
          const { bytesRead } = await handle.read(buffer, 0, STAGE_CHUNK_BYTES, offset);
          const last = bytesRead === 0 || offset + bytesRead >= info.size;
          const result = await client.command("Opensteer.stageFile", {
            data: buffer.subarray(0, bytesRead).toString("base64"),
            fileId,
            name,
            offset,
            ...(last ? { size: offset + bytesRead } : {}),
          });
          offset += bytesRead;
          if (!last) continue;
          if (typeof result.path !== "string") throw new Error(`Could not stage ${local}`);
          staged.push(result.path);
          break;
        }
      } finally {
        await handle.close();
      }
    }
    return staged;
  };

  const describeFileInput = async (objectId) => {
    const described = await cdp("Runtime.callFunctionOn", {
      functionDeclaration:
        "function(){return Array.from(this.files||[]).map(f=>({name:f.name,size:f.size,type:f.type}))}",
      objectId,
      returnByValue: true,
    });
    return { files: described.result?.value ?? [] };
  };

  /**
   * Gives local files to a page. `target` is a CSS selector for an
   * <input type="file">, or the {x, y} of a button that opens a file chooser.
   * Returns the files the page now holds.
   */
  const setInputFiles = async (target, paths) => {
    if (typeof target === "string") {
      const found = await cdp("Runtime.evaluate", {
        expression: `document.querySelector(${JSON.stringify(target)})`,
      });
      const objectId = found.result?.objectId;
      if (!objectId) throw new Error(`No element matches ${target}`);
      const kind = await cdp("Runtime.callFunctionOn", {
        functionDeclaration:
          "function(){return this instanceof HTMLInputElement&&this.type==='file'?(this.multiple?'multiple':'single'):null}",
        objectId,
        returnByValue: true,
      });
      if (!kind.result?.value) {
        throw new Error(
          `${target} is not a file input. For an upload button, pass its {x, y} coordinates instead.`,
        );
      }
      const list = Array.isArray(paths) ? paths : [paths];
      if (kind.result.value === "single" && list.length > 1) {
        throw new Error(`${target} accepts one file`);
      }
      await cdp("DOM.setFileInputFiles", { files: await stageFiles(list), objectId });
      return describeFileInput(objectId);
    }
    if (!target || !Number.isFinite(target.x) || !Number.isFinite(target.y)) {
      throw new TypeError("setInputFiles target must be a CSS selector or {x, y} coordinates");
    }
    const files = await stageFiles(paths);
    const pageSessionId = operations.getStore()?.sessionId ?? sessionId;
    await cdp("Page.enable");
    await cdp("Page.setInterceptFileChooserDialog", { enabled: true });
    try {
      const opened = client.waitForEvent(
        (event) => event.method === "Page.fileChooserOpened" && event.sessionId === pageSessionId,
        10_000,
      );
      opened.catch(() => undefined);
      await clickAt(target.x, target.y);
      let event;
      try {
        event = await opened;
      } catch {
        throw new Error(`No file chooser opened after clicking (${target.x}, ${target.y})`);
      }
      if (event.params?.mode === "selectSingle" && files.length > 1) {
        throw new Error("The file chooser accepts one file");
      }
      await cdp("DOM.setFileInputFiles", { backendNodeId: event.params?.backendNodeId, files });
      const resolved = await cdp("DOM.resolveNode", { backendNodeId: event.params?.backendNodeId });
      return describeFileInput(resolved.object?.objectId);
    } finally {
      await cdp("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => undefined);
    }
  };

  return Object.freeze({
    run: (operation) => {
      const binding = { sessionId, targetId };
      if (!binding.sessionId) return operations.run(binding, operation);
      const running = inFlight.get(binding.sessionId) ?? { count: 0, detach: false };
      inFlight.set(binding.sessionId, running);
      running.count += 1;
      const settle = () => {
        if (--running.count > 0) return;
        inFlight.delete(binding.sessionId);
        if (running.detach && binding.sessionId !== sessionId) void detachTarget(binding.sessionId);
      };
      let result;
      try {
        result = operations.run(binding, operation);
      } catch (error) {
        settle();
        throw error;
      }
      if (!(result instanceof Promise)) {
        settle();
        return result;
      }
      return result.finally(settle);
    },
    attach,
    captureScreenshot,
    cdp,
    clickAt,
    currentTab,
    detach,
    drainEvents: () => {
      const events = client.drainEvents().filter((event) => {
        if (event.sessionId) return attachedTargets.has(event.sessionId);
        const target = event.params?.targetId ?? event.params?.targetInfo?.targetId;
        return typeof target === "string" && [...attachedTargets.values()].includes(target);
      });
      for (const event of events) {
        if (event.method === "Page.javascriptDialogOpening") {
          observeDialog(attachedTargets.get(event.sessionId), { id: event.params?.dialogId });
        }
      }
      return events;
    },
    ensureRealTab,
    fillInput,
    fillLogin,
    fillCard,
    gotoUrl,
    js,
    pageInfo,
    page,
    pressKey,
    respondDialog: (options) => cdp("Page.handleJavaScriptDialog", options),
    scroll,
    setInputFiles,
    sleep,
    stageFiles,
    typeText,
    waitForElement,
    waitForLoad,
    waitForNetworkIdle: (options) =>
      networkIdle(client, cdp, () => new Set(attachedTargets.keys()), options, stale.signal),
  });
}

/** Observes requests that begin during this window; already-finished requests are unknown. */
export async function networkIdle(
  client,
  cdp,
  session,
  { timeout = 10_000, idleMs = 500 } = {},
  staleSignal,
) {
  for (const [name, value] of Object.entries({ timeout, idleMs }))
    if (!Number.isInteger(value) || value < 1 || value > 300_000)
      throw new TypeError(`${name} must be an integer from 1 to 300000 ms`);
  const requests = new Set();
  let idleTimer,
    deadline,
    done = false;
  let finish;
  const result = new Promise((resolve, reject) => {
    finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(idleTimer);
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve(value);
    };
  });
  const armIdle = () => {
    clearTimeout(idleTimer);
    if (!requests.size && !done) idleTimer = setTimeout(() => finish(null, true), idleMs);
  };
  const removeEvent = client.onEvent((event) => {
    const bound = session();
    if (bound instanceof Set ? !bound.has(event.sessionId) : event.sessionId !== bound) return;
    const { requestId, type } = event.params ?? {};
    const key = `${event.sessionId}:${requestId}`;
    if (event.method === "Network.requestWillBeSent") {
      if (type !== "WebSocket" && type !== "EventSource") requests.add(key);
      else requests.delete(key);
    } else if (
      ["Network.loadingFinished", "Network.loadingFailed"].includes(event.method) ||
      (event.method === "Network.responseReceived" && ["WebSocket", "EventSource"].includes(type))
    ) {
      requests.delete(key);
    } else return;
    armIdle();
  });
  const removeClose = client.onClose((error) => finish(error));
  const stale = () => finish(staleSignal.reason);
  staleSignal?.addEventListener("abort", stale, { once: true });
  if (staleSignal?.aborted) stale();
  deadline = setTimeout(() => finish(null, false), timeout);
  // Attach and enable count toward the same deadline. Do not disable Network: another waiter may use it.
  void cdp("Network.enable").then(armIdle, (error) => finish(error));
  try {
    return await result;
  } finally {
    removeEvent();
    removeClose();
    staleSignal?.removeEventListener("abort", stale);
    clearTimeout(idleTimer);
    clearTimeout(deadline);
  }
}
