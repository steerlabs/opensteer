// @vitest-environment happy-dom
import type { ClientConnection, ClientConnectionState } from "@opensteer/client/connections";
import { cloudSuggestionStorageKey, hostsDeployment } from "@opensteer/client/computers";
import type { ToolEntry } from "@opensteer/client/host";
import {
  MockCloudComputerAccount,
  MockHostClient,
  mockCloudComputerDeploymentId,
} from "@opensteer/client/mock";
import type { MachineSummary } from "@opensteer/protocol";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShellContext, useShell } from "../app-shell.js";
import { AsleepStepLine, GateAsleepLine } from "../asleep-moment.js";
import { ConnectionGateView } from "../connection-shell.js";
import { DevicesSection } from "./devices-page.js";
import { HomeFacts } from "./home-facts.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const workDeployment = "dep_00000000-0000-4000-8000-0000000000dd";
let root: Root | undefined;
let host: MockHostClient | undefined;
beforeEach(() => localStorage.clear());
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host?.dispose();
  host = undefined;
  vi.useRealTimers();
  localStorage.clear();
  document.body.replaceChildren();
});

type Snapshot = ReturnType<MockHostClient["getSnapshot"]>;

/** A Devices-sized shell: the mock Host's own snapshot, with only what a case changes. */
async function render(
  element: ReactNode,
  options: {
    readonly exposure?: "loopback" | "networked";
    readonly deploymentId?: string;
    readonly onThisComputer?: boolean;
    readonly cloud?: MockCloudComputerAccount;
    readonly machines?: (machines: readonly MachineSummary[]) => readonly MachineSummary[];
    readonly patch?: (snapshot: Snapshot) => Partial<Snapshot>;
  } = {},
) {
  host = new MockHostClient({ latencyMs: 0 });
  const base = host.getSnapshot();
  const identityConfig = base.identityConfig
    ? {
        ...base.identityConfig,
        exposure: options.exposure ?? "loopback",
        // A Home now says what it is; it matches its exposure here.
        homeKind: options.exposure === "networked" ? ("server" as const) : ("mac" as const),
      }
    : null;
  const snapshot: Snapshot = {
    ...base,
    identityConfig,
    deploymentId: options.deploymentId ?? base.deploymentId,
    machines: options.machines ? options.machines(base.machines) : base.machines,
    ...options.patch?.(base),
  } as Snapshot;
  const cloud = options.cloud;
  const context = {
    hostClient: host,
    snapshot,
    desktopBridge: cloud
      ? {
          cloudComputerRead: () => cloud.read(),
          cloudComputerAct: (input: Parameters<MockCloudComputerAccount["act"]>[0]) =>
            cloud.act(input),
          openExternalUrl: vi.fn(async () => undefined),
        }
      : null,
    desktopDeployment:
      options.onThisComputer === undefined
        ? null
        : { id: snapshot.deploymentId, onThisComputer: options.onThisComputer },
    deploymentAccess: { deployments: [] },
  } as unknown as React.ContextType<typeof ShellContext>;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <MemoryRouter>
        <ShellContext value={context}>{element}</ShellContext>
      </MemoryRouter>,
    ),
  );
  return { container, snapshot };
}

const homeRow = (container: HTMLElement) =>
  container.querySelector('[aria-labelledby="devices-home-title"] .devices-row');

describe("Devices: the Home says what kind it is", () => {
  it("is this Mac when this window runs on the Home", async () => {
    const { container } = await render(<DevicesSection />, { onThisComputer: true });
    await vi.waitFor(() =>
      expect(homeRow(container)?.textContent).toContain("This Mac · Home · Running"),
    );
    expect(container.textContent).toMatch(
      /Your Opensteer lives on .+\. Agents reach your other devices through it\./u,
    );
  });

  it("is a Mac Home elsewhere, online, from anywhere else", async () => {
    const { container } = await render(<DevicesSection />);
    await vi.waitFor(() => expect(homeRow(container)?.textContent).toContain("Home · Online"));
  });

  it("is a server when the Host is networked and the Account doesn't list it", async () => {
    const { container } = await render(<DevicesSection />, { exposure: "networked" });
    await vi.waitFor(() =>
      expect(homeRow(container)?.textContent).toContain("Home · Server · Online"),
    );
  });

  it("is the Cloud Computer when the Account's view for this deployment says so", async () => {
    const { container } = await render(<DevicesSection />, {
      exposure: "networked",
      deploymentId: mockCloudComputerDeploymentId,
      cloud: new MockCloudComputerAccount("ready"),
    });
    await vi.waitFor(() => expect(homeRow(container)?.textContent).toContain("Home · Always on"));
    expect(homeRow(container)?.textContent).toContain("Cloud Computer");
    expect(container.textContent).toContain("Your Opensteer lives on your Cloud Computer.");
  });

  it("is a work Home, with its organization's badge", async () => {
    const { container } = await render(<DevicesSection />, {
      exposure: "networked",
      deploymentId: workDeployment,
      cloud: new MockCloudComputerAccount("work", workDeployment),
    });
    await vi.waitFor(() =>
      expect(homeRow(container)?.textContent).toContain("Work · Acme Robotics"),
    );
    expect(homeRow(container)?.textContent).toContain("Work Home");
    expect(homeRow(container)?.textContent).not.toContain("Acme Robotics · Work Home");
  });
});

describe("Devices: each row says its status first", () => {
  it("shows asleep in amber, offline quietly, an update by name, and what's on when online", async () => {
    const since = new Date(Date.now() - 20 * 60_000).toISOString();
    let names: string[] = [];
    const { container } = await render(<DevicesSection />, {
      machines: (machines) => {
        const others = machines.filter(
          (machine) =>
            !hostsDeployment(machine) && !machine.phoneDisplay && machine.status === "online",
        );
        if (others.length === 0) throw new Error("The mock Host has no other online computer");
        const [first] = others;
        names = ["Sleepy Air", "Away Mini", "Old iMac"];
        return [
          ...machines,
          {
            ...first!,
            id: "rnr_00000000-0000-4000-8000-0000000000a1",
            name: names[0]!,
            status: "offline",
            asleepSince: since,
            lastSeenAt: since,
          },
          {
            ...first!,
            id: "rnr_00000000-0000-4000-8000-0000000000a2",
            name: names[1]!,
            status: "offline",
            asleepSince: null,
          },
          {
            ...first!,
            id: "rnr_00000000-0000-4000-8000-0000000000a3",
            name: names[2]!,
            status: "needs-update",
          },
        ];
      },
    });
    const row = (name: string) =>
      [
        ...container.querySelectorAll('[aria-labelledby="devices-devices-title"] .devices-row'),
      ].find((entry) => entry.querySelector(".devices-row__name")?.textContent === name);
    await vi.waitFor(() => expect(row(names[0]!)?.textContent).toContain("Asleep · seen 20m"));
    expect(row(names[0]!)?.querySelector(".status-dot--warn")).not.toBeNull();
    expect(row(names[1]!)?.textContent).toMatch(/Offline · seen |Offline$/u);
    expect(row(names[1]!)?.querySelector(".status-dot--muted")).not.toBeNull();
    expect(row(names[2]!)?.textContent).toContain(`Update Opensteer on ${names[2]}`);
    const online = [
      ...container.querySelectorAll(
        '[aria-labelledby="devices-devices-title"] .devices-row__status',
      ),
    ].map((entry) => entry.textContent ?? "");
    expect(online.some((line) => line.startsWith("Online"))).toBe(true);
    expect(container.querySelector('[aria-labelledby="devices-home-title"]')).not.toBeNull();
  });
});

describe("the Home page's own facts", () => {
  const home = (machines: readonly MachineSummary[]) => machines.find(hostsDeployment)!;

  it("says a server's address, version and that you're its owner", async () => {
    const { container } = await render(<Facts />, {
      exposure: "networked",
      machines: (machines) =>
        machines.map((machine) =>
          hostsDeployment(machine) ? { ...machine, runtimeVersion: "1.42.0" } : machine,
        ),
      patch: () => ({ deploymentShape: { kind: "personal" } }),
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Version"));
    expect(container.textContent).toContain("1.42.0");
    expect(container.textContent).toContain("Address");
    expect(container.textContent).toContain("Signed in as owner");
  });

  it("says it runs on this Mac only when it does, and nothing for a Cloud Computer", async () => {
    const here = await render(<Facts />, { onThisComputer: true });
    await vi.waitFor(() => expect(here.container.textContent).toContain("Running on this Mac"));
    act(() => root?.unmount());
    const cloud = await render(<Facts />, {
      exposure: "networked",
      deploymentId: mockCloudComputerDeploymentId,
      cloud: new MockCloudComputerAccount("ready"),
    });
    await act(async () => undefined);
    await vi.waitFor(() => expect(cloud.container.textContent).not.toContain("Signed in as owner"));
    expect(cloud.container.textContent).not.toContain("Running on this Mac");
  });

  function Facts() {
    const machine = home(useShell().snapshot.machines);
    return <HomeFacts machine={machine} />;
  }
});

describe("the asleep moment on the gate", () => {
  const unreachable: ClientConnectionState = {
    epoch: 1,
    issue: { code: "connection", reason: "unreachable" },
    lastConnectedAt: null,
    name: "Studio Mac",
    network: "online",
    pathRevision: 0,
    phase: "recovering",
    readyRevision: 1,
    route: null,
    scope: null,
    showInterruption: true,
    target: "computer",
    trying: false,
    visibility: "foreground",
  };
  const connection = (state: ClientConnectionState) =>
    ({
      getSnapshot: () => state,
      subscribe: () => () => undefined,
      retry: () => undefined,
    }) as unknown as ClientConnection;
  const line = (
    homeKind: "mac" | "cloud" | "server" | "work",
    deploymentId = "dep_00000000-0000-4000-8000-000000000001",
  ) => (
    <GateAsleepLine
      deploymentId={deploymentId}
      homeKind={homeKind}
      macName="Studio Mac"
      onOpen={() => undefined}
    />
  );
  const mountPlain = async (element: ReactNode) => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(element));
    return container;
  };

  it("adds the line and the offer under an unreachable Mac Home, and nothing for this computer or offline", async () => {
    const gate = await mountPlain(
      <ConnectionGateView
        connection={connection(unreachable)}
        scope="app"
        unreachableAside={line("mac")}
      />,
    );
    expect(gate.textContent).toContain(
      "Studio Mac isn’t reachable. It may be asleep or offline. Agents can’t use it until it’s back.",
    );
    expect(gate.textContent).toContain("Keep agents working while your Mac sleeps");
    act(() => root?.unmount());
    localStorage.clear();
    const same = await mountPlain(
      <ConnectionGateView
        connection={connection({
          ...unreachable,
          issue: { code: "connection", reason: "unreachable", route: "same-computer" },
        })}
        scope="app"
        unreachableAside={line("mac")}
      />,
    );
    expect(same.textContent).not.toContain("asleep or offline");
    act(() => root?.unmount());
    const offline = await mountPlain(
      <ConnectionGateView
        connection={connection({
          ...unreachable,
          issue: { code: "connection", reason: "offline" },
        })}
        scope="app"
        unreachableAside={line("mac")}
      />,
    );
    expect(offline.textContent).not.toContain("asleep or offline");
  });

  it("never appears for a Cloud Computer, a server or a work Home", async () => {
    for (const kind of ["cloud", "server", "work"] as const) {
      const container = await mountPlain(line(kind));
      expect(container.textContent).toBe("");
      act(() => root?.unmount());
    }
    expect(localStorage.getItem(cloudSuggestionStorageKey)).toBeNull();
  });

  it("goes with Not now and waits 14 days before another moment may show it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-20T12:00:00.000Z"));
    const first = await mountPlain(line("mac"));
    const notNow = [...first.querySelectorAll("button")].find(
      (button) => button.textContent === "Not now",
    )!;
    await act(async () => notNow.click());
    expect(first.textContent).toBe("");
    act(() => root?.unmount());
    vi.setSystemTime(new Date("2026-12-03T12:00:00.000Z"));
    const soon = await mountPlain(line("mac", "dep_00000000-0000-4000-8000-000000000002"));
    expect(soon.textContent).toBe("");
    act(() => root?.unmount());
    vi.setSystemTime(new Date("2026-12-04T12:00:01.000Z"));
    const later = await mountPlain(line("mac", "dep_00000000-0000-4000-8000-000000000002"));
    expect(later.textContent).toContain("isn’t reachable");
  });

  it("shows once in 14 days even without Not now: a second moment stays quiet", async () => {
    const first = await mountPlain(line("mac"));
    expect(first.textContent).toContain("isn’t reachable");
    act(() => root?.unmount());
    const again = await mountPlain(line("mac"));
    expect(again.textContent).toContain("isn’t reachable");
    act(() => root?.unmount());
    const other = await mountPlain(line("mac", "dep_00000000-0000-4000-8000-000000000003"));
    expect(other.textContent).toBe("");
  });
});

describe("the asleep line in a task's activity", () => {
  const asleepTool = (computerId: string): ToolEntry =>
    ({
      arguments: { computerId },
      callId: "call_1",
      createdAt: "2026-11-20T12:00:00.000Z",
      id: "tool_1",
      integration: null,
      isError: true,
      kind: "tool",
      output: {
        text: JSON.stringify({
          error: { code: "computer_asleep", message: "It is asleep.", next: null },
        }),
      },
      runId: null,
      state: "failed",
      streamText: "",
      tool: null,
    }) as unknown as ToolEntry;

  it("names the sleeping Device and offers the Cloud Computer on a Mac Home", async () => {
    let name = "";
    let id = "";
    const { container } = await render(<Step />, {
      machines: (machines) => {
        const other = machines.find(
          (machine) => !hostsDeployment(machine) && !machine.phoneDisplay,
        )!;
        name = other.name;
        id = other.id;
        return machines;
      },
    });
    function Step() {
      return <AsleepStepLine tool={asleepTool(id)} />;
    }
    await vi.waitFor(() =>
      expect(container.textContent).toContain(`Couldn’t reach ${name}: asleep`),
    );
    expect(container.textContent).toContain("Keep agents working while your Mac sleeps");
  });

  it("says what happened but offers nothing on a server or Cloud Computer Home", async () => {
    const { container } = await render(<AsleepStepLine tool={asleepTool("rnr_unknown")} />, {
      exposure: "networked",
    });
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Couldn’t reach a device: asleep"),
    );
    expect(container.textContent).not.toContain("Keep agents working");
  });
});
