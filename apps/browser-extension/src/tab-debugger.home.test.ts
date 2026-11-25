import {
  BrowserSourceTabAssembly,
  BrowserSourceTabResultSchema,
  browserSourceTabParts,
  type BrowserSourceTabCommand,
} from "@opensteer/browser-source-wire/frames";
import { describe, expect, it, vi } from "vitest";
import { ChromeTabDebugger } from "./tab-debugger.js";

function listen<T extends (...args: never[]) => void>() {
  let listener: T;
  return {
    addListener(value: T) {
      listener = value;
    },
    emit(...args: Parameters<T>) {
      listener(...args);
    },
  };
}

/** A Home paired at its loopback address; it sends its canonical origin and port at attach. */
const paired = ["http://127.0.0.1:4310"];
const sent = { origins: ["https://home.example.com"], loopbackPorts: [4310] };

async function fixture(url = "https://fixture.test/", leftBehind: number[] = []) {
  const onCreated =
    listen<(details: { sourceTabId: number; tabId: number; url: string }) => void>();
  const onUpdated =
    listen<(tabId: number, changes: { url?: string; title?: string }, tab: ChromeTab) => void>();
  const order: string[] = [];
  const attach = vi.fn(async () => {
    order.push("attach");
  });
  const detach = vi.fn(async () => {
    order.push("detach");
  });
  const rules: { add: ChromeSessionRule[]; remove: number[] } = { add: [], remove: [] };
  const updateSessionRules = vi.fn(
    async (options: { addRules?: ChromeSessionRule[]; removeRuleIds?: number[] }) => {
      order.push(options.addRules ? "rules" : "unrules");
      rules.add.push(...(options.addRules ?? []));
      rules.remove.push(...(options.removeRuleIds ?? []));
    },
  );
  const relay = new ChromeTabDebugger(
    {
      attach,
      detach,
      sendCommand: vi.fn(async () => ({ worked: true })),
      onDetach: listen<(source: ChromeDebuggee, reason: string) => void>(),
      onEvent:
        listen<
          (source: ChromeDebuggee, method: string, params?: Record<string, unknown>) => void
        >(),
      getTargets: vi.fn(async () =>
        [5, 6, 7].map((tabId) => ({ tabId, id: String(tabId), type: "page" })),
      ),
    },
    {
      onRemoved: listen<(tabId: number) => void>(),
      onReplaced: listen<(added: number, removed: number) => void>(),
      onUpdated,
      create: vi.fn(),
      get: vi.fn(async (id: number) => ({ id, title: "Popup", url: "http://localhost:4310/" })),
      getCurrent: vi.fn(),
      query: vi.fn(),
      remove: vi.fn(),
    },
    { onCreatedNavigationTarget: onCreated },
    { updateSessionRules, getSessionRules: async () => leftBehind.map((id) => ({ id })) },
  );
  const assembly = new BrowserSourceTabAssembly();
  const replies = new Map<
    string,
    PromiseWithResolvers<ReturnType<typeof BrowserSourceTabResultSchema.parse>>
  >();
  const link = relay.connect(
    "home",
    (frame) => {
      if (frame.type === "tab.result") {
        const raw = assembly.read(frame);
        if (raw !== undefined) {
          const reply = BrowserSourceTabResultSchema.parse(raw);
          replies.get(reply.requestId)?.resolve(reply);
        }
      }
      return true;
    },
    () => {},
    false,
    undefined,
    paired,
  );
  const send = (command: BrowserSourceTabCommand) => {
    const done = Promise.withResolvers<ReturnType<typeof BrowserSourceTabResultSchema.parse>>();
    replies.set(command.requestId, done);
    for (const frame of browserSourceTabParts(
      "tab.command",
      new TextEncoder().encode(JSON.stringify(command)),
    ))
      link.read(frame);
    return done.promise;
  };
  await relay.share("home", { id: 5, title: "Shared", url });
  const shareId = relay.list("home")[0]?.shareId;
  const attachmentId = crypto.randomUUID();
  const evaluate = () =>
    send({
      action: "cdp",
      requestId: crypto.randomUUID(),
      shareId: shareId!,
      attachmentId,
      method: "Runtime.evaluate",
      homeAddresses: sent,
    });
  const unshared = () => relay.list("home").length === 0;
  return {
    relay,
    attach,
    detach,
    order,
    rules,
    onCreated,
    onUpdated,
    evaluate,
    send,
    shareId,
    attachmentId,
    unshared,
  };
}

describe("ChromeTabDebugger: a shared tab an agent drives may not be on an address of this Home", () => {
  for (const url of ["http://127.0.0.1:4310/", "http://localhost:4310/tasks", "http://[::1]:4310/"])
    it(`does not share a tab on its paired Home: ${url}`, async () => {
      const relay = new ChromeTabDebugger(
        {
          attach: vi.fn(),
          detach: vi.fn(),
          sendCommand: vi.fn(),
          onDetach: listen(),
          onEvent: listen(),
          getTargets: vi.fn(async () => [{ tabId: 5, id: "5", type: "page" }]),
        } as unknown as ChromeDebugger,
        {
          onRemoved: listen(),
          onReplaced: listen(),
          onUpdated: listen(),
        } as unknown as ChromeApi["tabs"],
      );
      relay.connect(
        "home",
        () => true,
        () => {},
        false,
        undefined,
        paired,
      );
      await expect(relay.share("home", { id: 5, title: "Opensteer", url })).rejects.toMatchObject({
        reason: "unsupported-page",
      });
    });

  it("blocks the Home's addresses for the tab before the debugger attaches, and lifts it at detach", async () => {
    const f = await fixture();
    expect((await f.evaluate()).ok).toBe(true);
    expect(f.order.slice(0, 2)).toEqual(["rules", "attach"]);
    expect(f.rules.remove).toEqual([]);
    const filters = f.rules.add.map((rule) => rule.condition.urlFilter);
    for (const filter of [
      "|https://home.example.com/",
      "|wss://home.example.com/",
      "|http://127.0.0.1:4310/",
      "|http://localhost:4310/",
      "|http://[::1]:4310/",
    ])
      expect(filters).toContain(filter);
    expect(filters.some((filter) => filter.includes(":5173"))).toBe(false);
    for (const rule of f.rules.add) {
      expect(rule.condition.tabIds).toEqual([5]);
      expect(rule.condition.resourceTypes).toContain("main_frame");
      expect(rule.condition.resourceTypes).toContain("sub_frame");
      expect(rule.condition.resourceTypes).toContain("xmlhttprequest");
      expect(rule.action).toEqual({ type: "block" });
    }
    await f.send({
      action: "detach",
      requestId: crypto.randomUUID(),
      shareId: f.shareId!,
      attachmentId: f.attachmentId,
    });
    await vi.waitFor(() =>
      expect(f.rules.remove.sort()).toEqual(f.rules.add.map((rule) => rule.id).sort()),
    );
  });

  for (const url of ["http://localhost:4310/", "https://home.example.com/settings"])
    it(`ends the share when the tab goes to ${url}`, async () => {
      const f = await fixture();
      await f.evaluate();
      f.onUpdated.emit(5, { url }, { id: 5, url, title: "Opensteer" });
      await vi.waitFor(() => expect(f.unshared()).toBe(true));
      await vi.waitFor(() => expect(f.detach).toHaveBeenCalled());
    });

  it("shares no window an agent's tab opens on the Home", async () => {
    const f = await fixture();
    await f.evaluate();
    f.onCreated.emit({ sourceTabId: 5, tabId: 6, url: "http://localhost:4310/" });
    await Promise.resolve();
    expect(f.relay.list("home")).toHaveLength(1);
  });

  it("removes the rules a previous service worker left before it adds its own", async () => {
    const f = await fixture("https://fixture.test/", [1, 2, 7]);
    expect((await f.evaluate()).ok).toBe(true);
    expect(f.order.slice(0, 3)).toEqual(["unrules", "rules", "attach"]);
    expect(f.rules.remove).toEqual([1, 2, 7]);
  });

  it("shares and drives a dev server on another loopback port", async () => {
    const f = await fixture("http://localhost:5173/");
    expect(f.shareId).toBeDefined();
    expect((await f.evaluate()).ok).toBe(true);
    f.onUpdated.emit(
      5,
      { url: "http://127.0.0.1:3000/" },
      { id: 5, url: "http://127.0.0.1:3000/" },
    );
    expect(f.unshared()).toBe(false);
  });
});
