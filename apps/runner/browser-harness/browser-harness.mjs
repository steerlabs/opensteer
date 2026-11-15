#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { CdpClient, createBrowserHarness } from "./cdp.mjs";
import { postJson } from "./http.mjs";
import { ActionsClient, createActionsHarness } from "./actions.mjs";

const VERSION = "0.5.0-opensteer";
const USAGE = "usage: browser-harness [--tab <tabId>] < JavaScript on stdin";
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const NO_TAB =
  "Use --tab <tabId> for page, or await openPage(tabId) for a bound page handle. Get tabId from tab_list or tab_open.";
const helpers = [
  "captureScreenshot",
  "cdp",
  "clickAt",
  "currentTab",
  "drainEvents",
  "ensureRealTab",
  "fillInput",
  "fillLogin",
  "fillCard",
  "gotoUrl",
  "js",
  "pageInfo",
  "pressKey",
  "respondDialog",
  "scroll",
  "setInputFiles",
  "stageFiles",
  "typeText",
  "waitForElement",
  "waitForLoad",
  "waitForNetworkIdle",
];

function endpoint(base, path) {
  const url = new URL(base);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = `${url.pathname.replace(/\/$/u, "")}/${path}`;
  return url;
}

export function createFacade(base, post = postJson) {
  const connections = new Set();
  let closed = false;
  let initial;
  const request = async (path, body, timeout) => {
    if (closed) throw new Error("Browser Harness is closed");
    const response = await post(endpoint(base, path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "error",
      ...(timeout ? { signal: AbortSignal.timeout(timeout) } : {}),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      const error = result?.error;
      throw Object.assign(
        new Error(error?.message ?? `Opensteer request failed (HTTP ${response.status})`),
        error ? { code: error.code, next: error.next } : {},
      );
    }
    if (!result || typeof result !== "object") throw new Error("Invalid Opensteer response");
    return result;
  };
  const openPage = async (tabId) => {
    if (typeof tabId !== "string" || !/^[A-Za-z0-9_-]{1,256}$/u.test(tabId))
      throw new TypeError("openPage requires a tabId from tab_list or tab_open");
    // Each handle owns its socket, subscriptions and helpers for its entire lifetime.
    if (connections.size >= 16)
      throw new Error("At most 16 page handles may be open in one script");
    const binding = await request("agent/pages/bind", { tabId }, 30_000);
    if (binding.tabId !== tabId || !["cdp", "actions"].includes(binding.backend))
      throw new Error("Invalid page binding");
    const client =
      binding.backend === "actions"
        ? await ActionsClient.connect(base, binding.sessionId)
        : await CdpClient.connect(base, binding.sessionId);
    const harness =
      binding.backend === "actions"
        ? createActionsHarness(client, tabId)
        : createBrowserHarness(client, tabId);
    const connection = { client, harness };
    connections.add(connection);
    try {
      await harness.attach();
      if (closed) throw new Error("Browser Harness is closed");
      const info = async (name) => {
        const {
          targetId: _targetId,
          surfaceId: _surfaceId,
          sessionId: _sessionId,
          ...rest
        } = await harness[name]();
        return { ...rest, tabId };
      };
      const members = { ...harness.page, tabId };
      for (const name of helpers)
        members[name] = (...args) => harness.run(() => harness[name](...args));
      for (const name of ["pageInfo", "currentTab", "ensureRealTab"])
        members[name] = () => info(name);
      return Object.freeze(members);
    } catch (error) {
      connections.delete(connection);
      client.close();
      throw error;
    }
  };
  const noPage = new Proxy(
    {},
    {
      get() {
        throw new Error(NO_TAB);
      },
    },
  );
  const facade = {
    page: noPage,
    openPage,
    opensteer: Object.freeze({
      callTool: async (name, input) => {
        if (typeof name !== "string" || !name.length || name.length > 255)
          throw new TypeError("callTool requires an Opensteer tool name");
        // Generated once; a caller never retries an uncertain effect under a fresh identity.
        const result = await request("tools/call", { callId: randomUUID(), name, input });
        return result.content?.some((block) => block.type !== "text")
          ? result
          : (result.structuredContent ?? result);
      },
    }),
    sleep: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(milliseconds)))),
  };
  for (const name of helpers)
    facade[name] = (...args) => {
      if (!initial) throw new Error(NO_TAB);
      return initial[name](...args);
    };
  return {
    facade,
    bindInitial: async (tabId) => {
      initial = await openPage(tabId);
      facade.page = initial;
    },
    close: async () => {
      closed = true;
      const settled = await Promise.allSettled(
        [...connections].map(async ({ harness, client }) => {
          try {
            await harness.detach({ final: true });
          } finally {
            client.close();
          }
        }),
      );
      connections.clear();
      const failed = settled.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (
    args.length &&
    (args.length !== 2 || args[0] !== "--tab" || !/^[A-Za-z0-9_-]{1,256}$/u.test(args[1]))
  )
    throw new Error(USAGE);
  const url = process.env.OPENSTEER_BROWSER_CDP_WS;
  if (!url)
    throw new Error(
      "OPENSTEER_BROWSER_CDP_WS is required; the Runner did not configure browser control for this Run",
    );
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 1_048_576) throw new Error("Browser Harness program is too large");
    chunks.push(chunk);
  }
  const program = Buffer.concat(chunks).toString("utf8");
  if (!program.trim()) throw new Error(USAGE);
  const { facade, bindInitial, close } = createFacade(url);
  try {
    if (args[1]) await bindInitial(args[1]);
    const names = Object.keys(facade);
    const execute = new AsyncFunction(...names, `"use strict";\n{\n${program}\n}\n`);
    await execute(...names.map((name) => facade[name]));
  } finally {
    await close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
