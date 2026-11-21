import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { agentTools, toolsFor } from "@opensteer/agent-tools";
import { expect, it } from "vitest";
import { phoneDeviceUnavailableDetail } from "../computer-apps/computer-app-availability.js";
import {
  computerAppDiscovery,
  pendingOnComputerNextAction,
  phoneDiscovery,
} from "../devices/computer-use-discovery.js";

/**
 * The code a connected agent's `browser_use`, `browser_connect` and `computer_use` scripts run
 * through. What it throws or prints reaches the agent as script output, which no later step
 * rewrites, so each sentence is written for whoever will read it.
 */
const scriptPath = [
  "../browser/browser-service.ts",
  "../browser/chrome-shared-tabs.ts",
  "../browser/standard-cdp-tickets.ts",
  "../browser-use/browser-guest-library.ts",
  "../browser-use/browser-guest-source.ts",
  "../browser-use/browser-repl-messages.ts",
  "../browser-use/browser-repl-service.ts",
  "../browser-use/browser-script-service.ts",
  "../browser-use/browser-use-port.ts",
  "../computer-use/computer-repl/computer-repl-service.ts",
  "../computer-use/computer-repl/computer-repl-worker.ts",
  "../computer-use/computer-repl/guest-library.ts",
  "../computer-use/computer-repl/messages.ts",
  "../computer-use/computer-repl/native-tab-binding.ts",
  "../computer-use/computer-use-service.ts",
  "../computer-apps/computer-app-availability.ts",
  "../devices/computer-access.ts",
  "../devices/computer-use-discovery.ts",
  "../devices/device-service.ts",
  "../tabs/tab-service.ts",
];

/**
 * Every sentence on that path that names a tool no connected agent is offered, and why no
 * connected agent reads it. A new one fails until it is written for its reader and listed here.
 * Where the sentence is the Run's side of a choice, `connection` is the connected agent's side,
 * which must stay in the source beside it.
 */
type RunOnly = { readonly reason: string; readonly connection?: string };
const runOnly: Readonly<Record<string, RunOnly>> = {
  "That profile name is ambiguous. Use browser_profile_list": {
    reason: "openAgentTab has no production caller; only a sign-in integration test calls it.",
  },
  "Unknown browser profile. Use browser_profile_list": {
    reason: "openAgentTab has no production caller; only a sign-in integration test calls it.",
  },
  "This tab lost its browser connection. Use tab_list": {
    reason: "#admitAgentBackend, for a Run binding.",
    connection:
      "This tab lost its browser connection. Open it again with the same tabId; discover lists the tabs shared with you.",
  },
  "This browser profile is already available. Open a page with tab_open": {
    reason: "requestAccess is reached only from browser_profile_request, whose callers are Runs.",
  },
  "This tab has ended or is unavailable. Use tab_list": {
    reason: "#usableAgentSession, for a Run binding.",
    connection:
      "This tab has ended or is unavailable. Use discover to find an open tab and pass its tabId.",
  },
  "This Run has no selected tab. Use tab_list": {
    reason:
      "#followedAgentSession runs only without a sessionId; every connection path passes one (script attach, page bind, standard CDP ticket).",
  },
  "This tab is unavailable to this task. Use tab_list": {
    reason: "admitAgentBrowser, for a Run binding.",
    connection:
      "This tab is unavailable to this task. Use discover to find an open tab and pass its tabId.",
  },
  "The browser disconnected, but Opensteer could not save its ended state. Use tab_list": {
    reason:
      "#finish is the broker's own lifecycle, and an internal error reads as a generic failure to any agent.",
  },
  "Apps access is off on ${phone.name}. Use computer_access_request": {
    reason: "phoneDeviceUnavailableDetail, for the person's own agents.",
    connection: "Apps access is off on ${phone.name}. The person can turn it on in Opensteer.",
  },
  "Call computer_apps to find targets and access instructions.": {
    reason: "The computer REPL guest library's lookupNext, for a task's context.",
    connection: "Use target, or call discover to see what is shared with you.",
  },
  "app_access_request {computerId, app, access, reason}": {
    reason: "computerAppRequestShape is used only by app_access_request, a Run tool.",
  },
  "app_access_request {computerId, access, reason}": {
    reason: "phoneRequestShape is used only by app_access_request, a Run tool.",
  },
  "No phone display set up for agents has computerId ${computerId}. Call computer_apps": {
    reason: "unknownPhone is a not_found refusal; a connection reads the fixed not_found message.",
  },
  "No Mac set up for computer use has computerId ${computerId}. Call computer_apps": {
    reason:
      "unknownComputerUseMac is a not_found refusal; a connection reads the fixed not_found message.",
  },
  "The owner can answer the pending request for ${machine} from any Opensteer app. A pending request grants nothing yet. Its outcome":
    {
      reason: "pendingOnComputerNextAction, for the person's own agents.",
      connection:
        "The owner can answer the pending request for ${machine} from any Opensteer app. A pending request grants nothing yet.`",
    },
  "Request access with app_access_request {computerId:${JSON.stringify(facts.computerId)}": {
    reason: "computerAppDiscovery, for the person's own agents.",
    connection: "? connectionAccessRequired",
  },
  "Request access with app_access_request {computerId:${JSON.stringify(facts.phone.computerId)}": {
    reason: "phoneDiscovery, for the person's own agents.",
    connection: "? connectionAccessRequired",
  },
  "Ask with computer_access_request {computerId:${JSON.stringify(phone.computerId)}": {
    reason: "phoneProblem access-off, for the person's own agents.",
    connection: "Ask the person to turn on Apps access for ${phone.name} in Opensteer.",
  },
  "${connection.runnerName} allows seeing only. Ask for read-write access to act: call app_access_request":
    {
      reason: "#callComputerOperation, for a Run.",
      connection:
        "${connection.runnerName} allows seeing only. The person can share it with read-write access under Connected agents",
    },
  "This app or phone is no longer approved for this task. Call computer_apps": {
    reason: "#callComputerOperation, for a Run.",
    connection:
      "This app or phone is no longer approved for this task. Call discover for current access.",
  },
  "This phone is no longer approved for this task. Call computer_apps": {
    reason: "installedApps, for a Run.",
    connection: "This phone is no longer approved for this task. Call discover for current access.",
  },
};

function scriptSources() {
  return scriptPath.map((path) =>
    readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8"),
  );
}

function sentencesNamingUnofferedTools() {
  const offered = new Set(
    toolsFor({ kind: "connection", grant: { scope: "everything" }, accessMode: "full-access" }).map(
      ({ name }) => name,
    ),
  );
  const never = agentTools.map(({ name }) => name).filter((name) => !offered.has(name));
  const names = new RegExp(`\\b(?:${never.join("|")})\\b`, "u");
  const found: string[] = [];
  for (const source of scriptSources())
    for (const line of source.split("\n")) {
      const code = line.trim();
      if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) continue;
      for (const literal of line.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/gu) ??
        [])
        // Prose only: a bare tool name is an identifier, not a sentence anyone reads.
        if (names.test(literal) && /\s/u.test(literal)) found.push(literal.slice(1, -1));
    }
  return found;
}

it("names no tool a connected agent lacks in any sentence its scripts can receive", () => {
  const found = sentencesNamingUnofferedTools();
  const listed = Object.keys(runOnly);
  expect(
    found.filter((sentence) => !listed.some((start) => sentence.startsWith(start))),
    "Write a connected agent's own sentence, or trace why none reads this and list it.",
  ).toEqual([]);
  expect(
    listed.filter((start) => !found.some((sentence) => sentence.startsWith(start))),
    "A listed sentence is gone; remove it from the list.",
  ).toEqual([]);
  // A Run's sentence stays listed only while the connected agent's own is still beside it.
  const sources = scriptSources().join("\n");
  expect(
    Object.values(runOnly).flatMap(({ connection }) =>
      connection === undefined || sources.includes(connection) ? [] : [connection],
    ),
    "The connected agent's side of this choice is gone.",
  ).toEqual([]);
});

it("tells a connected agent what the person decides, never a request tool", () => {
  const machine = { name: "Studio", state: "ready", appApproval: "ask" as const };
  const common = { callable: false, pendingPersonalGrant: false, heldByAnotherRun: false };
  const app = {
    ...common,
    app: "Notes",
    computerId: "dev_1",
    machine,
    approval: null,
    pendingOnMac: false,
  };
  const phone = {
    ...common,
    phone: { name: "Pixel", state: "ready", computerId: "dev_2" },
    connection: null,
    pendingPhoneAccess: false,
  };
  const accessOff = { reason: { kind: "access-off" } } as never;
  const texts = [
    JSON.stringify(computerAppDiscovery({ ...app, connectedAgent: true })),
    JSON.stringify(computerAppDiscovery({ ...app, pendingOnMac: true, connectedAgent: true })),
    JSON.stringify(phoneDiscovery({ ...phone, connectedAgent: true })),
    JSON.stringify(
      phoneDiscovery({
        ...phone,
        phone: { ...phone.phone, availability: accessOff },
        connectedAgent: true,
      }),
    ),
    pendingOnComputerNextAction("Studio", true),
    phoneDeviceUnavailableDetail({ name: "Pixel", availability: accessOff, connection: true }) ??
      "",
  ];
  for (const text of texts) {
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/app_access_request|computer_access_request|computer_apps/u);
  }
  // The person's own agents keep every word.
  expect(JSON.stringify(computerAppDiscovery(app))).toContain("app_access_request");
  expect(pendingOnComputerNextAction("Studio")).toContain("app_access_request");
  expect(phoneDeviceUnavailableDetail({ name: "Pixel", availability: accessOff })).toBe(
    "Apps access is off on Pixel. Use computer_access_request if needed.",
  );
});
