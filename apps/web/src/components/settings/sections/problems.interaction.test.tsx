// @vitest-environment happy-dom

import { emptyExecutionPreferences } from "@opensteer/core";
import { MockHostClient } from "@opensteer/client/mock";
import type { HomeHealthReport, Problem } from "@opensteer/protocol/problems";
import type { ProblemReporting } from "@opensteer/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShellContext } from "../../app-shell.js";
import { ProblemsGroup } from "./problems.js";

/*
 * How Settings → Problems could mislead:
 * - a problem is shown in code words, or with text that was never in the table;
 * - the switch sends, or looks on, before the person turned it on;
 * - "what would be sent" shows anything but the exact report;
 * - a Cloud Computer offers a switch for a report its operator always receives.
 */

const roots: Root[] = [];
const noOp = () => undefined;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

const problems: Problem[] = [
  {
    code: "stop.unconfirmed",
    count: 1,
    firstSeenAt: "2026-11-24T08:00:00.000Z",
    lastSeenAt: "2026-11-24T08:00:00.000Z",
    fields: {},
  },
  {
    code: "engine.inspection_failed",
    count: 2,
    firstSeenAt: "2026-11-24T08:00:00.000Z",
    lastSeenAt: "2026-11-24T09:00:00.000Z",
    fields: { engine: "codex" },
  },
];
// The preview's report: the same problems, the preview's own version.
const report: HomeHealthReport = { schema: 1, home: "mac", version: "0.0.0", problems };

async function mount(reporting: ProblemReporting) {
  const hostClient = new MockHostClient({ latencyMs: 0 });
  hostClient.setProblems(problems, { cloudComputer: reporting.mode === "operator" });
  const set = vi.spyOn(hostClient, "setProblemReports");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const context = {
    createThreadAndSend: () => Promise.reject(new Error("Not in this test.")),
    defaultPlacement: undefined,
    deploymentAccess: null,
    desktopBridge: null,
    desktopDeployment: null,
    executionPreferences: emptyExecutionPreferences,
    hostClient,
    localExecutionStatus: null,
    addHarnessAccount: null,
    openHarnessAuthentication: null,
    refreshHarnessCatalog: async () => undefined,
    leaveSettings: noOp,
    openMobileNavigation: noOp,
    placements: [],
    rememberExecution: noOp,
    reportActionError: noOp,
    setTaskDone: noOp,
    snapshot: { ...hostClient.getSnapshot(), connection: "connected" },
  } as unknown as ShellContext;
  await act(async () =>
    root.render(
      <MemoryRouter>
        <ShellContext value={context}>
          <ProblemsGroup />
        </ShellContext>
      </MemoryRouter>,
    ),
  );
  await act(async () => undefined);
  return { container, set };
}

const text = (container: HTMLElement) => container.textContent ?? "";
const button = (label: string) =>
  [...document.querySelectorAll("button")].find((candidate) => candidate.textContent === label)!;

describe("Settings → Problems", () => {
  it("says each problem in the table's own words, what to do, and nothing more", async () => {
    const { container } = await mount({ mode: "off", destination: "opensteer" });
    expect(text(container)).toContain("A Stop could not be confirmed, so its task is held.");
    expect(text(container)).toContain(
      "An AI engine could not be checked, so it cannot start work.",
    );
    expect(text(container)).toContain(
      "Codex · 2 times · Open AI engines in Settings to see why, then update or reinstall it.",
    );
    expect(text(container)).not.toContain("stop.unconfirmed");
  });

  it("sends nothing until the person turns it on, and shows exactly what would be sent", async () => {
    const { container, set } = await mount({ mode: "off", destination: "opensteer" });
    const toggle = container.querySelector<HTMLInputElement>('input[role="switch"]')!;
    expect(toggle.getAttribute("aria-label")).toBe("Send problem reports to Opensteer");
    expect(toggle.checked).toBe(false);
    expect(text(container)).toContain("Off: nothing is sent.");
    await act(async () => button("See what would be sent").click());
    expect(document.querySelector(".problem-report__exact")?.textContent).toBe(
      JSON.stringify(report, null, 2),
    );
    await act(async () => toggle.click());
    await act(async () => undefined);
    expect(set).toHaveBeenCalledExactlyOnceWith(true);
    expect(text(container)).toContain("Sent to Opensteer every 15 minutes.");
  });

  it("on a Cloud Computer, says what its operator receives and offers no switch", async () => {
    const { container } = await mount({ mode: "operator", destination: "opensteer" });
    expect(container.querySelector('input[role="switch"]')).toBeNull();
    expect(text(container)).toContain("What Opensteer can see about this computer");
    expect(text(container)).toContain(
      "Opensteer runs this Cloud Computer and receives this report",
    );
  });
});
