import { browserReplLimits } from "./browser-repl-messages.js";

export const browserGuestLibrary = String.raw`
import { CdpProtocolError, createPage, evaluationResult } from "./page.mjs";

const bridge = globalThis.__computerCall;
const write = globalThis.__computerPrint;
const now = globalThis.__browserNow;
delete globalThis.__computerCall;
delete globalThis.__computerPrint;
delete globalThis.__browserNow;
globalThis.performance = Object.freeze({ now });
const encode = JSON.stringify;
const ErrorValue = Error;
const hasOwn = Object.hasOwn;
const decode = JSON.parse;
const charCodeAt = Function.prototype.call.bind(String.prototype.charCodeAt);
const substring = Function.prototype.call.bind(String.prototype.slice);
const asString = String;
const isInteger = Number.isSafeInteger;

globalThis.__browserCodec = (mode, value) => {
  if (mode === true) return value === undefined ? undefined : encode(value);
  if (mode === false) {
    const limit = (text, units) => typeof text === "string" ? substring(text, 0, units) : undefined;
    const code = value?.code;
    const cdpCode = isInteger(code) ? code : undefined;
    return [cdpCode === undefined ? limit(code, 128) : "cdp-error", limit(value?.message, 8192) ?? limit(asString(value), 8192),
      limit(value?.next, 2000), cdpCode];
  }
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const c = charCodeAt(value, i);
    if (c <= 127) bytes++;
    else if (c <= 2047) bytes += 2;
    else if (c >= 55296 && c <= 56319 && charCodeAt(value, i + 1) >= 56320 && charCodeAt(value, i + 1) <= 57343) {
      i++;
      bytes += 4;
    } else bytes += c >= 55296 && c <= 57343 ? 9 : 3;
    if (bytes > mode) return 0;
  }
  return bytes;
};

async function call(operation, target = null, args = {}) {
  const result = decode(await bridge(encode({ operation: "browser." + operation, target, args })));
  if (hasOwn(result, "error")) {
    const { code, message, next, cdpCode } = result.error;
    const error = code === "cdp-error" ? new CdpProtocolError(message) : new ErrorValue(message);
    error.code = cdpCode ?? code;
    if (next !== undefined) error.next = next;
    throw error;
  }
  return result.value;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms))));
const print = (...values) => {
  const text = values.map(value => typeof value === "string" ? value : encode(value)).join(" ");
  write(text, encode(text));
};
function navigableUrl(url) {
  const address = String(url);
  if (address !== "about:blank" && !address.startsWith("http://") && !address.startsWith("https://"))
    throw new Error("Navigation requires an HTTP or HTTPS URL");
  return address;
}
async function parseUrl(href) {
  const { entries, ...url } = await call("url", null, { href });
  const getAll = name => {
    const key = String(name);
    return entries.filter(([name]) => name === key).map(([, value]) => value);
  };
  const searchParams = {
    size: entries.length,
    get: name => getAll(name)[0] ?? null,
    getAll,
    has: (name, value) => value === undefined ? getAll(name).length > 0 : getAll(name).includes(String(value)),
    keys: () => entries.map(([key]) => key).values(),
    values: () => entries.map(([, value]) => value).values(),
    entries: () => entries.map(entry => entry.slice()).values(),
    toString: () => url.query,
    forEach: (callback, receiver) => {
      for (const [name, value] of entries) callback.call(receiver, value, name, searchParams);
    },
  };
  searchParams[Symbol.iterator] = searchParams.entries;
  const { query, ...fields } = url;
  return Object.freeze({ ...fields, searchParams: Object.freeze(searchParams), toString: () => url.href, toJSON: () => url.href });
}

const states = new Map();
const clearListeners = Function.prototype.call.bind(Set.prototype.clear);
const visitStates = Function.prototype.call.bind(Map.prototype.forEach, states);
globalThis.__browserEndCall = () => visitStates(state => clearListeners(state.listeners));
function stateFor(handle) {
  if (!states.has(handle)) states.set(handle, {
    events: [], bytes: 0, listeners: new Set(), open: new Map(), observed: new Map(), sequence: new Map(),
    page: undefined, ended: false,
  });
  return states.get(handle);
}
function noteDialog(state, sessionId, dialog) {
  if (dialog?.id) {
    state.open.set(sessionId, dialog);
    state.observed.set(sessionId, dialog.id);
  } else state.open.delete(sessionId);
}
globalThis.__browserReceiveEvents = encoded => {
  const { live, events } = decode(encoded);
  for (const [bytes, [handle, method, sessionId, params]] of events) {
    const state = stateFor(handle);
    const event = { method, params, ...(sessionId === null ? {} : { sessionId }) };
    const session = event.sessionId;
    if (event.method === "Page.javascriptDialogOpening" || event.method === "Page.javascriptDialogClosed") {
      state.sequence.set(session, (state.sequence.get(session) ?? 0) + 1);
      noteDialog(state, session, event.method === "Page.javascriptDialogOpening"
        ? { id: event.params?.dialogId, type: event.params?.type, message: event.params?.message }
        : null);
    }
    if (event.method === "Target.detachedFromTarget" && event.params?.sessionId) {
      state.open.delete(event.params.sessionId);
      state.observed.delete(event.params.sessionId);
      state.sequence.delete(event.params.sessionId);
    }
    state.events.push({ event, bytes });
    state.bytes += bytes;
    while (state.events.length > ${browserReplLimits.events} || state.bytes > ${browserReplLimits.eventBytes})
      state.bytes -= state.events.shift().bytes;
    for (const listener of state.listeners) listener(event);
  }
  for (const [handle, state] of states) {
    if (live.includes(handle)) continue;
    states.delete(handle);
    state.ended = true;
    clearListeners(state.listeners);
    state.open.clear();
    state.observed.clear();
    state.sequence.clear();
    state.events = [];
    state.bytes = 0;
  }
};

const rootCommands = new Set([
  "Target.getTargets", "Target.getTargetInfo", "Target.attachToTarget",
  "Target.detachFromTarget", "Target.createTarget", "Target.closeTarget",
  "Target.activateTarget", "Target.setDiscoverTargets", "Target.getBrowserContexts",
  "Opensteer.resumeTab",
]);

function bindPage({ handle, tabId, targetId, sessionId, dialog }) {
  const state = stateFor(handle);
  if (state.page) return state.page;
  if (!state.sequence.has(sessionId)) noteDialog(state, sessionId, dialog);
  const command = async (method, params = {}, requestedSession, screenshot = false) => {
    if (state.ended) throw Object.assign(new Error("This page handle has ended. Bind the tab again with openPage(tabId)."), { code: "page-ended" });
    const session = requestedSession ?? (
      method.startsWith("Browser.") || rootCommands.has(method) ? undefined : sessionId
    );
    if (method === "Page.handleJavaScriptDialog") {
      const dialogId = params.dialogId ?? state.observed.get(session);
      if (typeof dialogId !== "string")
        throw new Error("Read the dialog with currentTab(), pageInfo(), or drainEvents() before answering it.");
      params = { ...params, dialogId };
    }
    const result = await call("command", handle, { method, params, sessionId: session, screenshot });
    if (method === "Page.handleJavaScriptDialog" && state.open.get(session)?.id === params.dialogId)
      noteDialog(state, session, null);
    return result;
  };
  const captureScreenshot = async path => {
    if (path !== undefined)
      throw Object.assign(new Error("Screenshots are returned in the tool output. Omit the file path."), { code: "unsupported-operation" });
    return command("Page.captureScreenshot", { format: "png" }, sessionId, true);
  };
  let readyForInput;
  const { page, fillInput, pressKey } = createPage({
    bind: async () => ({ sessionId, targetId }),
    command,
    enableInput: session => readyForInput ??= command("Page.enable", {}, session).catch(error => {
      readyForInput = undefined;
      throw error;
    }),
    watchDialog: binding => {
      let listener;
      const promise = new Promise(resolve => {
        listener = event => {
          if (event.method === "Page.javascriptDialogOpening" && event.sessionId === binding.sessionId)
            resolve(state.open.get(binding.sessionId));
        };
        state.listeners.add(listener);
      });
      return { promise, cancel: () => state.listeners.delete(listener) };
    },
    navigableUrl,
    parseUrl,
    screenshot: captureScreenshot,
  });
  const js = async (expression, target) => {
    if (target !== undefined) throw new TypeError("js() is bound to this page. Use openPage(tabId).js(expression) for another page.");
    return evaluationResult(await command("Runtime.evaluate", {
      expression: String(expression), returnByValue: true, awaitPromise: true,
    }));
  };
  const currentTab = async () => {
    const sequence = state.sequence.get(sessionId);
    const { targetInfo } = await command("Target.getTargetInfo", { targetId });
    if (!targetInfo) throw new Error("CDP did not return target information");
    if (state.sequence.get(sessionId) === sequence) noteDialog(state, sessionId, targetInfo.dialog);
    const { title = "", url = "", userActivity, pageResize } = targetInfo;
    const dialog = state.open.get(sessionId);
    return { tabId, title, url,
      ...(userActivity ? { userActivity } : {}),
      ...(pageResize ? { pageResize } : {}),
      ...(dialog ? { dialog } : {}),
    };
  };
  const pageInfo = async () => {
    const tab = await currentTab();
    if (tab.dialog) return tab;
    return {
      ...tab,
      ...await js("({url:location.href,title:document.title,w:innerWidth,h:innerHeight,sx:scrollX,sy:scrollY,pw:document.documentElement.scrollWidth,ph:document.documentElement.scrollHeight})"),
    };
  };
  const wait = async (predicate, timeout) => {
    const until = now() + timeout;
    while (now() < until) {
      if (await predicate()) return true;
      await sleep(100);
    }
    return false;
  };
  const waitForNetworkIdle = async ({ timeout = 10000, idleMs = 500 } = {}) => {
    for (const [name, value] of Object.entries({ timeout, idleMs })) {
      if (!Number.isInteger(value) || value < 1 || value > 300000)
        throw new TypeError(name + " must be an integer from 1 to 300000 ms");
    }
    const requests = new Set();
    let idleTimer, deadline, listener;
    try {
      return await new Promise((resolve, reject) => {
        const arm = () => {
          clearTimeout(idleTimer);
          if (!requests.size) idleTimer = setTimeout(() => resolve(true), idleMs);
        };
        listener = ({ method, params, sessionId: session }) => {
          if (!session) return;
          const { requestId, type } = params ?? {};
          const key = session + ":" + requestId;
          if (method === "Network.requestWillBeSent") {
            if (type !== "WebSocket" && type !== "EventSource") requests.add(key);
            else requests.delete(key);
          } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed" ||
            (method === "Network.responseReceived" && (type === "WebSocket" || type === "EventSource")))
            requests.delete(key);
          else return;
          arm();
        };
        state.listeners.add(listener);
        deadline = setTimeout(() => resolve(false), timeout);
        command("Network.enable").then(arm, reject);
      });
    } finally {
      state.listeners.delete(listener);
      clearTimeout(idleTimer);
      clearTimeout(deadline);
    }
  };
  state.page = Object.freeze({
    ...page, tabId, captureScreenshot,
    cdp: (method, params, session) => command(method, params, session),
    clickAt: (x, y, { button = "left", clicks = 1 } = {}) => page.mouse.click(x, y, { button, clickCount: clicks }),
    currentTab, ensureRealTab: currentTab, fillInput, js, pageInfo, pressKey,
    gotoUrl: url => command("Page.navigate", { url: navigableUrl(url) }),
    drainEvents: () => {
      const events = state.events.map(({ event }) => event);
      state.events.length = 0;
      state.bytes = 0;
      return events;
    },
    respondDialog: options => command("Page.handleJavaScriptDialog", options),
    scroll: (x, y, { deltaX = 0, deltaY = -300 } = {}) =>
      command("Input.dispatchMouseEvent", { deltaX, deltaY, type: "mouseWheel", x, y }),
    typeText: text => page.keyboard.insertText(text),
    waitForElement: (selector, { timeout = 10000 } = {}) =>
      wait(() => js("Boolean(document.querySelector(" + JSON.stringify(String(selector)) + "))"), timeout),
    waitForLoad: async ({ timeout = 15000 } = {}) => {
      if (await wait(async () => (await js("document.readyState")) === "complete", timeout)) return true;
      throw new Error("Page did not finish loading");
    },
    waitForNetworkIdle,
  });
  return state.page;
}

Object.assign(globalThis, {
  pages: () => call("pages"),
  openPage: async tabId => bindPage(await call("open", null, { tabId })),
  newPage: async (url, { profileId } = {}) =>
    bindPage(await call("new", null, { url: navigableUrl(url), profileId })),
  print,
  printImage: (data, mimeType = "image/png") => call("image", null, { data, mimeType }).then(() => undefined),
  sleep,
});
`;
