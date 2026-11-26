import { OpensteerError } from "@opensteer/core";
import { DeviceIdSchema } from "@opensteer/core";
import { createId } from "@opensteer/core";
import { DeviceAccessRefusal } from "../../administration/device-access.js";
import { Worker } from "node:worker_threads";
import { computerReplLimits } from "./messages.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ComputerReplService } from "./computer-repl-service.js";

// Failure cases defined before implementation: synchronous starvation; total CPU;
// memory/stack exhaustion; wall/code/text/image/bridge limits; overlapping calls;
// FIFO aliases; detached work; cancellation and late results; generation changes;
// resident/executing limits; worker failure; teardown; absent ambient authority.
// One warm worker serves every case, as one serves every Run in a Host: starting
// a worker is not a case's work. Each case has its own Runs, ended after it.
let service: ComputerReplService;
let runs = 0;
const started: string[] = [];
const runId = () => {
  const id = `run-${++runs}`;
  started.push(id);
  return id;
};
// The length of a sleep argument whose request is one UTF-16 unit over the bridge limit.
const sleepArgument = {
  over:
    computerReplLimits.bridgeBytes +
    1 -
    JSON.stringify({ operation: "sleep", target: null, args: { ms: "" } }).length,
};
const output = (result: Awaited<ReturnType<ComputerReplService["execute"]>>) =>
  result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
beforeAll(async () => {
  service = new ComputerReplService({ invoke: async () => ({ value: [] }) });
  expect(output(await service.execute({ runId: runId(), generation: 1 }, "return 1"))).toBe("1");
});
afterEach(async () => {
  await Promise.all(started.splice(0).map((id) => service.endRun(id)));
});
afterAll(() => service.close());
function setup(invoke?: ConstructorParameters<typeof ComputerReplService>[0]["invoke"]) {
  const context = { runId: runId(), generation: 1 };
  return {
    service,
    context,
    run: (code: string, signal?: AbortSignal) => service.execute(context, code, signal, invoke),
  };
}
describe("computer REPL worker boundary", () => {
  it("keeps a connected agent's prints on both sides of a caught lost device reply", async () => {
    const window = {
      ref: "w",
      windowId: "win_00000000-0000-4000-8000-000000000007",
      title: "Doc",
    };
    const context = { runId: runId(), generation: 1, reportUnknownEffects: true as const };
    const result = await service.execute(
      context,
      `const w = await (await target).window();
       await w.observe();
       print("before click");
       try { await w.click(1); } catch {}
       print("observed again", (await w.observe()).tree);`,
      undefined,
      async ({ operation }) => {
        if (operation === "apps")
          return { value: [{ id: "notes", name: "Notes", computer: "Mac" }] };
        if (operation === "bind") return { value: { window } };
        if (operation === "observe")
          return {
            value: { observation: { snapshot: "s", window, tree: "[1] Save", screenshot: null } },
          };
        throw new OpensteerError({
          code: "conflict",
          reason: "outcome-unknown",
          message: "The device disconnected before it acknowledged the click.",
        });
      },
    );
    expect(result.structuredContent).toMatchObject({
      error: { code: "outcome-unknown", method: "click" },
    });
    expect(output(result)).toBe(
      "before click\nobserved again [1] Save\nclick: outcome-unknown: The device disconnected before it acknowledged the click.",
    );
  });

  it("gives a connection help and the bound app or phone without acquiring it by name", async () => {
    for (const app of [true, false]) {
      const invoke = vi.fn<ConstructorParameters<typeof ComputerReplService>[0]["invoke"]>(
        async ({ operation, target: id }) => {
          if (operation === "apps")
            return { value: app ? [{ id: "selected", name: "App", computer: "Mac" }] : [] };
          if (operation === "phones")
            return { value: [{ id: "selected", name: "Phone", computerId: "phone" }] };
          expect(id).toBe("selected");
          return { value: { tabId: "bound" } };
        },
      );
      const context = { runId: runId(), generation: 1, reportUnknownEffects: true as const };
      const help = output(await service.execute(context, "help()", undefined, invoke));
      expect(help).toMatch(/await target.*Window:.*Phone:.*installedApps/su);
      // A scroll's amount is said with its unit and its range.
      expect(help).toContain(
        "scroll's amount is how many steps it scrolls (three lines each in a Mac app, one swipe each on a phone), a whole number from 1 to 20.",
      );
      expect(invoke).not.toHaveBeenCalled();
      const refusal = await service.execute(context, 'await tab("another tab")', undefined, invoke);
      expect(output(refusal)).toContain(
        "Use target for the shared app or phone (app() or phone()). See help().",
      );
      expect(refusal.isError).toBe(true);
      expect(invoke).not.toHaveBeenCalled();
      expect(
        output(
          await service.execute(
            context,
            "const t = await target; return [t.id, typeof tab];",
            undefined,
            invoke,
          ),
        ),
      ).toBe('["selected","function"]');
      expect(invoke.mock.calls.map(([request]) => request.operation)).toEqual(
        app ? ["apps"] : ["apps", "phones", "bind"],
      );
    }
    const { run } = setup();
    expect(output(await run("return [typeof target, typeof help, typeof tab]"))).toBe(
      '["undefined","undefined","function"]',
    );
  });

  it("persists only within one Run attempt and prints returned JSON", async () => {
    const { service, context, run } = setup();
    expect(output(await run('globalThis.n = 3; print("before"); return {n};'))).toBe(
      'before\n{"n":3}',
    );
    expect(output(await run("return ++n"))).toBe("4");
    expect(output(await service.execute({ ...context, generation: 2 }, "return typeof n"))).toBe(
      '"undefined"',
    );
    expect(
      output(await service.execute({ runId: runId(), generation: 1 }, "return typeof n")),
    ).toBe('"undefined"');
  });
  it("expires the last idle VM at its deadline and disarms the timer", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const idle = new ComputerReplService({ invoke: async () => ({ value: [] }) });
    const context = { runId: runId(), generation: 1 };
    try {
      expect(vi.getTimerCount()).toBe(0);
      expect(output(await idle.execute(context, "globalThis.saved = 7; return saved"))).toBe("7");
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(computerReplLimits.idleMs);
      expect(vi.getTimerCount()).toBe(0);
      expect(output(await idle.execute(context, "return typeof saved"))).toBe('"undefined"');
      await idle.endRun(context.runId);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await idle.close();
      vi.useRealTimers();
    }
  });
  it("preserves a device refusal through the worker and its strict result envelope", async () => {
    const machineId = createId("runner");
    const { run } = setup(async () => {
      throw new DeviceAccessRefusal("device-access-off", DeviceIdSchema.parse(machineId), "apps");
    });
    const result = await run("await apps()");
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "device-access-off", machineId, capability: "apps" } },
    });
  });
  it("words the apps switch for who runs the script: a connected agent, or a program that may ask", async () => {
    const machineId = DeviceIdSchema.parse(createId("runner"));
    const invoke = async () => {
      throw new DeviceAccessRefusal("device-access-off", machineId, "apps", "Studio Mac");
    };
    const run = (context: Parameters<typeof service.execute>[0]) =>
      service.execute(context, "await apps()", undefined, invoke);
    // The person's own automation program also reports unknown effects; it holds the request tool.
    const program = await run({ runId: runId(), generation: 1, reportUnknownEffects: true });
    expect(output(program)).toContain("Use computer_access_request if needed.");
    const agent = await run({
      runId: runId(),
      generation: 1,
      reportUnknownEffects: true,
      connectedAgent: true,
    });
    expect(output(agent)).toContain(
      "Apps access is off on Studio Mac. The person can turn it on in Opensteer.",
    );
    expect(output(agent)).not.toContain("computer_access_request");
  });
  it("has no Node, network, filesystem or ambient timer capabilities", async () => {
    const { run } = setup();
    expect(
      output(await run("return [typeof process,typeof require,typeof fetch,typeof setTimeout]")),
    ).toBe('["undefined","undefined","undefined","undefined"]');
  });
  it("interrupts a synchronous slice without blocking the Host", async () => {
    const { run } = setup();
    const result = await run("while(true) {}");
    expect(result.isError).toBe(true);
    expect(output(result)).toContain("100 ms of CPU time without awaiting");
    expect(output(await run("return 42"))).toBe("42");
  });
  it("refuses code and output beyond the byte limits", async () => {
    const { run } = setup();
    expect((await run(" ".repeat(65537))).isError).toBe(true);
    expect((await run('print("x".repeat(524289))')).isError).toBe(true);
  });
  it.each([
    'throw new Error("x".repeat(2_000_000))',
    'throw {code:"漢".repeat(200_000),message:"😺".repeat(500_000)}',
    'print("a".repeat(524280)); throw new Error("x".repeat(2_000_000))',
  ])("bounds exception output within the remaining text budget: %s", async (code) => {
    const { run } = setup();
    const result = await run(code);
    expect(result.isError).toBe(true);
    const bytes = result.content.reduce(
      (sum, block) => sum + (block.type === "text" ? Buffer.byteLength(block.text) : 0),
      0,
    );
    expect(bytes).toBeLessThanOrEqual(computerReplLimits.textBytes);
    if (code.startsWith("print"))
      expect(result.content[0]).toEqual({ type: "text", text: "a".repeat(524280) });
  });
  describe("on a worker preempted mid-slice", () => {
    let worker: Worker;
    const release = new Int32Array(new SharedArrayBuffer(4));
    const messages: Record<string, unknown>[] = [];
    const execute = (context: string, code: string) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const listen = (message: Record<string, unknown>) => {
          if (message.context !== context) return;
          messages.push(message);
          if (message.type === "done") {
            worker.off("message", listen);
            resolve(message);
          }
        };
        worker.on("message", listen);
        worker.once("error", reject);
        worker.postMessage({ type: "execute", context, callId: context, code });
      });
    beforeAll(async () => {
      // The flood's thread loses twice the slice budget mid-slice, as on a busy
      // machine; its budgets charge only the guest's own time. The hog's thread
      // loses more than the wall bound a slice may hold the shared worker.
      worker = new Worker(new URL("./computer-repl-worker.ts", import.meta.url), {
        execArgv: [
          "--import",
          "tsx",
          "--import",
          new URL("./computer-repl-worker.test-support.ts", import.meta.url).href,
        ],
        workerData: {
          preempted: {
            "flood-warm": { afterPrints: 1000, ms: 2 * computerReplLimits.sliceMs },
            hog: {
              afterPrints: 1,
              ms: computerReplLimits.sliceWallMs + 100,
              release: release.buffer,
            },
          },
        },
      });
      await execute("flood-warm", "return 1");
      await execute("other-warm", "return 1");
    });
    afterAll(() => worker.terminate());
    it("bounds producer messages before transfer and leaves another Run responsive", async () => {
      messages.length = 0;
      const flood = execute(
        "flood-warm",
        'for(let i=0;i<200000;i++){try{print("x")}catch{} await Promise.resolve()}',
      );
      const other = execute("other-warm", "return 42");
      const [ended, healthy] = await Promise.all([flood, other]);
      expect(healthy.error).toBeUndefined();
      expect(messages.some((m) => m.context === "other-warm" && m.text === "42")).toBe(true);
      expect(
        messages.findIndex((m) => m.context === "other-warm" && m.type === "done"),
      ).toBeLessThan(messages.findIndex((m) => m.context === "flood-warm" && m.type === "done"));
      const floodMessages = messages.filter((m) => m.context === "flood-warm");
      expect(
        floodMessages.reduce((n, m) => n + Buffer.byteLength(JSON.stringify(m)), 0),
      ).toBeLessThanOrEqual(1024 * 1024 + 16 * 1024);
      expect(ended.error).toMatchObject({ code: "output-limit" });
      const enormous = await execute(
        "error-bounds",
        'throw {code:"x".repeat(200000),message:"y".repeat(2000000)}',
      );
      const error = enormous.error as { code: string; message: string };
      expect(Buffer.byteLength(error.code)).toBeLessThanOrEqual(128);
      expect(Buffer.byteLength(error.message)).toBeLessThanOrEqual(8192);
    });
    it("ends a slice that holds the shared worker past its wall bound, then runs another Run", async () => {
      messages.length = 0;
      const hog = execute("hog", 'print("holding"); while(true){}');
      await vi.waitFor(() =>
        expect(messages.some((m) => m.context === "hog" && m.text === "holding")).toBe(true),
      );
      // The hog's thread stays stalled until the other Run is queued behind it.
      const other = execute("other-warm", "return 42");
      Atomics.store(release, 0, 1);
      Atomics.notify(release, 0);
      const [held, healthy] = await Promise.all([hog, other]);
      expect(held.error).toMatchObject({ code: "slice-limit" });
      expect((held.error as { message: string }).message).toContain(
        "held the shared computer worker",
      );
      expect(healthy.error).toBeUndefined();
      expect(messages.some((m) => m.context === "other-warm" && m.text === "42")).toBe(true);
      expect(messages.findIndex((m) => m.context === "hog" && m.type === "done")).toBeLessThan(
        messages.findIndex((m) => m.context === "other-warm" && m.type === "done"),
      );
    });
  });
  it("keeps accepted output and an error when a Host text emission exceeds the remainder", async () => {
    const { run } = setup(async () => ({
      value: [],
      content: [{ type: "text", text: "x".repeat(524289) }],
    }));
    const result = await run('print("kept"); await apps()');
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({ type: "text", text: "kept" });
    expect(output(result)).toContain("output-limit");
    expect(
      result.content.reduce((n, b) => n + (b.type === "text" ? Buffer.byteLength(b.text) : 0), 0),
    ).toBeLessThanOrEqual(524288);
  });
  it("bounds guest memory and stack", async () => {
    const { run } = setup();
    expect((await run("const x=[]; for(;;) x.push(new Uint8Array(1024*1024))")).isError).toBe(true);
    expect((await run("function recurse(){recurse()} recurse()")).isError).toBe(true);
  });
  it("refuses overlap, cancels sleep, and fences ended Runs", async () => {
    const { service, context, run } = setup();
    const controller = new AbortController();
    const pending = run('await sleep(10000); return "late"', controller.signal);
    expect((await run('return "overlap"')).isError).toBe(true);
    controller.abort();
    expect((await pending).isError).toBe(true);
    await service.endRun(context.runId);
    expect((await run('return "ended"')).isError).toBe(true);
  });
  it("preserves the blocked phone recommendation when selected by computerId", async () => {
    const blocked = {
      code: "access_required",
      message: "Pixel needs access for this task.",
      next: 'Use app_access_request {computerId:"rnr_pixel", access:"read-write", reason:"Check calendar"}.',
    };
    const { run } = setup(async () => ({
      value: [{ id: "connection", computerId: "rnr_pixel", name: "Pixel", blocked }],
    }));
    const result = await run('await phone("rnr_pixel")');
    expect(result.structuredContent).toEqual({ error: { ...blocked, performed: [] } });
  });
  it("preserves typed Host refusal details in the same REPL failure shape", async () => {
    const { run } = setup(async () => {
      throw new OpensteerError({
        code: "forbidden",
        reason: "access_pending",
        message: "Access is pending.",
        next: "The owner can answer the request.",
      });
    });
    expect((await run("await apps()")).structuredContent).toEqual({
      error: {
        code: "access_pending",
        message: "Access is pending.",
        next: "The owner can answer the request.",
        performed: [],
      },
    });
  });
  it("serializes Promise.all, shares window snapshots and preserves emission order", async () => {
    const calls: string[] = [];
    const { run } = setup(async (request) => {
      calls.push(request.operation);
      if (request.operation === "apps")
        return {
          value: [
            { id: "a", name: "Notes", bundleId: "notes", computer: "Mac", access: "read-write" },
          ],
        };
      if (request.operation === "bind")
        return {
          value: {
            window: {
              ref: "w",
              windowId: "win_00000000-0000-4000-8000-000000000007",
              title: "Doc",
            },
          },
        };
      if (request.operation === "observe")
        return {
          value: {
            observation: {
              snapshot: "s",
              window: {
                ref: "w",
                windowId: "win_00000000-0000-4000-8000-000000000007",
                title: "Doc",
              },
              tree: "[1] Save",
              screenshot: null,
            },
          },
          content: [{ type: "text", text: "observed" }],
        };
      expect(request.args.snapshot).toBe("s");
      return {
        value: { performed: ["Clicked Save"] },
        content: [{ type: "text", text: "Clicked Save" }],
      };
    });
    const result = await run(
      'const a=await app("Notes"); const w=await a.window("win_00000000-0000-4000-8000-000000000007"); const alias=await a.window("win_00000000-0000-4000-8000-000000000007"); await Promise.all([w.observe(),alias.click(1)]); return "done"',
    );
    expect(result.isError).toBeUndefined();
    expect(calls).toEqual(["apps", "bind", "bind", "observe", "click"]);
    expect(output(result)).toBe('observed\nClicked Save\n"done"');
  });
  it("returns read-only tab identities and never reacquires during observations", async () => {
    const acquisitions: string[] = [];
    const { run } = setup(async (request) => {
      if (request.operation === "tab") {
        acquisitions.push(request.target!);
        return {
          value:
            request.target === "phone-tab"
              ? {
                  kind: "phone",
                  connectionId: "p",
                  tabId: "phone-tab",
                  name: "Phone",
                  computerId: "phone",
                }
              : {
                  kind: "window",
                  connectionId: "a",
                  tabId: "window-tab",
                  window: {
                    windowId: "win_00000000-0000-4000-8000-000000000007",
                    title: "Note",
                    ref: "w",
                  },
                },
        };
      }
      if (request.operation === "observe")
        return { value: { observation: { snapshot: "s", observationId: "o" } } };
      throw new Error("Unexpected operation");
    });
    expect(
      output(
        await run(
          'const w=await tab("window-tab"); const p=await tab("phone-tab"); try {w.tabId="other"} catch {} try {p.tabId="other"} catch {} await w.observe(); await p.observe(); return [w.tabId,p.tabId,w.windowId,typeof w.id]',
        ),
      ),
    ).toBe('["window-tab","phone-tab","win_00000000-0000-4000-8000-000000000007","undefined"]');
    await run("await w.observe(); await p.observe()");
    expect(acquisitions).toEqual(["window-tab", "phone-tab"]);
  });
  it("binds the phone computerId from discovery when names are identical", async () => {
    const bound: string[] = [];
    const { run } = setup(async (request) => {
      if (request.operation === "phones")
        return {
          value: [
            { id: "connection-a", name: "Phone", computerId: "computer-a" },
            { id: "connection-b", name: "Phone", computerId: "computer-b" },
          ],
        };
      if (request.operation === "bind") {
        bound.push(request.target!);
        return { value: { tabId: "phone-tab" } };
      }
      throw new Error("Unexpected operation");
    });
    expect(output(await run('return (await phone("computer-b")).name'))).toBe('"Phone"');
    expect(bound).toEqual(["connection-b"]);
  });
  it("binds one phone of either kind and sends only advertised navigation", async () => {
    const phones = [
      {
        id: "android",
        name: "Pixel",
        computer: "Pixel",
        computerId: "rnr_00000000-0000-4000-8000-000000000001",
        definitionId: "android-phone",
        platform: "android",
        navigation: ["back", "home"],
      },
      {
        id: "iphone",
        name: "Work iPhone",
        computer: "Work iPhone",
        computerId: "dev_00000000-0000-4000-8000-000000000002",
        definitionId: "iphone-screen",
        platform: "ios",
        navigation: ["home"],
      },
      {
        id: "iphone-2",
        name: "Work iPhone",
        computer: "Work iPhone",
        computerId: "dev_00000000-0000-4000-8000-000000000003",
        definitionId: "iphone-screen",
        platform: "ios",
        navigation: ["home"],
      },
    ];
    const sent: unknown[] = [];
    const { run } = setup(async (request) => {
      if (request.operation === "phones") return { value: phones };
      if (request.operation === "bind")
        return { value: { tabId: `tab-${request.target}`, connectionId: request.target } };
      if (request.operation === "tab")
        return {
          value: {
            kind: "phone",
            connectionId: "iphone",
            tabId: "tab-iphone",
            name: "Work iPhone",
            computerId: "dev_00000000-0000-4000-8000-000000000002",
          },
        };
      if (request.operation === "installedApps")
        return { value: { apps: [{ label: "Maps", appId: "opaque-maps" }], total: 1 } };
      sent.push([request.target, request.args.actions]);
      return { value: { observation: { observationId: "o" } } };
    });
    const ambiguous = await run('await phone("Work iPhone")');
    expect(output(ambiguous)).toContain(
      "Choose one: Work iPhone (computerId dev_00000000-0000-4000-8000-000000000002), Work iPhone (computerId dev_00000000-0000-4000-8000-000000000003)",
    );
    const result = await run(
      'const p=await phone("dev_00000000-0000-4000-8000-000000000002"); const {apps}=await p.installedApps({query:"maps"}); await p.launch(apps[0].appId); await p.navigate("home"); await p.wait(250); let refused; try {await p.navigate("back")} catch (error) {refused=error.message} const t=await tab("tab-iphone"); try {await t.navigate("back")} catch (error) {refused+=" / "+error.message} const a=await phone("Pixel"); await a.navigate("back"); return [p.platform,refused]',
    );
    expect(output(result)).toBe(
      '["ios","Work iPhone has no back button. It offers: home. / Work iPhone has no back button. It offers: home."]',
    );
    expect(sent).toEqual([
      ["iphone", [{ type: "launch", appId: "opaque-maps" }]],
      ["iphone", [{ type: "navigate", to: "home" }]],
      ["iphone", [{ type: "wait", ms: 250 }]],
      ["android", [{ type: "navigate", to: "back" }]],
    ]);
  });
  it("requires a new observation after explicitly reacquiring a native target", async () => {
    const snapshots: unknown[] = [];
    const { run } = setup(async (request) => {
      if (request.operation === "tab")
        return {
          value: {
            kind: "window",
            connectionId: "a",
            tabId: "window-tab",
            window: {
              windowId: "win_00000000-0000-4000-8000-000000000007",
              title: "Note",
              ref: "w",
            },
          },
        };
      if (request.operation === "observe") return { value: { observation: { snapshot: "prior" } } };
      snapshots.push(request.args.snapshot);
      return { value: { performed: [] } };
    });
    await run(
      'const first=await tab("window-tab"); await first.observe(); const fresh=await tab("window-tab"); await fresh.click(1)',
    );
    expect(snapshots).toEqual([null]);
  });
  it("cancels unstarted detached operations at body settlement", async () => {
    const calls: string[] = [];
    const { run } = setup(async (request) => {
      calls.push(request.operation);
      return { value: [] };
    });
    await run('apps(); apps(); return "finished"');
    expect(calls.length).toBeLessThanOrEqual(1);
    await run('return "next"');
    expect(calls.length).toBeLessThanOrEqual(1);
  });
  it("enforces image count and image byte budgets", async () => {
    for (const [count, size] of [
      [9, 1],
      [1, 4194305],
    ]) {
      const { run } = setup(async () => ({
        value: [],
        content: Array.from({ length: count! }, () => ({
          type: "image" as const,
          data: Buffer.alloc(size!).toString("base64"),
          mimeType: "image/png",
        })),
      }));
      expect((await run("await apps()")).isError).toBe(true);
    }
  });
  it("requires bounded JSON at the bridge", async () => {
    const { run } = setup(async () => ({ value: "x".repeat(1048577) }));
    expect((await run("await apps()")).isError).toBe(true);
  });
  it.each([
    [
      "arguments",
      "JSON.stringify = () => hostile; await sleep(1)",
      "failed: Computer arguments exceed 1 MiB.",
    ],
    [
      "printed text",
      "Array.prototype.join = () => hostile; print('a')",
      "output-limit: Computer output exceeded its byte limit.",
    ],
    [
      "a returned value",
      "JSON.stringify = () => hostile; return 1",
      "output-limit: Computer output exceeded its byte limit.",
    ],
  ])(
    "refuses %s that are not a string without running the guest's toString",
    async (_place, code, refusal) => {
      const { run } = setup();
      // Coercing this would run guest code that builds a string until a limit stops it.
      const hostile =
        'const hostile = { toString() { let text = ""; for (;;) text += "x".repeat(1024); } };';
      expect(output(await run(`${hostile} ${code}`))).toBe(refusal);
    },
  );
  it("reads a thrown value's fields as strings the guest cut to their bounds", async () => {
    const { run } = setup();
    const result = await run(`throw {
      code: "busy", next: "Try again.", message: "é".repeat(100_000),
      performed: [1, ...Array.from({ length: 300 }, (_, i) => "step " + i)],
    }`);
    expect(result.structuredContent).toEqual({
      error: {
        code: "busy",
        next: "Try again.",
        message: "é".repeat(4096),
        performed: Array.from({ length: 160 }, (_, i) => `step ${i}`),
      },
    });
  });
  it("refuses oversized arguments by their length, before the Host copies them", async () => {
    const { run } = setup();
    // Built before an await: the slice that calls sleep spends only the guest
    // library's serialization of an argument one unit over the limit.
    expect(
      output(await run(`const big = "x".repeat(${sleepArgument.over}); await 0; await sleep(big)`)),
    ).toBe("failed: Computer arguments exceed 1 MiB.");
  });
  describe("on a slow worker", () => {
    // Its CPU counts four times, as on a machine four times slower. A hosted
    // runner at least 2.8 times slower than a Mac ran out of slice before this
    // refusal: on the Mac the old case's slice took 36 ms, 14 of them the test's own
    // "x".repeat of 4 MiB, 21 the guest library's JSON.stringify of it, 0.06 the
    // Host's length check. Its Host also spends two slices' CPU parsing a large
    // argument, which is the Host's work and never the guest's slice.
    let worker: Worker;
    const messages: Record<string, unknown>[] = [];
    const execute = (context: string, code: string) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const listen = (message: Record<string, unknown>) => {
          if (message.context !== context) return;
          messages.push(message);
          if (message.type === "request")
            worker.postMessage({
              type: "reply",
              context,
              callId: context,
              id: message.id,
              value: null,
            });
          if (message.type === "done") {
            worker.off("message", listen);
            resolve(message);
          }
        };
        worker.on("message", listen);
        worker.once("error", reject);
        worker.postMessage({ type: "execute", context, callId: context, code });
      });
    beforeAll(async () => {
      worker = new Worker(new URL("./computer-repl-worker.ts", import.meta.url), {
        execArgv: [
          "--import",
          "tsx",
          "--import",
          new URL("./computer-repl-worker.test-support.ts", import.meta.url).href,
        ],
        workerData: { slowed: { cpuScale: 4, hostParseMs: 2 * computerReplLimits.sliceMs } },
      });
      await execute("slow-warm", "return 1");
    });
    afterAll(() => worker.terminate());
    it("refuses an oversized argument by its length and admits one at the limit", async () => {
      messages.length = 0;
      const refused = await execute(
        "slow-over",
        `const big = "x".repeat(${sleepArgument.over}); await 0; await sleep(big)`,
      );
      expect(refused.error).toMatchObject({ message: "Computer arguments exceed 1 MiB." });
      expect(messages.some((m) => m.type === "request")).toBe(false);
      // Its Host copy and parse are the Host's work, not the guest's slice.
      const admitted = await execute(
        "slow-limit",
        `const big = "x".repeat(${sleepArgument.over - 1}); await 0; await sleep(big)`,
      );
      expect(admitted.error).toBeUndefined();
      const request = messages.find((m) => m.type === "request")?.request as {
        args: { ms: string };
      };
      expect(request.args.ms).toHaveLength(sleepArgument.over - 1);
    });
  });
});
