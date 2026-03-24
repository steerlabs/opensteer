import { arraySchema, enumSchema, objectSchema, stringSchema, type JsonSchema } from "./json.js";

export const opensteerCapabilities = [
  "sessions.manage",
  "pages.manage",
  "pages.navigate",
  "input.pointer",
  "input.keyboard",
  "input.touch",
  "artifacts.screenshot",
  "execution.pause",
  "execution.resume",
  "execution.freeze",
  "inspect.pages",
  "inspect.frames",
  "inspect.html",
  "inspect.domSnapshot",
  "inspect.text",
  "inspect.attributes",
  "inspect.hitTest",
  "inspect.viewportMetrics",
  "inspect.network",
  "inspect.networkBodies",
  "inspect.cookies",
  "inspect.localStorage",
  "inspect.sessionStorage",
  "inspect.indexedDb",
  "transport.sessionHttp",
  "instrumentation.initScripts",
  "instrumentation.routing",
  "events.pageLifecycle",
  "events.dialog",
  "events.download",
  "events.chooser",
  "events.worker",
  "events.console",
  "events.pageError",
  "events.websocket",
  "events.eventStream",
  "events.executionState",
  "surface.rest",
  "surface.mcp",
] as const;

export type OpensteerCapability = (typeof opensteerCapabilities)[number];

export interface OpensteerCapabilityDescriptor {
  readonly key: OpensteerCapability;
  readonly description: string;
  readonly stability: "stable" | "experimental";
}

export const opensteerCapabilityDescriptors: readonly OpensteerCapabilityDescriptor[] = [
  {
    key: "sessions.manage",
    description: "Create and close isolated browser sessions.",
    stability: "stable",
  },
  {
    key: "pages.manage",
    description: "Create, close, and activate top-level browsing contexts.",
    stability: "stable",
  },
  {
    key: "pages.navigate",
    description: "Navigate, reload, and traverse session history.",
    stability: "stable",
  },
  {
    key: "input.pointer",
    description: "Inject pointer movement, click, and wheel input.",
    stability: "stable",
  },
  {
    key: "input.keyboard",
    description: "Inject key presses and raw text input.",
    stability: "stable",
  },
  { key: "input.touch", description: "Inject touch or gesture input.", stability: "experimental" },
  {
    key: "artifacts.screenshot",
    description: "Capture browser-rendered screenshots as evidence artifacts.",
    stability: "stable",
  },
  {
    key: "execution.pause",
    description: "Pause active page execution between protocol steps.",
    stability: "stable",
  },
  {
    key: "execution.resume",
    description: "Resume previously paused page execution.",
    stability: "stable",
  },
  {
    key: "execution.freeze",
    description: "Freeze timers or script execution at the engine boundary.",
    stability: "stable",
  },
  {
    key: "inspect.pages",
    description: "Enumerate pages and read page metadata.",
    stability: "stable",
  },
  {
    key: "inspect.frames",
    description: "Enumerate frames and read frame metadata.",
    stability: "stable",
  },
  {
    key: "inspect.html",
    description: "Read raw HTML snapshots without selector semantics.",
    stability: "stable",
  },
  {
    key: "inspect.domSnapshot",
    description: "Read structured DOM snapshots with node bindings.",
    stability: "stable",
  },
  {
    key: "inspect.text",
    description: "Read raw text from a specific node binding.",
    stability: "stable",
  },
  {
    key: "inspect.attributes",
    description: "Read ordered attributes from a specific node binding.",
    stability: "stable",
  },
  {
    key: "inspect.hitTest",
    description: "Resolve a point into the browser's current DOM target.",
    stability: "stable",
  },
  {
    key: "inspect.viewportMetrics",
    description: "Read viewport and scroll geometry.",
    stability: "stable",
  },
  {
    key: "inspect.network",
    description: "Read normalized network records without mutating traffic.",
    stability: "stable",
  },
  {
    key: "inspect.networkBodies",
    description: "Expose captured request and response bodies in network records.",
    stability: "stable",
  },
  {
    key: "inspect.cookies",
    description: "Read browser cookie state through the session boundary.",
    stability: "stable",
  },
  {
    key: "inspect.localStorage",
    description: "Read localStorage state through the session boundary.",
    stability: "stable",
  },
  {
    key: "inspect.sessionStorage",
    description: "Read sessionStorage state through the session boundary.",
    stability: "stable",
  },
  {
    key: "inspect.indexedDb",
    description: "Read IndexedDB state through the session boundary.",
    stability: "stable",
  },
  {
    key: "transport.sessionHttp",
    description: "Execute HTTP requests inside the live browser session boundary.",
    stability: "stable",
  },
  {
    key: "instrumentation.initScripts",
    description: "Inject scripts before page scripts execute inside a browser session.",
    stability: "stable",
  },
  {
    key: "instrumentation.routing",
    description: "Intercept, continue, replace, or abort browser network requests.",
    stability: "stable",
  },
  {
    key: "events.pageLifecycle",
    description: "Emit normalized page and popup lifecycle events.",
    stability: "stable",
  },
  { key: "events.dialog", description: "Emit dialog lifecycle events.", stability: "stable" },
  { key: "events.download", description: "Emit download lifecycle events.", stability: "stable" },
  {
    key: "events.chooser",
    description: "Emit file chooser and select picker events.",
    stability: "stable",
  },
  { key: "events.worker", description: "Emit worker lifecycle events.", stability: "experimental" },
  {
    key: "events.console",
    description: "Emit normalized console log events.",
    stability: "stable",
  },
  {
    key: "events.pageError",
    description: "Emit page-level uncaught error events.",
    stability: "stable",
  },
  {
    key: "events.websocket",
    description: "Emit websocket open, frame, and close events.",
    stability: "experimental",
  },
  {
    key: "events.eventStream",
    description: "Emit server-sent event stream messages.",
    stability: "experimental",
  },
  {
    key: "events.executionState",
    description: "Emit pause, resume, and frozen execution events.",
    stability: "stable",
  },
  {
    key: "surface.rest",
    description: "Expose the protocol over the canonical REST transport.",
    stability: "stable",
  },
  {
    key: "surface.mcp",
    description: "Expose the protocol over Model Context Protocol tools.",
    stability: "stable",
  },
] as const;

export const opensteerCapabilitySchema: JsonSchema = enumSchema(opensteerCapabilities, {
  title: "OpensteerCapability",
});

export const opensteerCapabilitySetSchema: JsonSchema = arraySchema(opensteerCapabilitySchema, {
  title: "OpensteerCapabilitySet",
  uniqueItems: true,
});

export const opensteerCapabilityDescriptorSchema: JsonSchema = objectSchema(
  {
    key: opensteerCapabilitySchema,
    description: stringSchema(),
    stability: enumSchema(["stable", "experimental"] as const),
  },
  {
    title: "OpensteerCapabilityDescriptor",
    required: ["key", "description", "stability"],
  },
);

export const opensteerCapabilityDescriptorListSchema: JsonSchema = arraySchema(
  opensteerCapabilityDescriptorSchema,
  {
    title: "OpensteerCapabilityDescriptorList",
    uniqueItems: true,
  },
);

export function hasCapability(
  capabilities: readonly OpensteerCapability[],
  capability: OpensteerCapability,
): boolean {
  return capabilities.includes(capability);
}
