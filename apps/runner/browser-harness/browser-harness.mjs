#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { CdpClient, createBrowserHarness } from "./cdp.mjs";
import { ActionsClient, createActionsHarness, negotiateBackend } from "./actions.mjs";

const VERSION = "0.5.0-opensteer";
const USAGE = "usage: browser-harness [--tab <tabId>] < JavaScript on stdin";
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
/** Browsers a script stays connected to at once; the relay admits 16 connections per Run. */
const OPEN_BROWSERS = 4;
const NO_TAB =
  'Call switchTab(tabId) or newTab(url, { profile: "<name>" }) or newTab(url, { guest: true }) before using page helpers.';

function tabIdOf(tab) {
  const id = typeof tab === "string" ? tab : tab?.tabId;
  if (typeof id !== "string" || !id.length)
    throw new TypeError("A tab ID or listTabs() row is required.");
  return id;
}

function publicInfo(info) {
  const { targetId, surfaceId, sessionId: _sessionId, ...rest } = info;
  return { ...rest, tabId: surfaceId ?? targetId };
}

function createFacade(base) {
  const adapters = new Map();
  let active;
  let current;
  let epoch = 0;
  let switching = Promise.resolve();
  const requireAdapter = () => {
    if (!active) throw new Error(NO_TAB);
    return active;
  };
  const agent = async (path, input, query) => {
    const url = new URL(base);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    url.pathname = `${url.pathname.replace(/\/$/u, "")}/agent/${path}`;
    for (const [key, value] of Object.entries(query ?? {}))
      if (value !== undefined) url.searchParams.set(key, String(value));
    const response = await fetch(url, {
      method: input === undefined ? "GET" : "POST",
      ...(input === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(input) }),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const refusal = body?.error;
      const error = new Error(
        (refusal?.message ?? `Browser request refused (HTTP ${response.status}).`) +
          (refusal?.machineId
            ? ` (machineId ${refusal.machineId}, capability ${refusal.capability ?? "browser"})`
            : ""),
      );
      if (refusal?.machineId)
        Object.assign(error, { machineId: refusal.machineId, capability: refusal.capability });
      // A lost or unconfirmed outcome may still have taken effect; its key recovers it.
      error.uncertain =
        response.status >= 500 || body?.error?.reason === "browser-tab-open-outcome-unknown";
      throw error;
    }
    if (!body) throw new Error("Invalid browser response.");
    return body;
  };
  const mutate = async (path, input, retry = false) => {
    const keyed = { ...input, operationKey: randomUUID() };
    try {
      return await agent(path, keyed);
    } catch (error) {
      if (!retry || error.uncertain === false) throw error;
      return agent(path, keyed);
    }
  };
  /** Runs work on an adapter, which stays connected until the work settles. */
  const track = (adapter, work) => {
    adapter.busy += 1;
    let result;
    try {
      result = adapter.harness.run(work);
    } catch (error) {
      adapter.busy -= 1;
      throw error;
    }
    // Locators refuse unknown properties, so only a real promise is awaited for.
    if (!(result instanceof Promise)) {
      adapter.busy -= 1;
      return result;
    }
    return result.finally(() => {
      adapter.busy -= 1;
    });
  };
  const release = async (adapter) => {
    try {
      await adapter.harness.detach();
    } finally {
      adapter.client.close();
    }
  };
  const getAdapter = async (binding) => {
    let adapter = adapters.get(binding.sessionId);
    if (adapter) {
      // Most recently used last, so the oldest idle browser is released first.
      adapters.delete(binding.sessionId);
      adapters.set(binding.sessionId, adapter);
    } else {
      for (const [sessionId, idle] of adapters) {
        if (adapters.size < OPEN_BROWSERS) break;
        // A browser with work in flight stays; the limit is exceeded until it settles.
        if (idle === active || idle.busy > 0) continue;
        adapters.delete(sessionId);
        await release(idle).catch(() => undefined);
      }
      const backend = binding.backend ?? (await negotiateBackend(base, binding.sessionId));
      const client =
        backend === "actions"
          ? await ActionsClient.connect(base, binding.sessionId)
          : await CdpClient.connect(base, binding.sessionId);
      adapter = {
        backend,
        busy: 0,
        client,
        harness:
          backend === "actions" ? createActionsHarness(client) : createBrowserHarness(client),
      };
      adapters.set(binding.sessionId, adapter);
    }
    return adapter;
  };
  const serializeSwitch = (work) => {
    const pending = switching.then(work);
    switching = pending.catch(() => {});
    return pending;
  };
  const leave = async () => {
    const departing = active;
    if (departing) await departing.harness.detach();
    epoch++;
  };
  const selectBinding = async (binding) => {
    const next = await getAdapter(binding);
    await next.harness.switchTab(binding.tabId);
    active = next;
    current = binding.tabId;
    if (binding.reloaded)
      process.stderr.write(
        `[opensteer] Tab ${current} reloaded. Observe it again and use fresh page handles.\n`,
      );
    return current;
  };
  const switchTab = (tab) =>
    serializeSwitch(async () => {
      const tabId = tabIdOf(tab);
      await leave();
      if (active) {
        const local = await active.harness.listTabs().catch(() => []);
        if (
          local.some(
            (row) => (row.surfaceId ?? row.targetId) === tabId && row.state !== "suspended",
          )
        ) {
          await active.harness.switchTab(tabId);
          current = tabId;
          return tabId;
        }
      }
      return selectBinding(await agent("tabs/use", { tabId }));
    });
  const listTabs = async ({ query, state, limit = 50, all = false } = {}) => {
    const selected = current;
    const tabs = [];
    let cursor;
    do {
      const result = await agent("tabs", undefined, { query, state, limit, cursor });
      tabs.push(
        ...result.tabs.map((tab) => ({
          ...tab,
          ...(tab.tabId === selected ? { current: true } : {}),
        })),
      );
      if (!all && result.total > tabs.length)
        process.stderr.write(
          `[opensteer] ${result.total} tabs match; showing ${tabs.length}. Narrow listTabs({ query, state }) or pass { all: true }.\n`,
        );
      cursor = all ? result.nextCursor : null;
    } while (cursor);
    return tabs;
  };
  // Page is dynamic; objects it creates (locators and their refinements) belong to this selection.
  const handle = (value, adapter, generation) => {
    if (!value || typeof value !== "object" || typeof value.then === "function") return value;
    return new Proxy(
      {},
      {
        get(_target, key) {
          if (key === "then" || typeof key === "symbol") return undefined;
          const member = value[key];
          if (typeof member !== "function") return handle(member, adapter, generation);
          return (...args) => {
            if (epoch !== generation || active !== adapter)
              throw new Error(
                "This page handle belongs to a tab you left. Use fresh page handles after switchTab() or newTab().",
              );
            return handle(
              track(adapter, () => member.apply(value, args)),
              adapter,
              generation,
            );
          };
        },
      },
    );
  };
  const pageProxy = (keys = []) =>
    new Proxy(
      {},
      {
        get(_target, key) {
          if (key === "then" || typeof key === "symbol") return undefined;
          const adapter = requireAdapter();
          let parent = adapter.harness.page;
          for (const part of keys) parent = parent[part];
          const member = parent[key];
          if (typeof member !== "function") return pageProxy([...keys, key]);
          return (...args) => {
            const selected = requireAdapter();
            let owner = selected.harness.page;
            for (const part of keys) owner = owner[part];
            return handle(
              track(selected, () => owner[key](...args)),
              selected,
              epoch,
            );
          };
        },
      },
    );
  const call =
    (name) =>
    (...args) => {
      const adapter = requireAdapter();
      const method = adapter.harness[name];
      if (!method)
        throw new Error(`${name} is unavailable in this browser (${adapter.backend} backend).`);
      return track(adapter, () => method(...args));
    };
  const facade = {
    page: pageProxy(),
    listTabs,
    switchTab,
    attach: async () => {
      await call("attach")();
      return current;
    },
    detach: () =>
      serializeSwitch(async () => {
        await leave();
      }),
    newTab: (url = "about:blank", options = {}) =>
      serializeSwitch(async () => {
        const { profile, guest, computer, ...unknown } = options;
        if (
          Object.keys(unknown).length ||
          (profile !== undefined && (guest !== undefined || computer !== undefined)) ||
          (guest !== undefined && guest !== true)
        )
          throw new TypeError(
            'newTab options are { profile: "<name>" } or { guest: true, computer? }.',
          );
        if (profile === undefined && guest === undefined && computer === undefined) {
          const adapter = requireAdapter();
          await leave();
          current = await adapter.harness.newTab(url);
          return current;
        }
        if (profile === undefined && guest !== true && computer === undefined)
          throw new TypeError('Choose { profile: "<name>" } or { guest: true, computer? }.');
        const binding = await mutate(
          "tabs/open",
          {
            url,
            identity:
              profile !== undefined
                ? { kind: "profile", profile }
                : { kind: "guest", ...(computer === undefined ? {} : { computer }) },
          },
          true,
        );
        await leave();
        return selectBinding(binding);
      }),
    closeTab: (tab = current) =>
      serializeSwitch(async () => {
        if (!tab) throw new Error(NO_TAB);
        const tabId = tabIdOf(tab);
        const result = await mutate("tabs/close", { tabIds: [tabId] });
        if (result.closed.includes(current)) {
          await leave();
          active = undefined;
          current = undefined;
        }
        return result;
      }),
    organizeTabs: (input) => mutate("tabs/organize", input),
    listGroups: async () => (await agent("tabs", undefined, { limit: 1 })).groups,
    currentTab: async () => publicInfo(await call("currentTab")()),
    pageInfo: async () => publicInfo(await call("pageInfo")()),
    ensureRealTab: async () => publicInfo(await call("ensureRealTab")()),
    sleep: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(milliseconds)))),
  };
  for (const name of [
    "captureScreenshot",
    "cdp",
    "clickAt",
    "drainEvents",
    "fillInput",
    "fillLogin",
    "fillCard",
    "gotoUrl",
    "js",
    "pressKey",
    "respondDialog",
    "scroll",
    "setInputFiles",
    "stageFiles",
    "typeText",
    "waitForElement",
    "waitForLoad",
  ])
    facade[name] = call(name);
  return {
    facade,
    close: async () => {
      const results = await Promise.allSettled([...adapters.values()].map(release));
      const failed = results.find((result) => result.status === "rejected");
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
    args.length !== 0 &&
    (args.length !== 2 || args[0] !== "--tab" || !/^[A-Za-z0-9_-]{1,256}$/u.test(args[1]))
  )
    throw new Error(USAGE);
  const url = process.env.OPENSTEER_BROWSER_CDP_WS;
  if (!url)
    throw new Error(
      "OPENSTEER_BROWSER_CDP_WS is required; the Opensteer Runner did not configure browser control for this Run",
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
  const { facade, close } = createFacade(url);
  try {
    if (args[1]) await facade.switchTab(args[1]);
    const names = Object.keys(facade);
    const execute = new AsyncFunction(...names, `"use strict";\n{\n${program}\n}\n`);
    await execute(...names.map((name) => facade[name]));
  } finally {
    await close();
  }
}
main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
