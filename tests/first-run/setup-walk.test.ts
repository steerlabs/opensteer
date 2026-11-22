import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { setupSteps } from "../../apps/web/src/components/first-run/setup-memory.js";
import { phoneStepTitle, setupMoves } from "./setup-walk.js";

/*
 * The first-run journey's walk through setup, held to the steps it walks: each title it waits
 * for is a step's own title, each move it makes is a button that step draws, and they come in the
 * order a Mac's setup has them. A step renamed, or a move it no longer offers, fails here and not
 * in the VM.
 */

const web = path.resolve(import.meta.dirname, "../../apps/web/src/components");
const source = (file: string) => readFileSync(path.join(web, file), "utf8");

/** Each setup step a Mac shows, its component, and how its move is drawn there. */
const steps = [
  {
    id: "ai",
    file: "first-run/setup-ai-step.tsx",
    title: "Your AI",
    // The footer's own Skip, offered when the step passes it `onSkip`.
    draws: (move: string, text: string) =>
      text.includes("onSkip={onNext}") &&
      source("first-run/setup-frame.tsx").includes(`skipLabel = "${move}"`),
  },
  {
    id: "permissions",
    file: "devices/home-setup-step.tsx",
    title: "Your agent on this Mac",
    draws: (move: string, text: string) => text.includes(`"${move}"`),
  },
  {
    id: "permissions",
    file: "devices/home-setup-step.tsx",
    title: "Let macOS allow it",
    draws: (move: string, text: string) => text.includes(`skipLabel="${move}"`),
  },
] as const;

describe("the first-run journey's walk through setup", () => {
  it("knows every step before the phone, in a Mac's order, and ends at the phone", () => {
    expect(setupSteps({ mac: true, onThisComputer: true })).toEqual(["ai", "permissions", "phone"]);
    expect(Object.keys(setupMoves)).toEqual(steps.map(({ title }) => title));
    expect(source("first-run/setup-phone-step.tsx")).toContain(`title="${phoneStepTitle}"`);
  });

  for (const step of steps)
    it(`waits for "${step.title}" and makes a move it draws`, () => {
      const text = source(step.file);
      expect(text).toContain(`title="${step.title}"`);
      const move = setupMoves[step.title];
      expect(move).toBeDefined();
      expect(step.draws(move!, text), `"${step.title}" draws no "${move}"`).toBe(true);
    });
});
