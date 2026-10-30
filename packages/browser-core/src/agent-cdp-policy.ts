import {
  agentCdpAllowlist,
  type AgentCdpFields,
  type AgentCdpValue,
} from "./agent-cdp-allowlist.js";
import type { CdpParameters } from "./session-cdp-router.js";

/*
 * Agents act in the main world of every frame in a page's own renderer, with
 * exactly the reach of that frame's own scripts, plus user input. Nothing
 * those scripts cannot read is allowed: HttpOnly cookies, request and
 * response headers, other script worlds, privileged storage and browser APIs,
 * and the browser's own diagnostics, which the Log domain carries (a CORS
 * failure's entry quotes response headers the page's fetch never sees). The
 * exact methods, parameters and events are in the
 * [allowlist](./agent-cdp-allowlist.ts); everything else is refused.
 */

const contextParameters: ReadonlySet<string> = new Set([
  "contextId",
  "executionContextId",
  "uniqueContextId",
]);

/**
 * Allowlisted agent methods that only read a page: they run no page script and
 * change nothing a script could react to. Any other admitted method may lead
 * the page to start a passkey ceremony, so it counts as agent activity.
 */
export const agentObservationMethods: ReadonlySet<string> = new Set([
  "Accessibility.disable",
  "Accessibility.enable",
  "Accessibility.getFullAXTree",
  "Accessibility.getPartialAXTree",
  "Accessibility.queryAXTree",
  "DOM.describeNode",
  "DOM.disable",
  "DOM.enable",
  "DOM.getAttributes",
  "DOM.getBoxModel",
  "DOM.getContentQuads",
  "DOM.getDocument",
  "DOM.getNodeForLocation",
  "DOM.getOuterHTML",
  "DOM.querySelector",
  "DOM.querySelectorAll",
  "DOM.requestNode",
  "DOM.resolveNode",
  "DOMSnapshot.captureSnapshot",
  "Page.bringToFront",
  "Page.disable",
  "Page.enable",
  "Page.getFrameTree",
  "Page.getLayoutMetrics",
  "Page.getNavigationHistory",
  "Page.screencastFrameAck",
  "Page.setLifecycleEventsEnabled",
  "Page.startScreencast",
  "Page.stopScreencast",
  "Runtime.disable",
  "Runtime.enable",
  "Runtime.getProperties",
  "Runtime.releaseObject",
  "Runtime.releaseObjectGroup",
]);

export function browserInternalsRefusal(method: string): string {
  return `${method} is not available to agents: agents operate pages, not browser internals such as cookies, network traffic, storage, browser logs, or other script worlds.`;
}

/** Returns why an agent may not send this command to a page, or null when it may. */
export function agentPageCommandRefusal(
  method: string,
  parameters: CdpParameters,
  machineClipboardShared = true,
): string | null {
  const fields = agentCdpAllowlist.methods.get(method);
  if (!fields) return browserInternalsRefusal(method);
  for (const name of Object.keys(parameters)) {
    if (contextParameters.has(name)) {
      return `${method} ${name} is not available to agents: page scripts run only in frames' main worlds.`;
    }
  }
  if (method === "Runtime.evaluate" && (parameters.includeCommandLineAPI ?? false) !== false) {
    return "Runtime.evaluate includeCommandLineAPI is not available to agents: the DevTools console helpers are not page-level power.";
  }
  if (method === "Runtime.callFunctionOn" && typeof parameters.objectId !== "string") {
    return "Runtime.callFunctionOn needs an objectId from the page's main world.";
  }
  if (
    method === "Page.printToPDF" &&
    (parameters.transferMode ?? "ReturnAsBase64") !== "ReturnAsBase64"
  ) {
    return "Page.printToPDF returns the PDF inline to agents; IO streams are not available.";
  }
  if (method === "Page.reload" && Object.hasOwn(parameters, "scriptToEvaluateOnLoad")) {
    return "Page.reload scriptToEvaluateOnLoad is not available to agents: scripts run only in the loaded page.";
  }
  if (method === "Input.dispatchKeyEvent" && pastesClipboard(parameters)) {
    return "Pasting is not available to agents: it would read the clipboard of the computer running the browser. Type the text with Input.insertText instead.";
  }
  if (
    method === "Input.dispatchKeyEvent" &&
    machineClipboardShared &&
    writesClipboard(parameters)
  ) {
    return "Native copy and cut are not available to agents in this browser: they would write the clipboard of the computer it runs on. Read text from the page instead.";
  }
  return fieldsRefusal(method, "", fields, parameters);
}

/** Checks parameters against their exact schema: no unknown name, no missing or mistyped value. */
function fieldsRefusal(
  method: string,
  path: string,
  fields: AgentCdpFields,
  value: Readonly<Record<string, unknown>>,
): string | null {
  for (const [name, given] of Object.entries(value)) {
    const at = `${path}${name}`;
    const expected = Object.hasOwn(fields, name) ? fields[name] : undefined;
    if (!expected) return `${method} does not accept ${at} from agents.`;
    if (given === undefined) continue;
    const refusal = valueRefusal(method, at, expected, given);
    if (refusal) return refusal;
  }
  for (const [name, field] of Object.entries(fields)) {
    if (!field.optional && value[name] === undefined) return `${method} needs ${path}${name}.`;
  }
  return null;
}

function valueRefusal(
  method: string,
  path: string,
  expected: AgentCdpValue,
  value: unknown,
): string | null {
  switch (expected.kind) {
    case "any":
      return null;
    case "boolean":
    case "string":
      return typeof value === expected.kind
        ? null
        : `${method} ${path} must be a ${expected.kind}.`;
    case "number":
      return Number.isFinite(value) ? null : `${method} ${path} must be a number.`;
    case "integer":
      return Number.isSafeInteger(value) ? null : `${method} ${path} must be an integer.`;
    case "enum":
      return typeof value === "string" && expected.values.includes(value)
        ? null
        : `${method} ${path} must be one of ${expected.values.join(", ")}.`;
    case "array":
      if (!Array.isArray(value)) return `${method} ${path} must be an array.`;
      for (const [index, item] of value.entries()) {
        const refusal = valueRefusal(method, `${path}[${index}]`, expected.items, item);
        if (refusal) return refusal;
      }
      return null;
    case "record":
      return isObject(value) ? null : `${method} ${path} must be an object.`;
    case "object":
      return isObject(value)
        ? fieldsRefusal(method, `${path}.`, expected.fields, value)
        : `${method} ${path} must be an object.`;
  }
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const ctrlModifier = 2;
const metaModifier = 4;
const shiftModifier = 8;

/**
 * A paste reads the clipboard of the computer the browser runs on, which on a
 * person's Mac can hold a password they just copied. Page scripts cannot read
 * it without a permission the browser denies, so neither may an agent's keys.
 */
function pastesClipboard(parameters: CdpParameters): boolean {
  const commands = parameters.commands;
  if (
    Array.isArray(commands) &&
    commands.some((command) => typeof command === "string" && /paste/iu.test(command))
  ) {
    return true;
  }
  if (parameters.type !== "keyDown" && parameters.type !== "rawKeyDown") return false;
  const modifiers = typeof parameters.modifiers === "number" ? parameters.modifiers : 0;
  const key = typeof parameters.key === "string" ? parameters.key : "";
  const code = typeof parameters.code === "string" ? parameters.code : "";
  const keyCode =
    typeof parameters.windowsVirtualKeyCode === "number" ? parameters.windowsVirtualKeyCode : 0;
  if (key === "Paste" || code === "Paste") return true;
  const isV = key.toLowerCase() === "v" || code === "KeyV" || keyCode === 86;
  const isInsert = key === "Insert" || code === "Insert" || keyCode === 45;
  return (
    (isV && (modifiers & (ctrlModifier | metaModifier)) !== 0) ||
    (isInsert && (modifiers & shiftModifier) !== 0)
  );
}

/**
 * Where the browser shares the clipboard of the computer it runs on (the
 * desktop engine on a person's Mac), a native copy or cut would overwrite what
 * that person copied. Engines with their own clipboard keep it to the page.
 */
function writesClipboard(parameters: CdpParameters): boolean {
  const commands = parameters.commands;
  if (
    Array.isArray(commands) &&
    commands.some((command) => typeof command === "string" && /copy|cut/iu.test(command))
  ) {
    return true;
  }
  if (parameters.type !== "keyDown" && parameters.type !== "rawKeyDown") return false;
  const modifiers = typeof parameters.modifiers === "number" ? parameters.modifiers : 0;
  const key = typeof parameters.key === "string" ? parameters.key : "";
  const code = typeof parameters.code === "string" ? parameters.code : "";
  const keyCode =
    typeof parameters.windowsVirtualKeyCode === "number" ? parameters.windowsVirtualKeyCode : 0;
  if (["Copy", "Cut"].includes(key) || ["Copy", "Cut"].includes(code)) return true;
  const isCopyOrCutKey =
    /^[cx]$/iu.test(key) || ["KeyC", "KeyX"].includes(code) || [67, 88].includes(keyCode);
  const isInsert = key === "Insert" || code === "Insert" || keyCode === 45;
  const isDelete = key === "Delete" || code === "Delete" || keyCode === 46;
  return (
    (isCopyOrCutKey && (modifiers & (ctrlModifier | metaModifier)) !== 0) ||
    (isInsert && (modifiers & ctrlModifier) !== 0) ||
    (isDelete && (modifiers & shiftModifier) !== 0)
  );
}

export function isAgentPageEvent(method: string): boolean {
  return agentCdpAllowlist.events.has(method);
}
