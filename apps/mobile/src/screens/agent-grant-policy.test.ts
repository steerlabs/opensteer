import { defaultWorkPolicy } from "@opensteer/control-plane-protocol";
import { describe, expect, it } from "vitest";
import { agentGrantSections, agentModeSection } from "./agent-grant-sections.js";

const notAllowed = "Your organization doesn’t allow this";
const read = { kind: "ready", data: [] } as never;
const context = {
  agent: "Claude",
  home: "Work Home",
  browser: { profiles: [], homes: [], dedicated: null } as never,
  apps: read,
  plugins: read,
  disabled: false,
  draft: { scope: "selected", tasks: false, resources: [], newProfile: null },
  mode: "approval-required",
  onScope: () => undefined,
  onOpen: () => undefined,
  onTasks: () => undefined,
} as const;

function rows(sections: ReturnType<typeof agentGrantSections>, key: string) {
  return sections.flatMap((section) => section.rows).find((row) => row.key === key);
}

describe("a work Home's policy on the phone's consent and grant editor", () => {
  it("rules nothing out without a policy, as on every Home today", () => {
    const sections = agentGrantSections(context);
    expect(rows(sections, "everything")).toMatchObject({ disabled: false });
    expect(rows(sections, "tasks")).toMatchObject({ disabled: false });
    expect(
      agentModeSection({
        mode: "approval-required",
        disabled: false,
        onMode: () => undefined,
      }).rows.map((row) => (row.kind === "choice" ? row.disabled : null)),
    ).toEqual([false, false, false, false]);
  });

  it("shows everything, tasks and modes above the ceiling as unavailable, with why", () => {
    const sections = agentGrantSections({ ...context, workPolicy: defaultWorkPolicy });
    expect(rows(sections, "everything")).toMatchObject({ disabled: true, detail: notAllowed });
    expect(rows(sections, "tasks")).toMatchObject({ disabled: true, detail: notAllowed });
    const modes = agentModeSection({
      mode: "approval-required",
      disabled: false,
      onMode: () => undefined,
      workPolicy: defaultWorkPolicy,
    }).rows.map((row) => (row.kind === "choice" ? [row.disabled, row.detail] : null));
    expect(modes[0]?.[0]).toBe(false);
    for (const mode of modes.slice(1)) expect(mode).toEqual([true, notAllowed]);
  });
});
