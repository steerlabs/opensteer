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
        return { value: { window: { ref: "w", id: 7, title: "Doc" } } };
      if (request.operation === "observe")
        return {
          value: {
            observation: {
              snapshot: "s",
              window: { ref: "w", id: 7, title: "Doc" },
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
      'const a=await app("Notes"); const w=await a.window(7); const alias=await a.window(7); await Promise.all([w.observe(),alias.click(1)]); return "done"',
    );
    expect(result.isError).toBeUndefined();
    expect(calls).toEqual(["apps", "bind", "bind", "observe", "click"]);
    expect(output(result)).toBe('observed\nClicked Save\n"done"');
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
});
