import { expect, it } from "vitest";
import { engineConfiguration } from "./engine-configuration.js";

it("gives the engine's own configuration only to the person's own task with personal context", () => {
  expect(engineConfiguration({ personalContext: true, personLineage: true })).toBe("own");
  // A connected agent's or a chat's task, even one only the person speaks in.
  expect(engineConfiguration({ personalContext: true, personLineage: false })).toBe("stripped");
  // A chat others can speak in.
  expect(engineConfiguration({ personalContext: false, personLineage: false })).toBe("stripped");
  expect(engineConfiguration({ personalContext: false, personLineage: true })).toBe("stripped");
});
