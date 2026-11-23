import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EditingContexts,
  namedTextWaitDecision,
  type EditingAdmissionKind,
  type EditingFieldIdentity,
} from "./editing.js";

type Step =
  | {
      observe: { field: EditingFieldIdentity | null; changed: boolean };
      save?: string;
      expectChanged?: boolean;
    }
  | {
      admits: {
        context: string;
        kind: EditingAdmissionKind;
        namedMatches?: boolean;
        exactNamed?: boolean;
        collapsed?: boolean;
      };
      is: boolean;
    }
  | {
      dependentGroup: {
        initial: string;
        context: string;
        operations: {
          kind: EditingAdmissionKind;
          before?: string;
          text?: string;
          move?: number;
          namedMatches?: boolean;
          follows?: boolean;
        }[];
        independent: { kind: EditingAdmissionKind; text: string };
      };
      expectAfterGroup: string;
      expectAfterIndependent: string;
    }
  | { mismatch: true; save?: string; expectChanged?: boolean }
  | { reset: true; save?: string; expectChanged?: boolean }
  | { rotateSame: number }
  | {
      wait: { sameField: boolean; matches: boolean; waited: number };
      is: "apply" | "wait" | "refuse-mismatch" | "refuse-field";
    };

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/editing-admission.json", import.meta.url), "utf8"),
) as {
  version: number;
  kept: number;
  namedTextWaitSeconds: number;
  cases: { name: string; steps: Step[] }[];
};

describe("editing admission rule (shared fixture)", () => {
  it("matches the shared constants", () => {
    expect(EditingContexts.kept).toBe(fixture.kept);
    expect(EditingContexts.namedTextWaitSeconds).toBe(fixture.namedTextWaitSeconds);
    expect(fixture.cases.length).toBeGreaterThanOrEqual(7);
  });

  for (const { name, steps } of fixture.cases) {
    it(name, () => {
      const contexts = new EditingContexts();
      const saved = new Map<string, string>();
      for (const step of steps) {
        if ("observe" in step) {
          const before = contexts.current;
          const changed = contexts.observe(step.observe.field, step.observe.changed);
          if (step.expectChanged !== undefined) {
            expect(changed).toBe(step.expectChanged);
            expect(contexts.current !== before).toBe(step.expectChanged);
          }
          if (step.save) saved.set(step.save, contexts.current);
        } else if ("admits" in step) {
          const contextId = saved.get(step.admits.context);
          if (!contextId) throw new Error(`Unknown saved context ${step.admits.context}`);
          expect(
            contexts.admits(contextId, step.admits.kind, {
              namedMatches: step.admits.namedMatches ?? true,
              exactNamed: step.admits.exactNamed ?? false,
              collapsed: step.admits.collapsed ?? true,
            }),
          ).toBe(step.is);
        } else if ("dependentGroup" in step) {
          const group = step.dependentGroup;
          const contextId = saved.get(group.context);
          if (!contextId) throw new Error(`Unknown saved context ${group.context}`);
          let text = group.initial;
          let refusedContext: string | null = null;
          const applyOp = (op: {
            kind: EditingAdmissionKind;
            text?: string;
            namedMatches?: boolean;
            follows?: boolean;
          }) => {
            if (op.follows && refusedContext === contextId) return false;
            const ok = contexts.admits(contextId, op.kind, {
              namedMatches: op.namedMatches ?? true,
              collapsed: true,
            });
            if (!ok) {
              refusedContext = contextId;
              if (op.kind === "named") contexts.mismatch();
              return false;
            }
            if (refusedContext === contextId) refusedContext = null;
            if (op.text) text += op.text;
            return true;
          };
          for (const op of group.operations) {
            if (!applyOp(op)) break;
          }
          expect(text).toBe(step.expectAfterGroup);
          expect(applyOp(group.independent)).toBe(true);
          expect(text).toBe(step.expectAfterIndependent);
        } else if ("mismatch" in step) {
          const before = contexts.current;
          contexts.mismatch();
          if (step.expectChanged !== undefined)
            expect(contexts.current !== before).toBe(step.expectChanged);
          if (step.save) saved.set(step.save, contexts.current);
        } else if ("reset" in step) {
          const before = contexts.current;
          contexts.reset();
          if (step.expectChanged !== undefined)
            expect(contexts.current !== before).toBe(step.expectChanged);
          if (step.save) saved.set(step.save, contexts.current);
        } else if ("rotateSame" in step) {
          for (let i = 0; i < step.rotateSame; i++) contexts.rotate(true);
        } else if ("wait" in step) {
          expect(
            namedTextWaitDecision(step.wait.sameField, step.wait.matches, step.wait.waited),
          ).toBe(step.is);
        }
      }
    });
  }
});
