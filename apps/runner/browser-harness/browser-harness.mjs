#!/usr/bin/env node
/**
 * Provider-free Browser Harness for an already-authorized CDP WebSocket.
 *
 * Opensteer owns browser launch, profiles, grants, and session lifetime. This
 * executable keeps the useful code-generation workflow: it evaluates one
 * JavaScript program from stdin with a compact set of asynchronous CDP helpers.
 */

import { randomUUID } from "node:crypto";
import { open, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { COMMAND_TIMEOUT, CdpProtocolError, createPage, evaluationResult } from "./page.mjs";

const VERSION = "0.5.0-opensteer";
const MAX_MESSAGE_BYTES = 1_048_576;
const MAX_EVENTS = 500;
const STAGE_CHUNK_BYTES = 256 * 1_024;
const USAGE =
  "usage: browser-harness --session <Browser Session ID> [--tab <target ID>] < JavaScript on stdin\n" +
  "browser_session_open returns the session ID; browser_session_list shows open sessions.";
const INTERNAL_URLS = ["chrome://", "chrome-untrusted://", "devtools://", "chrome-extension://"];
/** More tabs than a person keeps open for one task. */
const MANY_TABS = 6;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
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
  return `[opensteer] This page shows ${kind} dialog (${JSON.stringify(text)}); the page answers no other command until the dialog is answered with Page.handleJavaScriptDialog.`;
}

/**
 * One line when a session holds more tabs than a person would for one task,
 * or null. It counts the person's tabs too, so it asks only about the agent's.
 */
function manyTabsLine(count) {
  if (count <= MANY_TABS) return null;
  return `[opensteer] This Browser Session has ${count} tabs open. Visit your next page in a tab you already opened with gotoUrl(url), and close the tabs you opened once you are done with them.`;
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

class CdpClient {
  #closedError = null;
  #events = [];
  #nextId = 1;
  #pending = new Map();
  #socket;
  #waiters = new Set();
  #listeners = new Set();

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
              `Could not connect to Browser Session ${sessionId}. Check the ID with browser_session_list.`,
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

  close() {
    this.#rejectPending(new Error("CDP client closed"));
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
      pending.reject(new CdpProtocolError(message.error.message || "CDP command failed"));
    } else {
      pending.resolve(message.result ?? {});
    }
  }

  #rejectPending(error) {
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

function createBrowserHarness(client, initialTargetId) {
  let sessionId;
  let targetId;
  let selectedTargetId = initialTargetId;
  /**
   * The person's activity and resize the latest attach measured, before the
   * attach counted as a command.
   */
  let attachedActivity;
  let attachedResize;
  let notedActivity;
  let notedDialog;
  let notedManyTabs = false;
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
  const noteDialogEvent = (target, id) => {
    if (typeof target !== "string") return;
    dialogEvents.set(target, ++dialogSequence);
    if (typeof id === "string") observeDialog(target, { id });
    setOpenDialog(target, typeof id === "string" ? id : undefined);
  };
  /** Target information requested when the dialog sequence stood at `sequence`. */
  const noteDialogSnapshot = (target, dialog, sequence) => {
    if (typeof target !== "string") return;
    observeDialog(target, dialog);
    if ((dialogEvents.get(target) ?? 0) > sequence) return;
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
    observeDialog(targetId, dialog);
    const line = pageDialogLine(dialog);
    if (!line || line === notedDialog) return;
    notedDialog = line;
    process.stderr.write(`${line}\n`);
  };
  client.onEvent((event) => {
    const target = attachedTargets.get(event.sessionId);
    if (event.method === "Page.javascriptDialogClosed") noteDialogEvent(target, undefined);
    if (event.method === "Page.javascriptDialogOpening")
      noteDialogEvent(target, event.params?.dialogId);
  });

  const pages = async () => {
    const sequence = dialogSequence;
    const result = observeTargets(await client.command("Target.getTargets"), sequence);
    return (result.targetInfos ?? []).filter((target) => target.type === "page");
  };

  const detach = async () => {
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
      try {
        await client.command("Target.detachFromTarget", { sessionId: departing });
      } catch {
        // The target may have closed before cleanup.
      }
    }
    if (!sessionId) targetId = undefined;
  };

  const attach = async (requestedTargetId = selectedTargetId) => {
    await detach();
    let nextTargetId = requestedTargetId;
    const inventory = await client.command("Target.getTargets");
    const availablePages = (inventory.targetInfos ?? []).filter((target) => target.type === "page");
    if (!nextTargetId) {
      if (availablePages.length !== 1) {
        throw new Error(
          availablePages.length === 0
            ? "This Browser Session has no open tabs. Open one with await newTab(url)."
            : "Choose a tab with --tab <target ID> or await switchTab(targetId). Use await listTabs() to see the open tabs.",
        );
      }
      if (typeof inventory.rootTargetId !== "string" || inventory.rootTargetId.length === 0) {
        throw new Error(
          "The browser runtime did not provide this session's initial tab identity. Update the browser runtime, or choose an explicit target with --tab.",
        );
      }
      if (availablePages[0].targetId !== inventory.rootTargetId) {
        throw new Error(
          "This Browser Session's initial tab is closed. Use await listTabs() and choose the intended target explicitly with --tab or switchTab(targetId).",
        );
      }
      nextTargetId = inventory.rootTargetId;
    } else if (!availablePages.some((page) => page.targetId === nextTargetId)) {
      throw new Error(
        `Browser tab ${nextTargetId} is closed or unavailable. Use await listTabs() and choose the intended tab explicitly.`,
      );
    }
    if (typeof nextTargetId !== "string" || nextTargetId.length === 0) {
      throw new Error("CDP did not provide a target ID");
    }
    const attachSequence = dialogSequence;
    const result = await client.command("Target.attachToTarget", {
      flatten: true,
      targetId: nextTargetId,
    });
    if (typeof result.sessionId !== "string" || result.sessionId.length === 0) {
      throw new Error("CDP did not provide a session ID");
    }
    sessionId = result.sessionId;
    attachedTargets.set(sessionId, nextTargetId);
    targetId = nextTargetId;
    selectedTargetId = nextTargetId;
    attachedActivity = result.userActivity;
    attachedResize = result.pageResize;
    notePersonActivity(attachedActivity);
    notePageResize(attachedResize);
    notePageDialog(result.dialog);
    noteDialogSnapshot(nextTargetId, result.dialog, attachSequence);
    return sessionId;
  };

  const cdp = async (method, params = {}, requestedSessionId) => {
    const browserLevel = method.startsWith("Target.") || method.startsWith("Browser.");
    if (!browserLevel && !requestedSessionId && !sessionId) await attach();
    const pageSessionId = requestedSessionId ?? (browserLevel ? undefined : sessionId);
    try {
      if (method === "Page.handleJavaScriptDialog") {
        const dialogId = params.dialogId ?? observedDialogs.get(attachedTargets.get(pageSessionId));
        if (typeof dialogId !== "string") {
          throw new Error(
            "Read the dialog with currentTab(), listTabs(), pageInfo(), or drainEvents() before answering it.",
          );
        }
        params = { ...params, dialogId };
      }
      const sequence = dialogSequence;
      const result = observeTargets(await client.command(method, params, pageSessionId), sequence);
      if (method === "Target.attachToTarget") {
        attachedTargets.set(result.sessionId, params.targetId);
        noteDialogSnapshot(params.targetId, result.dialog, sequence);
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

  const listTabs = async ({ includeInternal = true } = {}) =>
    (await pages())
      .filter(
        (target) =>
          includeInternal || !INTERNAL_URLS.some((prefix) => (target.url ?? "").startsWith(prefix)),
      )
      .map((target) => ({
        targetId: target.targetId,
        ...(target.surfaceId ? { surfaceId: target.surfaceId } : {}),
        title: target.title ?? "",
        url: target.url ?? "",
        ...(target.userActivity ? { userActivity: target.userActivity } : {}),
        ...(target.pageResize ? { pageResize: target.pageResize } : {}),
        ...(target.dialog ? { dialog: target.dialog } : {}),
      }));

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
    const userActivity = attaching ? attachedActivity : info.userActivity;
    const pageResize = attaching ? attachedResize : info.pageResize;
    notePersonActivity(userActivity);
    notePageResize(pageResize);
    notePageDialog(info.dialog);
    return {
      targetId: info.targetId,
      ...(info.surfaceId ? { surfaceId: info.surfaceId } : {}),
      title: info.title ?? "",
      url: info.url ?? "",
      ...(userActivity ? { userActivity } : {}),
      ...(pageResize ? { pageResize } : {}),
      ...(info.dialog ? { dialog: info.dialog } : {}),
    };
  };

  const normalizeTargetId = (target) =>
    typeof target === "string"
      ? target
      : target && typeof target.targetId === "string"
        ? target.targetId
        : undefined;

  const switchTab = async (target) => {
    const requestedTargetId = normalizeTargetId(target);
    if (!requestedTargetId) throw new TypeError("switchTab requires a target ID or tab object");
    return attach(requestedTargetId);
  };

  const gotoUrl = async (url) => cdp("Page.navigate", { url: navigableUrl(url) });

  const newTab = async (url = "about:blank") => {
    const address = navigableUrl(url);
    const previousTargetId = selectedTargetId;
    const { targetId: createdTargetId } = await client.command("Target.createTarget", {
      url: "about:blank",
    });
    // A tab that went nowhere is closed, as a person closes one, and the
    // program carries on in the page it was using.
    const discard = async () => {
      await detach();
      selectedTargetId = previousTargetId;
      await client
        .command("Target.closeTarget", { targetId: createdTargetId })
        .catch(() => undefined);
    };
    try {
      await switchTab(createdTargetId);
    } catch (error) {
      await discard();
      throw error;
    }
    if (address !== "about:blank") {
      let navigation;
      try {
        navigation = await cdp("Page.navigate", { url: address });
      } catch (error) {
        if (error instanceof CdpTimeoutError) {
          throw new Error(
            `${address} is still loading in tab ${createdTargetId}. Continue there with --tab ${createdTargetId} or switchTab, or close it.`,
            { cause: error },
          );
        }
        await discard();
        throw error;
      }
      if (navigation.errorText) {
        const failure = `Could not open ${address}: ${navigation.errorText}`;
        // The person taking the tab elsewhere also aborts this navigation;
        // the tab is theirs then.
        const { targetInfo } = await client
          .command("Target.getTargetInfo", { targetId: createdTargetId })
          .catch(() => ({}));
        if (targetInfo?.userActivity?.sinceLastAgentCommand === true) {
          throw new Error(
            `${failure}. The person is using tab ${createdTargetId}, so it stays open.`,
          );
        }
        await discard();
        throw new Error(failure);
      }
    }
    if (!notedManyTabs) {
      const line = manyTabsLine(
        await pages().then(
          (found) => found.length,
          () => 0,
        ),
      );
      if (line) {
        notedManyTabs = true;
        process.stderr.write(`${line}\n`);
      }
    }
    return createdTargetId;
  };

  const closeTab = async (target = targetId) => {
    if (!target) target = (await currentTab()).targetId;
    const requestedTargetId = normalizeTargetId(target);
    if (!requestedTargetId) throw new TypeError("closeTab requires a target ID or tab object");
    return client.command("Target.closeTarget", { targetId: requestedTargetId });
  };

  const ensureRealTab = async () => {
    const current = await currentTab();
    if (INTERNAL_URLS.some((prefix) => current.url.startsWith(prefix))) {
      throw new Error(
        "The selected tab is a browser-internal page. Choose a website tab with switchTab(targetId), or open one with newTab(url).",
      );
    }
    return current;
  };

  const js = async (expression, requestedTargetId) => {
    if (requestedTargetId && requestedTargetId !== targetId) await switchTab(requestedTargetId);
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
    if (typeof loginRef !== "string" || !/^lgn_[0-9a-f]{32}$/u.test(loginRef)) {
      throw new TypeError("fillLogin requires a loginRef from sign_in.");
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
      expired: "Call sign_in again to authorize this session.",
      denied: "Permission to use this login ended.",
      unavailable: "The saved field or Opensteer Passwords is unavailable.",
    };
    const known = Object.hasOwn(explanations, status) ? status : "unavailable";
    throw new Error(`fillLogin ${known}: ${explanations[known]}`);
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
    { full = false } = {},
  ) => {
    const result = await cdp("Page.captureScreenshot", {
      captureBeyondViewport: full,
      format: "png",
    });
    const resolved = path.resolve(outputPath);
    await writeFile(resolved, Buffer.from(result.data, "base64"));
    return resolved;
  };

  const { page, fillInput, pressKey, settleInput } = createPage({
    bind: async () => {
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
          noteDialogEvent(binding.targetId, dialog.id);
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
    const pageSessionId = sessionId;
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
    attach,
    captureScreenshot,
    cdp,
    clickAt,
    closeTab,
    currentTab,
    detach,
    drainEvents: () => {
      const events = client.drainEvents();
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
    gotoUrl,
    js,
    listTabs,
    newTab,
    pageInfo,
    page,
    pressKey,
    scroll,
    setInputFiles,
    sleep,
    stageFiles,
    switchTab,
    typeText,
    waitForElement,
    waitForLoad,
  });
}

async function readProgram() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_MESSAGE_BYTES) throw new Error("Browser Harness program is too large");
    chunks.push(chunk);
  }
  const program = Buffer.concat(chunks).toString("utf8");
  if (!program.trim()) throw new Error(USAGE);
  return program;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (
    ![2, 4].includes(args.length) ||
    args[0] !== "--session" ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(args[1]) ||
    (args.length === 4 && (args[2] !== "--tab" || !/^[A-Za-z0-9_-]{1,256}$/u.test(args[3])))
  ) {
    throw new Error(USAGE);
  }
  const url = process.env.OPENSTEER_BROWSER_CDP_WS;
  if (!url) {
    throw new Error(
      "OPENSTEER_BROWSER_CDP_WS is required; the Opensteer Runner did not configure browser control for this Run",
    );
  }
  const program = await readProgram();
  const client = await CdpClient.connect(url, args[1]);
  const harness = createBrowserHarness(client, args[3]);
  try {
    const names = Object.keys(harness);
    const execute = new AsyncFunction(...names, `"use strict";\n{\n${program}\n}\n`);
    await execute(...names.map((name) => harness[name]));
  } finally {
    await harness.detach();
    client.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
