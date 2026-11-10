import { randomUUID } from "node:crypto";
import { open, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_BYTES = 432 * 1_024;
const ERRORS = new Set([
  "unsupported-operation",
  "target-suspended",
  "target-closed",
  "stale-document",
  "stale-geometry",
  "ambiguous",
  "not-found",
  "not-actionable",
  "dialog-open",
  "stale-dialog",
  "timeout",
  "forbidden",
  "too-large",
  "outcome-unknown",
]);
const READS = new Set([
  "session.tabs",
  "surface.attach",
  "page.info",
  "page.wait",
  "dom.snapshot",
  "dom.query",
  "dom.wait",
  "page.capture",
]);

export class BrowserActionError extends Error {
  constructor(code, message, dialog) {
    super(
      `${code}: ${message}${dialog ? " Answer with respondDialog({ accept: true or false })." : ""}`,
    );
    this.name = "BrowserActionError";
    this.code = code;
    if (dialog) this.dialog = dialog;
  }
}

function unsupported(
  operation,
  limit = "iPhone pages expose fixed actions, not page script, raw CDP, clipboard or emulation",
) {
  throw new BrowserActionError("unsupported-operation", `${operation}: ${limit}.`);
}

function optionsFor(options = {}, allowed = []) {
  if (!options || typeof options !== "object" || Array.isArray(options))
    throw new TypeError("Options must be an object");
  for (const key of Object.keys(options)) if (!allowed.includes(key)) unsupported(`Option ${key}`);
  return options;
}

function text(value, allowEmpty = false) {
  if (typeof value !== "string")
    unsupported(
      "Locator patterns",
      "only literal strings are supported; regular expressions and predicates are unavailable",
    );
  if (value.length > 4_096)
    throw new BrowserActionError("too-large", "Locator text exceeds 4096 characters");
  if (!allowEmpty && !value.length)
    unsupported("Locator", "an empty selector is not representable by the action wire");
  return value;
}

function inputText(value) {
  const result = String(value);
  if (result.length > 10_000)
    throw new BrowserActionError(
      "too-large",
      "Text insertion exceeds 10000 characters; split it explicitly",
    );
  return result;
}

function address(value) {
  const result = String(value);
  let parsed;
  try {
    parsed = new URL(result);
  } catch {
    unsupported("Navigation", "an absolute HTTP(S) URL is required");
  }
  if (
    result.length > 16_384 ||
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  )
    unsupported("Navigation", "HTTP(S) without credentials is required");
  return result;
}

function point(x, y) {
  if (![x, y].every((value) => Number.isFinite(value) && value >= 0 && value <= 32_768))
    throw new TypeError("Coordinates must be finite and between 0 and 32768");
  return { x, y };
}

function timeoutFor(options = {}) {
  const timeout = options.timeout ?? 10_000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30_000)
    unsupported(
      "timeout",
      "actions require a deadline from 1 to 30000 ms; unbounded waits are unavailable",
    );
  return timeout;
}

function subset(name, members) {
  return new Proxy(Object.freeze(members), {
    get(target, key) {
      if (key === "then" || typeof key === "symbol") return undefined;
      if (!Object.hasOwn(target, key)) unsupported(`${name}.${key}`);
      return target[key];
    },
  });
}

export async function negotiateBackend(base, sessionId) {
  const url = new URL(base);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = `${url.pathname.replace(/\/$/u, "")}/backend/${encodeURIComponent(sessionId)}`;
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!response.ok)
    throw new Error(`Browser backend negotiation refused (HTTP ${response.status}).`);
  const body = await response.text();
  if (Buffer.byteLength(body) > 1_024) throw new Error("Invalid browser backend negotiation");
  const backend = JSON.parse(body);
  if (
    backend.sessionId !== sessionId ||
    backend.version !== 1 ||
    !["cdp", "actions"].includes(backend.backend)
  )
    throw new Error("Invalid exact-session browser backend negotiation");
  return backend.backend;
}

export class ActionsClient {
  #socket;
  #sessionId;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Set();
  #events = [];
  #closed = false;

  constructor(socket, sessionId) {
    this.#socket = socket;
    this.#sessionId = sessionId;
    socket.addEventListener("message", ({ data }) => {
      try {
        this.#receive(data);
      } catch {
        this.#fail("Invalid browser actions response");
        socket.close();
      }
    });
    socket.addEventListener("close", ({ reason }) =>
      this.#fail(reason || "Browser actions connection closed"),
    );
    socket.addEventListener("error", () => this.#fail("Browser actions connection failed"));
  }

  static async connect(base, sessionId) {
    const url = new URL(base);
    url.pathname = `${url.pathname.replace(/\/$/u, "")}/actions/${encodeURIComponent(sessionId)}`;
    const socket = new WebSocket(url);
    const client = new ActionsClient(socket, sessionId);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("Browser actions connection timed out"));
      }, 15_000);
      const finish = (error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      socket.addEventListener("open", () => finish(), { once: true });
      socket.addEventListener(
        "error",
        () => finish(new Error("Could not connect to browser actions")),
        { once: true },
      );
      socket.addEventListener(
        "close",
        () => finish(new Error("Browser actions connection closed")),
        { once: true },
      );
    });
    return client;
  }

  request(binding, action, timeoutMs = 10_000) {
    if (this.#closed)
      throw new BrowserActionError("target-closed", "Browser actions connection is closed");
    if (this.#pending.size >= 64)
      throw new BrowserActionError("too-large", "Too many browser actions are pending");
    const id = this.#nextId++;
    const request = {
      id,
      sessionId: this.#sessionId,
      surfaceId: binding.surfaceId,
      timeoutMs,
      action,
      ...(!["session.tabs", "surface.open", "surface.attach", "surface.resume"].includes(
        action.type,
      )
        ? { documentId: binding.documentId }
        : {}),
      ...(["pointer.tap", "scroll"].includes(action.type) ||
      (action.type === "file.choose" && action.point)
        ? { geometryRevision: binding.geometryRevision }
        : {}),
    };
    const serialized = JSON.stringify(request);
    if (Buffer.byteLength(serialized) > MAX_BYTES)
      throw new BrowserActionError("too-large", "Browser action exceeds 432 KiB");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new BrowserActionError(
            READS.has(action.type) ? "timeout" : "outcome-unknown",
            `${action.type} did not answer; inspect the page, do not resend input`,
          ),
        );
      }, timeoutMs + 1_000);
      this.#pending.set(id, {
        resolve,
        reject,
        timer,
        type: action.type,
        surfaceId: binding.surfaceId,
      });
      try {
        this.#socket.send(serialized);
      } catch {
        this.#fail("Browser action submission failed");
      }
    });
  }

  onEvent(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  drainEvents() {
    return this.#events.splice(0);
  }
  close() {
    this.#fail("Browser actions connection closed");
    this.#socket.close();
  }

  #fail(message) {
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new BrowserActionError(
          READS.has(pending.type) ? "target-closed" : "outcome-unknown",
          message,
        ),
      );
    }
    this.#pending.clear();
  }

  #receive(raw) {
    if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_BYTES)
      throw new Error("Invalid action frame");
    const message = JSON.parse(raw);
    if (message.event && !Object.hasOwn(message, "id")) {
      if (!["surface.changed", "surface.closed", "dialog.changed"].includes(message.event.type))
        throw new Error("Invalid action event");
      if (this.#events.length === 500) this.#events.shift();
      this.#events.push(message.event);
      for (const listener of this.#listeners) listener(message.event);
      if (message.event.type === "dialog.changed" && message.event.dialog) {
        for (const [id, pending] of this.#pending) {
          if (
            pending.surfaceId !== message.event.surfaceId ||
            READS.has(pending.type) ||
            pending.type === "dialog.respond"
          )
            continue;
          clearTimeout(pending.timer);
          this.#pending.delete(id);
          pending.reject(
            new BrowserActionError(
              "dialog-open",
              "A dialog opened; the input outcome is not verified. Inspect after answering it",
              message.event.dialog,
            ),
          );
        }
      }
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    if (
      message.error
        ? !ERRORS.has(message.error.code) || typeof message.error.message !== "string"
        : message.result?.type !== pending.type
    )
      throw new Error("Invalid action response");
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error)
      pending.reject(
        new BrowserActionError(message.error.code, message.error.message, message.error.dialog),
      );
    else pending.resolve(message.result);
  }
}

export function createActionsHarness(client, initialTargetId) {
  let selected = initialTargetId;
  const bindings = new Map();
  const closed = new Set();
  const dialogs = new Map();
  let inventory;
  const publicTab = (binding) => ({ ...binding, targetId: binding.surfaceId });
  client.onEvent((event) => {
    if (event.type === "surface.closed") {
      closed.add(event.surfaceId);
      bindings.delete(event.surfaceId);
    }
    if (event.type === "dialog.changed") dialogs.set(event.surfaceId, event.dialog);
  });
  const listTabs = async () => {
    const result = await client.request({}, { type: "session.tabs" });
    inventory = result.tabs;
    for (const binding of inventory) bindings.set(binding.surfaceId, binding);
    return inventory.map(publicTab);
  };
  const bind = async () => {
    if (closed.has(selected))
      throw new BrowserActionError(
        "target-closed",
        "The selected tab closed; choose an exact tab with switchTab",
      );
    if (!selected) {
      await listTabs();
      if (inventory.length !== 1)
        throw new Error(
          "Choose an exact tab with --tab or switchTab(targetId); listTabs() shows the tabs",
        );
      selected = inventory[0].surfaceId;
    }
    if (!bindings.has(selected)) {
      const result = await client.request({ surfaceId: selected }, { type: "surface.attach" });
      bindings.set(selected, result.binding);
    }
    return bindings.get(selected);
  };
  const sendOn = async (binding, action, options = {}) => {
    try {
      const result = await client.request(binding, action, timeoutFor(options));
      if (result.binding) bindings.set(result.binding.surfaceId, result.binding);
      if (action.type === "page.info") dialogs.set(binding.surfaceId, result.dialog);
      return result;
    } catch (error) {
      if (error.dialog) dialogs.set(binding.surfaceId, error.dialog);
      if (["stale-document", "stale-geometry"].includes(error.code)) {
        const fresh = await client
          .request({ surfaceId: binding.surfaceId }, { type: "surface.attach" })
          .catch(() => null);
        if (fresh) bindings.set(binding.surfaceId, fresh.binding);
        else bindings.delete(binding.surfaceId);
      }
      throw error;
    }
  };
  const send = async (action, options = {}) => sendOn(await bind(), action, options);
  const pageInfo = async () => {
    const info = await send({ type: "page.info" });
    return {
      ...publicTab(info.binding),
      loading: info.loading,
      navigationFailed: info.navigationFailed,
      sizedByAgent: info.sizedByAgent,
      dialog: info.dialog,
    };
  };
  const pressKey = (key, options = {}) => {
    optionsFor(options);
    if (!["Enter", "Backspace"].includes(key))
      unsupported(
        `Key ${key}`,
        "only Enter and Backspace exist; native text insertion has no keydown/up, modifiers, Tab, arrows or paste",
      );
    return send({ type: "text.key", key });
  };
  const typeText = (value) => send({ type: "text.insert", text: inputText(value) });
  const focusThen = async (description, action, options, selection) => {
    optionsFor(options, ["timeout"]);
    const binding = await bind();
    await sendOn(
      binding,
      { type: "dom.act", locator: description, kind: "focus", ...(selection ? { selection } : {}) },
      options,
    );
    await sendOn(binding, action, options);
  };
  const selectors = (scope) => ({
    locator: (value) => locator({ by: "css", value: text(value), ...(scope ? { scope } : {}) }),
    getByRole: (value, options = {}) => {
      optionsFor(options, ["name", "exact"]);
      if (options.exact !== undefined && typeof options.exact !== "boolean")
        throw new TypeError("exact must be boolean");
      return locator({
        by: "role",
        value: text(value),
        ...(options.name !== undefined ? { name: text(options.name, true) } : {}),
        ...(options.exact !== undefined ? { exact: options.exact } : {}),
        ...(scope ? { scope } : {}),
      });
    },
    getByText: (value, options = {}) => byText("text", value, options, scope),
    getByLabel: (value, options = {}) => byText("label", value, options, scope),
  });
  const byText = (by, value, options, scope) => {
    optionsFor(options, ["exact"]);
    if (options.exact !== undefined && typeof options.exact !== "boolean")
      throw new TypeError("exact must be boolean");
    return locator({ by, value: text(value), ...options, ...(scope ? { scope } : {}) });
  };
  const locator = (description) => {
    let depth = 0;
    for (let current = description; current; current = current.scope)
      if (++depth > 8) unsupported("Locator scoping", "at most eight locator levels are supported");
    const refine = (fields) => {
      if (
        description.position !== undefined &&
        Object.keys(fields).some((key) => key !== "position")
      )
        unsupported(
          "Filtering after a position",
          "the action wire applies filters before first/last/nth; filter before choosing a position",
        );
      if (Object.keys(fields).some((key) => Object.hasOwn(description, key)))
        unsupported(
          "Repeated locator narrowing",
          "the action wire supports one position and one of each filter per scope; combine filters before choosing a position",
        );
      return locator({ ...description, ...fields });
    };
    const read = async (kind, attribute) =>
      (
        await send({
          type: "dom.query",
          locator: description,
          read: kind,
          ...(attribute === undefined ? {} : { attribute }),
        })
      ).value;
    const act = async (kind, fields = {}, options = {}) => {
      optionsFor(options, kind === "click" ? ["timeout", "button", "clickCount"] : ["timeout"]);
      if (options.button && options.button !== "left")
        unsupported("click button", "only left taps are supported");
      if (options.clickCount !== undefined && ![1, 2].includes(options.clickCount))
        unsupported("clickCount", "only single and double taps are supported");
      const result = await send(
        {
          type: "dom.act",
          locator: description,
          kind,
          ...fields,
          ...(options.button ? { button: options.button } : {}),
          ...(options.clickCount ? { clickCount: options.clickCount } : {}),
        },
        options,
      );
      return kind === "selectOption" ? result.values : undefined;
    };
    return subset("locator", {
      ...selectors(description),
      first: () => refine({ position: "first" }),
      last: () => refine({ position: "last" }),
      nth: (position) => {
        if (!Number.isInteger(position) || position < 0 || position > 10_000)
          throw new TypeError("nth requires an index from 0 to 10000");
        return refine({ position });
      },
      filter: (options) => {
        optionsFor(options, ["hasText", "hasNotText", "visible"]);
        for (const key of ["hasText", "hasNotText"])
          if (options[key] !== undefined) text(options[key], true);
        if (options.visible !== undefined && typeof options.visible !== "boolean")
          throw new TypeError("visible must be boolean");
        return refine(options);
      },
      count: () => read("count"),
      textContent: () => read("textContent"),
      innerText: () => read("innerText"),
      allInnerTexts: () => read("allInnerTexts"),
      inputValue: () => read("inputValue"),
      getAttribute: (attribute) => {
        if (typeof attribute !== "string" || !attribute.length || attribute.length > 255)
          throw new TypeError("Attribute name must contain 1 to 255 characters");
        return read("attribute", attribute);
      },
      isVisible: () => read("visible"),
      isChecked: () => read("checked"),
      isEnabled: () => read("enabled"),
      click: (options) => act("click", {}, options),
      dblclick: (options = {}) => act("click", {}, { ...options, clickCount: 2 }),
      fill: (value, options) => act("fill", { value: inputText(value) }, options),
      clear: (options) => act("clear", {}, options),
      focus: (options) => act("focus", {}, options),
      check: (options) => act("check", {}, options),
      uncheck: (options) => act("uncheck", {}, options),
      setChecked: (value, options) => {
        if (typeof value !== "boolean") throw new TypeError("setChecked requires a boolean");
        return act("setChecked", { value }, options);
      },
      selectOption: (values, options) => {
        const list = Array.isArray(values) ? values : [values];
        if (list.some((value) => typeof value !== "string"))
          unsupported(
            "selectOption",
            "only option value strings are supported, not labels or indices",
          );
        if (list.length > 100)
          throw new BrowserActionError("too-large", "selectOption accepts at most 100 values");
        list.forEach(inputText);
        return act("selectOption", { values: list }, options);
      },
      press: (key, options = {}) => {
        optionsFor(options, ["timeout"]);
        if (!["Enter", "Backspace"].includes(key))
          unsupported(
            "locator.press",
            "only Enter and Backspace exist; no modifiers, Tab, arrows or paste",
          );
        return focusThen(description, { type: "text.key", key }, options);
      },
      waitFor: async (options = {}) => {
        optionsFor(options, ["state", "timeout"]);
        await send(
          {
            type: "dom.wait",
            locator: description,
            state: options.state ?? "visible",
            timeout: timeoutFor(options),
          },
          options,
        );
      },
      ariaSnapshot: async () => (await send({ type: "dom.snapshot", scope: description })).text,
      evaluate: () => unsupported("locator.evaluate"),
    });
  };
  const captureScreenshot = async (
    outputPath = path.join(process.env.OPENSTEER_AGENT_WORKSPACE ?? ".", "browser-screenshot.png"),
    options = {},
  ) => {
    optionsFor(options, ["format", "quality", "clip"]);
    const result = await send({
      type: "page.capture",
      format: options.format ?? "png",
      ...options,
    });
    const resolved = path.resolve(outputPath);
    await writeFile(resolved, Buffer.from(result.data, "base64"));
    if (
      result.clip ||
      result.width !== result.viewport.width ||
      result.height !== result.viewport.height
    ) {
      process.stderr.write(
        `[opensteer] Capture metadata (input uses viewport points): ${JSON.stringify({ viewport: result.viewport, width: result.width, height: result.height, clip: result.clip })}\n`,
      );
    }
    return resolved;
  };
  const clickAt = (x, y, options = {}) => {
    optionsFor(options, ["button", "clicks"]);
    if (options.button && options.button !== "left")
      unsupported("clickAt", "only left taps are supported");
    if (options.clicks !== undefined && ![1, 2].includes(options.clicks))
      unsupported("clicks", "only single and double taps are supported");
    return send({ type: "pointer.tap", ...point(x, y), count: options.clicks ?? 1 });
  };
  const waitForLoad = async (options = {}) => {
    optionsFor(options, ["timeout"]);
    await send({ type: "page.wait", loadState: "load", timeout: timeoutFor(options) }, options);
    return true;
  };
  const gotoUrl = (url) => send({ type: "page.navigate", url: address(url) });
  const page = subset("page", {
    ...selectors(),
    keyboard: subset("page.keyboard", { press: pressKey, type: typeText, insertText: typeText }),
    mouse: subset("page.mouse", {
      click: (x, y, options = {}) => {
        optionsFor(options, ["button", "clickCount"]);
        return clickAt(x, y, {
          ...(options.button ? { button: options.button } : {}),
          clicks: options.clickCount ?? 1,
        });
      },
    }),
    goto: async (url, options = {}) => {
      optionsFor(options, ["timeout"]);
      await send({ type: "page.navigate", url: address(url) }, options);
      await waitForLoad(options);
      return null;
    },
    url: async () => (await pageInfo()).url,
    title: async () => (await pageInfo()).title,
    waitForURL: async (url, options = {}) => {
      optionsFor(options, ["timeout"]);
      if (typeof url !== "string")
        unsupported(
          "waitForURL",
          "only an exact literal HTTP(S) URL is supported, not a regex or predicate",
        );
      await send({ type: "page.wait", url: address(url), timeout: timeoutFor(options) }, options);
    },
    waitForFunction: () => unsupported("page.waitForFunction"),
    evaluate: () => unsupported("page.evaluate"),
    waitForTimeout: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    screenshot: (options = {}) => {
      optionsFor(options, ["path"]);
      return captureScreenshot(options.path);
    },
    ariaSnapshot: async () => (await send({ type: "dom.snapshot" })).text,
  });
  const stageFiles = async (paths) => {
    const list = Array.isArray(paths) ? paths : [paths];
    if (!list.length || list.length > 256)
      throw new TypeError("stageFiles requires between 1 and 256 files");
    const files = [];
    for (const local of list) {
      const info = await stat(local);
      if (!info.isFile() || info.size > 512 * 1_024 * 1_024)
        throw new Error("Staging requires a regular file no larger than 512 MiB");
      const fileId = randomUUID();
      const handle = await open(local, "r");
      try {
        const buffer = Buffer.alloc(256 * 1_024);
        let offset = 0;
        for (;;) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
          const last = offset + bytesRead >= info.size;
          const result = await send({
            type: "file.stage",
            data: buffer.subarray(0, bytesRead).toString("base64"),
            fileId,
            name: path.basename(local),
            offset,
            ...(last ? { size: offset + bytesRead } : {}),
          });
          if (result.fileId !== fileId || result.complete !== last)
            throw new Error("File staging receipt does not match the submitted chunk");
          offset += bytesRead;
          if (last) break;
          if (!bytesRead) throw new Error("File changed during staging");
        }
      } finally {
        await handle.close();
      }
      files.push(`staged:${fileId}`);
    }
    return files;
  };
  return Object.freeze({
    page,
    listTabs,
    pageInfo,
    currentTab: pageInfo,
    ensureRealTab: pageInfo,
    attach: bind,
    detach: async () => {},
    drainEvents: () => client.drainEvents(),
    switchTab: async (target) => {
      const surfaceId = typeof target === "string" ? target : target.targetId;
      await listTabs();
      const known = bindings.get(surfaceId);
      if (!known || closed.has(surfaceId))
        throw new BrowserActionError("target-closed", "That exact tab is no longer in the session");
      const result = await client.request(
        { surfaceId },
        { type: known.state === "suspended" ? "surface.resume" : "surface.attach" },
      );
      bindings.set(surfaceId, result.binding);
      selected = surfaceId;
      return publicTab(result.binding);
    },
    newTab: async (url = "about:blank") => {
      const result = await client.request(
        {},
        {
          type: "surface.open",
          ...(url === "about:blank" ? {} : { url: address(url) }),
        },
      );
      bindings.set(result.binding.surfaceId, result.binding);
      selected = result.binding.surfaceId;
      return selected;
    },
    closeTab: async (target) => {
      const binding = target
        ? bindings.get(typeof target === "string" ? target : target.targetId)
        : await bind();
      if (!binding)
        throw new BrowserActionError("target-closed", "Read listTabs before closing that tab");
      const result = await sendOn(binding, { type: "surface.close" });
      bindings.delete(binding.surfaceId);
      closed.add(binding.surfaceId);
      return { success: result.outcome === "closed" || result.outcome === "already-closed" };
    },
    gotoUrl,
    typeText,
    pressKey,
    clickAt,
    waitForLoad,
    captureScreenshot,
    stageFiles,
    fillInput: (selector, value, options = {}) => {
      optionsFor(options, ["clear", "timeout"]);
      if (options.clear === false)
        return focusThen(
          { by: "css", value: text(selector), position: "first" },
          { type: "text.insert", text: inputText(value) },
          options.timeout ? { timeout: options.timeout } : {},
          "end",
        );
      return page
        .locator(selector)
        .first()
        .fill(value, options.timeout ? { timeout: options.timeout } : {});
    },
    scroll: (x, y, options = {}) => {
      optionsFor(options, ["deltaX", "deltaY"]);
      const deltaX = options.deltaX ?? 0,
        deltaY = options.deltaY ?? -300;
      if (![deltaX, deltaY].every((value) => Number.isFinite(value) && Math.abs(value) <= 100_000))
        throw new TypeError("Scroll deltas must be finite and within 100000");
      return send({ type: "scroll", ...point(x, y), deltaX, deltaY });
    },
    waitForElement: async (selector, options = {}) => {
      try {
        await page.locator(selector).waitFor({ ...options, state: "attached" });
        return true;
      } catch (error) {
        if (error.code === "timeout") return false;
        throw error;
      }
    },
    setInputFiles: async (target, paths) => {
      const list = Array.isArray(paths) ? paths : [paths];
      if (!list.length || list.length > 256)
        throw new TypeError("setInputFiles requires between 1 and 256 files");
      const handles = list.every((file) => typeof file === "string" && file.startsWith("staged:"))
        ? list
        : await stageFiles(list);
      const stagedFileIds = handles.map((handle) => handle.slice("staged:".length));
      if (stagedFileIds.some((id) => !/^[A-Za-z0-9_-]{1,64}$/u.test(id)))
        throw new TypeError("Invalid staged file handle");
      return send({
        type: "file.choose",
        ...(typeof target === "string"
          ? { locator: { by: "css", value: text(target) } }
          : { point: point(target?.x, target?.y) }),
        stagedFileIds,
      });
    },
    respondDialog: async (options) => {
      optionsFor(options, ["accept", "promptText", "dialogId"]);
      if (typeof options.accept !== "boolean")
        throw new TypeError("respondDialog requires accept: true or false");
      const binding = await bind();
      const dialogId = options.dialogId ?? dialogs.get(binding.surfaceId)?.id;
      if (!dialogId)
        throw new BrowserActionError("stale-dialog", "No observed dialog; read pageInfo first");
      await send({
        type: "dialog.respond",
        dialogId,
        accept: options.accept,
        ...(options.promptText !== undefined ? { promptText: inputText(options.promptText) } : {}),
      });
    },
    cdp: () => unsupported("cdp()"),
    js: () => unsupported("js()"),
    fillLogin: () =>
      unsupported("fillLogin", "saved passwords require the main computer's browser"),
    fillCard: () => unsupported("fillCard", "saved cards require the main computer's browser"),
    sleep: page.waitForTimeout,
  });
}
