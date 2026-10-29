// @vitest-environment happy-dom

import { createId } from "@opensteer/core";
import {
  ShellSessionHistoryEntrySchema,
  ShellSessionSummarySchema,
  machineAccessPolicyDefault,
  type MachineSummary,
  type ShellSessionHistoryEntry,
  type ShellSessionSummary,
} from "@opensteer/protocol";
import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostClient, MachineAccessHistoryPage } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { MachineAccessSection } from "./machine-access-section.js";
import {
  machineAccessAuditLabel,
  machineAccessConflictMessage,
  machineReachOptions,
} from "./machine-access-editor.js";

const mountedRoots: Root[] = [];
const machineId = "rnr_11111111-1111-4111-8111-111111111111";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  for (const root of mountedRoots.splice(0)) act(() => root.unmount());
  vi.useRealTimers();
});

describe("machineReachOptions", () => {
  it("withholds an owner only where there is no owner to reach", () => {
    expect(
      machineReachOptions({
        deploymentKind: "server",
        deploymentName: "Acme",
        ownerReachAvailable: false,
        ownership: "deployment",
      }).map((option) => option.reach),
    ).toEqual(["nobody", "deployment"]);
  });

  it("offers my agents for a Deployment-owned computer that has an effective owner", () => {
    // The Personal main computer: owned by the Deployment, owned by a person
    // too. Reading ownership alone is what used to hide the choice.
    expect(
      machineReachOptions({
        deploymentKind: "personal",
        deploymentName: "Acme",
        ownerReachAvailable: true,
        ownership: "deployment",
      }).map((option) => option.reach),
    ).toEqual(["nobody", "owner", "deployment"]);
  });

  it("offers the whole Deployment only where there is more than one person", () => {
    const forKind = (deploymentKind: "personal" | "server") =>
      machineReachOptions({
        deploymentKind,
        deploymentName: "Acme",
        ownerReachAvailable: true,
        ownership: "mine",
      }).map((option) => option.reach);

    expect(forKind("server")).toEqual(["nobody", "owner", "deployment"]);
    expect(forKind("personal")).toEqual(["nobody", "owner"]);
  });
});

describe("machineAccessAuditLabel", () => {
  it("says what was requested, because a record precedes the operation", () => {
    expect(
      machineAccessAuditLabel({ channel: 1, kind: "sftp.open", mode: "write", path: "/srv/x" }),
    ).toBe("Requested write to /srv/x");
    expect(
      machineAccessAuditLabel({ channel: 1, kind: "sftp.mutate", op: "mkdir", path: "/srv/new" }),
    ).toBe("Requested new folder /srv/new");
    expect(
      machineAccessAuditLabel({ channel: 1, kind: "sftp.mutate", op: "remove", path: "/srv/old" }),
    ).toBe("Requested removal of /srv/old");
    expect(
      machineAccessAuditLabel({
        channel: 1,
        kind: "sftp.mutate",
        op: "rename",
        path: "/srv/a",
        target: "/srv/b",
      }),
    ).toBe("Requested rename /srv/a to /srv/b");
  });

  it("states an outcome only where the record carries one", () => {
    expect(machineAccessAuditLabel({ channel: 0, exitStatus: 3, kind: "channel.closed" })).toBe(
      "Exited 3",
    );
    expect(
      machineAccessAuditLabel({ channel: 0, exitSignal: "TERM", kind: "channel.closed" }),
    ).toBe("Ended on signal TERM");
    expect(machineAccessAuditLabel({ channel: 0, kind: "channel.closed" })).toBe("Ended");
    // Records go missing for several reasons; the history claims no cause.
    expect(machineAccessAuditLabel({ kind: "truncated" })).toBe(
      "History is incomplete; earlier requests were kept",
    );
  });
});

describe("MachineAccessSection", () => {
  it("states what commands and port forwarding actually grant", () => {
    const html = renderToStaticMarkup(
      sectionElement({ access: openAccess(), client: new MockHostClient({ latencyMs: 0 }) }),
    );

    expect(html).toContain("Reachable by agents");
    expect(html).toContain(
      "Lets agents run anything your account can run here — the same access you have in a terminal, including signed-in tools and every file, not just shared folders.",
    );
    expect(html).toContain(
      "Opensteer records each request but can&#x27;t limit what a command does once it runs.",
    );
    expect(html).toContain("Lets agents connect to ports this computer can reach");
    // The Linux allowance is broader than the relay socket, so it is stated
    // wherever access is granted rather than left in the design notes.
    expect(html).toContain(
      "On Linux cloud Runners, an agent&#x27;s sandbox may connect to any local Unix socket while machine access is set up.",
    );
  });

  it("keeps what agents could do out of sight while nobody may reach the computer", async () => {
    const page = await mount({ client: new MockHostClient({ latencyMs: 0 }) });

    expect(page.container.textContent).toContain("No other computer can reach Mac mini.");
    expect(page.container.textContent).not.toContain("Run commands");
    expect(buttonTexts(page.container)).not.toContain("Add folder");

    await click(reachSwitch(page.container));

    expect(page.container.textContent).toContain("Run commands");
    expect(page.container.textContent).toContain(
      "Your agents can connect to Mac mini but can't open any folder or run anything yet.",
    );
    expect(buttonTexts(page.container)).toContain("Add folder");
  });

  it("turns reach on at the narrowest audience the Host offers", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    const update = vi
      .spyOn(client, "updateMachineAccess")
      .mockResolvedValue({ outcome: "updated", revision: 8 });
    const page = await mount({ client });

    expect(reachSwitch(page.container).checked).toBe(false);
    expect(whoSelect(page.container)).toBeNull();

    await click(reachSwitch(page.container));
    await click(saveButton(page.container));

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ policy: expect.objectContaining({ reach: "owner" }) }),
    );
  });

  it("admits the whole Deployment where an owner is not a reachable audience", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    const update = vi
      .spyOn(client, "updateMachineAccess")
      .mockResolvedValue({ outcome: "updated", revision: 8 });
    const page = await mount({
      access: accessWith([], { ownerReachAvailable: false }),
      client,
      ownership: "deployment",
    });

    await click(reachSwitch(page.container));
    // One audience is not a choice, so no selector is drawn.
    expect(whoSelect(page.container)).toBeNull();
    await click(saveButton(page.container));

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ policy: expect.objectContaining({ reach: "deployment" }) }),
    );
  });

  it("asks who only where both audiences are offered, and writes the answer", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    const update = vi
      .spyOn(client, "updateMachineAccess")
      .mockResolvedValue({ outcome: "updated", revision: 8 });
    const page = await mount({ client });

    await click(reachSwitch(page.container));
    const options = [...(whoSelect(page.container)?.options ?? [])].map((option) => option.text);
    expect(options).toEqual(["Only your agents", "Everyone in Acme"]);

    await chooseWho(page.container, "deployment");
    await click(saveButton(page.container));

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ policy: expect.objectContaining({ reach: "deployment" }) }),
    );
  });

  it("keeps the folders and commands a person set when reach is turned off", async () => {
    const page = await mount({
      access: accessWith([], {
        policy: {
          commands: true,
          forwarding: false,
          reach: "owner",
          shares: [{ mode: "read", path: "/Users/person/Projects" }],
        },
      }),
      client: new MockHostClient({ latencyMs: 0 }),
    });

    await click(reachSwitch(page.container));

    expect(page.container.textContent).toContain("Everything below is kept but has no effect.");
    expect(whoSelect(page.container)).toBeNull();
  });

  it("offers the desktop's folder chooser only where there is a desktop to ask", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    const withoutDesktop = await mount({ access: openAccess(), client });
    await click(button(withoutDesktop.container, "Add folder"));
    expect(buttonTexts(withoutDesktop.container)).not.toContain("Choose folder…");

    const pickFolder = vi.fn(async () => ({ path: "/Users/person/Projects" }));
    const withDesktop = await mount({
      access: openAccess(),
      client,
      desktopBridge: { pickFolder } as unknown as OpensteerDesktopBridge,
    });
    await click(button(withDesktop.container, "Add folder"));
    await click(button(withDesktop.container, "Choose folder…"));

    expect(pickFolder).toHaveBeenCalledOnce();
    const input = labelledInput(withDesktop.container, "Folder 1 path for Mac mini");
    expect(input.value).toBe("/Users/person/Projects");
    expect(input.readOnly).toBe(false);
    // A chosen folder is a folder the shared validator accepts as it stands.
    expect(withDesktop.container.textContent).not.toContain("must be an absolute folder path");
    expect(saveButton(withDesktop.container).disabled).toBe(false);
  });

  it("leaves the row alone when the folder dialog is closed without a choice", async () => {
    const pickFolder = vi.fn(async () => null);
    const page = await mount({
      access: openAccess(),
      client: new MockHostClient({ latencyMs: 0 }),
      desktopBridge: { pickFolder } as unknown as OpensteerDesktopBridge,
    });

    await click(button(page.container, "Add folder"));
    await click(button(page.container, "Choose folder…"));

    expect(labelledInput(page.container, "Folder 1 path for Mac mini").value).toBe("");
    expect(saveButton(page.container).disabled).toBe(true);
  });

  it("refuses to save a folder list it can name a problem with", async () => {
    const page = await mount({
      access: openAccess(),
      client: new MockHostClient({ latencyMs: 0 }),
    });

    await click(button(page.container, "Add folder"));
    expect(page.container.textContent).toContain("Enter a folder path, or remove the empty row.");
    expect(saveButton(page.container).disabled).toBe(true);

    await change(labelledInput(page.container, "Folder 1 path for Mac mini"), "relative/path");
    expect(page.container.textContent).toContain(
      'relative/path must be an absolute folder path with no "." or ".." component, no repeated slash, and no trailing slash.',
    );
    expect(saveButton(page.container).disabled).toBe(true);

    await click(button(page.container, "Add folder"));
    await change(
      labelledInput(page.container, "Folder 1 path for Mac mini"),
      "/Users/person/Projects",
    );
    await change(
      labelledInput(page.container, "Folder 2 path for Mac mini"),
      "/Users/person/Projects/site",
    );
    expect(page.container.textContent).toContain(
      "/Users/person/Projects/site is inside /Users/person/Projects, which is already shared.",
    );
    expect(saveButton(page.container).disabled).toBe(true);
  });

  it("saves only what changed, against the revision the form read", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    const update = vi
      .spyOn(client, "updateMachineAccess")
      .mockResolvedValue({ outcome: "updated", revision: 8 });
    const page = await mount({ client });

    expect(saveButton(page.container).disabled).toBe(true);

    await click(reachSwitch(page.container));
    await click(button(page.container, "Add folder"));
    await change(
      labelledInput(page.container, "Folder 1 path for Mac mini"),
      "/Users/person/Projects",
    );
    expect(saveButton(page.container).disabled).toBe(false);

    await click(saveButton(page.container));

    expect(update).toHaveBeenCalledWith({
      expectedRevision: 7,
      policy: {
        commands: false,
        forwarding: false,
        reach: "owner",
        shares: [{ mode: "read", path: "/Users/person/Projects" }],
      },
      runnerId: machineId,
    });
    await vi.waitFor(() => expect(saveButton(page.container).disabled).toBe(true));
  });

  it("says how many live sessions a save will end", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    const one = await mount({ access: accessWith([session("Fix the deploy")]), client });
    expect(saveButton(one.container).textContent).toBe("Save and end 1 active session");

    const two = await mount({
      access: accessWith([session("Fix the deploy"), session("Ship the docs")]),
      client,
    });
    expect(saveButton(two.container).textContent).toBe("Save and end 2 active sessions");
  });

  it("offers a reload rather than overwriting a policy written elsewhere", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    vi.spyOn(client, "updateMachineAccess").mockResolvedValue({ outcome: "conflict" });
    const refresh = vi.spyOn(client, "refresh");
    const page = await mount({ client });

    await click(reachSwitch(page.container));
    await click(saveButton(page.container));

    expect(page.container.textContent).toContain("Access settings changed elsewhere. Reload.");
    expect(page.container.textContent).toContain(
      "Reloading shows the saved settings and discards your edits.",
    );
    await click(button(page.container, "Reload"));
    expect(refresh).toHaveBeenCalled();
  });

  it("saves against the revision a reload brought back, not the one that lost", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    const update = vi
      .spyOn(client, "updateMachineAccess")
      .mockResolvedValue({ outcome: "conflict" });
    vi.spyOn(client, "refresh").mockResolvedValue();
    const page = await mount({ client });

    await click(reachSwitch(page.container));
    await click(saveButton(page.container));
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ expectedRevision: 7 }));
    expect(page.container.textContent).toContain(machineAccessConflictMessage);

    // The refresh brings the policy somebody else wrote. While the form is
    // dirty a live update is ignored on purpose — so only the reload can put
    // the editor on it.
    const written = {
      commands: true,
      forwarding: false,
      reach: "deployment" as const,
      shares: [],
    };
    await page.render({ access: accessWith([], { policy: written, revision: 9 }) });
    expect(reachSwitch(page.container).checked).toBe(true);

    await click(button(page.container, "Reload"));

    expect(page.container.textContent).not.toContain(machineAccessConflictMessage);
    expect(reachSwitch(page.container).checked).toBe(true);
    expect(whoSelect(page.container)?.value).toBe("deployment");
    expect(saveButton(page.container).disabled).toBe(true);

    update.mockResolvedValue({ outcome: "updated", revision: 10 });
    await click(reachSwitch(page.container));
    await click(saveButton(page.container));

    expect(update).toHaveBeenLastCalledWith({
      expectedRevision: 9,
      policy: { ...written, reach: "nobody" },
      runnerId: machineId,
    });
  });

  it("lets a Stop that failed be tried again", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    const stop = vi
      .spyOn(client, "stopMachineAccessSession")
      .mockRejectedValue(new Error("The computer went away."));
    const live = session("Fix the deploy");
    const page = await mount({ access: accessWith([live]), client });

    await click(button(page.container, "Stop"));

    expect(stop).toHaveBeenCalledWith(live.id);
    expect(page.container.textContent).toContain("The computer went away.");
    // Without clearing the id the button stays "Stopping…" until some
    // unrelated notification arrives, and the session cannot be stopped.
    const retry = button(page.container, "Stop");
    expect(retry.disabled).toBe(false);
    await click(retry);
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("shows each live session and stops it once", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    const stop = vi.spyOn(client, "stopMachineAccessSession").mockResolvedValue(true);
    const live = session("Fix the deploy");
    const page = await mount({ access: accessWith([live]), client });

    expect(page.container.textContent).toContain("Thread Fix the deploy from cloud-1");
    await click(button(page.container, "Stop"));

    expect(stop).toHaveBeenCalledWith(live.id);
    expect(stop).toHaveBeenCalledTimes(1);
    // The row keeps its button once the request has settled — the Host's
    // notification is what takes the session off the page.
    expect(button(page.container, "Stop").disabled).toBe(false);
  });

  it("reads history only when it is opened, then pages through it", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    const first = historyEntry({ command: "gh pr list", title: "Fix the deploy" });
    const second = historyEntry({ command: "ls /srv", title: "Ship the docs" });
    const history = vi
      .spyOn(client, "loadMachineAccessHistory")
      .mockImplementation(async (input) =>
        input.before === undefined ? page([first], "cursor-1") : page([second], null),
      );
    const rendered = await mount({ client });

    expect(history).not.toHaveBeenCalled();

    await click(button(rendered.container, "History"));
    await vi.waitFor(() =>
      expect(rendered.container.textContent).toContain("Thread Fix the deploy from cloud-1"),
    );
    expect(history).toHaveBeenCalledWith({ limit: 20, runnerId: machineId });
    // The requests a session made are not shown until that session is opened.
    expect(rendered.container.textContent).not.toContain("gh pr list");

    await click(button(rendered.container, "Load more"));
    await vi.waitFor(() =>
      expect(rendered.container.textContent).toContain("Thread Ship the docs from cloud-1"),
    );
    expect(history).toHaveBeenLastCalledWith({
      before: "cursor-1",
      limit: 20,
      runnerId: machineId,
    });
    expect(rendered.container.textContent).toContain("Thread Fix the deploy from cloud-1");
  });

  it("re-reads an open history when the Host says the sessions changed", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    const history = vi.spyOn(client, "loadMachineAccessHistory").mockResolvedValue(page([], null));
    const rendered = await mount({ client });

    await click(button(rendered.container, "History"));
    await vi.waitFor(() => expect(history).toHaveBeenCalledTimes(1));

    await rendered.render({ machineRevision: 4 });
    await vi.waitFor(() => expect(history).toHaveBeenCalledTimes(2));
  });
});

function accessWith(
  activeSessions: readonly ShellSessionSummary[],
  overrides: Partial<NonNullable<MachineSummary["access"]>> = {},
): NonNullable<MachineSummary["access"]> {
  return {
    activeSessions: [...activeSessions],
    ownerReachAvailable: true,
    policy: machineAccessPolicyDefault,
    revision: 7,
    ...overrides,
  };
}

/** A computer somebody may already reach, where the grants are on show. */
function openAccess(
  activeSessions: readonly ShellSessionSummary[] = [],
): NonNullable<MachineSummary["access"]> {
  return accessWith(activeSessions, {
    policy: { ...machineAccessPolicyDefault, reach: "owner" },
  });
}

function session(
  threadTitle: string,
  bytes: { readonly bytesIn: number; readonly bytesOut: number } = {
    bytesIn: 8 * 1_048_576,
    bytesOut: 4 * 1_048_576,
  },
): ShellSessionSummary {
  return ShellSessionSummarySchema.parse({
    ...bytes,
    callerMachineName: "cloud-1",
    id: `shs_${crypto.randomUUID()}`,
    requestedBy: createId("user"),
    runId: createId("run"),
    startedAt: "2026-09-13T12:00:00.000Z",
    threadId: createId("thread"),
    threadTitle,
  });
}

function historyEntry(input: {
  readonly command: string;
  readonly title: string;
}): ShellSessionHistoryEntry {
  return ShellSessionHistoryEntrySchema.parse({
    ...session(input.title),
    endReason: "client-closed",
    endedAt: "2026-09-13T12:04:00.000Z",
    events: [
      { channel: 0, command: input.command, kind: "exec" },
      { channel: 1, kind: "sftp.open", mode: "read", path: "/Users/person/Projects/notes.md" },
      { channel: 2, host: "db.internal", kind: "forward", port: 5_432 },
      { detail: "interactive terminals are not offered", kind: "denied", what: "pty" },
      { channel: 0, exitStatus: 0, kind: "channel.closed" },
      { kind: "truncated" },
    ],
  });
}

function page(
  sessions: readonly ShellSessionHistoryEntry[],
  nextCursor: string | null,
): MachineAccessHistoryPage {
  return { nextCursor, sessions };
}

async function mount(input: {
  readonly access?: NonNullable<MachineSummary["access"]>;
  readonly client: HostClient;
  readonly desktopBridge?: OpensteerDesktopBridge;
  readonly ownership?: MachineSummary["ownership"];
}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  const render = async (
    overrides: {
      readonly access?: NonNullable<MachineSummary["access"]>;
      readonly machineRevision?: number;
    } = {},
  ) => {
    await act(async () => {
      root.render(sectionElement({ ...input, ...overrides }));
    });
  };
  await render();
  return { container, render };
}

function sectionElement(input: {
  readonly access?: NonNullable<MachineSummary["access"]>;
  readonly client: HostClient;
  readonly desktopBridge?: OpensteerDesktopBridge;
  readonly machineRevision?: number;
  readonly ownership?: MachineSummary["ownership"];
}) {
  return (
    <MachineAccessSection
      access={input.access ?? accessWith([])}
      client={input.client}
      deploymentKind="server"
      deploymentName="Acme"
      desktopBridge={input.desktopBridge ?? null}
      machineId={machineId}
      machineName="Mac mini"
      machineRevision={input.machineRevision ?? 0}
      ownership={input.ownership ?? "mine"}
    />
  );
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === text,
  );
  if (!match) throw new Error(`Missing button: ${text}`);
  return match;
}

function buttonTexts(container: HTMLElement): readonly (string | null)[] {
  return [...container.querySelectorAll("button")].map((candidate) => candidate.textContent);
}

function saveButton(container: HTMLElement): HTMLButtonElement {
  const match = container.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!match) throw new Error("Missing the save button.");
  return match;
}

function reachSwitch(container: HTMLElement): HTMLInputElement {
  const match = container.querySelector<HTMLInputElement>(".machine-access__status .switch");
  if (!match) throw new Error("Missing the Reachable by agents switch.");
  return match;
}

function whoSelect(container: HTMLElement): HTMLSelectElement | null {
  return container.querySelector<HTMLSelectElement>(".machine-access__who-select");
}

async function chooseWho(container: HTMLElement, value: string): Promise<void> {
  const select = whoSelect(container);
  if (!select) throw new Error("Missing the Who selector.");
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    if (!setValue) throw new Error("The test DOM has no select value setter.");
    setValue.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function labelledInput(container: HTMLElement, label: string): HTMLInputElement {
  const match = [...container.querySelectorAll("input")].find(
    (candidate) => candidate.getAttribute("aria-label") === label,
  );
  if (!match) throw new Error(`Missing input: ${label}`);
  return match;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}

async function change(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setValue) throw new Error("The test DOM has no input value setter.");
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
