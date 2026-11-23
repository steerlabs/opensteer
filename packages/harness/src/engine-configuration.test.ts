import { expect, it } from "vitest";
import { assertEngineMayRun, engineConfiguration } from "./engine-configuration.js";

it("gives the engine's own configuration only to the person's own task with personal context", () => {
  expect(engineConfiguration({ personalContext: true, personLineage: true })).toBe("own");
  // A connected agent's or a chat's task, even one only the person speaks in.
  expect(engineConfiguration({ personalContext: true, personLineage: false })).toBe("stripped");
  // A chat others can speak in.
  expect(engineConfiguration({ personalContext: false, personLineage: false })).toBe("stripped");
  expect(engineConfiguration({ personalContext: false, personLineage: true })).toBe("stripped");
});

it("refuses a task that is not the person's own only on an engine not shown to start without their configuration", () => {
  const others = { personalContext: true, personLineage: false };
  const own = { personalContext: true, personLineage: true };
  for (const engine of ["claude", "opencode", "antigravity"])
    expect(() => assertEngineMayRun(engine, others)).not.toThrow();
  for (const [engine, label] of [
    ["cursor", "Cursor"],
    ["grok", "Grok"],
    ["muse", "Muse Code"],
  ] as const) {
    expect(() => assertEngineMayRun(engine, others)).toThrow(
      `${label} starts with your own ${label} settings, so it runs only tasks you started yourself that no connected agent or chat has written to.`,
    );
    expect(() => assertEngineMayRun(engine, own)).not.toThrow();
  }
});
