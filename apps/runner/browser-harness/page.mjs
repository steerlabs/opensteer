import { pageFunction } from "./page-functions.mjs";
import { USKeyboardLayout, macEditingCommands } from "./keyboard-layout.mjs";

const DEFAULT_TIMEOUT = 10_000;
const MODIFIERS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const BACKOFF = [0, 20, 100, 100, 500];
// A pressed button or key is always released, even past the action's timeout:
// on the desktop the person shares the page and would inherit it held down.
const RELEASE_GRACE = 2_000;
/** How long the CDP client waits for any command's reply. */
export const COMMAND_TIMEOUT = 30_000;
let nextOperation = 0;

class RetryError extends Error {}
class DeadlineError extends Error {}
export class CdpProtocolError extends Error {}

export class DialogOpenedError extends Error {
  constructor(dialog) {
    super(
      `A ${dialog.type} dialog opened: ${JSON.stringify(dialog.message)}. Action outcome is not verified; answer with cdp("Page.handleJavaScriptDialog", { accept: true or false }).`,
    );
    this.name = "DialogOpenedError";
    this.dialog = dialog;
  }
}

export function evaluationResult(response) {
  if (response.exceptionDetails) {
    const details = response.exceptionDetails;
    const stack = details.stackTrace?.callFrames
      ?.map(
        (frame) =>
          `    at ${frame.functionName || "<anonymous>"} (${frame.url || "<page>"}:${frame.lineNumber + 1}:${frame.columnNumber + 1})`,
      )
      .join("\n");
    throw new Error(
      details.exception?.description ||
        [details.text || "JavaScript evaluation failed", stack].filter(Boolean).join("\n"),
    );
  }
  return Object.hasOwn(response.result ?? {}, "value")
    ? response.result.value
    : response.result?.unserializableValue;
}

function subset(name, members, alternative = "Use the supported locators, evaluate() or cdp().") {
  return new Proxy(Object.freeze(members), {
    get(target, key, receiver) {
      if (key === "then" || typeof key === "symbol") return undefined;
      if (Object.hasOwn(target, key)) return Reflect.get(target, key, receiver);
      throw new TypeError(
        `${name}.${key} is not supported. ${alternative} Supported: ${Object.keys(target).join(", ")}.`,
      );
    },
  });
}

function optionsFor(options = {}, allowed) {
  if (!options || typeof options !== "object" || Array.isArray(options))
    throw new TypeError("Options must be an object");
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key))
      throw new TypeError(
        `Option ${JSON.stringify(key)} is not supported. Supported: ${allowed.join(", ") || "none"}. Use evaluate() or cdp() for other behavior.`,
      );
  }
  if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout < 0))
    throw new TypeError("timeout must be a non-negative number");
  return options;
}

const pattern = (value) =>
  value instanceof RegExp ? { regex: value.source, flags: value.flags } : String(value);
const display = (value) => (value instanceof RegExp ? String(value) : JSON.stringify(value));
const match = (value, expected, exact = false) =>
  expected instanceof RegExp
    ? new RegExp(expected.source, expected.flags).test(value)
    : exact
      ? value === String(expected)
      : value.toLowerCase().includes(String(expected).toLowerCase());

class Operation {
  constructor(environment, label, timeout = DEFAULT_TIMEOUT, releases = new Set()) {
    this.environment = environment;
    this.releases = releases;
    this.label = label;
    this.timeout = timeout;
    this.deadline = performance.now() + timeout;
    this.group = `opensteer-op-${++nextOperation}`;
    // After input or an agent's own page function runs, a retry could repeat its effect.
    this.committed = false;
    this.dispatched = false;
    // Commands this action left unanswered past its time, each with how long it may still answer.
    this.unanswered = [];
    this.attempt = 0;
    this.reason = undefined;
    this.names = [];
    this.evidence = { hostTimedSampling: true, samples: 0 };
  }

  async race(promise) {
    const remaining = this.deadline - performance.now();
    if (remaining <= 0) {
      Promise.resolve(promise).catch(() => undefined);
      throw new DeadlineError("deadline exceeded");
    }
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new DeadlineError("deadline exceeded")), remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async start() {
    this.binding = await this.race(this.environment.bind());
  }

  async command(method, params = {}) {
    if (performance.now() >= this.deadline) throw new DeadlineError("deadline exceeded");
    return this.reply(method, this.environment.command(method, params, this.binding.sessionId));
  }

  /** Awaits a sent command within the deadline, noting a reply still owed when it passes. */
  async reply(method, pending) {
    try {
      return await this.race(this.dialog ? Promise.race([pending, this.dialog]) : pending);
    } catch (error) {
      if (error instanceof DeadlineError) {
        // A round trip in flight at the deadline is not yet a stalled page: it
        // gets the release grace past the deadline to answer.
        this.leftUnanswered(pending, this.deadline + RELEASE_GRACE);
        this.waitingFor = `waiting for CDP ${method}`;
      }
      throw error;
    }
  }

  leftUnanswered(pending, until) {
    const owed = { open: true, until };
    owed.answered = Promise.resolve(pending).then(
      () => (owed.open = false),
      () => (owed.open = false),
    );
    this.unanswered.push(owed);
  }

  async document() {
    const response = await this.command("Runtime.evaluate", {
      expression: "document",
      objectGroup: this.group,
    });
    evaluationResult(response);
    if (!response.result?.objectId) throw new RetryError("document is not available");
    return response.result.objectId;
  }

  async call(objectId, command, data = {}, objects = [], byValue = true) {
    const response = await this.command("Runtime.callFunctionOn", {
      objectId,
      objectGroup: this.group,
      functionDeclaration: pageFunction.toString(),
      arguments: [{ value: command }, { value: data }, ...objects.map((id) => ({ objectId: id }))],
      returnByValue: byValue,
      awaitPromise: true,
      userGesture: true,
    });
    const value = evaluationResult(response);
    if (value?.retry) throw new RetryError(value.retry);
    return byValue ? value : response.result?.objectId;
  }

  async elements(objectId) {
    if (!objectId) return [];
    const response = await this.command("Runtime.getProperties", { objectId, ownProperties: true });
    return response.result
      .filter((property) => /^\d+$/u.test(property.name) && property.value?.objectId)
      .sort((a, b) => Number(a.name) - Number(b.name))
      .map((property) => property.value.objectId);
  }

  async queryAX(objectId, filters = {}) {
    try {
      return (
        (await this.command("Accessibility.queryAXTree", { objectId, ...filters })).nodes ?? []
      );
    } catch (error) {
      if (/too large|size|exceeds|bounded.*transport/iu.test(error.message)) {
        throw new Error(
          `${this.label}: Chromium AX response exceeds the router's 432 KiB limit. Use a CSS scope, e.g. page.locator('#dialog').getByRole(...), or scope ariaSnapshot() to a smaller locator.`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async resolve(steps) {
    this.doc = await this.document();
    let scopes = [this.doc];
    this.names = [];
    this.roleDiagnostics = undefined;
    for (const step of steps) {
      if (step.kind === "nth") {
        const index = step.index < 0 ? scopes.length + step.index : step.index;
        scopes = scopes[index] ? [scopes[index]] : [];
      } else if (step.kind === "filter") {
        scopes = await this.elements(await this.call(this.doc, "filter", step, scopes, false));
      } else if (step.kind !== "role") {
        scopes = await this.elements(await this.call(this.doc, "resolve", step, scopes, false));
      } else {
        const candidates = [];
        const backendIds = new Set();
        this.roleDiagnostics =
          step.exact && typeof step.name === "string" ? { scopes, role: step.role } : undefined;
        for (const scope of scopes) {
          const roles = { img: "image", presentation: "none" };
          const nodes = await this.queryAX(scope, {
            role: roles[step.role] ?? step.role,
            ...(step.exact && typeof step.name === "string" ? { accessibleName: step.name } : {}),
          });
          for (const node of nodes) {
            if (node.ignored && !step.includeHidden) continue;
            const name = node.name?.value ?? "";
            this.names.push(name);
            if (step.name !== undefined && !match(name, step.name, step.exact)) continue;
            const checked = node.properties?.find((property) => property.name === "checked")?.value
              ?.value;
            const state =
              checked === true || checked === "true"
                ? true
                : checked === false || checked === "false"
                  ? false
                  : undefined;
            if (step.checked !== undefined && state !== step.checked) continue;
            if (!node.backendDOMNodeId || backendIds.has(node.backendDOMNodeId)) continue;
            backendIds.add(node.backendDOMNodeId);
            const resolved = await this.command("DOM.resolveNode", {
              backendNodeId: node.backendDOMNodeId,
              objectGroup: this.group,
            });
            if (resolved.object?.objectId) candidates.push(resolved.object.objectId);
          }
        }
        scopes = await this.elements(
          await this.call(
            this.doc,
            "validate",
            { scopes: scopes.length },
            [...scopes, ...candidates],
            false,
          ),
        );
      }
    }
    return scopes;
  }

  async strict(elements, allowMissing = false) {
    if (elements.length > 1) {
      const descriptions = await this.call(this.doc, "describe", {}, elements);
      throw new Error(
        `Strict mode violation: ${elements.length} elements: ${descriptions.join("; ")}`,
      );
    }
    if (!elements.length && !allowMissing) {
      if (!this.names.length && this.roleDiagnostics) {
        for (const scope of this.roleDiagnostics.scopes) {
          const nodes = await this.queryAX(scope, { role: this.roleDiagnostics.role });
          this.names.push(
            ...nodes.filter((node) => !node.ignored).map((node) => node.name?.value ?? ""),
          );
        }
      }
      throw new RetryError(
        `element was not found${this.names.length ? `; available accessible names: ${[...new Set(this.names)].slice(0, 20).map(display).join(", ")}` : ""}`,
      );
    }
    return elements[0];
  }

  async prepareInput() {
    if (this.dialog) return;
    await this.reply("Page.enable", this.environment.enableInput(this.binding.sessionId));
    const watcher = this.environment.watchDialog(this.binding);
    this.cancelDialog = watcher.cancel;
    this.dialog = watcher.promise.then((dialog) => {
      this.dialogError = new DialogOpenedError(dialog);
      throw this.dialogError;
    });
    this.dialog.catch(() => undefined);
  }

  /** Sends input within the deadline; `sent` tells a caller whether it left the harness. */
  async input(method, parameters, dispatch = true, sent = {}) {
    await this.prepareInput();
    if (this.dialogError) throw this.dialogError;
    if (performance.now() >= this.deadline) throw new DeadlineError("deadline exceeded");
    if (dispatch) this.committed = this.dispatched = true;
    const pending = this.environment.command(method, parameters, this.binding.sessionId);
    sent.value = true;
    return this.reply(method, pending);
  }

  /** Whether the document this attempt resolved against is gone, as after a navigation. */
  async documentLost() {
    if (!this.doc) return true;
    const probe = this.environment.command(
      "Runtime.callFunctionOn",
      { objectId: this.doc, functionDeclaration: "function() { return 1; }" },
      this.binding.sessionId,
    );
    try {
      await this.reply("Runtime.callFunctionOn", probe);
      return false;
    } catch (error) {
      // A dialog blocking the probe is not evidence of navigation.
      if (error instanceof DeadlineError || error instanceof DialogOpenedError) throw error;
      return true;
    }
  }

  /** Releases what a sent press holds; returns the failure instead of throwing it. */
  async release(method, parameters) {
    const command = this.environment.command(method, parameters, this.binding.sessionId);
    command.catch(() => undefined);
    // Under a dialog the page answers nothing; the release lands once it is answered.
    // Such a release gets its one grace when its session leaves, not now.
    if (!this.dialogError)
      // Every release in this operation shares one grace past its deadline.
      this.releaseDeadline ??= Math.max(performance.now(), this.deadline) + RELEASE_GRACE;
    const entry = {
      command,
      sessionId: this.binding.sessionId,
      operation: this,
      sentAt: performance.now(),
    };
    this.releases.add(entry);
    command.finally(() => this.releases.delete(entry)).catch(() => undefined);
    if (this.dialogError) return this.dialogError;
    const remaining = this.releaseDeadline - performance.now();
    if (remaining <= 0) {
      // This release's grace has already passed.
      this.leftUnanswered(command, this.releaseDeadline);
      return new DeadlineError("the input release was not acknowledged");
    }
    let timer;
    try {
      await Promise.race([
        command,
        ...(this.dialog ? [this.dialog] : []),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new DeadlineError("the input release was not acknowledged")),
            remaining,
          );
        }),
      ]);
    } catch (error) {
      if (error instanceof DeadlineError) {
        this.leftUnanswered(command, this.releaseDeadline);
        this.waitingFor = `waiting for CDP ${method} release`;
      }
      return error;
    } finally {
      clearTimeout(timer);
    }
  }

  async pause(milliseconds) {
    let timer;
    try {
      await this.race(
        new Promise((resolve) => {
          timer = setTimeout(resolve, milliseconds);
        }),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async run(action) {
    try {
      await this.start();
      for (;;) {
        try {
          return await action(this);
        } catch (error) {
          if (error instanceof DeadlineError || this.committed) throw error;
          if (
            !(error instanceof RetryError) &&
            !(error instanceof CdpProtocolError && (await this.documentLost()))
          )
            throw error;
          this.reason = error.message;
          await this.pause(BACKOFF[Math.min(this.attempt++, BACKOFF.length - 1)]);
        }
      }
    } catch (error) {
      if (error instanceof DialogOpenedError) {
        error.evidence = this.evidence;
        throw error;
      }
      const reason =
        error instanceof DeadlineError
          ? [this.reason, this.waitingFor].filter(Boolean).join("; ") ||
            "browser operation did not finish"
          : error.message;
      const failed = new Error(
        `${this.label}: ${error instanceof DeadlineError ? `Timeout ${this.timeout}ms: ` : ""}${reason}${this.dispatched ? "; outcome unknown after input was dispatched; action was not replayed" : ""}`,
        { cause: error },
      );
      failed.evidence = this.evidence;
      throw failed;
    } finally {
      this.cancelDialog?.();
      if (this.binding) {
        const release = this.environment.command(
          "Runtime.releaseObjectGroup",
          { objectGroup: this.group },
          this.binding.sessionId,
        );
        release.catch(() => undefined);
        // Tracked until it settles, whatever happens to the wait below, so the
        // session waits for it before it detaches.
        const entry = {
          command: release,
          sessionId: this.binding.sessionId,
          operation: this,
          sentAt: performance.now(),
        };
        this.releases.add(entry);
        release.finally(() => this.releases.delete(entry)).catch(() => undefined);
        if (!this.dialogError && performance.now() < this.deadline)
          await this.race(release).catch(() => undefined);
      }
    }
  }
}

const layout = new Map();
for (const [code, definition] of Object.entries(USKeyboardLayout)) {
  const description = {
    code,
    key: definition.key,
    windowsVirtualKeyCode: definition.keyCodeWithoutLocation ?? definition.keyCode,
    text: definition.text ?? (definition.key.length === 1 ? definition.key : ""),
    location: definition.location ?? 0,
  };
  const shifted = definition.shiftKey
    ? {
        ...description,
        key: definition.shiftKey,
        text: definition.shiftKey,
        windowsVirtualKeyCode: definition.shiftKeyCode ?? description.windowsVirtualKeyCode,
      }
    : undefined;
  layout.set(code, { ...description, shifted });
  if (!definition.location && definition.key.length === 1)
    layout.set(definition.key, { ...description, shifted });
  if (!definition.location && shifted) layout.set(shifted.key, shifted);
}
for (const [key, code] of Object.entries({
  Shift: "ShiftLeft",
  Control: "ControlLeft",
  Alt: "AltLeft",
  Meta: "MetaLeft",
  "\n": "Enter",
  "\r": "Enter",
}))
  layout.set(key, layout.get(code));

function keyDescription(key, mask) {
  const definition = layout.get(key);
  if (!definition) {
    const suggestion = [...layout.keys()].find(
      (candidate) => candidate.toLowerCase() === key.toLowerCase(),
    );
    throw new TypeError(
      `Unknown key ${JSON.stringify(key)}.${suggestion ? ` Did you mean ${JSON.stringify(suggestion)}?` : " Use keyboard.insertText() for arbitrary text."}`,
    );
  }
  const { shifted: _shifted, ...description } =
    mask & MODIFIERS.Shift && definition.shifted ? definition.shifted : definition;
  if (mask & (MODIFIERS.Alt | MODIFIERS.Control | MODIFIERS.Meta)) description.text = "";
  return { ...description, isKeypad: description.location === 3 };
}

/** A dialog the input opened outranks an earlier failure, which it keeps as its cause. */
function terminalError(operation, failure) {
  if (!operation.dialogError) return failure;
  if (failure && failure !== operation.dialogError) operation.dialogError.cause ??= failure;
  return operation.dialogError;
}

export function createPage(environment) {
  let browserMac;
  let versionLookup;
  const isMac = async (operation) => {
    if (browserMac !== undefined) return browserMac;
    versionLookup ??= environment.command("Browser.getVersion").then(
      (version) => (browserMac = /Macintosh|Mac OS X/iu.test(version.userAgent ?? "")),
      (error) => {
        versionLookup = undefined;
        throw error;
      },
    );
    return operation.race(versionLookup);
  };
  const smartModifier = (key, mac) => (key === "ControlOrMeta" ? (mac ? "Meta" : "Control") : key);
  const modifierMask = (modifiers, mac) => {
    if (!Array.isArray(modifiers))
      throw new TypeError(
        "modifiers must be an array of Alt, Control, Meta, Shift or ControlOrMeta",
      );
    let mask = 0;
    for (const modifier of modifiers) {
      const key = smartModifier(modifier, mac);
      if (!Object.hasOwn(MODIFIERS, key))
        throw new TypeError(`Unknown modifier ${display(modifier)}`);
      mask |= MODIFIERS[key];
    }
    return mask;
  };
  const press = async (operation, shortcut, legacyMask = 0, explicitCommands) => {
    if (typeof shortcut !== "string" || !shortcut)
      throw new TypeError("press() requires a key name");
    if (
      explicitCommands !== undefined &&
      (!Array.isArray(explicitCommands) ||
        !explicitCommands.every((command) => typeof command === "string"))
    )
      throw new TypeError("commands must be an array of editing command names");
    const mac = await isMac(operation);
    const parts = shortcut.split(/\+(?!$)/u).map((key) => smartModifier(key, mac));
    const key = parts.pop();
    modifierMask(parts, mac);
    keyDescription(key, legacyMask);
    const modifiers = [
      ...new Set([
        ...Object.keys(MODIFIERS).filter((modifier) => legacyMask & MODIFIERS[modifier]),
        ...parts,
      ]),
    ];
    const held = [];
    let mask = 0;
    let main;
    const mainSent = {};
    let failure;
    try {
      for (const modifier of modifiers) {
        mask |= MODIFIERS[modifier];
        const description = keyDescription(modifier, mask);
        const sent = {};
        try {
          await operation.input(
            "Input.dispatchKeyEvent",
            { ...description, modifiers: mask, type: "rawKeyDown", autoRepeat: false },
            true,
            sent,
          );
        } finally {
          if (sent.value) held.push(description);
        }
      }
      main = keyDescription(key, mask);
      const modifier = MODIFIERS[main.key] ?? 0;
      mask |= modifier;
      const shortcutCode = [
        ...["Shift", "Control", "Alt", "Meta"].filter((name) => mask & MODIFIERS[name]),
        main.code,
      ].join("+");
      const mapping = mac ? (macEditingCommands[shortcutCode] ?? []) : [];
      // Without native key codes, macOS Chromium edits only through explicit
      // commands. The router refuses the clipboard ones.
      const commands =
        explicitCommands ??
        (Array.isArray(mapping) ? mapping : [mapping])
          .filter((command) => !command.startsWith("insert"))
          .map((command) => command.replace(/:$/u, ""));
      await operation.input(
        "Input.dispatchKeyEvent",
        {
          ...main,
          modifiers: mask,
          type: main.text ? "keyDown" : "rawKeyDown",
          unmodifiedText: main.text,
          autoRepeat: false,
          ...(commands.length || explicitCommands ? { commands } : {}),
        },
        true,
        mainSent,
      );
    } catch (error) {
      failure = error;
    }
    if (main && mainSent.value) {
      mask &= ~(MODIFIERS[main.key] ?? 0);
      const { text: _text, ...description } = main;
      const error = await operation.release("Input.dispatchKeyEvent", {
        ...description,
        modifiers: mask,
        type: "keyUp",
      });
      failure ??= error;
    }
    for (const description of held.reverse()) {
      mask &= ~MODIFIERS[description.key];
      const { text: _text, ...released } = description;
      const error = await operation.release("Input.dispatchKeyEvent", {
        ...released,
        modifiers: mask,
        type: "keyUp",
      });
      failure ??= error;
    }
    const terminal = terminalError(operation, failure);
    if (terminal) throw terminal;
  };
  const mouseClick = async (operation, point, options, move = true) => {
    const { button = "left", clickCount = 1, modifiers = 0 } = options;
    if (
      !["left", "middle", "right", "back", "forward"].includes(button) ||
      !Number.isInteger(clickCount) ||
      clickCount < 1
    )
      throw new TypeError("click requires a valid mouse button and positive integer clickCount");
    if (move)
      await operation.input(
        "Input.dispatchMouseEvent",
        { ...point, type: "mouseMoved", modifiers },
        false,
      );
    for (let count = 1; count <= clickCount; count++) {
      const parameters = { ...point, button, modifiers, clickCount: count };
      const sent = {};
      let failure;
      try {
        await operation.input(
          "Input.dispatchMouseEvent",
          { ...parameters, type: "mousePressed" },
          true,
          sent,
        );
      } catch (error) {
        failure = error;
      }
      const released = sent.value
        ? await operation.release("Input.dispatchMouseEvent", {
            ...parameters,
            type: "mouseReleased",
          })
        : undefined;
      const terminal = terminalError(operation, failure ?? released);
      if (terminal) throw terminal;
    }
  };

  // Input and object-group releases still in flight, for example behind a
  // dialog the program then answered, or after an action that ran out of time.
  const releases = new Set();
  const settleRelease = (entry, dialog, settling, onDialogClosed) =>
    new Promise((resolve) => {
      const timers = new Set();
      // Runs `callback` once the clock reaches `time`. A timer can wake early
      // (whole-millisecond delays, a busy event loop), so it looks again.
      const at = (time, callback) => {
        const handle = {};
        const wake = () => {
          const left = time - performance.now();
          if (left > 0) {
            handle.timer = setTimeout(wake, Math.ceil(left));
            return;
          }
          timers.delete(handle);
          callback();
        };
        handle.timer = setTimeout(wake, Math.max(0, Math.ceil(time - performance.now())));
        timers.add(handle);
        return handle;
      };
      const cancel = (handle) => {
        clearTimeout(handle.timer);
        timers.delete(handle);
      };
      let unsubscribe = () => undefined;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        for (const handle of timers) clearTimeout(handle.timer);
        unsubscribe();
        resolve();
      };
      entry.command.then(finish, finish);
      at(entry.sentAt + COMMAND_TIMEOUT, finish);
      // A command its action left unanswered at the deadline: still unanswered
      // at its cutoff means the page stopped answering.
      for (const owed of entry.operation.unanswered)
        if (owed.open)
          at(owed.until, () => {
            if (owed.open) finish();
          });
      // A dialog keeps the page from answering: one grace from when it was
      // first seen open, or from now if it already was. Closing cancels that.
      let dialogTimer;
      const watchDialog = () => {
        if (dialogTimer !== undefined) {
          cancel(dialogTimer);
          dialogTimer = undefined;
          if (!dialog.open()) onDialogClosed();
        }
        const open = dialog.open();
        if (!open) return;
        dialogTimer = at(Math.max(open.since, settling) + RELEASE_GRACE, () => {
          if (dialog.open()?.id === open.id) finish();
        });
      };
      unsubscribe = dialog.onChange(watchDialog);
      watchDialog();
      if (done) unsubscribe();
    });
  const operate = (label, options, action) =>
    new Operation(environment, label, options?.timeout ?? DEFAULT_TIMEOUT, releases).run(action);
  const geometry = async (operation, element, options) => {
    const result = await operation.call(element, "geometry", {
      ...options,
      attempt: operation.attempt,
    });
    operation.evidence.visibilityState = result.visibilityState;
    operation.evidence.samples++;
    return result;
  };
  const actionable = async (operation, element, options) => {
    const first = await geometry(operation, element, { ...options, scroll: operation.attempt > 0 });
    await operation.pause(50);
    const second = await geometry(operation, element, options);
    if (Object.keys(first.box).some((key) => first.box[key] !== second.box[key]))
      throw new RetryError("element is not stable");
    operation.reason = undefined;
    return second;
  };
  const evaluate = async (operation, objectId, fn, arg, locator, commit = false) => {
    if (typeof fn !== "function" && typeof fn !== "string")
      throw new TypeError("evaluate requires a function or string");
    const source =
      typeof fn === "function"
        ? `function(arg) { return (${fn.toString()})(${locator ? "this, arg" : "arg"}); }`
        : `function() { return globalThis.eval(${JSON.stringify(fn)}); }`;
    if (commit) operation.committed = true;
    return evaluationResult(
      await operation.command("Runtime.callFunctionOn", {
        objectId,
        objectGroup: operation.group,
        functionDeclaration: source,
        arguments: [{ value: arg }],
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      }),
    );
  };

  const locator = (steps, source) => {
    const append = (step, suffix) => locator([...steps, step], `${source}.${suffix}`);
    const read = (kind, name) =>
      operate(`${source}.${kind}()`, {}, async (operation) => {
        const elements = await operation.resolve(steps);
        if (kind === "count") return elements.length;
        if (kind === "allInnerTexts")
          return Promise.all(
            elements.map((element) => operation.call(element, "read", { kind: "innerText" })),
          );
        const element = await operation.strict(elements, kind === "isVisible");
        return element ? operation.call(element, "read", { kind, name }) : false;
      });
    const act = (kind, value, options = {}, legacy = {}) => {
      optionsFor(
        options,
        kind === "click"
          ? ["button", "clickCount", "modifiers", "position", "timeout"]
          : ["timeout"],
      );
      return operate(
        `${source}.${kind}(${value === undefined ? "" : display(value)})`,
        options,
        async (operation) => {
          const elements = await operation.resolve(steps);
          if (legacy.noWait && !elements.length) throw new Error("Element not found");
          const element = await operation.strict(elements);
          if (kind === "fill") await operation.call(element, "fillKind", { value });
          if (
            kind === "setChecked" &&
            (await operation.call(element, "read", { kind: "isChecked" })) === value
          )
            return;
          const pointer = kind === "click" || kind === "setChecked";
          const sample = await actionable(operation, element, {
            pointer,
            editable: kind === "fill",
            position: options.position,
          });
          if (pointer) {
            const mask = modifierMask(options.modifiers ?? [], await isMac(operation));
            await operation.input(
              "Input.dispatchMouseEvent",
              { ...sample.point, type: "mouseMoved", modifiers: mask },
              false,
            );
            const live = await operation.strict(await operation.resolve(steps));
            await geometry(operation, live, {
              pointer: true,
              position: options.position,
              point: sample.point,
            });
            await mouseClick(operation, sample.point, { ...options, modifiers: mask }, false);
            if (
              kind === "setChecked" &&
              (await operation.call(live, "read", { kind: "isChecked" })) !== value
            )
              throw new Error("Clicking did not change its state");
            return;
          }
          await operation.prepareInput();
          const focus = await operation.call(element, "focus", {
            fill: kind === "fill",
            value,
            append: legacy.append,
          });
          if (!(await operation.call(element, "focused")))
            throw new RetryError("element changed or lost focus after focus()");
          if (kind === "press") return press(operation, value);
          if (kind === "selectOption") {
            operation.committed = operation.dispatched = true;
            return operation.call(element, "select", {
              values: Array.isArray(value) ? value : [value],
            });
          }
          if (focus.special) {
            operation.committed = operation.dispatched = true;
            return operation.call(element, "specialFill", { value });
          }
          if (focus.collapseEnd) await press(operation, "ArrowRight");
          if (value === "") await press(operation, "Delete");
          else await operation.input("Input.insertText", { text: String(value) });
        },
      );
    };
    const methods = {
      ...selectors(append),
      first: () => append({ kind: "nth", index: 0 }, "first()").public,
      last: () => append({ kind: "nth", index: -1 }, "last()").public,
      nth: (index) => {
        if (!Number.isInteger(index) || index < 0)
          throw new TypeError("nth() requires a non-negative integer");
        return append({ kind: "nth", index }, `nth(${index})`).public;
      },
      filter: (options) => {
        optionsFor(options, ["hasText", "hasNotText", "visible"]);
        return append(
          {
            kind: "filter",
            ...options,
            ...(options.hasText !== undefined ? { hasText: pattern(options.hasText) } : {}),
            ...(options.hasNotText !== undefined
              ? { hasNotText: pattern(options.hasNotText) }
              : {}),
          },
          `filter(${JSON.stringify(options)})`,
        ).public;
      },
      click: (options) => act("click", undefined, options),
      dblclick: (options) => act("click", undefined, { ...options, clickCount: 2 }),
      fill: (value, options) => act("fill", String(value), options),
      clear: (options) => act("fill", "", options),
      press: (key, options) => act("press", key, options),
      check: (options) => act("setChecked", true, options),
      uncheck: (options) => act("setChecked", false, options),
      setChecked: (value, options) => {
        if (typeof value !== "boolean") throw new TypeError("setChecked() requires a boolean");
        return act("setChecked", value, options);
      },
      selectOption: (values, options) => act("selectOption", values, options),
      ...Object.fromEntries(
        [
          "count",
          "textContent",
          "innerText",
          "allInnerTexts",
          "inputValue",
          "isVisible",
          "isChecked",
          "isEnabled",
        ].map((kind) => [kind, () => read(kind)]),
      ),
      getAttribute: (name) => read("getAttribute", String(name)),
      waitFor: (options = {}) => {
        optionsFor(options, ["state", "timeout"]);
        const state = options.state ?? "visible";
        if (!["attached", "detached", "visible", "hidden"].includes(state))
          throw new TypeError(`Unsupported waitFor state: ${state}`);
        return operate(`${source}.waitFor(${display(state)})`, options, async (operation) => {
          const element = await operation.strict(await operation.resolve(steps), true);
          const visible = element
            ? await operation.call(element, "read", { kind: "isVisible" })
            : false;
          if (
            state === "attached"
              ? element
              : state === "detached"
                ? !element
                : state === "visible"
                  ? visible
                  : !visible
          )
            return;
          throw new RetryError(
            `element is ${element ? (visible ? "visible" : "hidden") : "detached"}; waiting for ${state}`,
          );
        });
      },
      evaluate: (fn, arg) =>
        operate(`${source}.evaluate()`, {}, async (operation) =>
          evaluate(
            operation,
            await operation.strict(await operation.resolve(steps)),
            fn,
            arg,
            true,
            true,
          ),
        ),
      ariaSnapshot: () =>
        operate(`${source}.ariaSnapshot()`, {}, async (operation) =>
          snapshot(await operation.queryAX(await operation.strict(await operation.resolve(steps)))),
        ),
    };
    return { public: subset(source, methods), act };
  };

  function selectors(append) {
    return {
      locator: (css) =>
        append({ kind: "css", selector: String(css) }, `locator(${display(css)})`).public,
      getByRole: (role, options = {}) => {
        optionsFor(options, ["name", "exact", "checked", "includeHidden"]);
        return append(
          { kind: "role", role: String(role), ...options },
          `getByRole(${display(role)}, ${JSON.stringify(options, (_, value) => (value instanceof RegExp ? String(value) : value))})`,
        ).public;
      },
      getByText: (text, options = {}) => {
        optionsFor(options, ["exact"]);
        return append(
          { kind: "text", text: pattern(text), ...options },
          `getByText(${display(text)}, ${JSON.stringify(options)})`,
        ).public;
      },
      getByLabel: (text, options = {}) => {
        optionsFor(options, ["exact"]);
        return append(
          { kind: "label", text: pattern(text), ...options },
          `getByLabel(${display(text)}, ${JSON.stringify(options)})`,
        ).public;
      },
    };
  }

  const keyboard = subset(
    "page.keyboard",
    {
      press: (key) =>
        operate(`page.keyboard.press(${display(key)})`, {}, (operation) => press(operation, key)),
      type: (text) =>
        operate("page.keyboard.type()", {}, async (operation) => {
          for (const character of String(text)) {
            if (layout.has(character)) await press(operation, character);
            else await operation.input("Input.insertText", { text: character });
          }
        }),
      insertText: (text) =>
        operate("page.keyboard.insertText()", {}, (operation) =>
          operation.input("Input.insertText", { text: String(text) }),
        ),
    },
    "Use press(), type() or insertText(); held keys are not supported.",
  );
  const page = subset(
    "page",
    {
      ...selectors((step, source) => locator([step], `page.${source}`)),
      keyboard,
      mouse: subset(
        "page.mouse",
        {
          click: (x, y, options = {}) => {
            optionsFor(options, ["button", "clickCount"]);
            if (!Number.isFinite(x) || !Number.isFinite(y))
              throw new TypeError("mouse.click requires finite coordinates");
            return operate("page.mouse.click()", {}, (operation) =>
              mouseClick(operation, { x, y }, options),
            );
          },
        },
        "Use mouse.click() or cdp('Input.dispatchMouseEvent', ...).",
      ),
      goto: (url, options = {}) => {
        optionsFor(options, ["timeout"]);
        return operate(`page.goto(${display(url)})`, options, async (operation) => {
          if (!operation.navigation) {
            operation.navigation = true;
            const result = await operation.command("Page.navigate", {
              url: environment.navigableUrl(url),
            });
            if (result.errorText) throw new Error(result.errorText);
          }
          const document = await operation.document();
          if (!(await evaluate(operation, document, () => document.readyState === "complete")))
            throw new RetryError("document.readyState is not complete");
          return null;
        });
      },
      url: () => page.evaluate(() => location.href),
      title: () => page.evaluate(() => document.title),
      evaluate: (fn, arg) =>
        operate("page.evaluate()", {}, async (operation) =>
          evaluate(operation, await operation.document(), fn, arg, false, true),
        ),
      waitForURL: (expected, options = {}) => {
        optionsFor(options, ["timeout"]);
        return operate("page.waitForURL()", options, async (operation) => {
          const value = await evaluate(operation, await operation.document(), () => location.href);
          if (
            typeof expected === "function"
              ? await operation.race(Promise.resolve(expected(new URL(value))))
              : match(value, expected, true)
          )
            return;
          throw new RetryError(`URL is ${JSON.stringify(value)}`);
        });
      },
      waitForFunction: (fn, arg, options = {}) => {
        optionsFor(options, ["timeout"]);
        return operate("page.waitForFunction()", options, async (operation) => {
          const result = await evaluate(operation, await operation.document(), fn, arg);
          if (result) return result;
          throw new RetryError("function returned a falsy value");
        });
      },
      waitForTimeout: (milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(milliseconds)))),
      screenshot: (options = {}) => {
        optionsFor(options, ["path", "fullPage"]);
        return environment.screenshot(options.path, { full: options.fullPage });
      },
      ariaSnapshot: () => page.locator("body").ariaSnapshot(),
    },
    "Use locator(), getByRole(), getByText(), getByLabel(), evaluate() or cdp(). For history use cdp('Page.reload'); frames and networkidle are not supported.",
  );
  return {
    page,
    /**
     * Waits for a departing session's in-flight releases before it detaches:
     * the runtime releases what a departing agent still holds, and a release
     * it has not seen acknowledged would reach the page twice. Each release is
     * waited for until it settles, unless first its action's page is shown to
     * have stopped answering (a command left unanswered at the deadline is
     * still unanswered one grace later), a dialog has stayed open for one
     * grace, or its own command timeout has passed since it was sent.
     */
    settleInput: async (sessionId, dialog, notices = {}) => {
      const leaving = [...releases].filter((entry) => entry.sessionId === sessionId);
      // A departing session's releases are waited for once, never again.
      for (const entry of leaving) releases.delete(entry);
      if (leaving.length) notices.waiting?.(leaving.length);
      const settling = performance.now();
      let closed = false;
      const dialogClosed = () => {
        if (closed) return;
        closed = true;
        notices.dialogClosed?.();
      };
      await Promise.all(
        leaving.map((entry) => settleRelease(entry, dialog, settling, dialogClosed)),
      );
    },
    pressKey: (key, { modifiers = 0, commands } = {}) =>
      operate(`pressKey(${display(key)})`, {}, (operation) =>
        press(operation, key, modifiers, commands),
      ),
    fillInput: (selector, value, { clear = true, timeout = 0 } = {}) =>
      locator(
        [
          { kind: "css", selector: String(selector) },
          { kind: "nth", index: 0 },
        ],
        `fillInput(${display(selector)})`,
      ).act(
        "fill",
        String(value),
        { timeout: timeout || DEFAULT_TIMEOUT },
        { append: !clear, noWait: timeout === 0 },
      ),
  };
}

function snapshot(nodes) {
  const scalar = (value) =>
    /^[\w .-]+$/u.test(String(value)) && String(value).trim() === String(value)
      ? String(value)
      : JSON.stringify(value);
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const children = new Map();
  for (const node of nodes) {
    const parent = byId.get(node.parentId);
    if (parent) {
      const siblings = children.get(parent.nodeId) ?? [];
      siblings.push(node);
      children.set(parent.nodeId, siblings);
    }
  }
  const lines = [];
  const visit = (node, depth) => {
    const role = node.role?.value ?? "";
    const descendants = children.get(node.nodeId) ?? [];
    if (node.ignored || ["generic", "none", "InlineTextBox"].includes(role)) {
      for (const child of descendants) visit(child, depth);
      return;
    }
    const indent = "  ".repeat(depth);
    const name = node.name?.value ?? "";
    if (role === "StaticText") {
      lines.push(`${indent}- text: ${scalar(name)}`);
      return;
    }
    let line = `${indent}- ${role}${name ? ` ${JSON.stringify(name)}` : ""}`;
    for (const property of node.properties ?? []) {
      if (
        !["checked", "disabled", "expanded", "level", "pressed", "selected"].includes(property.name)
      )
        continue;
      const value = property.value?.value;
      if (value === false || value === "false" || value === undefined) continue;
      line +=
        property.name === "level"
          ? ` [level=${value}]`
          : value === "mixed"
            ? ` [${property.name}=mixed]`
            : ` [${property.name}]`;
    }
    if (role === "textbox" && node.value?.value !== undefined)
      line += `: ${scalar(node.value.value)}`;
    else if (descendants.length) line += ":";
    lines.push(line);
    for (const child of descendants) visit(child, depth + 1);
  };
  for (const node of nodes) if (!byId.has(node.parentId)) visit(node, 0);
  return lines.join("\n");
}
