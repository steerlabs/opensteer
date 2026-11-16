import { expect, it } from "vitest";
import { CdpProductIsolation } from "./cdp-product-isolation.js";

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
