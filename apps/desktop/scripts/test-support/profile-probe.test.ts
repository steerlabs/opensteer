import { CdpProductIsolation } from "@opensteer/browser-core";
import { expect, it, vi } from "vitest";
import { assertProfileContract, PlatformScripts, refusedProfileMessage } from "./profile-probe.js";

const frame = (scriptId: string) => ({
  scriptId,
  functionName: `work${scriptId}`,
  url: "https://page.test/work.js",
  lineNumber: 4,
  columnNumber: 2,
});
const root = { scriptId: "0", functionName: "(root)", url: "", lineNumber: -1, columnNumber: -1 };
const profile = (...frames: Record<string, unknown>[]) => ({
  profile: { nodes: [root, ...frames].map((callFrame, index) => ({ id: index + 1, callFrame })) },
});

/** The page's main world with script 17, and an Opensteer world with script 31. */
function platformScripts() {
  const scripts = new PlatformScripts();
  const inspect = (observe: (method: string, parameters: Record<string, unknown>) => void) => {
    observe("Runtime.executionContextCreated", { context: { id: 1, name: "" } });
    observe("Runtime.executionContextCreated", { context: { id: 2, name: "opensteer-editing" } });
    observe("Debugger.scriptParsed", { scriptId: "17", executionContextId: 1 });
    observe("Debugger.scriptParsed", { scriptId: "31", executionContextId: 2 });
  };
  inspect((method, parameters) => scripts.observe(method, parameters));
  return { scripts, inspect };
}

/** An agent's Profiler.stop as the guard answers it. */
async function stop(result: unknown, inspect: ReturnType<typeof platformScripts>["inspect"]) {
  return new CdpProductIsolation()
    .observeProfileResult(result, async (observe) => inspect(observe))
    .then(
      () => ({ result }),
      (error: unknown) => ({ error }),
    );
}

it("holds a profile to the page's frames, or to the agent's refusal for an Opensteer frame", async () => {
  const { scripts, inspect } = platformScripts();
  expect(assertProfileContract(await stop(profile(frame("17")), inspect), scripts)).toBe(
    "returned",
  );
  expect(
    assertProfileContract(await stop(profile(frame("17"), frame("31")), inspect), scripts),
  ).toBe("refused-platform-script");
  // A refusal it cannot explain fails, as does one in other words than the agent's.
  expect(() =>
    assertProfileContract(
      { error: Object.assign(new Error(refusedProfileMessage), { code: "forbidden" }) },
      scripts,
    ),
  ).toThrow("without a reason");
  expect(() =>
    assertProfileContract(
      { error: Object.assign(new Error("31"), { code: "forbidden" }) },
      scripts,
    ),
  ).toThrow("other words");
  expect(() => assertProfileContract({ result: profile(frame("99")) }, scripts)).toThrow(
    "cannot place",
  );
});

it("fails when the guard returns everything", async () => {
  const { scripts, inspect } = platformScripts();
  const open = vi
    .spyOn(CdpProductIsolation.prototype, "observeProfileResult")
    .mockResolvedValue(undefined);
  try {
    const stopped = await stop(profile(frame("17"), frame("31")), inspect);
    expect(stopped).toHaveProperty("result");
    expect(() => assertProfileContract(stopped, scripts)).toThrow("Opensteer's own scripts");
  } finally {
    open.mockRestore();
  }
});
