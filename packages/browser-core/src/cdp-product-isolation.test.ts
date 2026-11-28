import { expect, it, vi } from "vitest";
import { CdpProductIsolation, cdpProfileRefusal } from "./cdp-product-isolation.js";

it("admits page isolated worlds while isolating product preload, platform objects, scripts and IPC", () => {
  const worlds = new CdpProductIsolation();
  for (const [id, name] of [
    [1, ""],
    [2, "agent-world"],
    [3, "Electron Isolated Context"],
    [4, "opensteer-editing"],
  ] as const)
    worlds.observe("Runtime.executionContextCreated", {
      context: {
        id,
        name,
        uniqueId: `world-${id}`,
        auxData: { frameId: "frame", isDefault: id === 1, type: id === 1 ? "default" : "isolated" },
      },
    });
  expect(() =>
    worlds.assertCommand("Runtime.evaluate", { contextId: 2, expression: "42" }),
  ).not.toThrow();
  expect(() => worlds.assertCommand("Runtime.callFunctionOn", { objectId: "1.2.3" })).not.toThrow();
  expect(worlds.observe("Runtime.consoleAPICalled", { executionContextId: 2 })).toBe(true);
  for (const contextId of [3, 4]) {
    expect(() =>
      worlds.assertCommand("Runtime.evaluate", { contextId, expression: "require('electron')" }),
    ).toThrow("Opensteer");
    expect(() =>
      worlds.assertCommand("Runtime.getProperties", { objectId: `1.${contextId}.1` }),
    ).toThrow("Opensteer");
    expect(worlds.observe("Runtime.consoleAPICalled", { executionContextId: contextId })).toBe(
      false,
    );
  }
  worlds.observe("Debugger.scriptParsed", { scriptId: "page-script", executionContextId: 2 });
  worlds.observe("Debugger.scriptParsed", { scriptId: "preload-script", executionContextId: 3 });
  expect(() =>
    worlds.assertCommand("Debugger.getScriptSource", { scriptId: "page-script" }),
  ).not.toThrow();
  expect(() =>
    worlds.assertCommand("Debugger.getScriptSource", { scriptId: "preload-script" }),
  ).toThrow("Opensteer");
  expect(
    worlds.observe("Debugger.paused", {
      callFrames: [{ callFrameId: "preload-frame", location: { scriptId: "preload-script" } }],
    }),
  ).toBe(false);
  expect(() =>
    worlds.assertCommand("Debugger.evaluateOnCallFrame", { callFrameId: "preload-frame" }),
  ).toThrow("Opensteer");
  worlds.observePlatformCommand("Runtime.addBinding", { name: "host-bridge" });
  expect(() => worlds.assertCommand("Runtime.addBinding", { name: "host-bridge" })).toThrow(
    "Opensteer",
  );
  expect(worlds.observe("Runtime.bindingCalled", { name: "host-bridge", payload: "private" })).toBe(
    false,
  );
  expect(() =>
    worlds.assertCommand("Page.createIsolatedWorld", { worldName: "opensteer-frame" }),
  ).toThrow("Opensteer");
  expect(() => worlds.assertCommand("HeapProfiler.takeHeapSnapshot")).toThrow("Opensteer");
});

function cpuProfile(...callFrames: Record<string, unknown>[]) {
  return {
    profile: { nodes: callFrames.map((callFrame, index) => ({ id: index + 1, callFrame })) },
  };
}

const syntheticProfileFrame = (functionName: string) => ({
  scriptId: "0",
  functionName,
  url: "",
  lineNumber: -1,
  columnNumber: -1,
});

it("returns a CPU profile containing only V8 synthetic nodes without a script inventory", async () => {
  const worlds = new CdpProductIsolation();
  const inventory = vi.fn();
  const result = cpuProfile(...["(root)", "(idle)", "(program)"].map(syntheticProfileFrame));

  await expect(worlds.observeProfileResult(result, inventory)).resolves.toBeUndefined();
  expect(inventory).not.toHaveBeenCalled();
  expect(() => worlds.observeResult("Debugger.getStackTrace", {}, result)).toThrow("Opensteer");
  expect(() => worlds.assertCommand("Debugger.getScriptSource", { scriptId: "0" })).toThrow(
    "Opensteer",
  );
});

it("returns page frames in a CPU profile without the client enabling Debugger", async () => {
  const worlds = new CdpProductIsolation();
  const result = cpuProfile(syntheticProfileFrame("(root)"), {
    scriptId: "17",
    functionName: "work",
    url: "https://page.test/code.js",
    lineNumber: 4,
    columnNumber: 2,
  });

  await expect(
    worlds.observeProfileResult(result, async (observe) => {
      observe("Runtime.executionContextCreated", { context: { id: 2, name: "" } });
      observe("Debugger.scriptParsed", { scriptId: "17", executionContextId: 2 });
    }),
  ).resolves.toBeUndefined();
  expect(() => worlds.assertCommand("Debugger.getScriptSource", { scriptId: "17" })).toThrow(
    "Opensteer",
  );
});

it("refuses CPU profiles containing an internal or unclassified script", async () => {
  const worlds = new CdpProductIsolation();
  const result = cpuProfile(syntheticProfileFrame("(root)"), {
    scriptId: "17",
    functionName: "privateCode",
    url: "opensteer://preload",
    lineNumber: 4,
    columnNumber: 2,
  });

  for (const name of ["Electron Isolated Context", "opensteer-editing"]) {
    await expect(
      worlds.observeProfileResult(result, async (observe) => {
        observe("Runtime.executionContextCreated", { context: { id: 2, name } });
        observe("Debugger.scriptParsed", { scriptId: "17", executionContextId: 2 });
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  }
  await expect(worlds.observeProfileResult(result, async () => {})).rejects.toMatchObject({
    code: "forbidden",
  });
  expect(() =>
    worlds.observeResult("Profiler.stop", {}, cpuProfile({ ...syntheticProfileFrame("work") })),
  ).toThrow("Opensteer");
});

it("names why a CPU profile was refused, in the same words to the agent", async () => {
  const pageFrame = {
    scriptId: "17",
    functionName: "work",
    url: "https://page.test/code.js",
    lineNumber: 4,
    columnNumber: 2,
  };
  const refusal = async (
    frames: Record<string, unknown>[],
    inspect: (observe: (method: string, parameters: Record<string, unknown>) => void) => void,
  ) => {
    const error = await new CdpProductIsolation()
      .observeProfileResult(
        cpuProfile(syntheticProfileFrame("(root)"), ...frames),
        async (observe) => inspect(observe),
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    if (error)
      expect(error).toMatchObject({
        code: "forbidden",
        message: "Profiler.stop returned Opensteer's preload or platform state.",
      });
    return error && cdpProfileRefusal(error);
  };
  const page = (observe: (method: string, parameters: Record<string, unknown>) => void) => {
    observe("Runtime.executionContextCreated", { context: { id: 2, name: "" } });
    observe("Runtime.executionContextCreated", { context: { id: 3, name: "opensteer-editing" } });
    observe("Debugger.scriptParsed", { scriptId: "17", executionContextId: 2 });
    observe("Debugger.scriptParsed", { scriptId: "18", executionContextId: 3 });
  };
  expect(await refusal([pageFrame], page)).toBeNull();
  // A platform frame is the reason even beside frames the guard cannot place.
  expect(
    await refusal(
      [
        { ...pageFrame, scriptId: "99" },
        syntheticProfileFrame("work"),
        { ...pageFrame, scriptId: "18" },
      ],
      page,
    ),
  ).toBe("platform-script");
  expect(await refusal([pageFrame, syntheticProfileFrame("work")], page)).toBe("native-frame");
  expect(await refusal([pageFrame, { ...pageFrame, scriptId: "99" }], page)).toBe("unknown-script");
  expect(await refusal([pageFrame], () => {})).toBe("uninspected");
  expect(await refusal([{ ...pageFrame, executionContextId: 3 }], page)).toBe("platform-state");
  expect(
    cdpProfileRefusal(new Error("Profiler.stop returned Opensteer's preload or platform state.")),
  ).toBeNull();
});

it("never places a script in a context it was not reported in", () => {
  const worlds = new CdpProductIsolation();
  // A page context reported without a unique id, and a script with no context.
  worlds.observe("Runtime.executionContextCreated", { context: { id: 1, name: "" } });
  worlds.observe("Debugger.scriptParsed", { scriptId: "5", executionContextId: null });
  worlds.observe("Debugger.scriptParsed", { scriptId: "6", executionContextId: "1" });
  worlds.observe("Debugger.scriptParsed", { scriptId: "7", executionContextId: 1 });
  for (const scriptId of ["5", "6"])
    expect(() => worlds.assertCommand("Debugger.getScriptSource", { scriptId })).toThrow(
      "Opensteer",
    );
  expect(() => worlds.assertCommand("Debugger.getScriptSource", { scriptId: "7" })).not.toThrow();
});

it("refuses Debugger.setBreakpointByUrl with a non-empty condition outside explicit http(s)/extension URLs while keeping conditionless breakpoints available to your own agents (N1 preload, S2)", () => {
  const worlds = new CdpProductIsolation();
  worlds.observe("Runtime.executionContextCreated", { context: { id: 1, name: "" } });
  worlds.observe("Runtime.executionContextCreated", {
    context: { id: 2, name: "Electron Isolated Context" },
  });
  worlds.observe("Debugger.scriptParsed", { scriptId: "page-1", executionContextId: 1 });
  worlds.observe("Debugger.scriptParsed", { scriptId: "preload-1", executionContextId: 2 });

  // Non-empty condition with urlRegex, scriptHash, or non-http(s)/extension URL is refused.
  for (const params of [
    { urlRegex: ".*", lineNumber: 0, condition: "window.pwn = true, false" },
    { scriptHash: "deadbeef", lineNumber: 0, condition: "window.pwn = true, false" },
    {
      url: "file:///app/browser-page-preload.cjs",
      lineNumber: 0,
      condition: "window.pwn = true, false",
    },
    { url: "opensteer://preload", lineNumber: 0, condition: "window.pwn = true, false" },
    { url: "blob:https://example.test/x", lineNumber: 0, condition: "window.pwn = true, false" },
    { url: "data:text/javascript,1", lineNumber: 0, condition: "window.pwn = true, false" },
    { lineNumber: 0, condition: "window.pwn = true, false" },
  ]) {
    expect(
      () => worlds.assertCommand("Debugger.setBreakpointByUrl", params),
      JSON.stringify(params),
    ).toThrow();
  }

  // S2: without a non-empty condition, your own agents keep urlRegex, scriptHash, relative sourceURLs
  // (such as electron-browser-smoke's `smoke-break.js`), and file:/blob:/data: URLs.
  for (const params of [
    { url: "smoke-break.js", lineNumber: 1 },
    { urlRegex: ".*", lineNumber: 0 },
    { urlRegex: ".*", lineNumber: 0, condition: "" },
    { scriptHash: "deadbeef", lineNumber: 0 },
    { url: "file:///app/page.js", lineNumber: 0 },
    { url: "blob:https://example.test/x", lineNumber: 0 },
    { url: "data:text/javascript,1", lineNumber: 0 },
    { url: "https://example.test/app.js", lineNumber: 0, condition: "x > 1" },
    {
      url: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/content.js",
      lineNumber: 0,
      condition: "x > 1",
    },
  ]) {
    expect(
      () => worlds.assertCommand("Debugger.setBreakpointByUrl", params),
      JSON.stringify(params),
    ).not.toThrow();
  }

  // Result locations naming preload or unseen scripts are stripped instead of throwing after setting.
  const result = {
    breakpointId: "bp-1",
    locations: [
      { scriptId: "page-1", lineNumber: 0 },
      { scriptId: "preload-1", lineNumber: 0 },
      { scriptId: "unseen-9", lineNumber: 0 },
    ],
  };
  expect(() =>
    worlds.observeResult(
      "Debugger.setBreakpointByUrl",
      { url: "https://example.test/app.js", lineNumber: 0 },
      result,
    ),
  ).not.toThrow();
  expect(result.locations).toEqual([{ scriptId: "page-1", lineNumber: 0 }]);

  // S-f: when a Debugger.paused event is dropped because a lower call frame is in a preload
  // script, any page call frames recorded earlier in the same stack are cleared.
  expect(
    worlds.observe("Debugger.paused", {
      callFrames: [
        { callFrameId: "page-frame-1", location: { scriptId: "page-1", lineNumber: 0 } },
        { callFrameId: "preload-frame-2", location: { scriptId: "preload-1", lineNumber: 0 } },
      ],
    }),
  ).toBe(false);
  expect(() =>
    worlds.assertCommand("Debugger.evaluateOnCallFrame", {
      callFrameId: "page-frame-1",
      expression: "1",
    }),
  ).toThrow();

  // S-f fifth-look: when a Debugger.paused event has valid synchronous callFrames but is dropped
  // afterwards because asyncStackTrace references an unobserved script, page call frames collected
  // earlier in the same event are still cleared.
  expect(
    worlds.observe("Debugger.paused", {
      callFrames: [
        { callFrameId: "page-frame-async", location: { scriptId: "page-1", lineNumber: 0 } },
      ],
      asyncStackTrace: {
        callFrames: [{ scriptId: "unseen-async-1", lineNumber: 0 }],
      },
    }),
  ).toBe(false);
  expect(() =>
    worlds.assertCommand("Debugger.evaluateOnCallFrame", {
      callFrameId: "page-frame-async",
      expression: "1",
    }),
  ).toThrow();
});
