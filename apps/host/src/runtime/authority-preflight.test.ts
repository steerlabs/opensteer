import { deploymentPolicy } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { authorityPreflightDecision } from "./authority-preflight.js";

describe("authority preflight decision", () => {
  for (const kind of ["personal", "server"] as const)
    for (const executionPrincipal of ["person", "project"] as const) {
      it(`checks ${kind} against the ${executionPrincipal} policy, including dormant activation`, () => {
        const policy = {
          ...deploymentPolicy({ kind, defaultWorkspaceBacking: "local-directory" }),
          executionPrincipal,
        };
        const model = executionPrincipal === "person" ? 1 : 2;
        expect(authorityPreflightDecision({ state: "uninitialized" }, policy)).toEqual({
          state: "initialize",
          model,
        });
        expect(authorityPreflightDecision({ state: "existing", model }, policy)).toEqual({
          state: "start",
          model,
        });
        for (const other of [0, 1, 2, 3].filter((value) => value !== model))
          expect(authorityPreflightDecision({ state: "existing", model: other }, policy)).toEqual({
            state: "refuse",
          });
        expect(authorityPreflightDecision({ state: "unknown" }, policy)).toEqual({
          state: "refuse",
        });
      });
    }
});
