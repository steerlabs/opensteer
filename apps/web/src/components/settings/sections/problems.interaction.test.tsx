// @vitest-environment happy-dom

import { emptyExecutionPreferences } from "@opensteer/core";
import { MockHostClient } from "@opensteer/client/mock";
import type { Problem } from "@opensteer/protocol/problems";
import { unwrapRpcResult } from "@opensteer/client/host";
import type { ProblemReporting } from "@opensteer/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { ShellContext } from "../../app-shell.js";
import { ProblemsGroup } from "./problems.js";

/*
 * How Settings → Problems could mislead:
 * - a problem is shown in code words, or with text that was never in the table;
 * - a Home that sends nothing offers a switch, or does not say that nothing leaves;
 * - "what is sent" shows anything but the exact bytes the Home sends;
 * - the words leave out what the receiver keeps.
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
    firstSeenAt: "2026-11-24T08:00:00Z",
    lastSeenAt: "2026-11-24T08:00:00Z",
    fields: {},
  },
  {
    code: "engine.inspection_failed",
    count: 2,
    firstSeenAt: "2026-11-24T08:00:00Z",
    lastSeenAt: "2026-11-24T09:00:00Z",
    fields: { engine: "codex" },
  },
];

async function mount(destination: ProblemReporting["destination"]) {
  const hostClient = new MockHostClient({ latencyMs: 0 });
  hostClient.setProblems(problems, destination);
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
  return { container, hostClient };
}

const text = (container: HTMLElement) => container.textContent ?? "";
const button = (label: string) =>
  [...document.querySelectorAll("button")].find((candidate) => candidate.textContent === label)!;

describe("Settings → Problems", () => {
  it("says each problem in the table's own words, what to do, and nothing more", async () => {
    const { container } = await mount("none");
    expect(text(container)).toContain("A Stop could not be confirmed, so its task is held.");
    expect(text(container)).toContain(
      "An AI engine could not be checked, so it cannot start work.",
    );
    expect(text(container)).toContain(
      "Codex · 2 times · Open AI engines in Settings to see why, then update or reinstall it.",
    );
    expect(text(container)).not.toContain("stop.unconfirmed");
  });

  it("on a person's own Home offers no switch and says nothing leaves this computer", async () => {
    const { container } = await mount("none");
    expect(container.querySelector('input[role="switch"]')).toBeNull();
    expect(text(container)).toContain("Nothing about these problems leaves this computer.");
    expect(text(container)).not.toMatch(/Send problem reports|See what/u);
  });

  it("on a Cloud Computer, shows the exact bytes Opensteer receives and what it keeps (S6, S12, U4)", async () => {
    const { container, hostClient } = await mount("operator");
    expect(container.querySelector('input[role="switch"]')).toBeNull();
    expect(text(container)).toContain("What Opensteer can see about this computer");
    await act(async () => button("See what is sent").click());
    // Printed as the Host answered it, byte for byte, never parsed and written again.
    const { body } = unwrapRpcResult(await hostClient.rpc["problems.get"]({}));
    expect(document.querySelector(".problem-report__exact")?.textContent).toBe(body);
    expect(document.body.textContent).toContain(
      "it also logs this computer’s id, its version and those problems’ codes",
    );
    expect(document.body.textContent).toContain(
      "Opensteer also keeps its own record of this computer’s setup, billing and backups.",
    );
  });

  it("on a self-hosted Home, names its operator's own address, never Opensteer (S4)", async () => {
    const { container } = await mount("own");
    expect(text(container)).toContain("Problem reports to this Home’s own address");
    expect(text(container)).not.toContain("Opensteer receives");
    await act(async () => button("See what is sent").click());
    expect(document.body.textContent).toContain(
      "That address also sees the internet address the report comes from.",
    );
  });
});
